import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database, AppError} from '@/server/db';
import {createInvoiceDraft, listInvoices} from '@/server/sales-service';
import {CreateInvoiceDraftSchema} from '@/server/sales-schema';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const db = await database();
    const url = new URL(request.url);
    const params = Object.fromEntries(url.searchParams);
    if (!params.search && params.q) params.search = params.q;
    return listInvoices(db, identity, params);
  });
}

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const db = await database();
    try {
      const body = CreateInvoiceDraftSchema.parse(await jsonBody(request));
      return createInvoiceDraft(db, identity, body);
    } catch (e: any) {
      if (e?.issues) throw new AppError(400, e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', '));
      throw e;
    }
  });
}
