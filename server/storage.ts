import 'server-only';
import path from 'node:path';
import {mkdir, realpath, writeFile, readFile, unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {randomUUID, createHash} from 'node:crypto';
import {AppError, database, mongo} from './db';
import {Identity, tenantFilter} from './security';
import {
  encryptStorageSecret,
  decryptStorageSecret,
  EncryptedStorageEnvelope,
} from './storage-encryption';

export type StoredFile = {
  _id: string;
  tenantId: string;
  createdBy: string;
  key: string;
  name: string;
  type: string;
  size: number;
  status: 'Active' | 'Pending' | 'DeletePending' | 'DeleteFailed' | 'Orphaned' | 'Deleted';
  storageProvider: 'local' | 'cloudinary';
  storageConnectionId: string;
  cloudName?: string;
  cloudinaryPublicId?: string;
  cloudinaryResourceType?: 'image' | 'raw';
  cloudinaryDeliveryType?: 'authenticated' | 'upload';
  cloudinaryVersion?: number;
  checksum?: string;
  storageError?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
};

export type StorageConnectionDocument = {
  _id: string; // "CONN-${tenantId}-${uuid}"
  tenantId: string;
  provider: 'cloudinary';
  status: 'ActiveForNewUploads' | 'ReadOnlyRetained' | 'Unavailable';
  cloudName: string;
  apiKey: string;
  encryptedApiSecret: EncryptedStorageEnvelope;
  isPlatformDefault: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lastVerifiedAt?: Date;
  verifiedStatus?: 'Verified' | 'Failed';
  failureReason?: string;
};

export type PendingUploadDocument = {
  _id: string; // fileId
  tenantId: string;
  userId: string;
  storageConnectionId: string;
  cloudName: string;
  publicId: string;
  name: string;
  requestedSize: number;
  requestedType: string;
  status: 'Pending' | 'Completed' | 'Expired' | 'CleanupPending' | 'Cleaned';
  signatureTimestamp: number;
  expiresAt: Date;
  createdAt: Date;
  completedAt?: Date;
};

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const cloudNamePattern = /^[a-z0-9_-]{1,60}$/i;
const allowedMimes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

export function rfc5987Encode(str: string): string {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
}

export function hasPlatformCloudinary(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

export function getPlatformCloudinaryConfig() {
  if (!hasPlatformCloudinary()) return null;
  return {
    connectionId: 'platform-v1',
    cloudName: process.env.CLOUDINARY_CLOUD_NAME!,
    apiKey: process.env.CLOUDINARY_API_KEY!,
    apiSecret: process.env.CLOUDINARY_API_SECRET!,
    isCustom: false,
    available: true,
  };
}

export async function resolveStorageConnection(
  tenantId: string,
  connectionId: string
): Promise<{
  connectionId: string;
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  isCustom: boolean;
  available: boolean;
  status?: string;
} | null> {
  if (connectionId === 'local') return null;

  if (connectionId === 'platform-v1') {
    const platform = getPlatformCloudinaryConfig();
    if (!platform) {
      return {
        connectionId,
        cloudName: '',
        apiKey: '',
        apiSecret: '',
        isCustom: false,
        available: false,
        status: 'Unavailable',
      };
    }
    return platform;
  }

  const db = await database();
  const doc = await db
    .collection<StorageConnectionDocument>('storageConnections')
    .findOne({_id: connectionId, tenantId});

  if (!doc) {
    return {
      connectionId,
      cloudName: '',
      apiKey: '',
      apiSecret: '',
      isCustom: true,
      available: false,
      status: 'Unavailable',
    };
  }

  if (doc.status === 'Unavailable') {
    return {
      connectionId,
      cloudName: doc.cloudName,
      apiKey: doc.apiKey,
      apiSecret: '',
      isCustom: true,
      available: false,
      status: 'Unavailable',
    };
  }

  const currentPlatform = getPlatformCloudinaryConfig();
  if (doc.isPlatformDefault && currentPlatform?.cloudName === doc.cloudName) {
    return {...currentPlatform, connectionId: doc._id, status: doc.status};
  }

  try {
    const apiSecret = decryptStorageSecret(doc.encryptedApiSecret, {
      tenantId,
      connectionId: doc._id,
      version: doc.version,
    });
    return {
      connectionId: doc._id,
      cloudName: doc.cloudName,
      apiKey: doc.apiKey,
      apiSecret,
      isCustom: !doc.isPlatformDefault,
      available: true,
      status: doc.status,
    };
  } catch {
    return {
      connectionId: doc._id,
      cloudName: doc.cloudName,
      apiKey: doc.apiKey,
      apiSecret: '',
      isCustom: true,
      available: false,
      status: 'Unavailable',
    };
  }
}

export async function getTenantActiveStorageConnection(tenantId: string) {
  const db = await database();
  const settings = await db.collection<any>('companySettings').findOne({tenantId});
  const activeConnId = settings?.activeStorageConnectionId;

  if (activeConnId) {
    const conn = await resolveStorageConnection(tenantId, activeConnId);
    if (conn && conn.available && conn.status === 'ActiveForNewUploads') {
      return conn;
    }
    throw new AppError(503, 'Selected company storage is unavailable. Reconnect it or explicitly choose platform storage; no fallback upload was performed.');
  }

  const platform = getPlatformCloudinaryConfig();
  if (platform) {
    // Pin each new platform credential generation; changing the platform account
    // must not redirect historical files to the new account.
    const generation = createHash('sha256').update(JSON.stringify([tenantId, platform.cloudName, platform.apiKey, platform.apiSecret])).digest('hex');
    const connectionId = `PLATFORM-${generation}`;
    const now = new Date();
    const doc: StorageConnectionDocument = {
      _id: connectionId, tenantId, provider: 'cloudinary', status: 'ReadOnlyRetained',
      cloudName: platform.cloudName, apiKey: platform.apiKey,
      encryptedApiSecret: encryptStorageSecret(platform.apiSecret, {tenantId, connectionId, version: 1}),
      isPlatformDefault: true, version: 1, createdAt: now, updatedAt: now,
    };
    try {
      await db.collection<StorageConnectionDocument>('storageConnections').updateOne({_id: connectionId, tenantId}, {$setOnInsert: doc}, {upsert: true});
    } catch (error: any) { if (error?.code !== 11000) throw error; }
    return {...platform, connectionId};
  }

  return null;
}

async function localRoot() {
  const configured = process.env.PRIVATE_STORAGE_ROOT;
  if (!configured || !path.isAbsolute(configured)) {
    if (process.env.VERCEL) {
      throw new AppError(
        503,
        'File is stored on legacy local storage which is unavailable on Vercel. Asset migration to Cloudinary is required.'
      );
    }
    throw new AppError(503, 'Configure an absolute PRIVATE_STORAGE_ROOT outside the application directory.');
  }
  const resolved = path.resolve(configured),
    app = path.resolve(process.cwd());
  if (resolved === app || resolved.startsWith(app + path.sep)) {
    throw new AppError(503, 'Private files must be outside the application and public directories.');
  }
  await mkdir(resolved, {recursive: true, mode: 0o700});
  return realpath(resolved);
}

async function tenantDirectory(tenantId: string) {
  if (!idPattern.test(tenantId)) throw new AppError(403, 'Invalid tenant.');
  const base = await localRoot();
  const dir = path.join(base, tenantId);
  await mkdir(dir, {recursive: true, mode: 0o700});
  const canonical = await realpath(dir);
  if (!canonical.startsWith(base + path.sep)) throw new AppError(403, 'Invalid storage location.');
  return canonical;
}

function identify(bytes: Uint8Array): {type: string; ext: string} {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-') {
    return {type: 'application/pdf', ext: '.pdf'};
  }
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return {type: 'image/png', ext: '.png'};
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return {type: 'image/jpeg', ext: '.jpg'};
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP'
  ) {
    return {type: 'image/webp', ext: '.webp'};
  }
  throw new AppError(400, 'Unsupported file type or invalid file contents.');
}

// -------------------------------------------------------------
// Direct Signed Upload: Prepare & Complete
// -------------------------------------------------------------

export async function prepareDirectUpload(
  identity: Identity,
  input: {name: string; size: number; type: string}
) {
  const maxBytes = 5 * 1024 * 1024; // 5 MB
  if (!input.size || input.size < 1 || input.size > maxBytes) {
    throw new AppError(400, 'File size must be between 1 byte and 5 MB.');
  }

  const cleanName = input.name.replace(/[\r\n\x00-\x1f]/g, '').trim();
  if (!cleanName) throw new AppError(400, 'File name is required.');

  const ext = path.extname(cleanName).toLowerCase();
  const allowedExts = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];
  if (!allowedExts.includes(ext)) {
    throw new AppError(400, 'Allowed file formats: PNG, JPEG, WebP, PDF.');
  }

  const requestedMime = input.type.toLowerCase();
  if (!allowedMimes.includes(requestedMime)) {
    throw new AppError(400, 'Allowed file formats: PNG, JPEG, WebP, PDF.');
  }

  const conn = await getTenantActiveStorageConnection(identity.tenantId);
  if (!conn || !conn.available) {
    // If Cloudinary is not configured, direct upload cannot be used; client must use fallback POST /api/files
    return {directUploadAvailable: false};
  }

  const fileId = randomUUID();
  const folder = `itech/${identity.tenantId}`;
  const publicId = `${folder}/${fileId}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const type = 'authenticated';
  const overwrite = 'false';

  // Strict alphabetical order: folder, overwrite, public_id, timestamp, type
  const signString = `folder=${folder}&overwrite=${overwrite}&public_id=${fileId}&timestamp=${timestamp}&type=${type}${conn.apiSecret}`;
  const signature = createHash('sha1').update(signString).digest('hex');

  const pendingDoc: PendingUploadDocument = {
    _id: fileId,
    tenantId: identity.tenantId,
    userId: identity.userId,
    storageConnectionId: conn.connectionId,
    cloudName: conn.cloudName,
    publicId,
    name: cleanName.slice(0, 180),
    requestedSize: input.size,
    requestedType: requestedMime,
    status: 'Pending',
    signatureTimestamp: timestamp,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 mins
    createdAt: new Date(),
  };

  const db = await database();
  const session = (await mongo()).startSession();
  try {
    await session.withTransaction(async () => {
      const now = new Date();

      // Expire stale pending uploads to reconcile quota
      await db.collection('pendingUploads').updateMany(
        {tenantId: identity.tenantId, status: 'Pending', expiresAt: {$lte: now}},
        {$set: {status: 'Expired', expiredAt: now}},
        {session}
      );

      // Serialize tenant quota admissions on companySettings
      await db.collection('companySettings').updateOne(
        {tenantId: identity.tenantId},
        {$inc: {pendingUploadReservationSeq: 1}},
        {session, upsert: true}
      );

      // Bound active pending upload quotas to prevent signature/storage flooding
      const activeTenantPending = await db.collection('pendingUploads').countDocuments({
        tenantId: identity.tenantId,
        status: 'Pending',
        expiresAt: {$gt: now},
      }, {session});

      if (activeTenantPending >= 20) {
        throw new AppError(429, 'Too many pending uploads for this company. Please complete or wait for existing uploads to expire.');
      }

      const activeUserPending = await db.collection('pendingUploads').countDocuments({
        tenantId: identity.tenantId,
        userId: identity.userId,
        status: 'Pending',
        expiresAt: {$gt: now},
      }, {session});

      if (activeUserPending >= 10) {
        throw new AppError(429, 'Too many pending uploads for your user account. Please complete or wait for existing uploads to expire.');
      }

      await db.collection<PendingUploadDocument>('pendingUploads').insertOne(pendingDoc, {session});
    });
  } finally {
    await session.endSession();
  }

  return {
    directUploadAvailable: true,
    uploadUrl: `https://api.cloudinary.com/v1_1/${conn.cloudName}/auto/upload`,
    fields: {
      folder,
      public_id: fileId,
      timestamp: String(timestamp),
      type,
      overwrite,
      api_key: conn.apiKey,
      signature,
    },
    fileId,
    name: cleanName,
  };
}

export async function completeDirectUpload(identity: Identity, input: {fileId: string}) {
  const fileId = input.fileId;
  if (!idPattern.test(fileId)) throw new AppError(400, 'Invalid file ID.');

  const db = await database();
  const pending = await db
    .collection<PendingUploadDocument>('pendingUploads')
    .findOne({_id: fileId, tenantId: identity.tenantId, userId: identity.userId});

  if (!pending) {
    throw new AppError(404, 'Pending upload record not found.');
  }

  // Idempotency: if already completed, return existing active file
  if (pending.status === 'Completed') {
    const existing = await db
      .collection<StoredFile>('files')
      .findOne(tenantFilter(identity, {_id: fileId, status: 'Active'}));
    if (existing) {
      return {
        _id: existing._id,
        id: existing._id,
        name: existing.name,
        type: existing.type,
        size: existing.size,
        url: `/api/files/${existing._id}`,
      };
    }
  }

  if (pending.status !== 'Pending') {
    throw new AppError(400, 'Upload is not in pending state.');
  }

  if (pending.expiresAt < new Date()) {
    throw new AppError(400, 'Upload signature has expired. Please initiate a new upload.');
  }

  const conn = await resolveStorageConnection(identity.tenantId, pending.storageConnectionId);
  if (!conn || !conn.available) {
    throw new AppError(503, 'Storage connection is unavailable.');
  }

  // Query Cloudinary Resource API to verify actual uploaded asset
  const authHeader = 'Basic ' + Buffer.from(`${conn.apiKey}:${conn.apiSecret}`).toString('base64');
  let resourceType: 'image' | 'raw' = 'image';
  let res = await fetch(
    `https://api.cloudinary.com/v1_1/${conn.cloudName}/resources/image/authenticated/${encodeURIComponent(pending.publicId)}`,
    {headers: {Authorization: authHeader}, redirect: 'error', signal: AbortSignal.timeout(20000), cache: 'no-store'}
  );

  if (res.status === 404) {
    resourceType = 'raw';
    res = await fetch(
      `https://api.cloudinary.com/v1_1/${conn.cloudName}/resources/raw/authenticated/${encodeURIComponent(pending.publicId)}`,
      {headers: {Authorization: authHeader}, redirect: 'error', signal: AbortSignal.timeout(20000), cache: 'no-store'}
    );
  }

  if (!res.ok) {
    throw new AppError(400, 'File upload could not be verified with storage provider.');
  }

  const info = await res.json();

  if (info.type !== 'authenticated') {
    throw new AppError(400, 'File delivery type must be authenticated.');
  }

  const actualBytes = Number(info.bytes);
  if (!Number.isFinite(actualBytes) || actualBytes <= 0 || actualBytes > 5 * 1024 * 1024) {
    throw new AppError(400, 'Uploaded file size exceeded allowed 5 MB limit.');
  }

  if (info.public_id !== pending.publicId || info.resource_type !== resourceType || conn.cloudName !== pending.cloudName) {
    throw new AppError(400, 'Uploaded asset identity does not match this upload request.');
  }
  if (!Number.isSafeInteger(actualBytes) || actualBytes !== pending.requestedSize) throw new AppError(400, 'Uploaded file size does not match the selected file.');
  // Inspect actual content before trusting the requested MIME or filename.
  const verifyTimestamp = Math.floor(Date.now() / 1000);
  const verifyParams: Record<string, string> = {public_id: pending.publicId, timestamp: String(verifyTimestamp), expires_at: String(verifyTimestamp + 60), type: 'authenticated'};
  if (resourceType === 'image' && typeof info.format === 'string' && /^[a-z0-9]+$/.test(info.format)) verifyParams.format = info.format;
  const verifySignature = createHash('sha1').update(Object.keys(verifyParams).sort().map(key => `${key}=${verifyParams[key]}`).join('&') + conn.apiSecret).digest('hex');
  const verifyUrl = `https://api.cloudinary.com/v1_1/${conn.cloudName}/${resourceType}/download?` + new URLSearchParams({...verifyParams, api_key: conn.apiKey, signature: verifySignature});
  const content = await fetch(verifyUrl, {redirect: 'error', signal: AbortSignal.timeout(20000), cache: 'no-store'});
  if (!content.ok || !content.body) throw new AppError(502, 'Uploaded file contents could not be verified.');
  const reader = content.body.getReader();
  const chunks: Uint8Array[] = [];
  let contentSize = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    contentSize += chunk.value.byteLength;
    if (contentSize > 5 * 1024 * 1024) { await reader.cancel(); throw new AppError(400, 'Uploaded content exceeds 5 MB.'); }
    chunks.push(chunk.value);
  }
  const verifiedBytes = Buffer.concat(chunks);
  const format = identify(verifiedBytes);
  if (format.type !== pending.requestedType || contentSize !== actualBytes) throw new AppError(400, 'Uploaded content does not match its declared type or size.');
  const ext = format.ext;
  const now = new Date();
  const storedRecord: StoredFile = {
    _id: fileId,
    tenantId: identity.tenantId,
    createdBy: identity.userId,
    key: fileId + ext,
    name: pending.name,
    type: format.type,
    checksum: createHash('sha256').update(verifiedBytes).digest('hex'),
    size: actualBytes,
    status: 'Active',
    storageProvider: 'cloudinary',
    storageConnectionId: conn.connectionId,
    cloudName: conn.cloudName,
    cloudinaryPublicId: pending.publicId,
    cloudinaryResourceType: resourceType,
    cloudinaryDeliveryType: 'authenticated',
    cloudinaryVersion: info.version,
    createdAt: now,
    updatedAt: now,
  };

  const session = (await mongo()).startSession();
  try {
    await session.withTransaction(async () => {
      const current = await db.collection<PendingUploadDocument>('pendingUploads').findOne({_id: fileId, tenantId: identity.tenantId, userId: identity.userId}, {session});
      if (current?.status === 'Completed') {
        const existing = await db.collection<StoredFile>('files').findOne({_id: fileId, tenantId: identity.tenantId, status: 'Active'}, {session});
        if (!existing || existing.checksum !== storedRecord.checksum) throw new AppError(409, 'Upload completion conflicts with its saved file.');
        return;
      }
      if (!current || current.status !== 'Pending' || current.expiresAt <= new Date() || current.storageConnectionId !== pending.storageConnectionId) throw new AppError(409, 'Pending upload changed or expired; prepare a new upload.');
      await db.collection<StoredFile>('files').insertOne(storedRecord, {session});
      await db.collection<PendingUploadDocument>('pendingUploads').updateOne(
        {_id: fileId, tenantId: identity.tenantId, userId: identity.userId, status: 'Pending'},
        {$set: {status: 'Completed', completedAt: now}}, {session}
      );
    });
  } finally { await session.endSession(); }

  return {
    _id: storedRecord._id,
    id: storedRecord._id,
    name: storedRecord.name,
    type: storedRecord.type,
    size: storedRecord.size,
    url: `/api/files/${storedRecord._id}`,
  };
}

// -------------------------------------------------------------
// Server-Proxied Upload (Legacy fallback / Local VPS / Dev)
// -------------------------------------------------------------

export async function storeFile(identity: Identity, file: File) {
  // Bounded server-side upload limit: 4 MB on Vercel (to guarantee staying under 4.5 MB function limit)
  const maxBytes = process.env.VERCEL ? 4 * 1024 * 1024 : 5 * 1024 * 1024;
  if (file.size < 1 || file.size > maxBytes) {
    throw new AppError(
      400,
      `File size exceeds server upload limit (${maxBytes / (1024 * 1024)} MB). Use direct upload for 5 MB files.`
    );
  }

  const ext = path.extname(file.name).toLowerCase();
  const allowedExts = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];
  if (ext && !allowedExts.includes(ext)) {
    throw new AppError(400, 'Unsupported file type or extension.');
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = identify(bytes);

  if (file.type) {
    const declared = file.type.toLowerCase();
    const isJpegMatch = format.type === 'image/jpeg' && (declared === 'image/jpeg' || declared === 'image/jpg');
    if (declared !== format.type && !isJpegMatch) {
      throw new AppError(400, 'File content does not match declared MIME type.');
    }
  }

  const id = randomUUID();
  const key = id + format.ext;
  const checksum = createHash('sha256').update(bytes).digest('hex');

  const activeConn = await getTenantActiveStorageConnection(identity.tenantId);

  if (activeConn && activeConn.available) {
    // Cloudinary authenticated upload
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `itech/${identity.tenantId}`;
    const publicId = `${folder}/${id}`;
    const type = 'authenticated';
    const overwrite = 'false';

    const signString = `folder=${folder}&overwrite=${overwrite}&public_id=${id}&timestamp=${timestamp}&type=${type}${activeConn.apiSecret}`;
    const signature = createHash('sha1').update(signString).digest('hex');

    const base64Data = Buffer.from(bytes).toString('base64');
    const dataUri = `data:${format.type};base64,${base64Data}`;

    const body = new URLSearchParams({
      file: dataUri,
      timestamp: String(timestamp),
      folder,
      public_id: id,
      type,
      overwrite,
      api_key: activeConn.apiKey,
      signature,
    });

    const res = await fetch(`https://api.cloudinary.com/v1_1/${activeConn.cloudName}/auto/upload`, {
      method: 'POST',
      body,
    });

    const json = await res.json();
    if (!res.ok) {
      throw new AppError(502, `Cloud storage upload failed: ${json.error?.message || 'Unknown provider error'}`);
    }

    const resourceType: 'image' | 'raw' = json.resource_type === 'raw' ? 'raw' : 'image';
    const record: StoredFile = {
      _id: id,
      tenantId: identity.tenantId,
      createdBy: identity.userId,
      key,
      name: file.name.replace(/[\r\n\x00-\x1f]/g, '').slice(0, 180) || key,
      type: format.type,
      size: bytes.length,
      status: 'Active',
      storageProvider: 'cloudinary',
      storageConnectionId: activeConn.connectionId,
      cloudName: activeConn.cloudName,
      cloudinaryPublicId: json.public_id,
      cloudinaryResourceType: resourceType,
      cloudinaryDeliveryType: 'authenticated',
      cloudinaryVersion: json.version,
      checksum,
      createdAt: new Date(),
    };

    const db = await database();
    await db.collection<StoredFile>('files').insertOne(record);

    return {
      _id: record._id,
      id: record._id,
      name: record.name,
      type: record.type,
      size: record.size,
      url: '/api/files/' + record._id,
    };
  }

  // Local filesystem storage
  const dir = await tenantDirectory(identity.tenantId);
  const targetLocalPath = path.join(dir, key);
  await writeFile(targetLocalPath, bytes, {flag: 'wx', mode: 0o600});

  const record: StoredFile = {
    _id: id,
    tenantId: identity.tenantId,
    createdBy: identity.userId,
    key,
    name: file.name.replace(/[\r\n\x00-\x1f]/g, '').slice(0, 180) || key,
    type: format.type,
    size: bytes.length,
    status: 'Active',
    storageProvider: 'local',
    storageConnectionId: 'local',
    checksum,
    createdAt: new Date(),
  };

  try {
    const db = await database();
    await db.collection<StoredFile>('files').insertOne(record);
  } catch (e) {
    await unlink(targetLocalPath).catch(() => {});
    throw e;
  }

  return {
    _id: record._id,
    id: record._id,
    name: record.name,
    type: record.type,
    size: record.size,
    url: '/api/files/' + record._id,
  };
}

// -------------------------------------------------------------
// Streaming File Retrieval
// -------------------------------------------------------------

export async function getFile(identity: Identity, id: string): Promise<{
  record: StoredFile;
  stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
  size: number;
}> {
  if (!idPattern.test(id)) throw new AppError(404, 'File not found.');
  const db = await database();
  const record = await db.collection<StoredFile>('files').findOne(tenantFilter(identity, {_id: id}));

  if (!record || record.status !== 'Active') {
    throw new AppError(404, 'File not found.');
  }

  if (record.storageProvider === 'cloudinary') {
    const conn = await resolveStorageConnection(identity.tenantId, record.storageConnectionId);
    if (!conn || !conn.available) {
      throw new AppError(503, 'Storage connection for this asset is unavailable. Verify storage credentials.');
    }

    if (record.cloudName && conn.cloudName !== record.cloudName) throw new AppError(503, 'This file belongs to a different storage account. Restore its original connection or migrate it explicitly.');
    const timestamp = Math.floor(Date.now() / 1000);
    const resourceType = record.cloudinaryResourceType || (record.type === 'application/pdf' ? 'raw' : 'image');
    const publicId = record.cloudinaryPublicId || record.key.replace(/\.[^/.]+$/, '');
    const deliveryType = record.cloudinaryDeliveryType || 'authenticated';

    const signString = `public_id=${publicId}&timestamp=${timestamp}&type=${deliveryType}${conn.apiSecret}`;
    const signature = createHash('sha1').update(signString).digest('hex');

    const downloadUrl = `https://api.cloudinary.com/v1_1/${conn.cloudName}/${resourceType}/download?public_id=${encodeURIComponent(publicId)}&timestamp=${timestamp}&type=${deliveryType}&api_key=${conn.apiKey}&signature=${signature}`;

    const res = await fetch(downloadUrl);
    if (!res.ok || !res.body) {
      throw new AppError(404, 'File could not be retrieved from remote cloud storage.');
    }

    return {
      record,
      stream: res.body as ReadableStream<Uint8Array>,
      size: record.size,
    };
  }

  // Local filesystem storage
  const dir = await tenantDirectory(identity.tenantId);
  let filePath: string;
  try {
    filePath = await realpath(path.join(dir, record.key));
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new AppError(404, 'File not found on local storage.');
    }
    throw new AppError(403, 'Invalid file location.');
  }
  if (!filePath.startsWith(dir + path.sep)) throw new AppError(403, 'Invalid file location.');

  const nodeStream = createReadStream(filePath);
  return {
    record,
    stream: nodeStream,
    size: record.size,
  };
}

// -------------------------------------------------------------
// Deletion & Orphan Cleanup
// -------------------------------------------------------------

export async function deleteFromCloudinary(
  tenantId: string,
  storageConnectionId: string,
  publicId: string,
  resourceType: 'image' | 'raw' = 'image',
  deliveryType = 'authenticated'
): Promise<{success: boolean; error?: string}> {
  const conn = await resolveStorageConnection(tenantId, storageConnectionId);
  if (!conn || !conn.available) {
    return {success: false, error: 'Storage connection credentials unavailable.'};
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signString = `public_id=${publicId}&timestamp=${timestamp}&type=${deliveryType}${conn.apiSecret}`;
  const signature = createHash('sha1').update(signString).digest('hex');

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${conn.cloudName}/${resourceType}/destroy`, {
      signal: AbortSignal.timeout(8000),
      method: 'POST',
      body: new URLSearchParams({
        public_id: publicId,
        timestamp: String(timestamp),
        type: deliveryType,
        api_key: conn.apiKey,
        signature,
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (res.ok && (json.result === 'ok' || json.result === 'not found')) {
      return {success: true};
    }
    return {success: false, error: json.error?.message || `Provider returned status ${res.status}`};
  } catch (err: any) {
    return {success: false, error: err?.message || 'Network error deleting remote asset.'};
  }
}

export async function cleanupOrphanFiles(identity: Identity) {
  // Only never-completed upload reservations are eligible. Saved files are not
  // garbage-collected here, even if no current document references them.
  const db = await database();
  const tenantId = identity.tenantId;
  const before = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const candidates = await db.collection<any>('pendingUploads').find({tenantId,
    status: {$in: ['Pending', 'Expired', 'CleanupPending']}, expiresAt: {$lt: before},
    $or: [{cleanupLeaseUntil: {$exists: false}}, {cleanupLeaseUntil: {$lt: new Date()}}],
  }).sort({expiresAt: 1, _id: 1}).limit(5).toArray();
  let deletedCount = 0, failedCount = 0, skippedCount = 0;
  for (const candidate of candidates) {
    const session = (await mongo()).startSession();
    const lease = randomUUID();
    let claimed: any = null;
    try {
      claimed = await session.withTransaction(async () => {
        if (await db.collection('files').findOne({tenantId, $or: [{_id: candidate._id}, {publicId: candidate.publicId}]}, {session})) return null;
        return db.collection<any>('pendingUploads').findOneAndUpdate({_id: candidate._id, tenantId,
          status: {$in: ['Pending', 'Expired', 'CleanupPending']}, expiresAt: {$lt: before},
          $or: [{cleanupLeaseUntil: {$exists: false}}, {cleanupLeaseUntil: {$lt: new Date()}}],
        }, {$set: {status: 'CleanupPending', cleanupLease: lease, cleanupLeaseUntil: new Date(Date.now() + 5 * 60 * 1000)}}, {session, returnDocument: 'after'});
      });
    } finally { await session.endSession(); }
    if (!claimed) { skippedCount++; continue; }
    const conn = await resolveStorageConnection(tenantId, claimed.storageConnectionId);
    const ownsPath = idPattern.test(claimed._id) && claimed.publicId === `itech/${tenantId}/${claimed._id}`;
    let success = false;
    if (ownsPath && conn?.available && conn.cloudName === claimed.cloudName) {
      // Auto upload can store PDFs as raw or image; both owned namespaces are
      // checked. The reservation cannot become Completed after the claim.
      const image = await deleteFromCloudinary(tenantId, claimed.storageConnectionId, claimed.publicId, 'image');
      const raw = await deleteFromCloudinary(tenantId, claimed.storageConnectionId, claimed.publicId, 'raw');
      success = image.success && raw.success;
    }
    await db.collection('pendingUploads').updateOne({_id: claimed._id, tenantId, cleanupLease: lease}, {
      $set: {status: success ? 'Cleaned' : 'CleanupPending', cleanupCheckedAt: new Date(), ...(success ? {cleanedAt: new Date()} : {})},
      $unset: {cleanupLease: '', cleanupLeaseUntil: ''},
    });
    if (success) deletedCount++; else failedCount++;
  }
  return {deletedCount, failedCount, skippedCount, scope: 'Expired uploads only; saved files retained'};
}

export async function testCloudinaryStorage(input: {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}): Promise<{success: boolean; message: string}> {
  const cloudName = input.cloudName.trim();
  const apiKey = input.apiKey.trim();
  const apiSecret = input.apiSecret.trim();

  if (!cloudNamePattern.test(cloudName)) {
    throw new AppError(400, 'Invalid Cloud Name syntax. Only alphanumeric characters, hyphens, and underscores are permitted.');
  }
  if (!apiKey || apiKey.length < 5 || apiKey.length > 50) {
    throw new AppError(400, 'Invalid Cloudinary API Key.');
  }
  if (!apiSecret || apiSecret.length < 10 || apiSecret.length > 100) {
    throw new AppError(400, 'Invalid Cloudinary API Secret.');
  }

  const testImgId = `test_img_${randomUUID().slice(0, 8)}`;
  const testRawId = `test_pdf_${randomUUID().slice(0, 8)}`;
  const folder = 'itech-test';
  const timestamp = Math.floor(Date.now() / 1000);
  const type = 'authenticated';
  const overwrite = 'false';

  // 1. Test Image Upload
  const imgSignString = `folder=${folder}&overwrite=${overwrite}&public_id=${testImgId}&timestamp=${timestamp}&type=${type}${apiSecret}`;
  const imgSignature = createHash('sha1').update(imgSignString).digest('hex');

  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const imgRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: new URLSearchParams({
      file: `data:image/png;base64,${pngBase64}`,
      timestamp: String(timestamp),
      folder,
      public_id: testImgId,
      type,
      overwrite,
      api_key: apiKey,
      signature: imgSignature,
    }),
  });

  const imgJson = await imgRes.json().catch(() => ({}));
  if (!imgRes.ok) {
    throw new AppError(400, `Cloudinary image upload failed: ${imgJson.error?.message || 'Authentication error'}`);
  }

  // 2. Test Authenticated Raw/PDF Upload
  const rawSignString = `folder=${folder}&overwrite=${overwrite}&public_id=${testRawId}&timestamp=${timestamp}&type=${type}${apiSecret}`;
  const rawSignature = createHash('sha1').update(rawSignString).digest('hex');
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer<</Size 2/Root 1 0 R>>\nstartxref\n40\n%%EOF');

  const rawRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, {
    method: 'POST',
    body: new URLSearchParams({
      file: `data:application/pdf;base64,${pdfBytes.toString('base64')}`,
      timestamp: String(timestamp),
      folder,
      public_id: testRawId,
      type,
      overwrite,
      api_key: apiKey,
      signature: rawSignature,
    }),
  });

  const rawJson = await rawRes.json().catch(() => ({}));
  if (!rawRes.ok) {
    // Attempt image cleanup before failing
    const delTs = Math.floor(Date.now() / 1000);
    const delSign = createHash('sha1').update(`public_id=${imgJson.public_id}&timestamp=${delTs}&type=${type}${apiSecret}`).digest('hex');
    await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
      method: 'POST',
      body: new URLSearchParams({public_id: imgJson.public_id, timestamp: String(delTs), type, api_key: apiKey, signature: delSign}),
    }).catch(() => {});
    throw new AppError(400, `Cloudinary PDF raw upload failed: ${rawJson.error?.message || 'Raw delivery not permitted'}`);
  }

  // 3. Test & Verify Deletion for Both Assets
  const delTs = Math.floor(Date.now() / 1000);
  const imgDelSign = createHash('sha1').update(`public_id=${imgJson.public_id}&timestamp=${delTs}&type=${type}${apiSecret}`).digest('hex');
  const imgDelRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
    method: 'POST',
    body: new URLSearchParams({public_id: imgJson.public_id, timestamp: String(delTs), type, api_key: apiKey, signature: imgDelSign}),
  });
  const imgDelJson = await imgDelRes.json().catch(() => ({}));
  const imgDelOk = imgDelRes.ok && (imgDelJson.result === 'ok' || imgDelJson.result === 'not found');

  const rawDelSign = createHash('sha1').update(`public_id=${rawJson.public_id}&timestamp=${delTs}&type=${type}${apiSecret}`).digest('hex');
  const rawDelRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/destroy`, {
    method: 'POST',
    body: new URLSearchParams({public_id: rawJson.public_id, timestamp: String(delTs), type, api_key: apiKey, signature: rawDelSign}),
  });
  const rawDelJson = await rawDelRes.json().catch(() => ({}));
  const rawDelOk = rawDelRes.ok && (rawDelJson.result === 'ok' || rawDelJson.result === 'not found');

  if (!imgDelOk || !rawDelOk) {
    throw new AppError(400, 'Cloudinary test asset deletion check failed. Verify destroy permissions for both image and raw resources.');
  }

  return {success: true, message: 'Cloudinary image, PDF authenticated delivery, and deletion permissions verified successfully.'};
}

export async function saveCustomStorageConnection(
  identity: Identity,
  input: {cloudName: string; apiKey: string; apiSecret: string},
  expectedVersion: number
) {
  // Test connection first with images, PDFs, and verified destroys
  await testCloudinaryStorage(input);

  const db = await database();
  const tenantId = identity.tenantId;
  const cloudName = input.cloudName.trim();
  const apiKey = input.apiKey.trim();
  const apiSecret = input.apiSecret.trim();

  const connectionId = `CONN-${tenantId}-${randomUUID()}`;
  const encryptedApiSecret = encryptStorageSecret(apiSecret, {
    tenantId,
    connectionId,
    version: 1,
  });

  const now = new Date();
  const connDoc: StorageConnectionDocument = {
    _id: connectionId,
    tenantId,
    provider: 'cloudinary',
    status: 'ActiveForNewUploads',
    cloudName,
    apiKey,
    encryptedApiSecret,
    isPlatformDefault: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
    verifiedStatus: 'Verified',
  };

  const session = (await mongo()).startSession();
  try {
    await session.withTransaction(async () => {
      const currentSettings = await db.collection('companySettings').findOne({tenantId}, {session});
      if (!currentSettings) throw new AppError(409, 'Save company settings before configuring storage.');
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (currentSettings.storageSettingsVersion ?? 0) !== expectedVersion) {
        throw new AppError(409, 'Storage configuration was modified by another session. Please refresh and try again.');
      }

      // Retire existing active connection to ReadOnlyRetained
      await db.collection<StorageConnectionDocument>('storageConnections').updateMany(
        {tenantId, status: 'ActiveForNewUploads'},
        {$set: {status: 'ReadOnlyRetained', updatedAt: now}},
        {session}
      );

      await db.collection<StorageConnectionDocument>('storageConnections').insertOne(connDoc, {session});

      await db.collection('companySettings').updateOne(
        {tenantId},
        {
          $set: {activeStorageConnectionId: connectionId, updatedAt: now},
          $inc: {storageSettingsVersion: 1},
        },
        {session}
      );
      await db.collection('auditHistory').insertOne({tenantId, userId: identity.userId, action: 'ConfigureCustomStorage', timestamp: now}, {session});
    });
  } finally {
    await session.endSession();
  }

  return {
    success: true,
    connectionId,
    safeLabel: `Custom Cloudinary (${cloudName})`,
  };
}

export async function resetToPlatformStorage(identity: Identity, expectedVersion: number) {
  const db = await database();
  const tenantId = identity.tenantId;
  const now = new Date();

  const session = (await mongo()).startSession();
  try {
    await session.withTransaction(async () => {
      const currentSettings = await db.collection('companySettings').findOne({tenantId}, {session});
      if (!currentSettings) throw new AppError(409, 'Save company settings before configuring storage.');
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (currentSettings.storageSettingsVersion ?? 0) !== expectedVersion) {
        throw new AppError(409, 'Storage configuration was modified by another session. Please refresh and try again.');
      }

      // Demote current custom active connections to ReadOnlyRetained (never delete, so existing files remain readable)
      await db.collection<StorageConnectionDocument>('storageConnections').updateMany(
        {tenantId, status: 'ActiveForNewUploads'},
        {$set: {status: 'ReadOnlyRetained', updatedAt: now}},
        {session}
      );

      await db.collection('companySettings').updateOne(
        {tenantId},
        {
          $unset: {activeStorageConnectionId: ''},
          $set: {updatedAt: now},
          $inc: {storageSettingsVersion: 1},
        },
        {session}
      );
      await db.collection('auditHistory').insertOne({tenantId, userId: identity.userId, action: 'ResetToPlatformStorage', timestamp: now}, {session});
    });
  } finally {
    await session.endSession();
  }

  return {
    success: true,
    safeLabel: hasPlatformCloudinary() ? 'Platform Managed Cloud Storage' : 'Private Filesystem',
  };
}

export async function getTenantStorageStatus(identity: Identity) {
  const db = await database();
  const settings = await db.collection<any>('companySettings').findOne({tenantId: identity.tenantId});
  const activeConnId = settings?.activeStorageConnectionId;

  if (activeConnId) {
    const conn = await db
      .collection<StorageConnectionDocument>('storageConnections')
      .findOne({_id: activeConnId, tenantId: identity.tenantId});

    if (conn) {
      return {
        storageSettingsVersion: settings?.storageSettingsVersion ?? 0,
        provider: 'Custom Cloudinary',
        isCustom: true,
        cloudName: conn.cloudName,
        apiKey: conn.apiKey,
        status: conn.status,
        safeLabel: `Custom Cloudinary (${conn.cloudName})`,
        lastVerifiedAt: conn.lastVerifiedAt?.toISOString(),
        isConfigured: conn.status === 'ActiveForNewUploads',
      };
    }
  }

  if (activeConnId) throw new AppError(409, 'Configured storage connection is unavailable. Review your storage settings.');

  if (hasPlatformCloudinary()) {
    return {
      storageSettingsVersion: settings?.storageSettingsVersion ?? 0,
        provider: 'Platform Cloudinary (Default)',
      isCustom: false,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      status: 'ActiveForNewUploads',
      safeLabel: 'Platform Managed Cloud Storage',
      lastVerifiedAt: undefined,
      isConfigured: true,
    };
  }

  const isVercel = Boolean(process.env.VERCEL);
  const isConfiguredLocal = Boolean(process.env.PRIVATE_STORAGE_ROOT) && !isVercel;

  return {
    storageSettingsVersion: settings?.storageSettingsVersion ?? 0,
        provider: isVercel ? 'Vercel Ephemeral (Cloud Storage Required)' : 'Private Filesystem',
    isCustom: false,
    status: isConfiguredLocal ? 'ActiveForNewUploads' : 'Unavailable',
    safeLabel: isConfiguredLocal ? 'Private Filesystem' : 'Storage Not Configured',
    isConfigured: isConfiguredLocal,
  };
}
