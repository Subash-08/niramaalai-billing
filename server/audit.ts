import 'server-only';
import {Db, ClientSession} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {Identity, tenantFilter} from './security';

const ALLOWLISTS: Record<string, string[]> = {
  companySettings: ['name', 'phone', 'email', 'address', 'gst', 'bank', 'account', 'ifsc', 'declaration', 'logoFileId'],
  customer: ['name', 'phone', 'email', 'address', 'gst', 'type', 'notes', 'details', 'status'],
  supplier: ['name', 'phone', 'email', 'address', 'gst', 'terms', 'status'],
  product: ['name', 'category', 'brand', 'condition', 'model', 'hsn', 'costPaise', 'sellingPricePaise', 'priceEntryMode', 'taxBasisPoints', 'low', 'warranty', 'preferredSupplierId', 'isSerialTracked', 'status'],
  stockAdjustment: ['productId', 'delta', 'serials', 'reason', 'idempotencyKey'],
  serviceCatalog: ['name', 'category', 'description', 'ratePaise', 'taxBasisPoints', 'sac', 'warranty', 'active', 'status'],
  printJob: ['jobNumber','customerId','title','description','quantity','unit','dueDate','status','specifications','notes','invoiceId','version'],
  invoiceTemplate: ['name', 'title', 'paper', 'orientation', 'fontSize', 'accent', 'borders', 'striped', 'logoPosition', 'fields', 'columns', 'footer', 'currentRevision', 'isDefault', 'status'],
  openingSetup: ['status', 'cutoffDate', 'openingCashPaise', 'openingBankPaise', 'receivablesCount', 'payablesCount', 'lotsCount', 'serialsCount'],
  purchase: ['purchaseNumber', 'supplierId', 'orderDate', 'supplierInvoiceNumber', 'supplierInvoiceDate', 'documentStatus', 'billStatus', 'receiptStatus', 'paymentStatus', 'totalPaise', 'duePaise', 'notes'],
  purchaseReceipt: ['receiptNumber', 'purchaseId', 'purchaseNumber', 'receiptDate', 'lines'],
  supplierPayment: ['paymentNumber', 'supplierId', 'date', 'totalAmountPaise', 'allocatedAmountPaise', 'advanceAmountPaise', 'method', 'reference', 'isReversed'],
  supplierAllocation: ['sourceType', 'sourceId', 'targetType', 'targetId', 'amountPaise', 'isReversal'],
  supplierAdvance: ['advanceNumber', 'supplierId', 'sourceType', 'originalAmountPaise', 'remainingAmountPaise', 'status'],
  purchaseReturn: ['returnNumber', 'supplierId', 'purchaseId', 'quantity', 'totalReturnCreditPaise', 'status'],
  supplierRefund: ['refundNumber', 'supplierId', 'advanceId', 'amountPaise', 'account', 'isReversed'],
  quotation: ['quotationNumber', 'customerId', 'quotationDate', 'validUntil', 'status', 'totalPaise', 'version', 'notes'],
  invoice: ['invoiceNumber', 'customerId', 'invoiceDate', 'status', 'totalPaise', 'duePaise', 'receiptId', 'advanceUsedPaise', 'creditLimitOverride', 'creditLimitOverrideReason', 'notes'],
  stockReservation: ['reservationNumber', 'customerId', 'productId', 'lotId', 'quantity', 'remainingQuantity', 'status', 'expiresAt'],
  customerReceipt: ['receiptNumber', 'customerId', 'date', 'totalAmountPaise', 'allocatedAmountPaise', 'advanceAmountPaise', 'method', 'reference', 'isReversed'],
  customerAllocation: ['sourceType', 'sourceId', 'targetType', 'targetId', 'amountPaise', 'isReversal'],
  customerAdvance: ['advanceNumber', 'customerId', 'sourceType', 'originalAmountPaise', 'remainingAmountPaise', 'status'],
  customerReturn: ['returnNumber', 'customerId', 'invoiceId', 'quantity', 'refundPaise', 'status'],
  customerRefund: ['refundNumber', 'customerId', 'advanceId', 'amountPaise', 'account', 'isReversed'],
  warranty: ['invoiceId', 'customerId', 'productId', 'serialNumber', 'status', 'resolution', 'claimReason'],
  template: ['name', 'title', 'paper', 'orientation', 'fontSize', 'accent', 'borders', 'striped', 'logoPosition', 'currentRevision', 'isDefault', 'status'],
};

function sanitizeSnapshot(entityType: string, data?: Record<string, any>): Record<string, any> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const allowlist = ALLOWLISTS[entityType] || [];
  const result: Record<string, any> = {};
  for (const key of allowlist) {
    if (key in data && data[key] !== undefined) {
      result[key] = data[key];
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export type AuditRecord = {
  _id: string;
  tenantId: string;
  action: string;
  entityType: string;
  entityId: string;
  performedBy: string;
  timestamp: Date;
  before?: Record<string, any>;
  after?: Record<string, any>;
  detail: string;
};

export async function recordAudit(
  db: Db,
  params: {
    identity: Identity;
    action: string;
    entityType: string;
    entityId: string;
    before?: Record<string, any>;
    after?: Record<string, any>;
    detail: string;
  },
  session?: ClientSession
): Promise<AuditRecord> {
  const record: AuditRecord = {
    _id: randomUUID(),
    tenantId: params.identity.tenantId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    performedBy: params.identity.userId,
    timestamp: new Date(),
    before: sanitizeSnapshot(params.entityType, params.before),
    after: sanitizeSnapshot(params.entityType, params.after),
    detail: params.detail.slice(0, 500),
  };

  await db.collection<AuditRecord>('auditHistory').insertOne(record, session ? {session} : {});
  return record;
}

export async function listAuditHistory(
  db: Db,
  identity: Identity,
  params: {page?: number; limit?: number; entityType?: string; entityId?: string}
) {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 20));
  const skip = (page - 1) * limit;

  const filter: Record<string, any> = {tenantId: identity.tenantId};
  if (params.entityType) filter.entityType = params.entityType;
  if (params.entityId) filter.entityId = params.entityId;

  const [records, total] = await Promise.all([
    db.collection<AuditRecord>('auditHistory')
      .find(filter)
      .sort({timestamp: -1})
      .skip(skip)
      .limit(limit)
      .toArray(),
    db.collection('auditHistory').countDocuments(filter),
  ]);

  return {records, total, page, limit, totalPages: Math.ceil(total / limit)};
}
