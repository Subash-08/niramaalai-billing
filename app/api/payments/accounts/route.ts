import {endpoint, requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {getTenantAccountBalances} from '@/server/payment-voucher-service';

export const runtime = 'nodejs';

export async function GET() {
  return endpoint(async () => {
    const identity = await requireIdentity();
    return getTenantAccountBalances(await database(), identity);
  });
}
