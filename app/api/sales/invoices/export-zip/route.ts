import {requireIdentity} from '@/server/auth';
import {database, AppError} from '@/server/db';
import {col} from '@/server/purchase-service';
import {getFile} from '@/server/storage';
import JSZip from 'jszip';
import {jsPDF} from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {InvoiceDocument} from '@/server/sales-service';

export const runtime = 'nodejs';

const MAX_ZIP_LIMIT = 100;

function hexToRgb(hex: string): [number, number, number] {
  const clean = (hex || '').replace('#', '');
  if (clean.length === 6) {
    return [
      parseInt(clean.slice(0, 2), 16) || 0,
      parseInt(clean.slice(2, 4), 16) || 0,
      parseInt(clean.slice(4, 6), 16) || 0,
    ];
  }
  return [30, 41, 59];
}

function fmtPaise(paise?: number): string {
  return ((paise || 0) / 100).toFixed(2);
}

export async function GET(request: Request) {
  try {
    const identity = await requireIdentity();
    const db = await database();
    const url = new URL(request.url);

    const hasDue = url.searchParams.get('hasDue') === 'true';
    const customerId = url.searchParams.get('customerId') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const dateFrom = url.searchParams.get('dateFrom') || undefined;
    const dateTo = url.searchParams.get('dateTo') || undefined;
    const search = (url.searchParams.get('search') || '').trim().slice(0, 200);
    const businessCategory = url.searchParams.get('businessCategory') || undefined;

    const filter: Record<string, any> = {tenantId: identity.tenantId};
    if (hasDue || status === 'Unpaid') {
      filter.status = 'Issued';
      filter.duePaise = {$gt: 0};
    } else if (status === 'Paid') {
      filter.status = 'Issued';
      filter.duePaise = 0;
    } else if (status === 'PartlyPaid') {
      filter.status = 'Issued';
      filter.paymentStatus = 'PartlyPaid';
    } else if (status && status !== 'All') {
      filter.status = status;
    }
    if (customerId) filter.customerId = customerId;
    if (businessCategory && ['NewGoods', 'UsedGoods', 'Service'].includes(businessCategory)) {
      filter.businessCategory = businessCategory;
    }
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        {invoiceNumber: {$regex: escaped, $options: 'i'}},
        {'customerSnapshot.name': {$regex: escaped, $options: 'i'}},
      ];
    }
    if (dateFrom || dateTo) {
      filter.invoiceDate = {};
      if (dateFrom) filter.invoiceDate.$gte = dateFrom;
      if (dateTo) filter.invoiceDate.$lte = dateTo;
    }

    const totalCount = await col<InvoiceDocument>(db, 'invoices').countDocuments(filter);
    if (totalCount === 0) {
      throw new AppError(404, 'No invoices match the requested criteria.');
    }
    if (totalCount > MAX_ZIP_LIMIT) {
      throw new AppError(
        400,
        `Query matches ${totalCount} invoices, exceeding the maximum export limit of ${MAX_ZIP_LIMIT}. Please narrow your date range or filter.`
      );
    }

    const invoices = await col<InvoiceDocument>(db, 'invoices')
      .find(filter)
      .sort({invoiceDate: -1, createdAt: -1})
      .toArray();

    const company = await col(db, 'companySettings').findOne({tenantId: identity.tenantId});

    // Default template fallback
    const defaultTemplate =
      (await col(db, 'invoiceTemplates').findOne({tenantId: identity.tenantId, isDefault: true, status: 'Active'})) ||
      (await col(db, 'invoiceTemplates').findOne({tenantId: identity.tenantId, status: 'Active'})) ||
      {
        title: 'Tax Invoice',
        paper: 'A4',
        orientation: 'portrait',
        fontSize: 10,
        accent: '#1e293b',
        borders: true,
        striped: false,
        logoPosition: 'left',
        fields: {
          logo: true,
          shopName: true,
          shopAddress: true,
          shopGst: true,
          shopPhone: true,
          shopEmail: true,
          number: true,
          date: true,
          due: true,
          reference: true,
          customerName: true,
          customerAddress: true,
          customerPhone: true,
          customerGst: true,
          shipping: true,
          serials: true,
          warranty: true,
          subtotal: true,
          taxes: true,
          grandTotal: true,
          payments: true,
          declaration: true,
          bank: true,
          signatures: true,
        },
        columns: [
          {id: 'index', label: '#', show: true, align: 'left'},
          {id: 'description', label: 'Item & Description', show: true, align: 'left'},
          {id: 'hsn', label: 'HSN/SAC', show: true, align: 'left'},
          {id: 'qty', label: 'Qty', show: true, align: 'right'},
          {id: 'rate', label: 'Rate (INR)', show: true, align: 'right'},
          {id: 'tax', label: 'Tax', show: true, align: 'right'},
          {id: 'amount', label: 'Amount (INR)', show: true, align: 'right'},
        ],
        footer: 'This is a computer generated invoice.',
      };

    const templateCache = new Map<string, any>();
    const logoCache = new Map<string, Uint8Array | null>();

    const getLogo = async (fileId?: string): Promise<Uint8Array | null> => {
      if (!fileId) return null;
      if (logoCache.has(fileId)) return logoCache.get(fileId)!;
      try {
        const file = await getFile(identity, fileId);
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (file.stream instanceof ReadableStream) {
          const reader = file.stream.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              length += next.value.byteLength;
              if (length > 5 * 1024 * 1024) { await reader.cancel(); throw new Error('Logo exceeds size limit'); }
              chunks.push(next.value);
            }
          } finally { reader.releaseLock(); }
        } else {
          for await (const chunk of file.stream as AsyncIterable<Uint8Array>) {
            length += chunk.byteLength;
            if (length > 5 * 1024 * 1024) throw new Error('Logo exceeds size limit');
            chunks.push(chunk);
          }
        }
        const bytes = Buffer.concat(chunks);
        logoCache.set(fileId, bytes);
        return bytes;
      } catch {
        logoCache.set(fileId, null);
        return null;
      }
    };

    const zip = new JSZip();

    // Export manifest with tenant-safe metadata and membership
    const manifest = {
      tenantId: identity.tenantId,
      exportedAt: new Date().toISOString(),
      invoiceCount: invoices.length,
      filters: {customerId, status, dateFrom, dateTo, search: search || undefined},
      invoices: invoices.map(i => {
        const s = i.issuedSnapshot || i;
        return {
          id: i._id,
          invoiceNumber: s.invoiceNumber || i.invoiceNumber || i._id,
          invoiceDate: s.invoiceDate || i.invoiceDate,
          totalPaise: s.totalPaise || i.totalPaise,
          duePaise: i.duePaise,
          paymentStatus: i.paymentStatus,
          customerName: s.customerSnapshot?.name || i.customerSnapshot?.name || 'Customer',
        };
      }),
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    for (const inv of invoices) {
      const snap = inv.issuedSnapshot || inv;
      const num = snap.invoiceNumber || inv.invoiceNumber || inv._id;
      const safeNum = String(num).replace(/[^a-zA-Z0-9_-]/g, '_');
      const isDraft = inv.status === 'Draft';
      const fileName = isDraft ? `DRAFT_${safeNum}.pdf` : `${safeNum}.pdf`;

      // Resolve template
      let tmpl = snap.template || defaultTemplate;
      const tKey = `${inv.templateId || ''}:${inv.templateRevision || ''}`;
      if (!snap.template && tKey !== ':') {
        if (templateCache.has(tKey)) {
          tmpl = templateCache.get(tKey);
        } else {
          if (inv.templateId && inv.templateRevision) {
            const rev = await col(db, 'templateRevisions').findOne({
              tenantId: identity.tenantId,
              templateId: inv.templateId,
              revision: inv.templateRevision,
            });
            if (rev?.snapshot) tmpl = rev.snapshot;
          } else if (inv.templateId) {
            const t = await col(db, 'invoiceTemplates').findOne({
              tenantId: identity.tenantId,
              _id: inv.templateId,
            });
            if (t) tmpl = t;
          }
          templateCache.set(tKey, tmpl);
        }
      }

      const fields = tmpl.fields || {};
      const accentRgb = hexToRgb(tmpl.accent || '#1e293b');
      const doc = new jsPDF({
        orientation: tmpl.orientation || 'portrait',
        format: (tmpl.paper || 'A4').toLowerCase() as 'a4' | 'letter',
      });
      const width = doc.internal.pageSize.getWidth();
      let y = 14;

      // Title
      const title = tmpl.title || (snap.taxMode === 'Inter-state' || snap.igstPaise ? 'Tax Invoice' : 'Tax Invoice');
      doc.setFontSize(16);
      doc.setTextColor(accentRgb[0], accentRgb[1], accentRgb[2]);
      doc.text(title, width / 2, y, {align: 'center'});
      y += 8;

      // Logo
      const logoFileId = snap.seller?.logoFileId || snap.sellerSnapshot?.logoFileId || company?.logoFileId;
      if (fields.logo !== false && logoFileId) {
        const logoBytes = await getLogo(logoFileId);
        if (logoBytes) {
          try {
            const pos = tmpl.logoPosition || 'left';
            const lx = pos === 'right' ? width - 38 : pos === 'center' ? width / 2 - 12 : 14;
            doc.addImage(logoBytes, 'PNG', lx, y, 24, 16, undefined, 'FAST');
            y += 18;
          } catch {
            // Ignore corrupted logo bytes, continue rendering text
          }
        }
      }

      // Company info & Document metadata in side-by-side block
      const seller = snap.seller || snap.sellerSnapshot || company || {};
      const companyLines: string[] = [];
      if (fields.shopName !== false && seller.name) companyLines.push(seller.name);
      if (fields.shopAddress !== false && seller.address) companyLines.push(seller.address);
      if (fields.shopGst !== false && seller.gst) companyLines.push(`GSTIN: ${seller.gst}`);
      if (fields.shopPhone !== false && seller.phone) companyLines.push(`Phone: ${seller.phone}`);
      if (fields.shopEmail !== false && seller.email) companyLines.push(`Email: ${seller.email}`);

      const metaLines: string[] = [];
      if (fields.number !== false) metaLines.push(`Invoice #: ${num}`);
      if (fields.date !== false) metaLines.push(`Date: ${snap.invoiceDate || inv.invoiceDate}`);
      if (fields.due !== false && (snap.dueDate || inv.dueDate)) metaLines.push(`Due Date: ${snap.dueDate || inv.dueDate}`);
      if (fields.reference !== false && snap.sourceReference) metaLines.push(`Ref: ${snap.sourceReference}`);
      if (snap.placeOfSupply) metaLines.push(`Place of Supply: ${snap.placeOfSupply}`);

      autoTable(doc, {
        startY: y,
        body: [[companyLines.join('\n'), metaLines.join('\n')]],
        theme: tmpl.borders ? 'grid' : 'plain',
        styles: {fontSize: 9, cellPadding: 2, lineColor: [90,90,90], lineWidth: 0.15},
        columnStyles: {
          0: {cellWidth: (width - 28) / 2},
          1: {cellWidth: (width - 28) / 2, halign: 'right'},
        },
      });
      y = (doc as any).lastAutoTable.finalY + 4;

      // Buyer (Bill To) & Ship To (if enabled)
      const cust = {...(snap.customer || snap.customerSnapshot || inv.customerSnapshot || {}), ...(snap.billTo || {})};
      const buyerLines: string[] = ['Bill To:'];
      if (fields.customerName !== false && cust.name) buyerLines.push(cust.name);
      if (fields.customerAddress !== false && (snap.billingAddress || cust.address)) {
        buyerLines.push(snap.billingAddress || cust.address);
      }
      if (fields.customerPhone !== false && cust.phone) buyerLines.push(`Phone: ${cust.phone}`);
      if (fields.customerGst !== false && cust.gst) buyerLines.push(`GSTIN: ${cust.gst}`);

      const ship = snap.shippingAddress || snap.shipTo;
      const shipLines: string[] = [];
      if (fields.shipping && (ship?.name || ship?.address || snap.shippingAddress)) {
        shipLines.push('Ship To:');
        if (typeof ship === 'string') {
          shipLines.push(ship);
        } else if (ship) {
          if (ship.name) shipLines.push(ship.name);
          if (ship.address) shipLines.push(ship.address);
          if (ship.phone) shipLines.push(`Phone: ${ship.phone}`);
          if (ship.state) shipLines.push(ship.state);
        }
      }

      autoTable(doc, {
        startY: y,
        body: [[buyerLines.join('\n'), shipLines.join('\n')]],
        theme: tmpl.borders ? 'grid' : 'plain',
        styles: {fontSize: 9, cellPadding: 2, lineColor: [90,90,90], lineWidth: 0.15},
        columnStyles: {
          0: {cellWidth: (width - 28) / 2},
          1: {cellWidth: (width - 28) / 2},
        },
      });
      y = (doc as any).lastAutoTable.finalY + 4;

      // Table columns & rows
      const visibleCols = (tmpl.columns || []).filter((c: any) => c.show);
      const lines = snap.lines || inv.lines || [];
      const tableHead = visibleCols.map((c: any) => c.label);
      const tableBody = lines.map((l: any, idx: number) => {
        return visibleCols.map((colDef: any) => {
          switch (colDef.id) {
            case 'index':
              return String(idx + 1);
            case 'description': {
              const parts = [l.description || l.productSnapshot?.name || l.serviceSnapshot?.name || 'Item'];
              if (l.details) parts.push(l.details);
              if (l.printSpecifications && typeof l.printSpecifications === 'object') {
                const specEntries = Object.entries(l.printSpecifications)
                  .filter(([_, v]) => v)
                  .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1).replace(/([A-Z])/g, ' $1')}: ${v}`);
                if (specEntries.length > 0) parts.push(specEntries.join(' · '));
              }
              const serials = l.serials?.length ? l.serials : (l.stockAllocations || []).flatMap((a: any) => a.serials || []);
              if (fields.serials !== false && serials.length) parts.push('SN: ' + serials.join(', '));
              if (fields.warranty !== false && l.warrantyMonths) {
                parts.push(`Warranty: ${l.warrantyMonths} months`);
              }
              return parts.join('\n');
            }
            case 'hsn':
              return l.hsn || l.sac || '';
            case 'qty':
              return String(l.quantity ?? 1) + (l.unit ? ` ${l.unit}` : '');
            case 'rate':
              return fmtPaise(l.unitRatePaise);
            case 'rateIncl':
              return fmtPaise(
                (l.inclusive ?? snap.inclusive) ? (l.unitRatePaise ?? 0) : Math.round((l.unitRatePaise ?? 0) * (1 + (l.taxTreatment && l.taxTreatment !== 'Taxable' ? 0 : (l.taxBasisPoints || 0)) / 10000))
              );
            case 'rateExcl':
              return fmtPaise((l.inclusive ?? snap.inclusive) ? Math.round((l.unitRatePaise ?? 0) / (1 + (l.taxTreatment && l.taxTreatment !== 'Taxable' ? 0 : (l.taxBasisPoints || 0)) / 10000)) : (l.unitRatePaise ?? 0));
            case 'tax':
              return l.taxTreatment && l.taxTreatment !== 'Taxable' ? l.taxTreatment : `${(l.taxBasisPoints || 0) / 100}%`;
            case 'discount':
              return l.discountPaise ? fmtPaise(l.discountPaise) : '—';
            case 'warranty':
              return l.warrantyMonths ? `${l.warrantyMonths}m` : '—';
            case 'amount':
              return fmtPaise(l.totalPaise ?? l.taxableBasePaise);
            default:
              return '';
          }
        });
      });

      const colStyles: Record<number, any> = {};
      visibleCols.forEach((c: any, i: number) => {
        colStyles[i] = {halign: c.align || 'left'};
      });

      autoTable(doc, {
        startY: y,
        head: [tableHead],
        body: tableBody,
        theme: tmpl.borders ? 'grid' : tmpl.striped ? 'striped' : 'plain',
        styles: {
          fontSize: Math.max(6, Math.min(tmpl.fontSize || 10, 18)),
          cellPadding: 2,
          overflow: 'linebreak',
        },
        headStyles: {fillColor: accentRgb, textColor: [255, 255, 255]},
        columnStyles: colStyles,
        rowPageBreak: 'avoid',
      });
      y = (doc as any).lastAutoTable.finalY + 4;

      // Summary totals table
      const summaryRows: Array<[string, string]> = [];
      if (fields.subtotal !== false) {
        summaryRows.push(['Taxable Subtotal', fmtPaise(snap.taxableBasePaise)]);
      }
      if (fields.taxes !== false) {
        if (snap.taxMode === 'Inter-state' || snap.igstPaise) {
          summaryRows.push(['IGST', fmtPaise(snap.igstPaise)]);
        } else {
          summaryRows.push(['CGST', fmtPaise(snap.cgstPaise)]);
          summaryRows.push(['SGST', fmtPaise(snap.sgstPaise)]);
        }
      }
      if (fields.grandTotal !== false) {
        summaryRows.push(['Total (INR)', fmtPaise(snap.totalPaise || inv.totalPaise)]);
      }
      if (fields.payments !== false && !isDraft) {
        const grand = snap.totalPaise || inv.totalPaise || 0;
        const due = inv.duePaise ?? 0;
        const paid = Math.max(0, grand - due);
        summaryRows.push(['Amount Received', fmtPaise(paid)]);
        summaryRows.push(['Balance Due', fmtPaise(due)]);
      }

      if (summaryRows.length > 0) {
        autoTable(doc, {
          startY: y,
          body: summaryRows,
          theme: 'plain',
          styles: {fontSize: 9, cellPadding: 1.5},
          columnStyles: {
            0: {cellWidth: width - 80, halign: 'right', fontStyle: 'bold'},
            1: {cellWidth: 52, halign: 'right'},
          },
        });
        y = (doc as any).lastAutoTable.finalY + 4;
      }

      // Bank details & Terms / Declaration
      const notesBlock: string[] = [];
      if (fields.declaration !== false && seller.declaration) {
        notesBlock.push(`Declaration: ${seller.declaration}`);
      }
      if (fields.bank !== false && seller.bank) {
        notesBlock.push(`Bank Details: ${seller.bank} | A/C: ${seller.account || ''} | IFSC: ${seller.ifsc || ''}`);
      }
      if (notesBlock.length > 0) {
        autoTable(doc, {
          startY: y,
          body: [[notesBlock.join('\n')]],
          theme: 'plain',
          styles: {fontSize: 8, fontStyle: 'italic', cellPadding: 1},
        });
        y = (doc as any).lastAutoTable.finalY + 4;
      }

      // Watermark & Footer
      const pageCount = doc.getNumberOfPages();
      if (isDraft || inv.status === 'Cancelled') {
        const watermarkText = isDraft ? 'DRAFT · NOT ISSUED' : 'CANCELLED';
        for (let p = 1; p <= pageCount; p++) {
          doc.setPage(p);
          doc.saveGraphicsState();
          doc.setTextColor(220, 80, 80);
          doc.setFontSize(36);
          doc.setFont('helvetica', 'bold');
          doc.text(watermarkText, width / 2, doc.internal.pageSize.getHeight() / 2, {
            align: 'center',
            angle: 45,
          });
          doc.restoreGraphicsState();
        }
      }

      const footerText = tmpl.footer || 'This is a computer generated invoice.';
      for (let p = 1; p <= pageCount; p++) {
        doc.setPage(p);
        doc.setFontSize(8);
        doc.setTextColor(100);
        doc.text(footerText, 14, doc.internal.pageSize.getHeight() - 8);
        doc.text(`Page ${p} of ${pageCount}`, width - 28, doc.internal.pageSize.getHeight() - 8);
      }

      const pdfArrayBuffer = doc.output('arraybuffer');
      zip.file(fileName, pdfArrayBuffer);
    }

    const zipBuffer = await zip.generateAsync({type: 'nodebuffer'});

    return new Response(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="invoices-bundle-${Date.now()}.zip"`,
      },
    });
  } catch (err: any) {
    const status = err instanceof AppError ? err.status : 500;
    return Response.json({error: err.message || 'ZIP Export failed.'}, {status});
  }
}
