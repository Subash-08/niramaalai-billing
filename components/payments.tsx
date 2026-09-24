'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Plus,
  Printer,
  Download,
  Eye,
} from 'lucide-react';
import { useStore } from './store';
import { PageHead, Card, Btn, Modal, Empty, Badge } from './ui';
import { money, TODAY, uid, roundedTotal } from '@/lib/domain';
import { amountWords } from '@/lib/amount-words';
import { receiptPdfBytes, paymentVoucherPdfBytes, downloadBytes } from '@/lib/exports';
import SearchSelect from './search-select';

interface UnpaidInvoice {
  id: string;
  invoiceNumber: string;
  date: string;
  grandTotalPaise?: number;
  total?: number;
  duePaise: number;
  due?: number;
}

export default function Payments({ id }: { id?: string }) {
  const {
    state,
    isLive,
    notify,
    fetchCustomerReceiptsPage,
    fetchPaymentVouchersPage,
  } = useStore();

  const [activeTab, setActiveTab] = useState<'received' | 'paid'>('received');


  // Server summary totals (never bound to single page)
  const [summaryTotals, setSummaryTotals] = useState<{
    totalReceivedPaise: number;
    totalPaidPaise: number;
    receiptCount: number;
    voucherCount: number;
  }>({
    totalReceivedPaise: 0,
    totalPaidPaise: 0,
    receiptCount: 0,
    voucherCount: 0,
  });

  // Receipt list & pagination state
  const [receipts, setReceipts] = useState<any[]>([]);
  const [receiptsTotal, setReceiptsTotal] = useState(0);
  const [receiptPage, setReceiptPage] = useState(1);
  const [receiptLimit, setReceiptLimit] = useState(25);
  const [receiptTotalPages, setReceiptTotalPages] = useState(1);
  const [receiptSearch, setReceiptSearch] = useState('');
  const [receiptDateFrom, setReceiptDateFrom] = useState('');
  const [receiptDateTo, setReceiptDateTo] = useState('');
  const [receiptCustomerFilter, setReceiptCustomerFilter] = useState('');
  const [loadingReceipts, setLoadingReceipts] = useState(false);

  // Voucher list & pagination state
  const [vouchers, setVouchers] = useState<any[]>([]);
  const [vouchersTotal, setVouchersTotal] = useState(0);
  const [voucherPage, setVoucherPage] = useState(1);
  const [voucherLimit, setVoucherLimit] = useState(25);
  const [voucherTotalPages, setVoucherTotalPages] = useState(1);
  const [voucherSearch, setVoucherSearch] = useState('');
  const [voucherDateFrom, setVoucherDateFrom] = useState('');
  const [voucherDateTo, setVoucherDateTo] = useState('');
  const [loadingVouchers, setLoadingVouchers] = useState(false);

  // Modals
  const [recordReceiptOpen, setRecordReceiptOpen] = useState(false);
  const [recordVoucherOpen, setRecordVoucherOpen] = useState(false);
  const [previewReceipt, setPreviewReceipt] = useState<any | null>(null);
  const [previewVoucher, setPreviewVoucher] = useState<any | null>(null);

  // Load server-side summary totals
  const refreshSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/payments/summary');
      if (res.ok) {
        const json = await res.json();
        setSummaryTotals(json);
      }
    } catch {}
  }, []);


  // Load Receipts with real pagination
  const loadReceipts = useCallback(async () => {
    setLoadingReceipts(true);
    try {
      const res = await fetchCustomerReceiptsPage({
        page: receiptPage,
        limit: receiptLimit,
        search: receiptSearch || undefined,
        customerId: receiptCustomerFilter || undefined,
        dateFrom: receiptDateFrom || undefined,
        dateTo: receiptDateTo || undefined,
      });
      setReceipts(res.items || []);
      setReceiptsTotal(res.total || 0);
      setReceiptTotalPages(res.totalPages || 1);
    } catch (e: any) {
      if (isLive) notify(e.message || 'Failed to load receipts.');
    } finally {
      setLoadingReceipts(false);
    }
  }, [fetchCustomerReceiptsPage, receiptPage, receiptLimit, receiptSearch, receiptCustomerFilter, receiptDateFrom, receiptDateTo, isLive, notify]);

  // Load Vouchers with real pagination
  const loadVouchers = useCallback(async () => {
    setLoadingVouchers(true);
    try {
      const res = await fetchPaymentVouchersPage({
        page: voucherPage,
        limit: voucherLimit,
        search: voucherSearch || undefined,
        dateFrom: voucherDateFrom || undefined,
        dateTo: voucherDateTo || undefined,
      });
      setVouchers(res.items || []);
      setVouchersTotal(res.total || 0);
      setVoucherTotalPages(res.totalPages || 1);
    } catch (e: any) {
      if (isLive) notify(e.message || 'Failed to load payment vouchers.');
    } finally {
      setLoadingVouchers(false);
    }
  }, [fetchPaymentVouchersPage, voucherPage, voucherLimit, voucherSearch, voucherDateFrom, voucherDateTo, isLive, notify]);

  useEffect(() => {
    refreshSummary();
  }, [refreshSummary]);

  useEffect(() => {
    if (activeTab === 'received') {
      loadReceipts();
    } else {
      loadVouchers();
    }
  }, [activeTab, loadReceipts, loadVouchers]);

  // If specific receipt / voucher ID passed in props
  useEffect(() => {
    if (id) {
      if (id.startsWith('RCP')) {
        const found = receipts.find((r) => r._id === id || r.receiptNumber === id);
        if (found) setPreviewReceipt(found);
      } else if (id.startsWith('PV')) {
        const found = vouchers.find((v) => v._id === id || v.voucherNumber === id);
        if (found) setPreviewVoucher(found);
      }
    }
  }, [id, receipts, vouchers]);

  return (
    <div className="payments-page" style={{ padding: '0 0 3rem 0' }}>
      <PageHead
        title="Payments & receipts"
        description="Record single-invoice customer payments, manage outgoing expense vouchers, and view printable records."
        actions={
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Btn
              onClick={() => {
                setRecordReceiptOpen(true);
              }}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <ArrowDownLeft size={16} />
              Record receipt
            </Btn>
            <Btn
              secondary
              onClick={() => {
                setRecordVoucherOpen(true);
              }}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <ArrowUpRight size={16} />
              Record payment voucher
            </Btn>
          </div>
        }
      />

      {/* Summary Cards */}
      <div
        className="summary-cards-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border, #e5e7eb)', marginBottom: '1.5rem' }}>
        <button
          type="button"
          onClick={() => setActiveTab('received')}
          style={{
            padding: '0.75rem 1.25rem',
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'received' ? '2px solid var(--primary, #6366f1)' : '2px solid transparent',
            color: activeTab === 'received' ? 'var(--primary, #6366f1)' : 'var(--text-muted, #6b7280)',
            fontWeight: 600,
            fontSize: '0.95rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <ArrowDownLeft size={18} />
          Money received (Customer Receipts)
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('paid')}
          style={{
            padding: '0.75rem 1.25rem',
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'paid' ? '2px solid var(--primary, #6366f1)' : '2px solid transparent',
            color: activeTab === 'paid' ? 'var(--primary, #6366f1)' : 'var(--text-muted, #6b7280)',
            fontWeight: 600,
            fontSize: '0.95rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <ArrowUpRight size={18} />
          Money paid (Payment Vouchers)
        </button>
      </div>

      {/* Tab 1: Money Received (Customer Receipts) */}
      {activeTab === 'received' && (
        <Card title="Customer Receipts" sub="Single-invoice settlement receipts recorded for customer billing.">
          {/* Filters Bar */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              alignItems: 'center',
              marginBottom: '1.25rem',
              padding: '0.75rem',
              background: 'var(--surface-muted, #f9fafb)',
              borderRadius: '6px',
            }}
          >
            <div style={{ flex: '1 1 200px', minWidth: '180px' }}>
              <input
                type="text"
                placeholder="Search receipt #, invoice #..."
                value={receiptSearch}
                onChange={(e) => { setReceiptSearch(e.target.value); setReceiptPage(1); }}
                style={{
                  width: '100%',
                  padding: '0.45rem 0.65rem',
                  fontSize: '0.85rem',
                  borderRadius: '4px',
                  border: '1px solid var(--border, #d1d5db)',
                }}
              />
            </div>
            <div style={{ flex: '1 1 200px', minWidth: '180px' }}>
              <SearchSelect
                placeholder="Filter by customer..."
                value={receiptCustomerFilter}
                options={state.customers.map((c: any) => ({
                  value: c.id,
                  label: c.name,
                  sublabel: c.phone,
                }))}
                onSearch={async (query, signal) => {
                  if (!isLive) {
                    const qLower = query.toLowerCase();
                    return state.customers
                      .filter((c: any) => c.name.toLowerCase().includes(qLower) || c.phone.includes(qLower))
                      .map((c: any) => ({
                        value: c.id,
                        label: c.name,
                        sublabel: c.phone,
                      }));
                  }
                  const res = await fetch(`/api/master/customers?q=${encodeURIComponent(query)}&limit=30`, { signal });
                  if (!res.ok) return [];
                  const data = await res.json();
                  return (data.records || []).map((c: any) => ({
                    value: c._id || c.id,
                    label: c.name,
                    sublabel: c.phone,
                  }));
                }}
                onChange={(val) => { setReceiptCustomerFilter(val); setReceiptPage(1); }}
                onClear={() => { setReceiptCustomerFilter(''); setReceiptPage(1); }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted, #6b7280)' }}>From:</span>
              <input
                type="date"
                value={receiptDateFrom}
                onChange={(e) => { setReceiptDateFrom(e.target.value); setReceiptPage(1); }}
                style={{
                  padding: '0.4rem 0.5rem',
                  fontSize: '0.85rem',
                  borderRadius: '4px',
                  border: '1px solid var(--border, #d1d5db)',
                }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted, #6b7280)' }}>To:</span>
              <input
                type="date"
                value={receiptDateTo}
                onChange={(e) => { setReceiptDateTo(e.target.value); setReceiptPage(1); }}
                style={{
                  padding: '0.4rem 0.5rem',
                  fontSize: '0.85rem',
                  borderRadius: '4px',
                  border: '1px solid var(--border, #d1d5db)',
                }}
              />
            </div>
            <Btn
              secondary
              onClick={() => {
                setReceiptSearch('');
                setReceiptCustomerFilter('');
                setReceiptDateFrom('');
                setReceiptDateTo('');
                setReceiptPage(1);
              }}
            >
              Reset
            </Btn>
          </div>

          {/* Table */}
          {loadingReceipts ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted, #6b7280)' }}>
              Loading receipts...
            </div>
          ) : receipts.length === 0 ? (
            <Empty
              title="No customer receipts found"
              text="Record a payment against an unpaid invoice to issue your first receipt."
              action={
                <Btn onClick={() => setRecordReceiptOpen(true)}>
                  <Plus size={16} /> Record receipt
                </Btn>
              }
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border, #e5e7eb)', textAlign: 'left' }}>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Receipt #</th>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Date</th>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Customer</th>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Invoice</th>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Payment Mode</th>
                    <th style={{ padding: '0.65rem 0.75rem', textAlign: 'right' }}>Amount Paid</th>
                    <th style={{ padding: '0.65rem 0.75rem', textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((r) => {
                    const rNum = r.receiptNumber || r._id;
                    const rDate = r.date || String(r.createdAt || '').slice(0, 10);
                    const custName = r.customerSnapshot?.name || state.customers.find((c: any) => c.id === r.customerId)?.name || 'Customer';
                    const targetInvoice = r.allocations?.[0]?.targetId || r.invoiceId || '-';
                    const comp = r.components?.[0] || {};
                    const method = comp.method || r.method || 'Cash';
                    const amt = (r.amountPaise || comp.amountPaise || 0) / 100;

                    return (
                      <tr key={r._id || r.id} style={{ borderBottom: '1px solid var(--border, #f3f4f6)' }}>
                        <td style={{ padding: '0.65rem 0.75rem', fontWeight: 600 }}>
                          <span style={{ color: 'var(--primary, #6366f1)' }}>{rNum}</span>
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem', color: 'var(--text-muted, #6b7280)' }}>
                          {rDate}
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem', fontWeight: 500 }}>
                          {custName}
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem' }}>
                          <span style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{targetInvoice}</span>
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem' }}>
                          <Badge>{method}</Badge>
                          {comp.reference && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #9ca3af)' }}>
                              Ref: {comp.reference}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem', textAlign: 'right', fontWeight: 700 }}>
                          {money(amt)}
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem', textAlign: 'center' }}>
                          <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                            <button
                              type="button"
                              className="btn secondary"
                              style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                              onClick={() => setPreviewReceipt(r)}
                              title="View & Print Receipt"
                            >
                              <Eye size={13} style={{ marginRight: '4px' }} /> View
                            </button>
                            <button
                              type="button"
                              className="btn secondary"
                              style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                              onClick={async () => {
                                try {
                                  const bytes = await receiptPdfBytes(state.settings, r);
                                  downloadBytes(`receipt-${rNum}.pdf`, bytes, 'application/pdf');
                                } catch (err: any) {
                                  notify('Failed to generate PDF: ' + err.message);
                                }
                              }}
                              title="Download PDF"
                            >
                              <Download size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination Controls */}
          {receiptsTotal > 0 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: '1.25rem',
                paddingTop: '0.75rem',
                borderTop: '1px solid var(--border, #e5e7eb)',
                flexWrap: 'wrap',
                gap: '0.75rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-muted, #6b7280)' }}>
                <span>Rows per page:</span>
                <select
                  value={receiptLimit}
                  onChange={(e) => {
                    setReceiptLimit(Number(e.target.value));
                    setReceiptPage(1);
                  }}
                  style={{
                    padding: '0.3rem 0.5rem',
                    borderRadius: '4px',
                    border: '1px solid var(--border, #d1d5db)',
                    fontSize: '0.85rem',
                  }}
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span>
                  Page {receiptPage} of {receiptTotalPages} ({receiptsTotal} total records)
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <Btn
                  secondary
                  disabled={receiptPage <= 1}
                  onClick={() => setReceiptPage((p) => Math.max(1, p - 1))}
                  style={{ padding: '0.35rem 0.75rem', fontSize: '0.82rem' }}
                >
                  Previous
                </Btn>
                <Btn
                  secondary
                  disabled={receiptPage >= receiptTotalPages}
                  onClick={() => setReceiptPage((p) => p + 1)}
                  style={{ padding: '0.35rem 0.75rem', fontSize: '0.82rem' }}
                >
                  Next
                </Btn>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Tab 2: Money Paid (Payment Vouchers) */}
      {activeTab === 'paid' && (
        <Card title="Payment Vouchers" sub="Outgoing expenses and cash/bank payment disbursements.">
          {/* Filters Bar */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              alignItems: 'center',
              marginBottom: '1.25rem',
              padding: '0.75rem',
              background: 'var(--surface-muted, #f9fafb)',
              borderRadius: '6px',
            }}
          >
            <div style={{ flex: '1 1 250px', minWidth: '200px' }}>
              <input
                type="text"
                placeholder="Search voucher #, payee, purpose..."
                value={voucherSearch}
                onChange={(e) => { setVoucherSearch(e.target.value); setVoucherPage(1); }}
                style={{
                  width: '100%',
                  padding: '0.45rem 0.65rem',
                  fontSize: '0.85rem',
                  borderRadius: '4px',
                  border: '1px solid var(--border, #d1d5db)',
                }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted, #6b7280)' }}>From:</span>
              <input
                type="date"
                value={voucherDateFrom}
                onChange={(e) => { setVoucherDateFrom(e.target.value); setVoucherPage(1); }}
                style={{
                  padding: '0.4rem 0.5rem',
                  fontSize: '0.85rem',
                  borderRadius: '4px',
                  border: '1px solid var(--border, #d1d5db)',
                }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted, #6b7280)' }}>To:</span>
              <input
                type="date"
                value={voucherDateTo}
                onChange={(e) => { setVoucherDateTo(e.target.value); setVoucherPage(1); }}
                style={{
                  padding: '0.4rem 0.5rem',
                  fontSize: '0.85rem',
                  borderRadius: '4px',
                  border: '1px solid var(--border, #d1d5db)',
                }}
              />
            </div>
            <Btn
              secondary
              onClick={() => {
                setVoucherSearch('');
                setVoucherDateFrom('');
                setVoucherDateTo('');
              }}
            >
              Reset
            </Btn>
          </div>

          {/* Table */}
          {loadingVouchers ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted, #6b7280)' }}>
              Loading payment vouchers...
            </div>
          ) : vouchers.length === 0 ? (
            <Empty
              title="No payment vouchers found"
              text="Record an outgoing business payment to create your first voucher."
              action={
                <Btn onClick={() => setRecordVoucherOpen(true)}>
                  <Plus size={16} /> Record payment voucher
                </Btn>
              }
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border, #e5e7eb)', textAlign: 'left' }}>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Voucher #</th>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Date</th>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Paid To</th>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Purpose</th>
                    <th style={{ padding: '0.65rem 0.75rem' }}>Payment Method</th>
                    <th style={{ padding: '0.65rem 0.75rem', textAlign: 'right' }}>Amount</th>
                    <th style={{ padding: '0.65rem 0.75rem', textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {vouchers.map((v) => {
                    const vNum = v.voucherNumber || v._id;
                    const vDate = v.date || String(v.createdAt || '').slice(0, 10);
                    const amt = (v.amountPaise || 0) / 100;

                    return (
                      <tr key={v._id || v.id} style={{ borderBottom: '1px solid var(--border, #f3f4f6)' }}>
                        <td style={{ padding: '0.65rem 0.75rem', fontWeight: 600 }}>
                          <span style={{ color: 'var(--primary, #6366f1)' }}>{vNum}</span>
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem', color: 'var(--text-muted, #6b7280)' }}>
                          {vDate}
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem', fontWeight: 500 }}>
                          {v.payeeName}
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem' }}>
                          <div>{v.purpose}</div>
                          {v.reference && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #9ca3af)' }}>
                              Ref: {v.reference}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem' }}>
                          <Badge>{v.method || 'Cash'}</Badge>
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem', textAlign: 'right', fontWeight: 700, color: 'var(--danger, #dc2626)' }}>
                          {money(amt)}
                        </td>
                        <td style={{ padding: '0.65rem 0.75rem', textAlign: 'center' }}>
                          <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                            <button
                              type="button"
                              className="btn secondary"
                              style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                              onClick={() => setPreviewVoucher(v)}
                              title="View & Print Voucher"
                            >
                              <Eye size={13} style={{ marginRight: '4px' }} /> View
                            </button>
                            <button
                              type="button"
                              className="btn secondary"
                              style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                              onClick={async () => {
                                try {
                                  const bytes = await paymentVoucherPdfBytes(state.settings, v);
                                  downloadBytes(`payment-voucher-${vNum}.pdf`, bytes, 'application/pdf');
                                } catch (err: any) {
                                  notify('Failed to generate PDF: ' + err.message);
                                }
                              }}
                              title="Download PDF"
                            >
                              <Download size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Record Receipt Modal */}
      {recordReceiptOpen && (
        <RecordReceiptModal
          isOpen={recordReceiptOpen}
          onClose={() => setRecordReceiptOpen(false)}
          onSuccess={(receipt) => {
            setRecordReceiptOpen(false);
            loadReceipts();
            refreshSummary();
            setPreviewReceipt(receipt);
          }}
        />
      )}

      {/* Record Voucher Modal */}
      {recordVoucherOpen && (
        <RecordVoucherModal
          isOpen={recordVoucherOpen}
          onClose={() => setRecordVoucherOpen(false)}
          onSuccess={(voucher) => {
            setRecordVoucherOpen(false);
            loadVouchers();
            refreshSummary();
            setPreviewVoucher(voucher);
          }}
        />
      )}

      {/* Receipt Preview Modal */}
      {previewReceipt && (
        <ReceiptPreviewModal
          receipt={previewReceipt}
          onClose={() => setPreviewReceipt(null)}
        />
      )}

      {/* Payment Voucher Preview Modal */}
      {previewVoucher && (
        <VoucherPreviewModal
          voucher={previewVoucher}
          onClose={() => setPreviewVoucher(null)}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------
// Record Customer Receipt Modal (Single Invoice Only)
// -------------------------------------------------------------
export function RecordReceiptModal({
  isOpen,
  preselectedInvoice,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  preselectedInvoice?: any;
  onClose: () => void;
  onSuccess: (receipt: any) => void;
}) {
  const { state, isLive, recordCustomerReceiptApi, notify } = useStore();

  const [customerId, setCustomerId] = useState(preselectedInvoice?.customerId || '');
  const [invoices, setInvoices] = useState<UnpaidInvoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(preselectedInvoice?.id || '');
  const [amountStr, setAmountStr] = useState('');
  const [date, setDate] = useState(TODAY);
  const [account, setAccount] = useState<'Cash' | 'Bank'>('Cash');
  const [method, setMethod] = useState<'Cash' | 'UPI' | 'BankTransfer' | 'Card'>('Cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => `rcpt-idem-${Date.now()}-${uid('K')}`);
  const [invoiceSearchQuery, setInvoiceSearchQuery] = useState('');

  // Fetch unpaid invoices when customer changes
  useEffect(() => {
    if (!customerId) {
      setInvoices([]);
      setSelectedInvoiceId('');
      setAmountStr('');
      return;
    }

    setLoadingInvoices(true);
    if (!isLive) {
      const customerBills = (state.bills || [])
        .filter((b: any) => b.customerId === customerId && (b.kind === 'Sale' || b.kind === 'Service'))
        .map((b: any) => {
          const t = roundedTotal(b);
          return {
            id: b.id,
            invoiceNumber: b.id,
            date: b.date,
            duePaise: Math.round((b.previewPaid !== undefined ? Math.max(0, t - b.previewPaid) : (b.due !== undefined ? b.due : t)) * 100),
            total: t,
          };
        })
        .filter((b: any) => b.duePaise > 0);

      setInvoices(customerBills);
      setLoadingInvoices(false);
      return;
    }

    // Live mode: call receivables API
    fetch(`/api/sales/customers/${customerId}/receivables`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load receivables.');
        const data = await res.json();
        const rows = (data.receivables || [])
          .filter((item: any) => item.targetType === 'Invoice')
          .map((inv: any) => ({
            id: inv.targetId || inv.id,
            invoiceNumber: inv.reference || inv.targetId || inv.id,
            date: inv.date,
            grandTotalPaise: inv.originalAmountPaise || 0,
            duePaise: inv.remainingDuePaise || 0,
          }));
        setInvoices(rows);
      })
      .catch((err) => {
        notify(err.message || 'Error loading unpaid invoices.');
        setInvoices([]);
      })
      .finally(() => {
        setLoadingInvoices(false);
      });
  }, [customerId, isLive, state.bills, notify]);

  // When invoice selected, prefill amount with full due
  const selectedInvoice = invoices.find((inv) => inv.id === selectedInvoiceId);

  useEffect(() => {
    if (selectedInvoice) {
      const fullDueRupees = (selectedInvoice.duePaise / 100).toFixed(2);
      setAmountStr(fullDueRupees);
    } else {
      setAmountStr('');
    }
  }, [selectedInvoice]);

  function handleMethodChange(newMethod: 'Cash' | 'UPI' | 'BankTransfer' | 'Card') {
    setMethod(newMethod);
    if (newMethod === 'Cash') {
      setAccount('Cash');
    } else {
      setAccount('Bank');
    }
  }

  // Calculations
  const invoiceDuePaise = selectedInvoice?.duePaise || 0;
  const parsedAmountRupees = parseFloat(amountStr) || 0;
  const payingPaise = Math.round(parsedAmountRupees * 100);
  const remainingDuePaise = Math.max(0, invoiceDuePaise - payingPaise);

  const isAmountValid = payingPaise > 0 && payingPaise <= invoiceDuePaise;
  const hasOverpaid = payingPaise > invoiceDuePaise;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!customerId) {
      notify('Select a customer.');
      return;
    }
    if (!selectedInvoiceId || !selectedInvoice) {
      notify('Select exactly one invoice to pay.');
      return;
    }
    if (!isAmountValid) {
      if (hasOverpaid) {
        notify('Payment cannot exceed the selected invoice balance.');
      } else {
        notify('Enter a positive payment amount.');
      }
      return;
    }

    setBusy(true);
    try {
      const payload = {
        customerId,
        date,
        components: [
          {
            account,
            method,
            amountPaise: payingPaise,
            reference: reference.trim(),
          },
        ],
        allocations: [
          {
            targetType: 'Invoice',
            targetId: selectedInvoice.id,
            amountPaise: payingPaise,
          },
        ],
        recordExcessAsCustomerAdvance: false,
        notes: notes.trim(),
        idempotencyKey,
      };

      const result = await recordCustomerReceiptApi(payload);
      if (!result.success) {
        throw new Error(result.error || 'Failed to record receipt.');
      }

      notify('Receipt recorded successfully.');
      onSuccess(result.receipt || {
        ...payload,
        receiptNumber: `RCP-${Date.now().toString().slice(-4)}`,
        invoiceId: selectedInvoice.invoiceNumber,
        customerSnapshot: state.customers.find((c: any) => c.id === customerId),
      });
    } catch (err: any) {
      notify(err.message || 'Error recording receipt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Record Customer Receipt" onClose={onClose} wide>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
              Customer <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
            </label>
            <SearchSelect
              placeholder="Search customer by name, phone, GST..."
              value={customerId}
              options={state.customers.map((c: any) => ({
                value: c.id,
                label: c.name,
                sublabel: `${c.phone}${c.gst ? ` · GST: ${c.gst}` : ''}`,
              }))}
              onSearch={async (query, signal) => {
                if (!isLive) {
                  const qLower = query.toLowerCase();
                  return state.customers
                    .filter((c: any) => c.name.toLowerCase().includes(qLower) || c.phone.includes(qLower) || (c.gst && c.gst.toLowerCase().includes(qLower)))
                    .map((c: any) => ({
                      value: c.id,
                      label: c.name,
                      sublabel: `${c.phone}${c.gst ? ` · GST: ${c.gst}` : ''}`,
                    }));
                }
                const res = await fetch(`/api/master/customers?q=${encodeURIComponent(query)}&limit=30`, { signal });
                if (!res.ok) return [];
                const data = await res.json();
                return (data.records || []).map((c: any) => ({
                  value: c._id || c.id,
                  label: c.name,
                  sublabel: `${c.phone}${c.gst ? ` · GST: ${c.gst}` : ''}`,
                }));
              }}
              onChange={(val) => {
                setCustomerId(val);
                setSelectedInvoiceId('');
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
              Receipt Date <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
            </label>
            <input
              type="date"
              value={date}
              required
              onChange={(e) => setDate(e.target.value)}
              style={{
                width: '100%',
                padding: '0.45rem 0.65rem',
                borderRadius: '6px',
                border: '1px solid var(--border, #d1d5db)',
                fontSize: '0.9rem',
              }}
            />
          </div>
        </div>

        {/* Invoice Selector */}
        <div
          style={{
            padding: '1rem',
            background: 'var(--surface-muted, #f9fafb)',
            borderRadius: '8px',
            border: '1px solid var(--border, #e5e7eb)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <label style={{ fontSize: '0.9rem', fontWeight: 700 }}>
              Select Unpaid Invoice <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
            </label>
            <small style={{ color: 'var(--text-muted, #6b7280)' }}>
              Receipt applies to exactly one invoice
            </small>
          </div>

          {!customerId ? (
            <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted, #6b7280)', fontSize: '0.88rem' }}>
              Select a customer above to view their unpaid invoices.
            </div>
          ) : loadingInvoices ? (
            <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted, #6b7280)', fontSize: '0.88rem' }}>
              Loading customer invoices...
            </div>
          ) : invoices.length === 0 ? (
            <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted, #6b7280)', fontSize: '0.88rem' }}>
              No unpaid invoices found for this customer.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '180px', overflowY: 'auto' }}>
              {invoices.map((inv) => {
                const isSelected = selectedInvoiceId === inv.id;
                const dueRupees = inv.duePaise / 100;
                const totalRupees = (inv.grandTotalPaise || inv.total ? (inv.grandTotalPaise ? inv.grandTotalPaise / 100 : inv.total) : dueRupees) || dueRupees;

                return (
                  <div
                    key={inv.id}
                    onClick={() => setSelectedInvoiceId(inv.id)}
                    style={{
                      padding: '0.65rem 0.85rem',
                      borderRadius: '6px',
                      border: isSelected ? '2px solid var(--primary, #6366f1)' : '1px solid var(--border, #d1d5db)',
                      background: isSelected ? 'var(--primary-light, #eef2ff)' : 'var(--surface, #ffffff)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem', color: isSelected ? 'var(--primary, #4338ca)' : 'inherit' }}>
                        {inv.invoiceNumber}
                      </div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted, #6b7280)' }}>
                        Date: {inv.date} · Total: {money(totalRupees)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #6b7280)', display: 'block' }}>Current Due</span>
                      <strong style={{ fontSize: '0.95rem', color: 'var(--danger, #dc2626)' }}>{money(dueRupees)}</strong>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Payment Amount & Breakdown */}
        {selectedInvoice && (
          <div
            style={{
              padding: '1rem',
              background: 'var(--surface, #ffffff)',
              borderRadius: '8px',
              border: '1px solid var(--border, #e5e7eb)',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                  Amount Received (₹) <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={(invoiceDuePaise / 100).toFixed(2)}
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.45rem 0.65rem',
                    fontSize: '1rem',
                    fontWeight: 700,
                    borderRadius: '6px',
                    border: hasOverpaid ? '1px solid var(--danger, #ef4444)' : '1px solid var(--border, #d1d5db)',
                  }}
                />
                <small style={{ display: 'block', marginTop: '4px', color: 'var(--text-muted, #6b7280)' }}>
                  Full due prefilled. Enter smaller amount for partial payment.
                </small>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                  Payment Mode <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
                </label>
                <select
                  value={method}
                  onChange={(e) => handleMethodChange(e.target.value as any)}
                  style={{
                    width: '100%',
                    padding: '0.45rem 0.65rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border, #d1d5db)',
                    fontSize: '0.9rem',
                  }}
                >
                  <option value="Cash">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="BankTransfer">Bank Transfer</option>
                  <option value="Card">Card</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                  Transaction / UTR Reference
                </label>
                <input
                  type="text"
                  placeholder="e.g. UTR / Cheque / Auth Code"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.45rem 0.65rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border, #d1d5db)',
                    fontSize: '0.9rem',
                  }}
                />
              </div>
            </div>

            {/* Balance Calculation Box */}
            <div
              style={{
                marginTop: '1rem',
                padding: '0.75rem',
                borderRadius: '6px',
                background: hasOverpaid ? 'rgba(239, 68, 68, 0.1)' : 'var(--surface-muted, #f8fafc)',
                border: hasOverpaid ? '1px solid #ef4444' : '1px solid var(--border, #e2e8f0)',
                display: 'flex',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '0.5rem',
                fontSize: '0.88rem',
              }}
            >
              <div>
                <span style={{ color: 'var(--text-muted, #64748b)' }}>Selected Invoice Due: </span>
                <strong>{money(invoiceDuePaise / 100)}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted, #64748b)' }}>Paying Now: </span>
                <strong style={{ color: 'var(--primary, #6366f1)' }}>{money(parsedAmountRupees)}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted, #64748b)' }}>Balance on this invoice after payment: </span>
                <strong style={{ color: remainingDuePaise === 0 ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)' }}>
                  {money(remainingDuePaise / 100)}
                </strong>
              </div>
            </div>

            {hasOverpaid && (
              <div style={{ color: 'var(--danger, #ef4444)', fontSize: '0.82rem', marginTop: '0.5rem', fontWeight: 600 }}>
                Payment cannot exceed {money(invoiceDuePaise / 100)}. Multi-invoice allocation and advance overpayments are not permitted.
              </div>
            )}
          </div>
        )}

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Notes / Remarks
          </label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional receipt notes..."
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.88rem',
            }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
          <Btn secondary onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            type="submit"
            disabled={busy || !customerId || !selectedInvoiceId || !isAmountValid || hasOverpaid}
          >
            {busy ? 'Recording...' : 'Record Receipt'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------
// Record Outgoing Payment Voucher Modal
// -------------------------------------------------------------
export function RecordVoucherModal({
  isOpen: _isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (voucher: any) => void;
}) {
  const {createPaymentVoucherApi, notify} = useStore();
  const [date, setDate] = useState(TODAY);
  const [payeeName, setPayeeName] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [method, setMethod] = useState<'Cash' | 'UPI' | 'BankTransfer' | 'Card' | 'Cheque'>('Cash');
  const [purpose, setPurpose] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => `pv-idem-${Date.now()}-${uid('K')}`);
  const payingPaise = Math.round((parseFloat(amountStr) || 0) * 100);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!payeeName.trim()) return notify('Enter payee name.');
    if (!purpose.trim()) return notify('Enter purpose of payment.');
    if (payingPaise <= 0) return notify('Enter a positive payment amount.');
    setBusy(true);
    try {
      const payload = {
        date,
        payeeName: payeeName.trim(),
        amountPaise: payingPaise,
        method,
        purpose: purpose.trim(),
        reference: reference.trim(),
        notes: notes.trim(),
        idempotencyKey,
      };
      const result = await createPaymentVoucherApi(payload);
      if (!result.success) throw new Error(result.error || 'Failed to record payment voucher.');
      notify('Payment voucher created successfully.');
      onSuccess(result.voucher || {...payload, voucherNumber: `PV-${Date.now().toString().slice(-4)}`});
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Error recording payment voucher.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Record Payment Voucher" onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="voucher-form">
        <div className="voucher-form-grid">
          <div>
            <label className="voucher-field-label">Voucher Date <span>*</span></label>
            <input type="date" value={date} required onChange={(event) => setDate(event.target.value)} />
          </div>
          <div>
            <label className="voucher-field-label">Paid To (Payee Name) <span>*</span></label>
            <input type="text" required placeholder="e.g. Transport charges, Landlord, Technician" value={payeeName} onChange={(event) => setPayeeName(event.target.value)} />
          </div>
          <div>
            <label className="voucher-field-label">Payment Method <span>*</span></label>
            <select value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
              <option value="Cash">Cash</option>
              <option value="UPI">UPI</option>
              <option value="BankTransfer">Bank Transfer / NEFT / IMPS</option>
              <option value="Card">Card</option>
              <option value="Cheque">Cheque</option>
            </select>
          </div>
          <div>
            <label className="voucher-field-label">Amount (₹) <span>*</span></label>
            <input type="number" step="0.01" min="0.01" required placeholder="0.00" value={amountStr} onChange={(event) => setAmountStr(event.target.value)} />
          </div>
          <div>
            <label className="voucher-field-label">Purpose / Expense Category <span>*</span></label>
            <input type="text" required placeholder="e.g. Transport, rent, machine service" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
          </div>
          <div>
            <label className="voucher-field-label">External Reference</label>
            <input type="text" placeholder="Bill number, UPI reference or cheque number" value={reference} onChange={(event) => setReference(event.target.value)} />
          </div>
          <div className="voucher-form-full">
            <label className="voucher-field-label">Notes / Remarks</label>
            <textarea rows={3} placeholder="Optional payment details" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
        </div>
        <div className="form-actions">
          <Btn secondary onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn type="submit" disabled={busy || payingPaise <= 0}>{busy ? 'Recording…' : 'Record Payment Voucher'}</Btn>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------
// Professional Receipt Preview Modal (Print & jsPDF Download)
// -------------------------------------------------------------
export function ReceiptPreviewModal({
  receipt,
  onClose,
}: {
  receipt: any;
  onClose: () => void;
}) {
  const { state, notify } = useStore();
  const settings = state.settings;

  const snap = receipt.receiptSnapshot;
  const seller = snap?.seller || settings;
  const cust = snap?.customer || state.customers.find((c: any) => c.id === receipt.customerId) || receipt.customerSnapshot || {};

  const rNum = snap?.receiptNumber || receipt.receiptNumber || receipt._id || receipt.id || 'RCP';
  const rDate = snap?.receiptDate || receipt.date || (receipt.createdAt ? String(receipt.createdAt).slice(0, 10) : '');
  const comp = receipt.components?.[0] || {};
  const method = snap?.payment?.method || comp.method || receipt.method || 'Cash';
  const ref = snap?.payment?.reference || comp.reference || receipt.reference || '-';

  const alloc = receipt.allocations?.[0];
  const amountPaidPaise = snap?.amountAppliedPaise
    ?? (alloc?.amountPaise || receipt.totalAmountPaise || receipt.amountPaise || (comp.amountPaise ?? 0));
  const amountPaidRupees = amountPaidPaise / 100;

  const targetInvoice = snap?.invoiceNumber
    || (alloc?.targetId || receipt.invoiceId || '-');

  const invTotalPaise = snap?.invoiceTotalPaise ?? amountPaidPaise;
  const invTotalRupees = invTotalPaise / 100;

  const dueBeforePaise = snap?.dueBeforePaise ?? invTotalPaise;
  const dueBeforeRupees = dueBeforePaise / 100;

  const dueAfterPaise = snap?.dueAfterPaise ?? Math.max(0, dueBeforePaise - amountPaidPaise);
  const dueAfterRupees = dueAfterPaise / 100;

  const custOutstandingPaise = snap?.customerOutstandingAfterPaise
    ?? (typeof cust?.balancePaise === 'number' ? cust.balancePaise : (typeof cust?.balance === 'number' ? Math.round(cust.balance * 100) : dueAfterPaise));
  const custOutstandingRupees = custOutstandingPaise / 100;

  const custName = cust.name || 'Customer';
  const custPhone = cust.phone || '-';
  const custAddress = cust.address || '-';
  const custGst = cust.gst || 'Unregistered';

  async function handleDownloadPdf() {
    try {
      const bytes = await receiptPdfBytes(settings, receipt, null, cust);
      downloadBytes(`receipt-${rNum}.pdf`, bytes, 'application/pdf');
      notify('PDF downloaded.');
    } catch (err: any) {
      notify('PDF generation failed: ' + err.message);
    }
  }

  function handlePrint() {
    window.print();
  }

  return (
    <Modal title={`Receipt ${rNum}`} onClose={onClose} wide>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginBottom: '1rem' }} className="no-print">
        <Btn secondary onClick={handlePrint} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Printer size={15} /> Print
        </Btn>
        <Btn onClick={handleDownloadPdf} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Download size={15} /> Download PDF
        </Btn>
      </div>

      <div
        className="printable-document receipt-document"
        style={{
          background: '#ffffff',
          color: '#111827',
          padding: '2rem',
          border: '1px solid #e5e7eb',
          borderRadius: '4px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          maxWidth: '800px',
          margin: '0 auto',
        }}
      >
        <div style={{ textAlign: 'center', borderBottom: '2px solid #111827', paddingBottom: '0.75rem', marginBottom: '1.25rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, letterSpacing: '2px' }}>PAYMENT RECEIPT</h1>
          <small style={{ color: '#4b5563', fontSize: '0.8rem', textTransform: 'uppercase' }}>Official Single-Invoice Payment Acknowledgment</small>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '1.5rem', marginBottom: '1.25rem' }}>
          <div>
            <h2 style={{ margin: '0 0 4px 0', fontSize: '1.15rem', fontWeight: 700 }}>
              {seller.name || settings.name || 'Company Name'}
            </h2>
            <div style={{ fontSize: '0.85rem', color: '#374151', lineHeight: '1.4' }}>
              {(seller.address || settings.address) && <div>{seller.address || settings.address}</div>}
              {(seller.gst || settings.gst) && <div><strong>GSTIN:</strong> {seller.gst || settings.gst}</div>}
              {(seller.phone || settings.phone) && <div><strong>Phone:</strong> {seller.phone || settings.phone}</div>}
              {(seller.email || settings.email) && <div><strong>Email:</strong> {seller.email || settings.email}</div>}
            </div>
          </div>

          <div style={{ borderLeft: '1px solid #e5e7eb', paddingLeft: '1rem', fontSize: '0.85rem', lineHeight: '1.6' }}>
            <div><strong>Receipt No:</strong> {rNum}</div>
            <div><strong>Date:</strong> {rDate}</div>
            <div><strong>Payment Mode:</strong> {method}</div>
            <div><strong>Ref / UTR:</strong> {ref}</div>
          </div>
        </div>

        <div
          style={{
            background: '#f9fafb',
            border: '1px solid #e5e7eb',
            borderRadius: '4px',
            padding: '0.75rem 1rem',
            marginBottom: '1.25rem',
            fontSize: '0.88rem',
          }}
        >
          <div><strong>Received with thanks from:</strong> {custName}</div>
          <div style={{ color: '#4b5563', marginTop: '2px' }}>
            <span>Phone: {custPhone}</span> · <span>GSTIN: {custGst}</span>
          </div>
          {custAddress !== '-' && <div style={{ color: '#4b5563', marginTop: '2px' }}>Address: {custAddress}</div>}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.25rem', fontSize: '0.88rem' }}>
          <thead>
            <tr style={{ background: '#1e293b', color: '#ffffff', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.65rem' }}>S.No</th>
              <th style={{ padding: '0.5rem 0.65rem' }}>Settled Invoice #</th>
              <th style={{ padding: '0.5rem 0.65rem', textAlign: 'right' }}>Invoice Total</th>
              <th style={{ padding: '0.5rem 0.65rem', textAlign: 'right' }}>Due Before</th>
              <th style={{ padding: '0.5rem 0.65rem', textAlign: 'right' }}>Paid Now</th>
              <th style={{ padding: '0.5rem 0.65rem', textAlign: 'right' }}>Remaining Due</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
              <td style={{ padding: '0.6rem 0.65rem' }}>1</td>
              <td style={{ padding: '0.6rem 0.65rem', fontWeight: 600 }}>
                {targetInvoice}
              </td>
              <td style={{ padding: '0.6rem 0.65rem', textAlign: 'right' }}>
                {money(invTotalRupees)}
              </td>
              <td style={{ padding: '0.6rem 0.65rem', textAlign: 'right' }}>
                {money(dueBeforeRupees)}
              </td>
              <td style={{ padding: '0.6rem 0.65rem', textAlign: 'right', fontWeight: 700, color: 'var(--success, #16a34a)' }}>
                {money(amountPaidRupees)}
              </td>
              <td style={{ padding: '0.6rem 0.65rem', textAlign: 'right', fontWeight: 600, color: dueAfterRupees === 0 ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)' }}>
                {money(dueAfterRupees)}
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '0.85rem', color: '#374151' }}>
            <div><strong>Amount in words:</strong></div>
            <div style={{ fontStyle: 'italic', marginTop: '2px' }}>{amountWords(amountPaidRupees)}</div>
            {receipt.notes && (
              <div style={{ marginTop: '0.75rem' }}>
                <strong>Notes:</strong> {receipt.notes}
              </div>
            )}
          </div>

          <div style={{ background: '#f8fafc', padding: '0.85rem', borderRadius: '4px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem' }}>
              <span style={{ color: '#64748b' }}>Amount Paid Now:</span>
              <strong style={{ color: '#16a34a', fontSize: '0.95rem' }}>{money(amountPaidRupees)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem' }}>
              <span style={{ color: '#64748b' }}>Invoice Remaining Due:</span>
              <strong style={{ color: dueAfterRupees === 0 ? '#16a34a' : '#dc2626' }}>{money(dueAfterRupees)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', borderTop: '1px solid #e2e8f0', paddingTop: '4px' }}>
              <span style={{ color: '#64748b' }}>Customer Outstanding:</span>
              <strong>{money(custOutstandingRupees)}</strong>
            </div>
          </div>
        </div>

        <div style={{ marginTop: '3rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: '0.85rem' }}>
          <div style={{ color: '#6b7280', fontSize: '0.75rem' }}>
            Computer-generated receipt · Valid without physical seal
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 600 }}>For {seller.name || settings.name || 'Company'}</div>
            <div style={{ height: '40px' }} />
            <div style={{ borderTop: '1px solid #111827', paddingTop: '4px', minWidth: '160px' }}>
              Authorised Signatory
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------
// Professional Payment Voucher Preview Modal (Print & jsPDF Download)
// -------------------------------------------------------------
export function VoucherPreviewModal({
  voucher,
  onClose,
}: {
  voucher: any;
  onClose: () => void;
}) {
  const { state, notify } = useStore();
  const settings = state.settings;

  const vNum = voucher.voucherNumber || voucher._id || voucher.id || 'PV';
  const vDate = voucher.date || String(voucher.createdAt || '').slice(0, 10);
  const amountRupees = (voucher.amountPaise || 0) / 100;

  async function handleDownloadPdf() {
    try {
      const bytes = await paymentVoucherPdfBytes(settings, voucher);
      downloadBytes(`payment-voucher-${vNum}.pdf`, bytes, 'application/pdf');
      notify('PDF downloaded.');
    } catch (err: any) {
      notify('PDF generation failed: ' + err.message);
    }
  }

  function handlePrint() {
    window.print();
  }

  return (
    <Modal title={`Payment Voucher ${vNum}`} onClose={onClose} wide>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginBottom: '1rem' }} className="no-print">
        <Btn secondary onClick={handlePrint} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Printer size={15} /> Print
        </Btn>
        <Btn onClick={handleDownloadPdf} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Download size={15} /> Download PDF
        </Btn>
      </div>

      <div
        className="printable-document voucher-document"
        style={{
          background: '#ffffff',
          color: '#111827',
          padding: '2rem',
          border: '1px solid #e5e7eb',
          borderRadius: '4px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          maxWidth: '800px',
          margin: '0 auto',
        }}
      >
        <div style={{ textAlign: 'center', borderBottom: '2px solid #111827', paddingBottom: '0.75rem', marginBottom: '1.25rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, letterSpacing: '2px' }}>PAYMENT VOUCHER</h1>
          <small style={{ color: '#4b5563', fontSize: '0.8rem', textTransform: 'uppercase' }}>Payment confirmation</small>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '1.5rem', marginBottom: '1.25rem' }}>
          <div>
            <h2 style={{ margin: '0 0 4px 0', fontSize: '1.15rem', fontWeight: 700 }}>
              {settings.name || 'Company Name'}
            </h2>
            <div style={{ fontSize: '0.85rem', color: '#374151', lineHeight: '1.4' }}>
              {settings.address && <div>{settings.address}</div>}
              {settings.gst && <div><strong>GSTIN:</strong> {settings.gst}</div>}
              {settings.phone && <div><strong>Phone:</strong> {settings.phone}</div>}
            </div>
          </div>

          <div style={{ borderLeft: '1px solid #e5e7eb', paddingLeft: '1rem', fontSize: '0.85rem', lineHeight: '1.6' }}>
            <div><strong>Voucher No:</strong> {vNum}</div>
            <div><strong>Date:</strong> {vDate}</div>
            <div><strong>Payment Method:</strong> {voucher.method || 'Cash'}</div>
            <div><strong>Reference / UTR:</strong> {voucher.reference || 'N/A'}</div>
          </div>
        </div>

        <div
          style={{
            background: '#f9fafb',
            border: '1px solid #e5e7eb',
            borderRadius: '4px',
            padding: '0.75rem 1rem',
            marginBottom: '1.25rem',
            fontSize: '0.92rem',
          }}
        >
          <strong>Paid To:</strong> {voucher.payeeName}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.25rem', fontSize: '0.88rem' }}>
          <thead>
            <tr style={{ background: '#1e293b', color: '#ffffff', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem' }}>S.No</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Particulars / Purpose</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Method</th>
              <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
              <td style={{ padding: '0.6rem 0.75rem' }}>1</td>
              <td style={{ padding: '0.6rem 0.75rem' }}>
                <strong>{voucher.purpose}</strong>
              </td>
              <td style={{ padding: '0.6rem 0.75rem' }}>{voucher.method}</td>
              <td style={{ padding: '0.6rem 0.75rem', textAlign: 'right', fontWeight: 700 }}>
                {money(amountRupees)}
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '0.85rem', color: '#374151' }}>
            <div><strong>Amount in words:</strong></div>
            <div style={{ fontStyle: 'italic', marginTop: '2px' }}>{amountWords(amountRupees)}</div>
            {voucher.notes && (
              <div style={{ marginTop: '0.75rem' }}>
                <strong>Notes:</strong> {voucher.notes}
              </div>
            )}
          </div>

          <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '4px', border: '1px solid #e2e8f0', textAlign: 'right' }}>
            <span style={{ fontSize: '0.8rem', color: '#64748b', textTransform: 'uppercase', display: 'block' }}>Total Paid</span>
            <span style={{ fontSize: '1.35rem', fontWeight: 800, color: '#dc2626' }}>{money(amountRupees)}</span>
          </div>
        </div>

        <div style={{ marginTop: '3.5rem', display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
          <div style={{ textAlign: 'left', minWidth: '160px' }}>
            <div style={{ borderTop: '1px solid #111827', paddingTop: '4px' }}>
              Receiver's Signature
            </div>
          </div>
          <div style={{ textAlign: 'right', minWidth: '160px' }}>
            <div style={{ borderTop: '1px solid #111827', paddingTop: '4px' }}>
              Authorised Signatory
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------
// PaymentDialog for invoice detail integration
// -------------------------------------------------------------
export function PaymentDialog({ record, onClose }: { record: any; onClose: () => void }) {
  const [successReceipt, setSuccessReceipt] = useState<any | null>(null);

  if (successReceipt) {
    return (
      <ReceiptPreviewModal
        receipt={successReceipt}
        onClose={onClose}
      />
    );
  }

  return (
    <RecordReceiptModal
      isOpen={true}
      preselectedInvoice={record}
      onClose={onClose}
      onSuccess={(receipt) => {
        setSuccessReceipt(receipt);
      }}
    />
  );
}
