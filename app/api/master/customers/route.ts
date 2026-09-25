import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {listCustomers, createCustomer} from '@/server/master-service';
import {CustomerInputSchema, PaginationQuerySchema} from '@/server/master-schema';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const url = new URL(request.url);
    const query = PaginationQuerySchema.parse({
      page: url.searchParams.get('page') || '1',
      limit: url.searchParams.get('limit') || '20',
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || 'Active',
      type: url.searchParams.get('type') || undefined,
      balance: url.searchParams.get('balance') || 'All',
      sortBy: url.searchParams.get('sortBy') || 'recent',
      minSalesPaise: url.searchParams.get('minSalesPaise') || undefined,
      maxSalesPaise: url.searchParams.get('maxSalesPaise') || undefined,
    });
    return listCustomers(identity, query);
  });
}

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const body = CustomerInputSchema.parse(await jsonBody(request));
    return createCustomer(identity, body);
  });
}
