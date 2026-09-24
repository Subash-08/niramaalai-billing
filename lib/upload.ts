export type UploadOptions = {
  onProgress?: (percentage: number) => void;
  signal?: AbortSignal;
};

export type UploadedFileResult = {
  _id: string;
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
};

export async function uploadFile(
  file: File,
  options?: UploadOptions
): Promise<UploadedFileResult> {
  const maxBytes = 5 * 1024 * 1024; // 5 MB
  if (!file || file.size < 1) {
    throw new Error('Please select a valid non-empty file.');
  }
  if (file.size > maxBytes) {
    throw new Error('File size exceeds the 5 MB limit.');
  }

  // 1. Prepare direct upload with server
  const prepareRes = await fetch('/api/files/prepare', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
    }),
    signal: options?.signal,
  });

  const prep = await prepareRes.json();
  if (!prepareRes.ok) {
    throw new Error(prep.error || 'Failed to initialize file upload.');
  }

  // 2. Direct-to-Cloudinary upload if available
  if (prep.directUploadAvailable && prep.uploadUrl && prep.fields) {
    const formData = new FormData();
    for (const [k, v] of Object.entries(prep.fields)) {
      formData.append(k, String(v));
    }
    formData.append('file', file);

    // Perform upload with progress tracking via XMLHttpRequest
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', prep.uploadUrl);
      xhr.timeout = 60000; // 60s timeout

      const onAbort = () => xhr.abort();
      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, {once: true});
      }

      const cleanup = () => {
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      if (xhr.upload && options?.onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            options.onProgress?.(percent);
          }
        };
      }

      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          let msg = `Direct upload failed with status ${xhr.status}`;
          try {
            const errJson = JSON.parse(xhr.responseText);
            if (errJson.error?.message) msg = errJson.error.message;
          } catch {}
          reject(new Error(msg));
        }
      };

      xhr.onerror = () => {
        cleanup();
        reject(new Error('Network error during file upload to storage provider.'));
      };
      xhr.ontimeout = () => {
        cleanup();
        reject(new Error('File upload to storage provider timed out.'));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new Error('Upload aborted by user.'));
      };

      xhr.send(formData);
    });

    // 3. Complete and verify upload on server (with automatic retry for the same fileId on transient server/network errors)
    let completeError: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const completeRes = await fetch('/api/files/complete', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({fileId: prep.fileId}),
          signal: options?.signal,
        });

        const completeJson = await completeRes.json().catch(() => ({}));
        if (completeRes.ok) {
          return completeJson;
        }
        completeError = completeJson.error || `Server verification failed (${completeRes.status})`;
        if (completeRes.status < 500 && completeRes.status !== 408) {
          break; // Client errors (e.g. 400 Bad Request) are not retried
        }
      } catch (err: any) {
        completeError = err?.message || 'Network error verifying file completion.';
        if (options?.signal?.aborted) throw err;
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
      }
    }

    throw new Error(completeError || 'Failed to verify uploaded file.');
  }

  // Fallback: server-proxied upload for local filesystem storage
  const form = new FormData();
  form.append('file', file);

  const fallbackRes = await fetch('/api/files', {
    method: 'POST',
    body: form,
    signal: options?.signal,
  });

  const fallbackJson = await fallbackRes.json();
  if (!fallbackRes.ok) {
    throw new Error(fallbackJson.error || 'Server upload failed.');
  }

  return fallbackJson;
}
