import 'server-only';
import {ClientSession, Db} from 'mongodb';
import {z} from 'zod';
import {AppError} from './db';
import {Identity} from './security';
import {recordAudit} from './audit';
import {uid} from '../lib/domain';
import {col, executeIdempotentTransaction} from './purchase-service';
import {todayInKolkata} from './purchase-schema';
import {canonicalSerialKey, resolveSerialUnit, transitionSerialUnit} from './serial-identity';
import {assertSalePostingDay} from './sales-posting';
import {CreateStockReservationSchema, ReleaseStockReservationSchema, ReservationListQuerySchema} from './sales-schema';

export type StockHold = {
  _id: string; tenantId: string; customerId: string; productId: string; lotId: string;
  schemaVersion: 1; version: number; status: 'Active' | 'Fulfilled' | 'Released' | 'Expired';
  quantity: number; remainingQuantity: number; consumedQuantity: number; releasedQuantity: number;
  isSerialTracked: boolean; serials: string[]; remainingSerials: string[];
  reservedAt: string; expiresAt: string; quotationId?: string; notes: string;
  createdAt: Date; createdBy: string; updatedAt: Date;
};

function assertHold(hold: StockHold) {
  if (hold.schemaVersion !== 1 || ![hold.quantity, hold.remainingQuantity, hold.consumedQuantity, hold.releasedQuantity, hold.version].every(Number.isSafeInteger)
    || hold.quantity < 1 || hold.remainingQuantity < 0 || hold.consumedQuantity < 0 || hold.releasedQuantity < 0
    || hold.quantity !== hold.remainingQuantity + hold.consumedQuantity + hold.releasedQuantity)
    throw new AppError(409, 'Stock hold needs reconciliation before it can be changed.');
  if (!Array.isArray(hold.remainingSerials) || (hold.isSerialTracked ? hold.remainingSerials.length !== hold.remainingQuantity : hold.remainingSerials.length !== 0))
    throw new AppError(409, 'Stock hold serials do not reconcile with remaining quantity.');
}

function serialKeys(serials: string[]) {
  const normalized = serials.map(canonicalSerialKey);
  if (normalized.some(s => !s) || new Set(normalized).size !== normalized.length) throw new AppError(400, 'Invalid or duplicate serial number.');
  return normalized;
}

async function movement(db: Db, identity: Identity, session: ClientSession, hold: StockHold,
  kind: 'Hold' | 'Release' | 'Expire' | 'Sale', quantity: number, serials: string[], invoice?: {id: string; lineId: string}) {
  const sold = kind === 'Sale';
  const holding = kind === 'Hold';
  await col(db, 'stockMovements').insertOne({_id: uid('SMV'), tenantId: identity.tenantId,
    productId: hold.productId, lotId: hold.lotId, date: todayInKolkata(),
    qty: sold ? -quantity : 0, onHandDelta: sold ? -quantity : 0,
    sellableDelta: holding ? -quantity : sold ? 0 : quantity,
    reservedDelta: holding ? quantity : -quantity, defectiveDelta: 0,
    soldDelta: sold ? quantity : 0, returnedDelta: 0,
    reason: sold ? 'Sale' : `Stock hold ${kind.toLowerCase()}`, reference: invoice?.id ?? hold._id,
    sourceType: sold ? 'Invoice' : 'StockReservation', sourceId: invoice?.id ?? hold._id,
    reservationId: hold._id, invoiceId: invoice?.id, invoiceLineId: invoice?.lineId,
    serials, createdAt: new Date(), createdBy: identity.userId}, {session});
}

export async function createStockReservation(db: Db, identity: Identity, raw: z.input<typeof CreateStockReservationSchema>) {
  const input = CreateStockReservationSchema.parse(raw);
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'reservation.create', undefined, input, async session => {
    const tenantId = identity.tenantId;
    await assertSalePostingDay(db, tenantId, input.reservedAt, session);
    if (input.enquiryId) throw new AppError(409, 'Enquiry-linked holds require the live enquiry workflow.');
    const customer = await col(db, 'customers').findOne({_id: input.customerId, tenantId, status: 'Active'}, {session});
    const product = await col(db, 'products').findOne({_id: input.productId, tenantId, status: 'Active'}, {session});
    const lot = await col(db, 'stockLots').findOne({_id: input.lotId, tenantId, productId: input.productId}, {session});
    if (!customer || !product || !lot) throw new AppError(404, 'Customer, product or stock lot not found.');
    if (input.quotationId) {
      const quote = await col(db, 'quotations').findOne({_id: input.quotationId, tenantId, customerId: input.customerId}, {session});
      if (!quote) throw new AppError(404, 'Quotation not found for this customer.');
      if (!['Draft', 'Sent', 'Accepted'].includes(quote.status)) throw new AppError(409, 'Quotation is no longer open.');
    }
    const normalized = serialKeys(input.serials);
    if (product.isSerialTracked ? normalized.length !== input.quantity : normalized.length > 0) throw new AppError(400, 'Serial count must match the product tracking mode and hold quantity.');
    const resolvedSerials: Array<{unit: any; version: number}> = [];
    if (product.isSerialTracked) {
      for (const serial of input.serials) {
        const res = await resolveSerialUnit(db, session, tenantId, serial, {
          productId: input.productId,
          lotId: input.lotId,
          expectedStatus: 'InStock',
        });
        resolvedSerials.push(res);
      }
    }
    const now = new Date();
    const hold: StockHold = {_id: uid('HOLD'), tenantId, customerId: input.customerId, productId: input.productId,
      lotId: input.lotId, schemaVersion: 1, version: 1, status: 'Active', quantity: input.quantity,
      remainingQuantity: input.quantity, consumedQuantity: 0, releasedQuantity: 0, isSerialTracked: !!product.isSerialTracked,
      serials: input.serials, remainingSerials: normalized, reservedAt: input.reservedAt, expiresAt: input.expiresAt,
      quotationId: input.quotationId, notes: input.notes, createdAt: now, createdBy: identity.userId, updatedAt: now};
    const changed = await col(db, 'stockLots').updateOne({_id: input.lotId, tenantId, productId: input.productId,
      quantitySellable: {$gte: input.quantity}, quantityRemaining: {$gte: input.quantity},
      $expr: {$eq: ['$quantitySellable', '$quantityRemaining']}},
      {$inc: {quantitySellable: -input.quantity, quantityRemaining: -input.quantity, quantityReserved: input.quantity, version: 1}, $set: {updatedAt: now}}, {session});
    if (changed.matchedCount !== 1) throw new AppError(409, 'Insufficient available stock, or lot balances need reconciliation.');
    for (const item of resolvedSerials) {
      await transitionSerialUnit(db, session, item.unit._id, {
        transition: 'Hold',
        expected: {
          tenantId,
          productId: input.productId,
          lotId: input.lotId,
          status: 'InStock',
          version: item.version,
        },
        nextState: {
          status: 'Reserved',
          reservationId: hold._id,
        },
      });
    }
    await col<StockHold>(db, 'stockReservations').insertOne(hold, {session});
    await movement(db, identity, session, hold, 'Hold', input.quantity, input.serials);
    await recordAudit(db, {identity, action: 'reservation.create', entityType: 'stockReservation', entityId: hold._id,
      detail: `Held ${input.quantity} units through ${input.expiresAt}; no money movement.`}, session);
    return hold;
  });
}

/** Private transaction primitive: call only from issueInvoice's transaction.
 * Partial consumption leaves the remainder active with its original expiry. */
export async function consumeStockReservation(db: Db, identity: Identity, session: ClientSession, input: {
  reservationId: string; customerId: string; productId: string; lotId: string; quantity: number; serials: string[];
  invoiceId: string; invoiceLineId: string;
}) {
  if (!session.inTransaction()) throw new AppError(409, 'Stock hold consumption requires the invoice transaction.');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new AppError(400, 'Invalid consumption quantity.');
  const tenantId = identity.tenantId;
  const hold = await col<StockHold>(db, 'stockReservations').findOne({_id: input.reservationId, tenantId,
    customerId: input.customerId, productId: input.productId, lotId: input.lotId}, {session});
  if (!hold) throw new AppError(404, 'Stock hold not found for this customer, product and lot.');
  assertHold(hold);
  if (hold.status !== 'Active' || hold.expiresAt < todayInKolkata() || hold.remainingQuantity < input.quantity)
    throw new AppError(409, 'Stock hold is expired, closed or has insufficient remaining quantity.');
  const serials = serialKeys(input.serials);
  if (hold.isSerialTracked ? serials.length !== input.quantity : serials.length > 0) throw new AppError(400, 'Incorrect serial count for held stock.');
  if (serials.some(s => !hold.remainingSerials.includes(s))) throw new AppError(409, 'Serial is not part of this remaining hold.');
  const now = new Date();
  for (const serial of input.serials) {
    const {unit, version} = await resolveSerialUnit(db, session, tenantId, serial, {
      productId: hold.productId,
      lotId: hold.lotId,
      expectedStatus: 'Reserved',
      expectedReservationId: hold._id,
    });
    await transitionSerialUnit(db, session, unit._id, {
      transition: 'Sale',
      expected: {
        tenantId,
        productId: hold.productId,
        lotId: hold.lotId,
        status: 'Reserved',
        reservationId: hold._id,
        version,
      },
      nextState: {
        status: 'Sold',
        invoiceId: input.invoiceId,
        soldInvoiceId: input.invoiceId,
        invoiceLineId: input.invoiceLineId,
        soldAt: now,
        reservationId: null,
        fulfilledReservationId: hold._id,
      },
    });
  }
  const lot = await col(db, 'stockLots').updateOne({_id: hold.lotId, tenantId, productId: hold.productId,
    quantityReserved: {$gte: input.quantity}, quantitySellable: {$gte: 0},
    $expr: {$eq: ['$quantityRemaining', '$quantitySellable']}},
    {$inc: {quantityReserved: -input.quantity, quantitySold: input.quantity, version: 1}, $set: {updatedAt: now}}, {session});
  if (lot.matchedCount !== 1) throw new AppError(409, 'Reserved lot balance needs reconciliation.');
  const remaining = hold.remainingQuantity - input.quantity;
  const changed = await col<StockHold>(db, 'stockReservations').updateOne({_id: hold._id, tenantId, status: 'Active', version: hold.version},
    {$inc: {remainingQuantity: -input.quantity, consumedQuantity: input.quantity, version: 1},
      $set: {status: remaining === 0 ? 'Fulfilled' : 'Active', remainingSerials: hold.remainingSerials.filter((s: string) => !serials.includes(s)), updatedAt: now}}, {session});
  if (changed.matchedCount !== 1) throw new AppError(409, 'Stock hold changed; retry.');
  await movement(db, identity, session, hold, 'Sale', input.quantity, input.serials, {id: input.invoiceId, lineId: input.invoiceLineId});
  await recordAudit(db, {identity, action: 'reservation.consume', entityType: 'stockReservation', entityId: hold._id,
    detail: `Consumed ${input.quantity} units for invoice ${input.invoiceId}; ${remaining} remain.`}, session);
}

async function releaseWithinTransaction(db: Db, identity: Identity, session: ClientSession, hold: StockHold, expired: boolean, reason: string) {
  assertHold(hold);
  if (hold.status !== 'Active' || hold.remainingQuantity < 1) throw new AppError(409, 'Stock hold has no releasable quantity.');
  const tenantId = identity.tenantId;
  const now = new Date();
  for (const serial of hold.remainingSerials) {
    const {unit, version} = await resolveSerialUnit(db, session, tenantId, serial, {
      productId: hold.productId,
      lotId: hold.lotId,
      expectedStatus: 'Reserved',
      expectedReservationId: hold._id,
    });
    await transitionSerialUnit(db, session, unit._id, {
      transition: expired ? 'Expire' : 'Release',
      expected: {
        tenantId,
        productId: hold.productId,
        lotId: hold.lotId,
        status: 'Reserved',
        reservationId: hold._id,
        version,
      },
      nextState: {
        status: 'InStock',
        reservationId: null,
      },
    });
  }
  const changedLot = await col(db, 'stockLots').updateOne({_id: hold.lotId, tenantId, productId: hold.productId,
    quantityReserved: {$gte: hold.remainingQuantity}, quantitySellable: {$gte: 0, $lte: Number.MAX_SAFE_INTEGER - hold.remainingQuantity},
    $expr: {$eq: ['$quantityRemaining', '$quantitySellable']}},
    {$inc: {quantityReserved: -hold.remainingQuantity, quantitySellable: hold.remainingQuantity,
      quantityRemaining: hold.remainingQuantity, version: 1}, $set: {updatedAt: now}}, {session});
  if (changedLot.matchedCount !== 1) throw new AppError(409, 'Reserved lot balance is inconsistent.');
  const status = expired ? 'Expired' : 'Released';
  const changed = await col<StockHold>(db, 'stockReservations').updateOne({_id: hold._id, tenantId, status: 'Active', version: hold.version},
    {$set: {status, remainingQuantity: 0, remainingSerials: [], updatedAt: now},
      $inc: {releasedQuantity: hold.remainingQuantity, version: 1}}, {session});
  if (changed.matchedCount !== 1) throw new AppError(409, 'Stock hold changed during release.');
  await movement(db, identity, session, hold, expired ? 'Expire' : 'Release', hold.remainingQuantity, hold.remainingSerials);
  await recordAudit(db, {identity, action: expired ? 'reservation.expire' : 'reservation.release',
    entityType: 'stockReservation', entityId: hold._id, detail: `${reason}; released ${hold.remainingQuantity} units.`}, session);
  return {reservationId: hold._id, status, releasedQuantity: hold.remainingQuantity, version: hold.version + 1};
}

export async function releaseStockReservation(db: Db, identity: Identity, raw: z.input<typeof ReleaseStockReservationSchema>) {
  const input = ReleaseStockReservationSchema.parse(raw);
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'reservation.release', input.reservationId, input, async session => {
    const hold = await col<StockHold>(db, 'stockReservations').findOne({_id: input.reservationId, tenantId: identity.tenantId}, {session});
    if (!hold) throw new AppError(404, 'Stock hold not found.');
    if (hold.version !== input.expectedVersion) throw new AppError(409, 'Stock hold version changed; reload.');
    await assertSalePostingDay(db, identity.tenantId, todayInKolkata(), session);
    return releaseWithinTransaction(db, identity, session, hold, hold.expiresAt < todayInKolkata(), input.reason);
  });
}

/** Trusted scheduler/API adapter supplies a tenant-authorized Identity. Never
 * expose a caller-supplied tenantId. Expiry is after the entire expiresAt day. */
export async function expireStockReservation(db: Db, identity: Identity, reservationId: string) {
  if (!reservationId || reservationId.length > 128) throw new AppError(400, 'Invalid hold ID.');
  return executeIdempotentTransaction(db, identity, `hold-expire:${reservationId}`, 'reservation.expire', reservationId, {reservationId}, async session => {
    const hold = await col<StockHold>(db, 'stockReservations').findOne({_id: reservationId, tenantId: identity.tenantId}, {session});
    if (!hold) throw new AppError(404, 'Stock hold not found.');
    if (hold.status !== 'Active') return {reservationId, status: hold.status, releasedQuantity: 0};
    if (hold.expiresAt >= todayInKolkata()) throw new AppError(409, 'Stock hold has not expired.');
    await assertSalePostingDay(db, identity.tenantId, todayInKolkata(), session);
    return releaseWithinTransaction(db, identity, session, hold, true, 'Hold expired at end of the configured Kolkata day');
  });
}

export async function listStockReservations(db: Db, identity: Identity, raw: unknown) {
  const params = ReservationListQuerySchema.parse(raw);
  const filter: Record<string, any> = {tenantId: identity.tenantId};
  if (params.status) filter.status = params.status;
  if (params.customerId) filter.customerId = params.customerId;
  if (params.productId) filter.productId = params.productId;
  if (params.dateFrom || params.dateTo) {
    filter.reservedAt = {
      ...(params.dateFrom && {$gte: params.dateFrom}),
      ...(params.dateTo && {$lte: params.dateTo}),
    };
  }
  if (params.search) {
    const escaped = params.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      {_id: {$regex: escaped, $options: 'i'}},
      {notes: {$regex: escaped, $options: 'i'}},
    ];
  }
  const [items, total] = await Promise.all([
    col(db, 'stockReservations').find(filter).sort({createdAt: -1, _id: -1}).skip((params.page - 1) * params.limit).limit(params.limit).toArray(),
    col(db, 'stockReservations').countDocuments(filter),
  ]);
  return {items, total, page: params.page, limit: params.limit, totalPages: Math.ceil(total / params.limit)};
}

export async function getStockReservation(db: Db, identity: Identity, reservationId: string) {
  if (!reservationId || reservationId.length > 128) throw new AppError(400, 'Invalid hold ID.');
  const hold = await col<StockHold>(db, 'stockReservations').findOne({_id: reservationId, tenantId: identity.tenantId});
  if (!hold) throw new AppError(404, 'Stock hold not found.');
  const [customer, product, lot, movements] = await Promise.all([
    col(db, 'customers').findOne({_id: hold.customerId, tenantId: identity.tenantId}),
    col(db, 'products').findOne({_id: hold.productId, tenantId: identity.tenantId}),
    col(db, 'stockLots').findOne({_id: hold.lotId, tenantId: identity.tenantId}),
    col(db, 'stockMovements').find({tenantId: identity.tenantId, reservationId}).sort({createdAt: -1}).limit(50).toArray(),
  ]);
  return {
    hold,
    customer: customer ? {name: customer.name, phone: customer.phone, email: customer.email} : null,
    product: product ? {name: product.name, sku: product.sku, hsn: product.hsn} : null,
    lot: lot ? {lotNumber: lot.lotNumber, quantitySellable: lot.quantitySellable, quantityReserved: lot.quantityReserved} : null,
    movements,
  };
}

export async function processExpiredReservations(db: Db, tenantId: string, limit = 50) {
  const today = todayInKolkata();
  const dueHolds = await col<StockHold>(db, 'stockReservations')
    .find({tenantId, status: 'Active', expiresAt: {$lt: today}})
    .sort({expiresAt: 1, _id: 1})
    .limit(limit)
    .toArray();

  const workerIdentity: Identity = {
    tenantId,
    userId: 'system:expiry-worker',
    sessionId: 'system:cron',
  };

  const results: {id: string; status: string; error?: string}[] = [];
  for (const hold of dueHolds) {
    try {
      const res = await expireStockReservation(db, workerIdentity, hold._id);
      results.push({id: hold._id, status: res.status});
    } catch (err: any) {
      results.push({id: hold._id, status: 'Error', error: err?.message || 'Failed to expire hold'});
    }
  }

  return {
    today,
    totalFound: dueHolds.length,
    processed: results.length,
    results,
  };
}

export async function processExpiredReservationsAllTenants(db: Db, limit = 100) {
  const today = todayInKolkata();
  const dueHolds = await col<StockHold>(db, 'stockReservations')
    .find({status: 'Active', expiresAt: {$lt: today}})
    .sort({expiresAt: 1, _id: 1})
    .limit(limit)
    .toArray();

  const results: {id: string; tenantId: string; status: string; error?: string}[] = [];
  for (const hold of dueHolds) {
    const workerIdentity: Identity = {
      tenantId: hold.tenantId,
      userId: 'system:expiry-worker',
      sessionId: 'system:cron',
    };
    try {
      const res = await expireStockReservation(db, workerIdentity, hold._id);
      results.push({id: hold._id, tenantId: hold.tenantId, status: res.status});
    } catch (err: any) {
      results.push({id: hold._id, tenantId: hold.tenantId, status: 'Error', error: err?.message || 'Failed to expire hold'});
    }
  }

  return {
    today,
    totalFound: dueHolds.length,
    processed: results.length,
    results,
  };
}

