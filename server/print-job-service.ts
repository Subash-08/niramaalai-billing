import 'server-only';
import {randomUUID} from 'node:crypto';
import type {Db, ClientSession} from 'mongodb';
import type {Identity} from './security';
import {AppError, mongo} from './db';
import {recordAudit} from './audit';
import {CreatePrintJobSchema, UpdatePrintJobSchema} from './print-job-schema';

async function validateLinks(db: Db, tenantId: string, input: {customerId: string; invoiceId?: string}, session: ClientSession) {
  const customer = await db.collection<any>('customers').findOne({_id: input.customerId, tenantId, status: 'Active'}, {session});
  if (!customer) throw new AppError(404, 'Customer not found or archived.');
  if (input.invoiceId) {
    const invoice = await db.collection<any>('invoices').findOne({_id: input.invoiceId, tenantId, customerId: input.customerId, status: {$in: ['Draft', 'Issued']}}, {session});
    if (!invoice) throw new AppError(400, 'Invoice must belong to this company and the selected customer.');
  }
}

export async function createPrintJob(db: Db, identity: Identity, raw: unknown) {
  const input = CreatePrintJobSchema.parse(raw);
  const session = (await mongo()).startSession();
  try {
    return await session.withTransaction(async () => {
      await validateLinks(db, identity.tenantId, input, session);
      // The counter, job and audit commit together. Concurrent creations cannot reuse numbers.
      const counter = await db.collection<any>('tenantCounters').findOneAndUpdate(
        {_id: `PRINT-JOBS-${identity.tenantId}`, tenantId: identity.tenantId},
        {$inc: {currentValue: 1}}, {upsert: true, returnDocument: 'after', session});
      if (!counter) throw new AppError(409, 'Could not allocate a print job number.');
      const now = new Date();
      const record = {_id: `JOB-${randomUUID()}`, tenantId: identity.tenantId,
        jobNumber: `JOB-${String(counter.currentValue).padStart(5, '0')}`, ...input,
        status: 'Received', version: 1, createdAt: now, createdBy: identity.userId,
        updatedAt: now, updatedBy: identity.userId};
      await db.collection<any>('printJobs').insertOne(record, {session});
      await recordAudit(db, {identity, action: 'Created print job', entityType: 'printJob', entityId: record._id,
        after: record, detail: `Created ${record.jobNumber}: ${record.title}`}, session);
      return record;
    });
  } finally { await session.endSession(); }
}

export async function updatePrintJob(db: Db, identity: Identity, id: string, raw: unknown) {
  const {expectedVersion, ...input} = UpdatePrintJobSchema.parse(raw);
  const session = (await mongo()).startSession();
  try {
    return await session.withTransaction(async () => {
      const before = await db.collection<any>('printJobs').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!before) throw new AppError(404, 'Print job not found.');
      if (before.version !== expectedVersion) throw new AppError(409, 'Print job changed. Reload before saving.');
      if ((input.invoiceId || '') !== (before.invoiceId || '')) throw new AppError(409, 'Invoice links are managed when an invoice is issued.');
      if (before.invoiceId && (input.customerId !== before.customerId || input.status === 'Cancelled')) throw new AppError(409, 'An invoiced job cannot change customer or be cancelled.');
      await validateLinks(db, identity.tenantId, input, session);
      const result = await db.collection<any>('printJobs').findOneAndUpdate(
        {_id: id, tenantId: identity.tenantId, version: expectedVersion},
        {$set: {...input, updatedAt: new Date(), updatedBy: identity.userId}, $inc: {version: 1}},
        {returnDocument: 'after', session});
      if (!result) throw new AppError(409, 'Print job changed. Reload before saving.');
      await recordAudit(db, {identity, action: 'Updated print job', entityType: 'printJob', entityId: id,
        before, after: result, detail: `Updated ${before.jobNumber}: ${input.title}`}, session);
      return result;
    });
  } finally { await session.endSession(); }
}
