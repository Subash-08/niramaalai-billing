import {endpoint, requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {getPaidVoucher} from '@/server/payment-voucher-service';
export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
export async function GET(_request: Request, context: Context) { return endpoint(async () => { const identity = await requireIdentity(); const {id} = await context.params; return getPaidVoucher(await database(), identity, id); }); }
