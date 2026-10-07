'use client';
import {amountWords} from '@/lib/amount-words';
import {useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {Copy, Pencil, Printer, ArrowUp, ArrowDown, Check, FileText, Plus, Phone, Mail, MapPin} from 'lucide-react';
import {InvoiceTemplate, templateFields, extensionSeed} from '@/lib/extensions';
import {Bill, uid, money, totals, lineTotal, dateLabel, paid, balance} from '@/lib/domain';
import {useStore} from './store';
import {PageHead, Card, Btn, Modal, Field, Badge} from './ui';

const invoiceDate = (value?: string) => {
  if (!value) return '—';
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
};

const isNonGstTemplate = (template: InvoiceTemplate) => /non[\s-]?gst/i.test(`${template.title || ''} ${template.name || ''}`);

function buildNonGstTemplate(base: InvoiceTemplate): InvoiceTemplate {
  const columns = structuredClone(base.columns).map(column => ({
    ...column,
    show: column.id === 'tax' ? false : column.show,
    label: column.id === 'amount' ? 'Amount' : column.id === 'rateExcl' ? 'Rate' : column.label,
  }));
  const visible = columns.filter(column => column.show);
  if (visible.every(column => column.width != null) && Math.abs(visible.reduce((sum, column) => sum + (column.width || 0), 0) - 100) > 1) {
    columns.forEach(column => { column.width = undefined; });
  }
  return {
    ...structuredClone(base),
    id: '',
    name: 'Preprinted Non-GST Invoice',
    title: 'NON-GST INVOICE',
    isDefault: false,
    fields: {
      ...base.fields,
      shopGst: false,
      customerGst: false,
      reverseCharge: false,
      supplyDate: false,
      destination: false,
      taxes: false,
      taxSummary: false,
    },
    columns,
  };
}

function ReferenceInvoice({bill, template, state, supplier, isLive}: {bill: Bill; template: InvoiceTemplate; state: any; supplier?: {name:string;address:string;phone:string;gst:string}; isLive:boolean}) {
  const f = template.fields || {};
  const seller = bill.shopSnapshot || state.settings;
  const customer = supplier || bill.customerSnapshot || state.customers.find((entry: any) => entry.id === bill.customerId) || {};
  const billTo: any = supplier ? customer : bill.billTo || customer;
  const shipTo: any = bill.shipTo || billTo;
  const sum = totals(bill);
  const isNonGst = bill.lines.length > 0 && bill.lines.every((line) => line.taxTreatment === 'NonGST');
  const grandTotal = typeof bill.total === 'number' ? bill.total : sum.total + (bill.roundOff || 0);
  const interstate = bill.taxMode === 'Inter-state';
  const visibleColumns = (template.columns || []).filter(column => column.show && !(isNonGst && column.id === 'tax'));
  const packingLines = bill.lines.filter(line => line.lineType === 'Charge' && /^(packing(?:\s*&\s*forwarding)?|forwarding|freight)$/i.test(line.name.trim()));
  const packingTotal = packingLines.reduce((value, line) => value + lineTotal(line, bill.inclusive, bill.taxMode).base, 0);
  const itemLines = f.packing ? bill.lines.filter(line => !packingLines.includes(line)) : bill.lines;
  const publicNumber = (bill as any).invoiceNumber || (bill as any).quotationNumber || bill.id;
  const automaticTitle = bill.kind === 'Quotation' ? 'QUOTATION' : isNonGst ? 'NON-GST INVOICE' : bill.kind === 'Service' ? (sum.tax > 0 ? 'SERVICE TAX INVOICE' : 'SERVICE INVOICE') : sum.tax > 0 ? 'TAX INVOICE' : 'CASH BILL';
  const title = isNonGst
    ? (/non[\s-]?gst/i.test(template.title || '') ? template.title : 'NON-GST INVOICE')
    : template.title || automaticTitle;
  const headerReserve = template.headerMode === 'hidden' ? 0 : template.topReserveMm;
  const footerReserve = template.footerMode === 'hidden' ? 0 : template.bottomReserveMm;
  const calibratedItemHeight = Math.max(24, template.itemAreaMinHeightMm
    - (template.headerMode === 'preprinted' ? headerReserve - 34 : 0)
    - (template.footerMode === 'preprinted' ? footerReserve - 20 : 0));
  const style = {
    '--invoice-font': `${template.fontSize}px`, '--invoice-heading-font': `${template.headingFontSize}px`,
    '--invoice-font-family': template.fontFamily, '--invoice-font-weight': template.fontWeight,
    '--invoice-text': template.textColor, '--invoice-line': template.lineColor,
    '--invoice-line-width': `${template.lineWidth}px`, '--invoice-accent': template.accent,
    '--invoice-title-bg': template.titleBackground, '--invoice-title-color': template.titleColor,
    '--invoice-page-margin': `${template.pageMarginMm}mm`, '--invoice-item-height': `${calibratedItemHeight}mm`,
    '--invoice-top-reserve': `${headerReserve}mm`,
  } as React.CSSProperties;

  const partyLines = (party: any, includeGst: boolean) => [
    f.customerName && party?.name,
    f.customerAddress && party?.address,
    f.customerPhone && party?.phone && `Phone: ${party.phone}`,
    includeGst && customer?.gst && `GSTIN: ${customer.gst}`,
    [party?.state, party?.postalCode].filter(Boolean).join(' - '),
  ].filter(Boolean);

  const cell = (line: Bill['lines'][number], id: string, index: number) => {
    const calculated = lineTotal(line, bill.inclusive, bill.taxMode);
    const rateExclusive = bill.inclusive ? line.rate / (1 + line.tax / 100) : line.rate;
    const gross = rateExclusive * line.qty;
    const discountAmount = Math.max(0, gross - calculated.base);
    if (id === 'index') return index + 1;
    if (id === 'description') return <><b>{line.name}</b>{line.details && <small>{line.details}</small>}{line.printSpecifications && Object.entries(line.printSpecifications).filter(([, value]) => value).length > 0 && <small>{Object.entries(line.printSpecifications).filter(([, value]) => value).map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1')}: ${value}`).join(' · ')}</small>}{f.warranty && line.warranty > 0 && <small>Warranty: {line.warranty} month(s)</small>}</>;
    if (id === 'hsn') return line.hsn || line.sac || '';
    if (id === 'qty') return line.qty;
    if (id === 'unit') return line.unit || 'Piece';
    if (id === 'rateExcl') return money(rateExclusive);
    if (id === 'rateIncl') return money(bill.inclusive ? line.rate : line.rate * (1 + line.tax / 100));
    if (id === 'gross') return money(gross);
    if (id === 'discount') return discountAmount ? money(discountAmount) : '0.00';
    if (id === 'tax') return line.taxTreatment === 'Taxable' || !line.taxTreatment ? `${line.tax}%` : line.taxTreatment;
    if (id === 'amount') return money(calculated.base);
    if (id === 'warranty') return line.warranty ? `${line.warranty} months` : '—';
    return '';
  };

  const rowCapacity = Math.max(1, Math.floor(Math.max(8, calibratedItemHeight - 12) / 8.5));
  const pageLines: Array<Array<{line: Bill['lines'][number]; index: number}>> = [];
  let currentPage: Array<{line: Bill['lines'][number]; index: number}> = [];
  let usedCapacity = 0;
  itemLines.forEach((line, index) => {
    const specifications = line.printSpecifications ? Object.values(line.printSpecifications).filter(Boolean).join(' ') : '';
    const descriptionLength = [line.name, line.details, specifications].filter(Boolean).join(' ').length;
    const rowWeight = Math.max(1, Math.ceil(descriptionLength / 70));
    if (currentPage.length && usedCapacity + rowWeight > rowCapacity) {
      pageLines.push(currentPage);
      currentPage = [];
      usedCapacity = 0;
    }
    currentPage.push({line, index});
    usedCapacity += Math.min(rowWeight, rowCapacity);
  });
  if (currentPage.length || pageLines.length === 0) pageLines.push(currentPage);

  return <div className="print-area reference-document">
    {pageLines.map((lines, pageIndex) => {
      const isLastPage = pageIndex === pageLines.length - 1;
      return <article key={pageIndex} className={`invoice-paper reference-invoice ${template.headerMode === 'preprinted' ? 'preprinted-header' : ''} ${bill.status === 'Cancelled' ? 'draft-document' : ''} ${template.borders ? '' : 'no-borders'} ${template.striped ? 'striped' : ''}`} style={style}>
      {bill.status === 'Cancelled' && <div className="invoice-draft-watermark">CANCELLED</div>}
      {template.headerMode === 'preprinted' && <div className="letterhead-reserve" style={{height: `${headerReserve}mm`}} aria-label="Reserved for preprinted letterhead" />}
      {template.headerMode === 'digital' && <header className="reference-letterhead" style={{minHeight: `${Math.max(18, headerReserve)}mm`}}>
        <div>{f.shopName && <strong>{seller.name || 'Billing Software'}</strong>}<span>{seller.invoiceHeaderSubtitle || (/niramaalai/i.test(seller.name || '') ? 'ACCHU KALAIKOODAM' : 'PRINT · DESIGN · BRANDING')}</span></div>
        <i aria-hidden="true" />
      </header>}
      <div className="reference-title"><span>{title}</span>{pageLines.length > 1 && <small>Page {pageIndex + 1} of {pageLines.length}</small>}</div>
      {f.shopGst && !isNonGst && <div className="reference-seller-gst">GSTIN: {seller.gst || '—'}</div>}
      <div className="reference-body">
        <section className="reference-meta-grid">
          <div><b>{seller.invoiceNumberLabel || 'Invoice No'}</b><span>{f.number ? publicNumber : ''}</span></div><div><b>Transport Mode</b><span>{f.transportMode ? bill.dispatch || '—' : ''}</span></div>
          <div><b>Invoice Date</b><span>{f.date ? invoiceDate(bill.date) : ''}</span></div><div><b>Vehicle Number</b><span>{f.vehicleNumber ? bill.vehicleNumber || '—' : ''}</span></div>
          {!isNonGst && <><div><b>Reverse Charge</b><span>{f.reverseCharge ? bill.reverseCharge ? 'Yes' : 'No' : ''}</span></div><div><b>Date of Supply</b><span>{f.supplyDate ? invoiceDate(bill.supplyDate || bill.date) : ''}</span></div></>}
          <div><b>State</b><span className="reference-state-value">{f.stateDetails && <><span>{seller.state || '—'}</span>{seller.stateCode && !isNonGst && <><strong>State Code</strong><span>{seller.stateCode}</span></>}</>}</span></div>
          {!isNonGst ? <div><b>Place of Supply</b><span>{f.destination ? bill.placeOfSupply || '—' : ''}</span></div> : <div />}
        </section>
        <section className="reference-parties">
          <div><h3>BILL TO PARTY</h3>{partyLines(billTo, !!f.customerGst && !isNonGst).map((line, index) => <p key={index} className={index === 0 ? 'party-name' : ''}>{line}</p>)}</div>
          <div><h3>SHIP TO PARTY</h3>{f.shipping ? partyLines(shipTo, false).map((line, index) => <p key={index} className={index === 0 ? 'party-name' : ''}>{line}</p>) : <p>Same as bill to</p>}</div>
        </section>
        <section className="reference-items-wrap" style={{minHeight: `${calibratedItemHeight}mm`}}>
          <table className="reference-items"><colgroup>{visibleColumns.map(column => <col key={column.id} style={column.width ? {width: `${column.width}%`} : undefined} />)}</colgroup><thead><tr>{visibleColumns.map(column => <th key={column.id} style={{textAlign: column.align}}>{column.label}</th>)}</tr></thead>
            <tbody>{lines.map(({line, index}) => <tr key={line.clientLineKey || index}>{visibleColumns.map(column => <td key={column.id} style={{textAlign: column.align}}>{cell(line, column.id, index)}</td>)}</tr>)}
            {lines.length < rowCapacity && <tr className="reference-empty-row">{visibleColumns.map(column => <td key={column.id}>&nbsp;</td>)}</tr>}</tbody>
          </table>
        </section>
        {!isLastPage && <div className="reference-continued">Continued on page {pageIndex + 2}</div>}
        {isLastPage && <><section className="reference-settlement">
          <div className="reference-settlement-left">
            {f.bank && <div className="reference-bank"><p><b>Bank</b><span>{seller.bank || '—'}</span></p><p><b>Name</b><span>{seller.name || '—'}</span></p><p><b>A/C No.</b><span>{seller.account || '—'}</span></p><p><b>Branch</b><span>{seller.bankBranch || '—'}</span></p><p><b>IFSC Code</b><span>{seller.ifsc || '—'}</span></p></div>}
            {f.amountWords && <div className="reference-words"><b>E.&amp;<br/>O.E</b><span>{amountWords(grandTotal)}</span></div>}
          </div>
          <div className="reference-totals">
            {f.packing && <p><span>Packing &amp; forwarding</span><b>{packingTotal ? money(packingTotal) : ''}</b></p>}
            {f.subtotal && <p className="emphasis"><span>TOTAL</span><b>{money(sum.base)}</b></p>}
            {f.taxes && !isNonGst && (interstate ? <p><span>Add: IGST</span><b>{money(sum.igst)}</b></p> : <><p><span>Add: CGST</span><b>{money(sum.cgst)}</b></p><p><span>Add: SGST</span><b>{money(sum.sgst)}</b></p></>)}
            {f.roundOff && Math.abs(grandTotal - sum.total) >= 0.005 && <p><span>Round off</span><b>{money(grandTotal - sum.total)}</b></p>}
            {f.taxes && !isNonGst && <p><span>Total Tax Amount</span><b>{money(sum.tax)}</b></p>}
            {f.grandTotal && <p className="grand"><span>GRAND TOTAL</span><b>{money(grandTotal)}</b></p>}
          </div>
        </section>
        {f.payments && bill.kind !== 'Quotation' && bill.status !== 'Draft' && !supplier && <div className="reference-payment"><span>Amount received: {money(bill.previewPaid ?? bill.paid ?? paid(state, bill.id))}</span><b>Balance: {money(bill.previewPaid !== undefined ? Math.max(0, grandTotal - bill.previewPaid) : bill.dueAmount ?? balance(state, bill))}</b></div>}
        <section className="reference-signatures">
          <div>{f.declaration && <><u>Terms of Conditions:</u><div className="reference-terms">{(template.terms || seller.declaration || '').split(/\r?\n/).filter(Boolean).map((term: string, index: number) => <p key={index}>{index + 1}. {term.replace(/^\d+[.)]\s*/, '')}</p>)}</div></>}</div>
          <div className="signature-label">{f.receiverSignature && <>Receiver&apos;s Signature with seal</>}</div>
          <div className="signature-label">{f.signatures && <><b>For {seller.name}</b><span>Authorised Signature</span></>}</div>
        </section>
        {f.notes && bill.notes && <div className="reference-notes"><b>Notes:</b> {bill.notes}</div>}</>}
      </div>
      {template.footerMode === 'digital' && <footer className="reference-contact-footer" style={{minHeight: `${Math.max(14, footerReserve)}mm`}}>
        {f.shopPhone && <div className="contact-footer-item phone"><i aria-hidden="true"><Phone /></i><span>{[seller.phone, seller.alternatePhone].filter(Boolean).map((phone: string) => <span key={phone}>{phone}</span>)}</span></div>}
        {f.shopEmail && <div className="contact-footer-item email"><i aria-hidden="true"><Mail /></i><span>{seller.email || '—'}</span></div>}
        {f.shopAddress && <div className="contact-footer-item address"><i aria-hidden="true"><MapPin /></i><span>{seller.address || '—'}</span></div>}
      </footer>}
      {template.footerMode === 'preprinted' && <div className="letterhead-reserve footer" style={{height: `${footerReserve}mm`}} aria-label="Reserved for preprinted footer" />}
      {!isLive && <p className="invoice-foot">DEMO - not a valid tax invoice</p>}
    </article>;
    })}
  </div>;
}

export function TemplateInvoice({
  bill,
  supplier,
  templateId,
  template,
}: {
  bill: Bill;
  supplier?: {name: string; address: string; phone: string; gst: string};
  templateId?: string;
  template?: InvoiceTemplate;
}) {
  const {state, isLive} = useStore();
  const selectedTemplate =
    template ||
    (!templateId ? (bill as Bill & {templateSnapshot?: InvoiceTemplate}).templateSnapshot : undefined) ||
    state.templates.find((t) => t.id === (templateId || bill.templateId || state.defaultTemplateId)) ||
    state.templates[0];
  if (!selectedTemplate) return <div className="notice">Select a saved invoice template to preview this document.</div>;
  const templateDefaults = extensionSeed.templates[0];
  const selectedColumns = (selectedTemplate.columns || []).some((column: any) => column.id === 'unit') && (selectedTemplate.columns || []).some((column: any) => column.id === 'gross')
    ? selectedTemplate.columns : templateDefaults.columns;
  const t: InvoiceTemplate = {...templateDefaults, ...selectedTemplate, fields: {...templateDefaults.fields, ...(selectedTemplate.fields || {})}, columns: selectedColumns};
  return <ReferenceInvoice bill={bill} template={t} state={state} supplier={supplier} isLive={isLive} />;
}

export function PrintDialog({bills, onClose}: {bills: Bill[]; onClose: () => void}) {
  const {state, notify} = useStore();
  const [busy, setBusy] = useState(false);
  const [userOverrode, setUserOverrode] = useState(false);
  const [templateId, setTemplateId] = useState(bills[0]?.templateId || state.defaultTemplateId);
  const template = state.templates.find((t) => t.id === templateId) || state.templates[0];
  const previewRefs = useRef(new Map<string, HTMLDivElement>());

  async function download() {
    setBusy(true);
    try {
      const e = await import('@/lib/exports');
      if (!template) throw new Error('Select an active print template.');
      const entries = bills.map((bill) => {
        const wrapper = previewRefs.current.get(bill.id);
        const element = wrapper?.querySelector<HTMLElement>('.reference-document') || wrapper?.querySelector<HTMLElement>('.invoice-paper');
        if (!element) throw new Error(`Preview for ${bill.id} is not ready. Wait for it to appear and try again.`);
        const billTemplate = userOverrode ? template : ((bill as any).templateSnapshot || state.templates.find((t) => t.id === (bill.templateId || state.defaultTemplateId)) || template);
        const rawNum = (bill as any).invoiceNumber || (bill as any).quotationNumber || bill.id;
        const documentName = bill.status === 'Draft' ? (String(rawNum).startsWith('DRAFT') ? String(rawNum) : `DRAFT_${rawNum}`) : String(rawNum);
        return {name: documentName, element, template: billTemplate};
      });
      const firstTemplate = entries[0]?.template || template;
      e.downloadBytes(
        bills.length === 1 ? `${entries[0].name}.pdf` : 'invoices.zip',
        bills.length === 1
          ? await e.invoicePreviewPdfBytes(entries[0].element, firstTemplate)
          : await e.invoicePreviewZipBytes(entries),
        bills.length === 1 ? 'application/pdf' : 'application/zip'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Download failed.';
      notify(/Loading chunk|ChunkLoadError/i.test(message)
        ? 'PDF tools were updated while this page was open. Refresh the page once, then download again.'
        : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Print documents" onClose={onClose} wide>
      <div className="toolbar screen-only">
        <Field label="Print template">
          <select
            value={userOverrode ? templateId : ''}
            onChange={(e) => {
              setUserOverrode(true);
              setTemplateId(e.target.value);
            }}
          >
            {!userOverrode && (
              <option value="">
                Issued template snapshot (default)
              </option>
            )}
            {state.templates.map((t) => (
              <option value={t.id} key={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <span>
          {template.paper} · {template.orientation} · {bills.length} document(s)
        </span>
        <Link className="text-link" href="/templates" onClick={onClose}>
          Edit templates
        </Link>
      </div>
      <div className="batch-print">
        {bills.map((b) => (
          <div
            key={b.id}
            ref={(node) => {
              if (node) previewRefs.current.set(b.id, node);
              else previewRefs.current.delete(b.id);
            }}
          >
            <TemplateInvoice bill={b} templateId={userOverrode ? templateId : undefined} />
          </div>
        ))}
      </div>
      <div className="form-actions">
        <Btn secondary onClick={onClose}>
          Cancel
        </Btn>
        <Btn disabled={busy} onClick={download}>
          {busy ? 'Preparing…' : bills.length === 1 ? 'Download PDF' : 'Download ZIP'}
        </Btn>
        <Btn
          onClick={() => {
            const style = document.createElement('style');
            style.textContent = `@media print { @page { size: ${template.paper} ${template.orientation}; margin: 0; } }`;
            document.head.appendChild(style);
            window.print();
            style.remove();
          }}
        >
          <Printer size={16} />
          Print / save PDF
        </Btn>
      </div>
    </Modal>
  );
}

export default function Templates() {
  const {
    state,
    setState,
    notify,
    isLive,
    saveTemplateApi,
    setDefaultTemplateApi,
    archiveTemplateApi,
  } = useStore();

  const [editing, setEditing] = useState<InvoiceTemplate | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [sampleId, setSampleId] = useState(state.bills[0]?.id || '');
  const [print, setPrint] = useState(false);
  const [saving, setSaving] = useState(false);
  const creatingNonGstTemplate = useRef(false);

  useEffect(() => {
    if (editing || creatingNonGstTemplate.current || state.templates.length === 0 || state.templates.some(isNonGstTemplate)) return;
    const base = state.templates.find(template => template.status !== 'Archived') || extensionSeed.templates[0];
    creatingNonGstTemplate.current = true;
    void saveTemplateApi(buildNonGstTemplate(base)).finally(() => {
      creatingNonGstTemplate.current = false;
    });
  }, [editing, saveTemplateApi, state.templates]);

  const previewOnlySample: Bill = {
    id: 'PREVIEW-INV-0001', customerId: 'PREVIEW-CUSTOMER', date: '2026-09-18', due: '2026-09-18',
    kind: 'Sale', category: 'New goods', status: 'Preview', inclusive: true, taxMode: 'Intra-state',
    placeOfSupply: 'Tamil Nadu', notes: 'Thank you for your business.', profit: null, previewPaid: 10000,
    orderRef: 'PO-1042', deliveryNote: 'DN-1042', dispatch: 'By hand',
    customerSnapshot: {
      id: 'PREVIEW-CUSTOMER', name: 'Anand Computers', phone: '98765 43210', email: 'accounts@example.com',
      address: '42, Omalur Main Road, Salem, Tamil Nadu 636009', gst: '33ABCDE1234F1Z5', type: 'Business', notes: '',
    },
    shipTo: {name: 'Anand Computers — Warehouse', address: '12, Five Roads, Salem', phone: '98765 43210', state: 'Tamil Nadu', postalCode: '636004'},
    lines: [
      {productId: 'PREVIEW-LAPTOP', name: 'Dell Latitude 5420 Laptop', qty: 1, rate: 55000, discount: 0, tax: 18, taxTreatment: 'Taxable', serials: ['DL5420-SN-1001'], hsn: '84713010', warranty: 12, lineType: 'Product'},
      {productId: 'PREVIEW-RAM', name: 'Crucial 8GB DDR4 RAM', qty: 2, rate: 4000, discount: 0, tax: 18, taxTreatment: 'Taxable', serials: [], hsn: '84733099', warranty: 36, lineType: 'Product'},
      {productId: '', name: 'PC assembly and testing', qty: 1, rate: 1000, discount: 0, tax: 18, taxTreatment: 'Taxable', serials: [], hsn: '998713', warranty: 1, lineType: 'Charge'},
    ],
  };
  const sample = state.bills.find((b) => b.id === sampleId) || state.bills[0] || previewOnlySample;

  async function save() {
    if (!editing?.name.trim()) {
      notify('Give the template a name.');
      return;
    }
    if (editing.columns.filter((c) => c.show).length < 2) {
      notify('Keep at least two item columns visible.');
      return;
    }
    const visibleColumns = editing.columns.filter((column) => column.show);
    if (visibleColumns.every(column => column.width != null) && Math.abs(visibleColumns.reduce((sum, column) => sum + (column.width || 0), 0) - 100) > 1) {
      notify('Visible column widths must total 100%.');
      return;
    }
    const usableItemHeight = editing.itemAreaMinHeightMm
      - (editing.headerMode === 'preprinted' ? editing.topReserveMm - 34 : 0)
      - (editing.footerMode === 'preprinted' ? editing.bottomReserveMm - 20 : 0);
    if (usableItemHeight < 24) {
      notify('Header and footer reserves leave too little printable item space. Reduce a reserve or increase the item area height.');
      return;
    }
    setSaving(true);
    if (isLive) {
      // In live mode, call POST if new template or copy; call PUT if existing
      const ok = await saveTemplateApi(editing, isNew ? undefined : editing.id);
      setSaving(false);
      if (ok) {
        setEditing(null);
        setIsNew(false);
      }
      return;
    }

    // Mock Mode
    if (isNew) {
      const created = {...editing, id: uid('TPL')};
      setState((s) => ({...s, templates: [...s.templates, created]}));
    } else {
      setState((s) => ({...s, templates: s.templates.map((t) => (t.id === editing.id ? editing : t))}));
    }
    notify('Template saved. Select it when printing any invoice.');
    setSaving(false);
    setEditing(null);
    setIsNew(false);
  }

  function handleNewTemplate() {
    // An unsaved starter layout is editor input, never a live template identity.
    const base = state.templates.find(t => t.status !== 'Archived') || extensionSeed.templates[0];
    const t: InvoiceTemplate = {
      ...structuredClone(base),
      id: '',
      name: 'New custom invoice',
      isDefault: false,
    };
    setIsNew(true);
    setEditing(t);
  }

  function handleCopyTemplate(t: InvoiceTemplate) {
    const copy: InvoiceTemplate = {
      ...structuredClone(t),
      id: '',
      name: t.name + ' — copy',
      isDefault: false,
    };
    setIsNew(true);
    setEditing(copy);
  }

  return (
    <>
      <PageHead
        title="Invoice templates"
        description="Create reusable layouts, customise fields and choose a template whenever you print."
        actions={
          editing ? (
            <>
              <Btn
                secondary
                onClick={() => {
                  setEditing(null);
                  setIsNew(false);
                }}
              >
                Cancel changes
              </Btn>
              <Btn disabled={saving} onClick={save}>
                <Check size={16} />
                {saving ? 'Saving…' : 'Save template'}
              </Btn>
            </>
          ) : (
            <Btn onClick={handleNewTemplate}>
              <Plus size={16} />
              New template
            </Btn>
          )
        }
      />

      {editing ? (
        <div className="template-editor">
          <div className="stack">
            <Card title="Template settings">
              <div className="form-body stack">
                <Field label="Template name">
                  <input value={editing.name} onChange={(e) => setEditing({...editing, name: e.target.value})} />
                </Field>
                <Field label="Printed document title" hint="Automatic chooses Tax Invoice, Non-GST Invoice, Cash Bill, Service Invoice or Quotation from the document. Select a title here only when this template must always use that title.">
                  <select value={editing.title} onChange={(e) => setEditing({...editing, title: e.target.value})}>
                    <option value="">Automatic by document type</option>
                    <option value="TAX INVOICE">Tax Invoice</option><option value="NON-GST INVOICE">Non-GST Invoice</option><option value="CASH BILL">Cash Bill</option><option value="SALES INVOICE">Sales Invoice</option><option value="SERVICE INVOICE">Service Invoice</option><option value="QUOTATION">Quotation</option>
                    {editing.title && !['TAX INVOICE','NON-GST INVOICE','CASH BILL','SALES INVOICE','SERVICE INVOICE','QUOTATION'].includes(editing.title) && <option value={editing.title}>{editing.title}</option>}
                  </select>
                </Field>
                <div className="form-grid">
                  <Field label="Paper">
                    <select
                      value={editing.paper}
                      onChange={(e) => setEditing({...editing, paper: e.target.value as InvoiceTemplate['paper']})}
                    >
                      <option>A4</option>
                      <option>Letter</option>
                    </select>
                  </Field>
                  <Field label="Orientation">
                    <select
                      value={editing.orientation}
                      onChange={(e) =>
                        setEditing({...editing, orientation: e.target.value as InvoiceTemplate['orientation']})
                      }
                    >
                      <option>portrait</option>
                      <option>landscape</option>
                    </select>
                  </Field>
                  <Field label="Text size">
                    <input
                      type="number"
                      min="9"
                      max="16"
                      value={editing.fontSize}
                      onChange={(e) =>
                        setEditing({...editing, fontSize: Math.max(9, Math.min(16, +e.target.value))})
                      }
                    />
                  </Field>
                  <Field label="Heading size">
                    <input type="number" min="9" max="24" value={editing.headingFontSize} onChange={(e) => setEditing({...editing, headingFontSize: Math.max(9, Math.min(24, +e.target.value))})} />
                  </Field>
                  <Field label="Font family">
                    <select value={editing.fontFamily} onChange={(e) => setEditing({...editing, fontFamily: e.target.value as InvoiceTemplate['fontFamily']})}>
                      <option>Arial</option><option>Helvetica</option><option>Georgia</option><option>Times New Roman</option>
                    </select>
                  </Field>
                  <Field label="Font weight">
                    <select value={editing.fontWeight} onChange={(e) => setEditing({...editing, fontWeight: +e.target.value as InvoiceTemplate['fontWeight']})}>
                      <option value="400">Regular</option><option value="500">Medium</option><option value="600">Semi-bold</option><option value="700">Bold</option>
                    </select>
                  </Field>
                  <Field label="Accent colour">
                    <input
                      type="color"
                      value={editing.accent}
                      onChange={(e) => setEditing({...editing, accent: e.target.value})}
                    />
                  </Field>
                  <Field label="Text colour"><input type="color" value={editing.textColor} onChange={(e) => setEditing({...editing, textColor: e.target.value})} /></Field>
                  <Field label="Grid line colour"><input type="color" value={editing.lineColor} onChange={(e) => setEditing({...editing, lineColor: e.target.value})} /></Field>
                  <Field label="Grid line width"><input type="number" min="0.3" max="2" step="0.1" value={editing.lineWidth} onChange={(e) => setEditing({...editing, lineWidth: +e.target.value})} /></Field>
                  <Field label="Title background"><input type="color" value={editing.titleBackground} onChange={(e) => setEditing({...editing, titleBackground: e.target.value})} /></Field>
                  <Field label="Title text colour"><input type="color" value={editing.titleColor} onChange={(e) => setEditing({...editing, titleColor: e.target.value})} /></Field>
                </div>
                <Card title="Paper and letterhead calibration" sub="Use preprinted mode when the company header or footer already exists on the paper.">
                  <div className="form-body calibration-grid">
                    <Field label="Header mode"><select value={editing.headerMode} onChange={(e) => setEditing({...editing, headerMode: e.target.value as InvoiceTemplate['headerMode']})}><option value="preprinted">Preprinted - reserve blank space</option><option value="digital">Print company header</option><option value="hidden">No header or reserve</option></select></Field>
                    <Field label="Footer mode"><select value={editing.footerMode} onChange={(e) => setEditing({...editing, footerMode: e.target.value as InvoiceTemplate['footerMode']})}><option value="preprinted">Preprinted - reserve blank space</option><option value="digital">Print contact footer</option><option value="hidden">No footer or reserve</option></select></Field>
                    <Field label="Page side margin (mm)"><input type="number" min="5" max="25" step="0.5" value={editing.pageMarginMm} onChange={(e) => setEditing({...editing, pageMarginMm: +e.target.value})} /></Field>
                    <Field label={editing.headerMode === 'preprinted' ? 'Preprinted header reserve (mm)' : 'Printed header height (mm)'}><input type="number" min="0" max="60" step="0.5" value={editing.topReserveMm} onChange={(e) => setEditing({...editing, topReserveMm: +e.target.value})} /></Field>
                    <Field label={editing.footerMode === 'preprinted' ? 'Preprinted footer reserve (mm)' : 'Printed footer height (mm)'}><input type="number" min="0" max="40" step="0.5" value={editing.bottomReserveMm} onChange={(e) => setEditing({...editing, bottomReserveMm: +e.target.value})} /></Field>
                    <Field label="Item area minimum height (mm)"><input type="number" min="60" max="160" step="1" value={editing.itemAreaMinHeightMm} onChange={(e) => setEditing({...editing, itemAreaMinHeightMm: +e.target.value})} /></Field>
                    {editing.footerMode === 'digital' && <p className="hint">The contact footer uses the phone numbers, email and business address from <Link href="/settings">Company settings → Business identity</Link>.</p>}
                  </div>
                </Card>
                <div className="check-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={editing.borders}
                      onChange={(e) => setEditing({...editing, borders: e.target.checked})}
                    />
                    Table borders
                  </label>
                </div>
                <Field label="Terms and conditions">
                  <textarea value={editing.terms} onChange={(e) => setEditing({...editing, terms: e.target.value})} placeholder="One condition per line. Existing invoices keep their saved template revision." />
                </Field>
              </div>
            </Card>
            <Card title="Show or hide fields">
              <div className="body-pad toggle-fields">
                {Object.entries(templateFields).map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <input
                      type="checkbox"
                      checked={editing.fields[key]}
                      onChange={(e) =>
                        setEditing({...editing, fields: {...editing.fields, [key]: e.target.checked}})
                      }
                    />
                  </label>
                ))}
              </div>
            </Card>
            <Card title="Item table columns" sub="Rename, reorder and choose columns.">
              <div className="body-pad column-editor">
                {editing.columns.map((col, i) => (
                  <div key={col.id}>
                    <input
                      aria-label={'Show ' + col.label}
                      type="checkbox"
                      checked={col.show}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          columns: editing.columns.map((x, n) => (n === i ? {...x, show: e.target.checked} : x)),
                        })
                      }
                    />
                    <input
                      aria-label={'Label for ' + col.id}
                      value={col.label}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          columns: editing.columns.map((x, n) => (n === i ? {...x, label: e.target.value} : x)),
                        })
                      }
                    />
                    <select
                      aria-label={'Align ' + col.label}
                      value={col.align}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          columns: editing.columns.map((x, n) =>
                            n === i ? {...x, align: e.target.value as 'left' | 'right' | 'center'} : x
                          ),
                        })
                      }
                    >
                      <option>left</option>
                      <option>right</option>
                      <option>center</option>
                    </select>
                    <input aria-label={'Width percentage for ' + col.label} title="Column width %" type="number" min="3" max="60" value={col.width || ''} placeholder="Width %" onChange={(e) => setEditing({...editing, columns: editing.columns.map((x, n) => n === i ? {...x, width: e.target.value ? +e.target.value : undefined} : x)})} />
                    {[-1, 1].map((dir) => (
                      <button
                        key={dir}
                        className="icon-btn"
                        disabled={i + dir < 0 || i + dir >= editing.columns.length}
                        aria-label={`${dir === -1 ? 'Move up' : 'Move down'} ${col.label}`}
                        onClick={() => {
                          const columns = [...editing.columns];
                          [columns[i], columns[i + dir]] = [columns[i + dir], columns[i]];
                          setEditing({...editing, columns});
                        }}
                      >
                        {dir === -1 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <div className="template-live-preview">
            <div className="toolbar">
              <strong>Invoice preview</strong>
              <select
                aria-label="Preview document"
                value={sampleId}
                onChange={(e) => setSampleId(e.target.value)}
              >
                {state.bills.length === 0 && <option value="">Preview-only sample invoice</option>}
                {state.bills.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id}
                  </option>
                ))}
              </select>
            </div>
            {state.bills.length === 0 && (
              <div className="template-preview-note">Preview only · no invoice or customer record will be saved</div>
            )}
            <TemplateInvoice bill={{...sample, shopSnapshot: state.settings}} template={editing} />
          </div>
        </div>
      ) : state.templates.length === 0 ? (
        <Card title="Invoice templates">
          <div style={{textAlign: 'center', padding: '3rem 1.5rem'}}>
            <FileText size={48} style={{margin: '0 auto 1rem', color: '#9ca3af'}} />
            <h3 style={{fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem'}}>No invoice templates saved yet</h3>
            <p className="muted" style={{marginBottom: '1.5rem', maxWidth: '420px', marginInline: 'auto'}}>
              Create your company&apos;s first invoice layout to start issuing invoices with custom columns, header fields and branding.
            </p>
            <Btn onClick={handleNewTemplate}>
              <Plus size={16} />
              Create first template
            </Btn>
          </div>
        </Card>
      ) : (
        <div className="grid-3">
          {state.templates.map((t) => (
            <Card
              key={t.id}
              title={t.name}
              actions={state.defaultTemplateId === t.id ? <Badge>Default</Badge> : undefined}
            >
              <div className="template-thumbnail">
                <FileText size={45} style={{color: t.accent}} />
                <strong>{t.name}</strong>
                <span>
                  {t.paper} · {t.orientation} · {t.columns.filter((c) => c.show).length} columns
                </span>
                <Badge>{isNonGstTemplate(t) ? 'Non-GST' : 'GST / General'}</Badge>
              </div>
              <div className="body-pad actions">
                <Btn
                  secondary
                  onClick={() => {
                    setIsNew(false);
                    setEditing(structuredClone(t));
                  }}
                >
                  <Pencil size={15} />
                  Edit / rename
                </Btn>
                <Btn secondary onClick={() => handleCopyTemplate(t)}>
                  <Copy size={15} />
                  Make copy
                </Btn>
                {state.defaultTemplateId !== t.id && (
                  <button
                    className="link-button"
                    onClick={async () => {
                      if (isLive) {
                        await setDefaultTemplateApi(t.id);
                      } else {
                        setState((s) => ({...s, defaultTemplateId: t.id}));
                        notify('Default print template updated.');
                      }
                    }}
                  >
                    Use as default
                  </button>
                )}
                {state.defaultTemplateId !== t.id && state.templates.length > 1 && (
                  <button
                    className="link-button muted"
                    onClick={async () => {
                      if (confirm(`Archive template "${t.name}"?`)) {
                        if (isLive) {
                          await archiveTemplateApi(t.id);
                        } else {
                          setState((s) => ({...s, templates: s.templates.filter((x) => x.id !== t.id)}));
                          notify('Template archived.');
                        }
                      }
                    }}
                  >
                    Archive
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      {print && sample && <PrintDialog bills={[sample]} onClose={() => setPrint(false)} />}
    </>
  );
}
