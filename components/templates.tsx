'use client';
import {amountWords} from '@/lib/amount-words';
import {useRef, useState} from 'react';
import Link from 'next/link';
import {Copy, Pencil, Printer, ArrowUp, ArrowDown, Check, FileText, Plus} from 'lucide-react';
import {InvoiceTemplate, templateFields, extensionSeed} from '@/lib/extensions';
import {Bill, uid, money, totals, lineTotal, dateLabel, paid, balance} from '@/lib/domain';
import {useStore} from './store';
import {PageHead, Card, Btn, Modal, Field, Badge} from './ui';

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
  const t =
    template ||
    (!templateId ? (bill as Bill & {templateSnapshot?: InvoiceTemplate}).templateSnapshot : undefined) ||
    state.templates.find((t) => t.id === (templateId || bill.templateId || state.defaultTemplateId)) ||
    state.templates[0];
  if (!t) return <div className="notice">Select a saved invoice template to preview this document.</div>;
  const f = t.fields;
  const s = bill.shopSnapshot || state.settings;
  const c = supplier || bill.customerSnapshot || state.customers.find((c) => c.id === bill.customerId);
  const billTo = supplier ? undefined : bill.billTo || c;
  const deliveryTo = bill.shipTo || billTo;
  const interstate = bill.taxMode === 'Inter-state';
  const sum = totals(bill),
    cols = (t.columns || []).filter((c: any) => c.show);
  const details = 'details' in (c || {}) ? (c as {details?: Record<string, string>}).details : undefined;
  const hsn = Object.values(
    bill.lines.reduce<
      Record<string, {code: string; base: number; tax: number; rate: number; cgst: number; sgst: number; igst: number; treatment?: string}>
    >((a, l) => {
      const treatment = l.taxTreatment || 'Taxable';
      const k = treatment + '-' + l.hsn + '-' + l.tax;
      const x = lineTotal(l, bill.inclusive, bill.taxMode);
      a[k] ??= {code: l.hsn, base: 0, tax: 0, rate: (treatment === 'Exempt' || treatment === 'NonGST') ? 0 : l.tax, cgst: 0, sgst: 0, igst: 0, treatment};
      a[k].base += x.base;
      a[k].tax += x.tax;
      a[k].cgst += x.cgst;
      a[k].sgst += x.sgst;
      a[k].igst += x.igst;
      return a;
    }, {})
  );

  return (
    <div className="print-area">
      <article
        className={`invoice-paper template-paper ${t.borders ? '' : 'no-borders'} ${t.striped ? 'striped' : ''} ${
          t.orientation
        }`}
        style={{'--invoice-accent': t.accent, '--invoice-font': t.fontSize + 'px'} as React.CSSProperties}
      >
        <div className="invoice-top">
          <h2>
            {supplier
              ? 'Purchase record'
              : t.title ||
                (bill.kind === 'Quotation'
                  ? 'Quotation'
                  : bill.kind === 'Service'
                  ? 'Service Invoice'
                  : sum.tax > 0
                  ? 'Tax Invoice'
                  : 'Sales Invoice')}
          </h2>
          <span>ORIGINAL FOR RECIPIENT</span>
        </div>
        <div className="invoice-box">
          <div className="invoice-parties">
            <div>
              <div
                className="invoice-shop"
                style={{
                  justifyContent:
                    t.logoPosition === 'center' ? 'center' : t.logoPosition === 'right' ? 'flex-end' : 'flex-start',
                }}
              >
                {f.logo && s.logo && <img src={s.logo} alt="Shop logo" />}
                {f.shopName && <strong>{s.name.toUpperCase()}</strong>}
              </div>
              {f.shopAddress && <p>{s.address}</p>}
              {f.shopGst && <p>GSTIN/UIN: {s.gst}</p>}
              {(s.state || s.stateCode || s.postalCode) && (
                <p>State: {s.state || '—'}{s.stateCode ? `, Code: ${s.stateCode}` : ''}{s.postalCode ? ` · PIN: ${s.postalCode}` : ''}</p>
              )}
              {f.shopPhone && <p>Contact: {s.phone}</p>}
              {f.shopEmail && <p>Email: {s.email}</p>}
            </div>
            <div className="invoice-meta">
              {Object.entries({
                number: ['Document No.', bill.id],
                date: ['Date', dateLabel(bill.date)],
                due: [bill.kind === 'Quotation' ? 'Valid until' : 'Due date', dateLabel(bill.due)],
                reference: ['Reference', bill.jobId || bill.sourceId || '—'],
                order: ['Buyer order no.', bill.orderRef || '—'],
                delivery: ['Delivery note', bill.deliveryNote || '—'],
                dispatch: ['Dispatched through', bill.dispatch || '—'],
                destination: ['Place of supply', bill.placeOfSupply || 'Tamil Nadu'],
              })
                .filter(([k]) => f[k])
                .map(([k, [label, value]]) => (
                  <div key={k}>
                    <small>{label}</small>
                    <b>{value}</b>
                  </div>
                ))}
            </div>
          </div>
          <div className="invoice-buyer">
            <small>{supplier ? 'Supplier' : 'Buyer (Bill to)'}</small>
            {f.customerName && <strong>{billTo?.name || 'Customer not selected'}</strong>}
            {f.customerAddress && <p>{billTo?.address}</p>}
            {f.customerPhone && <p>{billTo?.phone}</p>}
            {f.customerGst && <p>GSTIN/UIN: {c?.gst || 'Not provided'}</p>}
            {billTo && (billTo as any).state && <p>{(billTo as any).state}{(billTo as any).stateCode ? `, Code: ${(billTo as any).stateCode}` : ''}{(billTo as any).postalCode ? ` · PIN: ${(billTo as any).postalCode}` : ''}</p>}
            {f.shipping && (
              <div className="invoice-shipto">
                <strong>Ship to (Deliver to)</strong>
                <p>{bill.shipTo?.name || billTo?.name}</p>
                <p>{bill.shipTo?.address || billTo?.address}</p>
                <p>{bill.shipTo?.phone || billTo?.phone}</p>
                {deliveryTo && (
                  <p>
                    {(deliveryTo as any).state || ''} {(deliveryTo as any).postalCode || ''}
                  </p>
                )}
              </div>
            )}
          </div>
          <table className="invoice-items">
            <thead>
              <tr>
                {(cols as any[]).map((col: any) => (
                  <th key={col.id} style={{textAlign: col.align}}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((l, i) => {
                const calc = lineTotal(l, bill.inclusive, bill.taxMode);
                const p = state.products.find((p) => p.id === l.productId);
                const cells: Record<string, React.ReactNode> = {
                  index: i + 1,
                  description: (
                    <>
                      <b>{l.name}</b>
                      {l.details && <small>{l.details}</small>}
                      {l.printSpecifications && Object.entries(l.printSpecifications).filter(([,value])=>value).length > 0 && (
                        <small>{Object.entries(l.printSpecifications).filter(([,value])=>value).map(([key,value])=>`${key.replace(/([A-Z])/g,' $1')}: ${value}`).join(' · ')}</small>
                      )}
                      {f.model && p && <small>{p.model}</small>}
                      {f.serials && l.serials.map((n) => <small key={n}>S/N: {n}</small>)}
                      {f.warranty && l.warranty > 0 && <small>Warranty: {l.warranty} month(s)</small>}
                    </>
                  ),
                  hsn: l.hsn,
                  tax: l.taxTreatment === 'Exempt' ? 'Exempt' : l.taxTreatment === 'NonGST' ? 'Non-GST' : l.tax + '%',
                  qty: l.qty + ' ' + (l.unit || 'Piece'),
                  rateIncl: money(bill.inclusive ? l.rate : l.rate * (1 + l.tax / 100)),
                  rateExcl: money(bill.inclusive ? l.rate / (1 + l.tax / 100) : l.rate),
                  discount: l.discountType === 'Amount' ? money(l.discount) : l.discount + '%',
                  warranty: l.warranty ? l.warranty + ' months' : '—',
                  amount: money(calc.base),
                };
                return (
                  <tr key={i}>
                    {(cols as any[]).map((col: any) => (
                      <td key={col.id} style={{textAlign: col.align}}>
                        {cells[col.id]}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {f.subtotal && (
                <tr className="invoice-tax-row">
                  <td colSpan={Math.max(1, cols.length - 1)}>Taxable value</td>
                  {cols.length > 1 && <td>{money(sum.base)}</td>}
                </tr>
              )}
              {f.taxes &&
                (interstate ? (
                  <tr>
                    <td colSpan={Math.max(1, cols.length - 1)}>IGST Output</td>
                    {cols.length > 1 && <td>{money(sum.igst)}</td>}
                  </tr>
                ) : (
                  <>
                    <tr>
                      <td colSpan={Math.max(1, cols.length - 1)}>CGST Output</td>
                      {cols.length > 1 && <td>{money(sum.cgst)}</td>}
                    </tr>
                    <tr>
                      <td colSpan={Math.max(1, cols.length - 1)}>SGST Output</td>
                      {cols.length > 1 && <td>{money(sum.sgst)}</td>}
                    </tr>
                  </>
                ))}
              {f.grandTotal && (
                <tr className="invoice-total">
                  <td colSpan={Math.max(1, cols.length - 1)}>
                    Total · {bill.lines.filter((l) => l.lineType !== 'Charge').reduce((a, l) => a + l.qty, 0)} Nos
                  </td>
                  {cols.length > 1 && <td>{money(sum.total)}</td>}
                </tr>
              )}
            </tbody>
          </table>
          {f.amountWords && (
            <div className="invoice-words">
              <small>Amount chargeable in words</small>
              <strong>INR {amountWords(sum.total)}</strong>
            </div>
          )}
          {f.payments && bill.kind !== 'Quotation' && !supplier && (
            <div className="invoice-payment">
              <span>Amount received: {money(bill.previewPaid ?? bill.paid ?? paid(state, bill.id))}</span>
              <b>
                Invoice balance: {money(bill.previewPaid !== undefined ? Math.max(0, sum.total - bill.previewPaid) : bill.dueAmount ?? balance(state, bill))}
              </b>
            </div>
          )}
          {f.taxSummary && (
            <table className="invoice-tax-table">
              <thead>
                <tr>
                  <th>HSN / SAC</th>
                  <th>Taxable value</th>
                  {interstate ? (
                    <>
                      <th>IGST rate</th>
                      <th>IGST amount</th>
                    </>
                  ) : (
                    <>
                      <th>CGST rate</th>
                      <th>Amount</th>
                      <th>SGST rate</th>
                      <th>Amount</th>
                    </>
                  )}
                  <th>Total tax</th>
                </tr>
              </thead>
              <tbody>
                {hsn.map((x, i) => (
                  <tr key={i}>
                    <td>{x.code}</td>
                    <td>{money(x.base)}</td>
                    {interstate ? (
                      <>
                        <td>{x.rate}%</td>
                        <td>{money(x.igst)}</td>
                      </>
                    ) : (
                      <>
                        <td>{x.rate / 2}%</td>
                        <td>{money(x.cgst)}</td>
                        <td>{x.rate / 2}%</td>
                        <td>{money(x.sgst)}</td>
                      </>
                    )}
                    <td>{money(x.tax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="invoice-bottom">
            <div>
              {f.declaration && (
                <>
                  <strong>Declaration</strong>
                  <p>{s.declaration}</p>
                </>
              )}
              {f.notes && bill.notes && (
                <>
                  <strong>Notes and terms</strong>
                  <p>{bill.notes}</p>
                </>
              )}
            </div>
            {f.bank && (
              <div>
                <strong>Company’s bank details</strong>
                <p>A/c holder: {s.name}</p>
                <p>Bank: {s.bank}</p>
                <p>A/c: {s.account}</p>
                <p>Branch & IFSC: {s.ifsc}</p>
              </div>
            )}
          </div>
          {f.signatures && (
            <div className="invoice-sign">
              <span>Customer’s seal and signature</span>
              <div>
                For {s.name}
                <br />
                <br />
                Authorised signatory
              </div>
            </div>
          )}
        </div>
        {f.footer && <p className="invoice-foot">{t.footer}</p>}
        {!isLive && <p className="invoice-foot">DEMO — not a valid tax invoice</p>}
      </article>
    </div>
  );
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
        const element = wrapper?.querySelector<HTMLElement>('.invoice-paper');
        if (!element) throw new Error(`Preview for ${bill.id} is not ready. Wait for it to appear and try again.`);
        const billTemplate = userOverrode ? template : ((bill as any).templateSnapshot || state.templates.find((t) => t.id === (bill.templateId || state.defaultTemplateId)) || template);
        return {name: bill.id, element, template: billTemplate};
      });
      const firstTemplate = entries[0]?.template || template;
      e.downloadBytes(
        bills.length === 1 ? bills[0].id + '.pdf' : 'invoices.zip',
        bills.length === 1
          ? await e.invoicePreviewPdfBytes(entries[0].element, firstTemplate)
          : await e.invoicePreviewZipBytes(entries),
        bills.length === 1 ? 'application/pdf' : 'application/zip'
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Download failed.');
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
            style.textContent = `@media print { @page { size: ${template.paper} ${template.orientation}; margin: 12mm; } }`;
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
    updateLogoApi,
    saveTemplateApi,
    setDefaultTemplateApi,
    archiveTemplateApi,
  } = useStore();

  const [editing, setEditing] = useState<InvoiceTemplate | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [sampleId, setSampleId] = useState(state.bills[0]?.id || '');
  const [print, setPrint] = useState(false);
  const [saving, setSaving] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);

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
                <Field label="Company logo (shared by new invoices)">
                  <input
                    type="file"
                    accept="image/*"
                    disabled={logoBusy || saving}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setLogoBusy(true);
                      await updateLogoApi(file);
                      setLogoBusy(false);
                      e.target.value = '';
                    }}
                  />
                </Field>
                {logoBusy && <p className="muted" style={{fontSize: '0.85rem'}}>Saving logo to company settings…</p>}
                {state.settings.logo && (
                  <>
                    <img
                      src={state.settings.logo}
                      alt="Company logo"
                      style={{maxWidth: 120, maxHeight: 80, objectFit: 'contain'}}
                    />
                    <Btn
                      secondary
                      disabled={logoBusy || saving}
                      onClick={async () => {
                        setLogoBusy(true);
                        await updateLogoApi(null);
                        setLogoBusy(false);
                      }}
                    >
                      Remove logo
                    </Btn>
                  </>
                )}
                <p className="muted">
                  Logo position and visibility are set below. Issued invoices retain their original company details.
                </p>
                <Field label="Template name">
                  <input value={editing.name} onChange={(e) => setEditing({...editing, name: e.target.value})} />
                </Field>
                <Field
                  label="Printed title override"
                  hint="Leave blank to use Tax Invoice, Sales Invoice, Service Invoice or Quotation."
                >
                  <input value={editing.title} onChange={(e) => setEditing({...editing, title: e.target.value})} />
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
                  <Field label="Accent colour">
                    <input
                      type="color"
                      value={editing.accent}
                      onChange={(e) => setEditing({...editing, accent: e.target.value})}
                    />
                  </Field>
                </div>
                <Field label="Logo position">
                  <select
                    value={editing.logoPosition}
                    onChange={(e) =>
                      setEditing({...editing, logoPosition: e.target.value as InvoiceTemplate['logoPosition']})
                    }
                  >
                    <option>left</option>
                    <option>center</option>
                    <option>right</option>
                  </select>
                </Field>
                <div className="check-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={editing.borders}
                      onChange={(e) => setEditing({...editing, borders: e.target.checked})}
                    />
                    Table borders
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={editing.striped}
                      onChange={(e) => setEditing({...editing, striped: e.target.checked})}
                    />
                    Alternate row shading
                  </label>
                </div>
                <Field label="Footer">
                  <textarea
                    value={editing.footer}
                    onChange={(e) => setEditing({...editing, footer: e.target.value})}
                  />
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
              <strong>Live preview</strong>
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
