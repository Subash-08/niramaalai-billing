import {requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {getCustomerStatement} from '@/server/customer-ledger';
import {z} from 'zod';
import ExcelJS from 'exceljs';
import {jsPDF} from 'jspdf';
import autoTable from 'jspdf-autotable';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine(q => !q.fromDate || !q.toDate || q.fromDate <= q.toDate, {message: 'From date must be on or before to date.'});

function safe(value: unknown) {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const identity = await requireIdentity();
    const {id} = await context.params;
    const query = QuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    const statement = await getCustomerStatement(await database(), identity, id, {
      fromDate: query.fromDate,
      toDate: query.toDate,
      page: 1,
      limit: 5000,
    });

    if (statement.totalEntries > 5000) {
      return Response.json({error: 'Statement exceeds 5,000 rows. Please narrow your date range.'}, {status: 400});
    }

    const headers = ['Date', 'Type', 'Reference', 'Description', 'Debit (INR)', 'Credit (INR)', 'Running balance (INR)'];
    const rows = statement.entries.map((item: any) => [
      safe(item.date),
      safe(item.type),
      safe(item.reference),
      safe(item.description),
      ((item.debitPaise || 0) / 100).toFixed(2),
      ((item.creditPaise || 0) / 100).toFixed(2),
      ((item.runningBalancePaise || 0) / 100).toFixed(2),
    ]);

    const custName = statement.customerSnapshot?.name || 'Customer';
    const fileBase = `customer-statement-${safe(custName).replace(/[^a-z0-9_-]+/gi, '-')}`;
    const closingBal = ((statement.periodClosingBalancePaise || 0) / 100).toFixed(2);

    if (query.format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Statement');
      sheet.addRow([custName]);
      sheet.addRow([`Closing Balance: INR ${closingBal}`]);
      sheet.addRow(headers);
      rows.forEach(row => sheet.addRow(row));
      const buffer = await workbook.xlsx.writeBuffer();
      return new Response(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${fileBase}.xlsx"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    if (query.format === 'pdf') {
      const doc = new jsPDF({orientation: 'landscape'});
      doc.setFontSize(15);
      doc.text(custName, 14, 15);
      doc.setFontSize(10);
      doc.text(`Customer account statement | Closing Balance: INR ${closingBal}`, 14, 22);
      autoTable(doc, {
        startY: 28,
        head: [headers],
        body: rows,
        styles: {fontSize: 8},
        headStyles: {fillColor: [79, 70, 229]},
      });
      return new Response(new Uint8Array(doc.output('arraybuffer')), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${fileBase}.pdf"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileBase}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error: any) {
    return Response.json(
      {error: error?.issues?.[0]?.message || error?.message || 'Statement export failed.'},
      {status: error?.status || 400}
    );
  }
}
