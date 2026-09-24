import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database, AppError} from '@/server/db';
import {col} from '@/server/purchase-service';
import {recordAudit} from '@/server/audit';
import {z} from 'zod';

const UpdatePromisedDateSchema = z.object({
  promisedPaymentDate: z.string().min(10).max(10),
  notes: z.string().max(500).optional(),
  expectedVersion: z.number().int().optional(),
});

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  props: {params: Promise<{id: string}>}
) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const db = await database();
    const {id} = await props.params;
    const body = UpdatePromisedDateSchema.parse(await jsonBody(request));

    const invoice = await col(db, 'invoices').findOne({_id: id, tenantId: identity.tenantId});
    if (!invoice) throw new AppError(404, 'Invoice not found.');

    if (body.expectedVersion !== undefined && invoice.version !== body.expectedVersion) {
      throw new AppError(409, 'Invoice was modified by another session. Please reload.');
    }

    const now = new Date();
    await col(db, 'invoices').updateOne(
      {_id: id, tenantId: identity.tenantId},
      {
        $set: {
          promisedPaymentDate: body.promisedPaymentDate,
          promisedDateNotes: body.notes || '',
          updatedAt: now,
          updatedBy: identity.userId,
        },
        $inc: {version: 1},
      }
    );

    await recordAudit(db, {
      identity,
      action: 'Update',
      entityType: 'invoice',
      entityId: id,
      detail: `Updated promised payment date to ${body.promisedPaymentDate} (Original due date ${invoice.dueDate} preserved)`,
    });

    return {success: true, invoiceId: id, promisedPaymentDate: body.promisedPaymentDate};
  });
}
