import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {getQuotation, updateQuotation, cancelQuotation} from '@/server/sales-service';
import {UpdateQuotationSchema, CancelQuotationSchema} from '@/server/sales-schema';
export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
export async function GET(_request: Request, context: Context) { return endpoint(async () => { const identity = await requireIdentity(); const {id} = await context.params; return getQuotation(await database(), identity, id); }); }
export async function PUT(request: Request, context: Context) { return endpoint(async () => { checkOrigin(request); const identity = await requireIdentity(); const {id} = await context.params; return updateQuotation(await database(), identity, id, UpdateQuotationSchema.parse(await jsonBody(request))); }); }
export async function DELETE(request: Request, context: Context) { return endpoint(async () => { checkOrigin(request); const identity = await requireIdentity(); const {id} = await context.params; return cancelQuotation(await database(), identity, id, CancelQuotationSchema.parse(await jsonBody(request))); }); }
