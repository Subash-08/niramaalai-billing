import {checkOrigin, endpoint, requireIdentity, jsonBody, assertPrepareRateLimit} from '@/server/auth';
import {prepareDirectUpload} from '@/server/storage';
import {z} from 'zod';

export const runtime = 'nodejs';

const PrepareSchema = z.object({
  name: z.string().min(1).max(180),
  size: z.number().int().min(1, 'File size must be between 1 byte and 5 MB.').max(5 * 1024 * 1024, 'File size must be between 1 byte and 5 MB.'),
  type: z.string().min(1).max(100),
});

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    await assertPrepareRateLimit(identity);
    const raw = await jsonBody(request);
    const input = PrepareSchema.parse(raw);

    return prepareDirectUpload(identity, input);
  });
}
