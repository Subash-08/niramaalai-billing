import {checkOrigin, endpoint, requireIdentity, jsonBody} from '@/server/auth';
import {AppError} from '@/server/db';
import {storeFile, getTenantStorageStatus} from '@/server/storage';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();

    // Server-side upload ceiling: 4 MB on Vercel to safely avoid 4.5 MB edge proxy limit
    const maxServerBytes = process.env.VERCEL ? 4 * 1024 * 1024 : 5 * 1024 * 1024;
    const size = Number(request.headers.get('content-length'));
    if (!Number.isFinite(size) || size <= 0 || size > maxServerBytes + 65536) {
      throw new AppError(
        413,
        `Upload payload too large for server-proxied route. Max allowed is ${maxServerBytes / (1024 * 1024)} MB. Use direct signed upload.`
      );
    }

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await jsonBody(request).catch(() => ({}));
      if (!body || !body.dataBase64 || !body.name) {
        throw new AppError(400, 'Select a file.');
      }
      const buffer = Buffer.from(body.dataBase64, 'base64');
      const file = new File([buffer], body.name, {type: body.contentType || 'application/octet-stream'});
      return storeFile(identity, file);
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new AppError(400, 'Select a file.');
    }
    return storeFile(identity, file);
  });
}

export async function GET() {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const status = await getTenantStorageStatus(identity);

    return {
      provider: status.provider,
      configured: status.isConfigured,
      status: status.safeLabel,
      uploadsAvailable: status.isConfigured,
      maxFileSizeMb: 5,
      allowedTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
      safeLabel: status.safeLabel,
    };
  });
}
