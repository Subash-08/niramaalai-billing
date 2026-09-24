import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {listProducts, createProduct} from '@/server/master-service';
import {ProductInputSchema, PaginationQuerySchema} from '@/server/master-schema';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const url = new URL(request.url);
    const query = PaginationQuerySchema.parse({
      page: url.searchParams.get('page') || '1',
      limit: url.searchParams.get('limit') || '20',
      q: url.searchParams.get('q') || '',
      category: url.searchParams.get('category') || undefined,
      status: url.searchParams.get('status') || 'Active',
    });
    return listProducts(identity, query);
  });
}

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const body = ProductInputSchema.parse(await jsonBody(request));
    return createProduct(identity, body);
  });
}
