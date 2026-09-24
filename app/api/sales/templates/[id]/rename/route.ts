import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {renameTemplate} from '@/server/sales-templates';

export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};

export async function PATCH(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    const body = await jsonBody(request);
    return renameTemplate(await database(), identity, id, body.name);
  });
}
