import 'server-only';
import {removeAvailableStock} from './stock-adjustment-core';
import {initializeAccountBalances} from './account-initialization';
import {lockBusinessDay} from './business-day';
import {Db, ClientSession} from 'mongodb';
import {database, mongo, AppError} from './db';
import {Identity} from './security';
import {recordAudit} from './audit';
import * as canonicalTemplates from './sales-templates';
import {
  CompanySettingsInput,
  CustomerInput,
  SupplierInput,
  ProductInput,
  StockAdjustmentInput,
  StockAdjustmentInputSchema,
  ServiceCatalogInput,
  InvoiceTemplateInput,
  OpeningDraftInput,
  FinalizeOpeningOptions,
  CorrectOpeningCutoffInput,
  PaginationQuery,
  normalizeSerial,
  normalizeGstin,
  normalizePhone,
  SERIALIZED_CATEGORIES,
} from './master-schema';
import {
  canonicalSerialKey,
  resolveSerialUnit,
  transitionSerialUnit,
  assertSerialsAvailableForCreation,
} from './serial-identity';

export const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export function todayInKolkata(): string {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata'}).format(new Date());
}

export function previousCalendarDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

export const col = (db: Db, name: string) => db.collection<any>(name);

// ---------------------------------------------------------------------------
// 1. Company Settings
// ---------------------------------------------------------------------------

export async function getCompanySettings(identity: Identity) {
  const db = await database();
  const settings = await col(db, 'companySettings').findOne({tenantId: identity.tenantId});
  if (!settings) {
    const tenant = await col(db, 'tenants').findOne({_id: identity.tenantId});
    return {
      tenantId: identity.tenantId,
      name: tenant?.companyName || 'My Store',
      phone: '',
      email: '',
      address: '',
      gst: '',
      state: '',
      stateCode: '',
      postalCode: '',
      bank: '',
      account: '',
      ifsc: '',
      declaration: 'Goods once sold will not be taken back.',
      logoFileId: '',
      demoImported: false,
    };
  }
  return settings;
}

export async function updateCompanySettings(identity: Identity, input: CompanySettingsInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');

      if (input.logoFileId) {
        const file = await col(db, 'files').findOne({_id: input.logoFileId, tenantId: identity.tenantId}, {session});
        if (!file) {
          throw new AppError(404, 'Logo file not found.');
        }
        const mimeType = (file as any).type || (file as any).mime || '';
        if (!mimeType.startsWith('image/')) {
          throw new AppError(400, 'Logo file must be an image (PNG, JPEG, WebP, SVG).');
        }
      }

      const existing = await col(db, 'companySettings').findOne({tenantId: identity.tenantId}, {session});

      const update = {
        ...input,
        tenantId: identity.tenantId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'companySettings').updateOne(
        {tenantId: identity.tenantId},
        {$set: update, $setOnInsert: {createdAt: new Date(), demoImported: false}},
        {upsert: true, session}
      );

      await recordAudit(db, {
        identity,
        action: existing ? 'Updated company settings' : 'Initialized company settings',
        entityType: 'companySettings',
        entityId: identity.tenantId,
        before: existing || undefined,
        after: update,
        detail: `Company details updated for ${input.name}`,
      }, session);

      return update;
    });
  } finally {
    await session.endSession();
  }
}

export async function updateCompanyLogo(identity: Identity, logoFileId: string | null) {
  const db = await database();
  if (logoFileId) {
    const file = await col(db, 'files').findOne({_id: logoFileId, tenantId: identity.tenantId});
    if (!file) {
      throw new AppError(404, 'Logo file not found.');
    }
    const mimeType = (file as any).type || (file as any).mime || '';
    if (!mimeType.startsWith('image/')) {
      throw new AppError(400, 'Logo file must be an image (PNG, JPEG, WebP, SVG).');
    }
  }
  await col(db, 'companySettings').updateOne(
    {tenantId: identity.tenantId},
    {$set: {logoFileId, updatedAt: new Date(), updatedBy: identity.userId}},
    {upsert: true}
  );
  return {success: true, logoFileId};
}

// ---------------------------------------------------------------------------
// 2. Customers
// ---------------------------------------------------------------------------

export async function listCustomers(identity: Identity, query: PaginationQuery) {
  const db = await database();
  const page = Math.max(1, query.page);
  const limit = Math.min(100, Math.max(1, query.limit));
  const skip = (page - 1) * limit;

  const filter: Record<string, any> = {tenantId: identity.tenantId};
  if (query.status && query.status !== 'All') {
    filter.status = query.status;
  } else if (!query.status) {
    filter.status = 'Active';
  }

  if (query.type) filter.type = query.type;

  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      {name: {$regex: escaped, $options: 'i'}},
      {category: {$regex: escaped, $options: 'i'}},
      {description: {$regex: escaped, $options: 'i'}},
      {phone: {$regex: escaped, $options: 'i'}},
      {email: {$regex: escaped, $options: 'i'}},
      {gst: {$regex: escaped, $options: 'i'}},
    ];
  }

  const computedMatch: Record<string, any> = {};
  if (query.balance === 'Outstanding') computedMatch.outstandingDuePaise = {$gt: 0};
  if (query.balance === 'Clear') computedMatch.outstandingDuePaise = 0;
  if (query.minSalesPaise != null || query.maxSalesPaise != null) computedMatch.totalSalesPaise = {
    ...(query.minSalesPaise != null && {$gte: query.minSalesPaise}),
    ...(query.maxSalesPaise != null && {$lte: query.maxSalesPaise}),
  };
  const sort = query.sortBy === 'name' ? {name: 1, _id: 1}
    : query.sortBy === 'outstanding' ? {outstandingDuePaise: -1, name: 1}
    : query.sortBy === 'sales' ? {totalSalesPaise: -1, name: 1}
    : {createdAt: -1, _id: -1};

  const result = await col(db, 'customers').aggregate([
    {$match: filter},
    {$lookup: {
      from: 'invoices', let: {customerKey: '$_id'},
      pipeline: [
        {$match: {$expr: {$and: [{$eq: ['$tenantId', identity.tenantId]}, {$eq: ['$customerId', '$$customerKey']}, {$eq: ['$status', 'Issued']}]}}},
        {$group: {_id: null, outstandingDuePaise: {$sum: '$duePaise'}, totalSalesPaise: {$sum: '$totalPaise'}, invoiceCount: {$sum: 1}, lastActivityDate: {$max: '$invoiceDate'}}},
      ], as: 'invoiceStats',
    }},
    {$lookup: {
      from: 'openingReceivables', let: {customerKey: '$_id'},
      pipeline: [
        {$match: {$expr: {$and: [{$eq: ['$tenantId', identity.tenantId]}, {$eq: ['$customerId', '$$customerKey']}, {$gt: ['$remainingAmountPaise', 0]}]}}},
        {$group: {_id: null, outstandingDuePaise: {$sum: '$remainingAmountPaise'}}},
      ], as: 'openingStats',
    }},
    {$addFields: {
      outstandingDuePaise: {$add: [{$ifNull: [{$arrayElemAt: ['$invoiceStats.outstandingDuePaise', 0]}, 0]}, {$ifNull: [{$arrayElemAt: ['$openingStats.outstandingDuePaise', 0]}, 0]}]},
      totalSalesPaise: {$ifNull: [{$arrayElemAt: ['$invoiceStats.totalSalesPaise', 0]}, 0]},
      invoiceCount: {$ifNull: [{$arrayElemAt: ['$invoiceStats.invoiceCount', 0]}, 0]},
      lastActivityDate: {$ifNull: [{$arrayElemAt: ['$invoiceStats.lastActivityDate', 0]}, '']},
    }},
    ...(Object.keys(computedMatch).length ? [{$match: computedMatch}] : []),
    {$facet: {
      records: [{$sort: sort}, {$skip: skip}, {$limit: limit}, {$unset: ['invoiceStats', 'openingStats']}],
      meta: [{$count: 'total'}],
    }},
  ]).toArray();
  const records = result[0]?.records || [];
  const total = result[0]?.meta?.[0]?.total || 0;
  return {records, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit))};
}

export async function getCustomerById(identity: Identity, id: string) {
  const db = await database();
  const customer = await col(db, 'customers').findOne({_id: id, tenantId: identity.tenantId});
  if (!customer) throw new AppError(404, 'Customer not found.');
  return customer;
}

export async function createCustomer(identity: Identity, input: CustomerInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');

      const normGst = input.gst ? normalizeGstin(input.gst) : '';
      const normPhone = input.phone ? normalizePhone(input.phone) : '';

      if (normGst) {
        const existingGst = await col(db, 'customers').findOne({
          tenantId: identity.tenantId,
          gstNormalized: normGst,
        }, {session});
        if (existingGst) {
          throw new AppError(400, 'A customer with this GSTIN already exists.');
        }
      }

      let warning: string | undefined;
      if (normPhone) {
        const existingPhone = await col(db, 'customers').findOne({
          tenantId: identity.tenantId,
          phoneNormalized: normPhone,
          status: 'Active',
        }, {session});
        if (existingPhone) {
          warning = `Phone number ${input.phone} is already used by customer "${existingPhone.name}".`;
        }
      }

      const id = uid('CUS');
      const record = {
        _id: id,
        tenantId: identity.tenantId,
        name: input.name,
        phone: input.phone || '',
        phoneNormalized: normPhone,
        email: input.email || '',
        address: input.address || '',
        gst: input.gst || '',
        gstNormalized: normGst,
        type: input.type,
        creditLimitPaise: input.creditLimitPaise ?? 0,
        paymentTermsDays: input.paymentTermsDays ?? 30,
        notes: input.notes || '',
        details: input.details || {},
        status: 'Active',
        createdAt: new Date(),
        createdBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'customers').insertOne(record, {session});

      await recordAudit(db, {
        identity,
        action: 'Created customer',
        entityType: 'customer',
        entityId: id,
        after: record,
        detail: `Added customer ${record.name} (${id})`,
      }, session);

      return {...record, warning};
    });
  } finally {
    await session.endSession();
  }
}

export async function updateCustomer(identity: Identity, id: string, input: CustomerInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'customers').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Customer not found.');

      if (existing.status === 'Archived') {
        throw new AppError(400, 'Cannot update an archived customer. Restore the record first.');
      }

      const normGst = input.gst ? normalizeGstin(input.gst) : '';
      const normPhone = input.phone ? normalizePhone(input.phone) : '';

      if (normGst) {
        const conflict = await col(db, 'customers').findOne({
          tenantId: identity.tenantId,
          gstNormalized: normGst,
          _id: {$ne: id},
        }, {session});
        if (conflict) {
          throw new AppError(400, 'A customer with this GSTIN already exists.');
        }
      }

      let warning: string | undefined;
      if (normPhone) {
        const existingPhone = await col(db, 'customers').findOne({
          tenantId: identity.tenantId,
          phoneNormalized: normPhone,
          _id: {$ne: id},
          status: 'Active',
        }, {session});
        if (existingPhone) {
          warning = `Phone number ${input.phone} is already used by customer "${existingPhone.name}".`;
        }
      }

      const update = {
        name: input.name,
        phone: input.phone || '',
        phoneNormalized: normPhone,
        email: input.email || '',
        address: input.address || '',
        gst: input.gst || '',
        gstNormalized: normGst,
        type: input.type,
        creditLimitPaise: input.creditLimitPaise !== undefined ? input.creditLimitPaise : (existing.creditLimitPaise || 0),
        paymentTermsDays: input.paymentTermsDays !== undefined ? input.paymentTermsDays : (existing.paymentTermsDays ?? 30),
        notes: input.notes || '',
        details: input.details || {},
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'customers').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Updated customer',
        entityType: 'customer',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Updated details for customer ${input.name} (${id})`,
      }, session);

      return {...existing, ...update, warning};
    });
  } finally {
    await session.endSession();
  }
}

export async function archiveCustomer(identity: Identity, id: string) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'customers').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Customer not found.');

      if (existing.status === 'Archived') return {success: true, message: 'Already archived.'};

      const outstanding = await col(db, 'openingReceivables').findOne({
        tenantId: identity.tenantId,
        customerId: id,
        remainingAmountPaise: {$gt: 0},
      }, {session});
      if (outstanding) {
        throw new AppError(400, 'Cannot archive customer with outstanding opening receivables.');
      }

      const update = {
        status: 'Archived',
        archivedAt: new Date(),
        archivedBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'customers').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Archived customer',
        entityType: 'customer',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Archived customer ${existing.name} (${id})`,
      }, session);

      return {success: true};
    });
  } finally {
    await session.endSession();
  }
}

export async function restoreCustomer(identity: Identity, id: string) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'customers').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Customer not found.');

      if (existing.status === 'Active') return {success: true, message: 'Already active.'};

      const update = {
        status: 'Active',
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'customers').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update, $unset: {archivedAt: '', archivedBy: ''}},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Restored customer',
        entityType: 'customer',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Restored customer ${existing.name} (${id})`,
      }, session);

      return {success: true};
    });
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// 3. Suppliers
// ---------------------------------------------------------------------------

export async function listSuppliers(identity: Identity, query: PaginationQuery) {
  const db = await database();
  const page = Math.max(1, query.page);
  const limit = Math.min(100, Math.max(1, query.limit));
  const skip = (page - 1) * limit;

  const filter: Record<string, any> = {tenantId: identity.tenantId};
  if (query.status && query.status !== 'All') {
    filter.status = query.status;
  } else if (!query.status) {
    filter.status = 'Active';
  }

  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      {name: {$regex: escaped, $options: 'i'}},
      {phone: {$regex: escaped, $options: 'i'}},
      {email: {$regex: escaped, $options: 'i'}},
      {gst: {$regex: escaped, $options: 'i'}},
    ];
  }

  const [records, total] = await Promise.all([
    col(db, 'suppliers')
      .find(filter)
      .sort({createdAt: -1})
      .skip(skip)
      .limit(limit)
      .toArray(),
    col(db, 'suppliers').countDocuments(filter),
  ]);

  return {records, total, page, limit, totalPages: Math.ceil(total / limit)};
}

export async function getSupplierById(identity: Identity, id: string) {
  const db = await database();
  const supplier = await col(db, 'suppliers').findOne({_id: id, tenantId: identity.tenantId});
  if (!supplier) throw new AppError(404, 'Supplier not found.');
  return supplier;
}

export async function createSupplier(identity: Identity, input: SupplierInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');

      const normGst = input.gst ? normalizeGstin(input.gst) : '';
      const normPhone = input.phone ? normalizePhone(input.phone) : '';

      if (normGst) {
        const existingGst = await col(db, 'suppliers').findOne({
          tenantId: identity.tenantId,
          gstNormalized: normGst,
          status: 'Active',
        }, {session});
        if (existingGst) {
          throw new AppError(400, 'A supplier with this GSTIN already exists.');
        }
      }

      let warning: string | undefined;
      if (normPhone) {
        const existingPhone = await col(db, 'suppliers').findOne({
          tenantId: identity.tenantId,
          phoneNormalized: normPhone,
          status: 'Active',
        }, {session});
        if (existingPhone) {
          warning = `Phone number ${input.phone} is already used by supplier "${existingPhone.name}".`;
        }
      }

      const id = uid('SUP');
      const record = {
        _id: id,
        tenantId: identity.tenantId,
        name: input.name,
        phone: input.phone || '',
        phoneNormalized: normPhone,
        email: input.email || '',
        address: input.address || '',
        gst: input.gst || '',
        gstNormalized: normGst,
        terms: input.terms,
        status: 'Active',
        createdAt: new Date(),
        createdBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'suppliers').insertOne(record, {session});

      await recordAudit(db, {
        identity,
        action: 'Created supplier',
        entityType: 'supplier',
        entityId: id,
        after: record,
        detail: `Added supplier ${record.name} (${id})`,
      }, session);

      return {...record, warning};
    });
  } finally {
    await session.endSession();
  }
}

export async function updateSupplier(identity: Identity, id: string, input: SupplierInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'suppliers').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Supplier not found.');

      if (existing.status === 'Archived') {
        throw new AppError(400, 'Cannot update an archived supplier. Restore the record first.');
      }

      const normGst = input.gst ? normalizeGstin(input.gst) : '';
      const normPhone = input.phone ? normalizePhone(input.phone) : '';

      if (normGst) {
        const conflict = await col(db, 'suppliers').findOne({
          tenantId: identity.tenantId,
          gstNormalized: normGst,
          _id: {$ne: id},
          status: 'Active',
        }, {session});
        if (conflict) {
          throw new AppError(400, 'A supplier with this GSTIN already exists.');
        }
      }

      let warning: string | undefined;
      if (normPhone) {
        const existingPhone = await col(db, 'suppliers').findOne({
          tenantId: identity.tenantId,
          phoneNormalized: normPhone,
          _id: {$ne: id},
          status: 'Active',
        }, {session});
        if (existingPhone) {
          warning = `Phone number ${input.phone} is already used by supplier "${existingPhone.name}".`;
        }
      }

      const update = {
        name: input.name,
        phone: input.phone || '',
        phoneNormalized: normPhone,
        email: input.email || '',
        address: input.address || '',
        gst: input.gst || '',
        gstNormalized: normGst,
        terms: input.terms,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'suppliers').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Updated supplier',
        entityType: 'supplier',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Updated details for supplier ${input.name} (${id})`,
      }, session);

      return {...existing, ...update, warning};
    });
  } finally {
    await session.endSession();
  }
}

export async function archiveSupplier(identity: Identity, id: string) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'suppliers').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Supplier not found.');

      if (existing.status === 'Archived') return {success: true, message: 'Already archived.'};

      const outstanding = await col(db, 'openingPayables').findOne({
        tenantId: identity.tenantId,
        supplierId: id,
        remainingAmountPaise: {$gt: 0},
      }, {session});
      if (outstanding) {
        throw new AppError(400, 'Cannot archive supplier with outstanding opening payables.');
      }

      const update = {
        status: 'Archived',
        archivedAt: new Date(),
        archivedBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'suppliers').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Archived supplier',
        entityType: 'supplier',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Archived supplier ${existing.name} (${id})`,
      }, session);

      return {success: true};
    });
  } finally {
    await session.endSession();
  }
}

export async function restoreSupplier(identity: Identity, id: string) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'suppliers').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Supplier not found.');

      if (existing.status === 'Active') return {success: true, message: 'Already active.'};

      const update = {
        status: 'Active',
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'suppliers').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update, $unset: {archivedAt: '', archivedBy: ''}},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Restored supplier',
        entityType: 'supplier',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Restored supplier ${existing.name} (${id})`,
      }, session);

      return {success: true};
    });
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// 4. Products & Stock Adjustments
// ---------------------------------------------------------------------------

export async function listProducts(identity: Identity, query: PaginationQuery) {
  const db = await database();
  const page = Math.max(1, query.page);
  const limit = Math.min(100, Math.max(1, query.limit));
  const skip = (page - 1) * limit;

  const filter: Record<string, any> = {tenantId: identity.tenantId};
  if (query.status && query.status !== 'All') {
    filter.status = query.status;
  } else if (!query.status) {
    filter.status = 'Active';
  }

  if (query.category && query.category !== 'All') {
    filter.category = query.category;
  }

  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      {name: {$regex: escaped, $options: 'i'}},
      {brand: {$regex: escaped, $options: 'i'}},
      {model: {$regex: escaped, $options: 'i'}},
      {hsn: {$regex: escaped, $options: 'i'}},
    ];
  }

  const [rawProducts, total] = await Promise.all([
    col(db, 'products')
      .find(filter)
      .sort({createdAt: -1})
      .skip(skip)
      .limit(limit)
      .toArray(),
    col(db, 'products').countDocuments(filter),
  ]);

  // Products are catalogue records. Billing quantities do not represent or mutate stock.
  const records = rawProducts.map((p) => ({...p, stock: 0, serials: []}));

  return {records, total, page, limit, totalPages: Math.ceil(total / limit)};
}

export async function getProductById(identity: Identity, id: string) {
  const db = await database();
  const product = await col(db, 'products').findOne({_id: id, tenantId: identity.tenantId});
  if (!product) throw new AppError(404, 'Product not found.');

  return {...product, stock: 0, serials: [], movements: [], lots: []};
}

export async function createProduct(identity: Identity, input: ProductInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');

      if (input.preferredSupplierId) {
        const supp = await col(db, 'suppliers').findOne(
          {_id: input.preferredSupplierId, tenantId: identity.tenantId, status: 'Active'},
          {session}
        );
        if (!supp) throw new AppError(404, 'Supplier not found.');
      }

      const id = uid('PRD');
      const isSerialTracked =
        input.isSerialTracked !== undefined
          ? input.isSerialTracked
          : SERIALIZED_CATEGORIES.includes(input.category);

      const record = {
        _id: id,
        tenantId: identity.tenantId,
        name: input.name,
        description: input.description,
        unit: input.unit,
        category: input.category,
        brand: input.brand,
        condition: input.condition,
        model: input.model || '',
        hsn: input.hsn.trim(),
        costPaise: input.costPaise,
        sellingPricePaise: input.sellingPricePaise,
        priceEntryMode: input.priceEntryMode,
        taxBasisPoints: input.taxBasisPoints,
        low: input.low,
        warranty: input.warranty,
        preferredSupplierId: input.preferredSupplierId || undefined,
        isSerialTracked,
        status: 'Active',
        createdAt: new Date(),
        createdBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'products').insertOne(record, {session});

      await recordAudit(db, {
        identity,
        action: 'Created product',
        entityType: 'product',
        entityId: id,
        after: record,
        detail: `Added product ${record.name} (${id})`,
      }, session);

      return {...record, stock: 0, serials: []};
    });
  } finally {
    await session.endSession();
  }
}

export async function updateProduct(identity: Identity, id: string, input: ProductInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'products').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Product not found.');

      if (existing.status === 'Archived') {
        throw new AppError(400, 'Cannot update an archived product. Restore the record first.');
      }

      if (input.preferredSupplierId) {
        const supp = await col(db, 'suppliers').findOne(
          {_id: input.preferredSupplierId, tenantId: identity.tenantId, status: 'Active'},
          {session}
        );
        if (!supp) throw new AppError(404, 'Supplier not found.');
      }

      const targetTracking =
        input.isSerialTracked !== undefined
          ? input.isSerialTracked
          : existing.isSerialTracked;

      if (targetTracking !== existing.isSerialTracked) {
        const hasStockHistory = await col(db, 'stockLots').countDocuments({
          tenantId: identity.tenantId,
          productId: id,
        }, {session});
        if (hasStockHistory > 0) {
          throw new AppError(400, 'Cannot change serial tracking mode for a product with existing stock history.');
        }
      }

      const update = {
        name: input.name,
        description: input.description,
        unit: input.unit,
        category: input.category,
        brand: input.brand,
        condition: input.condition,
        model: input.model || '',
        hsn: input.hsn.trim(),
        costPaise: input.costPaise,
        sellingPricePaise: input.sellingPricePaise,
        priceEntryMode: input.priceEntryMode,
        taxBasisPoints: input.taxBasisPoints,
        low: input.low,
        warranty: input.warranty,
        preferredSupplierId: input.preferredSupplierId || undefined,
        isSerialTracked: targetTracking,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'products').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Updated product',
        entityType: 'product',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Updated product ${input.name} (${id})`,
      }, session);

      return {...existing, ...update};
    });
  } finally {
    await session.endSession();
  }
}

export async function archiveProduct(identity: Identity, id: string) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'products').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Product not found.');

      if (existing.status === 'Archived') return {success: true, message: 'Already archived.'};

      const lotsWithStock = await col(db, 'stockLots').findOne({
        tenantId: identity.tenantId,
        productId: id,
        quantityRemaining: {$gt: 0},
      }, {session});

      if (lotsWithStock) {
        throw new AppError(400, 'Cannot archive product with active stock remaining.');
      }

      const update = {
        status: 'Archived',
        archivedAt: new Date(),
        archivedBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'products').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Archived product',
        entityType: 'product',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Archived product ${existing.name} (${id})`,
      }, session);

      return {success: true};
    });
  } finally {
    await session.endSession();
  }
}

export async function restoreProduct(identity: Identity, id: string) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'products').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Product not found.');

      if (existing.status === 'Active') return {success: true, message: 'Already active.'};

      const update = {
        status: 'Active',
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'products').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update, $unset: {archivedAt: '', archivedBy: ''}},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Restored product',
        entityType: 'product',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Restored product ${existing.name} (${id})`,
      }, session);

      return {success: true};
    });
  } finally {
    await session.endSession();
  }
}

export async function adjustProductStock(identity: Identity, id: string, input: StockAdjustmentInput) {
  input = StockAdjustmentInputSchema.parse(input);
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');

      const setup = await col(db, 'openingSetups').findOne({tenantId: identity.tenantId}, {session});
      if (setup && setup.status !== 'Finalized') {
        throw new AppError(400, 'Cannot perform manual stock adjustments before opening setup is finalized.');
      }
      await lockBusinessDay(db, session, identity.tenantId);

      if (input.idempotencyKey) {
        const existing = await col(db, 'stockMovements').findOne({
          tenantId: identity.tenantId,
          idempotencyKey: input.idempotencyKey,
        }, {session});
        if (existing) {
          const requestedSerials = [...(input.serials || [])].map(canonicalSerialKey).sort();
          const existingSerials = [...(existing.serials || [])].map(canonicalSerialKey).sort();
          const sameRequest = existing.productId === id && existing.qty === input.delta && existing.reason === input.reason &&
            JSON.stringify(existingSerials) === JSON.stringify(requestedSerials);
          if (!sameRequest) {
            throw new AppError(409, 'This idempotency key was already used for a different stock adjustment.');
          }
          return {
            success: true,
            idempotent: true,
            message: 'Stock adjustment already processed.',
            movementId: existing._id,
            delta: existing.qty,
          };
        }
      }

      const product = await col(db, 'products').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!product) throw new AppError(404, 'Product not found.');

      if (product.status === 'Archived') {
        throw new AppError(400, 'Cannot adjust stock for an archived product.');
      }

      if (!product.isSerialTracked && input.serials.length)
        throw new AppError(400, 'This product does not accept serial numbers.');
      const businessDate = todayInKolkata();
      if (setup && (!setup.cutoffDate || businessDate <= setup.cutoffDate))
        throw new AppError(409, 'Stock adjustments must be dated after the finalized opening cutoff.');
      const moveId = uid('MOV');

      if (input.delta > 0) {
        if (product.isSerialTracked) {
          if (!input.serials || input.serials.length !== input.delta) {
            throw new AppError(400, `Provide exactly ${input.delta} unique serial number(s) for this adjustment.`);
          }
          const uniqueSet = new Set(input.serials.map(normalizeSerial));
          if (uniqueSet.size !== input.serials.length) {
            throw new AppError(400, 'Serial numbers must be unique within adjustment.');
          }
        }

        const lotId = uid('LOT');
        await col(db, 'stockLots').insertOne(
          {
            _id: lotId,
            tenantId: identity.tenantId,
            productId: id,
            lotType: 'Adjustment',
            receivedDate: businessDate,
            quantityReceived: input.delta,
            quantityRemaining: input.delta,
            quantitySellable: input.delta,
            quantityReserved: 0,
            quantityDefective: 0,
            quantitySold: 0,
            quantityReturned: 0,
            quantityRemoved: 0,
            costPaise: product.costPaise,
            sourceReference: input.reason,
            createdAt: new Date(),
          },
          {session}
        );

        if (product.isSerialTracked && input.serials) {
          const canonicalMap = await assertSerialsAvailableForCreation(
            db,
            session,
            identity.tenantId,
            input.serials
          );
          const serialDocs = input.serials.map((s: string) => ({
            _id: uid('SER'),
            tenantId: identity.tenantId,
            productId: id,
            lotId,
            serialOriginal: s.trim(),
            serialNormalized: canonicalMap.get(s) || canonicalSerialKey(s),
            status: 'InStock',
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          }));
          await col(db, 'serialUnits').insertMany(serialDocs, {session});
        }

        await col(db, 'stockMovements').insertOne(
          {
            _id: moveId,
            tenantId: identity.tenantId,
            date: businessDate,
            productId: id,
            lotId,
            qty: input.delta,
            onHandDelta: input.delta,
            sellableDelta: input.delta,
            defectiveDelta: 0,
            reason: input.reason,
            reference: 'Manual adjustment',
            idempotencyKey: input.idempotencyKey || undefined,
            serials: input.serials || [],
            createdAt: new Date(),
            createdBy: identity.userId,
          },
          {session}
        );
      } else {
        const lotAllocations = await removeAvailableStock(db, session, {
          tenantId: identity.tenantId, productId: id, quantity: Math.abs(input.delta),
          isSerialTracked: !!product.isSerialTracked, serials: input.serials,
        });

        await col(db, 'stockMovements').insertOne(
          {
            _id: moveId,
            tenantId: identity.tenantId,
            date: businessDate,
            productId: id,
            qty: input.delta,
            onHandDelta: input.delta,
            sellableDelta: input.delta,
            defectiveDelta: 0,
            removedDelta: -input.delta,
            lotId: lotAllocations.length === 1 ? lotAllocations[0].lotId : undefined,
            lotAllocations,
            operation: 'PhysicalRemoval',

            reason: input.reason,
            reference: 'Manual adjustment',
            idempotencyKey: input.idempotencyKey || undefined,
            serials: input.serials || [],
            createdAt: new Date(),
            createdBy: identity.userId,
          },
          {session}
        );
      }

      await recordAudit(db, {
        identity,
        action: 'Adjusted product stock',
        entityType: 'product',
        entityId: id,
        after: {productId: id, delta: input.delta, reason: input.reason, serials: input.serials},
        detail: `Stock adjustment of ${input.delta > 0 ? '+' : ''}${input.delta} on product ${product.name} (${id})`,
      }, session);

      return {success: true, movementId: moveId, delta: input.delta};
    });
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// 5. Service Catalogue
// ---------------------------------------------------------------------------

export async function listServices(identity: Identity, query?: PaginationQuery) {
  const db = await database();
  const filter: any = {tenantId: identity.tenantId};
  if (query?.status === 'Active') filter.status = 'Active';
  else if (query?.status === 'Archived') filter.status = 'Archived';

  if (query?.q) {
    const qRegex = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{name: qRegex}, {category: qRegex}, {description: qRegex}, {sac: qRegex}];
  }

  const limit = query?.limit || 50;
  const page = query?.page || 1;
  const skip = (page - 1) * limit;

  const [records, total] = await Promise.all([
    col(db, 'serviceCatalog')
      .find(filter)
      .sort({name: 1})
      .skip(skip)
      .limit(limit)
      .toArray(),
    col(db, 'serviceCatalog').countDocuments(filter),
  ]);

  return {records, total, page, limit, totalPages: Math.ceil(total / limit) || 1};
}

export async function getServiceById(identity: Identity, id: string) {
  const db = await database();
  const service = await col(db, 'serviceCatalog').findOne({_id: id, tenantId: identity.tenantId});
  if (!service) throw new AppError(404, 'Service not found.');
  return service;
}

export async function createService(identity: Identity, input: ServiceCatalogInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');

      const normName = input.name.trim().toLowerCase();
      const existing = await col(db, 'serviceCatalog').findOne({
        tenantId: identity.tenantId,
        nameNormalized: normName,
        status: 'Active',
      }, {session});

      if (existing) {
        throw new AppError(400, 'A service with this name already exists.');
      }

      const id = uid('SRV');
      const record = {
        _id: id,
        tenantId: identity.tenantId,
        name: input.name,
        nameNormalized: normName,
        category: input.category,
        description: input.description,
        unit: input.unit,
        ratePaise: input.ratePaise,
        taxBasisPoints: input.taxBasisPoints,
        sac: input.sac,
        warranty: input.warranty,
        active: input.active,
        status: 'Active',
        createdAt: new Date(),
        createdBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'serviceCatalog').insertOne(record, {session});

      await recordAudit(db, {
        identity,
        action: 'Created service',
        entityType: 'serviceCatalog',
        entityId: id,
        after: record,
        detail: `Added service ${record.name} (${id})`,
      }, session);

      return record;
    });
  } finally {
    await session.endSession();
  }
}

export async function updateService(identity: Identity, id: string, input: ServiceCatalogInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'serviceCatalog').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Service not found.');

      if (existing.status === 'Archived') {
        throw new AppError(400, 'Cannot update an archived service. Restore the record first.');
      }

      const normName = input.name.trim().toLowerCase();
      const conflict = await col(db, 'serviceCatalog').findOne({
        tenantId: identity.tenantId,
        nameNormalized: normName,
        _id: {$ne: id},
        status: 'Active',
      }, {session});
      if (conflict) {
        throw new AppError(400, 'A service with this name already exists.');
      }

      const update = {
        name: input.name,
        nameNormalized: normName,
        category: input.category,
        description: input.description,
        unit: input.unit,
        ratePaise: input.ratePaise,
        taxBasisPoints: input.taxBasisPoints,
        sac: input.sac,
        warranty: input.warranty,
        active: input.active,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'serviceCatalog').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Updated service',
        entityType: 'serviceCatalog',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Updated service ${input.name} (${id})`,
      }, session);

      return {...existing, ...update};
    });
  } finally {
    await session.endSession();
  }
}

export async function archiveService(identity: Identity, id: string) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'serviceCatalog').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Service not found.');

      if (existing.status === 'Archived') return {success: true, message: 'Already archived.'};

      const update = {
        status: 'Archived',
        active: false,
        archivedAt: new Date(),
        archivedBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'serviceCatalog').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Archived service',
        entityType: 'serviceCatalog',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Archived service ${existing.name} (${id})`,
      }, session);

      return {success: true};
    });
  } finally {
    await session.endSession();
  }
}

export async function restoreService(identity: Identity, id: string) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      const existing = await col(db, 'serviceCatalog').findOne({_id: id, tenantId: identity.tenantId}, {session});
      if (!existing) throw new AppError(404, 'Service not found.');

      if (existing.status === 'Active') return {success: true, message: 'Already active.'};

      const update = {
        status: 'Active',
        active: true,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'serviceCatalog').updateOne(
        {_id: id, tenantId: identity.tenantId},
        {$set: update, $unset: {archivedAt: '', archivedBy: ''}},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Restored service',
        entityType: 'serviceCatalog',
        entityId: id,
        before: existing,
        after: {...existing, ...update},
        detail: `Restored service ${existing.name} (${id})`,
      }, session);

      return {success: true};
    });
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// 6. Invoice Templates with Immutable Revisions
// ---------------------------------------------------------------------------

export async function listTemplates(identity: Identity) {
  const res = await canonicalTemplates.listTemplates(await database(), identity);
  return res.templates;
}

export async function getTemplateById(identity: Identity, id: string) {
  return canonicalTemplates.getTemplateById(await database(), identity, id);
}

export async function createTemplate(identity: Identity, input: InvoiceTemplateInput) {
  return canonicalTemplates.createTemplate(await database(), identity, input);
}

export async function updateTemplate(identity: Identity, id: string, input: InvoiceTemplateInput) {
  return canonicalTemplates.updateTemplate(await database(), identity, id, input);
}

export async function setDefaultTemplate(identity: Identity, id: string) {
  return canonicalTemplates.setDefaultTemplate(await database(), identity, id);
}

export async function archiveTemplate(identity: Identity, id: string) {
  return canonicalTemplates.archiveTemplate(await database(), identity, id);
}

export async function restoreTemplate(identity: Identity, id: string) {
  return canonicalTemplates.restoreTemplate(await database(), identity, id);
}

// ---------------------------------------------------------------------------
// 7. Opening Balances: Draft & Finalization
// ---------------------------------------------------------------------------

export async function getOpeningSetup(identity: Identity) {
  const db = await database();
  const setup = await col(db, 'openingSetups').findOne({tenantId: identity.tenantId});
  if (!setup) {
    return {
      tenantId: identity.tenantId,
      status: 'Draft',
      draftVersion: 0,
      cutoffDate: previousCalendarDate(todayInKolkata()),
      openingCashPaise: 0,
      openingBankPaise: 0,
      draftReceivables: [],
      draftPayables: [],
      draftStockLots: [],
      isFinalized: false,
    };
  }

  const [receivables, payables, lots, serialCount] = await Promise.all([
    col(db, 'openingReceivables').find({tenantId: identity.tenantId}).toArray(),
    col(db, 'openingPayables').find({tenantId: identity.tenantId}).toArray(),
    col(db, 'stockLots').find({tenantId: identity.tenantId, lotType: 'Opening'}).toArray(),
    col(db, 'serialUnits').countDocuments({tenantId: identity.tenantId}),
  ]);

  return {
    ...setup,
    isFinalized: setup.status === 'Finalized',
    postedReceivablesCount: receivables.length,
    postedPayablesCount: payables.length,
    postedLotsCount: lots.length,
    postedSerialsCount: serialCount,
  };
}

export async function saveOpeningDraft(identity: Identity, input: OpeningDraftInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');

      const existing = await col(db, 'openingSetups').findOne({tenantId: identity.tenantId}, {session});
      if (existing?.status === 'Finalized') {
        throw new AppError(400, 'Opening setup has already been finalized and locked. Corrections require audited adjustments.');
      }

      const today = todayInKolkata();
      if (input.cutoffDate >= today) {
        throw new AppError(
          400,
          `Opening cutoff must be earlier than today (${today}). Choose ${previousCalendarDate(today)} or an earlier date so operational posting can begin today.`
        );
      }

      // Validate references within tenant
      for (const r of input.draftReceivables) {
        const cust = await col(db, 'customers').findOne({_id: r.customerId, tenantId: identity.tenantId, status: 'Active'}, {session});
        if (!cust) throw new AppError(404, `Customer with id "${r.customerId}" not found.`);
      }

      for (const p of input.draftPayables) {
        const supp = await col(db, 'suppliers').findOne({_id: p.supplierId, tenantId: identity.tenantId, status: 'Active'}, {session});
        if (!supp) throw new AppError(404, `Supplier with id "${p.supplierId}" not found.`);
      }

      for (const l of input.draftStockLots) {
        const prod = await col(db, 'products').findOne({_id: l.productId, tenantId: identity.tenantId, status: 'Active'}, {session});
        if (!prod) throw new AppError(404, `Product with id "${l.productId}" not found.`);
        if (prod.isSerialTracked) {
          if (l.serials.length !== l.qty) {
            throw new AppError(400, `Product "${prod.name}" requires exactly ${l.qty} serial number(s).`);
          }
          const uniqueSet = new Set(l.serials.map(normalizeSerial));
          if (uniqueSet.size !== l.serials.length) {
            throw new AppError(400, `Duplicate serial numbers found for product "${prod.name}".`);
          }
        }
      }

      const nextVersion = (existing?.draftVersion || 0) + 1;

      const draftRecord = {
        tenantId: identity.tenantId,
        status: 'Draft',
        draftVersion: nextVersion,
        cutoffDate: input.cutoffDate,
        openingCashPaise: input.openingCashPaise,
        openingBankPaise: input.openingBankPaise,
        draftReceivables: input.draftReceivables,
        draftPayables: input.draftPayables,
        draftStockLots: input.draftStockLots,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'openingSetups').updateOne(
        {tenantId: identity.tenantId},
        {$set: draftRecord, $setOnInsert: {createdAt: new Date()}},
        {upsert: true, session}
      );

      await recordAudit(db, {
        identity,
        action: 'Saved opening setup draft',
        entityType: 'openingSetup',
        entityId: identity.tenantId,
        after: draftRecord,
        detail: `Saved opening draft v${nextVersion} (cutoff: ${input.cutoffDate})`,
      }, session);

      return {...draftRecord, success: true};
    });
  } finally {
    await session.endSession();
  }
}

export async function finalizeOpeningSetup(identity: Identity, options?: FinalizeOpeningOptions) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');

      const draft = await col(db, 'openingSetups').findOne({tenantId: identity.tenantId}, {session});
      if (!draft) {
        throw new AppError(400, 'No opening setup draft found. Please save a draft first before finalization.');
      }
      if (draft.status === 'Finalized') {
        throw new AppError(400, 'Opening setup is already finalized and locked.');
      }
      if (draft.status !== 'Draft') {
        throw new AppError(400, 'Only a Draft opening setup can be finalized.');
      }

      if (options?.expectedDraftVersion !== undefined && draft.draftVersion !== options.expectedDraftVersion) {
        throw new AppError(409, 'Opening draft has been updated by another session. Please refresh and review before finalizing.');
      }


      const today = todayInKolkata();
      if (!draft.cutoffDate || draft.cutoffDate >= today) {
        throw new AppError(
          400,
          `Opening cutoff must be earlier than today (${today}). Return to Opening setup and choose ${previousCalendarDate(today)} or an earlier date.`
        );
      }

      // Check if any live stock movements or financial activity exists outside of opening setup
      const existingMovements = await col(db, 'stockMovements').countDocuments({
        tenantId: identity.tenantId,
        reference: {$ne: 'OPENING-SETUP'},
      }, {session});
      if (existingMovements > 0) {
        throw new AppError(400, 'Cannot finalize opening setup because live stock activity has already been recorded.');
      }

      const existingLedger = await col(db, 'accountMovements').countDocuments({
        tenantId: identity.tenantId,
        reference: {$ne: 'OPENING-SETUP'},
      }, {session});
      if (existingLedger > 0) {
        throw new AppError(400, 'Cannot finalize opening setup because live financial ledger activity has already been recorded.');
      }

      // 1. Post Opening Receivables
      const receivables = draft.draftReceivables || [];
      if (receivables.length > 0) {
        const recDocs = [];
        for (const r of receivables) {
          const cust = await col(db, 'customers').findOne({_id: r.customerId, tenantId: identity.tenantId, status: 'Active'}, {session});
          if (!cust) throw new AppError(404, `Customer with id "${r.customerId}" not found.`);

          recDocs.push({
            _id: uid('OPR'),
            tenantId: identity.tenantId,
            customerId: r.customerId,
            reference: r.reference || 'Opening invoice',
            date: r.date || draft.cutoffDate,
            amountPaise: r.amountPaise,
            originalAmountPaise: r.amountPaise,
            remainingAmountPaise: r.amountPaise,
            status: 'Open',
            notes: r.notes || '',
            createdAt: new Date(),
            createdBy: identity.userId,
          });
        }
        await col(db, 'openingReceivables').insertMany(recDocs, {session});
      }

      // 2. Post Opening Payables
      const payables = draft.draftPayables || [];
      if (payables.length > 0) {
        const payDocs = [];
        for (const p of payables) {
          const supp = await col(db, 'suppliers').findOne({_id: p.supplierId, tenantId: identity.tenantId, status: 'Active'}, {session});
          if (!supp) throw new AppError(404, `Supplier with id "${p.supplierId}" not found.`);

          payDocs.push({
            _id: uid('OPP'),
            tenantId: identity.tenantId,
            supplierId: p.supplierId,
            reference: p.reference || 'Opening purchase',
            date: p.date || draft.cutoffDate,
            amountPaise: p.amountPaise,
            originalAmountPaise: p.amountPaise,
            remainingAmountPaise: p.amountPaise,
            status: 'Open',
            notes: p.notes || '',
            createdAt: new Date(),
            createdBy: identity.userId,
          });
        }
        await col(db, 'openingPayables').insertMany(payDocs, {session});
      }

      // 3. Post Opening Stock Lots, Serial Units, and Stock Movements
      const stockLots = draft.draftStockLots || [];
      await assertSerialsAvailableForCreation(db, session, identity.tenantId,
        stockLots.flatMap((lot: any) => lot.serials || []));
      let totalSerialsCreated = 0;
      for (const lot of stockLots) {
        const prod = await col(db, 'products').findOne({_id: lot.productId, tenantId: identity.tenantId, status: 'Active'}, {session});
        if (!prod) throw new AppError(404, `Product with id "${lot.productId}" not found.`);

        if (prod.isSerialTracked) {
          if (!lot.serials || lot.serials.length !== lot.qty) {
            throw new AppError(400, `Product "${prod.name}" requires exactly ${lot.qty} serial number(s).`);
          }
          const uniqueSet = new Set(lot.serials.map(normalizeSerial));
          if (uniqueSet.size !== lot.serials.length) {
            throw new AppError(400, `Duplicate serial numbers found for product "${prod.name}".`);
          }
        }

        if (!prod.isSerialTracked && lot.serials?.length)
          throw new AppError(400, `Product "${prod.name}" does not accept serial numbers.`);
        const lotId = uid('LOT');
        const lotDoc = {
          _id: lotId,
          tenantId: identity.tenantId,
          productId: lot.productId,
          lotType: 'Opening',
          receivedDate: lot.receivedDate || draft.cutoffDate,
          quantityReceived: lot.qty,
          quantityRemaining: lot.qty,
          quantitySellable: lot.qty,
          quantityReserved: 0,
          quantityDefective: 0,
          quantitySold: 0,
          quantityReturned: 0,
          quantityRemoved: 0,
          costPaise: lot.costPaise ?? prod.costPaise,
          sourceReference: 'OPENING-SETUP',
          createdAt: new Date(),
        };
        await col(db, 'stockLots').insertOne(lotDoc, {session});

        await col(db, 'stockMovements').insertOne(
          {
            _id: uid('MOV'),
            tenantId: identity.tenantId,
            date: draft.cutoffDate,
            productId: lot.productId,
            lotId,
            qty: lot.qty,
            onHandDelta: lot.qty,
            sellableDelta: lot.qty,
            defectiveDelta: 0,
            reason: 'Opening stock',
            reference: 'OPENING-SETUP',
            serials: lot.serials || [],
            createdAt: new Date(),
            createdBy: identity.userId,
          },
          {session}
        );

        if (prod.isSerialTracked && lot.serials && lot.serials.length > 0) {
          const serialDocs = lot.serials.map((s: string) => ({
            _id: uid('SER'),
            tenantId: identity.tenantId,
            productId: lot.productId,
            lotId,
            serialOriginal: s.trim(),
            serialNormalized: canonicalSerialKey(s),
            status: 'InStock',
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          }));
          await col(db, 'serialUnits').insertMany(serialDocs, {session});
          totalSerialsCreated += serialDocs.length;
        }
      }

      // 4. Post Opening Cash and Bank Ledger Entries to accountMovements
      if (draft.openingCashPaise > 0) {
        await col(db, 'accountMovements').insertOne(
          {
            _id: uid('ACC'),
            tenantId: identity.tenantId,
            account: 'Cash',
            direction: 'In',
            amountPaise: draft.openingCashPaise,
            date: draft.cutoffDate,
            reason: 'Opening cash balance',
            reference: 'OPENING-SETUP',
            createdAt: new Date(),
            createdBy: identity.userId,
          },
          {session}
        );
      }

      if (draft.openingBankPaise > 0) {
        await col(db, 'accountMovements').insertOne(
          {
            _id: uid('ACC'),
            tenantId: identity.tenantId,
            account: 'Bank',
            direction: 'In',
            amountPaise: draft.openingBankPaise,
            date: draft.cutoffDate,
            reason: 'Opening bank balance',
            reference: 'OPENING-SETUP',
            createdAt: new Date(),
            createdBy: identity.userId,
          },
          {session}
        );
      }

      // 5. Mark setup as Finalized and permanent lock
      const finalizedRecord = {
        tenantId: identity.tenantId,
        status: 'Finalized',
        cutoffDate: draft.cutoffDate,
        openingCashPaise: draft.openingCashPaise,
        openingBankPaise: draft.openingBankPaise,
        draftReceivables: draft.draftReceivables,
        draftPayables: draft.draftPayables,
        draftStockLots: draft.draftStockLots,
        finalizedAt: new Date(),
        finalizedBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'openingSetups').updateOne(
        {tenantId: identity.tenantId},
        {$set: finalizedRecord},
        {session}
      );

      await initializeAccountBalances(db, identity.tenantId, session);

      // 6. Record Transactional Audit
      await recordAudit(db, {
        identity,
        action: 'Finalized opening setup',
        entityType: 'openingSetup',
        entityId: identity.tenantId,
        after: finalizedRecord,
        detail: `Finalized opening setup as of cutoff ${draft.cutoffDate}. Posted ${receivables.length} receivables, ${payables.length} payables, ${stockLots.length} stock lots, ${totalSerialsCreated} serial units, cash ${draft.openingCashPaise / 100} and bank ${draft.openingBankPaise / 100}.`,
      }, session);

      return {
        success: true,
        status: 'Finalized',
        message: 'Opening setup successfully finalized and locked.',
        cutoffDate: draft.cutoffDate,
        receivablesPosted: receivables.length,
        payablesPosted: payables.length,
        lotsPosted: stockLots.length,
        serialsPosted: totalSerialsCreated,
      };
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Repairs the onboarding mistake where a newly finalized company used today as
 * its opening cutoff. The correction can only move a today/future cutoff
 * backwards and refuses to run after operational activity exists.
 */
export async function correctFinalizedOpeningCutoff(identity: Identity, input: CorrectOpeningCutoffInput) {
  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB || 'billing_dev');
      await lockBusinessDay(db, session, identity.tenantId, {internalAllowClosed: true});

      const setup = await col(db, 'openingSetups').findOne({tenantId: identity.tenantId}, {session});
      if (!setup || setup.status !== 'Finalized') {
        throw new AppError(400, 'Only a finalized opening setup can use this correction.');
      }
      if (setup.cutoffDate !== input.expectedCutoffDate) {
        throw new AppError(409, 'Opening setup changed. Reload the page before correcting the cutoff.');
      }

      const today = todayInKolkata();
      if (setup.cutoffDate < today) {
        throw new AppError(400, 'The opening cutoff is already earlier than today and does not need correction.');
      }
      if (input.newCutoffDate >= today || input.newCutoffDate >= setup.cutoffDate) {
        throw new AppError(400, `Corrected cutoff must be earlier than today (${today}) and earlier than the current cutoff.`);
      }

      const operationalChecks: Array<{collection: string; filter: Record<string, unknown>; label: string}> = [
        {collection: 'stockMovements', filter: {reference: {$ne: 'OPENING-SETUP'}}, label: 'stock movement'},
        {collection: 'accountMovements', filter: {reference: {$ne: 'OPENING-SETUP'}}, label: 'cash or bank movement'},
        {collection: 'invoices', filter: {status: 'Issued'}, label: 'issued invoice'},
        {collection: 'purchases', filter: {billStatus: {$in: ['Posted', 'Credited', 'FullyCredited']}}, label: 'posted supplier bill'},
        {collection: 'purchaseReceipts', filter: {}, label: 'stock receipt'},
        {collection: 'customerReceipts', filter: {}, label: 'customer receipt'},
        {collection: 'supplierPayments', filter: {}, label: 'supplier payment'},
        {collection: 'customerReturns', filter: {}, label: 'customer return'},
        {collection: 'supplierReturns', filter: {}, label: 'supplier return'},
        {collection: 'serviceJobs', filter: {}, label: 'service job'},
        {collection: 'stockReservations', filter: {}, label: 'stock hold'},
        {collection: 'dailyClosings', filter: {}, label: 'daily closing'},
      ];

      for (const check of operationalChecks) {
        const count = await col(db, check.collection).countDocuments(
          {tenantId: identity.tenantId, ...check.filter},
          {session, limit: 1}
        );
        if (count > 0) {
          throw new AppError(
            409,
            `Opening cutoff cannot be corrected because a ${check.label} already exists. Use an audited current-day adjustment instead.`
          );
        }
      }

      const moveToCutoff = (value: unknown) =>
        typeof value === 'string' && value > input.newCutoffDate ? input.newCutoffDate : value;
      const draftReceivables = (setup.draftReceivables || []).map((row: any) => ({...row, date: moveToCutoff(row.date)}));
      const draftPayables = (setup.draftPayables || []).map((row: any) => ({...row, date: moveToCutoff(row.date)}));
      const draftStockLots = (setup.draftStockLots || []).map((row: any) => ({
        ...row,
        receivedDate: moveToCutoff(row.receivedDate),
      }));
      const now = new Date();

      await col(db, 'openingSetups').updateOne(
        {_id: setup._id, tenantId: identity.tenantId, cutoffDate: input.expectedCutoffDate},
        {$set: {
          cutoffDate: input.newCutoffDate,
          draftReceivables,
          draftPayables,
          draftStockLots,
          correctedAt: now,
          correctedBy: identity.userId,
          updatedAt: now,
          updatedBy: identity.userId,
        }},
        {session}
      );
      await col(db, 'openingReceivables').updateMany(
        {tenantId: identity.tenantId, date: {$gt: input.newCutoffDate}},
        {$set: {date: input.newCutoffDate}},
        {session}
      );
      await col(db, 'openingPayables').updateMany(
        {tenantId: identity.tenantId, date: {$gt: input.newCutoffDate}},
        {$set: {date: input.newCutoffDate}},
        {session}
      );
      await col(db, 'stockLots').updateMany(
        {tenantId: identity.tenantId, lotType: 'Opening', receivedDate: {$gt: input.newCutoffDate}},
        {$set: {receivedDate: input.newCutoffDate}},
        {session}
      );
      await col(db, 'stockMovements').updateMany(
        {tenantId: identity.tenantId, reference: 'OPENING-SETUP'},
        {$set: {date: input.newCutoffDate}},
        {session}
      );
      await col(db, 'accountMovements').updateMany(
        {tenantId: identity.tenantId, reference: 'OPENING-SETUP'},
        {$set: {date: input.newCutoffDate}},
        {session}
      );

      await recordAudit(db, {
        identity,
        action: 'Corrected opening cutoff',
        entityType: 'openingSetup',
        entityId: identity.tenantId,
        before: {cutoffDate: setup.cutoffDate},
        after: {cutoffDate: input.newCutoffDate},
        detail: `Corrected the onboarding cutoff from ${setup.cutoffDate} to ${input.newCutoffDate} before any operational activity was recorded.`,
      }, session);

      return {
        success: true,
        cutoffDate: input.newCutoffDate,
        message: `Opening cutoff corrected to ${input.newCutoffDate}. Operational posting can begin today.`,
      };
    });
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// 8. Demo Master Data Import (Fresh Company Only)
// ---------------------------------------------------------------------------

export async function importDemoMasterData(identity: Identity, options?: { cutoffDate?: string }) {
  const db = await database();

  // Strict freshness check across all master data collections (read-only pre-flight)
  const [custCount, suppCount, prodCount, srvCount, lotCount, setupExists] = await Promise.all([
    col(db, 'customers').countDocuments({tenantId: identity.tenantId}),
    col(db, 'suppliers').countDocuments({tenantId: identity.tenantId}),
    col(db, 'products').countDocuments({tenantId: identity.tenantId}),
    col(db, 'serviceCatalog').countDocuments({tenantId: identity.tenantId}),
    col(db, 'stockLots').countDocuments({tenantId: identity.tenantId}),
    col(db, 'openingSetups').findOne({tenantId: identity.tenantId}),
  ]);

  if (custCount > 0 || suppCount > 0 || prodCount > 0 || srvCount > 0 || lotCount > 0 || setupExists) {
    throw new AppError(
      400,
      'Demo master data import is only permitted on a fresh company with no existing master records or opening setup.'
    );
  }

  const client = await mongo();
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {

      const cutoff = options?.cutoffDate || previousCalendarDate(todayInKolkata());

      // Flag demo import on settings without wiping user's company name/details
      await col(db, 'companySettings').updateOne(
        {tenantId: identity.tenantId},
        {$set: {demoImported: true, updatedAt: new Date(), updatedBy: identity.userId}},
        {upsert: true, session}
      );

      // 1. Import Sample Suppliers
      const sup1 = uid('SUP'), sup2 = uid('SUP');
      await col(db, 'suppliers').insertMany([
        {
          _id: sup1,
          tenantId: identity.tenantId,
          name: 'Paper Plus Distributors',
          phone: '+91 44 2841 2300',
          phoneNormalized: normalizePhone('+91 44 2841 2300'),
          email: 'orders@paperplus.example',
          address: 'Mount Road, Chennai',
          gst: '33DEMOS1234A1Z1',
          gstNormalized: normalizeGstin('33DEMOS1234A1Z1'),
          terms: 30,
          status: 'Active',
          createdAt: new Date(),
          createdBy: identity.userId,
          updatedAt: new Date(),
          updatedBy: identity.userId,
        },
        {
          _id: sup2,
          tenantId: identity.tenantId,
          name: 'Print Media Wholesale',
          phone: '+91 422 230 4567',
          phoneNormalized: normalizePhone('+91 422 230 4567'),
          email: 'sales@printmedia.example',
          address: 'Cross Cut Road, Coimbatore',
          gst: '33DEMOS9012A1Z3',
          gstNormalized: normalizeGstin('33DEMOS9012A1Z3'),
          terms: 15,
          status: 'Active',
          createdAt: new Date(),
          createdBy: identity.userId,
          updatedAt: new Date(),
          updatedBy: identity.userId,
        },
      ], {session});

      // 2. Import Sample Customers
      const cus1 = uid('CUS'), cus2 = uid('CUS');
      await col(db, 'customers').insertMany([
        {
          _id: cus1,
          tenantId: identity.tenantId,
          name: 'Ravi Stationery Mart',
          phone: '+91 98427 12345',
          phoneNormalized: normalizePhone('+91 98427 12345'),
          email: 'accounts@ravistationery.example',
          address: '42 Meyyanur Bypass Road, Salem 636004',
          gst: '33DEMOX1234A1Z5',
          gstNormalized: normalizeGstin('33DEMOX1234A1Z5'),
          type: 'Business',
          creditLimitPaise: 5000000,
          paymentTermsDays: 30,
          notes: 'Regular printing client',
          details: {city: 'Salem', state: 'Tamil Nadu', postalCode: '636004'},
          status: 'Active',
          createdAt: new Date(),
          createdBy: identity.userId,
          updatedAt: new Date(),
          updatedBy: identity.userId,
        },
        {
          _id: cus2,
          tenantId: identity.tenantId,
          name: 'Priya Event Planners',
          phone: '+91 94432 67890',
          phoneNormalized: normalizePhone('+91 94432 67890'),
          email: '',
          address: 'Fairlands, Salem',
          gst: '',
          gstNormalized: '',
          type: 'Individual',
          creditLimitPaise: 0,
          paymentTermsDays: 0,
          notes: '',
          details: {city: 'Salem', state: 'Tamil Nadu'},
          status: 'Active',
          createdAt: new Date(),
          createdBy: identity.userId,
          updatedAt: new Date(),
          updatedBy: identity.userId,
        },
      ], {session});

      // 3. Import Sample Products
      const prd1 = uid('PRD'), prd2 = uid('PRD');
      await col(db, 'products').insertMany([
        {
          _id: prd1,
          tenantId: identity.tenantId,
          name: 'Vinyl Banner Roll 3ft',
          category: 'Banners & vinyl',
          brand: '',
          condition: 'New',
          model: '50m x 3ft',
          hsn: '39219099',
          costPaise: 180000,
          sellingPricePaise: 249900,
          priceEntryMode: 'Inclusive',
          taxBasisPoints: 1800,
          low: 2,
          warranty: 12,
          preferredSupplierId: sup1,
          isSerialTracked: true,
          status: 'Active',
          createdAt: new Date(),
          createdBy: identity.userId,
          updatedAt: new Date(),
          updatedBy: identity.userId,
        },
        {
          _id: prd2,
          tenantId: identity.tenantId,
          name: 'A4 80gsm Paper Ream',
          category: 'Paper & sheets',
          brand: '',
          condition: 'New',
          model: '500 sheets',
          hsn: '48025590',
          costPaise: 24000,
          sellingPricePaise: 35000,
          priceEntryMode: 'Inclusive',
          taxBasisPoints: 1800,
          low: 10,
          warranty: 36,
          preferredSupplierId: sup2,
          isSerialTracked: false,
          status: 'Active',
          createdAt: new Date(),
          createdBy: identity.userId,
          updatedAt: new Date(),
          updatedBy: identity.userId,
        },
      ], {session});

      // 4. Import Sample Services
      await col(db, 'serviceCatalog').insertMany([
        {
          _id: uid('SRV'),
          tenantId: identity.tenantId,
          name: 'Digital Colour Printing & Binding',
          nameNormalized: 'digital colour printing & binding',
          category: 'Digital printing',
          description: 'High-speed digital colour printing and spiral or saddle-stitch binding.',
          ratePaise: 180000,
          taxBasisPoints: 1800,
          sac: '998713',
          warranty: 3,
          active: true,
          status: 'Active',
          createdAt: new Date(),
          createdBy: identity.userId,
          updatedAt: new Date(),
          updatedBy: identity.userId,
        },
        {
          _id: uid('SRV'),
          tenantId: identity.tenantId,
          name: 'Custom Graphic & Brochure Design',
          nameNormalized: 'custom graphic & brochure design',
          category: 'Designing',
          description: 'Creative artwork, brochure layout and prepress file preparation.',
          ratePaise: 50000,
          taxBasisPoints: 1800,
          sac: '998713',
          warranty: 1,
          active: true,
          status: 'Active',
          createdAt: new Date(),
          createdBy: identity.userId,
          updatedAt: new Date(),
          updatedBy: identity.userId,
        },
      ], {session});

      // 5. Import Default Template
      const tplId = uid('TPL');
      await col(db, 'invoiceTemplates').insertOne({
        _id: tplId,
        tenantId: identity.tenantId,
        name: 'Standard GST Tax Invoice',
        nameNormalized: 'standard gst tax invoice',
        title: 'Tax Invoice',
        paper: 'A4',
        orientation: 'portrait',
        fontSize: 11,
        accent: '#6246e5',
        borders: true,
        striped: false,
        logoPosition: 'left',
        fields: {
          logo: true, shopName: true, shopAddress: true, shopGst: true, shopPhone: true, shopEmail: true,
          customerName: true, customerAddress: true, customerPhone: true, customerGst: true, shipping: false,
          number: true, date: true, due: true, reference: true, order: false, delivery: false, dispatch: false, destination: false,
          serials: true, model: true, warranty: true, subtotal: true, taxes: true, grandTotal: true, amountWords: true,
          taxSummary: true, payments: true, bank: true, notes: true, declaration: true, signatures: true, footer: true
        },
        columns: [
          {id: 'index', label: '#', show: true, align: 'center'},
          {id: 'description', label: 'Item & Specifications', show: true, align: 'left'},
          {id: 'hsn', label: 'HSN/SAC', show: true, align: 'center'},
          {id: 'qty', label: 'Qty', show: true, align: 'right'},
          {id: 'rateIncl', label: 'Rate (incl. GST)', show: true, align: 'right'},
          {id: 'amount', label: 'Amount', show: true, align: 'right'}
        ],
        footer: 'This is a computer generated invoice.',
        isDefault: true,
        currentRevision: 1,
        status: 'Active',
        createdAt: new Date(),
        createdBy: identity.userId,
        updatedAt: new Date(),
        updatedBy: identity.userId,
      }, {session});

      await col(db, 'templateRevisions').insertOne({
        _id: `${tplId}_rev_1`,
        templateId: tplId,
        tenantId: identity.tenantId,
        revision: 1,
        snapshot: {name: 'Standard GST Tax Invoice'},
        createdAt: new Date(),
        createdBy: identity.userId,
      }, {session});

      // 6. Finalize Opening Setup for Demo Data
      const serialSample = `DEMO-LOT-${Date.now().toString().slice(-4)}`;

      // Create Opening Setup as DRAFT so the company owner can review and finalize
      const draftRecord = {
        tenantId: identity.tenantId,
        status: 'Draft',
        cutoffDate: cutoff,
        openingCashPaise: 5000000,
        openingBankPaise: 15000000,
        draftReceivables: [
          {
            customerId: cus1,
            reference: 'OLD-INV-2026-08',
            date: cutoff,
            amountPaise: 1500000,
            notes: 'August balance',
          },
        ],
        draftPayables: [
          {
            supplierId: sup1,
            reference: 'SUP-AUG-4421',
            date: cutoff,
            amountPaise: 2500000,
            notes: 'Paper Plus balance',
          },
        ],
        draftStockLots: [
          {
            productId: prd1,
            batchNumber: 'LOT-OPEN-01',
            receivedDate: cutoff,
            quantity: 1,
            unitCostPaise: 180000,
            serials: [serialSample],
          },
        ],
        draftVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        updatedBy: identity.userId,
      };

      await col(db, 'openingSetups').insertOne(draftRecord, {session});

      await recordAudit(db, {
        identity,
        action: 'Imported sample master data',
        entityType: 'openingSetup',
        entityId: identity.tenantId,
        detail: `Imported sample master data and created opening draft with cutoff ${cutoff}`,
      }, session);

      return {
        success: true,
        message: 'Sample master data imported successfully. An opening draft has been created for your review.',
        draft: draftRecord,
      };
    });
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// 9. Bootstrap & Export
// ---------------------------------------------------------------------------

export async function getMasterBootstrap(identity: Identity) {
  const db = await database();

  const [
    companySettings,
    openingSetup,
    customerCount,
    supplierCount,
    productCount,
    serviceCount,
    templateCount,
    firstCustomers,
    firstSuppliers,
    rawFirstProducts,
    services,
    templates,
    recentAudit,
  ] = await Promise.all([
    getCompanySettings(identity),
    getOpeningSetup(identity),
    col(db, 'customers').countDocuments({tenantId: identity.tenantId, status: 'Active'}),
    col(db, 'suppliers').countDocuments({tenantId: identity.tenantId, status: 'Active'}),
    col(db, 'products').countDocuments({tenantId: identity.tenantId, status: 'Active'}),
    col(db, 'serviceCatalog').countDocuments({tenantId: identity.tenantId, status: 'Active'}),
    col(db, 'invoiceTemplates').countDocuments({tenantId: identity.tenantId, status: 'Active'}),
    col(db, 'customers').find({tenantId: identity.tenantId, status: 'Active'}).sort({createdAt: -1}).limit(10).toArray(),
    col(db, 'suppliers').find({tenantId: identity.tenantId, status: 'Active'}).sort({createdAt: -1}).limit(10).toArray(),
    col(db, 'products').find({tenantId: identity.tenantId, status: 'Active'}).sort({createdAt: -1}).limit(10).toArray(),
    col(db, 'serviceCatalog').find({tenantId: identity.tenantId, status: 'Active'}).sort({name: 1}).limit(50).toArray(),
    col(db, 'invoiceTemplates').find({tenantId: identity.tenantId, status: 'Active'}).sort({createdAt: 1}).limit(50).toArray(),
    col(db, 'auditHistory').find({tenantId: identity.tenantId}).sort({timestamp: -1}).limit(10).toArray(),
  ]);

  const pIds = rawFirstProducts.map((p) => p._id);
  const [lots, serials] = await Promise.all([
    col(db, 'stockLots')
      .aggregate([
        {$match: {tenantId: identity.tenantId, productId: {$in: pIds}, quantityRemaining: {$gt: 0}}},
        {$group: {_id: '$productId', totalStock: {$sum: '$quantityRemaining'}}},
      ])
      .toArray(),
    col(db, 'serialUnits')
      .aggregate([
        {$match: {tenantId: identity.tenantId, productId: {$in: pIds}, status: 'InStock'}},
        {$group: {_id: '$productId', serials: {$push: '$serialOriginal'}}},
      ])
      .toArray(),
  ]);

  const stockMap = new Map(lots.map((l) => [l._id, l.totalStock]));
  const serialMap = new Map(serials.map((s) => [s._id, s.serials]));

  const firstProducts = rawFirstProducts.map((p) => ({
    ...p,
    stock: stockMap.get(p._id) || 0,
    serials: serialMap.get(p._id) || [],
  }));

  const defaultTemplate = templates.find((t) => t.isDefault) || templates[0];

  return {
    company: companySettings,
    opening: openingSetup,
    openingStatus: openingSetup,
    counts: {
      customers: customerCount,
      suppliers: supplierCount,
      products: productCount,
      services: serviceCount,
      templates: templateCount,
    },
    firstCustomers,
    firstSuppliers,
    firstProducts,
    services,
    templates,
    defaultTemplateId: defaultTemplate?._id || '',
    recentAudit,
  };
}

export async function exportMasterData(identity: Identity) {
  const db = await database();

  const [settings, customers, suppliers, products, services, templates] = await Promise.all([
    col(db, 'companySettings').findOne({tenantId: identity.tenantId}),
    col(db, 'customers').find({tenantId: identity.tenantId}).sort({name: 1}).toArray(),
    col(db, 'suppliers').find({tenantId: identity.tenantId}).sort({name: 1}).toArray(),
    col(db, 'products').find({tenantId: identity.tenantId}).sort({name: 1}).toArray(),
    col(db, 'serviceCatalog').find({tenantId: identity.tenantId}).sort({name: 1}).toArray(),
    col(db, 'invoiceTemplates').find({tenantId: identity.tenantId}).sort({name: 1}).toArray(),
  ]);

  const sanitize = (record: any) => {
    const {tenantId, _id, ...rest} = record;
    return {id: _id, ...rest};
  };

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    company: settings ? sanitize(settings) : {},
    customers: customers.map(sanitize),
    suppliers: suppliers.map(sanitize),
    products: products.map(sanitize),
    services: services.map(sanitize),
    templates: templates.map(sanitize),
  };
}

export { getMasterBootstrap as bootstrap };
