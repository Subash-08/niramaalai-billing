import {endpoint, requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {getCustomerStatement} from '@/server/customer-ledger';

export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};

export async function GET(request: Request, context: Context) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const {id} = await context.params;
    const url = new URL(request.url);
    return getCustomerStatement(
      await database(),
      identity,
      id,
      Object.fromEntries(url.searchParams.entries())
    );
  });
}
