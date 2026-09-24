'use client';
import AccountHistory from './account-history';
import {useState, useEffect} from 'react';
import Link from 'next/link';
import {Plus, ArrowUpRight, Pencil, Phone, Mail, FileText, ArrowLeft, Archive, MessageSquare, Copy, Check, ExternalLink, IndianRupee} from 'lucide-react';
import {RecordReceiptModal} from './payments';
import {useStore} from './store';
import {Customer, Supplier, uid, money, roundedTotal, balance, dateLabel} from '@/lib/domain';
import {PageHead, Card, SearchBox, Btn, Modal, Field, Empty, Badge} from './ui';
import {mapCustomerFromApi, mapSupplierFromApi} from '@/lib/mappers';

export function PersonForm({
  supplier = false,
  existing,
  onClose,
  onSuccess,
}: {
  supplier?: boolean;
  existing?: Customer | Supplier;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const {
    state,
    isLive,
    saveCustomerApi,
    archiveCustomerApi,
    restoreCustomerApi,
    saveSupplierApi,
    archiveSupplierApi,
    restoreSupplierApi,
  } = useStore();

  const [form, setForm] = useState({
    name: existing?.name || '',
    phone: existing?.phone || '',
    email: existing?.email || '',
    address: existing?.address || '',
    gst: existing?.gst || '',
    type: (existing as Customer)?.type || 'Individual',
    notes: (existing as Customer)?.notes || '',
    terms: (existing as Supplier)?.terms || 30,
  });

  const [details, setDetails] = useState<Record<string, string>>(
    (existing as Customer)?.details || {
      state: 'Tamil Nadu',
      city: 'Salem',
      country: 'India',
      paymentTerms: '0',
      language: 'Tamil',
    }
  );

  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k: string, v: string | number) => {
    setForm((f) => ({...f, [k]: v}));
    if (k === 'phone') {
      const raw = String(v).replace(/\D/g, '');
      const last10 = raw.slice(-10);
      const collection = supplier ? state.suppliers : state.customers;
      if (last10 && collection.some((c) => (c.phone || '').replace(/\D/g, '').slice(-10) === last10 && c.id !== existing?.id)) {
        setWarning('Notice: This phone number is already shared with another contact.');
      } else {
        setWarning('');
      }
    }
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supplier && (!/^[+()0-9 .-]+$/.test(form.phone.trim()) ||
        form.phone.replace(/\D/g, '').length < 10 || form.phone.replace(/\D/g, '').length > 15)) {
      setError('Enter the customer phone number (10 to 15 digits).');
      return;
    }
    setBusy(true);
    setError('');

    try {
      if (supplier) {
        const res = await saveSupplierApi({...form}, existing?.id);
        if (res.warning) setWarning(res.warning);
        if (res.success) {
          onSuccess?.();
          onClose();
        }
      } else {
        const res = await saveCustomerApi({...form, details}, existing?.id);
        if (res.warning) setWarning(res.warning);
        if (res.success) {
          onSuccess?.();
          onClose();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive() {
    if (!existing?.id) return;
    setBusy(true);
    try {
      const ok = supplier
        ? await archiveSupplierApi(existing.id)
        : await archiveCustomerApi(existing.id);
      if (ok) {
        onSuccess?.();
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${existing ? 'Edit' : 'Add'} ${supplier ? 'supplier' : 'customer'}`} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="form-body">
          <div className="form-grid">
            <Field label={supplier ? 'Supplier name' : 'Customer name'}>
              <input required value={form.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Phone number">
              <input
                type="tel"
                required={!supplier}
                maxLength={30}
                autoComplete="tel"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                placeholder={supplier ? 'Optional contact number' : 'Customer phone number (required)'}
              />
            </Field>
            <Field label="Email (optional)">
              <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
            </Field>
            {supplier ? (
              <Field label="Credit period in days">
                <input
                  type="number"
                  min="0"
                  required
                  value={form.terms}
                  onChange={(e) => set('terms', +e.target.value)}
                />
              </Field>
            ) : (
              <Field label="Customer type">
                <select value={form.type} onChange={(e) => set('type', e.target.value)}>
                  <option>Individual</option>
                  <option>Business</option>
                </select>
              </Field>
            )}
            <Field label="GSTIN (optional)">
              <input
                maxLength={15}
                pattern="[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]"
                value={form.gst}
                onChange={(e) => set('gst', e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Address">
              <textarea value={form.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
            {!supplier && (
              <div className="full">
                <Field label="Notes">
                  <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} />
                </Field>
              </div>
            )}
          </div>

          <details className="optional-fields spaced">
            <summary>More contact, billing and delivery details</summary>
            <div className="form-grid spaced">
              {Object.entries({
                contactPerson: 'Contact person',
                alternatePhone: 'Alternate phone',
                city: 'City',
                state: 'State / territory',
                postalCode: 'PIN code',
                country: 'Country',
                shippingAddress: 'Delivery address (blank = billing address)',
                paymentTerms: 'Default payment period (days)',
                creditLimit: 'Credit limit (₹, blank = no limit)',
                language: 'Preferred language',
                reference: 'Customer reference / referral',
              }).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    type={['paymentTerms', 'creditLimit'].includes(key) ? 'number' : 'text'}
                    min="0"
                    value={details[key] || ''}
                    onChange={(e) => setDetails({...details, [key]: e.target.value})}
                  />
                </Field>
              ))}
            </div>
          </details>

          {warning && (
            <p className="notice" style={{marginTop: 12, backgroundColor: '#fef3c7', color: '#92400e'}}>
              {warning}
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        <div className="form-actions">
          {existing && isLive && (existing as any).status === 'Archived' ? (
            <Btn
              secondary
              onClick={async () => {
                setBusy(true);
                try {
                  const ok = supplier
                    ? await restoreSupplierApi(existing.id)
                    : await restoreCustomerApi(existing.id);
                  if (ok) {
                    onSuccess?.();
                    onClose();
                  }
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
            >
              Restore to active
            </Btn>
          ) : existing ? (
            <Btn secondary danger onClick={handleArchive} disabled={busy}>
              <Archive size={15} /> Archive
            </Btn>
          ) : null}
          <Btn secondary onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" disabled={busy}>
            {busy ? 'Saving…' : `Save ${supplier ? 'supplier' : 'customer'}`}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}


export function PaymentReminderModal({
  customer,
  invoices,
  totalDue,
  onClose,
}: {
  customer: Customer;
  invoices: any[];
  totalDue: number;
  onClose: () => void;
}) {
  const {state, notify} = useStore();
  const [copied, setCopied] = useState(false);
  const [phone, setPhone] = useState(customer.phone || '');

  // Filter unpaid invoices
  const unpaidInvoices = invoices.filter((inv) => {
    const due = inv.dueAmount !== undefined ? inv.dueAmount : (inv.duePaise ? inv.duePaise / 100 : 0);
    return due > 0;
  });

  const companyName = state.settings?.name?.trim() || 'Our Company';
  const companyPhone = state.settings?.phone?.trim() || '';

  const bankDetails = [
    state.settings?.bank ? `Bank: ${state.settings.bank}` : '',
    state.settings?.account ? `Account No: ${state.settings.account}` : '',
    state.settings?.ifsc ? `IFSC: ${state.settings.ifsc}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const unpaidLines = unpaidInvoices.length > 0
    ? unpaidInvoices
        .map((inv) => {
          const invNum = inv.invoiceNumber || inv.id;
          const invDue = inv.dueAmount !== undefined ? inv.dueAmount : (inv.duePaise ? inv.duePaise / 100 : 0);
          const invDate = inv.date || inv.invoiceDate || '';
          return `• Invoice #${invNum} (Dated: ${invDate}): Due ₹${invDue.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        })
        .join('\n')
    : `• Total balance due across account: ₹${totalDue.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;

  const initialMessage = `Dear ${customer.name},

Greetings from ${companyName}.

This is a gentle payment reminder regarding your outstanding balance with us.

Total Outstanding Due: ₹${totalDue.toLocaleString('en-IN', {minimumFractionDigits: 2})}

Pending Invoices:
${unpaidLines}
${bankDetails ? `\nPayment Details:\n${bankDetails}\n` : ''}
Kindly arrange for the settlement at your earliest convenience. If you have already made this payment, please disregard this reminder.

Thank you for your business!
${companyName}${companyPhone ? `\nPhone: ${companyPhone}` : ''}`;

  const [message, setMessage] = useState(initialMessage);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      notify('Reminder text copied to clipboard!');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      notify('Failed to copy to clipboard.');
    }
  };

  const handleOpenWhatsApp = () => {
    const rawDigits = phone.replace(/\D/g, '');
    if (!rawDigits || rawDigits.length < 10) {
      notify('Please enter a valid 10+ digit customer phone number for WhatsApp.');
      return;
    }
    const targetPhone = rawDigits.length === 10 ? '91' + rawDigits : rawDigits;
    const url = `https://wa.me/${targetPhone}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Modal title="Payment Reminder" onClose={onClose}>
      <div className="form-body stack" style={{gap: '1rem'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-sunken, #f8fafc)', padding: '0.75rem 1rem', borderRadius: 8}}>
          <div>
            <div style={{fontWeight: 600, fontSize: '1rem'}}>{customer.name}</div>
            <div style={{fontSize: '0.85rem', color: 'var(--text-muted, #64748b)'}}>
              {unpaidInvoices.length} unpaid {unpaidInvoices.length === 1 ? 'invoice' : 'invoices'}
            </div>
          </div>
          <div style={{textAlign: 'right'}}>
            <div style={{fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-muted, #64748b)'}}>Total Outstanding</div>
            <div style={{fontSize: '1.25rem', fontWeight: 700, color: totalDue > 0 ? '#b91c1c' : '#15803d'}}>
              ₹{totalDue.toLocaleString('en-IN', {minimumFractionDigits: 2})}
            </div>
          </div>
        </div>

        <Field label="Customer Phone for WhatsApp">
          <input
            type="tel"
            placeholder="e.g. 9876543210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>

        <Field label="Configurable Reminder Message" hint="You can edit this message before copying or opening WhatsApp.">
          <textarea
            rows={10}
            style={{fontFamily: 'monospace', fontSize: '0.85rem', lineHeight: 1.5, resize: 'vertical'}}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </Field>

        <div style={{display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: '0.5rem'}}>
          <div style={{display: 'flex', gap: '0.5rem'}}>
            <Btn secondary type="button" onClick={handleCopy}>
              {copied ? <Check size={15} style={{color: '#16a34a'}} /> : <Copy size={15} />}
              {copied ? 'Copied to clipboard' : 'Copy reminder text'}
            </Btn>
            <Btn
              type="button"
              style={{background: '#25D366', color: '#fff', border: 'none'}}
              onClick={handleOpenWhatsApp}
            >
              <ExternalLink size={15} /> Open WhatsApp
            </Btn>
          </div>
          <Btn secondary type="button" onClick={onClose}>
            Close
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

export default function People({supplier = false, id}: {supplier?: boolean; id?: string}) {
  const {state, isLive, notify, fetchCustomersPage, fetchSuppliersPage, fetchCustomerProfileApi} = useStore();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(false);
  const [type, setType] = useState('All');
  const [page, setPage] = useState(1);
  const [serverData, setServerData] = useState<{records: any[]; total: number; totalPages: number} | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [detailRecord, setDetailRecord] = useState<Customer | Supplier | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [customerProfile, setCustomerProfile] = useState<any>(null);
  const [customerProfileLoading, setCustomerProfileLoading] = useState(false);
  const [customerProfileError, setCustomerProfileError] = useState('');
  const [customerTab, setCustomerTab] = useState('Overview');
  const [showReminder, setShowReminder] = useState(false);
  const [recordReceiptOpen, setRecordReceiptOpen] = useState(false);

  const isDetailRoute = Boolean(id && id !== 'new');

  // Reset detail state whenever id OR supplier section changes
  useEffect(() => {
    setDetailRecord(null);
    setDetailLoading(false);
    setCustomerProfile(null);
    setCustomerProfileError('');
  }, [id, supplier]);

  useEffect(() => {
    setPage(1);
  }, [q, type, supplier]);

  useEffect(() => {
    if (isLive && !isDetailRoute) {
      let active = true;
      setListLoading(true);
      setListError('');
      const fetchFn = supplier ? fetchSuppliersPage : fetchCustomersPage;
      fetchFn({
        page,
        limit: 10,
        q: q.trim() || undefined,
        ...(supplier || type === 'All' ? {} : {type}),
      })
        .then((res) => {
          if (!active) return;
          setServerData(res);
          if (res && res.totalPages > 0 && page > res.totalPages) {
            setPage(res.totalPages);
          }
        })
        .catch((err) => {
          if (!active) return;
          setListError(err instanceof Error ? err.message : 'Failed to load records.');
        })
        .finally(() => {
          if (active) setListLoading(false);
        });
      return () => {
        active = false;
      };
    }
  }, [isLive, supplier, page, q, type, isDetailRoute, refreshIndex, fetchCustomersPage, fetchSuppliersPage]);

  useEffect(() => {
    if (!isLive || !isDetailRoute || !id) return;
    let active = true;
    setDetailLoading(true);
    fetch(`/api/master/${supplier ? 'suppliers' : 'customers'}/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Record not found');
        const data = await res.json();
        if (active) {
          setDetailRecord(supplier ? mapSupplierFromApi(data) : mapCustomerFromApi(data));
        }
      })
      .catch(() => {
        if (active) setDetailRecord(null);
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isLive, id, supplier, isDetailRoute, refreshIndex]);

  useEffect(() => {
    if (!isLive || !isDetailRoute || !id || supplier) return;
    let active = true;
    setCustomerProfileLoading(true);
    setCustomerProfileError('');
    fetchCustomerProfileApi(id)
      .then((data) => {
        if (active) setCustomerProfile(data);
      })
      .catch((error) => {
        if (active) {
          setCustomerProfile(null);
          setCustomerProfileError(error instanceof Error ? error.message : 'Failed to load customer activity.');
        }
      })
      .finally(() => { if (active) setCustomerProfileLoading(false); });
    return () => {
      active = false;
    };
  }, [isLive, id, supplier, isDetailRoute, refreshIndex, fetchCustomerProfileApi]);

  const collection = isLive ? (serverData?.records || []) : (supplier ? state.suppliers : state.customers);
  const person = isDetailRoute
    ? (detailRecord || (supplier ? state.suppliers : state.customers).find((p) => p.id === id) || (serverData?.records || []).find((p) => p.id === id) || null)
    : null;
  const path = '/customers';

  if (isDetailRoute && isLive && detailLoading) return <Empty title="Loading record…" />;
  if (isDetailRoute && !person) {
    return (
      <Empty
        title="Record not found"
        text={isLive ? 'This record may have been archived or belongs to another company.' : 'Demo records reset when the page is refreshed.'}
        action={<Link href={path}>Back to list</Link>}
      />
    );
  }

  const liveCustomerBills = (customerProfile?.invoices || []).map((invoice: any) => ({
    id: invoice._id,
    invoiceNumber: invoice.invoiceNumber,
    customerId: id || '',
    date: invoice.invoiceDate,
    due: invoice.invoiceDate,
    kind: invoice.invoiceKind === 'Service' ? 'Service' : 'Sale',
    category: invoice.businessCategory === 'UsedGoods' ? 'Used goods' : invoice.businessCategory === 'Service' ? 'Service' : 'New goods',
    status: invoice.status,
    lines: [],
    inclusive: true,
    notes: '',
    profit: null,
    total: (invoice.totalPaise || 0) / 100,
    dueAmount: (invoice.duePaise || 0) / 100,
    returnCredit: (invoice.returnCreditPaise || 0) / 100,
  }));
  const bills: any[] = person
    ? supplier
      ? state.purchases.filter((b) => b.supplierId === id)
      : isLive
        ? liveCustomerBills
        : state.bills.filter((b) => b.customerId === id && b.kind !== 'Quotation')
    : [];

  return (
    <>
      {id && (
        <Link className="back-link" href="/customers">
          <ArrowLeft size={14} />
          All customers
        </Link>
      )}

      <PageHead
        title={person?.name || 'Customers'}
        description={
          person
            ? `${person.id} · Customer profile and transaction history`
            : 'Every customer, invoices, and payments in one shared record.'
        }
        actions={
          person ? (
            <div style={{display: 'flex', gap: '0.5rem', flexWrap: 'wrap'}}>
              <Link className="btn" href={`/sales/new?customer=${id}`} style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                <Plus size={15} /> Create invoice
              </Link>
              <Btn secondary onClick={() => setRecordReceiptOpen(true)}>
                <IndianRupee size={15} /> Record receipt
              </Btn>
              <Btn secondary onClick={() => setCustomerTab('Statement')}>
                <FileText size={15} /> Account statement
              </Btn>
              <Btn secondary onClick={() => setShowReminder(true)}>
                <MessageSquare size={15} /> Payment reminder
              </Btn>
              <Btn onClick={() => setEdit(true)}>
                <Pencil size={15} /> Edit details
              </Btn>
            </div>
          ) : (
            <Btn onClick={() => setEdit(true)}>
              <Plus size={16} /> Add customer
            </Btn>
          )
        }
      />

      {person ? (
        <>
          <AccountHistory id={person.id} supplier={supplier} profile={!supplier ? customerProfile : undefined} activeTab={!supplier ? customerTab : undefined} onTabChange={!supplier ? setCustomerTab : undefined} />
          <div className="detail-grid spaced">
            <div className="stack">
              <Card
                title="Invoices"
                actions={
                  <Link
                    className="text-link"
                    href={`/sales/new?customer=${id}`}
                  >
                    New invoice <Plus size={14} />
                  </Link>
                }
              >
                {isLive && customerProfileLoading ? (
                  <Empty title="Loading invoices…" text="Loading this customer’s live invoice history." />
                ) : isLive && customerProfileError ? (
                  <Empty title="Could not load invoices" text={customerProfileError} action={<Btn secondary onClick={() => setRefreshIndex((n) => n + 1)}>Retry</Btn>} />
                ) : bills.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Invoice</th>
                          <th>Date</th>
                          <th>Total</th>
                          <th>Due</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {bills.map((b) => (
                          <tr key={b.id}>
                            <td>
                              <Link className="record-link" href={`/sales/${b.id}`}>
                                {(b as any).invoiceNumber || b.id}
                              </Link>
                            </td>
                            <td>{dateLabel(b.date)}</td>
                            <td>{money(roundedTotal(b))}</td>
                            <td>{money(balance(state, b))}</td>
                            <td>
                              <Link href={`/sales/${b.id}`}>
                                <ArrowUpRight size={16} />
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title="No invoices yet" text="Issued invoices for this customer will appear here." />
                )}
              </Card>

              <Card
                title="Receipt history"
                actions={
                  <Btn secondary onClick={() => setRecordReceiptOpen(true)}>
                    Record receipt <Plus size={14} />
                  </Btn>
                }
              >
                {(isLive ? (customerProfile?.receipts || []) : state.payments.filter((p) => p.party === id && p.direction === 'In')).length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Receipt</th>
                          <th>Date</th>
                          <th>Method / Account</th>
                          <th style={{ textAlign: 'right' }}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(isLive ? (customerProfile?.receipts || []) : state.payments.filter((p) => p.party === id && p.direction === 'In')).map((r: any) => (
                          <tr key={r._id || r.id}>
                            <td>
                              <Link className="record-link" href={`/payments?search=${encodeURIComponent(r.receiptNumber || r.id || '')}`}>
                                {r.receiptNumber || r.id}
                              </Link>
                            </td>
                            <td>{dateLabel(r.receiptDate || r.date)}</td>
                            <td>
                              <Badge>{r.method || r.account}</Badge>
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>
                              {money(r.totalAmountPaise != null ? r.totalAmountPaise / 100 : r.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title="No receipts recorded yet"
                    text="Receipts recorded for this customer will appear here."
                    action={
                      <Btn secondary onClick={() => setRecordReceiptOpen(true)}>
                        Record receipt
                      </Btn>
                    }
                  />
                )}
              </Card>
            </div>

            <div className="stack">
              <Card title="Contact details">
                <dl className="detail-list">
                  <div>
                    <dt>Phone</dt>
                    <dd>{person.phone || '—'}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>{person.email || '—'}</dd>
                  </div>
                  <div>
                    <dt>Address</dt>
                    <dd>{person.address || '—'}</dd>
                  </div>
                  <div>
                    <dt>GSTIN</dt>
                    <dd>{person.gst || 'Not provided'}</dd>
                  </div>
                </dl>
                <div className="body-pad">
                  <Btn secondary onClick={() => setShowReminder(true)} style={{display: 'inline-flex', alignItems: 'center', gap: '6px'}}>
                    <MessageSquare size={14} /> Send payment reminder
                  </Btn>
                </div>
              </Card>

              <Card title="Current outstanding">
                <div className="body-pad">
                  <h1>
                    {isLive && customerProfile
                      ? money((customerProfile.summary?.outstandingDuePaise || 0) / 100)
                      : money(bills.reduce((a, b) => a + balance(state, b), 0))}
                  </h1>
                  <p className="spaced">Calculated from issued invoices and received payments.</p>
                  <Link className="text-link spaced" href={`/reports?report=Customer+outstanding&customerId=${id}`}>
                    View customer outstanding <ArrowUpRight size={14} />
                  </Link>
                </div>
              </Card>

              <Card title="Customer notes">
                <p className="body-pad">{(person as Customer).notes || 'No notes added.'}</p>
              </Card>
            </div>
          </div>
        </>
      ) : (
        <Card>
          <div className="toolbar">
            <SearchBox
              value={q}
              onChange={setQ}
              placeholder={`Search ${supplier ? 'supplier' : 'customer'} name or phone…`}
            />
            {!supplier && (
              <select aria-label="Customer type filter" value={type} onChange={(e) => setType(e.target.value)}>
                <option>All</option>
                <option>Individual</option>
                <option>Business</option>
              </select>
            )}
            <span className="muted">
              {isLive && serverData ? serverData.total : collection.length} {supplier ? 'suppliers' : 'customers'}
            </span>
          </div>

          {listLoading && !serverData ? (
            <div className="table-wrap" style={{padding: '32px', textAlign: 'center'}}>
              <span className="muted">Loading records…</span>
            </div>
          ) : listError ? (
            <div className="table-wrap" style={{padding: '32px', textAlign: 'center'}}>
              <p className="error" style={{marginBottom: 12}}>{listError}</p>
              <Btn secondary onClick={() => setRefreshIndex((r) => r + 1)}>Retry</Btn>
            </div>
          ) : !collection.length ? (
            <Empty
              title={q ? 'No matching records' : `No ${supplier ? 'suppliers' : 'customers'} found`}
              text={q ? 'Try another search term or filter.' : `Click Add ${supplier ? 'supplier' : 'customer'} above to create the first record.`}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{supplier ? 'Supplier' : 'Customer'}</th>
                    <th>Contact</th>
                    <th>{supplier ? 'Credit period' : 'GSTIN'}</th>
                    <th>Outstanding</th>
                    {!supplier && <th>Sales activity</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(isLive
                    ? collection
                    : collection.filter(
                        (p) =>
                          (p.name + p.phone).toLowerCase().includes(q.toLowerCase()) &&
                          (supplier || type === 'All' || (p as Customer).type === type)
                      )
                  ).map((p) => {
                    const docs = supplier
                      ? state.purchases.filter((b) => b.supplierId === p.id)
                      : state.bills.filter((b) => b.customerId === p.id && b.kind !== 'Quotation');
                    return (
                      <tr key={p.id}>
                        <td>
                          <Link className="customer-cell" href={path + '/' + p.id}>
                            <div className="avatar">
                              {p.name
                                .split(' ')
                                .map((s: string) => s[0])
                                .slice(0, 2)
                                .join('')}
                            </div>
                            <div>
                              <strong>{p.name}</strong>
                              <small>{p.id}</small>
                            </div>
                          </Link>
                        </td>
                        <td>
                          {p.phone}
                          <small>{p.email}</small>
                        </td>
                        <td>{supplier ? `${(p as Supplier).terms} days` : (p as Customer).gst || 'Not provided'}</td>
                        <td className="amount">{money(isLive && !supplier ? ((p as Customer).outstandingDue || 0) : docs.reduce((a, b) => a + balance(state, b), 0))}</td>
                        {!supplier && <td>{isLive ? `${(p as Customer).invoiceCount || 0} invoice(s)` : `${docs.length} invoice(s)`}<small>{(p as Customer).lastActivityDate ? `Last: ${(p as Customer).lastActivityDate}` : 'No completed sales'}</small></td>}
                        <td>
                          <Link className="text-link" href={path + '/' + p.id}>
                            View profile <ArrowUpRight size={15} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {collection.length > 0 && (
            <div className="table-footer">
              <span>
                {isLive && serverData
                  ? `Showing ${collection.length} of ${serverData.total} records`
                  : `${collection.length} matching records`}
              </span>
              {isLive && serverData && serverData.totalPages > 1 && (
                <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
                  <span className="muted" style={{marginRight: 8}}>
                    Page {page} of {serverData.totalPages}
                  </span>
                  <Btn secondary disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                    Previous
                  </Btn>
                  <Btn secondary disabled={page >= serverData.totalPages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Btn>
                </div>
              )}
            </div>
          )}
        </Card>
      )}


      {recordReceiptOpen && person && !supplier && (
        <RecordReceiptModal
          isOpen={recordReceiptOpen}
          preselectedInvoice={{ customerId: id }}
          onClose={() => setRecordReceiptOpen(false)}
          onSuccess={() => {
            setRecordReceiptOpen(false);
            setRefreshIndex((n) => n + 1);
            notify('Customer payment receipt recorded.');
          }}
        />
      )}

      {showReminder && person && !supplier && (
        <PaymentReminderModal
          customer={person as Customer}
          invoices={bills}
          totalDue={
            isLive
              ? (customerProfile?.summary?.outstandingDuePaise != null
                  ? customerProfile.summary.outstandingDuePaise / 100
                  : bills.reduce((acc, b) => acc + (b.dueAmount || 0), 0))
              : bills.reduce((acc, b) => acc + balance(state, b), 0)
          }
          onClose={() => setShowReminder(false)}
        />
      )}

      {edit && (
        <PersonForm
          supplier={supplier}
          existing={person || undefined}
          onClose={() => setEdit(false)}
          onSuccess={() => setRefreshIndex((r) => r + 1)}
        />
      )}
    </>
  );
}
