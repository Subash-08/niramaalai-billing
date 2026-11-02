import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {shareQuotation} from '@/server/sales-service';
import {ShareQuotationSchema} from '@/server/sales-schema';
export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
export async function POST(request: Request, context: Context) { return endpoint(async () => { checkOrigin(request); const identity = await requireIdentity(); const {id} = await context.params; return shareQuotation(await database(), identity, id, ShareQuotationSchema.parse(await jsonBody(request))); }); }
