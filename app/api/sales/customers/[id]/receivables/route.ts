import {endpoint, requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {col} from '@/server/purchase-service';

export const runtime = 'nodejs';

export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const {id} = await context.params;
    const db = await database();
    const tenantId = identity.tenantId;

    const customer = await col(db, 'customers').findOne({_id: id, tenantId});
    if (!customer) {
      return {receivables: [], advances: [], totalDuePaise: 0, availableAdvancePaise: 0};
    }

    const [openings, invoices, advances] = await Promise.all([
      col(db, 'openingReceivables')
        .find({
          tenantId,
          customerId: id,
          remainingAmountPaise: {$gt: 0},
          status: {$nin: ['Settled', 'Cancelled']},
        })
        .toArray(),
      col(db, 'invoices')
        .find({
          tenantId,
          customerId: id,
          status: 'Issued',
          duePaise: {$gt: 0},
        })
        .sort({invoiceDate: 1, createdAt: 1})
        .toArray(),
      col(db, 'customerAdvances')
        .find({
          tenantId,
          customerId: id,
          status: {$in: ['Available', 'PartlyConsumed']},
          remainingAmountPaise: {$gt: 0},
        })
        .sort({date: 1, createdAt: 1})
        .toArray(),
    ]);

    const receivables = [
      ...openings.map(o => ({
        id: o._id,
        targetType: 'OpeningReceivable' as const,
        targetId: o._id,
        reference: o.reference || 'Opening Balance',
        date: o.date,
        originalAmountPaise: o.originalAmountPaise,
        remainingDuePaise: o.remainingAmountPaise,
        dueDate: o.dueDate,
      })),
      ...invoices.map(i => ({
        id: i._id,
        targetType: 'Invoice' as const,
        targetId: i._id,
        reference: i.invoiceNumber,
        date: i.invoiceDate,
        originalAmountPaise: i.totalPaise,
        remainingDuePaise: i.duePaise,
        dueDate: i.dueDate,
      })),
    ];

    const totalDuePaise = receivables.reduce((sum, r) => sum + r.remainingDuePaise, 0);
    const availableAdvancePaise = advances.reduce((sum, a) => sum + a.remainingAmountPaise, 0);

    return {
      customer: {
        id: customer._id,
        name: customer.name,
        phone: customer.phone,
      },
      receivables,
      advances: advances.map(a => ({
        id: a._id,
        advanceNumber: a.advanceNumber,
        date: a.date,
        originalAmountPaise: a.originalAmountPaise,
        remainingAmountPaise: a.remainingAmountPaise,
      })),
      totalDuePaise,
      availableAdvancePaise,
    };
  });
}
