import {endpoint, requireIdentity, checkOrigin} from '@/server/auth';
import {setDefaultTemplate} from '@/server/master-service';

export const runtime = 'nodejs';

export async function POST(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    return setDefaultTemplate(identity, id);
  });
}
