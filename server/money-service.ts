import 'server-only';
import {Db, ClientSession} from 'mongodb';
import {AppError} from './db';
import {Identity} from './security';
import {uid} from '../lib/domain';
import {recordAudit} from './audit';
import {lockBusinessDay} from './business-day';
import {
  col,
  assertPhase3MigrationComplete,
  assertOperationalPostingAllowed,
  executeIdempotentTransaction,
} from './purchase-service';
import {signedAccountMovementPaise} from './account-initialization';
import {todayInKolkata} from './purchase-schema';
import {getOpeningBalanceForDate} from './closing-service';
import {
  RecordMoneyInInput,
  RecordMoneyInSchema,
  RecordMoneyOutInput,
  RecordMoneyOutSchema,
  RecordTransferInput,
  RecordTransferSchema,
  ReverseMoneyInput,
  ReverseMoneySchema,
  MoneyListQueryInput,
  MoneyListQuerySchema,
} from './money-schema';

export type TenantAccountBalanceDocument = {
  _id: string;
  tenantId: string;
  account: 'Cash' | 'Bank';
  balancePaise: number;
  version: number;
  updatedAt: Date;
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 1. Record Money In (Receipt)
 * Only manual money receipts (OwnerContribution, OtherReceipt).
 * Explicit source identity: sourceType: 'ManualMoneyEntry'.
 * Safe bounded integer update with upper bound guard; no upserting incomplete balances.
 */
export async function recordMoneyIn(db: Db, identity: Identity, raw: unknown) {
  const input = RecordMoneyInSchema.parse(raw);
  const tenantId = identity.tenantId;

  await assertPhase3MigrationComplete(db, tenantId);

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'recordMoneyIn',
    undefined,
    input,
    async (session: ClientSession) => {
      // Validate operational posting date and acquire business-day write fence inside transaction
      await assertOperationalPostingAllowed(db, tenantId, input.date);
      await lockBusinessDay(db, session, tenantId, {date: input.date});

      const now = new Date();

      // Increment account balance with strict bounds check; never upsert incomplete balance
      const balRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
        {
          tenantId,
          account: input.account,
          balancePaise: {$gte: 0, $lte: Number.MAX_SAFE_INTEGER - input.amountPaise},
        },
        {
          $inc: {balancePaise: input.amountPaise, version: 1},
          $set: {updatedAt: now},
        },
        {session}
      );

      if (balRes.matchedCount !== 1) {
        throw new AppError(
          409,
          `${input.account} balance record is missing or outside supported range. Please initialize accounts before posting.`
        );
      }

      const movementId = uid('MOV');
      const movement = {
        _id: movementId,
        tenantId,
        date: input.date,
        account: input.account,
        qty: input.amountPaise,
        amountPaise: input.amountPaise,
        direction: 'In' as const,
        category: input.category,
        subCategory: input.subCategory,
        paymentMethod: input.method,
        reason: input.reason,
        reference: input.reference || '',
        partyName: input.payerName || '',
        sourceType: 'ManualMoneyEntry' as const,
        sourceId: movementId,
        idempotencyKey: input.idempotencyKey,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'accountMovements').insertOne(movement, {session});

      await recordAudit(
        db,
        {
          identity,
          action: 'Create',
          entityType: 'accountMovement',
          entityId: movementId,
          detail: `Manual money in ${input.category}: ₹${(input.amountPaise / 100).toFixed(2)} to ${input.account} (${input.reason})`,
          after: movement,
        },
        session
      );

      return {success: true, movementId, amountPaise: input.amountPaise, account: input.account};
    }
  );
}

/**
 * 2. Record Money Out (Disbursement)
 * Only manual money disbursements (Expense, OwnerWithdrawal).
 * Explicit source identity: sourceType: 'ManualMoneyEntry'.
 * Atomic overdraft guard to prevent negative balance.
 */
export async function recordMoneyOut(db: Db, identity: Identity, raw: unknown) {
  const input = RecordMoneyOutSchema.parse(raw);
  const tenantId = identity.tenantId;

  await assertPhase3MigrationComplete(db, tenantId);

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'recordMoneyOut',
    undefined,
    input,
    async (session: ClientSession) => {
      // Validate operational posting date and acquire business-day write fence inside transaction
      await assertOperationalPostingAllowed(db, tenantId, input.date);
      await lockBusinessDay(db, session, tenantId, {date: input.date});

      const now = new Date();

      // Decrement account balance with atomic overdraft guard
      const balRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
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

      if (balRes.matchedCount === 0 || balRes.modifiedCount === 0) {
        throw new AppError(
          400,
          `Insufficient funds in ${input.account}. Cannot disburse ₹${(input.amountPaise / 100).toFixed(2)}.`
        );
      }

      const movementId = uid('MOV');
      const movement = {
        _id: movementId,
        tenantId,
        date: input.date,
        account: input.account,
        qty: -input.amountPaise,
        amountPaise: input.amountPaise,
        direction: 'Out' as const,
        category: input.category,
        subCategory: input.subCategory,
        paymentMethod: input.method,
        reason: input.reason,
        reference: input.reference || '',
        partyName: input.payeeName || '',
        sourceType: 'ManualMoneyEntry' as const,
        sourceId: movementId,
        idempotencyKey: input.idempotencyKey,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'accountMovements').insertOne(movement, {session});

      await recordAudit(
        db,
        {
          identity,
          action: 'Create',
          entityType: 'accountMovement',
          entityId: movementId,
          detail: `Manual money out ${input.category}: ₹${(input.amountPaise / 100).toFixed(2)} from ${input.account} (${input.reason})`,
          after: movement,
        },
        session
      );

      return {success: true, movementId, amountPaise: input.amountPaise, account: input.account};
    }
  );
}

/**
 * 3. Record Transfer (Cash ↔ Bank)
 * Atomically deducts from source and credits destination.
 * Explicit source identity: sourceType: 'ManualTransfer'.
 * Never creates profit, loss, or expense impact.
 */
export async function recordTransfer(db: Db, identity: Identity, raw: unknown) {
  const input = RecordTransferSchema.parse(raw);
  const tenantId = identity.tenantId;

  if (input.fromAccount === input.toAccount) {
    throw new AppError(400, 'From and To accounts must be different.');
  }

  await assertPhase3MigrationComplete(db, tenantId);

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'recordTransfer',
    undefined,
    input,
    async (session: ClientSession) => {
      await assertOperationalPostingAllowed(db, tenantId, input.date);
      await lockBusinessDay(db, session, tenantId, {date: input.date});

      const now = new Date();

      // Decrement fromAccount with overdraft guard
      const fromRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
        {
          tenantId,
          account: input.fromAccount,
          balancePaise: {$gte: input.amountPaise},
        },
        {
          $inc: {balancePaise: -input.amountPaise, version: 1},
          $set: {updatedAt: now},
        },
        {session}
      );

      if (fromRes.matchedCount === 0 || fromRes.modifiedCount === 0) {
        throw new AppError(
          400,
          `Insufficient funds in ${input.fromAccount} to transfer ₹${(input.amountPaise / 100).toFixed(2)}.`
        );
      }

      // Increment toAccount with upper-bound guard; do not upsert incomplete balances
      const toRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
        {
          tenantId,
          account: input.toAccount,
          balancePaise: {$gte: 0, $lte: Number.MAX_SAFE_INTEGER - input.amountPaise},
        },
        {
          $inc: {balancePaise: input.amountPaise, version: 1},
          $set: {updatedAt: now},
        },
        {session}
      );

      if (toRes.matchedCount !== 1) {
        throw new AppError(
          409,
          `${input.toAccount} balance record is missing or outside supported range. Reconcile accounts first.`
        );
      }

      const outMovementId = uid('MOV');
      const inMovementId = uid('MOV');
      const transferGroupId = `${outMovementId}<->${inMovementId}`;

      const outDoc = {
        _id: outMovementId,
        tenantId,
        date: input.date,
        account: input.fromAccount,
        toAccount: input.toAccount,
        qty: -input.amountPaise,
        amountPaise: input.amountPaise,
        direction: 'Out' as const,
        category: 'Transfer' as const,
        sourceType: 'ManualTransfer' as const,
        sourceId: transferGroupId,
        reason: input.reason,
        reference: input.reference || '',
        linkedMovementId: inMovementId,
        idempotencyKey: `${input.idempotencyKey}:out`,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      const inDoc = {
        _id: inMovementId,
        tenantId,
        date: input.date,
        account: input.toAccount,
        fromAccount: input.fromAccount,
        qty: input.amountPaise,
        amountPaise: input.amountPaise,
        direction: 'In' as const,
        category: 'Transfer' as const,
        sourceType: 'ManualTransfer' as const,
        sourceId: transferGroupId,
        reason: input.reason,
        reference: input.reference || '',
        linkedMovementId: outMovementId,
        idempotencyKey: `${input.idempotencyKey}:in`,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'accountMovements').insertMany([outDoc, inDoc], {session});

      await recordAudit(
        db,
        {
          identity,
          action: 'Transfer',
          entityType: 'accountMovement',
          entityId: transferGroupId,
          detail: `Transfer ₹${(input.amountPaise / 100).toFixed(2)} from ${input.fromAccount} to ${input.toAccount} (${input.reason})`,
          after: {outMovementId, inMovementId, amountPaise: input.amountPaise},
        },
        session
      );

      return {
        success: true,
        outMovementId,
        inMovementId,
        fromAccount: input.fromAccount,
        toAccount: input.toAccount,
        amountPaise: input.amountPaise,
      };
    }
  );
}

/**
 * 4. Reverse Money Movement (Concurrency-Safe Generic Reversal)
 * Positive ownership check: only manual entries and transfers created by the manual money desk.
 * Operational records (CustomerReceipt, SupplierPayment, OpeningSetup, Invoices) MUST use dedicated reversal workflows.
 * In-transaction atomic claim with matchedCount === 1 prevents duplicate or racing reversals.
 * Compensating movement posted on the current open business day; original movement remains intact.
 */
export async function reverseMoneyMovement(
  db: Db,
  identity: Identity,
  movementId: string,
  raw: unknown
) {
  const input = ReverseMoneySchema.parse(raw);
  const tenantId = identity.tenantId;

  await assertPhase3MigrationComplete(db, tenantId);

  const reverseDate = todayInKolkata();

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'reverseMoneyMovement',
    movementId,
    input,
    async (session: ClientSession) => {
      // 1. Recheck operational posting allowed and acquire business-day fence inside the session
      await assertOperationalPostingAllowed(db, tenantId, reverseDate);
      await lockBusinessDay(db, session, tenantId, {date: reverseDate});

      const now = new Date();

      // 2. Read original movement inside the transaction session
      const mov = await col(db, 'accountMovements').findOne({_id: movementId, tenantId}, {session});
      if (!mov) {
        throw new AppError(404, 'Account movement record not found.');
      }

      if (mov.isReversed) {
        throw new AppError(400, 'This movement has already been reversed.');
      }

      // Reversal records themselves cannot be reversed
      if (
        mov.isReversal === true ||
        mov.reversalOfMovementId ||
        mov.category?.endsWith('Reversal') ||
        mov.sourceType?.endsWith('Reversal')
      ) {
        throw new AppError(400, 'Reversal movements cannot be reversed.');
      }

      // 3. Positive ownership check: only manual money entries or manual transfers
      const isManualEntry =
        mov.sourceType === 'ManualMoneyEntry' ||
        (!mov.sourceType &&
          ['Expense', 'OtherReceipt', 'OwnerContribution', 'OwnerWithdrawal'].includes(mov.category));

      const isManualTransfer =
        mov.sourceType === 'ManualTransfer' || (!mov.sourceType && mov.category === 'Transfer');

      if (!isManualEntry && !isManualTransfer) {
        throw new AppError(
          400,
          'This movement cannot be reversed through generic money reversal. Operational transactions (such as customer receipts, supplier payments, or opening balances) must be reversed through their respective workflows.'
        );
      }

      // Cross-tenant verification: verify identity tenantId matches record tenantId
      if (mov.tenantId !== tenantId) {
        throw new AppError(403, 'Cross-tenant account movement reference is rejected.');
      }

      // 4. Concurrency-safe reversal for Transfers
      if (isManualTransfer) {
        if (!mov.linkedMovementId) {
          throw new AppError(400, 'Transfer movement lacks required reciprocal link.');
        }

        const linked = await col(db, 'accountMovements').findOne(
          {_id: mov.linkedMovementId, tenantId},
          {session}
        );

        if (!linked) {
          throw new AppError(404, 'Linked paired transfer movement not found.');
        }

        // Validate reciprocal references and integrity
        if (linked.linkedMovementId !== mov._id) {
          throw new AppError(400, 'Transfer references are not reciprocal.');
        }

        if (mov.account === linked.account) {
          throw new AppError(400, 'Transfer legs must be on different accounts.');
        }

        const movSigned = signedAccountMovementPaise(mov);
        const linkedSigned = signedAccountMovementPaise(linked);
        if (movSigned !== -linkedSigned || movSigned === 0) {
          throw new AppError(400, 'Transfer legs are not equal and opposite.');
        }

        if (mov.isReversed || linked.isReversed) {
          throw new AppError(400, 'One or both transfer legs are already reversed.');
        }

        // Atomically claim BOTH transfer legs with conditional updates inside session
        const claimOut = await col(db, 'accountMovements').updateOne(
          {_id: mov._id, tenantId, isReversed: false},
          {
            $set: {
              isReversed: true,
              reversalReason: input.reason,
              reversedAt: now,
              reversedBy: identity.userId,
            },
          },
          {session}
        );

        const claimIn = await col(db, 'accountMovements').updateOne(
          {_id: linked._id, tenantId, isReversed: false},
          {
            $set: {
              isReversed: true,
              reversalReason: input.reason,
              reversedAt: now,
              reversedBy: identity.userId,
            },
          },
          {session}
        );

        if (claimOut.matchedCount !== 1 || claimIn.matchedCount !== 1) {
          throw new AppError(409, 'Transfer leg has already been claimed or reversed concurrently.');
        }

        // Determine receiving and sending accounts
        const outLeg = movSigned < 0 ? mov : linked;
        const inLeg = movSigned > 0 ? mov : linked;
        const amountPaise = Math.abs(movSigned);

        // Deduct from receiving account with atomic overdraft guard
        const balRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
          {
            tenantId,
            account: inLeg.account,
            balancePaise: {$gte: amountPaise},
          },
          {
            $inc: {balancePaise: -amountPaise, version: 1},
            $set: {updatedAt: now},
          },
          {session}
        );

        if (balRes.matchedCount === 0 || balRes.modifiedCount === 0) {
          throw new AppError(
            400,
            `Insufficient funds in ${inLeg.account} to reverse this transfer.`
          );
        }

        // Restore funds to sending account with safe upper-bound guard
        const restRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
          {
            tenantId,
            account: outLeg.account,
            balancePaise: {$gte: 0, $lte: Number.MAX_SAFE_INTEGER - amountPaise},
          },
          {
            $inc: {balancePaise: amountPaise, version: 1},
            $set: {updatedAt: now},
          },
          {session}
        );

        if (restRes.matchedCount !== 1) {
          throw new AppError(
            409,
            `${outLeg.account} balance record is missing or outside supported range.`
          );
        }

        // Insert compensating reversal movements atomically
        const revOutId = uid('MOV');
        const revInId = uid('MOV');
        const revGroupId = `${revOutId}<->${revInId}`;

        await col(db, 'accountMovements').insertMany(
          [
            {
              _id: revOutId,
              tenantId,
              date: reverseDate,
              account: inLeg.account,
              toAccount: outLeg.account,
              qty: -amountPaise,
              amountPaise,
              direction: 'Out' as const,
              category: 'TransferReversal' as const,
              sourceType: 'ManualTransferReversal' as const,
              sourceId: revGroupId,
              reason: `Reversal of transfer: ${input.reason}`,
              linkedMovementId: revInId,
              reversalOfMovementId: inLeg._id,
              isReversed: false,
              isReversal: true,
              createdAt: now,
              createdBy: identity.userId,
            },
            {
              _id: revInId,
              tenantId,
              date: reverseDate,
              account: outLeg.account,
              fromAccount: inLeg.account,
              qty: amountPaise,
              amountPaise,
              direction: 'In' as const,
              category: 'TransferReversal' as const,
              sourceType: 'ManualTransferReversal' as const,
              sourceId: revGroupId,
              reason: `Reversal of transfer: ${input.reason}`,
              linkedMovementId: revOutId,
              reversalOfMovementId: outLeg._id,
              isReversed: false,
              isReversal: true,
              createdAt: now,
              createdBy: identity.userId,
            },
          ],
          {session}
        );

        await recordAudit(
          db,
          {
            identity,
            action: 'Reverse',
            entityType: 'accountMovement',
            entityId: movementId,
            detail: `Reversed transfer of ₹${(amountPaise / 100).toFixed(2)} between ${outLeg.account} and ${inLeg.account}: ${input.reason}`,
            after: {revOutId, revInId, amountPaise},
          },
          session
        );

        return {success: true, movementId, reversedTransfer: true, amountPaise};
      }

      // 5. Concurrency-safe reversal for Single Direct Manual Movement
      const signedPaise = signedAccountMovementPaise(mov);
      const amountPaise = Math.abs(signedPaise);
      const wasIn = signedPaise > 0;

      // Atomically claim the original movement
      const claimRes = await col(db, 'accountMovements').updateOne(
        {_id: movementId, tenantId, isReversed: false},
        {
          $set: {
            isReversed: true,
            reversalReason: input.reason,
            reversedAt: now,
            reversedBy: identity.userId,
          },
        },
        {session}
      );

      if (claimRes.matchedCount !== 1) {
        throw new AppError(409, 'Movement has already been claimed or reversed concurrently.');
      }

      if (wasIn) {
        // Money originally came in; reversal takes it out with atomic overdraft guard
        const balRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
          {
            tenantId,
            account: mov.account,
            balancePaise: {$gte: amountPaise},
          },
          {
            $inc: {balancePaise: -amountPaise, version: 1},
            $set: {updatedAt: now},
          },
          {session}
        );

        if (balRes.matchedCount === 0 || balRes.modifiedCount === 0) {
          throw new AppError(
            400,
            `Insufficient funds in ${mov.account} to reverse this receipt.`
          );
        }
      } else {
        // Money originally went out; reversal restores it with safe upper-bound guard
        const restRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
          {
            tenantId,
            account: mov.account,
            balancePaise: {$gte: 0, $lte: Number.MAX_SAFE_INTEGER - amountPaise},
          },
          {
            $inc: {balancePaise: amountPaise, version: 1},
            $set: {updatedAt: now},
          },
          {session}
        );

        if (restRes.matchedCount !== 1) {
          throw new AppError(
            409,
            `${mov.account} balance record is missing or outside supported range.`
          );
        }
      }

      const revId = uid('MOV');
      const revDoc = {
        _id: revId,
        tenantId,
        date: reverseDate,
        account: mov.account,
        qty: wasIn ? -amountPaise : amountPaise,
        amountPaise,
        direction: wasIn ? ('Out' as const) : ('In' as const),
        category: `${mov.category}Reversal`,
        sourceType: 'ManualMoneyReversal' as const,
        sourceId: revId,
        reason: `Reversal: ${input.reason}`,
        reversalOfMovementId: movementId,
        reference: mov.reference || '',
        isReversed: false,
        isReversal: true,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'accountMovements').insertOne(revDoc, {session});

      await recordAudit(
        db,
        {
          identity,
          action: 'Reverse',
          entityType: 'accountMovement',
          entityId: movementId,
          detail: `Reversed ${mov.category} movement ${movementId} (₹${(amountPaise / 100).toFixed(2)}): ${input.reason}`,
          after: revDoc,
        },
        session
      );

      return {success: true, movementId, reversalMovementId: revId, amountPaise};
    }
  );
}

/**
 * 5. Get Account Register
 * Authoritative ledger query with:
 * - Real pagination and total count
 * - Escaped literal search and date/account/category filters
 * - Single authoritative signed movement decoder (rows and summary agree exactly)
 * - Historical Opening Cash/Bank, Day Movements, and Expected Closing Cash/Bank
 * - Current live balances labeled separately
 */
export async function getAccountRegister(db: Db, identity: Identity, rawQuery: unknown) {
  const query = MoneyListQuerySchema.parse(rawQuery);
  const tenantId = identity.tenantId;

  await assertPhase3MigrationComplete(db, tenantId);

  const filter: Record<string, any> = {tenantId};

  if (query.date) {
    filter.date = query.date;
  } else if (query.dateFrom || query.dateTo) {
    filter.date = {};
    if (query.dateFrom) filter.date.$gte = query.dateFrom;
    if (query.dateTo) filter.date.$lte = query.dateTo;
  }

  if (query.account && query.account !== 'All') {
    filter.account = query.account;
  }

  if (query.category) {
    filter.category = query.category;
  }

  if (query.search && query.search.trim()) {
    const esc = escapeRegex(query.search.trim());
    const rx = {$regex: esc, $options: 'i'};
    filter.$or = [
      {reason: rx},
      {reference: rx},
      {partyName: rx},
      {category: rx},
    ];
  }

  const page = query.page || 1;
  const limit = query.limit || 50;
  const skip = (page - 1) * limit;

  const [totalCount, rows] = await Promise.all([
    col(db, 'accountMovements').countDocuments(filter),
    col(db, 'accountMovements')
      .find(filter)
      .sort({date: -1, createdAt: -1, _id: -1})
      .skip(skip)
      .limit(limit)
      .toArray(),
  ]);

  // Decode rows using signedAccountMovementPaise
  const movements = rows.map(r => {
    const signedQty = signedAccountMovementPaise(r);
    const amountPaise = Math.abs(signedQty);
    const direction = signedQty >= 0 ? 'In' : 'Out';

    return {
      _id: r._id,
      date: r.date,
      account: r.account,
      toAccount: r.toAccount,
      fromAccount: r.fromAccount,
      qty: signedQty,
      amountPaise,
      direction,
      category: r.category || (r.reason?.includes('Transfer') ? 'Transfer' : 'General'),
      subCategory: r.subCategory,
      paymentMethod: r.paymentMethod || r.method || (r.account === 'Cash' ? 'Cash' : undefined),
      reason: r.reason || '',
      reference: r.reference || '',
      partyName: r.partyName || r.party || '',
      sourceType: r.sourceType,
      linkedMovementId: r.linkedMovementId,
      isReversed: Boolean(r.isReversed),
      reversalReason: r.reversalReason,
      createdAt: r.createdAt,
    };
  });

  // Current live account balances from tenantAccountBalances
  const [cashDoc, bankDoc] = await Promise.all([
    col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').findOne({tenantId, account: 'Cash'}),
    col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').findOne({tenantId, account: 'Bank'}),
  ]);

  const currentCashPaise = cashDoc?.balancePaise || 0;
  const currentBankPaise = bankDoc?.balancePaise || 0;

  // Authoritative filter summary: legacy Out movements never counted in In
  const summaryAgg = await col(db, 'accountMovements').aggregate([
    {$match: filter},
    {
      $group: {
        _id: null,
        totalInPaise: {
          $sum: {
            $cond: [
              {$ne: [{$ifNull: ['$qty', null]}, null]},
              {$cond: [{$gt: ['$qty', 0]}, '$qty', 0]},
              {$cond: [{$eq: ['$direction', 'In']}, '$amountPaise', 0]},
            ],
          },
        },
        totalOutPaise: {
          $sum: {
            $cond: [
              {$ne: [{$ifNull: ['$qty', null]}, null]},
              {$cond: [{$lt: ['$qty', 0]}, {$abs: '$qty'}, 0]},
              {$cond: [{$eq: ['$direction', 'Out']}, '$amountPaise', 0]},
            ],
          },
        },
        count: {$sum: 1},
      },
    },
  ]).toArray();

  const filterSummary = summaryAgg[0] || {totalInPaise: 0, totalOutPaise: 0, count: 0};

  // If a specific date is selected, calculate exact historical opening and closing position
  let historicalPosition: {
    openingCashPaise: number;
    openingBankPaise: number;
    openingCombinedPaise: number;
    dayCashInPaise: number;
    dayCashOutPaise: number;
    dayBankInPaise: number;
    dayBankOutPaise: number;
    expectedClosingCashPaise: number;
    expectedClosingBankPaise: number;
    expectedClosingCombinedPaise: number;
  } | null = null;

  if (query.date) {
    const openingBal = await getOpeningBalanceForDate(db, tenantId, query.date);

    // Sum all movements for this exact day by account
    const dayMovements = await col(db, 'accountMovements')
      .find({tenantId, date: query.date})
      .toArray();

    let dayCashInPaise = 0;
    let dayCashOutPaise = 0;
    let dayBankInPaise = 0;
    let dayBankOutPaise = 0;

    for (const m of dayMovements) {
      const signedVal = signedAccountMovementPaise(m);
      if (m.account === 'Cash') {
        if (signedVal > 0) dayCashInPaise += signedVal;
        else dayCashOutPaise += Math.abs(signedVal);
      } else if (m.account === 'Bank' || m.account === 'Bank account') {
        if (signedVal > 0) dayBankInPaise += signedVal;
        else dayBankOutPaise += Math.abs(signedVal);
      }
    }

    const expectedClosingCashPaise = openingBal.cashPaise + dayCashInPaise - dayCashOutPaise;
    const expectedClosingBankPaise = openingBal.bankPaise + dayBankInPaise - dayBankOutPaise;

    historicalPosition = {
      openingCashPaise: openingBal.cashPaise,
      openingBankPaise: openingBal.bankPaise,
      openingCombinedPaise: openingBal.cashPaise + openingBal.bankPaise,
      dayCashInPaise,
      dayCashOutPaise,
      dayBankInPaise,
      dayBankOutPaise,
      expectedClosingCashPaise,
      expectedClosingBankPaise,
      expectedClosingCombinedPaise: expectedClosingCashPaise + expectedClosingBankPaise,
    };
  }

  return {
    movements,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit) || 1,
    },
    liveBalances: {
      cashPaise: currentCashPaise,
      bankPaise: currentBankPaise,
      combinedPaise: currentCashPaise + currentBankPaise,
    },
    historicalPosition,
    filterSummary: {
      totalInPaise: filterSummary.totalInPaise,
      totalOutPaise: filterSummary.totalOutPaise,
      netPaise: filterSummary.totalInPaise - filterSummary.totalOutPaise,
      count: filterSummary.count,
    },
  };
}
