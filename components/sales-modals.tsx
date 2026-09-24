'use client';

import {useState, useEffect, useRef} from 'react';
import {Modal, Field, Btn, Badge} from './ui';
import {money, TODAY, uid, Line} from '@/lib/domain';
import {useStore} from './store';
import {Plus, Trash2, Check, AlertTriangle} from 'lucide-react';

export function IssueInvoiceModal({
  isOpen,
  onClose,
  draft,
  onIssued,
  initialPayments = [],
}: {
  isOpen: boolean;
  onClose: () => void;
  draft: {id: string; version: number; totalPaise: number; customerId: string};
  onIssued?: (invoice: any) => void;
  initialPayments?: Array<{account: string; method: string; amount: string}>;
}) {
  const {issueInvoiceApi, notify} = useStore();
  const [busy, setBusy] = useState(false);
  const [applyAdvance, setApplyAdvance] = useState(0);
  const [recordExcess, setRecordExcess] = useState(false);
  const [creditLimitOverride, setCreditLimitOverride] = useState(false);
  const [creditLimitReason, setCreditLimitReason] = useState('');
  const [paymentRows, setPaymentRows] = useState<
    Array<{account: 'Cash' | 'Bank'; method: 'Cash' | 'UPI' | 'BankTransfer' | 'Card'; amount: string; reference: string}>
  >(() => initialPayments.map(p => ({
    account: p.method === 'Cash' ? 'Cash' : 'Bank',
    method: (p.method === 'Cash' ? 'Cash' : p.method === 'Card' ? 'Card' : p.method === 'UPI' || p.method === 'GPay' ? 'UPI' : 'BankTransfer'),
    amount: p.amount, reference: '',
  })));
  const issueAttempt = useRef<{fingerprint: string; key: string} | null>(null);

  if (!isOpen) return null;

  const totalPaise = draft.totalPaise || 0;
  const totalRupees = totalPaise / 100;
  const paymentTotal = paymentRows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
  const advanceTotal = applyAdvance || 0;
  const effectivePaid = paymentTotal + advanceTotal;
  const remainingDue = Math.max(0, totalRupees - effectivePaid);
  const excessAmount = Math.max(0, effectivePaid - totalRupees);

  const addRow = () => {
    setPaymentRows((rows) => [...rows, {account: 'Bank', method: 'UPI', amount: '', reference: ''}]);
  };

  const removeRow = (index: number) => {
    setPaymentRows((rows) => rows.filter((_, i) => i !== index));
  };

  const updateRow = (index: number, field: string, value: any) => {
    setPaymentRows((rows) =>
      rows.map((row, i) => {
        if (i !== index) return row;
        const updated = {...row, [field]: value};
        if (field === 'account') {
          if (value === 'Cash') updated.method = 'Cash';
          else if (row.method === 'Cash') updated.method = 'UPI';
        } else if (field === 'method') {
          if (value === 'Cash') updated.account = 'Cash';
          else updated.account = 'Bank';
        }
        return updated;
      })
    );
  };

  const handleIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    for (const r of paymentRows) {
      const amt = parseFloat(r.amount) || 0;
      if (!/^\d+(?:\.\d{1,2})?$/.test(r.amount.trim()) || !Number.isFinite(amt) || Math.round(amt * 100) < 1) {
        notify('Enter a positive payment amount with up to two decimals, or remove the unused row for a credit invoice.');
        return;
      }
      if (amt > 0) {
        if (r.account === 'Cash' && r.method !== 'Cash') {
          notify('Cash account requires Cash payment method.');
          return;
        }
        if (r.account === 'Bank' && r.method === 'Cash') {
          notify('Bank account cannot use Cash payment method.');
          return;
        }
      }
    }

    if (!Number.isFinite(applyAdvance) || applyAdvance < 0 || advanceTotal > totalRupees) {
      notify('Customer advance applied cannot exceed the invoice total.');
      return;
    }

    const components = paymentRows
      .filter((r) => (parseFloat(r.amount) || 0) > 0)
      .map((r) => ({
        account: r.account,
        method: r.method,
        amountPaise: Math.round((parseFloat(r.amount) || 0) * 100),
        reference: r.reference.trim(),
      }));

    const fingerprint = JSON.stringify({draft, components, advanceTotal, recordExcess, creditLimitOverride, creditLimitReason});
    if (!issueAttempt.current || issueAttempt.current.fingerprint !== fingerprint) {
      issueAttempt.current = {fingerprint, key: `inv-issue-${crypto.randomUUID()}`};
    }
    setBusy(true);
    try {
      const res = await issueInvoiceApi(draft.id, {
        draftId: draft.id,
        expectedVersion: draft.version,
        paymentComponents: components,
        applyCustomerAdvancePaise: Math.round(advanceTotal * 100),
        recordExcessAsCustomerAdvance: recordExcess,
        creditLimitOverride,
        creditLimitOverrideReason: creditLimitReason.trim(),
        idempotencyKey: issueAttempt.current.key,
      });

      if (res.success) {
        notify('Invoice issued successfully.');
        onClose();
        onIssued?.(res.invoice);
      } else {
        if (res.error?.includes('credit limit') || res.error?.includes('Credit limit')) {
          setCreditLimitOverride(true);
          notify('Customer credit limit exceeded. Check the override box and specify a reason.');
        } else {
          notify(res.error || 'Failed to issue invoice.');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Issue Sales Invoice · ${draft.id}`} onClose={onClose} wide>
      <form onSubmit={handleIssue}>
        <div className="form-body stack">
          <div
            className="notice"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: 'var(--card-bg, #f8f9fa)',
              padding: '1rem',
              borderRadius: '6px',
            }}
          >
            <div>
              <span style={{fontSize: '0.85rem', color: 'var(--muted, #666)'}}>Invoice Gross Total</span>
              <h2 style={{margin: '0.25rem 0 0 0', color: 'var(--primary, #1a73e8)'}}>{money(totalRupees)}</h2>
            </div>
            <div style={{textAlign: 'right'}}>
              <span style={{fontSize: '0.85rem', color: 'var(--muted, #666)'}}>Balance After Payment</span>
              <h3 style={{margin: '0.25rem 0 0 0', color: remainingDue > 0 ? 'var(--error, #e53935)' : 'var(--success, #2e7d32)'}}>
                {money(remainingDue)}
              </h3>
            </div>
          </div>

          <Field label="Apply existing customer advance (₹)" hint="Oldest available advance balances will be drawn first.">
            <input
              type="number"
              min="0"
              step="0.01"
              max={totalRupees}
              value={applyAdvance || ''}
              onChange={(e) => setApplyAdvance(Math.max(0, Math.min(totalRupees, parseFloat(e.target.value) || 0)))}
              placeholder="0.00"
            />
          </Field>

          <div>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem'}}>
              <strong>Payment received at issue</strong>
              <Btn secondary onClick={addRow} style={{padding: '0.25rem 0.5rem', fontSize: '0.85rem'}}>
                <Plus size={14} /> Add payment line
              </Btn>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Method</th>
                    <th>Amount (₹)</th>
                    <th>Reference / Note</th>
                    <th style={{width: '40px'}} />
                  </tr>
                </thead>
                <tbody>
                  {paymentRows.map((row, idx) => (
                    <tr key={idx}>
                      <td>
                        <select
                          value={row.account}
                          onChange={(e) => updateRow(idx, 'account', e.target.value as 'Cash' | 'Bank')}
                        >
                          <option value="Cash">Cash (Cash drawer)</option>
                          <option value="Bank">Bank (Main account)</option>
                        </select>
                      </td>
                      <td>
                        <select
                          value={row.method}
                          onChange={(e) => updateRow(idx, 'method', e.target.value as any)}
                        >
                          {row.account === 'Cash' ? (
                            <option value="Cash">Cash</option>
                          ) : (
                            <>
                              <option value="UPI">UPI</option>
                              <option value="BankTransfer">Bank Transfer / IMPS / NEFT</option>
                              <option value="Card">Card</option>
                            </>
                          )}
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={row.amount}
                          onChange={(e) => updateRow(idx, 'amount', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          placeholder="Transaction ref / UPI ID"
                          value={row.reference}
                          onChange={(e) => updateRow(idx, 'reference', e.target.value)}
                        />
                      </td>
                      <td>
                        {paymentRows.length > 1 && (
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => removeRow(idx)}
                            aria-label="Remove payment line"
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {excessAmount > 0 && (
            <div className="notice" style={{backgroundColor: '#e8f5e9', borderLeft: '4px solid #4caf50'}}>
              <p style={{margin: '0 0 0.5rem 0'}}>
                <strong>Excess payment: {money(excessAmount)}</strong>
              </p>
              <label style={{display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer'}}>
                <input
                  type="checkbox"
                  checked={recordExcess}
                  onChange={(e) => setRecordExcess(e.target.checked)}
                />
                Record excess amount as reusable customer advance
              </label>
            </div>
          )}

          {creditLimitOverride && (
            <div className="notice full" style={{backgroundColor: '#fff3e0', borderLeft: '4px solid #ff9800'}}>
              <p style={{margin: '0 0 0.5rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem'}}>
                <AlertTriangle size={18} color="#e65100" />
                <strong>Customer Credit Limit Override</strong>
              </p>
              <p style={{fontSize: '0.85rem', margin: '0 0 0.5rem 0'}}>
                This customer’s outstanding dues will exceed their configured credit limit. Provide an explicit justification for the audit trail.
              </p>
              <Field label="Override Reason *">
                <input
                  required
                  placeholder="e.g. Approved by Store Manager for high-value regular customer"
                  value={creditLimitReason}
                  onChange={(e) => setCreditLimitReason(e.target.value)}
                />
              </Field>
            </div>
          )}
        </div>

        <div className="form-actions">
          <Btn secondary disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
          <Btn type="submit" disabled={busy}>
            {busy ? 'Issuing…' : 'Confirm & Issue Invoice'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

export function InvoiceCancelModal({
  isOpen,
  onClose,
  invoiceId,
  version,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  invoiceId: string;
  version: number;
  onSuccess?: () => void;
}) {
  const {cancelInvoiceDraftApi, notify} = useStore();
  const [reason, setReason] = useState('Draft discarded by user');
  const [busy, setBusy] = useState(false);

  if (!isOpen) return null;

  return (
    <Modal title={`Cancel Invoice Draft · ${invoiceId}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!reason.trim()) return notify('Reason is required.');
          setBusy(true);
          try {
            const res = await cancelInvoiceDraftApi(invoiceId, version, reason.trim());
            if (res.success) {
              notify('Invoice draft cancelled.');
              onClose();
              onSuccess?.();
            } else {
              notify(res.error || 'Failed to cancel draft.');
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-body">
          <p>Cancel this unissued invoice draft? It has no financial posting or stock deductions.</p>
          <Field label="Reason for cancellation *">
            <input required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <div className="form-actions">
          <Btn secondary disabled={busy} onClick={onClose}>
            Keep draft
          </Btn>
          <Btn danger type="submit" disabled={busy}>
            {busy ? 'Cancelling…' : 'Cancel Draft'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}
