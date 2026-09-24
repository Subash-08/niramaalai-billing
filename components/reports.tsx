'use client';
import ExportButtons from './export-buttons';
import {useState, useEffect, useCallback} from 'react';
import Link from 'next/link';
import {Download, Printer, ArrowUpRight, BarChart3, LockKeyhole} from 'lucide-react';
import {TODAY, money, roundedTotal, balance, paid, totals, lineTotal} from '@/lib/domain';
import {useStore} from './store';
import {PageHead, Card, Btn, Modal, Field, Empty, csvDownload} from './ui';
import {PrintDialog} from './templates';

const reportNames = [
  'Sales',
  'Tax summary',
  'Service sales',
  'Payments received',
  'Payments paid',
  'Customer outstanding',
  'Product catalogue',
  'Invoice exports',
];

export default function Reports() {
  const {state, role, notify, isLive} = useStore();
  const [customer, setCustomer] = useState('All customers');
  const [paymentStatus, setPaymentStatus] = useState('All payments');
  const [template, setTemplate] = useState(state.defaultTemplateId);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState('Sales');
  const [from, setFrom] = useState(TODAY.slice(0, 8) + '01');
  const [to, setTo] = useState(TODAY);
  const [category, setCategory] = useState('All categories');
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [serverReport, setServerReport] = useState<{headers: string[]; rows: (string | number)[][]} | null>(null);
  const [loading, setLoading] = useState(false);
  const [reportError, setReportError] = useState('');

  useEffect(() => {
    if (!isLive) return;
    if (report === 'Invoice exports') return;

    let active = true;
    setLoading(true);
    setServerReport(null);
    setReportError('');
    const p = new URLSearchParams({
      report,
      from,
      to,
      customerId: customer,
      paymentStatus,
      category,
    });

    fetch(`/api/company/reports?${p.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load report.');
        }
        return res.json();
      })
      .then((data) => {
        if (active) setServerReport(data);
      })
      .catch((err) => {
        if (active) {
          notify(err.message);
          setReportError(err.message);
          setServerReport(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isLive, report, from, to, customer, paymentStatus, category, role, notify]);

  // Demo fallback calculations
  const bills = state.bills.filter(
    (b) =>
      b.kind !== 'Quotation' &&
      b.status === 'Issued' &&
      (customer === 'All customers' || b.customerId === customer) &&
      (paymentStatus === 'All payments' ||
        (paymentStatus === 'Paid' ? balance(state, b) === 0 : balance(state, b) > 0)) &&
      b.date >= from &&
      b.date <= to &&
      (category === 'All categories' ||
        category === 'Tax invoices'
        ? category !== 'Tax invoices' || b.lines.some((l) => l.tax > 0)
        : category === 'Non-GST invoices'
        ? b.lines.every((l) => l.tax === 0)
        : b.category === category)
  );

  const demoRows: (string | number)[][] =
    report === 'Tax summary'
      ? bills.map((b) => {
          const t = totals(b);
          return [b.id, b.date, b.taxMode || 'Intra-state', t.base, t.cgst, t.sgst, t.igst, t.total];
        })
      : report === 'Service sales'
      ? bills.flatMap((b) => b.lines.filter(l => l.lineType === 'Service').map(l => [b.id, b.date, state.customers.find(c => c.id === b.customerId)?.name || 'Customer', l.name, l.qty, l.unit || 'Job', lineTotal(l, b.inclusive, b.taxMode).total]))
      : report === 'Payments received'
      ? state.payments.filter(p => p.direction === 'In' && p.date >= from && p.date <= to).map(p => [p.reference || p.id, p.date, p.party || 'Customer', (p as any).invoiceId || p.reference || 'Invoice', p.account, (p as any).method || 'Cash', p.note || '-', p.amount])
      : report === 'Payments paid'
      ? state.payments.filter(p => p.direction === 'Out' && p.date >= from && p.date <= to).map(p => [p.reference || p.id, p.date, p.party || 'Payee', p.purpose || 'Expense', p.account, (p as any).method || 'Cash', p.note || '-', p.amount])
      : report === 'Customer outstanding' || report === 'Customer dues'
      ? state.bills
          .filter(
            (b) =>
              b.kind !== 'Quotation' &&
              b.date <= to &&
              (customer === 'All customers' || b.customerId === customer) &&
              balance(state, b) > 0
          )
          .map((b) => [b.id, state.customers.find((c) => c.id === b.customerId)?.name || '', b.date, b.due || b.date, balance(state, b)])
      : report === 'Product catalogue'
      ? state.products.map(p => [p.id, p.name, p.category, p.description || '', p.unit || 'Piece', p.hsn || '', p.price, `${p.tax || 0}%`, p.status || 'Active'])
      : bills.map((b) => {
          const t = totals(b);
          return [
            b.id,
            b.date,
            state.customers.find((c) => c.id === b.customerId)?.name || 'Customer',
            b.category || 'Sale',
            t.base,
            t.tax,
            roundedTotal(b),
            paid(state, b.id),
            balance(state, b),
          ];
        });

  const demoHeaders =
    report === 'Tax summary'
      ? ['Invoice', 'Date', 'Supply type', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total']
      : report === 'Service sales'
      ? ['Invoice', 'Date', 'Customer', 'Service description', 'Quantity', 'Unit', 'Amount']
      : report === 'Payments received'
      ? ['Receipt number', 'Date', 'Customer', 'Settled invoice', 'Account', 'Payment method', 'Reference / UTR', 'Amount']
      : report === 'Payments paid'
      ? ['Voucher number', 'Date', 'Paid to', 'Purpose', 'Account', 'Payment method', 'Reference / UTR', 'Amount']
      : report === 'Customer outstanding' || report === 'Customer dues'
      ? ['Bill', 'Customer', 'Invoice date', 'Due date', 'Current balance']
      : report === 'Product catalogue'
      ? ['Product ID', 'Name', 'Category', 'Description', 'Unit', 'HSN', 'Standard rate', 'GST rate', 'Status']
      : ['Invoice number', 'Date', 'Customer', 'Category', 'Taxable amount', 'GST', 'Total', 'Collected', 'Due'];

  const headers = isLive ? (serverReport?.headers || []) : demoHeaders;
  const rows = isLive ? (serverReport?.rows || []) : demoRows;
  // Summaries use the very same filtered rows as the table and exports.
  const summaryColumns: Record<string, number[]> = {
    Sales: [4, 5, 6, 7, 8],
    'Tax summary': [3, 4, 5, 6, 7],
    'Service sales': [4, 6],
    'Payments received': [7],
    'Payments paid': [7],
    'Customer outstanding': [4],
    'Customer dues': [4],
    'Product catalogue': [6],
  };
  const summaryCards = (summaryColumns[report] || []).map(index => ({
    label: headers[index], count: false,
    value: rows.reduce((n, row) => n + (typeof row[index] === 'number' ? Math.round((row[index] as number) * 100) : 0), 0) / 100,
  }));


  function preset(days: number) {
    setTo(TODAY);
    setFrom(
      new Date(new Date(TODAY + 'T12:00:00').getTime() - (days - 1) * 86400000)
        .toISOString()
        .slice(0, 10)
    );
  }

  async function zipInvoices() {
    setBusy(true);
    try {
      if (isLive) {
        const p = new URLSearchParams({
          dateFrom: from,
          dateTo: to,
        });
        if (customer !== 'All customers') p.set('customerId', customer);
        const res = await fetch(`/api/sales/invoices/export-zip?${p.toString()}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Export failed.');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `invoices-${from}-to-${to}.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        notify('Downloaded filtered invoice PDFs and manifest ZIP.');
      } else {
        const e = await import('@/lib/exports');
        const chosen = bills.filter((b) => selected.includes(b.id));
        e.downloadBytes(
          'invoices-' + from + '-to-' + to + '.zip',
          await e.invoiceZipBytes(state, chosen, template),
          'application/zip'
        );
        notify('Downloaded ' + chosen.length + ' invoice PDFs and an Excel index.');
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }

  const restricted = false;

  return (
    <>
      <PageHead
        title="Reports"
        description="Review the numbers, open the source records and prepare your accountant’s documents."
        actions={
          <ExportButtons
            title={report}
            headers={headers}
            rows={rows}
            description={`${from} to ${to} / ${customer} / ${paymentStatus}`}
            disabled={restricted}
          />
        }
      />
      <div className="reports-layout">
        <aside className="report-nav screen-only">
          {reportNames.map((r) => (
            <button
              className={report === r ? 'active' : ''}
              key={r}
              onClick={() => {
                setReport(r);
                setSelected([]);
              }}
            >
              <BarChart3 size={15} />
              {r}

            </button>
          ))}
        </aside>

        <div className="stack">
          {loading && <div className="notice" role="status">Loading live report…</div>}
          {reportError && <div className="notice" role="alert">{reportError} Change a filter to retry. No demo data is shown.</div>}
          {report !== 'Invoice exports' && !loading && !reportError && <div className="stats-grid">
            <Card title="Matching records"><div className="body-pad"><h2>{rows.length}</h2><small>Current filters</small></div></Card>
            {summaryCards.map(card => <Card key={card.label} title={card.label}><div className="body-pad"><h2>{card.count ? card.value : money(card.value)}</h2><small>Current filters · same records as export</small></div></Card>)}
          </div>}
          <Card
            title={report + ' report'}
            sub={
              report === 'Product catalogue' || report.includes('outstanding') || report.includes('dues')
                ? 'Current balances; date range does not reconstruct a historical stock or due balance.'
                : `${from} to ${to}`
            }
          >
            <div className="toolbar screen-only">
              <Field label="From">
                <input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setSelected([]);
                  }}
                />
              </Field>
              <Field label="To">
                <input
                  type="date"
                  value={to}
                  min={from}
                  max={TODAY}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setSelected([]);
                  }}
                />
              </Field>

              {['Sales', 'Service sales', 'Invoice exports', 'Tax summary', 'Customer outstanding', 'Customer dues', 'Payments received'].includes(report) && (
                <Field label="Customer">
                  <select
                    value={customer}
                    onChange={(e) => {
                      setCustomer(e.target.value);
                      setSelected([]);
                    }}
                  >
                    <option>All customers</option>
                    {state.customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}



              {['Sales', 'Invoice exports'].includes(report) && (
                <Field label="Payment status">
                  <select
                    value={paymentStatus}
                    onChange={(e) => {
                      setPaymentStatus(e.target.value);
                      setSelected([]);
                    }}
                  >
                    <option>All payments</option>
                    <option>Paid</option>
                    <option>Unpaid / partial</option>
                  </select>
                </Field>
              )}

              <button className="link-button" onClick={() => preset(7)}>
                7 days
              </button>
              <button className="link-button" onClick={() => preset(30)}>
                30 days
              </button>

              {['Sales', 'Invoice exports', 'Tax summary'].includes(report) && (
                <select
                  aria-label="Report category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {[
                    'All categories',
                    'New goods',
                    'Used goods',
                    'Service',
                    'Tax invoices',
                    'Non-GST invoices',
                  ].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              )}
            </div>

            {restricted ? (
              <Empty
                title="Owner access required"
                text="Staff can enter individual profit on the day-end screen. Profit totals and exports are owner-only."
              />
            ) : (
              <>
                {report === 'Invoice exports' ? (
                  <>
                    <div className="toolbar screen-only">
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={
                            !!bills.length &&
                            bills.every((b) => selected.includes(b.id))
                          }
                          onChange={(e) =>
                            setSelected(e.target.checked ? bills.map((b) => b.id) : [])
                          }
                        />
                        Select all
                      </label>
                      <Field label="PDF layout">
                        <select
                          value={template}
                          onChange={(e) => setTemplate(e.target.value)}
                        >
                          {state.templates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Btn
                        disabled={busy || (!isLive && !bills.some((b) => selected.includes(b.id)))}
                        onClick={zipInvoices}
                      >
                        {busy ? 'Preparing ZIP…' : 'Download invoice ZIP'}
                      </Btn>
                      <Btn
                        disabled={!selected.length}
                        onClick={() => setBatch(true)}
                      >
                        Preview {selected.length} selected invoice(s)
                      </Btn>
                    </div>

                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Select</th>
                            <th>Document</th>
                            <th>Customer</th>
                            <th>Type</th>
                            <th>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bills.map((b) => (
                            <tr key={b.id}>
                              <td>
                                <input
                                  aria-label={'Select ' + b.id}
                                  type="checkbox"
                                  checked={selected.includes(b.id)}
                                  onChange={(e) =>
                                    setSelected(
                                      e.target.checked
                                        ? [...selected, b.id]
                                        : selected.filter((x) => x !== b.id)
                                    )
                                  }
                                />
                              </td>
                              <td>
                                <Link className="record-link" href={'/sales/' + b.id}>
                                  {b.id}
                                </Link>
                              </td>
                              <td>
                                {state.customers.find((c) => c.id === b.customerId)?.name}
                              </td>
                              <td>
                                {b.lines.some((l) => l.tax > 0)
                                  ? 'Tax invoice'
                                  : 'Non-GST invoice'}
                                <small>{b.category}</small>
                              </td>
                              <td>{money(roundedTotal(b))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          {headers.map((h) => (
                            <th key={h}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i}>
                            {r.map((v, n) => (
                              <td key={n}>
                                {typeof v === 'number' &&
                                /Amount|Price|total|billed|balance|profit|Estimate|Returns|Paid|Due|value/i.test(
                                  headers[n]
                                )
                                  ? money(v)
                                  : v}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {loading && (
                  <div style={{padding: '16px', textAlign: 'center'}} className="muted">
                    Loading authoritative report…
                  </div>
                )}
                {!loading && !rows.length && (
                  <Empty
                    title="No records in this selection"
                    text="Try another report or date range."
                  />
                )}
                <div className="table-footer">
                  {rows.length} records · {isLive ? 'Live company data' : 'Based on current demo workspace'}
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
      {batch && (
        <PrintDialog
          bills={bills.filter((b) => selected.includes(b.id))}
          onClose={() => setBatch(false)}
        />
      )}
    </>
  );
}
