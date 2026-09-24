import {checkOrigin, endpoint, requireIdentity, jsonBody} from '@/server/auth';
import {completeDirectUpload} from '@/server/storage';
import {z} from 'zod';

export const runtime = 'nodejs';

const CompleteSchema = z.object({
  fileId: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const raw = await jsonBody(request);
    const input = CompleteSchema.parse(raw);

    return completeDirectUpload(identity, input);
  });
}
