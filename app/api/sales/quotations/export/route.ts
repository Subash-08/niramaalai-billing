import {requireIdentity} from '@/server/auth';
import {database, AppError} from '@/server/db';
import {col} from '@/server/purchase-service';
import {MAX_EXPORT_ROWS} from '@/server/purchase-schema';
import ExcelJS from 'exceljs';
import {jsPDF} from 'jspdf';
import autoTable from 'jspdf-autotable';
export const runtime = 'nodejs';
const safe = (value: unknown) => /^[=+\-@]/.test(String(value ?? '')) ? `'${String(value ?? '')}` : String(value ?? '');
export async function GET(request: Request) {
  try {
    const identity = await requireIdentity(); const db = await database(); const url = new URL(request.url);
    const format = (url.searchParams.get('format') || 'csv').toLowerCase();
    if (!['csv', 'xlsx', 'pdf'].includes(format)) throw new AppError(400, 'Export format must be CSV, XLSX, or PDF.');
    const filter: Record<string, any> = {tenantId: identity.tenantId};
    const status = url.searchParams.get('status'); const from = url.searchParams.get('dateFrom'); const to = url.searchParams.get('dateTo'); const search = (url.searchParams.get('search') || '').trim().slice(0, 200);
    if (status && status !== 'All') filter.status = status === 'Shared' ? 'Sent' : status;
    if (from || to) filter.quotationDate = {...(from && {$gte: from}), ...(to && {$lte: to})};
    if (search) { const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{quotationNumber: {$regex: escaped, $options: 'i'}}, {'customerSnapshot.name': {$regex: escaped, $options: 'i'}}]; }
    const count = await col(db, 'quotations').countDocuments(filter); if (count > MAX_EXPORT_ROWS) throw new AppError(400, `Export matches more than ${MAX_EXPORT_ROWS} quotations. Refine the filters.`);
    const [rows, company] = await Promise.all([col(db, 'quotations').find(filter).sort({quotationDate: -1}).toArray(), col(db, 'companySettings').findOne({tenantId: identity.tenantId})]);
    const headers = ['Quotation Number', 'Date', 'Valid Until', 'Customer', 'Status', 'Total (INR)', 'Converted Invoice'];
    const data = rows.map(row => [safe(row.quotationNumber || row._id), safe(row.quotationDate), safe(row.validUntil), safe(row.customerSnapshot?.name), safe(row.convertedToInvoiceId ? 'Converted' : row.status), ((row.totalPaise || 0) / 100).toFixed(2), safe(row.convertedToInvoiceId || '')]);
    const name = company?.name || 'Billing Software';
    if (format === 'xlsx') { const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Quotations'); sheet.addRow([name]); sheet.addRow(headers); data.forEach(row => sheet.addRow(row)); const buffer = await workbook.xlsx.writeBuffer(); return new Response(buffer, {headers: {'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="quotations-${Date.now()}.xlsx"`}}); }
    if (format === 'pdf') { const doc = new jsPDF({orientation: 'landscape'}); doc.setFontSize(16); doc.text(`${name} · Quotations`, 14, 15); autoTable(doc, {startY: 22, head: [headers], body: data, styles: {fontSize: 8}}); return new Response(doc.output('arraybuffer'), {headers: {'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="quotations-${Date.now()}.pdf"`}}); }
    const csv = [headers, ...data].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n'); return new Response(csv, {headers: {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="quotations-${Date.now()}.csv"`}});
  } catch (error: any) { return Response.json({error: error.message || 'Quotation export failed.'}, {status: error instanceof AppError ? error.status : 500}); }
}
