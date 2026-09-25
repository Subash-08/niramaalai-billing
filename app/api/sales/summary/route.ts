import {endpoint, requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {getSalesSummary} from '@/server/sales-service';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const db = await database();
    const url = new URL(request.url);

    return getSalesSummary(db, identity, Object.fromEntries(url.searchParams.entries()));
  });
}
