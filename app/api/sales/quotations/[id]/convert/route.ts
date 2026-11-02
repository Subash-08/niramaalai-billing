import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {convertQuotationToDraft} from '@/server/sales-service';
import {ConvertQuotationSchema} from '@/server/sales-schema';
export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
export async function POST(request: Request, context: Context) { return endpoint(async () => { checkOrigin(request); const identity = await requireIdentity(); const {id} = await context.params; const body = ConvertQuotationSchema.parse(await jsonBody(request)); return convertQuotationToDraft(await database(), identity, {...body, quotationId: id}); }); }
