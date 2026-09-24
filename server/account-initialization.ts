import 'server-only';
import {ClientSession, Db} from 'mongodb';
import {AppError, mongo} from './db';

const accounts = ['Cash', 'Bank'] as const;
type Account = typeof accounts[number];

export function signedAccountMovementPaise(movement: any): number {
  const hasQty = movement.qty !== undefined && movement.qty !== null;
  const hasAmount = movement.amountPaise !== undefined && movement.amountPaise !== null;
  if (!hasQty && !hasAmount) throw new AppError(409, 'Account movement has no amount. Reconciliation is required.');
  if (hasQty && !Number.isSafeInteger(movement.qty))
    throw new AppError(409, 'Account movement has an invalid signed paise amount.');
  let legacy: number | undefined;
  if (hasAmount) {
    if (!Number.isSafeInteger(movement.amountPaise) || movement.amountPaise < 0 ||
        !['In', 'Out'].includes(movement.direction))
      throw new AppError(409, 'Account movement has an invalid amount or direction.');
    legacy = movement.direction === 'Out' ? -movement.amountPaise : movement.amountPaise;
  }
  if (hasQty && hasAmount && movement.qty !== legacy)
    throw new AppError(409, 'Account movement amount formats disagree. Reconciliation is required.');
  return hasQty ? movement.qty : legacy!;
}

/** Initialize projections from authoritative movements; never reset an existing balance. */
export async function initializeAccountBalances(db: Db, tenantId: string, session: ClientSession) {
  const opening = await db.collection<any>('openingSetups').findOne({tenantId}, {session});
  if (opening && opening.status !== 'Finalized') throw new AppError(409, 'Complete the existing opening setup before initializing payments.');

  // All competing initializations serialize here. Existing balance rows are also
  // touched below, so concurrent operational posting conflicts and is retried.
  let settings = await db.collection<any>('companySettings').findOne({tenantId}, {session});
  if (!settings) {
    const tenant = await db.collection<any>('tenants').findOne({_id: tenantId}, {session});
    const defaultSettings = {
      tenantId,
      name: tenant?.companyName || 'My Store',
      legalName: '',
      gstin: '',
      phone: '',
      email: '',
      address: '',
      state: 'Tamil Nadu',
      stateCode: '33',
      accountInitializationVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      demoImported: false,
    };
    await db.collection<any>('companySettings').insertOne(defaultSettings, {session});
    settings = defaultSettings;
  } else {
    settings = await db.collection<any>('companySettings').findOneAndUpdate(
      {tenantId},
      {$inc: {accountInitializationVersion: 1}},
      {session, returnDocument: 'after'}
    );
  }
  if (!settings) throw new AppError(409, 'Company settings could not be initialized.');

  const sums: Record<Account, bigint> = {Cash: 0n, Bank: 0n};
  const openingSums: Record<Account, bigint> = {Cash: 0n, Bank: 0n};
  const cursor = db.collection<any>('accountMovements').find({tenantId}, {session}).batchSize(500);
  for await (const movement of cursor) {
    const account = movement.account === 'Bank account' ? 'Bank' : movement.account;
    if (account !== 'Cash' && account !== 'Bank')
      throw new AppError(409, 'Unrecognized account in financial history. Reconciliation is required.');
    const value = BigInt(signedAccountMovementPaise(movement));
    sums[account as Account] += value;
    const refUpper = typeof movement.reference === 'string' ? movement.reference.toUpperCase().trim() : '';
    if (refUpper === 'OPENING-SETUP' || refUpper === 'OPENING SETUP' || refUpper === 'OPENING') {
      openingSums[account as Account] += value;
    }
  }

  const now = new Date();
  const result: Record<Account, number> = {Cash: 0, Bank: 0};
  for (const account of accounts) {
    const expectedOpening = opening ? (account === 'Cash' ? opening.openingCashPaise : opening.openingBankPaise) : 0;
    if (!Number.isSafeInteger(expectedOpening) || expectedOpening < 0 ||
        openingSums[account] !== BigInt(expectedOpening))
      throw new AppError(409, `${account} opening movements do not match finalized setup. Reconciliation is required.`);
    if (sums[account] < 0n || sums[account] > BigInt(Number.MAX_SAFE_INTEGER))
      throw new AppError(409, `${account} ledger total is negative or outside the supported paise range. No balance was reset.`);
    const balancePaise = Number(sums[account]);
    const existing = await db.collection<any>('tenantAccountBalances').find({tenantId, account}, {session}).limit(2).toArray();
    if (existing.length > 1) throw new AppError(409, `Duplicate ${account} balances need reconciliation.`);
    if (existing[0]) {
      if (!Number.isSafeInteger(existing[0].balancePaise) || existing[0].balancePaise !== balancePaise)
        throw new AppError(409, `${account} balance differs from its ledger. No existing balance was overwritten.`);
      await db.collection<any>('tenantAccountBalances').updateOne({_id: existing[0]._id, tenantId, account},
        {$inc: {version: 1}, $set: {reconciledAt: now}}, {session});
    } else {
      await db.collection<any>('tenantAccountBalances').insertOne({_id: `BAL-${tenantId}-${account}`,
        tenantId, account, balancePaise, version: 1, createdAt: now, updatedAt: now}, {session});
    }
    result[account] = balancePaise;
  }
  const alreadyMigrated = settings.phase3Migration?.status === 'Completed';
  await db.collection<any>('companySettings').updateOne({tenantId}, {$set: {
    'phase3Migration.status': 'Completed',
    'phase3Migration.version': 2,
    'phase3Migration.reconciledAt': now,
    ...(!alreadyMigrated ? {
      'phase3Migration.initializedAt': now,
      'phase3Migration.initialCashPaise': result.Cash,
      'phase3Migration.initialBankPaise': result.Bank,
    } : {}),
  }}, {session});
  return {status: 'Completed', alreadyMigrated, initialCashPaise: result.Cash, initialBankPaise: result.Bank};
}

export async function ensureAccountBalances(db: Db, tenantId: string, session?: ClientSession): Promise<void> {
  if (!session) {
    const owned = (await mongo()).startSession();
    try { await owned.withTransaction(() => ensureAccountBalances(db, tenantId, owned)); }
    finally { await owned.endSession(); }
    return;
  }
  const settings = await db.collection<any>('companySettings').findOne({tenantId}, {session});
  if (settings?.phase3Migration?.status === 'Completed' && settings.phase3Migration.version >= 2) {
    const rows = await db.collection<any>('tenantAccountBalances').find({tenantId, account: {$in: [...accounts]}}, {session}).limit(3).toArray();
    if (rows.length === 2 && accounts.every(account => rows.filter(row => row.account === account &&
        Number.isSafeInteger(row.balancePaise) && row.balancePaise >= 0).length === 1)) return;
  }
  await initializeAccountBalances(db, tenantId, session);
}
