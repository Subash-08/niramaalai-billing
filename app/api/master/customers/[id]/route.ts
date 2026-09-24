import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {getCustomerById, updateCustomer, archiveCustomer} from '@/server/master-service';
import {CustomerInputSchema} from '@/server/master-schema';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const {id} = await context.params;
    return getCustomerById(identity, id);
  });
}

export async function PUT(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    const body = CustomerInputSchema.parse(await jsonBody(request));
    return updateCustomer(identity, id, body);
  });
}

export async function DELETE(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    return archiveCustomer(identity, id);
  });
}
