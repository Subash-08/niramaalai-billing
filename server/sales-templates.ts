import 'server-only';
import {Db, ClientSession} from 'mongodb';
import {mongo, AppError} from './db';
import {Identity} from './security';
import {recordAudit} from './audit';
import {uid} from '../lib/domain';
import {col} from './purchase-service';
import {InvoiceTemplateInputSchema} from './master-schema';

async function transaction<T>(db: Db, identity: Identity, work: (session: ClientSession) => Promise<T>) {
  const session = (await mongo()).startSession();
  try {
    return await session.withTransaction(async () => {
      // Serialize every template writer, including first-template creation and restore.
      const lock = await col(db, 'tenants').updateOne(
        {_id: identity.tenantId},
        {$inc: {templateWriteVersion: 1}},
        {session}
      );
      if (!lock.matchedCount) throw new AppError(404, 'Company not found.');
      return work(session);
    });
  } finally {
    await session.endSession();
  }
}

function settings(raw: any) {
  // Stored records contain audit/archive metadata. Validate only editable settings
  // so subsequent edits, copies and restores cannot leak metadata into strict input.
  const keys = ['name', 'title', 'paper', 'orientation', 'fontSize', 'accent',
    'borders', 'striped', 'logoPosition', 'fields', 'columns', 'footer', 'isDefault'];
  const input = Object.fromEntries(keys.filter(key => raw?.[key] !== undefined)
    .map(key => [key, raw[key]]));
  const {expectedRevision, ...result} = InvoiceTemplateInputSchema.parse(input);
  return result;
}

async function requireTemplate(db: Db, identity: Identity, id: string, session: ClientSession) {
  const record = await col(db, 'invoiceTemplates').findOne({_id: id, tenantId: identity.tenantId}, {session});
  if (!record) throw new AppError(404, 'Template not found.');
  return record;
}

async function saveRevision(db: Db, identity: Identity, record: any, session: ClientSession) {
  // Revision immutability: persist a frozen snapshot
  await col(db, 'templateRevisions').insertOne({
    _id: `${record._id}_rev_${record.currentRevision}`,
    templateId: record._id,
    tenantId: identity.tenantId,
    revision: record.currentRevision,
    snapshot: record,
    createdAt: new Date(),
    createdBy: identity.userId,
  }, {session});
}

async function uniqueName(db: Db, identity: Identity, name: string, id: string, session: ClientSession) {
  const duplicate = await col(db, 'invoiceTemplates').findOne({
    tenantId: identity.tenantId,
    nameNormalized: name.toLowerCase(),
    status: 'Active',
    _id: {$ne: id},
  }, {session});
  if (duplicate) throw new AppError(409, 'An active template already uses this name.');
}

export async function listTemplates(db: Db, identity: Identity) {
  const templates = await col(db, 'invoiceTemplates')
    .find({tenantId: identity.tenantId, status: 'Active'})
    .sort({isDefault: -1, name: 1, _id: 1})
    .toArray();
  return {templates};
}

export async function getTemplateById(db: Db, identity: Identity, id: string) {
  const template = await col(db, 'invoiceTemplates').findOne({
    _id: id,
    tenantId: identity.tenantId,
  });
  if (!template) throw new AppError(404, 'Template not found.');

  const revisions = await col(db, 'templateRevisions')
    .find({templateId: id, tenantId: identity.tenantId})
    .sort({revision: -1})
    .toArray();

  return {...template, revisions};
}

async function create(db: Db, identity: Identity, raw: any, session: ClientSession) {
  const input = settings(raw);
  const id = uid('TPL');
  await uniqueName(db, identity, input.name, id, session);

  const existingDefault = await col(db, 'invoiceTemplates').findOne({
    tenantId: identity.tenantId,
    status: 'Active',
    isDefault: true,
  }, {session});

  const isDefault = input.isDefault || !existingDefault;
  if (isDefault) {
    await col(db, 'invoiceTemplates').updateMany(
      {tenantId: identity.tenantId},
      {$set: {isDefault: false}},
      {session}
    );
  }

  const now = new Date();
  const record = {
    ...input,
    _id: id,
    tenantId: identity.tenantId,
    nameNormalized: input.name.toLowerCase(),
    isDefault,
    status: 'Active',
    currentRevision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: identity.userId,
  };

  await col(db, 'invoiceTemplates').insertOne(record, {session});
  await saveRevision(db, identity, record, session);

  await recordAudit(db, {
    identity,
    action: 'Create',
    entityType: 'invoiceTemplate',
    entityId: id,
    detail: `Created template ${record.name}`,
    after: record,
  }, session);

  return record;
}

export async function createTemplate(db: Db, identity: Identity, raw: any) {
  return transaction(db, identity, session => create(db, identity, raw, session));
}

async function update(db: Db, identity: Identity, existing: any, raw: any, session: ClientSession) {
  if (existing.status !== 'Active') throw new AppError(409, 'Restore this template before editing it.');

  const input = settings({...existing, ...raw});
  await uniqueName(db, identity, input.name, existing._id, session);

  if (existing.isDefault && !input.isDefault) {
    throw new AppError(400, 'Select another default template first.');
  }

  if (input.isDefault) {
    await col(db, 'invoiceTemplates').updateMany(
      {tenantId: identity.tenantId},
      {$set: {isDefault: false}},
      {session}
    );
  }

  if (!Number.isSafeInteger(existing.currentRevision) || existing.currentRevision < 1)
    throw new AppError(409, 'Stored template revision needs reconciliation before editing.');
  const nextRevision = existing.currentRevision + 1;
  const now = new Date();
  const record = {
    ...existing,
    ...input,
    nameNormalized: input.name.toLowerCase(),
    currentRevision: nextRevision,
    updatedAt: now,
    updatedBy: identity.userId,
  };

  await col(db, 'invoiceTemplates').replaceOne(
    {_id: existing._id, tenantId: identity.tenantId},
    record,
    {session}
  );

  await saveRevision(db, identity, record, session);

  await recordAudit(db, {
    identity,
    action: 'Update',
    entityType: 'invoiceTemplate',
    entityId: existing._id,
    detail: `Template revision ${record.currentRevision}`,
    before: existing,
    after: record,
  }, session);

  return {...record, success: true};
}

export async function updateTemplate(db: Db, identity: Identity, id: string, raw: any) {
  return transaction(db, identity, async session => {
    const existing = await requireTemplate(db, identity, id, session);
    if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1 || raw.expectedRevision !== existing.currentRevision)
      throw new AppError(409, 'Template changed or revision is missing. Reload before saving.');
    return update(db, identity, existing, raw, session);
  });
}

export async function copyTemplate(db: Db, identity: Identity, id: string, newName?: string) {
  return transaction(db, identity, async session => {
    const existing = await requireTemplate(db, identity, id, session);
    return create(db, identity, {...existing, name: newName ?? `${existing.name} (Copy)`, isDefault: false}, session);
  });
}

export async function renameTemplate(db: Db, identity: Identity, id: string, name: string) {
  return transaction(db, identity, async session => {
    const existing = await requireTemplate(db, identity, id, session);
    return update(db, identity, existing, {name}, session);
  });
}

export async function setDefaultTemplate(db: Db, identity: Identity, id: string) {
  return transaction(db, identity, async session => {
    const existing = await requireTemplate(db, identity, id, session);
    return update(db, identity, existing, {isDefault: true}, session);
  });
}

export async function archiveTemplate(db: Db, identity: Identity, id: string) {
  return transaction(db, identity, async session => {
    const record = await requireTemplate(db, identity, id, session);
    if (record.isDefault) throw new AppError(409, 'Choose another default before archiving this template.');

    await col(db, 'invoiceTemplates').updateOne(
      {_id: id, tenantId: identity.tenantId},
      {$set: {status: 'Archived', updatedAt: new Date(), archivedBy: identity.userId}},
      {session}
    );

    await recordAudit(db, {
      identity,
      action: 'Archive',
      entityType: 'invoiceTemplate',
      entityId: id,
      before: record,
      detail: 'Archived invoice template',
    }, session);

    return {success: true};
  });
}

export async function restoreTemplate(db: Db, identity: Identity, id: string) {
  return transaction(db, identity, async session => {
    const record = await requireTemplate(db, identity, id, session);
    if (record.status === 'Active') return {success: true};

    // Restoring an archived template whose name is now in use must fail
    await uniqueName(db, identity, record.name, id, session);

    await col(db, 'invoiceTemplates').updateOne(
      {_id: id, tenantId: identity.tenantId},
      {
        $set: {status: 'Active', isDefault: false, updatedAt: new Date()},
        $unset: {archivedAt: '', archivedBy: ''},
      },
      {session}
    );

    await recordAudit(db, {
      identity,
      action: 'Restore',
      entityType: 'invoiceTemplate',
      entityId: id,
      before: record,
      detail: 'Restored invoice template',
    }, session);

    return {success: true};
  });
}
