'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  IndianRupee,
  Receipt,
  FileText,
  Users,
  ArrowDownLeft,
  ArrowUpRight,
  Plus,
  RefreshCw,
  AlertCircle,
  Printer,
  ChevronRight,
  TrendingUp,
} from 'lucide-react';
import { useStore } from './store';
import { Card, PageHead, Btn, Badge } from './ui';
import { money, TODAY, roundedTotal, balance } from '@/lib/domain';

export default function Dashboard() {
  const { state, isLive, notify } = useStore();

  const [liveData, setLiveData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLiveDashboard = useCallback(async () => {
    if (!isLive) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/company/dashboard');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to load live dashboard statistics.');
      }
      const json = await res.json();
      setLiveData(json);
    } catch (err: any) {
      setError(err.message || 'Unable to connect to live billing data.');
      setLiveData(null);
    } finally {
      setLoading(false);
    }
  }, [isLive]);

  useEffect(() => {
    if (isLive) {
      fetchLiveDashboard();
    }
  }, [isLive, fetchLiveDashboard]);

  // Demo fallback only used when completely unauthenticated (not in Live mode)
  const demoData = React.useMemo(() => {
    if (isLive) return null;
    const issuedBills = state.bills.filter(
      (b: any) => b.kind !== 'Quotation' && b.status === 'Issued'
    );
    const todayBills = issuedBills.filter((b: any) => b.date === TODAY);
    const monthBills = issuedBills.filter(
      (b: any) => b.date.slice(0, 7) === TODAY.slice(0, 7)
    );

    const todayTotal = todayBills.reduce((acc, b) => acc + roundedTotal(b), 0);
    const monthTotal = monthBills.reduce((acc, b) => acc + roundedTotal(b), 0);
    const monthGst = monthBills.reduce(
      (acc, b) =>
        acc +
        (b.lines || []).reduce(
          (sum: number, l: any) => sum + (l.tax || 0),
          0
        ),
      0
    );
    const totalDue = issuedBills.reduce((acc, b) => acc + balance(state, b), 0);

    return {
      todayDate: TODAY,
      sales: {
        todayTotalPaise: Math.round(todayTotal * 100),
        todayCount: todayBills.length,
        monthTotalPaise: Math.round(monthTotal * 100),
        monthGstPaise: Math.round(monthGst * 100),
        monthCount: monthBills.length,
      },
      dues: {
        totalCustomerOutstandingPaise: Math.round(totalDue * 100),
      },
      payments: {
        moneyReceivedTodayPaise: Math.round(todayTotal * 0.7 * 100),
        receivedTodayCount: todayBills.length > 0 ? 1 : 0,
        moneyPaidTodayPaise: 0,
        paidTodayCount: 0,
      },
      customerCount: state.customers.length,
      printJobsByStatus: {
        Queued: (state.jobs || []).filter((j: any) => j.status === 'Received').length,
        Printing: (state.jobs || []).filter((j: any) => j.status === 'In Progress').length,
        Completed: (state.jobs || []).filter((j: any) => j.status === 'Completed').length,
        Delivered: (state.jobs || []).filter((j: any) => j.status === 'Delivered').length,
      },
      recentInvoices: issuedBills.slice(0, 5).map((b: any) => ({
        id: b.id,
        invoiceNumber: b.id,
        customerName:
          state.customers.find((c: any) => c.id === b.customerId)?.name ||
          'Customer',
        date: b.date,
        totalPaise: Math.round(roundedTotal(b) * 100),
        duePaise: Math.round(balance(state, b) * 100),
        paymentStatus: balance(state, b) === 0 ? 'Paid' : 'Unpaid',
      })),
      outstandingInvoices: issuedBills
        .filter((b: any) => balance(state, b) > 0)
        .slice(0, 5)
        .map((b: any) => ({
          id: b.id,
          invoiceNumber: b.id,
          customerName:
            state.customers.find((c: any) => c.id === b.customerId)?.name ||
            'Customer',
          date: b.date,
          totalPaise: Math.round(roundedTotal(b) * 100),
          duePaise: Math.round(balance(state, b) * 100),
        })),
      recentReceipts: [],
      recentVouchers: [],
    };
  }, [isLive, state]);

  const data = isLive ? liveData : demoData;

  return (
    <>
      <PageHead
        title="Dashboard"
        description="Live overview of sales, collections, disbursements, customer balances, and active print orders."
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Link className="btn" href="/sales/new">
              <Plus size={15} style={{ marginRight: '4px' }} /> New Invoice
            </Link>
            <Link className="btn secondary" href="/payments">
              <ArrowDownLeft size={15} style={{ marginRight: '4px', color: 'var(--success, #16a34a)' }} /> Receive Money
            </Link>
            <Link className="btn secondary" href="/payments">
              <ArrowUpRight size={15} style={{ marginRight: '4px', color: 'var(--danger, #ef4444)' }} /> Pay Money
            </Link>
          </div>
        }
      />

      {/* Live mode retryable error banner */}
      {isLive && error && (
        <div
          className="notice error"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1rem',
            marginBottom: '1.25rem',
            borderRadius: '6px',
            background: 'var(--danger-bg, #fef2f2)',
            border: '1px solid var(--danger-border, #fecaca)',
            color: 'var(--danger, #991b1b)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <AlertCircle size={20} />
            <div>
              <strong>Failed to load live dashboard statistics.</strong>
              <div style={{ fontSize: '0.85rem' }}>{error}</div>
            </div>
          </div>
          <Btn onClick={fetchLiveDashboard} disabled={loading}>
            <RefreshCw size={14} style={{ marginRight: '4px' }} className={loading ? 'spin' : ''} />
            {loading ? 'Retrying…' : 'Retry'}
          </Btn>
        </div>
      )}

      {/* Loading state indicator */}
      {isLive && loading && !liveData && (
        <div
          style={{
            padding: '3rem',
            textAlign: 'center',
            color: 'var(--text-muted, #6b7280)',
          }}
        >
          <RefreshCw size={24} className="spin" style={{ margin: '0 auto 0.75rem auto' }} />
          <p>Loading real-time billing metrics…</p>
        </div>
      )}

      {data && (
        <>
          {/* Row 1: Six Key Financial & Billing Summary Cards */}
          <div
            className="summary-dashboard"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '1rem',
              marginBottom: '1.5rem',
            }}
          >
            {/* 1. Today's Sales */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted, #6b7280)', fontWeight: 600 }}>
                    Today&apos;s Sales
                  </p>
                  <h2 style={{ margin: '0.35rem 0', fontSize: '1.45rem', fontWeight: 800 }}>
                    {money((data.sales?.todayTotalPaise || 0) / 100)}
                  </h2>
                  <small style={{ color: 'var(--text-muted, #6b7280)' }}>
                    {data.sales?.todayCount || 0} invoice{data.sales?.todayCount === 1 ? '' : 's'} issued today
                  </small>
                </div>
                <div
                  style={{
                    padding: '8px',
                    borderRadius: '8px',
                    background: 'rgba(99, 102, 241, 0.1)',
                    color: 'var(--primary, #6366f1)',
                  }}
                >
                  <IndianRupee size={20} />
                </div>
              </div>
            </Card>

            {/* 2. Month's Sales */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted, #6b7280)', fontWeight: 600 }}>
                    This Month&apos;s Sales
                  </p>
                  <h2 style={{ margin: '0.35rem 0', fontSize: '1.45rem', fontWeight: 800 }}>
                    {money((data.sales?.monthTotalPaise || 0) / 100)}
                  </h2>
                  <small style={{ color: 'var(--text-muted, #6b7280)' }}>
                    {data.sales?.monthCount || 0} invoice{data.sales?.monthCount === 1 ? '' : 's'} this calendar month
                  </small>
                </div>
                <div
                  style={{
                    padding: '8px',
                    borderRadius: '8px',
                    background: 'rgba(16, 185, 129, 0.1)',
                    color: 'var(--success, #10b981)',
                  }}
                >
                  <TrendingUp size={20} />
                </div>
              </div>
            </Card>

            {/* 3. Month's GST */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted, #6b7280)', fontWeight: 600 }}>
                    This Month&apos;s GST
                  </p>
                  <h2 style={{ margin: '0.35rem 0', fontSize: '1.45rem', fontWeight: 800 }}>
                    {money((data.sales?.monthGstPaise || 0) / 100)}
                  </h2>
                  <small style={{ color: 'var(--text-muted, #6b7280)' }}>
                    CGST, SGST &amp; IGST collected
                  </small>
                </div>
                <div
                  style={{
                    padding: '8px',
                    borderRadius: '8px',
                    background: 'rgba(245, 158, 11, 0.1)',
                    color: '#d97706',
                  }}
                >
                  <FileText size={20} />
                </div>
              </div>
            </Card>

            {/* 4. Total Customer Outstanding */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted, #6b7280)', fontWeight: 600 }}>
                    Customer Outstanding
                  </p>
                  <h2 style={{ margin: '0.35rem 0', fontSize: '1.45rem', fontWeight: 800, color: (data.dues?.totalCustomerOutstandingPaise || 0) > 0 ? 'var(--danger, #dc2626)' : 'inherit' }}>
                    {money((data.dues?.totalCustomerOutstandingPaise || 0) / 100)}
                  </h2>
                  <small style={{ color: 'var(--text-muted, #6b7280)' }}>
                    Total uncollected invoice balances
                  </small>
                </div>
                <div
                  style={{
                    padding: '8px',
                    borderRadius: '8px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    color: 'var(--danger, #ef4444)',
                  }}
                >
                  <Users size={20} />
                </div>
              </div>
            </Card>

            {/* 5. Money Received Today */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted, #6b7280)', fontWeight: 600 }}>
                    Money Received Today
                  </p>
                  <h2 style={{ margin: '0.35rem 0', fontSize: '1.45rem', fontWeight: 800, color: 'var(--success, #16a34a)' }}>
                    {money((data.payments?.moneyReceivedTodayPaise || 0) / 100)}
                  </h2>
                  <small style={{ color: 'var(--text-muted, #6b7280)' }}>
                    {data.payments?.receivedTodayCount || 0} receipt{data.payments?.receivedTodayCount === 1 ? '' : 's'} recorded today
                  </small>
                </div>
                <div
                  style={{
                    padding: '8px',
                    borderRadius: '8px',
                    background: 'rgba(22, 163, 74, 0.1)',
                    color: 'var(--success, #16a34a)',
                  }}
                >
                  <ArrowDownLeft size={20} />
                </div>
              </div>
            </Card>

            {/* 6. Money Paid Today */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted, #6b7280)', fontWeight: 600 }}>
                    Money Paid Today
                  </p>
                  <h2 style={{ margin: '0.35rem 0', fontSize: '1.45rem', fontWeight: 800, color: 'var(--danger, #dc2626)' }}>
                    {money((data.payments?.moneyPaidTodayPaise || 0) / 100)}
                  </h2>
                  <small style={{ color: 'var(--text-muted, #6b7280)' }}>
                    {data.payments?.paidTodayCount || 0} payment voucher{data.payments?.paidTodayCount === 1 ? '' : 's'} today
                  </small>
                </div>
                <div
                  style={{
                    padding: '8px',
                    borderRadius: '8px',
                    background: 'rgba(220, 38, 38, 0.1)',
                    color: 'var(--danger, #dc2626)',
                  }}
                >
                  <ArrowUpRight size={20} />
                </div>
              </div>
            </Card>
          </div>

          {/* Row 2: Tables & Detail Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
            {/* Recent Invoices */}
            <Card
              title="Recent Invoices"
              sub="Latest invoices issued to customers"
              actions={
                <Link className="text-link" href="/sales">
                  View all <ChevronRight size={14} />
                </Link>
              }
            >
              <div className="table-wrap" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border, #e5e7eb)', textAlign: 'left', color: 'var(--text-muted, #6b7280)' }}>
                      <th style={{ padding: '0.5rem 0.65rem' }}>Invoice #</th>
                      <th style={{ padding: '0.5rem 0.65rem' }}>Customer</th>
                      <th style={{ padding: '0.5rem 0.65rem', textAlign: 'right' }}>Total</th>
                      <th style={{ padding: '0.5rem 0.65rem', textAlign: 'right' }}>Due</th>
                      <th style={{ padding: '0.5rem 0.65rem', textAlign: 'center' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.recentInvoices || []).map((inv: any) => (
                      <tr key={inv.id} style={{ borderBottom: '1px solid var(--border-light, #f3f4f6)' }}>
                        <td style={{ padding: '0.55rem 0.65rem', fontWeight: 600 }}>
                          <Link href={`/sales/${inv.id}`} style={{ color: 'var(--primary, #6366f1)', textDecoration: 'none' }}>
                            {inv.invoiceNumber || inv.id}
                          </Link>
                        </td>
                        <td style={{ padding: '0.55rem 0.65rem' }}>{inv.customerName}</td>
                        <td style={{ padding: '0.55rem 0.65rem', textAlign: 'right', fontWeight: 600 }}>
                          {money((inv.totalPaise || 0) / 100)}
                        </td>
                        <td style={{ padding: '0.55rem 0.65rem', textAlign: 'right', color: inv.duePaise > 0 ? 'var(--danger, #dc2626)' : 'var(--text-muted, #6b7280)' }}>
                          {money((inv.duePaise || 0) / 100)}
                        </td>
                        <td style={{ padding: '0.55rem 0.65rem', textAlign: 'center' }}>
                          <Badge>
                            {inv.duePaise === 0 ? 'Paid' : 'Unpaid'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                    {(!data.recentInvoices || data.recentInvoices.length === 0) && (
                      <tr>
                        <td colSpan={5} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted, #6b7280)' }}>
                          No invoices issued yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Outstanding Invoices Requiring Attention */}
            <Card
              title="Outstanding Dues Requiring Attention"
              sub="Uncollected invoices with pending balances"
              actions={
                <Link className="text-link" href="/reports?report=Customer+outstanding">
                  All dues <ChevronRight size={14} />
                </Link>
              }
            >
              <div className="table-wrap" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border, #e5e7eb)', textAlign: 'left', color: 'var(--text-muted, #6b7280)' }}>
                      <th style={{ padding: '0.5rem 0.65rem' }}>Invoice #</th>
                      <th style={{ padding: '0.5rem 0.65rem' }}>Customer</th>
                      <th style={{ padding: '0.5rem 0.65rem' }}>Due Date</th>
                      <th style={{ padding: '0.5rem 0.65rem', textAlign: 'right' }}>Pending Due</th>
                      <th style={{ padding: '0.5rem 0.65rem', textAlign: 'center' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.outstandingInvoices || []).map((inv: any) => (
                      <tr key={inv.id} style={{ borderBottom: '1px solid var(--border-light, #f3f4f6)' }}>
                        <td style={{ padding: '0.55rem 0.65rem', fontWeight: 600 }}>
                          <Link href={`/sales/${inv.id}`} style={{ color: 'var(--primary, #6366f1)', textDecoration: 'none' }}>
                            {inv.invoiceNumber || inv.id}
                          </Link>
                        </td>
                        <td style={{ padding: '0.55rem 0.65rem' }}>{inv.customerName}</td>
                        <td style={{ padding: '0.55rem 0.65rem', color: 'var(--text-muted, #6b7280)', fontSize: '0.82rem' }}>
                          {inv.dueDate || inv.date || '—'}
                        </td>
                        <td style={{ padding: '0.55rem 0.65rem', textAlign: 'right', fontWeight: 700, color: 'var(--danger, #dc2626)' }}>
                          {money((inv.duePaise || 0) / 100)}
                        </td>
                        <td style={{ padding: '0.55rem 0.65rem', textAlign: 'center' }}>
                          <Link
                            href={`/payments`}
                            className="btn secondary"
                            style={{ padding: '3px 8px', fontSize: '0.75rem' }}
                          >
                            Receive
                          </Link>
                        </td>
                      </tr>
                    ))}
                    {(!data.outstandingInvoices || data.outstandingInvoices.length === 0) && (
                      <tr>
                        <td colSpan={5} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--success, #16a34a)' }}>
                          All customer invoices are settled! No overdue balances.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          {/* Row 3: Recent Activity (Receipts & Vouchers) & Print Jobs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
            {/* Recent Payments (Receipts & Vouchers) */}
            <Card
              title="Recent Payments & Vouchers"
              sub="Latest cash & bank transactions"
              actions={
                <Link className="text-link" href="/payments">
                  Payments ledger <ChevronRight size={14} />
                </Link>
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {(data.recentReceipts || []).slice(0, 3).map((r: any) => (
                  <div
                    key={r.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '0.65rem 0.75rem',
                      background: 'rgba(22, 163, 74, 0.04)',
                      border: '1px solid rgba(22, 163, 74, 0.15)',
                      borderRadius: '6px',
                      fontSize: '0.85rem',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--success, #16a34a)' }}>
                        <ArrowDownLeft size={13} style={{ display: 'inline', marginRight: '3px' }} />
                        Receipt {r.receiptNumber} · {r.customerName}
                      </div>
                      <small style={{ color: 'var(--text-muted, #6b7280)' }}>
                        Inv: {r.invoiceNumber} · Mode: {r.method} · {r.date}
                      </small>
                    </div>
                    <div style={{ fontWeight: 700, color: 'var(--success, #16a34a)', fontSize: '0.95rem' }}>
                      +{money((r.amountPaise || 0) / 100)}
                    </div>
                  </div>
                ))}

                {(data.recentVouchers || []).slice(0, 3).map((v: any) => (
                  <div
                    key={v.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '0.65rem 0.75rem',
                      background: 'rgba(220, 38, 38, 0.04)',
                      border: '1px solid rgba(220, 38, 38, 0.15)',
                      borderRadius: '6px',
                      fontSize: '0.85rem',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--danger, #dc2626)' }}>
                        <ArrowUpRight size={13} style={{ display: 'inline', marginRight: '3px' }} />
                        Voucher {v.voucherNumber} · Paid to {v.payeeName}
                      </div>
                      <small style={{ color: 'var(--text-muted, #6b7280)' }}>
                        Purpose: {v.purpose} · {v.account} ({v.method}) · {v.date}
                      </small>
                    </div>
                    <div style={{ fontWeight: 700, color: 'var(--danger, #dc2626)', fontSize: '0.95rem' }}>
                      -{money((v.amountPaise || 0) / 100)}
                    </div>
                  </div>
                ))}

                {(!data.recentReceipts?.length && !data.recentVouchers?.length) && (
                  <p style={{ textAlign: 'center', color: 'var(--text-muted, #6b7280)', padding: '1rem' }}>
                    No payment receipts or vouchers recorded yet.
                  </p>
                )}
              </div>
            </Card>

            {/* Print Jobs Status & Quick Actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Print Jobs Overview */}
              <Card
                title="Print Jobs by Status"
                sub="Production workflow in the press"
                actions={
                  <Link className="text-link" href="/print-jobs">
                    All jobs <ChevronRight size={14} />
                  </Link>
                }
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: '0.75rem', textAlign: 'center' }}>
                  <div style={{ padding: '0.75rem 0.5rem', background: 'var(--surface-muted, #f9fafb)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{data.printJobsByStatus?.Queued || 0}</div>
                    <small style={{ color: 'var(--text-muted, #6b7280)' }}>Queued</small>
                  </div>
                  <div style={{ padding: '0.75rem 0.5rem', background: 'rgba(99, 102, 241, 0.08)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--primary, #6366f1)' }}>
                      {data.printJobsByStatus?.Printing || 0}
                    </div>
                    <small style={{ color: 'var(--primary, #6366f1)', fontWeight: 600 }}>Printing</small>
                  </div>
                  <div style={{ padding: '0.75rem 0.5rem', background: 'rgba(16, 185, 129, 0.08)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--success, #10b981)' }}>
                      {data.printJobsByStatus?.Completed || 0}
                    </div>
                    <small style={{ color: 'var(--success, #10b981)', fontWeight: 600 }}>Completed</small>
                  </div>
                  <div style={{ padding: '0.75rem 0.5rem', background: 'var(--surface-muted, #f9fafb)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{data.printJobsByStatus?.Delivered || 0}</div>
                    <small style={{ color: 'var(--text-muted, #6b7280)' }}>Delivered</small>
                  </div>
                </div>
              </Card>

              {/* Quick Actions */}
              <Card title="Quick Actions" sub="Frequently used billing workflows">
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                    gap: '0.5rem',
                  }}
                >
                  <Link className="btn secondary" href="/sales/new" style={{ fontSize: '0.8rem', padding: '0.45rem' }}>
                    + New Invoice
                  </Link>
                  <Link className="btn secondary" href="/payments" style={{ fontSize: '0.8rem', padding: '0.45rem' }}>
                    + Record Receipt
                  </Link>
                  <Link className="btn secondary" href="/payments" style={{ fontSize: '0.8rem', padding: '0.45rem' }}>
                    + Payment Voucher
                  </Link>
                  <Link className="btn secondary" href="/customers" style={{ fontSize: '0.8rem', padding: '0.45rem' }}>
                    + Add Customer
                  </Link>
                  <Link className="btn secondary" href="/inventory" style={{ fontSize: '0.8rem', padding: '0.45rem' }}>
                    + Add Product
                  </Link>
                  <Link className="btn secondary" href="/service-catalog" style={{ fontSize: '0.8rem', padding: '0.45rem' }}>
                    + Add Service
                  </Link>
                  <Link className="btn secondary" href="/print-jobs" style={{ fontSize: '0.8rem', padding: '0.45rem' }}>
                    + New Print Job
                  </Link>
                  <Link className="btn secondary" href="/reports" style={{ fontSize: '0.8rem', padding: '0.45rem' }}>
                    Open Reports
                  </Link>
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
