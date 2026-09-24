import 'server-only';
import {Db, ClientSession} from 'mongodb';
import {AsyncLocalStorage} from 'node:async_hooks';
import {AppError} from './db';
import {Identity} from './security';
import {recordAudit} from './audit';
import {uid} from '../lib/domain';
import {
  todayInKolkata,
  deriveFinancialYear,
} from './purchase-schema';
import {
  calculateSaleLinePaise,
  calculateSaleDocumentTotals,
  splitSaleTax,
  SaleTaxMode,
} from './sales-calculations';
import {
  CreateInvoiceDraftInput,
  IssueInvoiceInput,
  CreateQuotationSchema,
  UpdateQuotationSchema,
  CancelQuotationSchema,
  ReopenQuotationSchema,
  ShareQuotationSchema,
  CreateInvoiceDraftSchema,
  IssueInvoiceSchema,
  UpdateInvoiceDraftSchema,
  CancelInvoiceDraftSchema,
  ConvertQuotationSchema,
  SalesListQuerySchema,
  ReservationListQuerySchema,
} from './sales-schema';
import {z} from 'zod';
import {normalizeSerial} from './master-schema';
import {canonicalSerialKey, resolveSerialUnit, transitionSerialUnit} from './serial-identity';
import {assertSalePostingDay, settleInvoiceOnIssue, addWarrantyMonths} from './sales-posting';
import {consumeStockReservation} from './stock-reservations';
import {
  nextTenantSequence,
  executeIdempotentTransaction,
  col,
} from './purchase-service';

const salesTransaction = new AsyncLocalStorage<ClientSession>();

export type InvoiceStatus = 'Draft' | 'Issued' | 'Cancelled';
export type QuotationStatus = 'Draft' | 'Sent' | 'Accepted' | 'Rejected' | 'Converted' | 'Expired';

export type SaleLineDocument = {
  lineId: string;
  clientLineKey: string;
  lineType: 'Product' | 'Service' | 'Charge' | 'ConsumedPart';
  partId?: string;
  lotId?: string;
  serials?: string[];
  productId?: string;
  productSnapshot?: {
    name: string; hsn: string; category: string;
    brand: string; model: string; isSerialTracked: boolean; condition: 'New' | 'Used';
  };
  stockAllocations?: Array<{lotId: string; reservationId?: string | null; quantity: number; serials: string[]}>;
  warrantyMonths?: number;
  serviceId?: string;
  serviceSnapshot?: {name: string; sac: string};
  serviceJobId?: string | null;
  sac?: string;
  description: string;
  details: string;
  unit: string;
  printSpecifications?: {size?: string; material?: string; gsm?: string; colour?: string; sides?: string; finishing?: string; deliveryDate?: string; notes?: string};
  hsn?: string;
  quantity: number;
  unitRatePaise: number;
  discountType: 'Percentage' | 'Amount';
  discountValue: number;
  taxBasisPoints: number;
  taxTreatment: 'Taxable' | 'Exempt' | 'NonGST';
  inclusive: boolean;
  grossPaise: number;
  discountPaise: number;
  taxableBasePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  returnedQuantity: number;
  creditedReturnPaise: number;
};

export type CustomerAddressSnapshot = {
  name: string; phone: string; address: string;
  state: string; stateCode: string; postalCode: string;
};

export type QuotationDocument = {
  _id: string;
  quotationNumber: string;
  tenantId: string;
  version: number;
  status: QuotationStatus;
  customerId: string;
  customerSnapshot: {name: string; phone: string; email: string; gst: string; address: string};
  billTo: CustomerAddressSnapshot;
  shipTo?: CustomerAddressSnapshot | null;
  invoiceKind: 'Sale' | 'Service';
  businessCategory: 'NewGoods' | 'UsedGoods' | 'Service';
  quotationDate: string;
  validUntil: string;
  inclusive: boolean;
  taxMode: SaleTaxMode;
  placeOfSupply: string;
  templateId: string;
  templateRevision: number;
  sourceEnquiryId?: string | null;
  serviceJobId?: string | null;
  orderReference?: string | null;
  notes: string;
  lines: SaleLineDocument[];
  grossPaise: number;
  discountPaise: number;
  taxableBasePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  lineTotalPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  convertedToInvoiceId?: string | null;
  cancelReason?: string | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
};

export type InvoiceDocument = {
  printJobId?: string | null;
  _id: string;
  tenantId: string;
  version: number;
  status: InvoiceStatus;
  invoiceNumber?: string;
  financialYear?: string;
  invoiceDate: string;
  dueDate?: string | null;
  issuedAt?: Date;
  issuedBy?: string;
  customerId: string;
  customerSnapshot: {name: string; phone: string; email: string; gst: string; address: string};
  billTo: CustomerAddressSnapshot;
  shipTo?: CustomerAddressSnapshot | null;
  invoiceKind: 'Sale' | 'Service';
  businessCategory: 'NewGoods' | 'UsedGoods' | 'Service';
  inclusive: boolean;
  taxMode: SaleTaxMode;
  placeOfSupply: string;
  templateId: string;
  templateRevision: number;
  sourceQuotationId?: string | null;
  serviceJobId?: string | null;
  enquiryId?: string | null;
  reservationId?: string | null;
  orderReference?: string | null;
  deliveryNote?: string | null;
  dispatchThrough?: string | null;
  notes: string;
  lines: SaleLineDocument[];
  grossPaise: number;
  discountPaise: number;
  taxableBasePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  lineTotalPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  originalTotalPaise: number;
  allocatedReceiptPaise: number;
  allocatedCreditPaise: number;
  allocatedAdvancePaise?: number;
  duePaise: number;
  issuedSnapshot?: object;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
};

type CreateQuotationInput = z.infer<typeof CreateQuotationSchema>;

function sessionOpt(session?: ClientSession) {
  return session ? {session} : {};
}

function validatedCalculation<T>(calculate: () => T): T {
  try { return calculate(); }
  catch (error) { throw new AppError(400, error instanceof Error ? error.message : 'Invalid invoice calculation.'); }
}

async function buildSaleLines(
  db: Db,
  tenantId: string,
  rawLines: CreateInvoiceDraftInput['lines'],
  inclusive: boolean,
  taxMode: SaleTaxMode,
  session?: ClientSession,
  requireStock = false,
): Promise<SaleLineDocument[]> {
  const result: SaleLineDocument[] = [];
  for (let idx = 0; idx < rawLines.length; idx++) {
    const l = rawLines[idx];
    const lineId = uid('SLN');
    const calc = validatedCalculation(() => calculateSaleLinePaise({
      quantity: l.quantity, unitRatePaise: l.unitRatePaise, inclusive,
      taxBasisPoints: l.taxBasisPoints, discountType: l.discountType, discountValue: l.discountValue,
    }));
    const tax = splitSaleTax(calc.taxPaise, taxMode);
    const base: Omit<SaleLineDocument, 'lineType' | 'productId' | 'productSnapshot' | 'stockAllocations' | 'serviceId' | 'serviceSnapshot' | 'sac'> = {
      lineId, clientLineKey: l.clientLineKey, description: l.description, details: l.details || '', unit: l.unit || 'Piece',
      printSpecifications: l.printSpecifications || {}, quantity: l.quantity,
      unitRatePaise: l.unitRatePaise, discountType: l.discountType, discountValue: l.discountValue,
      taxBasisPoints: l.taxBasisPoints, taxTreatment: l.taxTreatment, inclusive, ...calc, ...tax,
      returnedQuantity: 0, creditedReturnPaise: 0,
    };
    if (l.lineType === 'Product') {
      const product = await col(db, 'products').findOne({_id: l.productId, tenantId, status: 'Active'}, sessionOpt(session));
      if (!product) throw new AppError(404, `Line ${idx + 1}: Product not found or archived.`);
      result.push({
        ...base, lineType: 'Product', productId: l.productId,
        productSnapshot: {
          name: product.name, hsn: l.hsn || product.hsn || '', category: product.category || 'General',
          brand: product.brand || '', model: product.model || '', isSerialTracked: !!product.isSerialTracked,
          condition: product.condition === 'Used' ? 'Used' : 'New',
        },
        stockAllocations: [], warrantyMonths: 0, hsn: l.hsn || product.hsn || '',
      });
    } else if (l.lineType === 'Service') {
      let serviceSnap: {name: string; sac: string} | undefined;
      if (l.serviceId) {
        const svc = await col(db, 'serviceCatalog').findOne({_id: l.serviceId, tenantId, status: 'Active', active: true}, sessionOpt(session));
        if (!svc) throw new AppError(404, `Line ${idx + 1}: Service not found or archived.`);
        serviceSnap = {name: svc.name, sac: svc.sac || l.sac};
      }
      result.push({...base, lineType: 'Service', ...(l.serviceId ? {serviceId: l.serviceId} : {}), serviceSnapshot: serviceSnap, ...(l.serviceJobId ? {serviceJobId: l.serviceJobId} : {}), sac: l.sac, warrantyMonths: l.warrantyMonths ?? 0});
    } else if (l.lineType === 'ConsumedPart') {
      const product = await col(db, 'products').findOne({_id: l.productId, tenantId, status: 'Active'}, sessionOpt(session));
      if (!product) throw new AppError(404, `Line ${idx + 1}: Consumed part product not found or archived.`);
      result.push({
        ...base,
        lineType: 'ConsumedPart',
        serviceJobId: l.serviceJobId,
        partId: l.partId,
        productId: l.productId,
        productSnapshot: {
          name: product.name,
          hsn: l.hsn || product.hsn || '',
          category: product.category || 'General',
          brand: product.brand || '',
          model: product.model || '',
          isSerialTracked: !!product.isSerialTracked,
          condition: product.condition === 'Used' ? 'Used' : 'New',
        },
        lotId: l.lotId,
        serials: l.serials || [],
        warrantyMonths: l.warrantyMonths ?? 0,
        hsn: l.hsn || product.hsn || '',
      });
    } else {
      result.push({...base, lineType: 'Charge', sac: l.sac});
    }
  }
  return result;
}

async function resolveCustomer(db: Db, tenantId: string, customerId: string, session?: ClientSession) {
  const customer = await col(db, 'customers').findOne({_id: customerId, tenantId, status: 'Active'}, sessionOpt(session));
  if (!customer) throw new AppError(404, 'Customer not found or archived.');
  return customer;
}

async function resolveTemplate(db: Db, tenantId: string, templateId: string, templateRevision: number, session?: ClientSession) {
  const active = await col(db, 'invoiceTemplates').findOne({_id: templateId, tenantId, status: 'Active'}, sessionOpt(session));
  if (!active) throw new AppError(404, 'Selected invoice template is unavailable or archived.');
  const rev = await col(db, 'templateRevisions').findOne({tenantId, templateId, revision: templateRevision}, sessionOpt(session));
  if (!rev) throw new AppError(404, `Invoice template revision ${templateRevision} not found.`);
  if (!Array.isArray(rev.snapshot?.columns) || !rev.snapshot?.fields)
    throw new AppError(409, 'Selected template revision has an incomplete layout snapshot. Select a complete saved revision.');
  return rev;
}

/**
 * GST treatment is derived from the seller's state and the actual delivery
 * destination, never from a client-side toggle alone. The address snapshots
 * remain authoritative after a customer profile is later edited.
 */
async function assertSupplyTaxTreatment(
  db: Db,
  tenantId: string,
  input: {taxMode: SaleTaxMode; placeOfSupply: string; billTo?: CustomerAddressSnapshot | null; shipTo?: CustomerAddressSnapshot | null},
  session?: ClientSession,
) {
  const normalize = (value: string | undefined) => (value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const place = normalize(input.placeOfSupply);
  if (!place) throw new AppError(400, 'Place of supply is required.');
  const destination = input.shipTo?.state || input.billTo?.state || '';
  if (destination && normalize(destination) !== place) {
    throw new AppError(400, 'Place of supply must match the bill-to or ship-to state.');
  }
  const settings = await col(db, 'companySettings').findOne({tenantId}, sessionOpt(session));
  const sellerState = normalize(settings?.state);
  if (!sellerState || !destination) return;
  const sameState = sellerState === normalize(destination);
  if (input.taxMode === 'Inter-state' && sameState) {
    throw new AppError(400, 'Interstate / IGST cannot be used when the destination is in the shop state.');
  }
  if (input.taxMode === 'Intra-state' && !sameState) {
    throw new AppError(400, 'A destination outside the shop state requires Interstate / IGST.');
  }
}

// 1. Create Quotation
export async function createQuotation(db: Db, identity: Identity, raw: CreateQuotationInput) {
  const input = CreateQuotationSchema.parse(raw);
  if (input.sourceQuotationId) throw new AppError(400, 'A quotation cannot have a source quotation.');
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'quotation.create', undefined, input,
    session => salesTransaction.run(session, () => createQuotationWithinTransaction(db, identity, input)));
}

async function createQuotationWithinTransaction(db: Db, identity: Identity, input: CreateQuotationInput) {
  const tenantId = identity.tenantId;
  const session = salesTransaction.getStore();
  const customer = await resolveCustomer(db, tenantId, input.customerId, session);
  await resolveTemplate(db, tenantId, input.templateId, input.templateRevision, session);
  await assertSupplyTaxTreatment(db, tenantId, input, session);
  const lines = await buildSaleLines(db, tenantId, input.lines, input.inclusive, input.taxMode, session);
  const totals = calculateSaleDocumentTotals(lines, input.roundOffPaise);
  const now = new Date();
  const yearStr = input.quotationDate.slice(0, 4);
  const quotationNumber = await nextTenantSequence(db, tenantId, 'Quotation', yearStr, 'QUO', session);
  const quotationId = uid('QUO');
  const billTo: CustomerAddressSnapshot = {
    name: customer.name, phone: customer.phone || '', address: customer.address || '',
    state: customer.details?.state || customer.state || '', stateCode: customer.stateCode || '',
    postalCode: customer.details?.postalCode || customer.postalCode || '',
  };
  const doc: QuotationDocument = {
    _id: quotationId, quotationNumber, tenantId, version: 1, status: 'Draft',
    customerId: input.customerId,
    customerSnapshot: {name: customer.name, phone: customer.phone || '', email: customer.email || '', gst: customer.gst || '', address: customer.address || ''},
    billTo: input.billTo ?? billTo, shipTo: input.shipTo,
    invoiceKind: input.invoiceKind, businessCategory: input.businessCategory,
    quotationDate: input.quotationDate, validUntil: input.validUntil,
    inclusive: input.inclusive, taxMode: input.taxMode, placeOfSupply: input.placeOfSupply,
    templateId: input.templateId, templateRevision: input.templateRevision,
    sourceEnquiryId: input.enquiryId, serviceJobId: input.serviceJobId,
    orderReference: input.orderReference, notes: input.notes,
    lines, ...totals,
    createdAt: now, createdBy: identity.userId, updatedAt: now, updatedBy: identity.userId,
  };
  await col<QuotationDocument>(db, 'quotations').insertOne(doc, sessionOpt(session));
  await recordAudit(db, {identity, action: 'quotation.create', entityType: 'quotation', entityId: quotationId,
    after: doc as any, detail: `Created quotation ${quotationNumber}`}, session);
  return doc;
}

// 2. Convert Quotation to Invoice Draft
export async function convertQuotationToDraft(
  db: Db, identity: Identity,
  input: {quotationId: string; expectedVersion: number; invoiceDate: string; idempotencyKey: string},
) {
  input = ConvertQuotationSchema.parse(input);
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'quotation.convert', input.quotationId, input, async session => {
    const tenantId = identity.tenantId;
    const quotation = await col<QuotationDocument>(db, 'quotations').findOne({_id: input.quotationId, tenantId}, {session});
    if (!quotation) throw new AppError(404, 'Quotation not found.');
    if (quotation.convertedToInvoiceId) throw new AppError(409, 'Quotation already has a linked invoice draft. Open that invoice.');
    if (quotation.validUntil < input.invoiceDate) throw new AppError(400, 'Quotation expired. Update validity before converting.');
    if (quotation.version !== input.expectedVersion) throw new AppError(409, 'Quotation was modified by another session. Please reload.');
    if (!['Draft', 'Sent', 'Accepted'].includes(quotation.status)) throw new AppError(400, `Quotation is ${quotation.status} and cannot be converted.`);
    const now = new Date();
    const invoiceId = uid('INV');
    const invoiceDoc: InvoiceDocument = {
      _id: invoiceId, tenantId, version: 1, status: 'Draft',
      invoiceDate: input.invoiceDate, dueDate: undefined,
      customerId: quotation.customerId, customerSnapshot: quotation.customerSnapshot,
      billTo: quotation.billTo, shipTo: quotation.shipTo,
      invoiceKind: quotation.invoiceKind, businessCategory: quotation.businessCategory,
      inclusive: quotation.inclusive, taxMode: quotation.taxMode, placeOfSupply: quotation.placeOfSupply,
      templateId: quotation.templateId, templateRevision: quotation.templateRevision,
      sourceQuotationId: quotation._id, serviceJobId: quotation.serviceJobId, enquiryId: quotation.sourceEnquiryId,
      orderReference: quotation.orderReference, deliveryNote: '', dispatchThrough: '', notes: quotation.notes,
      lines: quotation.lines,
      grossPaise: quotation.grossPaise, discountPaise: quotation.discountPaise, taxableBasePaise: quotation.taxableBasePaise,
      taxPaise: quotation.taxPaise, cgstPaise: quotation.cgstPaise, sgstPaise: quotation.sgstPaise, igstPaise: quotation.igstPaise,
      lineTotalPaise: quotation.lineTotalPaise, roundOffPaise: quotation.roundOffPaise, totalPaise: quotation.totalPaise,
      originalTotalPaise: 0, allocatedReceiptPaise: 0, allocatedCreditPaise: 0, duePaise: 0,
      createdAt: now, createdBy: identity.userId, updatedAt: now, updatedBy: identity.userId,
    };
    await col<InvoiceDocument>(db, 'invoices').insertOne(invoiceDoc, {session});
    const linked = await col<QuotationDocument>(db, 'quotations').updateOne(
      {_id: input.quotationId, tenantId, version: quotation.version},
      {$set: {convertedToInvoiceId: invoiceId, version: quotation.version + 1, updatedAt: now, updatedBy: identity.userId}},
      {session},
    );
    if (linked.matchedCount !== 1) throw new AppError(409, 'Quotation changed during conversion.');
    await recordAudit(db, {identity, action: 'quotation.convert', entityType: 'quotation', entityId: input.quotationId,
      detail: `Converted quotation ${quotation.quotationNumber} -> invoice draft ${invoiceId}`}, session);
    return invoiceDoc;
  });
}

// 2a. Update Quotation Draft
export async function updateQuotation(db: Db, identity: Identity, id: string, raw: z.infer<typeof UpdateQuotationSchema>) {
  const input = UpdateQuotationSchema.parse(raw);
  return executeIdempotentTransaction(db, identity, input.quotation.idempotencyKey, 'quotation.update', id, input, async session => {
    const before = await col<QuotationDocument>(db, 'quotations').findOne({_id: id, tenantId: identity.tenantId}, {session});
    if (!before) throw new AppError(404, 'Quotation not found.');
    if (before.status !== 'Draft' || before.version !== input.expectedVersion) {
      throw new AppError(409, 'Only current draft version of quotation can be edited.');
    }
    if (before.convertedToInvoiceId) {
      throw new AppError(409, 'Converted quotation cannot be edited.');
    }
    const tenantId = identity.tenantId;
    const customer = await resolveCustomer(db, tenantId, input.quotation.customerId, session);
    await resolveTemplate(db, tenantId, input.quotation.templateId, input.quotation.templateRevision, session);
    const lines = await buildSaleLines(db, tenantId, input.quotation.lines, input.quotation.inclusive, input.quotation.taxMode, session);
    const totals = calculateSaleDocumentTotals(lines, input.quotation.roundOffPaise);
    const now = new Date();
    const oldLineIds = new Map(before.lines.map((l: SaleLineDocument) => [l.clientLineKey, l.lineId]));
    const billTo: CustomerAddressSnapshot = {
      name: customer.name, phone: customer.phone || '', address: customer.address || '',
      state: customer.details?.state || customer.state || '', stateCode: customer.stateCode || '',
      postalCode: customer.details?.postalCode || customer.postalCode || '',
    };
    const nextLines = lines.map(line => ({...line, lineId: oldLineIds.get(line.clientLineKey) ?? line.lineId}));
    const updatePayload = {
      customerId: input.quotation.customerId,
      customerSnapshot: {name: customer.name, phone: customer.phone || '', email: customer.email || '', gst: customer.gst || '', address: customer.address || ''},
      billTo: input.quotation.billTo ?? billTo, shipTo: input.quotation.shipTo,
      invoiceKind: input.quotation.invoiceKind, businessCategory: input.quotation.businessCategory,
      quotationDate: input.quotation.quotationDate, validUntil: input.quotation.validUntil,
      inclusive: input.quotation.inclusive, taxMode: input.quotation.taxMode, placeOfSupply: input.quotation.placeOfSupply,
      templateId: input.quotation.templateId, templateRevision: input.quotation.templateRevision,
      sourceEnquiryId: input.quotation.enquiryId, serviceJobId: input.quotation.serviceJobId,
      orderReference: input.quotation.orderReference, notes: input.quotation.notes,
      lines: nextLines, ...totals,
      version: before.version + 1, updatedAt: now, updatedBy: identity.userId,
    };
    const res = await col<QuotationDocument>(db, 'quotations').updateOne(
      {_id: id, tenantId, status: 'Draft', version: input.expectedVersion},
      {$set: updatePayload},
      {session}
    );
    if (res.matchedCount !== 1) throw new AppError(409, 'Quotation was modified by another session. Please reload.');
    await recordAudit(db, {identity, action: 'quotation.update', entityType: 'quotation', entityId: id,
      detail: `Updated quotation ${before.quotationNumber} (v${before.version} -> v${before.version + 1})`}, session);
    return {_id: id, quotationNumber: before.quotationNumber, tenantId, ...updatePayload};
  });
}

// 2b. Mark a reviewed quotation as shared with the customer.
export async function shareQuotation(db: Db, identity: Identity, id: string, raw: z.infer<typeof ShareQuotationSchema>) {
  const input = ShareQuotationSchema.parse(raw);
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'quotation.share', id, input, async session => {
    const before = await col<QuotationDocument>(db, 'quotations').findOne({_id: id, tenantId: identity.tenantId}, {session});
    if (!before) throw new AppError(404, 'Quotation not found.');
    if (before.convertedToInvoiceId || before.status === 'Converted') throw new AppError(409, 'Converted quotation cannot be marked as shared.');
    if (before.status !== 'Draft' || before.version !== input.expectedVersion) {
      throw new AppError(409, 'Only the current draft quotation can be marked as shared. Reload and try again.');
    }
    const now = new Date();
    const result = await col<QuotationDocument>(db, 'quotations').updateOne(
      {_id: id, tenantId: identity.tenantId, status: 'Draft', version: input.expectedVersion},
      {$set: {status: 'Sent', sharedAt: now, sharedBy: identity.userId, sharedChannel: input.channel, updatedAt: now, updatedBy: identity.userId}, $inc: {version: 1}},
      {session},
    );
    if (result.matchedCount !== 1) throw new AppError(409, 'Quotation changed while it was being marked as shared. Reload and try again.');
    await recordAudit(db, {identity, action: 'quotation.share', entityType: 'quotation', entityId: id,
      detail: `Marked quotation ${before.quotationNumber} as shared via ${input.channel}`}, session);
    return {quotationId: id, status: 'Sent', version: before.version + 1, sharedAt: now, sharedChannel: input.channel};
  });
}

// 2c. Cancel Quotation
export async function cancelQuotation(db: Db, identity: Identity, id: string, raw: z.infer<typeof CancelQuotationSchema>) {
  const input = CancelQuotationSchema.parse(raw);
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'quotation.cancel', id, input, async session => {
    const before = await col<QuotationDocument>(db, 'quotations').findOne({_id: id, tenantId: identity.tenantId}, {session});
    if (!before) throw new AppError(404, 'Quotation not found.');
    if (!['Draft', 'Sent'].includes(before.status) || before.version !== input.expectedVersion) {
      throw new AppError(409, 'Only draft or sent quotation at current version can be cancelled.');
    }
    if (before.convertedToInvoiceId) {
      throw new AppError(409, 'Converted quotation cannot be cancelled.');
    }
    const now = new Date();
    const res = await col<QuotationDocument>(db, 'quotations').updateOne(
      {_id: id, tenantId: identity.tenantId, version: input.expectedVersion},
      {$set: {status: 'Cancelled', cancelReason: input.reason, updatedAt: now, updatedBy: identity.userId}, $inc: {version: 1}},
      {session}
    );
    if (res.matchedCount !== 1) throw new AppError(409, 'Quotation was modified by another session. Please reload.');
    await recordAudit(db, {identity, action: 'quotation.cancel', entityType: 'quotation', entityId: id,
      detail: `Cancelled quotation ${before.quotationNumber}: ${input.reason}`}, session);
    return {quotationId: id, status: 'Cancelled', version: before.version + 1};
  });
}

// 2d. Reopen Quotation
export async function reopenQuotation(db: Db, identity: Identity, id: string, raw: z.infer<typeof ReopenQuotationSchema>) {
  const input = ReopenQuotationSchema.parse(raw);
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'quotation.reopen', id, input, async session => {
    const before = await col<QuotationDocument>(db, 'quotations').findOne({_id: id, tenantId: identity.tenantId}, {session});
    if (!before) throw new AppError(404, 'Quotation not found.');
    if (!['Cancelled', 'Expired'].includes(before.status) || before.version !== input.expectedVersion) {
      throw new AppError(409, 'Only cancelled or expired quotation at current version can be reopened.');
    }
    if (input.validUntil < todayInKolkata()) {
      throw new AppError(400, 'New validity date cannot be in the past.');
    }
    const now = new Date();
    const res = await col<QuotationDocument>(db, 'quotations').updateOne(
      {_id: id, tenantId: identity.tenantId, version: input.expectedVersion},
      {$set: {status: 'Draft', validUntil: input.validUntil, updatedAt: now, updatedBy: identity.userId}, $unset: {cancelReason: ''}, $inc: {version: 1}},
      {session}
    );
    if (res.matchedCount !== 1) throw new AppError(409, 'Quotation was modified by another session. Please reload.');
    await recordAudit(db, {identity, action: 'quotation.reopen', entityType: 'quotation', entityId: id,
      detail: `Reopened quotation ${before.quotationNumber} with validity ${input.validUntil}`}, session);
    return {quotationId: id, status: 'Draft', version: before.version + 1, validUntil: input.validUntil};
  });
}

// 3. Prepare Invoice Draft (internal helper)
async function prepareInvoiceDraft(db: Db, identity: Identity, input: CreateInvoiceDraftInput, session: ClientSession) {
  const tenantId = identity.tenantId;
  if (input.printJobId) {
    const job = await col(db, 'printJobs').findOne({_id: input.printJobId, tenantId, customerId: input.customerId, status: {$ne: 'Cancelled'}}, {session});
    if (!job) throw new AppError(400, 'Print job must belong to this company and customer and must not be cancelled.');
  }
  const customer = await resolveCustomer(db, tenantId, input.customerId, session);
  await resolveTemplate(db, tenantId, input.templateId, input.templateRevision, session);
  await assertSupplyTaxTreatment(db, tenantId, input, session);
  const lines = await buildSaleLines(db, tenantId, input.lines, input.inclusive, input.taxMode, session);
  const totals = calculateSaleDocumentTotals(lines, input.roundOffPaise);
  const now = new Date();
  const invoiceId = uid('INV');
  const billTo: CustomerAddressSnapshot = {
    name: customer.name, phone: customer.phone || '', address: customer.address || '',
    state: customer.details?.state || customer.state || '', stateCode: customer.stateCode || '',
    postalCode: customer.details?.postalCode || customer.postalCode || '',
  };
  const doc: InvoiceDocument = {
    _id: invoiceId, tenantId, version: 1, status: 'Draft',
    printJobId: input.printJobId,
    invoiceDate: input.invoiceDate, dueDate: input.dueDate,
    customerId: input.customerId,
    customerSnapshot: {name: customer.name, phone: customer.phone || '', email: customer.email || '', gst: customer.gst || '', address: customer.address || ''},
    billTo: input.billTo ?? billTo, shipTo: input.shipTo,
    invoiceKind: input.invoiceKind, businessCategory: input.businessCategory,
    inclusive: input.inclusive, taxMode: input.taxMode, placeOfSupply: input.placeOfSupply,
    templateId: input.templateId, templateRevision: input.templateRevision,
    sourceQuotationId: input.sourceQuotationId, serviceJobId: input.serviceJobId,
    enquiryId: input.enquiryId, reservationId: input.reservationId,
    orderReference: input.orderReference, deliveryNote: input.deliveryNote, dispatchThrough: input.dispatchThrough,
    notes: input.notes, lines, ...totals,
    originalTotalPaise: 0, allocatedReceiptPaise: 0, allocatedCreditPaise: 0, duePaise: 0,
    createdAt: now, createdBy: identity.userId, updatedAt: now, updatedBy: identity.userId,
  };
  return doc;
}

// 4. Create / Update / Cancel Invoice Draft
export async function createInvoiceDraft(db: Db, identity: Identity, raw: CreateInvoiceDraftInput) {
  const input = CreateInvoiceDraftSchema.parse(raw);
  if (input.sourceQuotationId) throw new AppError(400, 'Use the quotation conversion endpoint to create a linked draft.');
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'invoice.createDraft', undefined, input, async session => {
    const doc = await prepareInvoiceDraft(db, identity, input, session);
    await col<InvoiceDocument>(db, 'invoices').insertOne(doc, {session});
    await recordAudit(db, {identity, action: 'invoice.createDraft', entityType: 'invoice', entityId: doc._id,
      detail: 'Created draft; no stock or financial posting.'}, session);
    return doc;
  });
}

export async function updateInvoiceDraft(db: Db, identity: Identity, id: string, raw: z.infer<typeof UpdateInvoiceDraftSchema>) {
  const input = UpdateInvoiceDraftSchema.parse(raw);
  return executeIdempotentTransaction(db, identity, input.draft.idempotencyKey, 'invoice.updateDraft', id, input, async session => {
    const before = await col<InvoiceDocument>(db, 'invoices').findOne({_id: id, tenantId: identity.tenantId}, {session});
    if (!before) throw new AppError(404, 'Invoice not found.');
    if (before.status !== 'Draft' || before.version !== input.expectedVersion) throw new AppError(409, 'Only the current draft version can be edited.');
    if (input.draft.sourceQuotationId && input.draft.sourceQuotationId !== before.sourceQuotationId) throw new AppError(400, 'Quotation links cannot be reassigned.');
    if (before.sourceQuotationId && input.draft.customerId !== before.customerId) throw new AppError(400, 'A converted quotation must retain its customer.');
    const prepared = await prepareInvoiceDraft(db, identity, {...input.draft, sourceQuotationId: before.sourceQuotationId}, session);
    const oldLineIds = new Map(before.lines.map((line: SaleLineDocument) => [line.clientLineKey, line.lineId]));
    const {_id: ignored, ...next} = {...prepared, lines: prepared.lines.map(line => ({...line, lineId: oldLineIds.get(line.clientLineKey) ?? line.lineId})),
      version: before.version + 1, createdAt: before.createdAt, createdBy: before.createdBy};
    const result = await col<InvoiceDocument>(db, 'invoices').updateOne({_id: id, tenantId: identity.tenantId, status: 'Draft', version: input.expectedVersion}, {$set: next}, {session});
    if (result.matchedCount !== 1) throw new AppError(409, 'Draft changed; reload.');
    await recordAudit(db, {identity, action: 'invoice.updateDraft', entityType: 'invoice', entityId: id,
      detail: `Draft version ${before.version} -> ${next.version}; no financial posting.`}, session);
    return {_id: id, ...next};
  });
}

export async function cancelInvoiceDraft(db: Db, identity: Identity, id: string, raw: z.infer<typeof CancelInvoiceDraftSchema>) {
  const input = CancelInvoiceDraftSchema.parse(raw);
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'invoice.cancelDraft', id, input, async session => {
    const before = await col<InvoiceDocument>(db, 'invoices').findOne({_id: id, tenantId: identity.tenantId}, {session});
    if (!before) throw new AppError(404, 'Invoice not found.');
    if (before.status !== 'Draft' || before.version !== input.expectedVersion) throw new AppError(409, 'Only the current draft can be cancelled. Issued invoices require the credit/return workflow.');
    const now = new Date();
    const result = await col<InvoiceDocument>(db, 'invoices').updateOne({_id: id, tenantId: identity.tenantId, status: 'Draft', version: input.expectedVersion},
      {$set: {status: 'Cancelled', updatedAt: now, updatedBy: identity.userId}, $inc: {version: 1}}, {session});
    if (result.matchedCount !== 1) throw new AppError(409, 'Draft changed; reload.');
    await recordAudit(db, {identity, action: 'invoice.cancelDraft', entityType: 'invoice', entityId: id, detail: input.reason}, session);
    return {invoiceId: id, status: 'Cancelled', version: before.version + 1};
  });
}

// 5. Issue Invoice (Atomic)
export async function issueInvoice(db: Db, identity: Identity, rawInput: IssueInvoiceInput) {
  const input = IssueInvoiceSchema.parse(rawInput);
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'invoice.issue', input.draftId, input, async session => {
    const tenantId = identity.tenantId;
    const draft = await col<InvoiceDocument>(db, 'invoices').findOne({_id: input.draftId, tenantId}, {session});
    if (!draft) throw new AppError(404, 'Invoice not found.');
    if (draft.status !== 'Draft' || draft.version !== input.expectedVersion) throw new AppError(409, 'Draft state/version changed. Reload before issuing.');
    await assertSalePostingDay(db, tenantId, draft.invoiceDate, session);
    await resolveCustomer(db, tenantId, draft.customerId, session);
    const template = await resolveTemplate(db, tenantId, draft.templateId, draft.templateRevision, session);
    const seller = await col(db, 'companySettings').findOne({tenantId}, {session});
    if (!seller?.name) throw new AppError(409, 'Complete company settings before issuing.');
    await assertSupplyTaxTreatment(db, tenantId, draft, session);
    if (draft.reservationId) throw new AppError(409, 'Select a stock hold on each relevant lot allocation; the legacy invoice-level hold reference is not supported.');
    let linkedServiceJob: any = null;
    if (draft.serviceJobId) {
      linkedServiceJob = await col(db, 'serviceJobs').findOne({_id: draft.serviceJobId, tenantId}, {session});
      if (!linkedServiceJob) throw new AppError(404, 'Linked service job not found.');
      if (linkedServiceJob.customerId !== draft.customerId) throw new AppError(400, 'Service job customer does not match invoice customer.');
      if (linkedServiceJob.invoiceId && linkedServiceJob.invoiceId !== draft._id) {
        throw new AppError(409, `Service job is already billed on invoice ${linkedServiceJob.invoiceId}.`);
      }
    }
    if (draft.enquiryId) {
      const enquiry = await col(db, 'enquiries').findOne({_id: draft.enquiryId, tenantId}, {session});
      if (!enquiry) throw new AppError(404, 'Linked enquiry not found.');
      if (enquiry.customerId && enquiry.customerId !== draft.customerId) {
        throw new AppError(400, 'Enquiry customer does not match invoice customer.');
      }
    }
    if (draft.sourceQuotationId) {
      const quotation = await col(db, 'quotations').findOne({_id: draft.sourceQuotationId, tenantId,
        customerId: draft.customerId, convertedToInvoiceId: draft._id, status: {$in: ['Draft', 'Sent', 'Accepted']}}, {session});
      if (!quotation) throw new AppError(409, 'The linked quotation is no longer eligible for this invoice.');
    }
    const parsed = CreateInvoiceDraftSchema.parse({...draft, idempotencyKey: input.idempotencyKey,
      lines: draft.lines.map((l: SaleLineDocument) => ({...l, hsn: l.hsn || l.productSnapshot?.hsn || '', sac: l.sac || ''}))});
    // Products are catalogue items in this application. Invoice issue never requires,
    // reserves, serializes, or decrements physical stock.
    const calculated = await buildSaleLines(db, tenantId, parsed.lines, draft.inclusive, draft.taxMode, session, false);
    const lines = calculated.map((line, index) => ({...line, lineId: draft.lines[index].lineId}));
    const totals = calculateSaleDocumentTotals(lines, draft.roundOffPaise);
    if (totals.totalPaise !== draft.totalPaise) throw new AppError(409, 'Draft totals are inconsistent. Re-save the draft before issuing.');
    const now = new Date();
    for (const line of lines) {
      if (line.lineType === 'ConsumedPart') {
        const jId = line.serviceJobId || draft.serviceJobId;
        if (!jId) throw new AppError(400, 'Consumed part lines require a linked serviceJobId.');
        if (!linkedServiceJob || linkedServiceJob._id !== jId) {
          linkedServiceJob = await col(db, 'serviceJobs').findOne({_id: jId, tenantId}, {session});
        }
        const part = (linkedServiceJob?.parts || []).find((p: any) => p.partId === line.partId);
        if (!part) throw new AppError(404, `Part ${line.partId} not found on service job ${jId}.`);
        if (part.reversed) throw new AppError(400, `Part ${part.productName || line.partId} has been reversed and cannot be billed.`);
        if (part.invoiced && part.invoiceId !== draft._id) throw new AppError(409, `Part ${part.productName || line.partId} is already billed.`);

        // Mark part as invoiced on service job - stock was ALREADY decremented during consumption!
        await col(db, 'serviceJobs').updateOne(
          {_id: jId, tenantId, 'parts.partId': line.partId},
          {
            $set: {
              'parts.$.invoiced': true,
              'parts.$.invoiceId': draft._id,
              'parts.$.billingRatePaise': line.unitRatePaise,
              updatedAt: now,
            },
          },
          {session}
        );
        continue;
      }
      // No product stock posting. Quantity is used only for invoice calculation.
    }
    const settlement = await settleInvoiceOnIssue(db, identity, session, {...draft, totalPaise: totals.totalPaise}, input);
    const year = deriveFinancialYear(draft.invoiceDate);
    const invoiceNumber = await nextTenantSequence(db, tenantId,
      draft.invoiceKind === 'Service' ? 'ServiceInvoice' : 'Invoice', year,
      draft.invoiceKind === 'Service' ? 'SRV' : 'INV', session);
    const sellerSnapshot = Object.fromEntries(['name','phone','email','address','gst','state','stateCode','postalCode','bank','account','ifsc','declaration','logoFileId'].map(key => [key, seller[key] ?? '']));
    const issuedSnapshot = {schemaVersion: 1, invoiceNumber, invoiceDate: draft.invoiceDate, dueDate: draft.dueDate,
      seller: sellerSnapshot, customer: draft.customerSnapshot, billTo: draft.billTo, shipTo: draft.shipTo,
      invoiceKind: draft.invoiceKind, businessCategory: draft.businessCategory,
      inclusive: draft.inclusive, taxMode: draft.taxMode, placeOfSupply: draft.placeOfSupply,
      templateId: draft.templateId, templateRevision: draft.templateRevision, template: template.snapshot,
      orderReference: draft.orderReference, deliveryNote: draft.deliveryNote, dispatchThrough: draft.dispatchThrough,
      notes: draft.notes, lines, ...totals};
    const updated = await col<InvoiceDocument>(db, 'invoices').updateOne({_id: draft._id, tenantId, status: 'Draft', version: input.expectedVersion},
      {$set: {status: 'Issued', invoiceNumber, financialYear: deriveFinancialYear(draft.invoiceDate), issuedAt: now,
        issuedBy: identity.userId, lines, ...totals, originalTotalPaise: totals.totalPaise,
        allocatedReceiptPaise: settlement.receiptApplied, allocatedAdvancePaise: settlement.advanceUsed,
        allocatedCreditPaise: 0, allocatedPaidPaise: settlement.receiptApplied + settlement.advanceUsed,
        duePaise: settlement.duePaise, issuedSnapshot,
        paymentStatus: settlement.duePaise === 0 ? 'Paid' : settlement.duePaise < totals.totalPaise ? 'PartlyPaid' : 'Unpaid',
        updatedAt: now, updatedBy: identity.userId}, $inc: {version: 1}}, {session});
    if (updated.matchedCount !== 1) throw new AppError(409, 'Draft changed during issue.');
    if (draft.printJobId) {
      const linked = await col(db, 'printJobs').updateOne({
        _id: draft.printJobId, tenantId, customerId: draft.customerId, status: {$ne: 'Cancelled'},
        $or: [{invoiceId: {$exists: false}}, {invoiceId: null}, {invoiceId: ''}, {invoiceId: draft._id}],
      }, {$set: {invoiceId: draft._id, updatedAt: now, updatedBy: identity.userId}, $inc: {version: 1}}, {session});
      if (linked.matchedCount !== 1) throw new AppError(409, 'Print job was changed or already invoiced. Reload it before issuing.');
    }

    if (draft.serviceJobId) {
      await col(db, 'serviceJobs').updateOne(
        {_id: draft.serviceJobId, tenantId},
        {
          $set: {
            invoiceId: draft._id,
            status: linkedServiceJob?.status === 'Delivered' ? 'Delivered' : 'ReadyForDelivery',
            updatedAt: now,
            updatedBy: identity.userId,
          },
          $inc: {version: 1},
        },
        {session}
      );
    }
    if (draft.enquiryId) {
      await col(db, 'enquiries').updateOne(
        {_id: draft.enquiryId, tenantId},
        {
          $set: {
            status: 'Converted',
            convertedInvoiceId: draft._id,
            updatedAt: now,
            updatedBy: identity.userId,
          },
          $inc: {version: 1},
        },
        {session}
      );
    }

    for (const line of lines) {
      if (!line.warrantyMonths) continue;
      if (line.lineType === 'ConsumedPart') {
        const serials = line.serials || [];
        const units = serials.length > 0 ? serials.map(serial => ({serial, quantity: 1})) : [{serial: null, quantity: line.quantity}];
        for (const unit of units) {
          await col(db, 'warranties').insertOne({
            _id: uid('WAR'),
            tenantId,
            invoiceId: draft._id,
            invoiceNumber,
            invoiceLineId: line.lineId,
            customerId: draft.customerId,
            customerSnapshot: draft.customerSnapshot,
            productId: line.productId,
            productSnapshot: line.productSnapshot,
            serviceId: undefined,
            serviceJobId: draft.serviceJobId || line.serviceJobId,
            ...unit,
            serialNumber: unit.serial ?? undefined,
            startDate: draft.invoiceDate,
            endDate: addWarrantyMonths(draft.invoiceDate, line.warrantyMonths),
            warrantyMonths: line.warrantyMonths,
            status: 'Active',
            version: 1,
            attachmentIds: [],
            createdAt: now,
            createdBy: identity.userId,
          }, {session});
        }
        continue;
      }
      const units = line.lineType === 'Product' && line.productSnapshot?.isSerialTracked
        ? line.stockAllocations!.flatMap(a => a.serials.map(serial => ({serial, quantity: 1})))
        : [{serial: null, quantity: line.quantity}];
      for (const unit of units) await col(db, 'warranties').insertOne({_id: uid('WAR'), tenantId,
        invoiceId: draft._id, invoiceNumber, invoiceLineId: line.lineId, customerId: draft.customerId,
        customerSnapshot: draft.customerSnapshot, productId: line.productId,
        productSnapshot: line.productSnapshot, serviceId: line.serviceId, ...unit,
        serialNumber: unit.serial ?? undefined, startDate: draft.invoiceDate,
        endDate: addWarrantyMonths(draft.invoiceDate, line.warrantyMonths), warrantyMonths: line.warrantyMonths,
        status: 'Active', version: 1, attachmentIds: [], createdAt: now, createdBy: identity.userId}, {session});
    }
    if (draft.sourceQuotationId) {
      const r = await col(db, 'quotations').updateOne({_id: draft.sourceQuotationId, tenantId,
        convertedToInvoiceId: draft._id, status: {$in: ['Draft', 'Sent', 'Accepted']}},
        {$set: {status: 'Converted', updatedAt: now, updatedBy: identity.userId}, $inc: {version: 1}}, {session});
      if (r.matchedCount !== 1) throw new AppError(409, 'Quotation changed during issue.');
    }
    await recordAudit(db, {identity, action: 'invoice.issue', entityType: 'invoice', entityId: draft._id,
      detail: `Issued ${invoiceNumber}; due ${settlement.duePaise} paise`,
      after: {invoiceNumber, totalPaise: totals.totalPaise, duePaise: settlement.duePaise,
        receiptId: settlement.receiptId, advanceUsedPaise: settlement.advanceUsed,
        creditLimitOverride: input.creditLimitOverride, creditLimitOverrideReason: input.creditLimitOverrideReason}}, session);
    return {invoiceId: draft._id, invoiceNumber, totalPaise: totals.totalPaise, duePaise: settlement.duePaise, receiptId: settlement.receiptId};
  });
}

// 6. List Invoices / Quotations
export function buildSalesFilter(identity: Identity, raw: unknown, kind: 'invoices' | 'quotations') {
  const params = SalesListQuerySchema.parse(raw);
  const allowed = kind === 'invoices' ? ['Draft', 'Issued', 'Cancelled'] : ['Draft', 'Sent', 'Accepted', 'Rejected', 'Converted', 'Expired'];
  if (params.status && !allowed.includes(params.status)) throw new AppError(400, 'Invalid document status for this list.');
  const filter: Record<string, any> = {tenantId: identity.tenantId};
  if (params.status) filter.status = params.status;
  if (params.customerId) filter.customerId = params.customerId;
  if (params.dateFrom || params.dateTo) filter[kind === 'invoices' ? 'invoiceDate' : 'quotationDate'] = {
    ...(params.dateFrom && {$gte: params.dateFrom}), ...(params.dateTo && {$lte: params.dateTo})};
  if (params.hasDue === 'true') {
    if (kind !== 'invoices' || (params.status && params.status !== 'Issued')) throw new AppError(400, 'Only issued invoices have outstanding dues.');
    filter.status = 'Issued'; filter.duePaise = {$gt: 0};
  }
  if (params.search) {
    const escaped = params.search.replace(/[.*+?^${}()|[]\]/g, '\$&');
    filter.$or = [{[kind === 'invoices' ? 'invoiceNumber' : 'quotationNumber']: {$regex: escaped, $options: 'i'}},
      {'customerSnapshot.name': {$regex: escaped, $options: 'i'}}];
  }
  return {filter, page: params.page, limit: params.limit};
}

async function listSalesDocuments(db: Db, identity: Identity, raw: unknown, kind: 'invoices' | 'quotations') {
  const {filter, page, limit} = buildSalesFilter(identity, raw, kind);
  const [items, total] = await Promise.all([
    col(db, kind).find(filter).sort({createdAt: -1, _id: -1}).skip((page - 1) * limit).limit(limit).toArray(),
    col(db, kind).countDocuments(filter),
  ]);
  return {items, total, page, limit, totalPages: Math.ceil(total / limit)};
}

export const listInvoices = (db: Db, identity: Identity, raw: unknown) => listSalesDocuments(db, identity, raw, 'invoices');
export const listQuotations = (db: Db, identity: Identity, raw: unknown) => listSalesDocuments(db, identity, raw, 'quotations');

// 7. Get Invoice
export async function getInvoice(db: Db, identity: Identity, invoiceId: string) {
  const invoice = await col<InvoiceDocument>(db, 'invoices').findOne({_id: invoiceId, tenantId: identity.tenantId});
  if (!invoice) throw new AppError(404, 'Invoice not found.');
  const [receipts, warranties] = await Promise.all([
    col(db, 'customerReceipts').find({tenantId: identity.tenantId, invoiceId}).sort({date: -1}).limit(50).toArray(),
    col(db, 'warranties').find({tenantId: identity.tenantId, invoiceId}).sort({createdAt: -1}).limit(50).toArray(),
  ]);
  return {invoice, receipts, warranties};
}

// 8. Get Quotation
export async function getQuotation(db: Db, identity: Identity, quotationId: string) {
  const quotation = await col<QuotationDocument>(db, 'quotations').findOne({_id: quotationId, tenantId: identity.tenantId});
  if (!quotation) throw new AppError(404, 'Quotation not found.');
  return {quotation};
}

// 9. Get Sales Summary
export async function getSalesSummary(
  db: Db,
  identity: Identity,
  params: {hasDue?: boolean; customerId?: string} = {}
) {
  const tenantId = identity.tenantId;
  const matchInvoices: any = {tenantId};
  const matchQuotations: any = {tenantId};
  if (params.customerId) {
    matchInvoices.customerId = params.customerId;
    matchQuotations.customerId = params.customerId;
  }

  const [invoicesFacet, quotationsFacet, advancesRes] = await Promise.all([
    col<InvoiceDocument>(db, 'invoices').aggregate([
      {$match: matchInvoices},
      {
        $facet: {
          draftCount: [
            {$match: {status: 'Draft'}},
            {$count: 'count'},
          ],
          issuedCount: [
            {$match: {status: 'Issued'}},
            {$count: 'count'},
          ],
          cancelledCount: [
            {$match: {status: 'Cancelled'}},
            {$count: 'count'},
          ],
          totals: [
            {$match: {status: 'Issued'}},
            {
              $group: {
                _id: null,
                totalSalesPaise: {$sum: '$totalPaise'},
                totalPaidPaise: {$sum: '$allocatedPaidPaise'},
                totalDuePaise: {$sum: '$duePaise'},
              },
            },
          ],
          unpaidDue: [
            {$match: {status: 'Issued', duePaise: {$gt: 0}}},
            {$group: {_id: null, count: {$sum: 1}, sum: {$sum: '$duePaise'}}},
          ],
        },
      },
    ]).next(),
    col<QuotationDocument>(db, 'quotations').aggregate([
      {$match: matchQuotations},
      {
        $facet: {
          draftCount: [{$match: {status: 'Draft'}}, {$count: 'count'}],
          sentCount: [{$match: {status: 'Sent'}}, {$count: 'count'}],
          convertedCount: [{$match: {status: 'Converted'}}, {$count: 'count'}],
          expiredCount: [{$match: {status: 'Expired'}}, {$count: 'count'}],
          pipelineTotals: [
            {$match: {status: {$in: ['Draft', 'Sent', 'Accepted']}}},
            {$group: {_id: null, totalQuotedPaise: {$sum: '$totalPaise'}}},
          ],
        },
      },
    ]).next(),
    col(db, 'customerAdvances').aggregate([
      {$match: {tenantId, status: {$in: ['Available', 'PartlyConsumed']}}},
      {$group: {_id: null, totalRemainingPaise: {$sum: '$remainingAmountPaise'}}},
    ]).next(),
  ]);

  const invTotals = invoicesFacet?.totals?.[0] || {totalSalesPaise: 0, totalPaidPaise: 0, totalDuePaise: 0};
  const unpaidDue = invoicesFacet?.unpaidDue?.[0] || {count: 0, sum: 0};

  return {
    invoices: {
      draftCount: invoicesFacet?.draftCount?.[0]?.count ?? 0,
      issuedCount: invoicesFacet?.issuedCount?.[0]?.count ?? 0,
      cancelledCount: invoicesFacet?.cancelledCount?.[0]?.count ?? 0,
      totalSalesPaise: invTotals.totalSalesPaise,
      totalPaidPaise: invTotals.totalPaidPaise,
      totalDuePaise: invTotals.totalDuePaise,
      unpaidCount: unpaidDue.count,
      unpaidDuePaise: unpaidDue.sum,
    },
    quotations: {
      draftCount: quotationsFacet?.draftCount?.[0]?.count ?? 0,
      sentCount: quotationsFacet?.sentCount?.[0]?.count ?? 0,
      convertedCount: quotationsFacet?.convertedCount?.[0]?.count ?? 0,
      expiredCount: quotationsFacet?.expiredCount?.[0]?.count ?? 0,
      totalQuotedPaise: quotationsFacet?.pipelineTotals?.[0]?.totalQuotedPaise ?? 0,
    },
    totalCustomerAdvanceAvailablePaise: advancesRes?.totalRemainingPaise ?? 0,
  };
}
