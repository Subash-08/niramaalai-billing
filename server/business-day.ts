import 'server-only';
import {ClientSession, Db} from 'mongodb';
import {AsyncLocalStorage} from 'node:async_hooks';
import {AppError} from './db';
import {todayInKolkata} from './purchase-schema';

export interface BusinessDayAttemptContext {
  attemptId: number;
  tenantId?: string;
  dbName?: string;
  sessionId?: string;
  locked: boolean;
  gateSnapshot?: any;
}

export const businessDayAttemptStore = new AsyncLocalStorage<BusinessDayAttemptContext>();

let globalAttemptCounter = 0;

export function runInAttemptContext<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: BusinessDayAttemptContext = {
    attemptId: ++globalAttemptCounter,
    locked: false,
  };
  return businessDayAttemptStore.run(ctx, fn);
}

/**
 * Shared write fence: closing and EVERY operational transaction write this row.
 * Uses an attempt-scoped AsyncLocalStorage guard so that within a single transaction attempt,
 * the gate version increments at most once, while each retried transaction attempt (e.g. from MongoDB withTransaction)
 * resets the lock and re-acquires it.
 * Bound strictly to tenant, db, and active session.
 */
export async function lockBusinessDay(
  db: Db,
  session: ClientSession,
  tenantId: string,
  options?: {allowClosed?: boolean; internalAllowClosed?: boolean; date?: string}
) {
  if (!session.inTransaction()) {
    throw new AppError(500, 'Business-day lock requires an active transaction.');
  }

  const allowClosed = options?.internalAllowClosed ?? options?.allowClosed ?? false;
  const checkDate = options?.date || todayInKolkata();

  const currentAttempt = businessDayAttemptStore.getStore();
  const sessionId = (session as any)?.id ? JSON.stringify((session as any).id) : undefined;
  const dbName = db.databaseName;

  // Check if already locked within this exact transaction attempt, tenant, database, and session
  if (
    currentAttempt &&
    currentAttempt.locked &&
    currentAttempt.tenantId === tenantId &&
    currentAttempt.dbName === dbName &&
    currentAttempt.sessionId === sessionId &&
    currentAttempt.gateSnapshot
  ) {
    const existing = currentAttempt.gateSnapshot;
    if (!allowClosed && existing?.closedThrough && checkDate <= existing.closedThrough) {
      throw new AppError(
        409,
        `Business day ${existing.closedThrough} is closed. Post a correction on the next open day; closed records cannot be edited.`
      );
    }
    return existing;
  }

  const gate = await db.collection<any>('businessDayGates').findOneAndUpdate(
    {_id: `DAY-${tenantId}`, tenantId},
    {$inc: {version: 1}, $setOnInsert: {closedThrough: null}},
    {session, upsert: true, returnDocument: 'after'}
  );
  if (!gate) {
    throw new AppError(409, 'Business day changed. Retry the operation.');
  }
  if (!allowClosed && gate.closedThrough && checkDate <= gate.closedThrough) {
    throw new AppError(
      409,
      `Business day ${gate.closedThrough} is closed. Post a correction on the next open day; closed records cannot be edited.`
    );
  }

  if (currentAttempt) {
    currentAttempt.locked = true;
    currentAttempt.tenantId = tenantId;
    currentAttempt.dbName = dbName;
    currentAttempt.sessionId = sessionId;
    currentAttempt.gateSnapshot = gate;
  }

  return gate;
}
