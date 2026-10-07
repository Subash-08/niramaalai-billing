'use client';

import {useState} from 'react';
import Link from 'next/link';
import {useStore} from './store';
import {PageHead, Card, Field, Btn} from './ui';

type SequenceMode = 'continue' | 'set-next';

function invoicePreview(prefix: string, start: number, padding: number, separator: string, includeYear: boolean) {
  return [prefix || 'INV', ...(includeYear ? ['2026-2027'] : []), String(start || 1).padStart(padding, '0')].join(separator);
}

export default function Settings(){
  const {state, saveSettingsApi} = useStore();
  const [form, setForm] = useState({...state.settings});
  const [saving, setSaving] = useState(false);
  const [gstSequenceMode, setGstSequenceMode] = useState<SequenceMode>('continue');
  const [nonGstSequenceMode, setNonGstSequenceMode] = useState<SequenceMode>('continue');
  const set = (key: string, value: unknown) => setForm(current => ({...current, [key]: value}));

  async function save(){
    setSaving(true);
    await saveSettingsApi(form);
    setSaving(false);
  }

  const separator = form.invoiceNumberSeparator ?? '-';
  const padding = form.invoiceNumberPadding ?? 4;
  const includeYear = form.invoiceIncludeFinancialYear !== false;
  const gstPreview = invoicePreview(form.gstInvoicePrefix || form.invoicePrefix || 'INV', form.gstInvoiceStartNumber || form.invoiceStartNumber || 1, padding, separator, includeYear);
  const nonGstPreview = invoicePreview(form.nonGstInvoicePrefix || 'NGST', form.nonGstInvoiceStartNumber || 1, padding, separator, includeYear);
  const sharedNumbering = form.invoiceNumberingMode === 'shared';

  return <>
    <PageHead title="Company settings" description="These details appear throughout the workspace and on issued invoices. Until setup is complete, the application displays Billing Software." actions={<Link className="btn secondary" href="/templates">Invoice templates</Link>}/>

    <Card title="Business identity">
      <div className="form-body form-grid">
        <Field label="Company / business name"><input required value={form.name} onChange={e => set('name', e.target.value)} placeholder="Your registered or trading name"/></Field>
        <Field label="Invoice header second line"><input value={form.invoiceHeaderSubtitle || ''} onChange={e => set('invoiceHeaderSubtitle', e.target.value)} placeholder="For example: ACCHU KALAIKOODAM"/></Field>
        <Field label="Primary phone"><input required value={form.phone} onChange={e => set('phone', e.target.value)}/></Field>
        <Field label="Alternate phone"><input value={form.alternatePhone || ''} onChange={e => set('alternatePhone', e.target.value)} placeholder="Optional second number"/></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={e => set('email', e.target.value)}/></Field>
        <Field label="GSTIN"><input value={form.gst} onChange={e => set('gst', e.target.value.toUpperCase())} placeholder="Enter later if applicable"/></Field>
        <div className="full"><Field label="Business address"><textarea required value={form.address} onChange={e => set('address', e.target.value)}/></Field></div>
        <Field label="State"><input value={form.state || ''} onChange={e => set('state', e.target.value)} placeholder="Tamil Nadu"/></Field>
        <Field label="State code"><input value={form.stateCode || ''} onChange={e => set('stateCode', e.target.value)} maxLength={2}/></Field>
        <Field label="PIN code"><input value={form.postalCode || ''} onChange={e => set('postalCode', e.target.value)} maxLength={6}/></Field>
      </div>
    </Card>

    <Card title="Invoice numbering">
      <div className="form-body form-grid">
        <Field label="Numbering mode"><select value={sharedNumbering ? 'shared' : 'separate'} onChange={e => set('invoiceNumberingMode', e.target.value as 'shared' | 'separate')}><option value="separate">Separate GST and Non-GST sequences</option><option value="shared">One shared sequence for both</option></select></Field>
        {sharedNumbering ? <>
          <Field label="Invoice number field name"><input value={form.invoiceNumberLabel || 'Invoice No'} onChange={e => set('invoiceNumberLabel', e.target.value)} placeholder="Invoice No"/></Field>
          <Field label="Shared invoice prefix"><input value={form.invoicePrefix || 'INV'} onChange={e => {const value = e.target.value.toUpperCase(); set('invoicePrefix', value); set('gstInvoicePrefix', value); set('nonGstInvoicePrefix', value);}} placeholder="INV"/></Field>
          <Field label="Sequence"><select value={gstSequenceMode} onChange={e => setGstSequenceMode(e.target.value as SequenceMode)}><option value="continue">Continue existing numbers</option><option value="set-next">Start from a new number</option></select></Field>
          <Field label="Next number"><input type="number" min="1" max="999999999" step="1" disabled={gstSequenceMode === 'continue'} value={form.gstInvoiceStartNumber || form.invoiceStartNumber || 1} onChange={e => set('gstInvoiceStartNumber', Number(e.target.value))}/></Field>
        </> : <>
          <Field label="GST invoice number field name"><input value={form.gstInvoiceNumberLabel || form.invoiceNumberLabel || 'GST Invoice No'} onChange={e => set('gstInvoiceNumberLabel', e.target.value)} placeholder="GST Invoice No"/></Field>
          <Field label="GST invoice prefix"><input value={form.gstInvoicePrefix || form.invoicePrefix || 'INV'} onChange={e => set('gstInvoicePrefix', e.target.value.toUpperCase())} placeholder="INV"/></Field>
          <Field label="GST sequence"><select value={gstSequenceMode} onChange={e => setGstSequenceMode(e.target.value as SequenceMode)}><option value="continue">Continue existing GST numbers</option><option value="set-next">Start GST from a new number</option></select></Field>
          <Field label="Next GST number"><input type="number" min="1" max="999999999" step="1" disabled={gstSequenceMode === 'continue'} value={form.gstInvoiceStartNumber || form.invoiceStartNumber || 1} onChange={e => set('gstInvoiceStartNumber', Number(e.target.value))}/></Field>
          <Field label="Non-GST invoice number field name"><input value={form.nonGstInvoiceNumberLabel || 'Non-GST Invoice No'} onChange={e => set('nonGstInvoiceNumberLabel', e.target.value)} placeholder="Non-GST Invoice No"/></Field>
          <Field label="Non-GST invoice prefix"><input value={form.nonGstInvoicePrefix || 'NGST'} onChange={e => set('nonGstInvoicePrefix', e.target.value.toUpperCase())} placeholder="NGST"/></Field>
          <Field label="Non-GST sequence"><select value={nonGstSequenceMode} onChange={e => setNonGstSequenceMode(e.target.value as SequenceMode)}><option value="continue">Continue existing Non-GST numbers</option><option value="set-next">Start Non-GST from a new number</option></select></Field>
          <Field label="Next Non-GST number"><input type="number" min="1" max="999999999" step="1" disabled={nonGstSequenceMode === 'continue'} value={form.nonGstInvoiceStartNumber || 1} onChange={e => set('nonGstInvoiceStartNumber', Number(e.target.value))}/></Field>
        </>}

        <Field label="Number padding"><select value={padding} onChange={e => set('invoiceNumberPadding', Number(e.target.value))}>{[0,1,2,3,4,5,6,7,8,9].map(value => <option key={value} value={value}>{value === 0 ? 'None' : `${value} digits`}</option>)}</select></Field>
        <Field label="Separator"><select value={separator} onChange={e => set('invoiceNumberSeparator', e.target.value)}><option value="-">Hyphen (-)</option><option value="/">Slash (/)</option><option value="_">Underscore (_)</option><option value="">None</option></select></Field>
        <label className="check full"><input type="checkbox" checked={includeYear} onChange={e => set('invoiceIncludeFinancialYear', e.target.checked)}/> Include financial year in invoice numbers</label>
        <p className="hint full">{sharedNumbering ? <>Preview: <b>{invoicePreview(form.invoicePrefix || 'INV', form.gstInvoiceStartNumber || 1, padding, separator, includeYear)}</b>. Both GST and Non-GST invoices use the same counter, so the next invoice always receives the next number.</> : <>GST preview: <b>{gstPreview}</b>. Non-GST preview: <b>{nonGstPreview}</b>. “Continue existing numbers” keeps the current counter. “Start from a new number” can only move it forward; issued numbers are never reused.</>}</p>
      </div>
    </Card>

    <Card title="Invoice payment details">
      <div className="form-body form-grid">
        <Field label="Bank name"><input value={form.bank} onChange={e => set('bank', e.target.value)}/></Field>
        <Field label="Bank branch"><input value={form.bankBranch || ''} onChange={e => set('bankBranch', e.target.value)}/></Field>
        <Field label="Account number"><input value={form.account} onChange={e => set('account', e.target.value)}/></Field>
        <Field label="IFSC"><input value={form.ifsc} onChange={e => set('ifsc', e.target.value.toUpperCase())}/></Field>
        <div className="full"><Field label="Invoice declaration / default terms"><textarea value={form.declaration} onChange={e => set('declaration', e.target.value)}/></Field></div>
      </div>
    </Card>

    <div className="form-actions"><Btn disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save company settings'}</Btn></div>
  </>;
}
