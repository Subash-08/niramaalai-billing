import {checkOrigin, endpoint, requireIdentity, jsonBody, verifyLoginPassword, assertStorageRateLimit} from '@/server/auth';
import {AppError} from '@/server/db';
import {
  getTenantStorageStatus,
  saveCustomStorageConnection,
  resetToPlatformStorage,
} from '@/server/storage';
import {z} from 'zod';

export const runtime = 'nodejs';

const SaveStorageSchema = z.object({
  cloudName: z.string().min(1).max(60),
  apiKey: z.string().min(5).max(60),
  apiSecret: z.string().min(10).max(100),
  accountPassword: z.string().min(8).max(128),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const ResetStorageSchema = z.object({
  accountPassword: z.string().min(8).max(128),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export async function GET() {
  return endpoint(async () => {
    const identity = await requireIdentity();
    return getTenantStorageStatus(identity);
  });
}

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    await assertStorageRateLimit(identity);

    const raw = await jsonBody(request);
    const input = SaveStorageSchema.parse(raw);

    const passwordOk = await verifyLoginPassword(identity, input.accountPassword);
    if (!passwordOk) {
      throw new AppError(403, 'Incorrect account login password. Storage mutation rejected.');
    }

    const result = await saveCustomStorageConnection(identity, {
      cloudName: input.cloudName,
      apiKey: input.apiKey,
      apiSecret: input.apiSecret,
    }, input.expectedVersion);



    return result;
  });
}

export async function DELETE(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    await assertStorageRateLimit(identity);

    const raw = await jsonBody(request).catch(() => ({}));
    const input = ResetStorageSchema.parse(raw);

    const passwordOk = await verifyLoginPassword(identity, input.accountPassword);
    if (!passwordOk) {
      throw new AppError(403, 'Incorrect account login password. Storage reset rejected.');
    }

    const result = await resetToPlatformStorage(identity, input.expectedVersion);



    return result;
  });
}
