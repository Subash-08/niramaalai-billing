import 'server-only';
import {Db, ClientSession} from 'mongodb';
import {AppError, mongo} from './db';
import {Identity} from './security';
import {uid} from '../lib/domain';
import {recordAudit} from './audit';
import {lockBusinessDay} from './business-day';
import {
  col,
  nextTenantSequence,
  assertPhase3MigrationComplete,
  assertOperationalPostingAllowed,
  executeIdempotentTransaction,
} from './purchase-service';
import {canonicalSerialKey, resolveSerialUnit, transitionSerialUnit} from './serial-identity';
import {todayInKolkata} from './purchase-schema';
import {
  CreateServiceJobInput,
  CreateServiceJobSchema,
  UpdateServiceJobStatusInput,
  UpdateServiceJobStatusSchema,
  UpdateEstimateInput,
  UpdateEstimateSchema,
  IssueServicePartInput,
  IssueServicePartSchema,
  ReverseServicePartInput,
  ReverseServicePartSchema,
  ServiceJobListQueryInput,
  ServiceJobListQuerySchema,
} from './service-schema';

export interface ServiceJobDocument {
  _id: string;
  tenantId: string;
  jobNumber: string;
  customerId: string;
  customerSnapshot: {
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    gst?: string;
  };
  device: {
    type: string;
    brand: string;
    model: string;
    serialNumber?: string;
    accessories?: string;
    conditionNotes?: string;
    photos: string[];
  };
  reportedProblem: string;
  diagnosticNotes?: string;
  status: string;
  estimate: {
    estimatedCostPaise: number;
    status: 'Pending' | 'Approved' | 'Rejected';
    revisionHistory: Array<{
      revision: number;
      estimatedCostPaise: number;
      notes: string;
      status: 'Pending' | 'Approved' | 'Rejected';
      createdAt: Date;
      createdBy: string;
    }>;
  };
  parts: Array<{
    partId: string;
    productId: string;
    productName: string;
    lotId: string;
    quantity: number;
    unitCostPaise: number;
    billingRatePaise: number;
    taxBasisPoints: number;
    hsn: string;
    serials: string[];
    consumedAt: Date;
    consumedBy: string;
    invoiced: boolean;
    invoiceId?: string;
    reversed: boolean;
    reversalReason?: string;
    conditionAtReversal?: 'Sellable' | 'Defective';
  }>;
  invoiceId?: string;
  deliveredAt?: Date;
  deliveredTo?: string;
  unpaidDuesAllowed?: boolean;
  version: number;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

async function assertJobPhotos(db: Db, tenantId: string, ids: string[], session?: ClientSession) {
  if (new Set(ids).size !== ids.length) throw new AppError(400, 'Duplicate photos are not allowed.');
  for (const id of ids) {
    const file = await col(db, 'files').findOne({_id: id, tenantId, status: 'Active'}, {session});
    if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new AppError(404, 'Service photo not found or unavailable.');
  }
}

export async function createServiceJob(db: Db, identity: Identity, raw: unknown) {
  const input = CreateServiceJobSchema.parse(raw);
  const tenantId = identity.tenantId;

  await assertPhase3MigrationComplete(db, tenantId);

  const customer = await col(db, 'customers').findOne({_id: input.customerId, tenantId, status: 'Active'});
  if (!customer) throw new AppError(404, 'Customer not found or archived.');

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'createServiceJob',
    input.customerId,
    input,
    async (session: ClientSession) => {
      await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());
      await lockBusinessDay(db, session, tenantId);

      const yearStr = new Date().getFullYear().toString();
      const jobNumber = await nextTenantSequence(db, tenantId, 'ServiceJob', yearStr, 'JOB', session);
      const jobId = uid('JOB');
      const now = new Date();

      await assertJobPhotos(db, tenantId, input.device.photos, session);
      const initialEstimatePaise = input.initialEstimatePaise || 0;

      const job: ServiceJobDocument = {
        _id: jobId,
        tenantId,
        jobNumber,
        customerId: input.customerId,
        customerSnapshot: {
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          address: customer.address,
          gst: customer.gst,
        },
        device: {
          type: input.device.type,
          brand: input.device.brand,
          model: input.device.model,
          serialNumber: input.device.serialNumber || '',
          accessories: input.device.accessories || '',
          conditionNotes: input.device.conditionNotes || '',
          photos: input.device.photos || [],
        },
        reportedProblem: input.reportedProblem,
        status: 'Received',
        estimate: {
          estimatedCostPaise: initialEstimatePaise,
          status: 'Pending',
          revisionHistory: [
            {
              revision: 1,
              estimatedCostPaise: initialEstimatePaise,
              notes: 'Initial intake estimate',
              status: 'Pending',
              createdAt: now,
              createdBy: identity.userId,
            },
          ],
        },
        parts: [],
        version: 1,
        createdAt: now,
        createdBy: identity.userId,
        updatedAt: now,
        updatedBy: identity.userId,
      };

      await col(db, 'serviceJobs').insertOne(job, {session});

      await recordAudit(
        db,
        {
          identity,
          action: 'Create',
          entityType: 'serviceJob',
          entityId: jobId,
          detail: `Created service job ${jobNumber} for ${customer.name} (${input.device.brand} ${input.device.model})`,
          after: job,
        },
        session
      );

      return job;
    }
  );
}

export async function updateServiceJobStatus(
  db: Db,
  identity: Identity,
  jobId: string,
  raw: unknown
) {
  const input = UpdateServiceJobStatusSchema.parse(raw);
  const tenantId = identity.tenantId;


  const client = await mongo();
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      await lockBusinessDay(db, session, tenantId);

      const job = await col<ServiceJobDocument>(db, 'serviceJobs').findOne(
        {tenantId, $or: [{_id: jobId}, {jobNumber: jobId}]},
        {session}
      );
      if (!job) throw new AppError(404, 'Service job not found.');

      if (job.version !== input.expectedVersion) {
        throw new AppError(409, 'Service job was modified by another session. Refresh and try again.');
      }

      // Evidence-only edits do not post money or stock. Keep the shared day fence
      // and optimistic job version even when onboarding has not been finalized.
      const evidenceOnly = input.photos !== undefined && input.status === job.status &&
        (input.diagnosticNotes === undefined || input.diagnosticNotes === (job.diagnosticNotes || ''));
      if (!evidenceOnly) {
        await assertPhase3MigrationComplete(db, tenantId, session);
        await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());
      }

      // Check cancellation rules: cannot cancel if unreversed or unbilled parts exist
      if (input.status === 'Cancelled') {
        const activeParts = (job.parts || []).filter((p: any) => !p.reversed);
        if (activeParts.length > 0) {
          throw new AppError(
            400,
            `Cannot cancel job: ${activeParts.length} consumed part(s) must be reversed or removed first.`
          );
        }
      }

      const now = new Date();
      const updateFields: any = {
        status: input.status,
        updatedAt: now,
        updatedBy: identity.userId,
      };

      if (input.diagnosticNotes !== undefined) updateFields.diagnosticNotes = input.diagnosticNotes;
      if (input.photos !== undefined) {
        await assertJobPhotos(db, tenantId, input.photos, session);
        if ((job.device.photos || []).some((id: string) => !input.photos!.includes(id))) {
          throw new AppError(400, 'Existing service evidence cannot be removed through a status update.');
        }
        updateFields['device.photos'] = input.photos;
      }
      if (input.status === 'Delivered' && job.status !== 'Delivered') {
        updateFields.deliveredAt = now;
        updateFields.deliveredTo = job.customerSnapshot.name;
      }

      const res = await col(db, 'serviceJobs').updateOne(
        {_id: job._id, tenantId, version: input.expectedVersion},
        {$set: updateFields, $inc: {version: 1}},
        {session}
      );

      if (res.matchedCount === 0) {
        throw new AppError(409, 'Concurrent update conflict. Please retry.');
      }

      await recordAudit(
        db,
        {
          identity,
          action: 'Update',
          entityType: 'serviceJob',
          entityId: jobId,
          detail: `Updated service job ${job.jobNumber} status from ${job.status} to ${input.status}`,
        },
        session
      );

      return {success: true, jobId, status: input.status, version: job.version + 1};
    });
  } finally {
    await session.endSession();
  }
}

export async function updateEstimate(
  db: Db,
  identity: Identity,
  jobId: string,
  raw: unknown
) {
  const input = UpdateEstimateSchema.parse(raw);
  const tenantId = identity.tenantId;

  await assertPhase3MigrationComplete(db, tenantId);

  const client = await mongo();
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());
      await lockBusinessDay(db, session, tenantId);

      const job = await col<ServiceJobDocument>(db, 'serviceJobs').findOne(
        {tenantId, $or: [{_id: jobId}, {jobNumber: jobId}]},
        {session}
      );
      if (!job) throw new AppError(404, 'Service job not found.');

      if (job.version !== input.expectedVersion) {
        throw new AppError(409, 'Service job version mismatch. Please reload.');
      }

      const now = new Date();
      const nextRev = (job.estimate?.revisionHistory?.length || 0) + 1;

      const revisionItem = {
        revision: nextRev,
        estimatedCostPaise: input.estimatedCostPaise,
        notes: input.notes || '',
        status: input.status,
        createdAt: now,
        createdBy: identity.userId,
      };

      const nextJobStatus =
        input.status === 'Approved'
          ? 'EstimateApproved'
          : input.status === 'Rejected'
          ? 'EstimateRejected'
          : 'EstimatePending';

      await col(db, 'serviceJobs').updateOne(
        {_id: job._id, tenantId, version: input.expectedVersion},
        {
          $set: {
            'estimate.estimatedCostPaise': input.estimatedCostPaise,
            'estimate.status': input.status,
            status: nextJobStatus,
            updatedAt: now,
            updatedBy: identity.userId,
          },
          $push: {'estimate.revisionHistory': revisionItem as any},
          $inc: {version: 1},
        },
        {session}
      );

      await recordAudit(
        db,
        {
          identity,
          action: 'Update',
          entityType: 'serviceJob',
          entityId: jobId,
          detail: `Updated estimate on job ${job.jobNumber} to ₹${(input.estimatedCostPaise / 100).toFixed(2)} (${input.status})`,
        },
        session
      );

      return {success: true, estimatedCostPaise: input.estimatedCostPaise, status: input.status};
    });
  } finally {
    await session.endSession();
  }
}

export async function issueServicePart(
  db: Db,
  identity: Identity,
  jobId: string,
  raw: unknown
) {
  const input = IssueServicePartSchema.parse(raw);
  const tenantId = identity.tenantId;

  await assertPhase3MigrationComplete(db, tenantId);
  await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'issueServicePart',
    jobId,
    input,
    async (session: ClientSession) => {
      await lockBusinessDay(db, session, tenantId);

      const job = await col<ServiceJobDocument>(
        db,
        'serviceJobs'
      ).findOne({tenantId, $or: [{_id: jobId}, {jobNumber: jobId}]}, {session});
      if (!job) throw new AppError(404, 'Service job not found.');
      if (['Delivered', 'Cancelled', 'Unrepaired'].includes(job.status)) {
        throw new AppError(400, `Cannot issue parts to a job with status "${job.status}".`);
      }
      if (job.version !== input.expectedVersion) {
        throw new AppError(409, 'Service job version mismatch. Please reload.');
      }

      const product = await col(db, 'products').findOne({_id: input.productId, tenantId, status: 'Active'}, {session});
      if (!product) throw new AppError(404, 'Product not found or archived.');

      // Check stockLot
      const lot = await col(db, 'stockLots').findOne({_id: input.lotId, tenantId, productId: input.productId}, {session});
      if (!lot) throw new AppError(404, 'Stock lot not found.');
      if (lot.quantitySellable < input.quantity) {
        throw new AppError(400, `Insufficient sellable stock in selected lot (${lot.quantitySellable} available).`);
      }

      // Check serials if serialized
      if (product.isSerialTracked) {
        if (!input.serials || input.serials.length !== input.quantity) {
          throw new AppError(400, `Provide exactly ${input.quantity} serial number(s) for this part.`);
        }
        for (const s of input.serials) {
          const resolved = await resolveSerialUnit(db, session, tenantId, s, {
            productId: input.productId,
            expectedStatus: 'InStock',
          });
          await transitionSerialUnit(db, session, resolved.unit._id, {
            transition: 'ServiceConsumption',
            expected: {
              tenantId,
              productId: input.productId,
              lotId: input.lotId,
              status: 'InStock',
              version: resolved.version,
            },
            nextState: {
              status: 'ConsumedInService',
              serviceJobId: jobId,
            },
          });
        }
      }

      // Atomically decrement sellable and increment quantityConsumed on stockLot
      const lotRes = await col(db, 'stockLots').updateOne(
        {
          _id: input.lotId,
          tenantId,
          productId: input.productId,
          quantitySellable: {$gte: input.quantity},
        },
        {
          $inc: {
            quantitySellable: -input.quantity,
            quantityConsumed: input.quantity,
            version: 1,
          },
          $set: {updatedAt: new Date()},
        },
        {session}
      );

      if (lotRes.matchedCount === 0 || lotRes.modifiedCount === 0) {
        throw new AppError(409, 'Stock lot changed concurrently. Please retry.');
      }

      const now = new Date();
      const partId = uid('PRT');

      // Append stockMovement
      await col(db, 'stockMovements').insertOne(
        {
          _id: uid('SMV'),
          tenantId,
          date: todayInKolkata(),
          productId: input.productId,
          lotId: input.lotId,
          qty: -input.quantity,
          reason: `Service consumption: ${job.jobNumber}`,
          reference: job.jobNumber,
          sourceType: 'ServiceJob',
          sourceId: jobId,
          serials: input.serials,
          createdAt: now,
          createdBy: identity.userId,
        },
        {session}
      );

      const partRecord = {
        partId,
        productId: input.productId,
        productName: product.name,
        lotId: input.lotId,
        quantity: input.quantity,
        unitCostPaise: lot.costPaise || 0,
        billingRatePaise: input.billingRatePaise,
        taxBasisPoints: input.taxBasisPoints,
        hsn: product.hsn || '',
        serials: input.serials,
        consumedAt: now,
        consumedBy: identity.userId,
        invoiced: false,
        reversed: false,
      };

      await col(db, 'serviceJobs').updateOne(
        {_id: job._id, tenantId},
        {
          $push: {parts: partRecord as any},
          $inc: {version: 1},
          $set: {updatedAt: now, updatedBy: identity.userId},
        },
        {session}
      );

      await recordAudit(
        db,
        {
          identity,
          action: 'ConsumePart',
          entityType: 'serviceJob',
          entityId: jobId,
          detail: `Issued ${input.quantity} unit(s) of ${product.name} to job ${job.jobNumber}`,
          after: partRecord,
        },
        session
      );

      return {success: true, partId, quantity: input.quantity};
    }
  );
}

export async function reverseServicePart(
  db: Db,
  identity: Identity,
  jobId: string,
  partId: string,
  raw: unknown
) {
  const input = ReverseServicePartSchema.parse(raw);
  const tenantId = identity.tenantId;

  await assertPhase3MigrationComplete(db, tenantId);
  await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'reverseServicePart',
    partId,
    input,
    async (session: ClientSession) => {
      await lockBusinessDay(db, session, tenantId);

      const job = await col<ServiceJobDocument>(
        db,
        'serviceJobs'
      ).findOne({tenantId, $or: [{_id: jobId}, {jobNumber: jobId}]}, {session});
      if (!job) throw new AppError(404, 'Service job not found.');

      const part = (job.parts || []).find((p: any) => p.partId === partId);
      if (!part) throw new AppError(404, 'Part record not found on this service job.');
      if (part.reversed) throw new AppError(400, 'This part consumption was already reversed.');
      if (part.invoiced) {
        throw new AppError(
          400,
          `Part is billed on invoice ${part.invoiceId}. Unwind or credit the invoice before reversing this part.`
        );
      }

      // Check lot and return to appropriate bucket
      const lotField = input.condition === 'Defective' ? 'quantityDefective' : 'quantitySellable';

      await col(db, 'stockLots').updateOne(
        {
          _id: part.lotId,
          tenantId,
          quantityConsumed: {$gte: part.quantity},
        },
        {
          $inc: {
            quantityConsumed: -part.quantity,
            [lotField]: part.quantity,
            version: 1,
          },
          $set: {updatedAt: new Date()},
        },
        {session}
      );

      // Revert serial status
      if (part.serials && part.serials.length > 0) {
        for (const s of part.serials) {
          const resolved = await resolveSerialUnit(db, session, tenantId, s, {
            productId: part.productId,
            expectedStatus: 'ConsumedInService',
          });
          await transitionSerialUnit(db, session, resolved.unit._id, {
            transition: 'ServiceReversal',
            expected: {
              tenantId,
              productId: part.productId,
              lotId: part.lotId,
              status: 'ConsumedInService',
              version: resolved.version,
            },
            nextState: {
              status: input.condition === 'Defective' ? 'Defective' : 'InStock',
              serviceJobId: null,
            },
          });
        }
      }

      const now = new Date();

      // Append incoming stockMovement
      await col(db, 'stockMovements').insertOne(
        {
          _id: uid('SMV'),
          tenantId,
          date: todayInKolkata(),
          productId: part.productId,
          lotId: part.lotId,
          qty: part.quantity,
          reason: `Service part reversal (${input.condition}): ${input.reason}`,
          reference: job.jobNumber,
          sourceType: 'ServiceJob',
          sourceId: jobId,
          serials: part.serials,
          createdAt: now,
          createdBy: identity.userId,
        },
        {session}
      );

      // Mark part reversed on job
      await col(db, 'serviceJobs').updateOne(
        {_id: job._id, tenantId, 'parts.partId': partId},
        {
          $set: {
            'parts.$.reversed': true,
            'parts.$.reversalReason': input.reason,
            'parts.$.conditionAtReversal': input.condition,
            updatedAt: now,
            updatedBy: identity.userId,
          },
          $inc: {version: 1},
        },
        {session}
      );

      await recordAudit(
        db,
        {
          identity,
          action: 'ReversePart',
          entityType: 'serviceJob',
          entityId: jobId,
          detail: `Reversed part ${part.productName} on job ${job.jobNumber} to ${input.condition} stock (${input.reason})`,
        },
        session
      );

      return {success: true, partId, condition: input.condition};
    }
  );
}

export async function listServiceJobs(db: Db, identity: Identity, rawQuery: unknown) {
  const query = ServiceJobListQuerySchema.parse(rawQuery);
  const tenantId = identity.tenantId;

  await assertPhase3MigrationComplete(db, tenantId);

  const filter: Record<string, any> = {tenantId};
  if (query.status && query.status !== 'All' && query.status !== 'All jobs') {
    if (query.status === 'Active' || query.status === 'Active jobs') {
      filter.status = {$nin: ['Delivered', 'Cancelled']};
    } else {
      filter.status = query.status;
    }
  }
  if (query.customerId) filter.customerId = query.customerId;
  if (query.search) {
    const rx = {$regex: query.search, $options: 'i'};
    filter.$or = [
      {jobNumber: rx},
      {'customerSnapshot.name': rx},
      {'customerSnapshot.phone': rx},
      {'device.brand': rx},
      {'device.model': rx},
      {'device.serialNumber': rx},
      {reportedProblem: rx},
    ];
  }

  const page = query.page || 1;
  const limit = query.limit || 50;
  const skip = (page - 1) * limit;

  const [totalCount, jobs] = await Promise.all([
    col(db, 'serviceJobs').countDocuments(filter),
    col(db, 'serviceJobs')
      .find(filter)
      .sort({createdAt: -1})
      .skip(skip)
      .limit(limit)
      .toArray(),
  ]);

  return {
    jobs,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
    },
  };
}

export async function getServiceJob(db: Db, identity: Identity, jobId: string) {
  const tenantId = identity.tenantId;
  const job = await col<ServiceJobDocument>(db, 'serviceJobs').findOne({
    tenantId,
    $or: [{_id: jobId}, {jobNumber: jobId}],
  });
  if (!job) throw new AppError(404, 'Service job not found.');
  return job;
}
