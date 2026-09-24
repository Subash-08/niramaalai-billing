import {endpoint, requireIdentity, checkOrigin} from '@/server/auth';
import {database} from '@/server/db';
import {setDefaultTemplate} from '@/server/sales-templates';

export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};

export async function POST(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    return setDefaultTemplate(await database(), identity, id);
  });
}
