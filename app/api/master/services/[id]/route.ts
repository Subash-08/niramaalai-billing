import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {getServiceById, updateService, archiveService} from '@/server/master-service';
import {ServiceCatalogInputSchema} from '@/server/master-schema';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const {id} = await context.params;
    return getServiceById(identity, id);
  });
}

export async function PUT(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    const body = ServiceCatalogInputSchema.parse(await jsonBody(request));
    return updateService(identity, id, body);
  });
}

export async function DELETE(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    return archiveService(identity, id);
  });
}
