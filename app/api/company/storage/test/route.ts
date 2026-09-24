import {checkOrigin, endpoint, requireIdentity, jsonBody, verifyLoginPassword, assertStorageRateLimit} from '@/server/auth';
import {AppError} from '@/server/db';
import {testCloudinaryStorage} from '@/server/storage';
import {z} from 'zod';

export const runtime = 'nodejs';

const TestStorageSchema = z.object({
  cloudName: z.string().min(1).max(60),
  apiKey: z.string().min(5).max(60),
  apiSecret: z.string().min(10).max(100),
  accountPassword: z.string().min(8).max(128),
});

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    await assertStorageRateLimit(identity);

    const raw = await jsonBody(request);
    const input = TestStorageSchema.parse(raw);

    const passwordOk = await verifyLoginPassword(identity, input.accountPassword);
    if (!passwordOk) {
      throw new AppError(403, 'Incorrect account login password. Storage verification rejected.');
    }

    return testCloudinaryStorage({
      cloudName: input.cloudName,
      apiKey: input.apiKey,
      apiSecret: input.apiSecret,
    });
  });
}
