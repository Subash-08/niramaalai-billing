import 'server-only';
import {ClientSession, Db} from 'mongodb';
import {AppError} from './db';
import {Identity} from './security';
import {uid} from '../lib/domain';
import {col, nextTenantSequence, assertPhase3MigrationComplete} from './purchase-service';
import {todayInKolkata} from './purchase-schema';
import {isValidCalendarDate} from './master-schema';
import {sumSalePaise} from './sales-calculations';
import {lockBusinessDay} from './business-day';
import type {IssueInvoiceInput} from './sales-schema';

/** Must run inside the same transaction as every stock and financial write. */
export async function assertSalePostingDay(db: Db, tenantId: string, date: string, session: ClientSession) {
  if (!isValidCalendarDate(date) || date !== todayInKolkata()) throw new AppError(400, 'Issue invoices on the current business date in Asia/Kolkata. Update the draft date first.');
  const opening = await col(db, 'openingSetups').findOne({tenantId}, {session});
  if (opening && opening.status !== 'Finalized') {
    throw new AppError(409, 'An existing opening setup is unfinished. Complete it before posting.');
  }
  if (opening?.cutoffDate && date <= opening.cutoffDate) {
    const [year, month, day] = opening.cutoffDate.split('-').map(Number);
    const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const cutoffFormatted = `${day} ${months[month - 1]} ${year}`;
    const nextFormatted = `${nextDate.getUTCDate()} ${months[nextDate.getUTCMonth()]} ${nextDate.getUTCFullYear()}`;
    throw new AppError(409, `Opening setup is finalized through ${cutoffFormatted}. Sales and purchases can be posted from ${nextFormatted}.`);
  }
  await assertPhase3MigrationComplete(db, tenantId, session);
  await lockBusinessDay(db, session, tenantId, {date});
}

export function addWarrantyMonths(date: string, months: number): string {
  if (!isValidCalendarDate(date) || !Number.isInteger(months) || months < 0 || months > 240) throw new AppError(400, 'Invalid warranty term.');
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const finalDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, finalDay));
  return target.toISOString().slice(0, 10);
}

export function deriveCustomerAdvanceStatus(original: number, remaining: number): 'Available' | 'PartlyConsumed' | 'FullyConsumed' {
  if (!Number.isSafeInteger(original) || !Number.isSafeInteger(remaining) || original <= 0 || remaining < 0 || remaining > original) throw new AppError(409, 'Customer advance balance is inconsistent.');
  return remaining === 0 ? 'FullyConsumed' : remaining === original ? 'Available' : 'PartlyConsumed';
}

export async function insertCustomerAllocation(db: Db, identity: Identity, session: ClientSession, data: {
  customerId: string; sourceType: 'Receipt' | 'Advance'; sourceId: string;
  targetType: 'Invoice' | 'OpeningReceivable'; targetId: string; amountPaise: number; effectiveDate: string;
}) {
  if (!Number.isSafeInteger(data.amountPaise) || data.amountPaise <= 0) throw new AppError(400, 'Allocation must be positive integer paise.');
  const record = {_id: uid('CAL'), tenantId: identity.tenantId, ...data, isReversal: false, createdAt: new Date(), createdBy: identity.userId};
  await col(db, 'customerAllocations').insertOne(record, {session});
  return record._id;
}

/** Issue owns the transaction and final invoice write. This function cannot be
 * called without its session; an exception must roll back the entire issue. */
export async function settleInvoiceOnIssue(db: Db, identity: Identity, session: ClientSession,
  invoice: {_id: string; customerId: string; totalPaise: number; invoiceDate: string}, input: IssueInvoiceInput) {
  const tenantId = identity.tenantId;
  const now = new Date();
  const date = invoice.invoiceDate;
  const year = date.slice(0, 4);
  const paymentTotal = sumSalePaise(input.paymentComponents.map(c => c.amountPaise));
  const advanceUsed = input.applyCustomerAdvancePaise;
  if (advanceUsed > invoice.totalPaise) throw new AppError(400, 'Apply existing advance only up to this invoice total.');
  const receiptApplied = Math.min(paymentTotal, invoice.totalPaise - advanceUsed);
  const excessPaise = paymentTotal - receiptApplied;
  if (excessPaise > 0 && !input.recordExcessAsCustomerAdvance) throw new AppError(400, 'Confirm recording the excess payment as a customer advance.');

  // This shared customer write serializes concurrent issues before checking the
  // customer's outstanding credit limit. Future receipt/return writers reuse it.
  const customer = await col(db, 'customers').findOneAndUpdate(
    {_id: invoice.customerId, tenantId, status: 'Active'},
    {$inc: {financialVersion: 1}}, {session, returnDocument: 'after'},
  );
  if (!customer) throw new AppError(404, 'Customer not found or archived.');
  const duePaise = invoice.totalPaise - advanceUsed - receiptApplied;
  if (customer.creditLimitPaise > 0 && duePaise > 0) {
    const outstanding = await col(db, 'invoices').aggregate([
      {$match: {tenantId, customerId: invoice.customerId, status: 'Issued'}},
      {$group: {_id: null, amount: {$sum: '$duePaise'}}},
    ], {session}).next();
    const opening = await col(db, 'openingReceivables').aggregate([
      {$match: {tenantId, customerId: invoice.customerId}},
      {$group: {_id: null, amount: {$sum: '$remainingAmountPaise'}}},
    ], {session}).next();
    if (sumSalePaise([outstanding?.amount ?? 0, opening?.amount ?? 0, duePaise]) > customer.creditLimitPaise &&
        (!input.creditLimitOverride || !input.creditLimitOverrideReason.trim())) throw new AppError(409, 'Customer credit limit exceeded. Explicit override and a reason are required.');
  }

  // Deterministic oldest-first advance allocation, with no unbounded in-memory array.
  let remaining = advanceUsed;
  if (remaining > 0) {
    const cursor = col(db, 'customerAdvances').find({tenantId, customerId: invoice.customerId,
      status: {$in: ['Available', 'PartlyConsumed']}, remainingAmountPaise: {$gt: 0}}, {session}).sort({date: 1, createdAt: 1, _id: 1});
    try {
      for await (const advance of cursor) {
        const amount = Math.min(remaining, advance.remainingAmountPaise);
        const after = advance.remainingAmountPaise - amount;
        const status = deriveCustomerAdvanceStatus(advance.originalAmountPaise, after);
        const result = await col(db, 'customerAdvances').updateOne({_id: advance._id, tenantId,
          customerId: invoice.customerId, remainingAmountPaise: advance.remainingAmountPaise, status: advance.status},
          {$inc: {remainingAmountPaise: -amount, version: 1}, $set: {status, updatedAt: now}}, {session});
        if (result.matchedCount !== 1) throw new AppError(409, 'Customer advance changed; retry.');
        await insertCustomerAllocation(db, identity, session, {customerId: invoice.customerId,
          sourceType: 'Advance', sourceId: advance._id, targetType: 'Invoice', targetId: invoice._id,
          amountPaise: amount, effectiveDate: date});
        remaining -= amount;
        if (remaining === 0) break;
      }
    } finally { await cursor.close(); }
    if (remaining !== 0) throw new AppError(400, 'Insufficient available customer advance.');
  }

  let receiptId: string | undefined;
  if (paymentTotal > 0) {
    receiptId = uid('RCP');
    const receiptNumber = await nextTenantSequence(db, tenantId, 'Receipt', year, 'RCP', session);
    const components = input.paymentComponents.map(component => ({
      ...component,
      componentId: uid('CMP'),
    }));

    let advanceId: string | undefined;
    if (excessPaise > 0) {
      advanceId = uid('ADV');
      await col(db, 'customerAdvances').insertOne({
        _id: advanceId,
        tenantId,
        advanceNumber: await nextTenantSequence(db, tenantId, 'Advance', year, 'ADV', session),
        customerId: invoice.customerId,
        customerSnapshot: (invoice as any).customerSnapshot,
        sourceType: 'Receipt',
        sourceReceiptId: receiptId,
        receiptId,
        originalAmountPaise: excessPaise,
        remainingAmountPaise: excessPaise,
        status: 'Available',
        version: 1,
        date,
        createdAt: now,
        createdBy: identity.userId,
      }, {session});
    }

    const allocs = [];
    if (receiptApplied > 0) {
      const allocId = await insertCustomerAllocation(db, identity, session, {
        customerId: invoice.customerId,
        sourceType: 'Receipt',
        sourceId: receiptId,
        targetType: 'Invoice',
        targetId: invoice._id,
        amountPaise: receiptApplied,
        effectiveDate: date,
      });
      allocs.push({
        allocationId: allocId,
        targetType: 'Invoice',
        targetId: invoice._id,
        amountPaise: receiptApplied,
        date,
      });
    }

    await col(db, 'customerReceipts').insertOne({
      _id: receiptId,
      tenantId,
      receiptNumber,
      customerId: invoice.customerId,
      customerSnapshot: (invoice as any).customerSnapshot,
      date,
      components,
      totalAmountPaise: paymentTotal,
      allocatedAmountPaise: receiptApplied,
      advanceAmountPaise: excessPaise,
      advanceId,
      allocations: allocs,
      invoiceId: invoice._id,
      issuedWithInvoice: true,
      status: 'Posted',
      isReversed: false,
      version: 1,
      createdAt: now,
      createdBy: identity.userId,
    }, {session});
  }
  return {receiptId, receiptApplied, advanceUsed, excessPaise, duePaise};
}
