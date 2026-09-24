import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {issueInvoice} from '@/server/sales-service';
import {IssueInvoiceSchema} from '@/server/sales-schema';
import {AppError} from '@/server/db';

export const runtime = 'nodejs';

export async function POST(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    const db = await database();
    try {
      const body = IssueInvoiceSchema.parse(await jsonBody(request));
      if (body.draftId !== id) {
        throw new AppError(400, 'draftId in body must match the URL parameter.');
      }
      return issueInvoice(db, identity, body);
    } catch (e: any) {
      if (e?.issues) throw new AppError(400, e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', '));
      throw e;
    }
  });
}
