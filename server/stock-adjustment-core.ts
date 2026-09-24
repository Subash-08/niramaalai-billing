import 'server-only';
import {ClientSession, Db} from 'mongodb';
import {AppError} from './db';
import {canonicalSerialKey, resolveSerialUnit, transitionSerialUnit} from './serial-identity';

export type RemovedLotAllocation = {lotId: string; quantity: number; serials: string[]};

function assertLot(lot: any) {
  const keys = ['quantityReceived', 'quantitySellable', 'quantityReserved', 'quantityDefective', 'quantitySold', 'quantityReturned', 'quantityRemoved', 'quantityConsumed'];
  const values = keys.map(k => lot[k] ?? 0);
  if (!values.every(n => Number.isSafeInteger(n) && n >= 0) ||
      values[0] !== values.slice(1).reduce((a, b) => a + b, 0) ||
      lot.quantityRemaining !== lot.quantitySellable) {
    throw new AppError(409, `Stock lot ${lot._id} needs reconciliation before adjustment. No stock was changed.`);
  }
}

/** Physical removal only. Quarantine/restore remain zero-on-hand operations.
 * The caller owns the transaction, movement, audit and idempotency record. */
export async function removeAvailableStock(db: Db, session: ClientSession, input: {
  tenantId: string; productId: string; quantity: number; isSerialTracked: boolean; serials: string[];
}): Promise<RemovedLotAllocation[]> {
  if (!session.inTransaction()) throw new AppError(409, 'Stock removal requires a transaction.');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 10000)
    throw new AppError(400, 'Removal quantity must be a whole number between 1 and 10,000.');
  const allocations = new Map<string, RemovedLotAllocation>();
  const units: Awaited<ReturnType<typeof resolveSerialUnit>>[] = [];
  if (input.isSerialTracked) {
    if (input.serials.length !== input.quantity) throw new AppError(400, 'Select one available serial for every removed unit.');
    const normalized = input.serials.map(canonicalSerialKey);
    if (new Set(normalized).size !== normalized.length) throw new AppError(400, 'Duplicate serial selections are not allowed.');
    for (const serial of input.serials) {
      const resolved = await resolveSerialUnit(db, session, input.tenantId, serial, {
        productId: input.productId, expectedStatus: 'InStock',
      });
      if (!resolved.unit.lotId) throw new AppError(409, 'Serial has no source stock lot.');
      units.push(resolved);
      const allocation = allocations.get(resolved.unit.lotId) ?? {lotId: resolved.unit.lotId, quantity: 0, serials: []};
      allocation.quantity++;
      allocation.serials.push(resolved.unit.serialOriginal);
      allocations.set(allocation.lotId, allocation);
    }
  } else {
    if (input.serials.length) throw new AppError(400, 'This product does not use serial tracking.');
    let remaining = input.quantity;
    const cursor = db.collection<any>('stockLots').find({tenantId: input.tenantId,
      productId: input.productId, quantitySellable: {$gt: 0}}, {session})
      .sort({receivedDate: 1, createdAt: 1, _id: 1}).limit(10001).batchSize(100);
    try {
      for await (const lot of cursor) {
        if (!remaining) break;
        assertLot(lot);
        const take = Math.min(lot.quantitySellable, remaining);
        allocations.set(lot._id, {lotId: lot._id, quantity: take, serials: []});
        remaining -= take;
      }
    } finally { await cursor.close(); }
    if (remaining) throw new AppError(409, 'Insufficient available stock. Sold, held and defective stock cannot be removed here.');
  }
  for (const allocation of allocations.values()) {
    const lot = await db.collection<any>('stockLots').findOne({_id: allocation.lotId,
      tenantId: input.tenantId, productId: input.productId}, {session});
    if (!lot) throw new AppError(404, 'Source stock lot not found.');
    assertLot(lot);
    const result = await db.collection('stockLots').updateOne({_id: lot._id, tenantId: input.tenantId,
      productId: input.productId, quantitySellable: {$gte: allocation.quantity},
      quantityRemaining: {$gte: allocation.quantity}, $expr: {$eq: ['$quantityRemaining', '$quantitySellable']}},
      {$inc: {quantitySellable: -allocation.quantity, quantityRemaining: -allocation.quantity,
        quantityRemoved: allocation.quantity, version: 1}, $set: {updatedAt: new Date()}}, {session});
    if (result.modifiedCount !== 1) throw new AppError(409, 'Stock availability changed. Reload the product.');
  }
  for (const {unit, version} of units) {
    await transitionSerialUnit(db, session, unit._id, {transition: 'PhysicalRemoval', expected: {
      tenantId: input.tenantId, productId: input.productId, lotId: unit.lotId, status: 'InStock', version,
    }, nextState: {status: 'Removed'}});
  }
  return [...allocations.values()];
}
