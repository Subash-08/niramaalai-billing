import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {updateTemplate, archiveTemplate} from '@/server/sales-templates';

export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};

export async function PUT(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    const body = await jsonBody(request);
    return updateTemplate(await database(), identity, id, body);
  });
}

export async function DELETE(_request: Request, context: Context) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const {id} = await context.params;
    return archiveTemplate(await database(), identity, id);
  });
}
