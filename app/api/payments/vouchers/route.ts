import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {createPaidVoucher, listPaidVouchers} from '@/server/payment-voucher-service';
export const runtime = 'nodejs';
export async function GET(request: Request) { return endpoint(async () => { const identity = await requireIdentity(); return listPaidVouchers(await database(), identity, Object.fromEntries(new URL(request.url).searchParams.entries())); }); }
export async function POST(request: Request) { return endpoint(async () => { checkOrigin(request); const identity = await requireIdentity(); return createPaidVoucher(await database(), identity, await jsonBody(request)); }); }
