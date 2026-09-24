import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {getInvoice, updateInvoiceDraft, cancelInvoiceDraft} from '@/server/sales-service';
import {UpdateInvoiceDraftSchema, CancelInvoiceDraftSchema} from '@/server/sales-schema';
export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
export async function GET(_request: Request, context: Context) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const {id} = await context.params;
    return getInvoice(await database(), identity, id);
  });
}
export async function PUT(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    return updateInvoiceDraft(await database(), identity, id, UpdateInvoiceDraftSchema.parse(await jsonBody(request)));
  });
}
export async function DELETE(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    return cancelInvoiceDraft(await database(), identity, id, CancelInvoiceDraftSchema.parse(await jsonBody(request)));
  });
}
