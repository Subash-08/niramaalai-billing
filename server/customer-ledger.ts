import 'server-only';
import {Db, ClientSession} from 'mongodb';
import {AppError} from './db';
import {Identity} from './security';
import {recordAudit} from './audit';
import {uid} from '../lib/domain';
import {todayInKolkata} from './purchase-schema';
import {sumSalePaise} from './sales-calculations';
import {
  RecordCustomerReceiptInput,
  AllocateCustomerAdvanceInput,
  RefundCustomerAdvanceInput,
  ReverseCustomerReceiptInput,
  ReverseCustomerAllocationInput,
  ReverseCustomerRefundInput,
  CustomerStatementQueryInput,
  CustomerReceiptsListQueryInput,
  RecordCustomerReceiptSchema,
  AllocateCustomerAdvanceSchema,
  RefundCustomerAdvanceSchema,
  ReverseCustomerReceiptSchema,
  ReverseCustomerAllocationSchema,
  ReverseCustomerRefundSchema,
  CustomerStatementQuerySchema,
  CustomerReceiptsListQuerySchema,
} from './sales-schema';
import {
  assertSalePostingDay,
  deriveCustomerAdvanceStatus,
  insertCustomerAllocation,
} from './sales-posting';
import {
  col,
  nextTenantSequence,
  executeIdempotentTransaction,
} from './purchase-service';
import type {InvoiceDocument} from './sales-service';

export type CustomerReceiptDocument = {
  _id: string;
  tenantId: string;
  receiptNumber: string;
  customerId: string;
  customerSnapshot: {
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    gst?: string;
  };
  date: string;
  totalAmountPaise: number;
  allocatedAmountPaise: number;
  advanceAmountPaise: number;
  advanceId?: string;
  components: Array<{
    account: 'Cash' | 'Bank';
    method: 'Cash' | 'UPI' | 'BankTransfer' | 'Card';
    amountPaise: number;
    reference?: string;
  }>;
  allocations: Array<{
    targetType: 'Invoice' | 'OpeningReceivable';
    targetId: string;
    amountPaise: number;
  }>;
  notes?: string;
  receiptSnapshot?: {
    invoiceId: string;
    invoiceNumber: string;
    invoiceTotalPaise: number;
    dueBeforePaise: number;
    amountAppliedPaise: number;
    dueAfterPaise: number;
    customerOutstandingAfterPaise: number;
    customer: {
      name: string;
      phone?: string;
      email?: string;
      address?: string;
      gst?: string;
    };
    seller: {
      name: string;
      phone?: string;
      email?: string;
      address?: string;
      gst?: string;
      logoFileId?: string | null;
    };
    payment: {
      account: 'Cash' | 'Bank';
      method: 'Cash' | 'UPI' | 'BankTransfer' | 'Card';
      amountPaise: number;
      reference?: string;
    };
    receiptDate: string;
    receiptNumber: string;
  };
  isReversed: boolean;
  reversalReason?: string;
  reversedAt?: Date;
  reversedBy?: string;
  createdAt: Date;
  createdBy: string;
};

export type CustomerAdvanceDocument = {
  _id: string;
  tenantId: string;
  advanceNumber: string;
  customerId: string;
  customerSnapshot: {
    name: string;
    phone?: string;
  };
  sourceType: 'ReceiptExcess' | 'ExplicitAdvance' | 'CreditNote';
  receiptId?: string;
  date: string;
  originalAmountPaise: number;
  remainingAmountPaise: number;
  status: 'Available' | 'PartlyConsumed' | 'FullyConsumed' | 'Refunded' | 'Reversed';
  version: number;
  createdAt: Date;
  updatedAt?: Date;
  createdBy: string;
};

export type CustomerRefundDocument = {
  _id: string;
  tenantId: string;
  refundNumber: string;
  customerId: string;
  advanceId: string;
  account: 'Cash' | 'Bank';
  amountPaise: number;
  refundDate: string;
  reason: string;
  isReversed: boolean;
  reversalReason?: string;
  reversedAt?: Date;
  reversedBy?: string;
  createdAt: Date;
  createdBy: string;
};

// 1. Record Customer Receipt
export async function recordCustomerReceipt(
  db: Db,
  identity: Identity,
  raw: unknown
) {
  const input = RecordCustomerReceiptSchema.parse(raw);
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'recordCustomerReceipt',
    undefined,
    input,
    async (session: ClientSession) => {
      await assertSalePostingDay(db, tenantId, input.date, session);

      // Customer financial lock & serialization
      const customer = await col(db, 'customers').findOneAndUpdate(
        {_id: input.customerId, tenantId, status: 'Active'},
        {$inc: {financialVersion: 1}},
        {session, returnDocument: 'after'}
      );
      if (!customer) throw new AppError(404, 'Customer not found or archived.');

      const totalReceiptPaise = sumSalePaise(input.components.map(c => c.amountPaise));
      const totalAllocatedPaise = sumSalePaise(input.allocations.map(a => a.amountPaise));

      if (totalAllocatedPaise !== totalReceiptPaise) {
        throw new AppError(400, 'Receipt amount must exactly match the payment applied to the selected invoice.');
      }

      const excessPaise = totalReceiptPaise - totalAllocatedPaise;
      if (excessPaise > 0 && !input.recordExcessAsCustomerAdvance) {
        throw new AppError(400, 'Confirm recording excess payment as customer advance.');
      }

      const now = new Date();
      const year = input.date.slice(0, 4);
      const receiptId = uid('RCP');
      const receiptNumber = await nextTenantSequence(db, tenantId, 'Receipt', year, 'RCP', session);

      let advanceId: string | undefined;
      if (excessPaise > 0) {
        advanceId = uid('ADV');
        const advanceNumber = await nextTenantSequence(db, tenantId, 'Advance', year, 'ADV', session);
        await col<CustomerAdvanceDocument>(db, 'customerAdvances').insertOne(
          {
            _id: advanceId,
            tenantId,
            advanceNumber,
            customerId: input.customerId,
            customerSnapshot: {
              name: customer.name,
              phone: customer.phone,
            },
            sourceType: 'ReceiptExcess',
            receiptId,
            date: input.date,
            originalAmountPaise: excessPaise,
            remainingAmountPaise: excessPaise,
            status: 'Available',
            version: 1,
            createdAt: now,
            createdBy: identity.userId,
          },
          {session}
        );
      }

      // Process allocations & snapshot data
      let snapshotInvoice: any = null;
      let snapshotAlloc: any = null;

      for (const alloc of input.allocations) {
        if (alloc.targetType === 'Invoice') {
          const inv = await col<InvoiceDocument>(db, 'invoices').findOneAndUpdate(
            {
              _id: alloc.targetId,
              tenantId,
              customerId: input.customerId,
              status: 'Issued',
              duePaise: {$gte: alloc.amountPaise},
            },
            {
              $inc: {duePaise: -alloc.amountPaise, allocatedPaidPaise: alloc.amountPaise, allocatedReceiptPaise: alloc.amountPaise, version: 1},
              $set: {updatedAt: now},
            },
            {session, returnDocument: 'after'}
          );
          if (!inv) {
            throw new AppError(400, `Invoice ${alloc.targetId} has insufficient due or does not belong to this customer.`);
          }
          const paymentStatus = inv.duePaise === 0 ? 'Paid' : 'PartlyPaid';
          await col(db, 'invoices').updateOne(
            {_id: inv._id, tenantId},
            {$set: {paymentStatus}},
            {session}
          );
          snapshotInvoice = inv;
          snapshotAlloc = alloc;
        } else if (alloc.targetType === 'OpeningReceivable') {
          const op = await col(db, 'openingReceivables').findOneAndUpdate(
            {
              _id: alloc.targetId,
              tenantId,
              customerId: input.customerId,
              remainingAmountPaise: {$gte: alloc.amountPaise},
            },
            {
              $inc: {remainingAmountPaise: -alloc.amountPaise, version: 1},
              $set: {updatedAt: now},
            },
            {session, returnDocument: 'after'}
          );
          if (!op) {
            throw new AppError(400, `Opening receivable ${alloc.targetId} has insufficient due or does not belong to this customer.`);
          }
        }

        await insertCustomerAllocation(db, identity, session, {
          customerId: input.customerId,
          sourceType: 'Receipt',
          sourceId: receiptId,
          targetType: alloc.targetType,
          targetId: alloc.targetId,
          amountPaise: alloc.amountPaise,
          effectiveDate: input.date,
        });
      }

      // Calculate total customer outstanding after this receipt
      const activeCustomerInvoices = await col<InvoiceDocument>(db, 'invoices').find(
        {tenantId, customerId: input.customerId, status: 'Issued'},
        {session}
      ).toArray();
      const customerOutstandingAfterPaise = activeCustomerInvoices.reduce((sum, item) => sum + (item.duePaise || 0), 0);

      // Fetch tenant & company settings for seller snapshot
      const [settingsDoc, tenantDoc] = await Promise.all([
        col(db, 'companySettings').findOne({tenantId}, {session}),
        col(db, 'tenants').findOne({_id: tenantId}, {session}),
      ]);

      const sellerSnapshot = {
        name: settingsDoc?.name || tenantDoc?.companyName || 'My Store',
        phone: settingsDoc?.phone || '',
        email: settingsDoc?.email || '',
        address: settingsDoc?.address || '',
        gst: settingsDoc?.gst || '',
        logoFileId: settingsDoc?.logoFileId || null,
      };

      const primaryComp = input.components[0] || {
        account: 'Cash',
        method: 'Cash',
        amountPaise: totalReceiptPaise,
        reference: '',
      };

      const invTotalPaise = snapshotInvoice
        ? (snapshotInvoice.grandTotalPaise ?? snapshotInvoice.totalPaise ?? Math.round((snapshotInvoice.total ?? 0) * 100))
        : totalReceiptPaise;
      const amountAppliedPaise = snapshotAlloc ? snapshotAlloc.amountPaise : totalReceiptPaise;
      const dueAfterPaise = snapshotInvoice ? (snapshotInvoice.duePaise || 0) : 0;
      const dueBeforePaise = dueAfterPaise + amountAppliedPaise;

      const receiptSnapshot = {
        invoiceId: snapshotInvoice ? (snapshotInvoice.id || String(snapshotInvoice._id)) : (input.allocations[0]?.targetId || ''),
        invoiceNumber: snapshotInvoice ? (snapshotInvoice.invoiceNumber || snapshotInvoice.id || String(snapshotInvoice._id)) : (input.allocations[0]?.targetId || 'Invoice'),
        invoiceTotalPaise: invTotalPaise,
        dueBeforePaise,
        amountAppliedPaise,
        dueAfterPaise,
        customerOutstandingAfterPaise,
        customer: {
          name: customer.name,
          phone: customer.phone || '',
          email: customer.email || '',
          address: customer.address || '',
          gst: customer.gst || '',
        },
        seller: sellerSnapshot,
        company: sellerSnapshot,
        payment: {
          account: primaryComp.account,
          method: primaryComp.method,
          amountPaise: primaryComp.amountPaise,
          reference: primaryComp.reference || '',
        },
        receiptDate: input.date,
        receiptNumber,
      };

      const receiptRecord: CustomerReceiptDocument = {
        _id: receiptId,
        tenantId,
        receiptNumber,
        customerId: input.customerId,
        customerSnapshot: {
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          address: customer.address,
          gst: customer.gst,
        },
        date: input.date,
        totalAmountPaise: totalReceiptPaise,
        allocatedAmountPaise: totalAllocatedPaise,
        advanceAmountPaise: excessPaise,
        advanceId,
        components: input.components,
        allocations: input.allocations,
        receiptSnapshot,
        notes: input.notes,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col<CustomerReceiptDocument>(db, 'customerReceipts').insertOne(receiptRecord, {session});
      await recordAudit(db, {
        identity,
        action: 'Create',
        entityType: 'customerReceipt',
        entityId: receiptId,
        detail: `Customer receipt ${receiptNumber} recorded`,
        after: {receiptNumber, totalAmountPaise: totalReceiptPaise},
      }, session);

      return receiptRecord;
    }
  );
}

// 2. Allocate Customer Advance
export async function allocateCustomerAdvance(
  db: Db,
  identity: Identity,
  raw: unknown
) {
  const input = AllocateCustomerAdvanceSchema.parse(raw);
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'allocateCustomerAdvance',
    input.advanceId,
    input,
    async (session: ClientSession) => {
      await assertSalePostingDay(db, tenantId, input.effectiveDate, session);
      const advance = await col<CustomerAdvanceDocument>(db, 'customerAdvances').findOne(
        {
          _id: input.advanceId,
          tenantId,
          status: {$in: ['Available', 'PartlyConsumed']},
        },
        {session}
      );
      if (!advance) throw new AppError(404, 'Customer advance not found or already consumed.');
      if (advance.version !== input.expectedVersion) throw new AppError(409, 'Advance version mismatch; retry.');

      // Customer financial lock
      const customer = await col(db, 'customers').findOneAndUpdate(
        {_id: advance.customerId, tenantId, status: 'Active'},
        {$inc: {financialVersion: 1}},
        {session, returnDocument: 'after'}
      );
      if (!customer) throw new AppError(404, 'Customer not found or archived.');

      const totalAllocated = sumSalePaise(input.allocations.map(a => a.amountPaise));
      if (totalAllocated > advance.remainingAmountPaise) {
        throw new AppError(400, 'Allocations exceed available advance balance.');
      }

      const now = new Date();
      const after = advance.remainingAmountPaise - totalAllocated;
      const status = deriveCustomerAdvanceStatus(advance.originalAmountPaise, after);

      const updResult = await col(db, 'customerAdvances').updateOne(
        {_id: advance._id, tenantId, version: advance.version},
        {
          $inc: {remainingAmountPaise: -totalAllocated, version: 1},
          $set: {status, updatedAt: now},
        },
        {session}
      );
      if (updResult.matchedCount !== 1) throw new AppError(409, 'Advance changed concurrently; retry.');

      for (const alloc of input.allocations) {
        if (alloc.targetType === 'Invoice') {
          const inv = await col<InvoiceDocument>(db, 'invoices').findOneAndUpdate(
            {
              _id: alloc.targetId,
              tenantId,
              customerId: advance.customerId,
              status: 'Issued',
              duePaise: {$gte: alloc.amountPaise},
            },
            {
              $inc: {duePaise: -alloc.amountPaise, allocatedPaidPaise: alloc.amountPaise, allocatedAdvancePaise: alloc.amountPaise, version: 1},
              $set: {updatedAt: now},
            },
            {session, returnDocument: 'after'}
          );
          if (!inv) {
            throw new AppError(400, `Invoice ${alloc.targetId} has insufficient due or does not belong to this customer.`);
          }
          const paymentStatus = inv.duePaise === 0 ? 'Paid' : 'PartlyPaid';
          await col(db, 'invoices').updateOne(
            {_id: inv._id, tenantId},
            {$set: {paymentStatus}},
            {session}
          );
        } else if (alloc.targetType === 'OpeningReceivable') {
          const op = await col(db, 'openingReceivables').findOneAndUpdate(
            {
              _id: alloc.targetId,
              tenantId,
              customerId: advance.customerId,
              remainingAmountPaise: {$gte: alloc.amountPaise},
            },
            {
              $inc: {remainingAmountPaise: -alloc.amountPaise, version: 1},
              $set: {updatedAt: now},
            },
            {session, returnDocument: 'after'}
          );
          if (!op) {
            throw new AppError(400, `Opening receivable ${alloc.targetId} has insufficient due or does not belong to this customer.`);
          }
        }

        await insertCustomerAllocation(db, identity, session, {
          customerId: advance.customerId,
          sourceType: 'Advance',
          sourceId: advance._id,
          targetType: alloc.targetType,
          targetId: alloc.targetId,
          amountPaise: alloc.amountPaise,
          effectiveDate: input.effectiveDate,
        });
      }

      await recordAudit(db, {
        identity,
        action: 'Allocate',
        entityType: 'customerAdvance',
        entityId: advance._id,
        detail: `Advance ${advance.advanceNumber} allocated ${totalAllocated / 100}`,
        after: {remainingAmountPaise: after, status},
      }, session);

      return {success: true, remainingAmountPaise: after, status};
    }
  );
}

// 3. Refund Customer Advance
export async function refundCustomerAdvance(
  db: Db,
  identity: Identity,
  raw: unknown
) {
  const input = RefundCustomerAdvanceSchema.parse(raw);
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'refundCustomerAdvance',
    input.advanceId,
    input,
    async (session: ClientSession) => {
      const advance = await col<CustomerAdvanceDocument>(db, 'customerAdvances').findOne(
        {
          _id: input.advanceId,
          tenantId,
          status: {$in: ['Available', 'PartlyConsumed']},
        },
        {session}
      );
      if (!advance) throw new AppError(404, 'Customer advance not found or already consumed.');
      if (advance.version !== input.expectedVersion) throw new AppError(409, 'Advance version mismatch; retry.');
      if (input.amountPaise > advance.remainingAmountPaise) {
        throw new AppError(400, 'Refund amount exceeds available advance balance.');
      }

      const customer = await col(db, 'customers').findOneAndUpdate(
        {_id: advance.customerId, tenantId, status: 'Active'},
        {$inc: {financialVersion: 1}},
        {session, returnDocument: 'after'}
      );
      if (!customer) throw new AppError(404, 'Customer not found or archived.');

      const now = new Date();
      const year = input.refundDate.slice(0, 4);
      const after = advance.remainingAmountPaise - input.amountPaise;
      const status = after === 0 && advance.originalAmountPaise === input.amountPaise ? 'Refunded' : deriveCustomerAdvanceStatus(advance.originalAmountPaise, after);

      await col(db, 'customerAdvances').updateOne(
        {_id: advance._id, tenantId, version: advance.version},
        {
          $inc: {remainingAmountPaise: -input.amountPaise, version: 1},
          $set: {status, updatedAt: now},
        },
        {session}
      );

      // Deduct from account with overdraft protection
      const accResult = await col(db, 'tenantAccountBalances').updateOne(
        {
          tenantId,
          account: input.account,
          balancePaise: {$gte: input.amountPaise},
        },
        {
          $inc: {balancePaise: -input.amountPaise, version: 1},
          $set: {updatedAt: now},
        },
        {session}
      );
      if (accResult.matchedCount !== 1) {
        throw new AppError(409, `Insufficient funds in ${input.account} for customer refund.`);
      }

      const refundId = uid('CRF');
      const refundNumber = await nextTenantSequence(db, tenantId, 'Refund', year, 'CRF', session);

      await col(db, 'accountMovements').insertOne(
        {
          _id: uid('ACM'),
          tenantId,
          account: input.account,
          date: input.refundDate,
          qty: -input.amountPaise,
          reason: 'Customer advance refund',
          reference: refundNumber,
          sourceType: 'CustomerRefund',
          sourceId: refundId,
          createdAt: now,
          createdBy: identity.userId,
        },
        {session}
      );

      const refundRecord: CustomerRefundDocument = {
        _id: refundId,
        tenantId,
        refundNumber,
        customerId: advance.customerId,
        advanceId: advance._id,
        account: input.account,
        amountPaise: input.amountPaise,
        refundDate: input.refundDate,
        reason: input.reason,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col<CustomerRefundDocument>(db, 'customerRefunds').insertOne(refundRecord, {session});
      await recordAudit(db, {
        identity,
        action: 'Refund',
        entityType: 'customerRefund',
        entityId: refundId,
        detail: `Refund ${refundNumber} of ${input.amountPaise / 100}`,
        after: {refundNumber, amountPaise: input.amountPaise},
      }, session);

      return refundRecord;
    }
  );
}

// Restore only an active authoritative allocation; embedded receipt rows are snapshots.
async function restoreCustomerAllocationTarget(db: Db, identity: Identity, alloc: any, session: ClientSession) {
  const tenantId = identity.tenantId;
  if (!['Receipt', 'Advance'].includes(alloc.sourceType)) {
    throw new AppError(409, 'Return credits must be corrected through the return workflow.');
  }

  if (alloc.targetType === 'Invoice') {
    const invoice = await col<InvoiceDocument>(db, 'invoices').findOne(
      {_id: alloc.targetId, tenantId, customerId: alloc.customerId, status: 'Issued'},
      {session}
    );
    if (!invoice) throw new AppError(409, 'Allocation target invoice is unavailable.');

    const returned = await col(db, 'customerReturns').findOne({tenantId, invoiceId: invoice._id}, {session});
    const paid = invoice.allocatedPaidPaise ?? 0;
    const receipt = Math.max(invoice.allocatedReceiptPaise ?? 0, paid - (invoice.allocatedAdvancePaise ?? 0));
    const advance = Math.max(invoice.allocatedAdvancePaise ?? 0, paid - (invoice.allocatedReceiptPaise ?? 0));
    const remainingPaid = paid - alloc.amountPaise;
    const due = invoice.duePaise + alloc.amountPaise;
    const maxDueAllowed = (invoice.originalTotalPaise ?? invoice.totalPaise) - (invoice.allocatedCreditPaise ?? 0);

    if (remainingPaid < 0 || due > maxDueAllowed || (alloc.sourceType === 'Receipt' ? receipt : advance) < alloc.amountPaise) {
      if (returned) {
        throw new AppError(
          409,
          `This invoice has return settlement ${returned.returnNumber}. Reversing this payment allocation would cause invoice due (${due / 100}) to exceed net invoice liability (${maxDueAllowed / 100}). Supported recovery: reconcile or reverse the return settlement first.`
        );
      }
      throw new AppError(409, 'Invoice allocation totals need reconciliation before reversal.');
    }

    await col(db, 'invoices').updateOne(
      {_id: invoice._id, tenantId},
      {
        $set: {
          duePaise: due,
          allocatedPaidPaise: remainingPaid,
          allocatedReceiptPaise: receipt - (alloc.sourceType === 'Receipt' ? alloc.amountPaise : 0),
          allocatedAdvancePaise: advance - (alloc.sourceType === 'Advance' ? alloc.amountPaise : 0),
          paymentStatus: due === 0 ? 'Paid' : remainingPaid === 0 && !(invoice.allocatedCreditPaise ?? 0) ? 'Unpaid' : 'PartlyPaid',
          updatedAt: new Date(),
        },
        $inc: {version: 1},
      },
      {session}
    );
  } else if (alloc.targetType === 'OpeningReceivable') {
    const target = await col(db, 'openingReceivables').findOne(
      {_id: alloc.targetId, tenantId, customerId: alloc.customerId},
      {session}
    );
    if (!target || target.remainingAmountPaise + alloc.amountPaise > target.originalAmountPaise) {
      throw new AppError(409, 'Opening balance allocation needs reconciliation.');
    }
    await col(db, 'openingReceivables').updateOne(
      {_id: target._id, tenantId},
      {$inc: {remainingAmountPaise: alloc.amountPaise, version: 1}, $set: {updatedAt: new Date()}},
      {session}
    );
  } else {
    throw new AppError(409, 'Unknown allocation target.');
  }
}

// 4. Reverse Customer Receipt
export async function reverseCustomerReceipt(
  db: Db,
  identity: Identity,
  raw: unknown
) {
  const input = ReverseCustomerReceiptSchema.parse(raw);
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'reverseCustomerReceipt',
    input.receiptId,
    input,
    async (session: ClientSession) => {
      await assertSalePostingDay(db, tenantId, todayInKolkata(), session);

      const receipt = await col<CustomerReceiptDocument>(db, 'customerReceipts').findOne(
        {_id: input.receiptId, tenantId, isReversed: false},
        {session}
      );
      if (!receipt) throw new AppError(404, 'Receipt not found or already reversed.');

      const customer = await col(db, 'customers').findOneAndUpdate(
        {_id: receipt.customerId, tenantId, status: 'Active'},
        {$inc: {financialVersion: 1}},
        {session, returnDocument: 'after'}
      );
      if (!customer) throw new AppError(404, 'Customer not found or archived.');

      const now = new Date();
      const reversalDate = todayInKolkata();

      // Downstream consumption check
      // Verify and cancel any customer advances derived from this receipt
      const allDerivedAdvances = await col<CustomerAdvanceDocument>(db, 'customerAdvances').find(
        {
          tenantId,
          $or: [
            ...(receipt.advanceId ? [{_id: receipt.advanceId}] : []),
            {receiptId: receipt._id},
            {sourceReceiptId: receipt._id},
          ],
        },
        {session}
      ).toArray();

      for (const adv of allDerivedAdvances) {
        if (adv.remainingAmountPaise < adv.originalAmountPaise) {
          throw new AppError(409, 'Cannot reverse receipt: customer advance produced by this receipt has already been partially or fully consumed.');
        }
      }
      for (const adv of allDerivedAdvances) {
        await col(db, 'customerAdvances').updateOne(
          {_id: adv._id, tenantId},
          {$set: {status: 'Reversed', remainingAmountPaise: 0, updatedAt: now}},
          {session}
        );
      }

      // Previously reversed allocations are already represented by derived advances.
      const activeAllocations = await col(db, 'customerAllocations').find({
        tenantId,
        customerId: receipt.customerId,
        sourceType: 'Receipt',
        sourceId: receipt._id,
        isReversal: false,
      }, {session}).toArray();

      const backedAmount = activeAllocations.reduce((n, a) => n + a.amountPaise, 0)
        + allDerivedAdvances.reduce((n, a) => n + a.originalAmountPaise, 0);
      if (backedAmount !== receipt.totalAmountPaise) {
        throw new AppError(409, 'Receipt allocation history does not reconcile. No funds were reversed.');
      }

      for (const allocation of activeAllocations) {
        await restoreCustomerAllocationTarget(db, identity, allocation, session);
        // Record immutable compensating reversal allocation
        await col(db, 'customerAllocations').insertOne({
          _id: uid('CAL'),
          tenantId,
          customerId: receipt.customerId,
          targetType: allocation.targetType,
          targetId: allocation.targetId,
          sourceType: 'Receipt',
          sourceId: receipt._id,
          amountPaise: -allocation.amountPaise,
          isReversal: true,
          reversalOfAllocationId: allocation._id,
          reversalReason: input.reason,
          date: reversalDate,
          effectiveDate: reversalDate,
          createdAt: now,
          createdBy: identity.userId,
        }, {session});
      }

      // Mark original allocations as reversed
      await col(db, 'customerAllocations').updateMany(
        {tenantId, sourceType: 'Receipt', sourceId: receipt._id, isReversal: false},
        {
          $set: {
            isReversed: true,
            isReversal: true,
            reversalReason: input.reason,
            reversedAt: now,
            reversedBy: identity.userId,
          },
        },
        {session}
      );

      await col(db, 'customerReceipts').updateOne(
        {_id: receipt._id, tenantId},
        {
          $set: {
            isReversed: true,
            reversalDate,
            reversalReason: input.reason,
            reversedAt: now,
            reversedBy: identity.userId,
          },
        },
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Reverse',
        entityType: 'customerReceipt',
        entityId: receipt._id,
        detail: `Receipt ${receipt.receiptNumber} reversed: ${input.reason}`,
      }, session);

      return {success: true};
    }
  );
}

// 5. Reverse Customer Allocation
export async function reverseCustomerAllocation(
  db: Db,
  identity: Identity,
  raw: unknown
) {
  const input = ReverseCustomerAllocationSchema.parse(raw);
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'reverseCustomerAllocation',
    input.allocationId,
    input,
    async (session: ClientSession) => {
      await assertSalePostingDay(db, tenantId, todayInKolkata(), session);

      const alloc = await col(db, 'customerAllocations').findOne(
        {_id: input.allocationId, tenantId, isReversal: false},
        {session}
      );
      if (!alloc) throw new AppError(404, 'Customer allocation not found or already reversed.');

      const customer = await col(db, 'customers').findOneAndUpdate(
        {_id: alloc.customerId, tenantId, status: 'Active'},
        {$inc: {financialVersion: 1}},
        {session, returnDocument: 'after'}
      );
      if (!customer) throw new AppError(404, 'Customer not found or archived.');

      const now = new Date();
      const reversalDate = todayInKolkata();

      await restoreCustomerAllocationTarget(db, identity, alloc, session);

      // If source was advance: restore advance remaining
      if (alloc.sourceType === 'Advance') {
        const adv = await col<CustomerAdvanceDocument>(db, 'customerAdvances').findOne({_id: alloc.sourceId, tenantId}, {session});
        if (!adv || adv.customerId !== alloc.customerId || adv.status === 'Reversed') {
          throw new AppError(409, 'Source advance is unavailable or reversed.');
        }
        const after = adv.remainingAmountPaise + alloc.amountPaise;
        const status = deriveCustomerAdvanceStatus(adv.originalAmountPaise, after);
        await col(db, 'customerAdvances').updateOne(
          {_id: adv._id, tenantId},
          {
            $inc: {remainingAmountPaise: alloc.amountPaise, version: 1},
            $set: {status, updatedAt: now},
          },
          {session}
        );
      } else if (alloc.sourceType === 'Receipt') {
        const source = await col(db, 'customerReceipts').findOne({_id: alloc.sourceId, tenantId, customerId: alloc.customerId, isReversed: false}, {session});
        if (!source) throw new AppError(409, 'Source receipt is unavailable or reversed.');

        // Receipt allocation reversal frees previously applied funds as an available customer advance
        const advId = uid('ADV');
        const year = (alloc.date || reversalDate).slice(0, 4);
        const advanceNumber = await nextTenantSequence(db, tenantId, 'Advance', year, 'ADV', session);
        await col<CustomerAdvanceDocument>(db, 'customerAdvances').insertOne(
          {
            _id: advId,
            tenantId,
            advanceNumber,
            customerId: alloc.customerId,
            customerSnapshot: {
              name: customer.name,
              phone: customer.phone,
            },
            sourceType: 'ReceiptExcess',
            receiptId: alloc.sourceId,
            sourceReceiptId: alloc.sourceId,
            date: reversalDate,
            originalAmountPaise: alloc.amountPaise,
            remainingAmountPaise: alloc.amountPaise,
            status: 'Available',
            version: 1,
            createdAt: now,
            createdBy: identity.userId,
          },
          {session}
        );
      }

      // Record compensating reversal allocation
      await col(db, 'customerAllocations').insertOne({
        _id: uid('CAL'),
        tenantId,
        customerId: alloc.customerId,
        targetType: alloc.targetType,
        targetId: alloc.targetId,
        sourceType: alloc.sourceType,
        sourceId: alloc.sourceId,
        amountPaise: -alloc.amountPaise,
        isReversal: true,
        reversalOfAllocationId: alloc._id,
        reversalReason: input.reason,
        date: reversalDate,
        effectiveDate: reversalDate,
        createdAt: now,
        createdBy: identity.userId,
      }, {session});

      await col(db, 'customerAllocations').updateOne(
        {_id: alloc._id, tenantId},
        {
          $set: {
            isReversed: true,
            isReversal: true,
            reversalReason: input.reason,
            reversedAt: now,
            reversedBy: identity.userId,
          },
        },
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Reverse',
        entityType: 'customerAllocation',
        entityId: alloc._id,
        detail: `Allocation ${alloc._id} reversed: ${input.reason}`,
      }, session);

      return {success: true};
    }
  );
}

// 6. Reverse Customer Refund
export async function reverseCustomerRefund(
  db: Db,
  identity: Identity,
  raw: unknown
) {
  const input = ReverseCustomerRefundSchema.parse(raw);
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'reverseCustomerRefund',
    input.refundId,
    input,
    async (session: ClientSession) => {
      await assertSalePostingDay(db, tenantId, todayInKolkata(), session);

      const refund = await col<CustomerRefundDocument>(db, 'customerRefunds').findOne(
        {_id: input.refundId, tenantId, isReversed: false},
        {session}
      );
      if (!refund) throw new AppError(404, 'Refund not found or already reversed.');

      const customer = await col(db, 'customers').findOneAndUpdate(
        {_id: refund.customerId, tenantId, status: 'Active'},
        {$inc: {financialVersion: 1}},
        {session, returnDocument: 'after'}
      );
      if (!customer) throw new AppError(404, 'Customer not found or archived.');

      const now = new Date();
      const reversalDate = todayInKolkata();

      if (refund.advanceId) {
        // Restore advance credit
        const adv = await col<CustomerAdvanceDocument>(db, 'customerAdvances').findOne({_id: refund.advanceId, tenantId}, {session});
        if (!adv || adv.customerId !== refund.customerId || adv.status === 'Reversed') {
          throw new AppError(409, 'Source advance is unavailable or reversed.');
        }
        const after = adv.remainingAmountPaise + refund.amountPaise;
        const status = deriveCustomerAdvanceStatus(adv.originalAmountPaise, after);
        await col(db, 'customerAdvances').updateOne(
          {_id: adv._id, tenantId},
          {
            $inc: {remainingAmountPaise: refund.amountPaise, version: 1},
            $set: {status, updatedAt: now},
          },
          {session}
        );
      } else if (refund.returnId) {
        // Direct return-refund reversal: restore customer credit as an available advance
        const ret = await col(db, 'customerReturns').findOne({_id: refund.returnId, tenantId}, {session});
        if (!ret) throw new AppError(404, 'Linked return not found for this refund.');

        const advId = uid('ADV');
        const year = reversalDate.slice(0, 4);
        const advanceNumber = await nextTenantSequence(db, tenantId, 'Advance', year, 'ADV', session);
        await col<CustomerAdvanceDocument>(db, 'customerAdvances').insertOne({
          _id: advId,
          tenantId,
          advanceNumber,
          customerId: refund.customerId,
          customerSnapshot: {
            name: customer.name,
            phone: customer.phone,
          },
          sourceType: 'ReturnCredit',
          sourceId: refund.returnId,
          date: reversalDate,
          originalAmountPaise: refund.amountPaise,
          remainingAmountPaise: refund.amountPaise,
          status: 'Available',
          version: 1,
          createdAt: now,
          createdBy: identity.userId,
        }, {session});
      } else {
        throw new AppError(409, 'Use the return settlement correction workflow for a direct return refund.');
      }

      // Redeposit funds into Cash/Bank
      await col(db, 'tenantAccountBalances').updateOne(
        {tenantId, account: refund.account},
        {
          $inc: {balancePaise: refund.amountPaise, version: 1},
          $set: {updatedAt: now},
        },
        {session}
      );

      await col(db, 'accountMovements').insertOne(
        {
          _id: uid('ACM'),
          tenantId,
          account: refund.account,
          date: reversalDate,
          qty: refund.amountPaise,
          reason: 'Customer refund reversal',
          reference: refund.refundNumber,
          sourceType: 'CustomerRefundReversal',
          sourceId: refund._id,
          createdAt: now,
          createdBy: identity.userId,
        },
        {session}
      );

      await col(db, 'customerRefunds').updateOne(
        {_id: refund._id, tenantId},
        {
          $set: {
            isReversed: true,
            reversalDate,
            reversalReason: input.reason,
            reversedAt: now,
            reversedBy: identity.userId,
          },
        },
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Reverse',
        entityType: 'customerRefund',
        entityId: refund._id,
        detail: `Refund ${refund.refundNumber} reversed: ${input.reason}`,
      }, session);

      return {success: true};
    }
  );
}

// 7. Get Customer Statement
export async function getCustomerStatement(
  db: Db,
  identity: Identity,
  customerId: string,
  raw: unknown
) {
  const query = CustomerStatementQuerySchema.parse(raw);
  const tenantId = identity.tenantId;

  const customer = await col(db, 'customers').findOne({_id: customerId, tenantId});
  if (!customer) throw new AppError(404, 'Customer not found.');

  const fromDate = query.fromDate || '1970-01-01';
  const toDate = query.toDate || '9999-12-31';

  // Compute balance before fromDate:
  // Invoices: +totalPaise
  // OpeningReceivables: +originalAmountPaise
  // Receipts issued before fromDate: -totalAmountPaise
  // Receipt reversals before fromDate: +totalAmountPaise
  // Refunds issued before fromDate: +amountPaise
  // Refund reversals before fromDate: -amountPaise
  // Returns before fromDate: -refundPaise
  const [
    priorInvoices,
    priorReceipts,
    priorReceiptReversals,
    priorRefunds,
    priorRefundReversals,
    priorReturns,
    opening,
  ] = await Promise.all([
    col<InvoiceDocument>(db, 'invoices').aggregate([
      {$match: {tenantId, customerId, status: 'Issued', invoiceDate: {$lt: fromDate}}},
      {$group: {_id: null, sum: {$sum: '$totalPaise'}}},
    ]).next(),
    col<CustomerReceiptDocument>(db, 'customerReceipts').aggregate([
      {$match: {tenantId, customerId, date: {$lt: fromDate}}},
      {$group: {_id: null, sum: {$sum: '$totalAmountPaise'}}},
    ]).next(),
    col<CustomerReceiptDocument>(db, 'customerReceipts').aggregate([
      {$match: {tenantId, customerId, isReversed: true, reversalDate: {$lt: fromDate}}},
      {$group: {_id: null, sum: {$sum: '$totalAmountPaise'}}},
    ]).next(),
    col<CustomerRefundDocument>(db, 'customerRefunds').aggregate([
      {$match: {tenantId, customerId, refundDate: {$lt: fromDate}}},
      {$group: {_id: null, sum: {$sum: '$amountPaise'}}},
    ]).next(),
    col<CustomerRefundDocument>(db, 'customerRefunds').aggregate([
      {$match: {tenantId, customerId, isReversed: true, reversalDate: {$lt: fromDate}}},
      {$group: {_id: null, sum: {$sum: '$amountPaise'}}},
    ]).next(),
    col(db, 'customerReturns').aggregate([
      {$match: {tenantId, customerId, date: {$lt: fromDate}}},
      {$group: {_id: null, sum: {$sum: '$refundPaise'}}},
    ]).next(),
    col(db, 'openingReceivables').aggregate([
      {$match: {tenantId, customerId}},
      {$group: {_id: null, sum: {$sum: '$originalAmountPaise'}}},
    ]).next(),
  ]);

  const openingPaise = opening?.sum ?? 0;
  const priorDebit = (priorInvoices?.sum ?? 0) + (priorReceiptReversals?.sum ?? 0) + (priorRefunds?.sum ?? 0) + openingPaise;
  const priorCredit = (priorReceipts?.sum ?? 0) + (priorRefundReversals?.sum ?? 0) + (priorReturns?.sum ?? 0);
  const balanceBeforePagePaise = priorDebit - priorCredit;

  // Retrieve transactions in the date range
  const [
    invoices,
    receipts,
    reversedReceiptsInRange,
    refunds,
    reversedRefundsInRange,
    returns,
    openingReceivablesInRange,
  ] = await Promise.all([
    col<InvoiceDocument>(db, 'invoices').find({
      tenantId, customerId, status: 'Issued',
      invoiceDate: {$gte: fromDate, $lte: toDate},
    }).toArray(),
    col<CustomerReceiptDocument>(db, 'customerReceipts').find({
      tenantId, customerId,
      date: {$gte: fromDate, $lte: toDate},
    }).toArray(),
    col<CustomerReceiptDocument>(db, 'customerReceipts').find({
      tenantId, customerId, isReversed: true,
      reversalDate: {$gte: fromDate, $lte: toDate},
    }).toArray(),
    col<CustomerRefundDocument>(db, 'customerRefunds').find({
      tenantId, customerId,
      refundDate: {$gte: fromDate, $lte: toDate},
    }).toArray(),
    col<CustomerRefundDocument>(db, 'customerRefunds').find({
      tenantId, customerId, isReversed: true,
      reversalDate: {$gte: fromDate, $lte: toDate},
    }).toArray(),
    col(db, 'customerReturns').find({
      tenantId, customerId,
      date: {$gte: fromDate, $lte: toDate},
    }).toArray(),
    col(db, 'openingReceivables').find({
      tenantId, customerId,
      date: {$gte: fromDate, $lte: toDate},
    }).toArray(),
  ]);

  type StatementEntry = {
    id: string;
    date: string;
    type: 'Invoice' | 'Receipt' | 'ReceiptReversal' | 'Refund' | 'RefundReversal' | 'Return' | 'OpeningReceivable';
    reference: string;
    description: string;
    debitPaise: number;
    creditPaise: number;
    runningBalancePaise: number;
    createdAt: Date;
  };

  const rawEntries: StatementEntry[] = [
    ...invoices.map(inv => ({
      id: inv._id,
      date: inv.invoiceDate,
      type: 'Invoice' as const,
      reference: inv.invoiceNumber || inv._id,
      description: `Sales Invoice (${inv.lines?.length || 0} items)`,
      debitPaise: inv.totalPaise,
      creditPaise: 0,
      runningBalancePaise: 0,
      createdAt: inv.createdAt,
    })),
    ...openingReceivablesInRange.map((op: any) => ({
      id: op._id,
      date: op.date || fromDate,
      type: 'OpeningReceivable' as const,
      reference: op.reference || 'Opening Balance',
      description: 'Opening Accounts Receivable Balance',
      debitPaise: op.originalAmountPaise,
      creditPaise: 0,
      runningBalancePaise: 0,
      createdAt: op.createdAt || new Date(0),
    })),
    ...receipts.map(rcpt => ({
      id: rcpt._id,
      date: rcpt.date,
      type: 'Receipt' as const,
      reference: rcpt.receiptNumber,
      description: `Customer Receipt (${rcpt.components?.map((c: any) => c.method).join(', ') || 'Payment'})`,
      debitPaise: 0,
      creditPaise: rcpt.totalAmountPaise,
      runningBalancePaise: 0,
      createdAt: rcpt.createdAt,
    })),
    ...reversedReceiptsInRange.map(rcpt => ({
      id: `${rcpt._id}_rev`,
      date: (rcpt as any).reversalDate || rcpt.date,
      type: 'ReceiptReversal' as const,
      reference: rcpt.receiptNumber,
      description: `Receipt Reversal: ${rcpt.reversalReason || 'Reversed'}`,
      debitPaise: rcpt.totalAmountPaise,
      creditPaise: 0,
      runningBalancePaise: 0,
      createdAt: rcpt.reversedAt || rcpt.createdAt,
    })),
    ...refunds.map(rf => ({
      id: rf._id,
      date: rf.refundDate,
      type: 'Refund' as const,
      reference: rf.refundNumber,
      description: `Refund (${rf.reason})`,
      debitPaise: rf.amountPaise,
      creditPaise: 0,
      runningBalancePaise: 0,
      createdAt: rf.createdAt,
    })),
    ...reversedRefundsInRange.map(rf => ({
      id: `${rf._id}_rev`,
      date: (rf as any).reversalDate || rf.refundDate,
      type: 'RefundReversal' as const,
      reference: rf.refundNumber,
      description: `Refund Reversal: ${rf.reversalReason || 'Reversed'}`,
      debitPaise: 0,
      creditPaise: rf.amountPaise,
      runningBalancePaise: 0,
      createdAt: rf.reversedAt || rf.createdAt,
    })),
    ...returns.map((ret: any) => ({
      id: ret._id,
      date: ret.date,
      type: 'Return' as const,
      reference: ret.returnNumber || ret._id,
      description: `Sales Return (${ret.reason})`,
      debitPaise: 0,
      creditPaise: ret.refundPaise || ret.totalRefundPaise || 0,
      runningBalancePaise: 0,
      createdAt: ret.createdAt,
    })),
  ];

  // Sort chronologically with deterministic tie-breaker
  rawEntries.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });

  let running = balanceBeforePagePaise;
  let totalDebitPaise = 0;
  let totalCreditPaise = 0;

  for (const entry of rawEntries) {
    totalDebitPaise += entry.debitPaise;
    totalCreditPaise += entry.creditPaise;
    running += (entry.debitPaise - entry.creditPaise);
    entry.runningBalancePaise = running;
  }

  const periodClosingBalancePaise = running;
  const totalEntries = rawEntries.length;
  const limit = query.limit;
  const page = query.page;
  const totalPages = Math.max(1, Math.ceil(totalEntries / limit));
  const paginatedEntries = rawEntries.slice((page - 1) * limit, page * limit);
  const pageOpeningBalancePaise = page === 1
    ? balanceBeforePagePaise
    : (rawEntries[(page - 1) * limit - 1]?.runningBalancePaise ?? balanceBeforePagePaise);

  return {
    customerId,
    customerSnapshot: {
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      creditLimitPaise: customer.creditLimitPaise || 0,
    },
    fromDate: query.fromDate,
    toDate: query.toDate,
    balanceBeforePagePaise,
    pageOpeningBalancePaise,
    periodClosingBalancePaise,
    totalDebitPaise,
    totalCreditPaise,
    entries: paginatedEntries,
    page,
    limit,
    totalEntries,
    totalPages,
  };
}

// 8. List Customer Receipts
export async function listCustomerReceipts(
  db: Db,
  identity: Identity,
  raw: unknown
) {
  const query = CustomerReceiptsListQuerySchema.parse(raw);
  const tenantId = identity.tenantId;

  const filter: Record<string, any> = {tenantId};
  if (query.customerId) filter.customerId = query.customerId;
  if (query.dateFrom || query.dateTo) {
    filter.date = {
      ...(query.dateFrom && {$gte: query.dateFrom}),
      ...(query.dateTo && {$lte: query.dateTo}),
    };
  }
  if (query.search) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      {receiptNumber: {$regex: escaped, $options: 'i'}},
      {'customerSnapshot.name': {$regex: escaped, $options: 'i'}},
    ];
  }

  const page = query.page;
  const limit = query.limit;

  const [items, total, sumAgg] = await Promise.all([
    col<CustomerReceiptDocument>(db, 'customerReceipts')
      .find(filter)
      .sort({date: -1, createdAt: -1})
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    col(db, 'customerReceipts').countDocuments(filter),
    col<CustomerReceiptDocument>(db, 'customerReceipts').aggregate([
      {$match: filter},
      {$group: {_id: null, totalReceivedPaise: {$sum: '$totalAmountPaise'}}},
    ]).toArray(),
  ]);

  const totalReceivedPaise = sumAgg[0]?.totalReceivedPaise || 0;

  return {items, total, totalReceivedPaise, page, limit, totalPages: Math.max(1, Math.ceil(total / limit))};
}

// 9. Get Customer Receipt
export async function getCustomerReceipt(
  db: Db,
  identity: Identity,
  receiptId: string
) {
  const receipt = await col<CustomerReceiptDocument>(db, 'customerReceipts').findOne({
    _id: receiptId,
    tenantId: identity.tenantId,
  });
  if (!receipt) throw new AppError(404, 'Receipt not found.');
  return {receipt};
}
