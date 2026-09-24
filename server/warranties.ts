import 'server-only';
import {z} from 'zod';
import {canonicalSerialKey, resolveSerialUnit, transitionSerialUnit} from './serial-identity';
import {todayInKolkata} from './purchase-schema';
import {assertSalePostingDay, addWarrantyMonths} from './sales-posting';
import {Db, ClientSession} from 'mongodb';
import {AppError} from './db';
import {Identity} from './security';
import {recordAudit} from './audit';
import {uid} from '../lib/domain';
import {col, executeIdempotentTransaction} from './purchase-service';

export type WarrantyDocument = {
  _id: string;
  tenantId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceLineId: string;
  customerId: string;
  customerSnapshot: {name: string; phone?: string};
  productId: string;
  productSnapshot?: {name: string; hsn?: string; isSerialTracked?: boolean};
  serviceId?: string;
  serial?: string | null;
  serialNumber?: string;
  quantity?: number;
  remainingQuantity?: number;
  warrantyMonths: number;
  coverage?: string;
  startDate: string;
  endDate: string;
  status: 'Active' | 'Expired' | 'Claimed' | 'Returned';
  version?: number;
  returnId?: string;
  returnedAt?: Date;
  claimDetails?: {
    claimDate: string;
    reason: string;
    action: 'Repaired' | 'Replaced' | 'Rejected';
    replacementSerial?: string;
    notes?: string;
    attachmentIds?: string[];
    handledBy: string;
  };
  notes?: string;
  attachmentIds?: string[];
  createdAt: Date;
  updatedAt?: Date;
  createdBy?: string;
};

export async function listWarranties(
  db: Db,
  identity: Identity,
  query: any = {}
) {
  const tenantId = identity.tenantId;
  const filter: Record<string, any> = {tenantId};
  if (query.customerId) filter.customerId = query.customerId;
  if (query.productId) filter.productId = query.productId;
  if (query.invoiceId) filter.invoiceId = query.invoiceId;
  if (query.status && query.status !== 'All') filter.status = query.status;
  if (query.serial) {
    try {
      const sNorm = canonicalSerialKey(query.serial);
      filter.$or = [{serialNumber: sNorm}, {serial: sNorm}, {serial: query.serial}];
    } catch {
      filter.$or = [{serialNumber: query.serial}, {serial: query.serial}];
    }
  }
  if (query.search) {
    const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      {invoiceNumber: {$regex: escaped, $options: 'i'}},
      {serialNumber: {$regex: escaped, $options: 'i'}},
      {serial: {$regex: escaped, $options: 'i'}},
      {'customerSnapshot.name': {$regex: escaped, $options: 'i'}},
      {'productSnapshot.name': {$regex: escaped, $options: 'i'}},
    ];
  }

  const page = Math.max(1, parseInt(query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

  const [items, total] = await Promise.all([
    col<WarrantyDocument>(db, 'warranties')
      .find(filter)
      .sort({endDate: 1, createdAt: -1})
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    col(db, 'warranties').countDocuments(filter),
  ]);

  return {items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit))};
}

export const ClaimSchema = z.object({
  reason: z.string().trim().min(1, 'Claim reason is required.').max(1000),
  action: z.enum(['Repaired', 'Replaced', 'Rejected']),
  replacementSerial: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
  attachmentIds: z.array(z.string().trim().min(1).max(128)).max(10).optional(),
  expectedVersion: z.number().int().min(1, 'Expected version must be an integer >= 1.'),
  idempotencyKey: z.string().trim().min(8, 'Idempotency key must be at least 8 characters.').max(200),
});

export async function claimWarranty(db: Db, identity: Identity, warrantyId: string, raw: unknown) {
  const input = ClaimSchema.parse(raw);
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'claimWarranty',
    warrantyId,
    input,
    async (session: ClientSession) => {
      const warranty = await col<WarrantyDocument>(db, 'warranties').findOne({_id: warrantyId, tenantId}, {session});
      if (!warranty) throw new AppError(404, 'Warranty record not found.');

      if ((warranty.version ?? 1) !== input.expectedVersion) {
        throw new AppError(409, `Warranty version mismatch: expected ${input.expectedVersion}, but found ${warranty.version ?? 1}. Reload before submitting.`);
      }

      const claimDate = todayInKolkata();
      await assertSalePostingDay(db, tenantId, claimDate, session);

      if (warranty.status !== 'Active' || warranty.returnedAt || claimDate < warranty.startDate || claimDate > warranty.endDate) {
        throw new AppError(409, 'Warranty is not active for this unit and business date.');
      }

      const invoice = await col(db, 'invoices').findOne({
        _id: warranty.invoiceId,
        tenantId,
        customerId: warranty.customerId,
        status: 'Issued',
      }, {session});
      if (!invoice) throw new AppError(409, 'The issued invoice for this warranty is unavailable.');

      const line = invoice.lines.find((l: any) => l.lineId === warranty.invoiceLineId);
      if (!line) throw new AppError(409, 'Warranty has no valid invoice-line linkage.');

      const isTracked = !!line.productSnapshot?.isSerialTracked;
      let oldUnit: any = null;
      let oldVersion: number = 1;

      if (isTracked) {
        const rawSerial = warranty.serialNumber ?? warranty.serial ?? '';
        if (!rawSerial) throw new AppError(409, 'Serialized warranty record is missing serial information.');
        const res = await resolveSerialUnit(db, session, tenantId, rawSerial, {
          productId: warranty.productId,
          expectedStatus: 'Sold',
          expectedInvoiceId: warranty.invoiceId,
        });
        oldUnit = res.unit;
        oldVersion = res.version;

        if (oldUnit.invoiceLineId !== warranty.invoiceLineId || oldUnit.replacedBySerial) {
          throw new AppError(409, 'Claimed serial is no longer owned by this invoice line.');
        }
      } else {
        const remaining = warranty.remainingQuantity ?? warranty.quantity ?? 1;
        if (remaining < 1) {
          throw new AppError(409, 'No remaining covered quantity available for this non-serialized item.');
        }
      }

      const now = new Date();
      const claimId = uid('WCL');
      let replacementSerial: string | undefined;
      let repSerialToStore: string | undefined;
      const oldSerialToStore = oldUnit?.serialOriginal || oldUnit?.serial || warranty.serialNumber || warranty.serial;

      if (input.action === 'Replaced') {
        if (!isTracked) {
          throw new AppError(400, 'Unit replacement is currently supported for serialized products.');
        }

        if (!input.replacementSerial) {
          throw new AppError(400, 'Replacement serial is required for this serialized product.');
        }

        const repRes = await resolveSerialUnit(db, session, tenantId, input.replacementSerial, {
          productId: warranty.productId,
          expectedStatus: 'InStock',
        });
        const replacement = repRes.unit;
        const replacementVersion = repRes.version;

        if (!oldUnit || replacement._id === oldUnit._id) {
          throw new AppError(400, 'Select a different replacement serial for this serialized product.');
        }

        if (!replacement.lotId || !oldUnit.lotId) {
          throw new AppError(409, 'Both units must have traceable stock lots.');
        }

        // Verify replacement lot has available sellable stock
        const incoming = await col(db, 'stockLots').updateOne(
          {_id: oldUnit.lotId, tenantId, productId: warranty.productId, quantitySold: {$gte: 1}},
          {$inc: {quantitySold: -1, quantityDefective: 1, version: 1}, $set: {updatedAt: now}},
          {session}
        );

        const outgoing = await col(db, 'stockLots').updateOne(
          {_id: replacement.lotId, tenantId, productId: warranty.productId, quantitySellable: {$gte: 1}, quantityRemaining: {$gte: 1}},
          {$inc: {quantitySold: 1, quantitySellable: -1, quantityRemaining: -1, version: 1}, $set: {updatedAt: now}},
          {session}
        );

        if (incoming.matchedCount !== 1 || outgoing.matchedCount !== 1) {
          throw new AppError(409, 'Stock changed. Reload before replacing this unit.');
        }

        repSerialToStore = replacement.serialOriginal || input.replacementSerial;

        await transitionSerialUnit(db, session, oldUnit._id, {
          transition: 'WarrantyReplacementClaim',
          expected: {
            tenantId,
            productId: warranty.productId,
            lotId: oldUnit.lotId,
            status: 'Sold',
              invoiceId: warranty.invoiceId,
              invoiceLineId: warranty.invoiceLineId,
            version: oldVersion,
          },
          nextState: {
            status: 'Defective',
            replacedBySerial: repSerialToStore,
            warrantyClaimId: claimId,
            invoiceId: null,
            soldInvoiceId: null,
            invoiceLineId: null,
          },
        });

        await transitionSerialUnit(db, session, replacement._id, {
          transition: 'WarrantyReplacementSupply',
          expected: {
            tenantId,
            productId: warranty.productId,
            lotId: replacement.lotId,
            status: 'InStock',
            version: replacementVersion,
          },
          nextState: {
            status: 'Sold',
            invoiceId: warranty.invoiceId,
            soldInvoiceId: warranty.invoiceId,
            invoiceLineId: warranty.invoiceLineId,
            replacesSerial: oldSerialToStore,
            warrantyClaimId: claimId,
            soldAt: now,
          },
        });

        await col(db, 'stockMovements').insertMany([
          {
            _id: uid('STM'),
            tenantId,
            productId: warranty.productId,
            lotId: oldUnit.lotId,
            type: 'WarrantyReplacementDefective',
            qty: 1,
            onHandDelta: 1,
            sellableDelta: 0,
            defectiveDelta: 1,
            soldDelta: -1,
            serials: [oldSerialToStore],
          },
          {
            _id: uid('STM'),
            tenantId,
            productId: warranty.productId,
            lotId: replacement.lotId,
            type: 'WarrantyReplacementOut',
            qty: -1,
            onHandDelta: -1,
            sellableDelta: -1,
            defectiveDelta: 0,
            soldDelta: 1,
            serials: [repSerialToStore],
          },
        ].map(m => ({
          ...m,
          date: claimDate,
          reference: warranty.invoiceNumber,
          invoiceId: warranty.invoiceId,
          invoiceLineId: warranty.invoiceLineId,
          warrantyId,
          claimId,
          createdAt: now,
          createdBy: identity.userId,
        })), {session});
      } else if (input.replacementSerial) {
        throw new AppError(400, 'Replacement serial is only applicable to replacement claims.');
      }

      const claimDetails = {
        claimDate,
        reason: input.reason.trim(),
        action: input.action,
        replacementSerial: repSerialToStore,
        notes: input.notes?.trim(),
        attachmentIds: input.attachmentIds || [],
        handledBy: identity.userId,
      };

      await col(db, 'warrantyClaims').insertOne({
        _id: claimId,
        tenantId,
        warrantyId,
        invoiceId: warranty.invoiceId,
        invoiceLineId: warranty.invoiceLineId,
        invoiceNumber: warranty.invoiceNumber,
        customerId: warranty.customerId,
        productId: warranty.productId,
        originalSerial: oldSerialToStore || undefined,
        ...claimDetails,
        createdAt: now,
        createdBy: identity.userId,
      }, {session});

      // Repair/replacement preserves the original coverage expiry.
      // Status remains 'Active' unless rejected/expired.
      const currentAttachmentIds = warranty.attachmentIds || [];
      const newAttachments = input.attachmentIds || [];
      const mergedAttachments = Array.from(new Set([...currentAttachmentIds, ...newAttachments]));

      await col(db, 'warranties').updateOne(
        {_id: warrantyId, tenantId},
        {
          $set: {
            claimDetails,
            attachmentIds: mergedAttachments,
            updatedAt: now,
            ...(repSerialToStore ? {serial: repSerialToStore, serialNumber: repSerialToStore} : {}),
          },
          $inc: {version: 1},
        },
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Claim',
        entityType: 'warranty',
        entityId: warrantyId,
        detail: `Warranty claim ${input.action}: ${input.reason}`,
        after: {claimId, ...claimDetails},
      }, session);

      return {success: true, claimId, claimDetails};
    }
  );
}

export const PostSaleWarrantySchema = z.object({
  invoiceId: z.string().trim().min(1, 'Invoice ID is required.'),
  invoiceLineId: z.string().trim().min(1, 'Invoice Line ID is required.'),
  serialNumber: z.string().trim().max(200).optional(),
  quantity: z.number().int().min(1).default(1),
  warrantyMonths: z.number().int().min(1).max(120, 'Warranty duration must be between 1 and 120 months.'),
  coverageProvider: z.enum(['Manufacturer', 'Shop']).default('Manufacturer'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Valid YYYY-MM-DD start date required.').optional(),
  notes: z.string().trim().max(2000).optional(),
  attachmentIds: z.array(z.string().trim().min(1).max(128)).max(10).optional(),
  idempotencyKey: z.string().trim().min(8, 'Idempotency key must be at least 8 characters.').max(200),
});

export async function getWarranty(db: Db, identity: Identity, warrantyId: string) {
  const warranty = await col<WarrantyDocument>(db, 'warranties').findOne({_id: warrantyId, tenantId: identity.tenantId});
  if (!warranty) throw new AppError(404, 'Warranty record not found.');
  return {warranty};
}

export async function createWarrantyCoverage(db: Db, identity: Identity, raw: unknown) {
  const input = PostSaleWarrantySchema.parse(raw);
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'createWarrantyCoverage',
    input.invoiceId,
    input,
    async (session: ClientSession) => {
      await assertSalePostingDay(db, tenantId, todayInKolkata(), session);
      const invoice = await col(db, 'invoices').findOneAndUpdate(
        {
          _id: input.invoiceId,
          tenantId,
          status: 'Issued',
        },
        {$inc: {warrantyLock: 1}},
        {session, returnDocument: 'after'}
      );
      if (!invoice) throw new AppError(404, 'Issued invoice not found.');

      const line = (invoice.lines || []).find((l: any) => l.lineId === input.invoiceLineId);
      if (!line) throw new AppError(404, 'Invoice line not found.');

      const isTracked = !!line.productSnapshot?.isSerialTracked;
      let sNorm: string | null = null;

      if (isTracked) {
        if (!input.serialNumber) {
          throw new AppError(400, 'Serial number is required for serialized product warranty coverage.');
        }

        const {unit} = await resolveSerialUnit(db, session, tenantId, input.serialNumber, {
          productId: line.productId,
          expectedStatus: 'Sold',
          expectedInvoiceId: invoice._id,
        });

        if (unit.invoiceLineId !== line.lineId) {
          throw new AppError(409, `Serial ${input.serialNumber} is not currently sold on invoice line.`);
        }
        if (unit.replacedBySerial) {
          throw new AppError(409, `Serial ${input.serialNumber} has already been replaced under warranty.`);
        }

        sNorm = canonicalSerialKey(input.serialNumber);

        // Prevent duplicate coverage
        const existing = await col(db, 'warranties').findOne({
          tenantId,
          invoiceId: invoice._id,
          invoiceLineId: line.lineId,
          $or: [{serial: sNorm}, {serialNumber: sNorm}, {serial: input.serialNumber}, {serialNumber: input.serialNumber}],
          status: 'Active',
        }, {session});

        if (existing) {
          throw new AppError(409, `Active warranty coverage already exists for serial ${input.serialNumber}.`);
        }
      } else {
        const unreturned = (line.quantity || 1) - (line.returnedQuantity || 0);
        const existingWarranties = await col<WarrantyDocument>(db, 'warranties').find({
          tenantId,
          invoiceId: invoice._id,
          invoiceLineId: line.lineId,
          status: 'Active',
        }, {session}).toArray();

        const alreadyCovered = existingWarranties.reduce((sum, w) => sum + (w.remainingQuantity ?? w.quantity ?? 0), 0);
        if (alreadyCovered + input.quantity > unreturned) {
          throw new AppError(409, `Requested quantity (${input.quantity}) exceeds remaining unreturned uncovered quantity (${Math.max(0, unreturned - alreadyCovered)}).`);
        }
      }

      const startDate = input.startDate || invoice.invoiceDate;
      const endDate = addWarrantyMonths(startDate, input.warrantyMonths);
      const warrantyId = uid('WAR');
      const now = new Date();

      const doc: WarrantyDocument = {
        _id: warrantyId,
        tenantId,
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceLineId: line.lineId,
        customerId: invoice.customerId,
        customerSnapshot: invoice.customerSnapshot,
        productId: line.productId,
        productSnapshot: line.productSnapshot,
        serviceId: line.serviceId,
        serial: sNorm,
        serialNumber: sNorm || undefined,
        quantity: isTracked ? 1 : input.quantity,
        remainingQuantity: isTracked ? 1 : input.quantity,
        warrantyMonths: input.warrantyMonths,
        coverage: input.coverageProvider,
        startDate,
        endDate,
        status: 'Active',
        version: 1,
        notes: input.notes?.trim(),
        attachmentIds: input.attachmentIds || [],
        createdAt: now,
        createdBy: identity.userId,
      };

      try {
        await col(db, 'warranties').insertOne(doc, {session});
      } catch (err: any) {
        if (err.code === 11000) {
          throw new AppError(409, `Active warranty coverage already exists for serial ${input.serialNumber || ''}.`);
        }
        throw err;
      }

      await recordAudit(db, {
        identity,
        action: 'warranty.create',
        entityType: 'warranty',
        entityId: warrantyId,
        detail: `Added ${input.warrantyMonths}m ${input.coverageProvider} warranty for ${line.productSnapshot?.name || 'product'} on invoice ${invoice.invoiceNumber}`,
        after: doc,
      }, session);

      return {success: true, warrantyId, warranty: doc};
    }
  );
}
