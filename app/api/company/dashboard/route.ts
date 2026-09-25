import {endpoint, requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {col} from '@/server/purchase-service';
import {todayInKolkata} from '@/server/purchase-schema';

export const runtime = 'nodejs';

export async function GET() {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const db = await database();
    const tenantId = identity.tenantId;
    const today = todayInKolkata();
    const monthStart = today.slice(0, 7) + '-01';

    const [
      todaySalesAgg,
      monthSalesAgg,
      customerDuesAgg,
      openingDuesAgg,
      todayReceiptsAgg,
      todayVouchersAgg,
      recentInvoices,
      outstandingInvoices,
      recentReceipts,
      recentVouchers,
      printJobsAgg,
      activeCustomerCount,
    ] = await Promise.all([
      // Today sales
      col(db, 'invoices').aggregate([
        {$match: {tenantId, status: 'Issued', invoiceDate: today}},
        {$group: {_id: null, totalPaise: {$sum: '$totalPaise'}, count: {$sum: 1}}},
      ]).toArray(),

      // Month sales & GST
      col(db, 'invoices').aggregate([
        {$match: {tenantId, status: 'Issued', invoiceDate: {$gte: monthStart, $lte: today}}},
        {$group: {_id: null, totalPaise: {$sum: '$totalPaise'}, taxPaise: {$sum: '$taxPaise'}, count: {$sum: 1}}},
      ]).toArray(),

      // Current invoice dues
      col(db, 'invoices').aggregate([
        {$match: {tenantId, status: 'Issued', duePaise: {$gt: 0}}},
        {$group: {_id: null, totalDuePaise: {$sum: '$duePaise'}}},
      ]).toArray(),

      // Opening receivable dues
      col(db, 'openingReceivables').aggregate([
        {$match: {tenantId, remainingAmountPaise: {$gt: 0}}},
        {$group: {_id: null, totalDuePaise: {$sum: '$remainingAmountPaise'}}},
      ]).toArray(),

      // Money received today (customer receipts)
      col(db, 'customerReceipts').aggregate([
        {$match: {tenantId, isReversed: {$ne: true}, date: today}},
        {$group: {_id: null, totalPaise: {$sum: '$totalAmountPaise'}, count: {$sum: 1}}},
      ]).toArray(),

      // Money paid today (payment vouchers)
      col(db, 'paymentVouchers').aggregate([
        {$match: {tenantId, isReversed: {$ne: true}, date: today}},
        {$group: {_id: null, totalPaise: {$sum: '$amountPaise'}, count: {$sum: 1}}},
      ]).toArray(),

      // Recent 5 issued invoices
      col(db, 'invoices')
        .find({tenantId, status: 'Issued'})
        .sort({invoiceDate: -1, createdAt: -1})
        .limit(5)
        .toArray(),

      // Top 5 outstanding invoices requiring attention
      col(db, 'invoices')
        .find({tenantId, status: 'Issued', duePaise: {$gt: 0}})
        .sort({dueDate: 1, invoiceDate: 1})
        .limit(5)
        .toArray(),

      // Recent 5 customer receipts
      col(db, 'customerReceipts')
        .find({tenantId, isReversed: {$ne: true}})
        .sort({date: -1, createdAt: -1})
        .limit(5)
        .toArray(),

      // Recent 5 payment vouchers
      col(db, 'paymentVouchers')
        .find({tenantId, isReversed: {$ne: true}})
        .sort({date: -1, createdAt: -1})
        .limit(5)
        .toArray(),

      // Print jobs by status
      col(db, 'printJobs').aggregate([
        {$match: {tenantId}},
        {$group: {_id: '$status', count: {$sum: 1}}},
      ]).toArray(),

      // Active customers
      col(db, 'customers').countDocuments({tenantId, status: 'Active'}),
    ]);

    const invoiceDuesPaise = customerDuesAgg[0]?.totalDuePaise || 0;
    const openingDuesPaise = openingDuesAgg[0]?.totalDuePaise || 0;
    const totalCustomerOutstandingPaise = invoiceDuesPaise + openingDuesPaise;

    const printJobsByStatus: Record<string, number> = {
      Draft: 0,
      Queued: 0,
      Printing: 0,
      Completed: 0,
      Delivered: 0,
      Cancelled: 0,
    };
    for (const pj of printJobsAgg) {
      if (pj._id) printJobsByStatus[pj._id] = pj.count || 0;
    }

    const legacyReceiptInvoiceIds = recentReceipts
      .filter((receipt: any) => !receipt.receiptSnapshot)
      .map((receipt: any) => receipt.invoiceId || receipt.allocations?.[0]?.targetId)
      .filter(Boolean);
    const legacyReceiptInvoices = legacyReceiptInvoiceIds.length
      ? await col(db, 'invoices').find({tenantId, _id: {$in: legacyReceiptInvoiceIds}}).toArray()
      : [];
    const invoiceNumberById = new Map(legacyReceiptInvoices.map((invoice: any) => [invoice._id, invoice.invoiceNumber || invoice._id]));

    return {
      todayDate: today,
      sales: {
        todayTotalPaise: todaySalesAgg[0]?.totalPaise || 0,
        todayCount: todaySalesAgg[0]?.count || 0,
        monthTotalPaise: monthSalesAgg[0]?.totalPaise || 0,
        monthGstPaise: monthSalesAgg[0]?.taxPaise || 0,
        monthCount: monthSalesAgg[0]?.count || 0,
      },
      dues: {
        totalCustomerOutstandingPaise,
      },
      payments: {
        moneyReceivedTodayPaise: todayReceiptsAgg[0]?.totalPaise || 0,
        receivedTodayCount: todayReceiptsAgg[0]?.count || 0,
        moneyPaidTodayPaise: todayVouchersAgg[0]?.totalPaise || 0,
        paidTodayCount: todayVouchersAgg[0]?.count || 0,
      },
      customerCount: activeCustomerCount,
      printJobsByStatus,
      recentInvoices: recentInvoices.map((inv: any) => ({
        id: inv._id || inv.id,
        invoiceNumber: inv.invoiceNumber || inv.id,
        customerName: inv.customerSnapshot?.name || 'Customer',
        date: inv.invoiceDate || inv.date,
        dueDate: inv.dueDate || null,
        totalPaise: inv.totalPaise || (inv.grandTotalPaise ?? 0),
        duePaise: inv.duePaise || 0,
        paymentStatus: inv.paymentStatus || (inv.duePaise === 0 ? 'Paid' : inv.duePaise < inv.totalPaise ? 'PartlyPaid' : 'Unpaid'),
      })),
      outstandingInvoices: outstandingInvoices.map((inv: any) => ({
        id: inv._id || inv.id,
        invoiceNumber: inv.invoiceNumber || inv.id,
        customerName: inv.customerSnapshot?.name || 'Customer',
        date: inv.invoiceDate || inv.date,
        dueDate: inv.dueDate || null,
        totalPaise: inv.totalPaise || (inv.grandTotalPaise ?? 0),
        duePaise: inv.duePaise || 0,
      })),
      recentReceipts: recentReceipts.map((rcpt: any) => ({
        id: rcpt._id || rcpt.id,
        receiptNumber: rcpt.receiptNumber || rcpt.id,
        customerName: rcpt.customerSnapshot?.name || 'Customer',
        invoiceNumber: rcpt.receiptSnapshot?.invoiceNumber || invoiceNumberById.get(rcpt.invoiceId || rcpt.allocations?.[0]?.targetId) || rcpt.allocations?.[0]?.targetId || 'Invoice',
        amountPaise: rcpt.totalAmountPaise || rcpt.amountPaise || 0,
        method: rcpt.components?.[0]?.method || 'Cash',
        date: rcpt.date,
      })),
      recentVouchers: recentVouchers.map((v: any) => ({
        id: v._id || v.id,
        voucherNumber: v.voucherNumber || v.id,
        payeeName: v.payeeName,
        purpose: v.purpose,
        amountPaise: v.amountPaise || 0,
        account: v.account,
        method: v.method,
        date: v.date,
      })),
    };
  });
}
