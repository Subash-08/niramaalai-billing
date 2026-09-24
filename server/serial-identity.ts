import 'server-only';
import {createHash} from 'node:crypto';
import {Db, ClientSession, MongoServerError} from 'mongodb';
import {AppError} from './db';
import {normalizeSerial} from './master-schema';

export interface SerialUnitDocument {
  _id: string;
  tenantId: string;
  productId: string;
  lotId: string;
  serialOriginal: string;
  serialNormalized: string;
  status: 'InStock' | 'Reserved' | 'Sold' | 'Defective' | 'Returned' | 'Removed' | 'ConsumedInService';
  version: number;
  reservationId?: string | null;
  fulfilledReservationId?: string | null;
  invoiceId?: string | null;
  soldInvoiceId?: string | null;
  invoiceLineId?: string | null;
  soldAt?: Date | null;
  lastInvoiceId?: string | null;
  lastInvoiceLineId?: string | null;
  lastReturnId?: string | null;
  warrantyClaimId?: string | null;
  replacedBySerial?: string | null;
  replacesSerial?: string | null;
  serviceJobId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantSerialGateDocument {
  _id: string;
  tenantId: string;
  status: 'Ready' | 'Maintenance' | 'Unreconciled';
  schemaVersion: number;
  writeVersion?: number;
  lastActiveAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Pure validated canonical serial normalization.
 * Strips non-ASCII-alphanumeric characters and converts to lowercase.
 * Enforces non-empty and schema length bounds.
 */
export function canonicalSerialKey(raw: string): string {
  if (typeof raw !== 'string') {
    throw new AppError(400, 'Serial number must be a text string.');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new AppError(400, 'Serial number cannot be empty.');
  }
  if (trimmed.length > 100) {
    throw new AppError(400, 'Serial number cannot exceed 100 characters.');
  }
  const canonical = normalizeSerial(trimmed);
  if (canonical.length === 0) {
    throw new AppError(400, `Serial number "${trimmed}" must contain at least one alphanumeric character.`);
  }
  return canonical;
}

/**
 * Transactional readiness gate and write fence for tenant serial operations.
 * Must be called within a MongoDB session/transaction.
 */
export async function assertTenantSerialReady(
  db: Db,
  tenantId: string,
  session?: ClientSession
): Promise<void> {
  if (!session?.inTransaction()) throw new AppError(409, 'Serial writes require an active transaction.');
  const gateCol = db.collection<TenantSerialGateDocument>('tenantSerialGates');
  const gate = await gateCol.findOne({tenantId}, session ? {session} : {});

  if (!gate) {
    // Check if tenant has any existing serialUnits
    const serialUnits = await db
      .collection<SerialUnitDocument>('serialUnits')
      .find({tenantId}, session ? {session} : {})
      .limit(5001)
      .toArray();

    if (serialUnits.length > 5000) throw new AppError(409, 'Serial readiness requires a paginated reconciliation audit for this company.');

    if (serialUnits.length === 0) {
      // Genuinely new or empty tenant can establish canonical readiness atomically
      await gateCol.updateOne(
        {tenantId},
        {
          $setOnInsert: {
            _id: `GATE-${tenantId}`,
            tenantId,
            status: 'Ready',
            schemaVersion: 1,
            lastActiveAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        {upsert: true, ...(session ? {session} : {})}
      );
      return;
    }

    // Inspect existing units for collisions under canonical normalization
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const u of serialUnits) {
      const raw = u.serialOriginal || u.serialNormalized || (u as any).serial;
      if (!raw) { collisions.push(`missing identity: ${u._id}`); continue; }
      try {
        const canonical = canonicalSerialKey(raw);
        if (seen.has(canonical) && seen.get(canonical) !== u._id) {
          collisions.push(canonical);
        } else {
          seen.set(canonical, u._id);
        }
      } catch {
        collisions.push(String(raw));
      }
    }

    if (collisions.length > 0) {
      await gateCol.updateOne(
        {tenantId},
        {
          $setOnInsert: {
            _id: `GATE-${tenantId}`,
            tenantId,
            status: 'Unreconciled',
            schemaVersion: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        {upsert: true, ...(session ? {session} : {})}
      );
      throw new AppError(
        409,
        `Tenant requires serial identity reconciliation before serial transactions can be performed. Collisions detected: ${collisions.join(', ')}`
      );
    }

    // Collision-free existing inventory: establish Ready gate atomically
    await gateCol.updateOne(
      {tenantId},
      {
        $setOnInsert: {
          _id: `GATE-${tenantId}`,
          tenantId,
          status: 'Ready',
          schemaVersion: 1,
          lastActiveAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      {upsert: true, ...(session ? {session} : {})}
    );
    return;
  }

  if (gate.status === 'Maintenance') {
    throw new AppError(409, 'Tenant serial operations are currently locked for maintenance.');
  }

  if (gate.status !== 'Ready') {
    throw new AppError(
      409,
      'Tenant requires serial identity reconciliation before serial transactions can be performed.'
    );
  }

  // Acquire write fence by touching lastActiveAt within the transaction
  const fenceRes = await gateCol.updateOne(
    {tenantId, status: 'Ready'},
    {$inc: {writeVersion: 1}, $set: {lastActiveAt: new Date()}},
    session ? {session} : {}
  );
  if (fenceRes.matchedCount !== 1) {
    throw new AppError(409, 'Tenant serial gate is locked or undergoing maintenance.');
  }
}

/**
 * Validates payload serials for creation, checks against duplicates in payload and tenant inventory.
 * Requires tenant readiness gate.
 */
export async function assertSerialsAvailableForCreation(
  db: Db,
  session: ClientSession | undefined,
  tenantId: string,
  serials: string[]
): Promise<Map<string, string>> {
  if (!Array.isArray(serials) || serials.length === 0) {
    return new Map();
  }

  await assertTenantSerialReady(db, tenantId, session);

  const canonicalMap = new Map<string, string>();
  const seenCanonical = new Map<string, string>();

  for (const s of serials) {
    const canonical = canonicalSerialKey(s);
    if (seenCanonical.has(canonical)) {
      throw new AppError(
        400,
        `Duplicate serial "${s}" (collides with "${seenCanonical.get(canonical)}") provided in payload.`
      );
    }
    seenCanonical.set(canonical, s);
    canonicalMap.set(s, canonical);
  }

  const canonicalKeys = Array.from(seenCanonical.keys());
  // An exact lowercase index lookup alone misses existing uppercase aliases.
  for (const key of canonicalKeys) {
    try {
      await resolveSerialUnit(db, session, tenantId, key);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) continue;
      throw error;
    }
    throw new AppError(409, 'A serial with this identity already exists in company inventory.');
  }
  const existing = await db
    .collection('serialUnits')
    .find(
      {
        tenantId,
        serialNormalized: {$in: canonicalKeys},
      },
      session ? {session} : {}
    )
    .toArray();

  if (existing.length > 0) {
    const collision = existing[0];
    const originalInput = seenCanonical.get(collision.serialNormalized) || collision.serialOriginal;
    throw new AppError(
      400,
      `Serial number "${originalInput}" already exists in company inventory.`
    );
  }

  return canonicalMap;
}

/**
 * Resolves a physical unit by tenant and canonical key.
 * Enforces tenant identity before checking product/lot/status constraints.
 */
export async function resolveSerialUnit(
  db: Db,
  session: ClientSession | undefined,
  tenantId: string,
  raw: string,
  constraints?: {
    productId?: string;
    lotId?: string;
    expectedStatus?: string;
    expectedReservationId?: string;
    expectedInvoiceId?: string;
  }
): Promise<{unit: SerialUnitDocument; version: number}> {
  const canonical = canonicalSerialKey(raw);

  // Compatibility lookup is read-only. Search all aliases together, including
  // punctuation-free input, so canonical hits never hide a legacy collision.
  // Result count and execution time are bounded; no lifecycle data is migrated.
  const aliasPattern = '^' + canonical.split('').join('[^a-zA-Z0-9]*') + '$';
  const originalPattern = '^[^a-zA-Z0-9]*' + canonical.split('').join('[^a-zA-Z0-9]*') + '[^a-zA-Z0-9]*$';
  const candidates = await db.collection<SerialUnitDocument>('serialUnits').find({
    tenantId,
    $or: [
      {serialNormalized: {$regex: originalPattern, $options: 'i'}},
      {serialOriginal: {$regex: originalPattern, $options: 'i'}},
      {serial: {$regex: aliasPattern, $options: 'i'}},
    ],
  }, session ? {session} : {}).limit(2).maxTimeMS(5000).toArray();

  if (candidates.length === 0) {
    throw new AppError(404, `Serial unit "${raw}" not found.`);
  }

  if (candidates.length > 1) {
    throw new AppError(
      409,
      `Ambiguous serial identity for "${raw}": multiple units match canonical key "${canonical}".`
    );
  }

  const unit = candidates[0];
  const fieldsToCheck = [
    unit.serialNormalized,
    unit.serialOriginal || (unit as any).serial,
  ].filter(Boolean);
  if (fieldsToCheck.length === 0) {
    throw new AppError(409, 'Serial identity fields disagree. Reconcile this unit before posting.');
  }
  for (const stored of fieldsToCheck) {
    if (typeof stored !== 'string' || canonicalSerialKey(stored) !== canonical)
      throw new AppError(409, 'Serial identity fields disagree. Reconcile this unit before posting.');
  }

  if (constraints?.productId && unit.productId !== constraints.productId) {
    throw new AppError(400, `Serial "${raw}" belongs to another product.`);
  }

  if (constraints?.lotId && unit.lotId !== constraints.lotId) {
    throw new AppError(400, `Serial "${raw}" does not belong to this stock lot.`);
  }

  if (constraints?.expectedStatus && unit.status !== constraints.expectedStatus) {
    throw new AppError(
      409,
      `Serial "${raw}" has status ${unit.status} and cannot be processed (expected ${constraints.expectedStatus}).`
    );
  }

  if (
    constraints?.expectedReservationId &&
    unit.reservationId !== constraints.expectedReservationId
  ) {
    throw new AppError(
      400,
      `Serial "${raw}" is not held under reservation ${constraints.expectedReservationId}.`
    );
  }

  if (
    constraints?.expectedInvoiceId &&
    (unit.invoiceId ?? unit.soldInvoiceId) !== constraints.expectedInvoiceId
  ) {
    throw new AppError(
      400,
      `Serial "${raw}" is not sold under invoice ${constraints.expectedInvoiceId}.`
    );
  }

  return {unit, version: typeof unit.version === 'number' ? unit.version : 0};
}

export type AllowedSerialTransition =
  | 'Hold'
  | 'Release'
  | 'Expire'
  | 'Sale'
  | 'CustomerReturn'
  | 'Quarantine'
  | 'Restore'
  | 'SupplierReturn'
  | 'SupplierReturnReversal'
  | 'WarrantyReplacementClaim'
  | 'WarrantyReplacementSupply'
  | 'PhysicalRemoval'
  | 'ServiceConsumption'
  | 'ServiceReversal';

export interface TransitionSerialUnitParams {
  transition: AllowedSerialTransition;
  expected: {
    tenantId: string;
    productId?: string;
    lotId?: string;
    status: SerialUnitDocument['status'];
    version?: number;
    reservationId?: string | null;
    invoiceId?: string | null;
    invoiceLineId?: string | null;
  };
  nextState: {
    status: SerialUnitDocument['status'];
    lotId?: string | null;
    reservationId?: string | null;
    fulfilledReservationId?: string | null;
    invoiceId?: string | null;
    soldInvoiceId?: string | null;
    invoiceLineId?: string | null;
    soldAt?: Date | null;
    lastInvoiceId?: string | null;
    lastInvoiceLineId?: string | null;
    lastReturnId?: string | null;
    warrantyClaimId?: string | null;
    replacedBySerial?: string | null;
    replacesSerial?: string | null;
    serviceJobId?: string | null;
  };
}

/**
 * Atomic state transition for serial units inside a MongoDB transaction.
 * Enforces exact ownership, expected status, and optimistic version checks.
 * Guarantees serialNormalized is immutable.
 */
export async function transitionSerialUnit(
  db: Db,
  session: ClientSession,
  unitId: string,
  params: TransitionSerialUnitParams
): Promise<void> {
  const {expected, nextState, transition} = params;
  if (!session.inTransaction()) throw new AppError(409, 'Serial transitions require the enclosing stock transaction.');
  await assertTenantSerialReady(db, expected.tenantId, session);
  const allowed: Record<AllowedSerialTransition, string[]> = {
    Hold: ['InStock:Reserved'], Release: ['Reserved:InStock'], Expire: ['Reserved:InStock'],
    Sale: ['InStock:Sold', 'Reserved:Sold'], CustomerReturn: ['Sold:InStock', 'Sold:Defective', 'ConsumedInService:InStock', 'ConsumedInService:Defective'],
    Quarantine: ['InStock:Defective'], Restore: ['Defective:InStock'],
    SupplierReturn: ['InStock:Returned', 'Defective:Returned'],
    SupplierReturnReversal: ['Returned:InStock', 'Returned:Defective'],
    WarrantyReplacementClaim: ['Sold:Defective'], WarrantyReplacementSupply: ['InStock:Sold'],
    PhysicalRemoval: ['InStock:Removed', 'Defective:Removed'],
    ServiceConsumption: ['InStock:ConsumedInService'],
    ServiceReversal: ['ConsumedInService:InStock', 'ConsumedInService:Defective'],
  };
  if (!allowed[transition]?.includes(`${expected.status}:${nextState.status}`))
    throw new AppError(409, 'This serial state change is not allowed for the requested operation.');
  if (!expected.tenantId || !expected.productId || !expected.lotId)
    throw new AppError(409, 'Serial transition requires exact tenant, product and source lot.');
  if (nextState.lotId !== undefined && nextState.lotId !== expected.lotId)
    throw new AppError(409, 'Moving an existing serial to another lot requires a separate audited workflow.');
  if (expected.status === 'Reserved' && !expected.reservationId)
    throw new AppError(409, 'The exact stock hold is required.');
  if (nextState.status === 'Reserved' && !nextState.reservationId)
    throw new AppError(409, 'A stock hold reference is required.');
  if (nextState.status === 'Sold' && (!nextState.invoiceId || !nextState.invoiceLineId))
    throw new AppError(409, 'A sale requires invoice and line ownership.');
  if (expected.status === 'Sold' && (!expected.invoiceId || !expected.invoiceLineId))
    throw new AppError(409, 'Returning or replacing a sold unit requires its exact invoice and line.');
  if (nextState.status === 'Sold' && nextState.soldInvoiceId != null && nextState.soldInvoiceId !== nextState.invoiceId)
    throw new AppError(409, 'Invoice ownership fields disagree.');
  const now = new Date();

  // Validate that serialNormalized or identity fields cannot be modified
  if ('serialNormalized' in nextState || 'serialOriginal' in nextState || '_id' in nextState) {
    throw new AppError(500, 'Serial identity fields are immutable and cannot be mutated during transitions.');
  }

  const query: Record<string, any> = {
    _id: unitId,
    tenantId: expected.tenantId,
    status: expected.status,
  };

  if (expected.productId) query.productId = expected.productId;
  if (expected.lotId) query.lotId = expected.lotId;
  if (expected.reservationId !== undefined) query.reservationId = expected.reservationId;
  const predicates: Record<string, any>[] = [];
  if (expected.invoiceId !== undefined) {
    // Prefer current ownership; use the legacy field only when it is absent.
    predicates.push({$or: [{invoiceId: expected.invoiceId},
      {invoiceId: null, soldInvoiceId: expected.invoiceId}]});
  }
  if (expected.invoiceLineId !== undefined) query.invoiceLineId = expected.invoiceLineId;
  const expectedVersion = expected.version ?? 0;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    throw new AppError(409, 'Serial version needs reconciliation.');
  if (expectedVersion === 0) predicates.push({$or: [{version: 0}, {version: {$exists: false}}]});
  else query.version = expectedVersion;
  if (predicates.length) query.$and = predicates;

  const updateFields: Record<string, any> = {
    status: nextState.status,
    updatedAt: now,
  };

  // Preserve source lot and physical identity. Current ownership is separate
  // from historical commercial lineage.
  if (expected.status === 'Sold') {
    updateFields.lastInvoiceId = expected.invoiceId;
    updateFields.lastInvoiceLineId = expected.invoiceLineId;
  }
  if (nextState.status !== 'Reserved') updateFields.reservationId = null;
  if (nextState.reservationId !== undefined) updateFields.reservationId = nextState.reservationId;
  if (nextState.fulfilledReservationId !== undefined) updateFields.fulfilledReservationId = nextState.fulfilledReservationId;
  if (nextState.invoiceId !== undefined) updateFields.invoiceId = nextState.invoiceId;
  if (nextState.soldInvoiceId !== undefined) updateFields.soldInvoiceId = nextState.soldInvoiceId;
  if (nextState.invoiceLineId !== undefined) updateFields.invoiceLineId = nextState.invoiceLineId;
  if (nextState.soldAt !== undefined) updateFields.soldAt = nextState.soldAt;
  if (nextState.lastInvoiceId !== undefined) updateFields.lastInvoiceId = nextState.lastInvoiceId;
  if (nextState.lastInvoiceLineId !== undefined) updateFields.lastInvoiceLineId = nextState.lastInvoiceLineId;
  if (nextState.lastReturnId !== undefined) updateFields.lastReturnId = nextState.lastReturnId;
  if (nextState.warrantyClaimId !== undefined) updateFields.warrantyClaimId = nextState.warrantyClaimId;
  if (nextState.replacedBySerial !== undefined) updateFields.replacedBySerial = nextState.replacedBySerial;
  if (nextState.replacesSerial !== undefined) updateFields.replacesSerial = nextState.replacesSerial;

  const res = await db.collection('serialUnits').updateOne(
    query,
    {
      $set: updateFields,
      $inc: {version: 1},
    },
    {session}
  );

  if (res.matchedCount !== 1 || res.modifiedCount !== 1) {
    throw new AppError(
      409,
      `Serial unit state changed concurrently or does not match expected status "${expected.status}".`
    );
  }
}

export interface SerialAuditResult {
  tenantId: string;
  totalUnits: number;
  auditHash: string;
  invariantHash: string;
  canonicalCount: number;
  legacyCount: number;
  collisionCount: number;
  collisions: Array<{canonicalKey: string; unitIds: string[]; statusList: string[]}>;
  legacyUnits: Array<{unitId: string; currentKey: string; canonicalKey: string; status: string; original: string; version?: number}>;
}

/**
 * Read-only compatibility audit for a tenant's serial units.
 * Identifies legacy un-canonical keys and potential collisions without mutating data.
 */
export async function auditTenantSerials(db: Db, tenantId: string, session?: ClientSession): Promise<SerialAuditResult> {
  if (!tenantId?.trim()) throw new AppError(400, 'Explicit tenant scope is required.');
  const units = await db
    .collection<SerialUnitDocument>('serialUnits')
    .find({tenantId}, session ? {session} : {}).sort({_id: 1})
    .limit(5001)
    .toArray();
  if (units.length > 5000) throw new AppError(409, 'Use a paginated serial audit for companies with more than 5,000 units. No partial report was produced.');

  const keyGroups = new Map<string, SerialUnitDocument[]>();
  const legacyUnits: SerialAuditResult['legacyUnits'] = [];
  let canonicalCount = 0;

  for (const u of units) {
    const raw = u.serialOriginal;
    let canonical = '';
    try {
      canonical = canonicalSerialKey(raw);
    } catch {
      throw new AppError(409, `Serial unit ${u._id} has invalid identity data and requires review.`);
    }

    if (typeof u.serialNormalized !== 'string' || canonicalSerialKey(u.serialNormalized) !== canonical ||
        (u.version !== undefined && (!Number.isSafeInteger(u.version) || u.version < 0)))
      throw new AppError(409, `Serial unit ${u._id} has conflicting identity/version data. Review it before migration.`);

    if (u.serialNormalized === canonical) {
      canonicalCount++;
    } else {
      legacyUnits.push({
        unitId: u._id,
        currentKey: u.serialNormalized,
        original: u.serialOriginal,
        version: u.version,
        canonicalKey: canonical,
        status: u.status,
      });
    }

    const group = keyGroups.get(canonical) ?? [];
    group.push(u);
    keyGroups.set(canonical, group);
  }

  const collisions: SerialAuditResult['collisions'] = [];
  for (const [canonicalKey, group] of keyGroups.entries()) {
    if (group.length > 1) {
      collisions.push({
        canonicalKey,
        unitIds: group.map(g => g._id),
        statusList: group.map(g => g.status),
      });
    }
  }

  return {
    tenantId,
    totalUnits: units.length,
    auditHash: createHash('sha256').update(JSON.stringify(units)).digest('hex'),
    invariantHash: createHash('sha256').update(JSON.stringify(units.map(unit => {
      const {serialNormalized, version, updatedAt, ...unchanged} = unit;
      return unchanged;
    }))).digest('hex'),
    canonicalCount,
    legacyCount: legacyUnits.length,
    collisionCount: collisions.length,
    collisions,
    legacyUnits,
  };
}

/**
 * Safe, idempotent migration path for test fixtures and tenant serial identity.
 * Strictly blocks if collisions exist. Does NOT delete duplicates or reset data.
 */
export async function reconcileTenantSerials(
  db: Db,
  tenantId: string,
  options: {
    dryRun?: boolean;
    session?: ClientSession;
    expectedAuditHash?: string;
    migrationId?: string;
    actorId?: string;
  } = {}
): Promise<SerialAuditResult & {reconciledCount: number}> {
  if (!tenantId?.trim()) throw new AppError(400, 'Explicit tenant scope is required.');
  if (options.dryRun !== false) {
    const audit = await auditTenantSerials(db, tenantId, options.session);
    return {...audit, reconciledCount: 0};
  }
  const {session, expectedAuditHash, migrationId, actorId} = options;
  if (!session?.inTransaction() || !expectedAuditHash || !/^[a-f0-9]{64}$/.test(expectedAuditHash) ||
      !migrationId?.trim() || migrationId.length > 100 || !actorId?.trim())
    throw new AppError(409, 'Apply requires an active transaction, reviewed audit hash, migration ID and actor. Dry-run does not modify data.');

  const journalId = createHash('sha256').update(JSON.stringify([tenantId, migrationId])).digest('hex');
  const journals = db.collection<any>('serialIdentityMigrations');
  const prior = await journals.findOne({_id: journalId, tenantId}, {session});
  if (prior) {
    if (prior.expectedAuditHash !== expectedAuditHash || prior.actorId !== actorId)
      throw new AppError(409, 'Migration ID was already used for a different request.');
    if (prior.status !== 'Completed') throw new AppError(409, 'Migration journal needs review.');
    return prior.result;
  }

  // Read-only metadata validation; never create or drop indexes in this operation.
  const indexes = await db.collection('serialUnits').listIndexes().toArray();
  const uniqueIdentity = indexes.some(index => index.unique === true && !index.partialFilterExpression &&
    Object.keys(index.key).length === 2 && index.key.tenantId === 1 && index.key.serialNormalized === 1);
  if (!uniqueIdentity) throw new AppError(409, 'The unique tenant/serial identity index must be verified before migration.');

  const gates = db.collection<any>('tenantSerialGates');
  const existingGate = await gates.findOne({tenantId}, {session});
  if (existingGate?.status === 'Maintenance') throw new AppError(409, 'A serial maintenance operation is already active.');
  const now = new Date();
  if (!existingGate) {
    await gates.insertOne({_id: `GATE-${tenantId}`, tenantId, status: 'Maintenance',
      schemaVersion: 0, writeVersion: 1, migrationId, createdAt: now, updatedAt: now}, {session});
  } else {
    const locked = await gates.updateOne({_id: existingGate._id, tenantId, status: {$ne: 'Maintenance'}},
      {$inc: {writeVersion: 1}, $set: {status: 'Maintenance', migrationId, updatedAt: now}}, {session});
    if (locked.modifiedCount !== 1) throw new AppError(409, 'Serial gate changed. Retry after a fresh audit.');
  }

  // All serial creators/transitions must write this same gate. Conflicting
  // operations retry against the committed version; old bypassing binaries
  // must be drained by the operator before applying a migration.
  const audit = await auditTenantSerials(db, tenantId, session);
  if (audit.auditHash !== expectedAuditHash)
    throw new AppError(409, 'Serial data changed after the reviewed audit. Run a new dry-run.');
  if (audit.collisionCount)
    throw new AppError(409, 'Canonical identity collisions require review; no units were merged or changed.');

  for (const item of audit.legacyUnits) {
    const changed = await db.collection<SerialUnitDocument>('serialUnits').updateOne({
      _id: item.unitId, tenantId, serialNormalized: item.currentKey,
      serialOriginal: item.original,
      ...(item.version === undefined ? {version: {$exists: false}} : {version: item.version}),
    }, {$set: {serialNormalized: item.canonicalKey, updatedAt: now}, $inc: {version: 1}}, {session});
    if (changed.modifiedCount !== 1) throw new AppError(409, 'A serial changed during migration. The transaction must be rolled back.');
  }

  const after = await auditTenantSerials(db, tenantId, session);
  if (after.legacyCount || after.collisionCount || after.totalUnits !== audit.totalUnits ||
      after.invariantHash !== audit.invariantHash)
    throw new AppError(409, 'Serial migration reconciliation failed. The transaction must be rolled back.');
  const result = {...after, reconciledCount: audit.legacyCount};
  await journals.insertOne({_id: journalId, tenantId, migrationId, actorId, schemaVersion: 1,
    status: 'Completed', expectedAuditHash, beforeHash: audit.auditHash, afterHash: after.auditHash,
    invariantHash: after.invariantHash, changes: audit.legacyUnits, result, createdAt: now}, {session});
  const finished = await gates.updateOne({tenantId, status: 'Maintenance', migrationId},
    {$inc: {writeVersion: 1}, $set: {status: 'Ready', schemaVersion: 1, updatedAt: now, lastActiveAt: now},
      $unset: {migrationId: ''}}, {session});
  if (finished.modifiedCount !== 1) throw new AppError(409, 'Could not finalize the serial maintenance gate.');
  return result;
}
