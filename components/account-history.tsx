'use client';

import {useState, useEffect} from 'react';
import Link from 'next/link';
import {Download, ArrowUpRight} from 'lucide-react';
import {useStore} from './store';
import {money, roundedTotal, dateLabel, TODAY} from '@/lib/domain';
import {Card, Btn, Badge, Field} from './ui';

export default function AccountHistory({
  id,
  supplier = false,
  profile,
  activeTab,
  onTabChange,
}: {
  id: string;
  supplier?: boolean;
  profile?: any;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
}) {
  const {
    state,
    isLive,
    fetchCustomerStatementApi,
  } = useStore();

  const [internalTab, setInternalTab] = useState('Overview');
  const tab = activeTab ?? internalTab;
  const setTab = (t: string) => {
    setInternalTab(t);
    onTabChange?.(t);
  };

  // Customer Statement Tab State
  const [statementData, setStatementData] = useState<any>(null);
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementDateFrom, setStatementDateFrom] = useState('');
  const [statementDateTo, setStatementDateTo] = useState('');
  const [statementPage, setStatementPage] = useState(1);

  const bills = state.bills.filter((b) => b.customerId === id && b.kind !== 'Quotation');
  const refs = new Set(bills.map((b) => b.id));

  // Load statement
  useEffect(() => {
    if (isLive && tab === 'Statement') {
      setStatementLoading(true);
      fetchCustomerStatementApi(id, {
        fromDate: statementDateFrom || undefined,
        toDate: statementDateTo || undefined,
        page: statementPage,
        limit: 25,
      })
        .then((res: any) => {
          setStatementData(res);
        })
        .catch(() => {})
        .finally(() => setStatementLoading(false));
    }
  }, [isLive, id, tab, statementDateFrom, statementDateTo, statementPage, fetchCustomerStatementApi]);

  const customerEvents = [
    ...bills.map((b) => ({
      id: b.id,
      date: b.date,
      title: b.kind === 'Service' ? 'Service invoice' : 'Product invoice',
      detail: (b as any).invoiceNumber ? `${(b as any).invoiceNumber} · ${money(roundedTotal(b))}` : `${b.id} · ${money(roundedTotal(b))}`,
      href: '/sales/' + b.id,
    })),
    ...state.payments
      .filter((p) => p.party === id || refs.has(p.reference))
      .map((p) => ({
        id: p.id,
        date: p.date,
        title: p.purpose || 'Payment received',
        detail: money(p.amount) + ' · ' + p.account + (p.note ? ' · ' + p.note : ''),
        href: p.reference ? '/sales/' + p.reference : '/payments',
      })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const availableTabs = ['Overview', 'Statement', 'Activity timeline'];

  return (
    <div className="stack spaced">
      <div className="tabs">
        {availableTabs.map((t) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="grid-2">
          <Card title="Product billing">
            <div className="body-pad">
              <h2>
                {isLive
                  ? (profile ? money((profile.contributions?.newGoodsTotalPaise || 0) / 100) : '…')
                  : money(bills.filter(b => b.category !== 'Service').reduce((n, b) => n + roundedTotal(b), 0))}
              </h2>
              <p>Invoiced value for printed products</p>
              <small>
                {isLive
                  ? (profile ? `${profile.contributions?.newGoodsInvoiceCount || 0} invoices` : 'Loading live totals…')
                  : `${bills.filter(b => b.category !== 'Service').length} invoices`}
              </small>
            </div>
          </Card>
          <Card title="Service billing">
            <div className="body-pad">
              <h2>
                {isLive
                  ? (profile ? money((profile.contributions?.serviceTotalPaise || 0) / 100) : '…')
                  : money(bills.filter(b => b.category === 'Service').reduce((n, b) => n + roundedTotal(b), 0))}
              </h2>
              <p>Invoiced value for printing services</p>
              <small>
                {isLive
                  ? (profile ? `${profile.contributions?.serviceInvoiceCount || 0} invoices` : 'Loading live totals…')
                  : `${bills.filter(b => b.category === 'Service').length} invoices`}
              </small>
            </div>
          </Card>
        </div>
      )}

      {/* Customer Statement Tab */}
      {tab === 'Statement' && (
        <Card
          title="Customer account statement"
          actions={
            <div style={{display: 'flex', gap: '0.5rem'}}>
              {(['csv', 'xlsx', 'pdf'] as const).map(format => (
                <Btn key={format} secondary onClick={() => {
                  const query = new URLSearchParams({format});
                  if (statementDateFrom) query.set('fromDate', statementDateFrom);
                  if (statementDateTo) query.set('toDate', statementDateTo);
                  window.location.href = `/api/sales/customers/${id}/statement/export?${query.toString()}`;
                }}><Download size={14} /> {format.toUpperCase()}</Btn>
              ))}
            </div>
          }
        >
          <div className="toolbar" style={{gap: '1rem', flexWrap: 'wrap'}}>
            <Field label="Date from">
              <input
                type="date"
                value={statementDateFrom}
                onChange={(e) => {
                  setStatementDateFrom(e.target.value);
                  setStatementPage(1);
                }}
              />
            </Field>
            <Field label="Date to">
              <input
                type="date"
                max={TODAY}
                value={statementDateTo}
                onChange={(e) => {
                  setStatementDateTo(e.target.value);
                  setStatementPage(1);
                }}
              />
            </Field>
            {(statementDateFrom || statementDateTo) && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setStatementDateFrom('');
                  setStatementDateTo('');
                  setStatementPage(1);
                }}
              >
                Reset dates
              </button>
            )}
          </div>

          {statementLoading ? (
            <div className="body-pad muted">Loading customer statement…</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Reference</th>
                    <th>Description</th>
                    <th>Debit / Invoice (+)</th>
                    <th>Credit / Receipt (-)</th>
                    <th>Running Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {(statementData?.entries || []).map((e: any, idx: number) => {
                    const debitAmt = e.debitPaise !== undefined ? e.debitPaise : (e.amountPaise > 0 ? e.amountPaise : 0);
                    const creditAmt = e.creditPaise !== undefined ? e.creditPaise : (e.amountPaise < 0 ? Math.abs(e.amountPaise) : 0);
                    const isDebit = debitAmt > 0;
                    const isCredit = creditAmt > 0;
                    return (
                      <tr key={idx}>
                        <td>{dateLabel(e.date)}</td>
                        <td><Badge>{e.type}</Badge></td>
                        <td>
                          {e.reference?.startsWith('INV') ? (
                            <Link href={'/sales/' + (e.invoiceId || e.reference)}>{e.reference}</Link>
                          ) : (
                            e.reference || '—'
                          )}
                        </td>
                        <td>{e.description || '—'}</td>
                        <td className={isDebit ? 'positive' : ''}>
                          {isDebit ? money(debitAmt / 100) : '—'}
                        </td>
                        <td className={isCredit ? 'error' : ''}>
                          {isCredit ? money(creditAmt / 100) : '—'}
                        </td>
                        <td>
                          <strong>{money((e.runningBalancePaise ?? e.balanceAfterPaise ?? 0) / 100)}</strong>
                        </td>
                      </tr>
                    );
                  })}
                  {!(statementData?.entries || []).length && (
                    <tr>
                      <td colSpan={7} className="muted body-pad">
                        No transactions recorded for this customer in the selected date range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {statementData?.pagination && statementData.pagination.totalPages > 1 && (
            <div className="pagination toolbar" style={{marginTop: '1rem'}}>
              <Btn
                secondary
                disabled={statementPage <= 1}
                onClick={() => setStatementPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Btn>
              <span>
                Page {statementPage} of {statementData.pagination.totalPages}
              </span>
              <Btn
                secondary
                disabled={statementPage >= statementData.pagination.totalPages}
                onClick={() => setStatementPage((p) => Math.min(statementData.pagination.totalPages, p + 1))}
              >
                Next
              </Btn>
            </div>
          )}
        </Card>
      )}

      {/* Activity Timeline Tab */}
      {tab === 'Activity timeline' && (
        <Card title="Activity timeline">
          {customerEvents.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Activity</th>
                    <th>Details</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {customerEvents.map((evt) => (
                    <tr key={evt.id}>
                      <td>{dateLabel(evt.date)}</td>
                      <td>{evt.title}</td>
                      <td>{evt.detail}</td>
                      <td>
                        {evt.href && (
                          <Link href={evt.href}>
                            <ArrowUpRight size={15} />
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="body-pad muted">No recorded activity for this customer yet.</p>
          )}
        </Card>
      )}
    </div>
  );
}
