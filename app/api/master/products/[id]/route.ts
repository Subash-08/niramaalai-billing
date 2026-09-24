import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {getProductById, updateProduct, archiveProduct} from '@/server/master-service';
import {ProductInputSchema} from '@/server/master-schema';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const {id} = await context.params;
    return getProductById(identity, id);
  });
}

export async function PUT(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    const body = ProductInputSchema.parse(await jsonBody(request));
    return updateProduct(identity, id, body);
  });
}

export async function DELETE(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    return archiveProduct(identity, id);
  });
}
