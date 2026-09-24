import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {reverseCustomerAllocation} from '@/server/customer-ledger';

export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};

export async function POST(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    const body = await jsonBody(request);
    return reverseCustomerAllocation(await database(), identity, {...body, allocationId: id});
  });
}
