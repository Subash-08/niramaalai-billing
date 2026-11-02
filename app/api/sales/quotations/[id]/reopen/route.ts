import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {reopenQuotation} from '@/server/sales-service';
import {ReopenQuotationSchema} from '@/server/sales-schema';
export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
export async function POST(request: Request, context: Context) { return endpoint(async () => { checkOrigin(request); const identity = await requireIdentity(); const {id} = await context.params; return reopenQuotation(await database(), identity, id, ReopenQuotationSchema.parse(await jsonBody(request))); }); }
