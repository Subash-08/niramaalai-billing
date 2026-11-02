import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database, AppError} from '@/server/db';
import {col} from '@/server/purchase-service';
import {z} from 'zod';

const Schema = z.object({dismissed: z.boolean()});
export const runtime = 'nodejs';

export async function PATCH(request: Request, props: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const db = await database();
    const {id} = await props.params;
    const {dismissed} = Schema.parse(await jsonBody(request));
    const result = await col(db, 'invoices').updateOne(
      {_id: id, tenantId: identity.tenantId, status: 'Issued'},
      {$set: {dueReminderDismissed: dismissed, updatedAt: new Date(), updatedBy: identity.userId}, $inc: {version: 1}}
    );
    if (!result.matchedCount) throw new AppError(404, 'Outstanding invoice not found.');
    return {success: true, dismissed};
  });
}
