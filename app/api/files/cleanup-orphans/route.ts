import {checkOrigin, endpoint, requireIdentity} from '@/server/auth';
import {cleanupOrphanFiles} from '@/server/storage';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    return cleanupOrphanFiles(identity);
  });
}
