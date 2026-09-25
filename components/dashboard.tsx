'use client';

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import Link from 'next/link';
import {
  AlertCircle, ArrowDownLeft, ArrowUpRight, ChevronRight, FileText,
  IndianRupee, Plus, Printer, Receipt, RefreshCw, TrendingUp, Users,
} from 'lucide-react';
import {useStore} from './store';
import {Badge, Btn, Card, PageHead} from './ui';
import {balance, money, roundedTotal, TODAY, totals} from '@/lib/domain';

type DashboardData = {
  sales: {todayTotalPaise: number; todayCount: number; monthTotalPaise: number; monthGstPaise: number; monthCount: number};
  dues: {totalCustomerOutstandingPaise: number};
  payments: {moneyReceivedTodayPaise: number; receivedTodayCount: number; moneyPaidTodayPaise: number; paidTodayCount: number};
  customerCount: number;
  printJobsByStatus: Record<string, number>;
  recentInvoices: any[];
  outstandingInvoices: any[];
  recentReceipts: any[];
  recentVouchers: any[];
};

type MetricProps = {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  tone: 'violet' | 'green' | 'amber' | 'red' | 'blue';
};

function MetricCard({label, value, hint, icon, tone}: MetricProps) {
  return (
    <article className="dashboard-metric">
      <div className={`dashboard-metric-icon ${tone}`}>{icon}</div>
      <div className="dashboard-metric-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{hint}</small>
      </div>
    </article>
  );
}

function EmptyRows({columns, text}: {columns: number; text: string}) {
  return <tr><td className="dashboard-empty-row" colSpan={columns}>{text}</td></tr>;
}

export default function Dashboard() {
  const {state, isLive} = useStore();
  const [liveData, setLiveData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLiveDashboard = useCallback(async () => {
    if (!isLive) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/company/dashboard', {cache: 'no-store'});
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Failed to load live dashboard statistics.');
      setLiveData(payload);
    } catch (cause) {
      setLiveData(null);
      setError(cause instanceof Error ? cause.message : 'Unable to connect to live billing data.');
    } finally {
      setLoading(false);
    }
  }, [isLive]);

  useEffect(() => {
    if (isLive) void fetchLiveDashboard();
    else {
      setLiveData(null);
      setError(null);
    }
  }, [isLive, fetchLiveDashboard]);

  const demoData = useMemo<DashboardData | null>(() => {
    if (isLive) return null;
    const invoices = state.bills.filter((bill: any) => bill.kind !== 'Quotation' && bill.status === 'Issued');
    const todayInvoices = invoices.filter((bill: any) => bill.date === TODAY);
    const monthInvoices = invoices.filter((bill: any) => bill.date?.slice(0, 7) === TODAY.slice(0, 7));
    const receipts = state.payments.filter((payment: any) => payment.direction === 'In' && payment.date === TODAY);
    const vouchers = state.payments.filter((payment: any) => payment.direction === 'Out' && payment.date === TODAY);

    return {
      sales: {
        todayTotalPaise: Math.round(todayInvoices.reduce((sum, bill) => sum + roundedTotal(bill), 0) * 100),
        todayCount: todayInvoices.length,
        monthTotalPaise: Math.round(monthInvoices.reduce((sum, bill) => sum + roundedTotal(bill), 0) * 100),
        monthGstPaise: Math.round(monthInvoices.reduce((sum, bill) => sum + totals(bill).tax, 0) * 100),
        monthCount: monthInvoices.length,
      },
      dues: {totalCustomerOutstandingPaise: Math.round(invoices.reduce((sum, bill) => sum + balance(state, bill), 0) * 100)},
      payments: {
        moneyReceivedTodayPaise: Math.round(receipts.reduce((sum: number, payment: any) => sum + payment.amount, 0) * 100),
        receivedTodayCount: receipts.length,
        moneyPaidTodayPaise: Math.round(vouchers.reduce((sum: number, payment: any) => sum + payment.amount, 0) * 100),
        paidTodayCount: vouchers.length,
      },
      customerCount: state.customers.length,
      printJobsByStatus: {
        Queued: state.jobs.filter((job: any) => ['Received', 'Queued'].includes(job.status)).length,
        Printing: state.jobs.filter((job: any) => ['In Progress', 'Printing'].includes(job.status)).length,
        Completed: state.jobs.filter((job: any) => job.status === 'Completed').length,
        Delivered: state.jobs.filter((job: any) => job.status === 'Delivered').length,
      },
      recentInvoices: invoices.slice(0, 5).map((bill: any) => ({
        id: bill.id,
        invoiceNumber: bill.id,
        customerName: state.customers.find((customer: any) => customer.id === bill.customerId)?.name || 'Customer',
        date: bill.date,
        dueDate: bill.due,
        totalPaise: Math.round(roundedTotal(bill) * 100),
        duePaise: Math.round(balance(state, bill) * 100),
      })),
      outstandingInvoices: invoices.filter((bill: any) => balance(state, bill) > 0).slice(0, 5).map((bill: any) => ({
        id: bill.id,
        invoiceNumber: bill.id,
        customerName: state.customers.find((customer: any) => customer.id === bill.customerId)?.name || 'Customer',
        dueDate: bill.due,
        duePaise: Math.round(balance(state, bill) * 100),
      })),
      recentReceipts: state.payments.filter((payment: any) => payment.direction === 'In').slice(0, 5).map((payment: any) => ({
        id: payment.id, receiptNumber: payment.id, customerName: state.customers.find((customer: any) => customer.id === payment.party)?.name || payment.party || 'Customer',
        invoiceNumber: payment.reference || 'Invoice', amountPaise: Math.round(payment.amount * 100), method: payment.account, date: payment.date,
      })),
      recentVouchers: state.payments.filter((payment: any) => payment.direction === 'Out').slice(0, 5).map((payment: any) => ({
        id: payment.id, voucherNumber: payment.id, payeeName: payment.party || 'Payee',
        purpose: payment.purpose, amountPaise: Math.round(payment.amount * 100), method: payment.account, date: payment.date,
      })),
    };
  }, [isLive, state]);

  const data = isLive ? liveData : demoData;
  const activities = data ? [
    ...data.recentReceipts.map(item => ({...item, kind: 'Receipt', label: item.receiptNumber, party: item.customerName, detail: `${item.invoiceNumber} · ${item.method}`, amountPaise: item.amountPaise, href: '/payments'})),
    ...data.recentVouchers.map(item => ({...item, kind: 'Voucher', label: item.voucherNumber, party: item.payeeName, detail: `${item.purpose || 'Payment'} · ${item.method || item.account}`, amountPaise: item.amountPaise, href: '/payments'})),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 6) : [];

  return <>
    <PageHead
      title="Dashboard"
      description="Sales, GST, customer dues, receipts and payment vouchers from your billing records."
      actions={<div className="dashboard-actions">
        <Link className="btn" href="/sales/new"><Plus size={16}/>New invoice</Link>
        <Link className="btn secondary" href="/payments"><ArrowDownLeft size={16}/>Receive money</Link>
        <Link className="btn secondary" href="/payments"><ArrowUpRight size={16}/>Pay money</Link>
      </div>}
    />

    {isLive && error && <div className="dashboard-error" role="alert">
      <AlertCircle size={21}/>
      <div><strong>Live dashboard unavailable</strong><span>{error}</span></div>
      <Btn secondary onClick={fetchLiveDashboard} disabled={loading}><RefreshCw size={15}/>{loading ? 'Retrying…' : 'Retry'}</Btn>
    </div>}

    {isLive && loading && !data && <div className="dashboard-loading" role="status">
      <RefreshCw className="spin" size={25}/><strong>Loading live billing data</strong><span>Your company records are being retrieved securely.</span>
    </div>}

    {data && <div className="dashboard-shell">
      <section className="dashboard-primary-grid" aria-label="Billing summary">
        <MetricCard label="Today’s sales" value={money(data.sales.todayTotalPaise / 100)} hint={`${data.sales.todayCount} invoice${data.sales.todayCount === 1 ? '' : 's'} issued`} icon={<IndianRupee size={21}/>} tone="violet"/>
        <MetricCard label="This month’s sales" value={money(data.sales.monthTotalPaise / 100)} hint={`${data.sales.monthCount} invoice${data.sales.monthCount === 1 ? '' : 's'} this month`} icon={<TrendingUp size={21}/>} tone="green"/>
        <MetricCard label="This month’s GST" value={money(data.sales.monthGstPaise / 100)} hint="CGST, SGST and IGST" icon={<FileText size={21}/>} tone="amber"/>
        <MetricCard label="Customer outstanding" value={money(data.dues.totalCustomerOutstandingPaise / 100)} hint="Uncollected invoice balances" icon={<Users size={21}/>} tone="red"/>
      </section>

      <section className="dashboard-cash-grid" aria-label="Today’s payment activity">
        <MetricCard label="Money received today" value={money(data.payments.moneyReceivedTodayPaise / 100)} hint={`${data.payments.receivedTodayCount} receipt${data.payments.receivedTodayCount === 1 ? '' : 's'} recorded`} icon={<ArrowDownLeft size={22}/>} tone="green"/>
        <MetricCard label="Money paid today" value={money(data.payments.moneyPaidTodayPaise / 100)} hint={`${data.payments.paidTodayCount} payment voucher${data.payments.paidTodayCount === 1 ? '' : 's'}`} icon={<ArrowUpRight size={22}/>} tone="red"/>
      </section>

      <section className="dashboard-content-grid">
        <Card title="Recent invoices" sub="Latest invoices issued to customers" actions={<Link className="text-link" href="/sales">View all <ChevronRight size={14}/></Link>}>
          <div className="table-wrap"><table className="dashboard-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Due</th><th>Status</th></tr></thead><tbody>
            {data.recentInvoices.map(invoice => <tr key={invoice.id}><td><Link className="record-link" href={`/sales/${invoice.id}`}>{invoice.invoiceNumber}</Link><small>{invoice.date}</small></td><td>{invoice.customerName}</td><td className="amount">{money(invoice.totalPaise / 100)}</td><td className={invoice.duePaise > 0 ? 'dashboard-due' : ''}>{money(invoice.duePaise / 100)}</td><td><Badge>{invoice.paymentStatus === 'PartlyPaid' ? 'Partly paid' : invoice.paymentStatus || (invoice.duePaise === 0 ? 'Paid' : invoice.duePaise < invoice.totalPaise ? 'Partly paid' : 'Unpaid')}</Badge></td></tr>)}
            {!data.recentInvoices.length && <EmptyRows columns={5} text="No invoices issued yet."/>}
          </tbody></table></div>
        </Card>

        <Card title="Outstanding invoices" sub="Invoices that still need customer payment" actions={<Link className="text-link" href="/reports?report=Customer+outstanding">View report <ChevronRight size={14}/></Link>}>
          <div className="table-wrap"><table className="dashboard-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Due date</th><th>Pending</th><th/></tr></thead><tbody>
            {data.outstandingInvoices.map(invoice => <tr key={invoice.id}><td><Link className="record-link" href={`/sales/${invoice.id}`}>{invoice.invoiceNumber}</Link></td><td>{invoice.customerName}</td><td>{invoice.dueDate || '—'}</td><td className="dashboard-due amount">{money(invoice.duePaise / 100)}</td><td><Link className="text-link" href="/payments">Receive</Link></td></tr>)}
            {!data.outstandingInvoices.length && <EmptyRows columns={5} text="No outstanding invoices."/>}
          </tbody></table></div>
        </Card>
      </section>

      <section className="dashboard-lower-grid">
        <Card title="Recent receipts and vouchers" sub="Latest money received and paid" actions={<Link className="text-link" href="/payments">Open ledger <ChevronRight size={14}/></Link>}>
          <div className="dashboard-activity-list">
            {activities.map(item => <Link href={item.href} key={`${item.kind}-${item.id}`} className="dashboard-activity">
              <span className={`dashboard-activity-icon ${item.kind === 'Receipt' ? 'received' : 'paid'}`}>{item.kind === 'Receipt' ? <Receipt size={17}/> : <ArrowUpRight size={17}/>}</span>
              <span><strong>{item.party}</strong><small>{item.label} · {item.detail} · {item.date}</small></span>
              <b className={item.kind === 'Receipt' ? 'received' : 'paid'}>{item.kind === 'Receipt' ? '+' : '−'}{money(item.amountPaise / 100)}</b>
            </Link>)}
            {!activities.length && <div className="dashboard-empty-block">No receipts or payment vouchers recorded yet.</div>}
          </div>
        </Card>

        <div className="dashboard-side-stack">
          <Card title="Print jobs" sub="Current production workload" actions={<Link className="text-link" href="/print-jobs">All jobs <ChevronRight size={14}/></Link>}>
            <div className="dashboard-job-grid">{['Queued', 'Printing', 'Completed', 'Delivered'].map(status => <div key={status}><strong>{data.printJobsByStatus[status] || 0}</strong><span>{status}</span></div>)}</div>
          </Card>
          <Card title="Quick actions" sub="Common billing tasks">
            <div className="dashboard-quick-grid">
              <Link href="/customers"><Users size={17}/>Add customer</Link>
              <Link href="/inventory"><Plus size={17}/>Add product</Link>
              <Link href="/service-catalog"><Printer size={17}/>Add service</Link>
              <Link href="/print-jobs"><FileText size={17}/>New print job</Link>
            </div>
          </Card>
        </div>
      </section>
    </div>}
  </>;
}
