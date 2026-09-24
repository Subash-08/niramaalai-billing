import {endpoint, requireIdentity} from '@/server/auth';
import {database, AppError} from '@/server/db';
import {col} from '@/server/purchase-service';
import {todayInKolkata} from '@/server/purchase-schema';
import {isValidCalendarDate} from '@/server/master-schema';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return endpoint(async () => {
    const url = new URL(request.url);
    const reportType = url.searchParams.get('report') || 'Sales';
    const allowedReports = [
      'Sales',
      'Tax summary',
      'GST/Tax summary',
      'Service sales',
      'Payments received',
      'Payments paid',
      'Payment vouchers',
      'Customer outstanding',
      'Customer dues',
      'Product catalogue',
    ];

    if (!allowedReports.includes(reportType)) {
      throw new AppError(404, `Report "${reportType}" is not available in this application.`);
    }

    const from = url.searchParams.get('from') || todayInKolkata().slice(0, 8) + '01';
    const to = url.searchParams.get('to') || todayInKolkata();
    if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || from > to) {
      throw new AppError(400, 'Choose a valid date range.');
    }

    const customerId = url.searchParams.get('customerId') || undefined;
    const paymentStatus = url.searchParams.get('paymentStatus') || 'All payments';
    const category = url.searchParams.get('category') || 'All categories';

    const identity = await requireIdentity();
    const db = await database();
    const tenantId = identity.tenantId;

    switch (reportType) {
      // 1. Sales Report (Without return credits)
      case 'Sales': {
        const query: Record<string, any> = {
          tenantId,
          status: 'Issued',
          invoiceDate: {$gte: from, $lte: to},
        };
        if (customerId && customerId !== 'All customers') query.customerId = customerId;
        if (paymentStatus === 'Paid') query.duePaise = 0;
        if (paymentStatus === 'Unpaid / partial') query.duePaise = {$gt: 0};
        if (category && category !== 'All categories') {
          if (category === 'Tax invoices') query['lines.taxBasisPoints'] = {$gt: 0};
          else if (category === 'Non-GST invoices') query.lines = {$not: {$elemMatch: {taxTreatment: {$ne: 'NonGST'}}}};
          else if (category === 'New goods') query.businessCategory = 'NewGoods';
          else if (category === 'Used goods') query.businessCategory = 'UsedGoods';
          else if (category === 'Service') query.businessCategory = 'Service';
        }

        const [invoices, customers] = await Promise.all([
          col(db, 'invoices').find(query).sort({invoiceDate: -1, createdAt: -1}).toArray(),
          col(db, 'customers').find({tenantId}).toArray(),
        ]);
        const custMap = new Map(customers.map((c) => [c._id, c.name]));

        const rows = invoices.map((b) => {
          const lines = b.lines || [];
          const taxable = lines.reduce((s: number, l: any) => s + (l.taxableBasePaise || 0), 0) / 100;
          const gst = lines.reduce((s: number, l: any) => s + (l.taxPaise || (l.cgstPaise || 0) + (l.sgstPaise || 0) + (l.igstPaise || 0)), 0) / 100;
          const total = (b.totalPaise || 0) / 100;
          const collected = (b.allocatedPaidPaise ?? ((b.allocatedReceiptPaise || 0) + (b.allocatedAdvancePaise || 0))) / 100;
          const due = (b.duePaise || 0) / 100;
          return [
            b.invoiceNumber || b._id,
            b.invoiceDate,
            custMap.get(b.customerId) || b.customerSnapshot?.name || 'Customer',
            b.businessCategory || 'Sale',
            taxable,
            gst,
            total,
            collected,
            due,
          ];
        });

        return {
          headers: ['Invoice number', 'Date', 'Customer', 'Category', 'Taxable amount', 'GST', 'Total', 'Collected', 'Due'],
          rows,
        };
      }

      // 2. GST / Tax Summary Report
      case 'Tax summary':
      case 'GST/Tax summary': {
        const query: Record<string, any> = {
          tenantId,
          status: 'Issued',
          invoiceDate: {$gte: from, $lte: to},
        };
        if (customerId && customerId !== 'All customers') query.customerId = customerId;

        const invoices = await col(db, 'invoices').find(query).sort({invoiceDate: -1}).toArray();

        const rows = invoices.map((b) => {
          const lines = b.lines || [];
          const taxable = lines.reduce((s: number, l: any) => s + (l.taxableBasePaise || 0), 0) / 100;
          const cgst = lines.reduce((s: number, l: any) => s + (l.cgstPaise || 0), 0) / 100;
          const sgst = lines.reduce((s: number, l: any) => s + (l.sgstPaise || 0), 0) / 100;
          const igst = lines.reduce((s: number, l: any) => s + (l.igstPaise || 0), 0) / 100;
          const total = (b.totalPaise || 0) / 100;
          return [
            b.invoiceNumber || b._id,
            b.invoiceDate,
            b.taxMode || 'Intra-state',
            taxable,
            cgst,
            sgst,
            igst,
            total,
          ];
        });

        return {
          headers: ['Invoice', 'Date', 'Supply type', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total'],
          rows,
        };
      }

      // 3. Service Sales Report
      case 'Service sales': {
        const query: Record<string, any> = {
          tenantId,
          status: 'Issued',
          invoiceDate: {$gte: from, $lte: to},
          'lines.lineType': 'Service',
        };
        if (customerId && customerId !== 'All customers') query.customerId = customerId;

        const invoices = await col(db, 'invoices').find(query).sort({invoiceDate: -1}).toArray();
        const rows = invoices.flatMap((inv: any) =>
          (inv.lines || [])
            .filter((l: any) => l.lineType === 'Service')
            .map((l: any) => [
              inv.invoiceNumber || inv._id,
              inv.invoiceDate,
              inv.customerSnapshot?.name || 'Customer',
              l.description,
              l.quantity,
              l.unit || 'Job',
              (l.totalPaise || 0) / 100,
            ])
        );

        return {
          headers: ['Invoice', 'Date', 'Customer', 'Service description', 'Quantity', 'Unit', 'Amount'],
          rows,
        };
      }

      // 4. Payments Received (Customer Receipts linked to single invoice)
      case 'Payments received': {
        const query: Record<string, any> = {
          tenantId,
          date: {$gte: from, $lte: to},
          isReversed: {$ne: true},
        };
        if (customerId && customerId !== 'All customers') query.customerId = customerId;

        const receipts = await col(db, 'customerReceipts').find(query).sort({date: -1, createdAt: -1}).toArray();

        const rows = receipts.map((r: any) => {
          const comp = r.components?.[0] || {};
          const settledInvoice = r.receiptSnapshot?.invoiceNumber || r.allocations?.[0]?.targetId || r.invoiceId || 'Invoice';
          return [
            r.receiptNumber || r._id,
            r.date,
            r.customerSnapshot?.name || r.customerName || 'Customer',
            settledInvoice,
            comp.account || 'Cash',
            comp.method || r.method || 'Cash',
            comp.reference || r.reference || '-',
            (r.totalAmountPaise || r.amountPaise || 0) / 100,
          ];
        });

        return {
          headers: ['Receipt number', 'Date', 'Customer', 'Settled invoice', 'Account', 'Payment method', 'Reference / UTR', 'Amount'],
          rows,
        };
      }

      // 5. Payments Paid (Payment Vouchers)
      case 'Payments paid':
      case 'Payment vouchers': {
        const query: Record<string, any> = {
          tenantId,
          date: {$gte: from, $lte: to},
          isReversed: {$ne: true},
        };

        const vouchers = await col(db, 'paymentVouchers').find(query).sort({date: -1, createdAt: -1}).toArray();

        const rows = vouchers.map((v: any) => [
          v.voucherNumber || v._id,
          v.date,
          v.payeeName,
          v.purpose,
          v.account,
          v.method,
          v.reference || '-',
          (v.amountPaise || 0) / 100,
        ]);

        return {
          headers: ['Voucher number', 'Date', 'Paid to', 'Purpose', 'Account', 'Payment method', 'Reference / UTR', 'Amount'],
          rows,
        };
      }

      // 6. Customer Outstanding Report
      case 'Customer outstanding':
      case 'Customer dues': {
        const query: Record<string, any> = {
          tenantId,
          status: 'Issued',
          duePaise: {$gt: 0},
          invoiceDate: {$lte: to},
        };
        if (customerId && customerId !== 'All customers') query.customerId = customerId;

        const [invoices, customers, opening] = await Promise.all([
          col(db, 'invoices').find(query).sort({dueDate: 1, invoiceDate: 1}).toArray(),
          col(db, 'customers').find({tenantId}).toArray(),
          col(db, 'openingReceivables').find({
            tenantId,
            remainingAmountPaise: {$gt: 0},
            date: {$lte: to},
            ...(customerId && !customerId.startsWith('All ') ? {customerId} : {}),
          }).toArray(),
        ]);
        const custMap = new Map(customers.map((c) => [c._id, c.name]));

        const rows = invoices.map((b) => [
          b.invoiceNumber || b._id,
          custMap.get(b.customerId) || b.customerSnapshot?.name || 'Customer',
          b.invoiceDate,
          b.dueDate || b.promisedPaymentDate || '—',
          (b.duePaise || 0) / 100,
        ]);

        for (const o of opening) {
          rows.push([
            o.reference || o._id,
            custMap.get(o.customerId) || 'Opening balance',
            o.date,
            o.date,
            o.remainingAmountPaise / 100,
          ]);
        }

        return {
          headers: ['Bill', 'Customer', 'Invoice date', 'Due date', 'Current balance'],
          rows,
        };
      }

      // 7. Product Catalogue Report (No stock fields!)
      case 'Product catalogue': {
        const products = await col(db, 'products').find({tenantId}).sort({name: 1}).toArray();

        const rows = products.map((p: any) => [
          p._id || p.id,
          p.name,
          p.category || 'General',
          p.description || '',
          p.unit || 'Piece',
          p.hsn || '',
          (p.sellingPricePaise || 0) / 100,
          `${(p.taxBasisPoints || 0) / 100}%`,
          p.status || 'Active',
        ]);

        return {
          headers: ['Product ID', 'Name', 'Category', 'Description', 'Unit', 'HSN', 'Standard rate', 'GST rate', 'Status'],
          rows,
        };
      }

      default:
        throw new AppError(400, `Unknown report type: ${reportType}`);
    }
  });
}
