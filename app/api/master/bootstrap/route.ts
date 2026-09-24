import {endpoint, requireIdentity} from '@/server/auth';
import {bootstrap} from '@/server/master-service';

export const runtime = 'nodejs';

export async function GET() {
  return endpoint(async () => {
    const identity = await requireIdentity();
    return bootstrap(identity);
  });
}
