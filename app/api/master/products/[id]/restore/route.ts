import {endpoint, requireIdentity, checkOrigin} from '@/server/auth';
import {restoreProduct} from '@/server/master-service';

export const runtime = 'nodejs';

export async function POST(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    return restoreProduct(identity, id);
  });
}
