import {endpoint, requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {getSalesSummary} from '@/server/sales-service';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const db = await database();
    const url = new URL(request.url);

    const hasDue = url.searchParams.get('hasDue') === 'true';
    const customerId = url.searchParams.get('customerId') || undefined;

    return getSalesSummary(db, identity, {hasDue, customerId});
  });
}
