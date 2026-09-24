import 'server-only';
import {Db} from 'mongodb';
import {AppError} from './db';
import {Identity} from './security';
import {uid} from '../lib/domain';
import {recordAudit} from './audit';
import {col, nextTenantSequence} from './purchase-service';
import {todayInKolkata} from './purchase-schema';
import {
  CreateEnquiryInput,
  CreateEnquirySchema,
  UpdateEnquiryInput,
  UpdateEnquirySchema,
  EnquiryListQueryInput,
  EnquiryListQuerySchema,
} from './enquiry-schema';

export interface EnquiryDocument {
  _id: string;
  tenantId: string;
  enquiryNumber: string;
  customerId: string;
  customerSnapshot: {
    name: string;
    phone?: string;
    email?: string;
  };
  category: string;
  requirement: string;
  budgetPaise: number;
  followUpDate: string;
  date: string;
  notes: string;
  status: 'Open' | 'Contacted' | 'Quoted' | 'Won' | 'Closed';
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  version: number;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export async function createEnquiry(
  db: Db,
  identity: Identity,
  rawInput: unknown
): Promise<EnquiryDocument> {
  const input: CreateEnquiryInput = CreateEnquirySchema.parse(rawInput);
  const tenantId = identity.tenantId;

  const customer = await col(db, 'customers').findOne({_id: input.customerId, tenantId});
  if (!customer) throw new AppError(404, 'Customer not found.');

  const date = todayInKolkata();
  const yearStr = date.slice(0, 4);
  const enquiryNumber = await nextTenantSequence(db, tenantId, 'Enquiry', yearStr, 'ENQ');

  const enquiryId = uid('ENQ');
  const now = new Date();

  const doc: EnquiryDocument = {
    _id: enquiryId,
    tenantId,
    enquiryNumber,
    customerId: input.customerId,
    customerSnapshot: {
      name: customer.name || 'Unknown',
      phone: customer.phone,
      email: customer.email,
    },
    category: input.category,
    requirement: input.requirement,
    budgetPaise: input.budgetPaise || 0,
    followUpDate: input.followUpDate,
    date,
    notes: input.notes || '',
    status: 'Open',
    invoiceId: null,
    invoiceNumber: null,
    version: 1,
    createdAt: now,
    createdBy: identity.userId,
    updatedAt: now,
    updatedBy: identity.userId,
  };

  await col(db, 'enquiries').insertOne(doc);

  await recordAudit(db, {
    identity,
    action: 'Create',
    entityType: 'enquiry',
    entityId: enquiryId,
    detail: `Created enquiry ${enquiryNumber} for customer ${customer.name} (${input.category})`,
  });

  return doc;
}

export async function updateEnquiry(
  db: Db,
  identity: Identity,
  id: string,
  rawInput: unknown
): Promise<EnquiryDocument> {
  const input: UpdateEnquiryInput = UpdateEnquirySchema.parse(rawInput);
  const tenantId = identity.tenantId;

  const enquiry = await col(db, 'enquiries').findOne({_id: id, tenantId});
  if (!enquiry) throw new AppError(404, 'Enquiry not found.');

  if (input.expectedVersion !== undefined && enquiry.version !== input.expectedVersion) {
    throw new AppError(409, 'Enquiry was modified by another session. Please reload.');
  }

  if (input.status === 'Won' && enquiry.status !== 'Won' && !enquiry.invoiceId) {
    throw new AppError(400, 'Enquiries can only be won by issuing a completed sales invoice.');
  }

  const setFields: Record<string, any> = {
    updatedAt: new Date(),
    updatedBy: identity.userId,
  };

  if (input.category !== undefined) setFields.category = input.category;
  if (input.requirement !== undefined) setFields.requirement = input.requirement;
  if (input.budgetPaise !== undefined) setFields.budgetPaise = input.budgetPaise;
  if (input.followUpDate !== undefined) setFields.followUpDate = input.followUpDate;
  if (input.notes !== undefined) setFields.notes = input.notes;
  if (input.status !== undefined) setFields.status = input.status;

  if (input.customerId && input.customerId !== enquiry.customerId) {
    const customer = await col(db, 'customers').findOne({_id: input.customerId, tenantId});
    if (!customer) throw new AppError(404, 'Customer not found.');
    setFields.customerId = input.customerId;
    setFields.customerSnapshot = {
      name: customer.name || 'Unknown',
      phone: customer.phone,
      email: customer.email,
    };
  }

  await col(db, 'enquiries').updateOne(
    {_id: id, tenantId},
    {
      $set: setFields,
      $inc: {version: 1},
    }
  );

  const updated = await col(db, 'enquiries').findOne({_id: id, tenantId});

  await recordAudit(db, {
    identity,
    action: 'Update',
    entityType: 'enquiry',
    entityId: id,
    detail: `Updated enquiry ${enquiry.enquiryNumber}${input.status ? ` status to ${input.status}` : ''}`,
  });

  return updated as unknown as EnquiryDocument;
}

export async function getEnquiry(
  db: Db,
  identity: Identity,
  id: string
): Promise<EnquiryDocument> {
  const enquiry = await col(db, 'enquiries').findOne({_id: id, tenantId: identity.tenantId});
  if (!enquiry) throw new AppError(404, 'Enquiry not found.');
  return enquiry as unknown as EnquiryDocument;
}

export async function listEnquiries(
  db: Db,
  identity: Identity,
  rawQuery: unknown
) {
  const query: EnquiryListQueryInput = EnquiryListQuerySchema.parse(rawQuery);
  const tenantId = identity.tenantId;

  const filter: Record<string, any> = {tenantId};

  if (query.customerId) {
    filter.customerId = query.customerId;
  }
  if (query.status && query.status !== 'All') {
    filter.status = query.status;
  }
  if (query.category && query.category !== 'All') {
    filter.category = query.category;
  }
  if (query.search && query.search.trim()) {
    const s = query.search.trim();
    const regex = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      {requirement: regex},
      {enquiryNumber: regex},
      {'customerSnapshot.name': regex},
      {'customerSnapshot.phone': regex},
      {notes: regex},
    ];
  }

  const page = query.page || 1;
  const limit = query.limit || 20;
  const skip = (page - 1) * limit;

  const [total, records] = await Promise.all([
    col(db, 'enquiries').countDocuments(filter),
    col(db, 'enquiries')
      .find(filter)
      .sort({createdAt: -1})
      .skip(skip)
      .limit(limit)
      .toArray(),
  ]);

  return {
    records,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}
