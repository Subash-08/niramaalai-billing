import {endpoint, requireIdentity} from '@/server/auth';
import {database, AppError} from '@/server/db';
import {col} from '@/server/purchase-service';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  {params}: {params: Promise<{id: string}>}
) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const db = await database();
    const {id: customerId} = await params;
    const tenantId = identity.tenantId;

    const customer = await col(db, 'customers').findOne({_id: customerId, tenantId});
    if (!customer) throw new AppError(404, 'Customer not found.');

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    // 1. Fetch financial aggregates
    const [
      invoices,
      returns,
      receipts,
      advances,
      openingDue,
      serviceJobs,
      enquiries,
    ] = await Promise.all([
      col(db, 'invoices')
        .find({tenantId, customerId, status: 'Issued'})
        .sort({createdAt: -1, _id: -1})
        .toArray(),
      col(db, 'customerReturns')
        .find({tenantId, customerId})
        .toArray(),
      col(db, 'customerReceipts')
        .find({tenantId, customerId, isReversed: false})
        .toArray(),
      col(db, 'customerAdvances')
        .find({tenantId, customerId, status: {$in: ['Available', 'PartlyConsumed']}})
        .toArray(),
      col(db, 'openingReceivables')
        .findOne({tenantId, customerId}),
      col(db, 'serviceJobs')
        .find({tenantId, customerId})
        .sort({createdAt: -1})
        .toArray(),
      col(db, 'enquiries')
        .find({tenantId, customerId})
        .sort({createdAt: -1})
        .toArray(),
    ]);

    // Category contributions
    let newGoodsTotalPaise = 0;
    let usedGoodsTotalPaise = 0;
    let serviceTotalPaise = 0;
    let totalSalesPaise = 0;
    let outstandingInvoiceDuePaise = 0;
    let newGoodsInvoiceCount = 0;
    let usedGoodsInvoiceCount = 0;
    let serviceInvoiceCount = 0;

    const returnCreditsByInvoice = new Map<string, number>();
    for (const ret of returns) {
      const credit = ret.refundPaise ?? ret.totalRefundPaise ?? 0;
      returnCreditsByInvoice.set(ret.invoiceId, (returnCreditsByInvoice.get(ret.invoiceId) || 0) + credit);
    }

    for (const inv of invoices) {
      const t = inv.totalPaise || 0;
      const net = Math.max(0, t - (returnCreditsByInvoice.get(inv._id) || 0));
      totalSalesPaise += t;
      outstandingInvoiceDuePaise += inv.duePaise || 0;

      if (inv.businessCategory === 'UsedGoods') {
        usedGoodsTotalPaise += net;
        usedGoodsInvoiceCount += 1;
      } else if (inv.businessCategory === 'Service' || inv.invoiceKind === 'Service') {
        serviceTotalPaise += net;
        serviceInvoiceCount += 1;
      } else {
        newGoodsTotalPaise += net;
        newGoodsInvoiceCount += 1;
      }
    }

    const totalReturnsPaise = returns.reduce((s, r) => s + (r.refundPaise ?? r.totalRefundPaise ?? 0), 0);
    const totalCollectionsPaise = receipts.reduce((s, r) => s + (r.totalAmountPaise || 0), 0);
    const availableAdvancesPaise = advances.reduce((s, a) => s + (a.remainingAmountPaise || 0), 0);
    const openingDuePaise = openingDue?.remainingDuePaise ?? openingDue?.originalAmountPaise ?? 0;
    const totalOutstandingDuePaise = outstandingInvoiceDuePaise + openingDuePaise;

    // 2. Activity Timeline compilation
    type TimelineItem = {
      id: string;
      date: string;
      type: 'Invoice' | 'Return' | 'Receipt' | 'ServiceJob' | 'Enquiry' | 'OpeningDue';
      title: string;
      reference: string;
      amountPaise?: number;
      status: string;
      createdAt: Date;
    };

    const timelineItems: TimelineItem[] = [
      ...invoices.map(inv => ({
        id: inv._id,
        date: inv.invoiceDate,
        type: 'Invoice' as const,
        title: `Sales Invoice (${inv.invoiceKind || 'Sale'})`,
        reference: inv.invoiceNumber || inv._id,
        amountPaise: inv.totalPaise,
        status: inv.paymentStatus || 'Issued',
        createdAt: inv.createdAt || new Date(inv.invoiceDate),
      })),
      ...returns.map(ret => ({
        id: ret._id,
        date: ret.date,
        type: 'Return' as const,
        title: `Customer Return (${ret.settlement || 'Return'})`,
        reference: ret.returnNumber || ret._id,
        amountPaise: ret.refundPaise,
        status: 'Completed',
        createdAt: ret.createdAt || new Date(ret.date),
      })),
      ...receipts.map(rcpt => ({
        id: rcpt._id,
        date: rcpt.date,
        type: 'Receipt' as const,
        title: `Payment Received (${rcpt.components?.map((c: any) => c.method).join(', ') || 'Cash'})`,
        reference: rcpt.receiptNumber || rcpt._id,
        amountPaise: rcpt.totalAmountPaise,
        status: 'Received',
        createdAt: rcpt.createdAt || new Date(rcpt.date),
      })),
      ...serviceJobs.map(job => ({
        id: job._id,
        date: job.createdAt?.toISOString().slice(0, 10) || '2026-09-01',
        type: 'ServiceJob' as const,
        title: `Service: ${job.device?.brand || ''} ${job.device?.model || ''}`,
        reference: job.jobNumber || job._id,
        amountPaise: job.estimate?.estimatedCostPaise,
        status: job.status,
        createdAt: job.createdAt,
      })),
      ...enquiries.map(enq => ({
        id: enq._id,
        date: enq.date || enq.createdAt?.toISOString().slice(0, 10) || '2026-09-01',
        type: 'Enquiry' as const,
        title: `Enquiry: ${enq.requirement || enq.category || 'General'}`,
        reference: enq.enquiryNumber || enq._id,
        amountPaise: enq.budgetPaise,
        status: enq.status,
        createdAt: enq.createdAt,
      })),
    ];

    if (openingDue) {
      timelineItems.push({
        id: openingDue._id,
        date: openingDue.cutoffDate || '2026-09-01',
        type: 'OpeningDue' as const,
        title: 'Opening Receivable Balance',
        reference: 'OPENING-DUE',
        amountPaise: openingDue.originalAmountPaise,
        status: openingDue.status || 'Active',
        createdAt: openingDue.createdAt || new Date('2026-09-01'),
      });
    }

    // Sort descending with stable tie-breaker
    timelineItems.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      const diff = b.createdAt.getTime() - a.createdAt.getTime();
      if (diff !== 0) return diff;
      return b.id.localeCompare(a.id);
    });

    const totalCount = timelineItems.length;
    const paginatedTimeline = timelineItems.slice(skip, skip + limit);

    return {
      customer: {
        _id: customer._id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        gst: customer.gst,
        type: customer.type,
        creditLimitPaise: customer.creditLimitPaise || 0,
      },
      contributions: {
        newGoodsTotalPaise,
        usedGoodsTotalPaise,
        serviceTotalPaise,
        newGoodsInvoiceCount,
        usedGoodsInvoiceCount,
        serviceInvoiceCount,
      },
      summary: {
        totalSalesPaise,
        totalReturnsPaise,
        totalCollectionsPaise,
        outstandingDuePaise: totalOutstandingDuePaise,
        availableAdvancesPaise,
      },
      invoices: invoices.slice(0, 25).map(inv => {
        const returnCreditPaise = returnCreditsByInvoice.get(inv._id) || 0;
        return {
          _id: inv._id,
          invoiceNumber: inv.invoiceNumber || inv._id,
          invoiceDate: inv.invoiceDate,
          invoiceKind: inv.invoiceKind || 'Sale',
          businessCategory: inv.businessCategory || 'NewGoods',
          status: inv.status,
          paymentStatus: inv.paymentStatus || ((inv.duePaise || 0) > 0 ? 'Unpaid' : 'Paid'),
          totalPaise: inv.totalPaise || 0,
          returnCreditPaise,
          netInvoicePaise: Math.max(0, (inv.totalPaise || 0) - returnCreditPaise),
          duePaise: inv.duePaise || 0,
        };
      }),
      receipts: receipts.slice(0, 50).map(r => ({
        _id: r._id,
        receiptNumber: r.receiptNumber,
        receiptDate: r.receiptDate,
        totalAmountPaise: r.totalAmountPaise,
        account: r.components?.[0]?.account || 'Cash',
        method: r.components?.[0]?.method || 'Cash',
        invoiceNumber: r.receiptSnapshot?.invoiceNumber || '',
        reference: r.allocations?.[0]?.targetId || '',
      })),
      receiptCount: receipts.length,
      invoiceCount: invoices.length,
      timeline: paginatedTimeline,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
    };
  });
}
