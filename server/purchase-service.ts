import 'server-only';
import {ensureAccountBalances, initializeAccountBalances, signedAccountMovementPaise} from './account-initialization';
import {Db, ClientSession, Filter, Document} from 'mongodb';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {AppError, database, assertWriteIntegrity, mongo} from './db';
import {Identity, tenantFilter, digest} from './security';
import {recordAudit} from './audit';
import {uid} from '../lib/domain';
import {
  todayInKolkata,
  deriveFinancialYear,
  deriveAdvanceStatus,
  calculateLinePaise,
  calculatePurchaseDocumentTotals,
  prorateLineReturnValuation,
  PurchaseDocumentStatus,
  PurchaseBillStatus,
  PurchaseReceiptStatus,
  PurchasePaymentStatus,
  CreatePurchaseInput,
  UpdatePurchaseDraftInput,
  PostPurchaseBillInput,
  ConfirmPurchaseOrderInput,
  CancelPurchaseOrderInput,
  CloseRemainderInput,
  QuarantineStockInput,
  RestoreDefectiveStockInput,
  ReverseReceiptInput,
  RecordReceiveInput,
  ReceiveStockInput,
  RecordSupplierPaymentInput,
  AllocateAdvanceInput,
  SupplierReturnInput,
  AcceptReturnCreditNoteInput,
  CreateStandaloneCreditNoteInput,
  RecordSupplierRefundInput,
  ReverseOperationInput,
  RecordReceiveAndPayInput,
  PurchaseDocument,
  PurchaseProductLine,
  PurchaseChargeLine,
  PurchaseReceiptDocument,
  StockLotDocument,
  StockMovementDocument,
  SupplierPaymentDocument,
  SupplierPaymentComponent,
  SupplierAllocationDocument,
  SupplierAdvanceDocument,
  SupplierCreditNoteDocument,
  SupplierCreditNoteReversalDocument,
  SupplierReturnDocument,
  SupplierRefundDocument,
  SupplierRefundReversalDocument,
  TenantAccountBalanceDocument,
  TenantCounterDocument,
  IdempotencyOperationDocument,
  MAX_PURCHASE_LINES,
  MAX_PURCHASE_TOTAL_PAISE,
  MAX_EXPORT_ROWS,
} from './purchase-schema';
import {
  canonicalSerialKey,
  assertTenantSerialReady,
  assertSerialsAvailableForCreation,
  resolveSerialUnit,
  transitionSerialUnit,
} from './serial-identity';
import {lockBusinessDay, runInAttemptContext} from './business-day';

const purchaseTransaction = new AsyncLocalStorage<ClientSession>();

export const col = <T = any>(db: Db, name: string) => db.collection<any>(name);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Monotonic Sequence Generator
export async function nextTenantSequence(
  db: Db,
  tenantId: string,
  sequenceType: 'Purchase' | 'Receipt' | 'Payment' | 'PaymentVoucher' | 'CreditNote' | 'Return' | 'Refund' | 'Advance' | 'Quotation' | 'Invoice' | 'ServiceInvoice' | 'ServiceJob' | 'Enquiry',
  year: string,
  prefix: string,
  session?: ClientSession
): Promise<string> {
  const counterId = `CNT-${tenantId}-${sequenceType}-${year}`;
  const res = await col<TenantCounterDocument>(db, 'tenantCounters').findOneAndUpdate(
    {_id: counterId, tenantId, sequenceType, year},
    {$inc: {currentValue: 1}, $set: {updatedAt: new Date()}},
    {upsert: true, returnDocument: 'after', session}
  );
  const val = res?.currentValue || 1;
  return `${prefix}-${year}-${String(val).padStart(4, '0')}`;
}

// Cutoff and Posting Date Invariants
export async function assertAfterCutoffDate(db: Db, tenantId: string, dateStr?: string, label: string = 'Date') {
  if (!dateStr) return;
  const opening = await col(db, 'openingSetups').findOne({tenantId});
  if (opening && opening.status === 'Finalized' && opening.cutoffDate) {
    if (dateStr <= opening.cutoffDate) {
      throw new AppError(
        400,
        `Operational posting on or before cutoff date must be rejected. ${label} (${dateStr}) <= cutoff (${opening.cutoffDate})`
      );
    }
  }
}

export async function assertOperationalPostingAllowed(db: Db, tenantId: string, postingDate: string) {
  const today = todayInKolkata();
  if (postingDate !== today) {
    throw new AppError(400, `Operational posting date must be the current open business day in Asia/Kolkata (${today}). Received: ${postingDate}`);
  }
  await assertAfterCutoffDate(db, tenantId, postingDate, 'Operational posting date');
}

// Phase 3 Migration & Account Projection
export async function assertPhase3MigrationComplete(db: Db, tenantId: string, session?: ClientSession) {
  await ensureAccountBalances(db, tenantId, session ?? purchaseTransaction.getStore());
}

export async function migratePhase3AccountBalances(db: Db, identity: Identity) {
  const session = (await mongo()).startSession();
  try {
    return await session.withTransaction(async () => {
      const result = await initializeAccountBalances(db, identity.tenantId, session);
      await recordAudit(db, {identity, action: 'Initialize accounts', entityType: 'companySettings',
        entityId: identity.tenantId, detail: 'Reconciled Cash and Bank projections against account movements.',
        after: result}, session);
      return result;
    });
  } finally { await session.endSession(); }
}

export async function reconcileTenantAccountBalances(db: Db, identity: Identity) {
  const tenantId = identity.tenantId;
  const [cashBal, bankBal] = await Promise.all([
    col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').findOne({tenantId, account: 'Cash'}),
    col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').findOne({tenantId, account: 'Bank'}),
  ]);
  let cash = 0n, bank = 0n;
  for await (const m of col(db, 'accountMovements').find({tenantId}).batchSize(500)) {
    const value = BigInt(signedAccountMovementPaise(m));
    if (m.account === 'Cash') cash += value;
    else if (m.account === 'Bank' || m.account === 'Bank account') bank += value;
    else throw new AppError(409, 'Unrecognized account in financial history.');
  }
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (cash > max || cash < -max || bank > max || bank < -max)
    throw new AppError(409, 'Account ledger total exceeds supported paise range.');
  const cashSum = Number(cash), bankSum = Number(bank);
  return {
    cash: {projectedBalancePaise: cashBal?.balancePaise ?? null, ledgerSignedSumPaise: cashSum,
      reconciled: !!cashBal && cashBal.balancePaise === cashSum},
    bank: {projectedBalancePaise: bankBal?.balancePaise ?? null, ledgerSignedSumPaise: bankSum,
      reconciled: !!bankBal && bankBal.balancePaise === bankSum},
  };
}

// Tenant Attachment File Check
async function assertTenantFile(db: Db, tenantId: string, fileId?: string) {
  if (!fileId) return;
  const session = purchaseTransaction.getStore();
  const file = await col(db, 'files').findOne({_id: fileId, tenantId}, session ? {session} : {});
  if (!file) {
    throw new AppError(404, 'Attachment file not found or belongs to another company.');
  }
}

// Idempotency Runner
export async function executeIdempotentTransaction<T>(
  db: Db,
  identity: Identity,
  idempotencyKey: string,
  operationType: string,
  targetId: string | undefined,
  rawPayload: unknown,
  fn: (session: ClientSession) => Promise<T>
): Promise<T> {
  const parentSession = purchaseTransaction.getStore();
  if (parentSession) return fn(parentSession);

  assertWriteIntegrity();

  const tenantId = identity.tenantId;
  const requestFingerprint = digest(`${operationType}:${targetId || ''}:${JSON.stringify(rawPayload)}`);

  // Fast read check
  const existing = await col<IdempotencyOperationDocument>(db, 'idempotencyOperations').findOne({
    tenantId,
    idempotencyKey,
  });

  if (existing) {
    if (existing.requestFingerprint === requestFingerprint) {
      return existing.responseBody as T;
    }
    throw new AppError(409, 'Idempotency key was already used with a different request payload.');
  }

  const client = await mongo();
  const session = client.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      return runInAttemptContext(async () => {
        // In-transaction recheck
        const inTxCheck = await col<IdempotencyOperationDocument>(db, 'idempotencyOperations').findOne(
          {tenantId, idempotencyKey},
          {session}
        );
        if (inTxCheck) {
          if (inTxCheck.requestFingerprint === requestFingerprint) {
            result = inTxCheck.responseBody as T;
            return;
          }
          throw new AppError(409, 'Idempotency key was already used with a different request payload.');
        }

        result = await purchaseTransaction.run(session, () => fn(session));

        await col<IdempotencyOperationDocument>(db, 'idempotencyOperations').insertOne(
          {
            _id: `IDEMP-${tenantId}-${idempotencyKey}`,
            tenantId,
            idempotencyKey,
            operationType,
            targetId,
            requestFingerprint,
            statusCode: 200,
            responseBody: result,
            createdAt: new Date(),
          },
          {session}
        );
      });
    });

    return result!;
  } catch (err: any) {
    if (err?.code === 11000 && (err?.message?.includes('idempotencyOperations') || err?.keyPattern?.idempotencyKey)) {
      throw new AppError(409, 'Concurrent request with same idempotency key in progress. Please retry shortly.');
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function createPurchase(db: Db, identity: Identity, input: CreatePurchaseInput): Promise<PurchaseDocument> {
  const tenantId = identity.tenantId;
  const session = purchaseTransaction.getStore();
  if (input.postImmediately && !session) {
    const key =
      (input as any).idempotencyKey ||
      `create-post:${tenantId}:${input.supplierId}:${input.supplierInvoiceNumber || ''}:${input.supplierInvoiceDate || ''}:${input.orderDate}`;
    return executeIdempotentTransaction(
      db,
      identity,
      key,
      'PurchaseCreateAndPost',
      input.supplierId,
      input,
      async () => createPurchase(db, identity, input)
    );
  }
  await assertTenantFile(db, tenantId, input.attachmentFileId);

  const supplier = await col(db, 'suppliers').findOne({_id: input.supplierId, tenantId, status: 'Active'}, session ? {session} : {});
  if (!supplier) throw new AppError(400, 'Supplier not found or archived.');

  const lines: Array<PurchaseProductLine | PurchaseChargeLine> = [];
  for (let idx = 0; idx < input.lines.length; idx++) {
    const l = input.lines[idx];
    const lineId = l.lineId || uid('PLN');

    if (l.lineType === 'Product') {
      if (!l.productId) throw new AppError(400, `Line ${idx + 1}: productId is required for product line.`);
      const product = await col(db, 'products').findOne({_id: l.productId, tenantId, status: 'Active'}, session ? {session} : {});
      if (!product) throw new AppError(400, `Line ${idx + 1}: Product not found or archived.`);

      const linePaise = calculateLinePaise({
        quantity: l.quantityOrdered,
        unitCostPaise: l.unitCostPaise,
        discountType: l.discountType,
        discountValue: l.discountValue,
        taxBasisPoints: l.taxBasisPoints,
        inclusive: input.inclusive,
        taxMode: input.taxMode,
      });

      lines.push({
        clientLineKey: l.clientLineKey || lineId,
        lineId,
        lineType: 'Product',
        productId: l.productId,
        productSnapshot: {
          name: product.name,
          category: product.category || 'General',
          brand: product.brand || '',
          model: product.model || '',
          condition: product.condition || 'New',
          hsn: product.hsn || '',
          isSerialTracked: !!product.isSerialTracked,
        },
        quantityOrdered: l.quantityOrdered,
        quantityReceived: 0,
        quantityCancelled: 0,
        quantityReturned: 0,
        unitCostPaise: l.unitCostPaise,
        discountType: l.discountType,
        discountValue: l.discountValue,
        taxBasisPoints: l.taxBasisPoints,
        ...linePaise,
        creditedLiabilityPaise: 0,
        allocatedPaidPaise: 0,
        remainingDuePaise: linePaise.totalPaise,
      });
    } else {
      const linePaise = calculateLinePaise({
        quantity: 1,
        unitCostPaise: l.unitCostPaise,
        discountType: l.discountType,
        discountValue: l.discountValue,
        taxBasisPoints: l.taxBasisPoints,
        inclusive: input.inclusive,
        taxMode: input.taxMode,
      });

      lines.push({
        clientLineKey: l.clientLineKey || lineId,
        lineId,
        lineType: 'Charge',
        description: l.description || 'Service / Freight Charge',
        sac: l.sac || '996511',
        ratePaise: l.unitCostPaise,
        discountType: l.discountType,
        discountValue: l.discountValue,
        taxBasisPoints: l.taxBasisPoints,
        ...linePaise,
        creditedLiabilityPaise: 0,
        allocatedPaidPaise: 0,
        remainingDuePaise: linePaise.totalPaise,
      });
    }
  }

  const docTotals = calculatePurchaseDocumentTotals(lines);
  if (docTotals.totalPaise > MAX_PURCHASE_TOTAL_PAISE) {
    throw new AppError(400, 'Purchase total exceeds system maximum allowed (₹5 crore).');
  }

  const financialYear = deriveFinancialYear(input.supplierInvoiceDate || input.orderDate);
  const now = new Date();
  const yearStr = (now.getFullYear()).toString();
  const purchaseNumber = await nextTenantSequence(db, tenantId, 'Purchase', yearStr, 'PUR', session);
  const purchaseId = uid('PUR');

  let docStatus: PurchaseDocument['documentStatus'] = 'Draft';
  let bStatus: PurchaseDocument['billStatus'] = 'NotPosted';
  let pStatus: PurchaseDocument['paymentStatus'] = 'NotApplicable';
  let postingDate: string | undefined = undefined;
  let supInvNorm: string | undefined = undefined;

  if (input.postImmediately) {
    if (!input.supplierInvoiceNumber || !input.supplierInvoiceDate) {
      throw new AppError(400, 'Supplier invoice number and invoice date are required to post bill immediately.');
    }
    await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());
    await assertAfterCutoffDate(db, tenantId, input.supplierInvoiceDate, 'Supplier invoice date');
    if (session) {
      await lockBusinessDay(db, session, tenantId);
    }

    supInvNorm = input.supplierInvoiceNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const dup = await col(db, 'purchases').findOne({
      tenantId,
      supplierId: input.supplierId,
      financialYear,
      supplierInvoiceNumberNormalized: supInvNorm,
      billStatus: 'Posted',
    }, session ? {session} : {});
    if (dup) {
      throw new AppError(400, `Supplier bill number ${input.supplierInvoiceNumber} was already posted for this supplier in FY ${financialYear}.`);
    }

    docStatus = 'Confirmed';
    bStatus = 'Posted';
    pStatus = 'Unpaid';
    postingDate = todayInKolkata();
  }

  const purchaseDoc: PurchaseDocument = {
    _id: purchaseId,
    purchaseNumber,
    tenantId,
    version: 1,
    supplierId: input.supplierId,
    supplierSnapshot: {
      name: supplier.name,
      phone: supplier.phone || '',
      email: supplier.email || '',
      address: supplier.address || '',
      gst: supplier.gst || '',
      paymentTermsDays: supplier.terms ?? supplier.paymentTermsDays ?? 30,
    },
    supplierInvoiceNumber: input.supplierInvoiceNumber,
    supplierInvoiceNumberNormalized: supInvNorm,
    supplierInvoiceDate: input.supplierInvoiceDate,
    financialYear,
    orderDate: input.orderDate,
    postingDate,
    dueDate: input.dueDate || input.orderDate,

    documentStatus: docStatus,
    billStatus: bStatus,
    receiptStatus: 'NotReceived',
    paymentStatus: pStatus,

    inclusive: input.inclusive,
    taxMode: input.taxMode,
    placeOfSupply: input.placeOfSupply,
    currency: 'INR',
    notes: input.notes || '',
    attachmentFileId: input.attachmentFileId,

    lines,
    ...docTotals,

    createdAt: now,
    createdBy: identity.userId,
    updatedAt: now,
    updatedBy: identity.userId,
  };

  await col<PurchaseDocument>(db, 'purchases').insertOne(purchaseDoc, session ? {session} : {});
  await recordAudit(db, {
    identity,
    action: input.postImmediately ? 'purchase.createAndPost' : 'purchase.createDraft',
    entityType: 'purchase',
    entityId: purchaseId,
    after: purchaseDoc,
    detail: `Created purchase ${purchaseNumber} (${bStatus})`,
  }, session);

  return purchaseDoc;
}

// 2. Update Purchase Draft
export async function updatePurchaseDraft(
  db: Db,
  identity: Identity,
  purchaseId: string,
  input: UpdatePurchaseDraftInput
) {
  const tenantId = identity.tenantId;
  await assertTenantFile(db, tenantId, input.attachmentFileId);

  const existing = await col<PurchaseDocument>(db, 'purchases').findOne({_id: purchaseId, tenantId});
  if (!existing) throw new AppError(404, 'Purchase record not found.');
  if (existing.documentStatus !== 'Draft') {
    throw new AppError(400, 'Only draft purchases can be edited.');
  }
  if (existing.version !== input.version) {
    throw new AppError(409, 'This draft was updated by another session. Please reload to see latest version.');
  }

  const supplier = await col(db, 'suppliers').findOne({_id: input.supplierId, tenantId, status: 'Active'});
  if (!supplier) throw new AppError(400, 'Supplier not found or archived.');

  const lines: Array<PurchaseProductLine | PurchaseChargeLine> = [];
  for (let idx = 0; idx < input.lines.length; idx++) {
    const l = input.lines[idx];
    const lineId = l.lineId || uid('PLN');

    if (l.lineType === 'Product') {
      if (!l.productId) throw new AppError(400, `Line ${idx + 1}: productId is required.`);
      const product = await col(db, 'products').findOne({_id: l.productId, tenantId, status: 'Active'});
      if (!product) throw new AppError(400, `Line ${idx + 1}: Product not found or archived.`);

      const linePaise = calculateLinePaise({
        quantity: l.quantityOrdered,
        unitCostPaise: l.unitCostPaise,
        discountType: l.discountType,
        discountValue: l.discountValue,
        taxBasisPoints: l.taxBasisPoints,
        inclusive: input.inclusive,
        taxMode: input.taxMode,
      });

      lines.push({
        clientLineKey: l.clientLineKey || lineId,
        lineId,
        lineType: 'Product',
        productId: l.productId,
        productSnapshot: {
          name: product.name,
          category: product.category || 'General',
          brand: product.brand || '',
          model: product.model || '',
          condition: product.condition || 'New',
          hsn: product.hsn || '',
          isSerialTracked: !!product.isSerialTracked,
        },
        quantityOrdered: l.quantityOrdered,
        quantityReceived: 0,
        quantityCancelled: 0,
        quantityReturned: 0,
        unitCostPaise: l.unitCostPaise,
        discountType: l.discountType,
        discountValue: l.discountValue,
        taxBasisPoints: l.taxBasisPoints,
        ...linePaise,
        creditedLiabilityPaise: 0,
        allocatedPaidPaise: 0,
        remainingDuePaise: linePaise.totalPaise,
      });
    } else {
      const linePaise = calculateLinePaise({
        quantity: 1,
        unitCostPaise: l.unitCostPaise,
        discountType: l.discountType,
        discountValue: l.discountValue,
        taxBasisPoints: l.taxBasisPoints,
        inclusive: input.inclusive,
        taxMode: input.taxMode,
      });

      lines.push({
        clientLineKey: l.clientLineKey || lineId,
        lineId,
        lineType: 'Charge',
        description: l.description || 'Charge',
        sac: l.sac || '996511',
        ratePaise: l.unitCostPaise,
        discountType: l.discountType,
        discountValue: l.discountValue,
        taxBasisPoints: l.taxBasisPoints,
        ...linePaise,
        creditedLiabilityPaise: 0,
        allocatedPaidPaise: 0,
        remainingDuePaise: linePaise.totalPaise,
      });
    }
  }

  const docTotals = calculatePurchaseDocumentTotals(lines);
  const financialYear = deriveFinancialYear(input.supplierInvoiceDate || input.orderDate);
  const now = new Date();

  const res = await col<PurchaseDocument>(db, 'purchases').findOneAndUpdate(
    {_id: purchaseId, tenantId, version: input.version},
    {
      $set: {
        supplierId: input.supplierId,
        supplierSnapshot: {
          name: supplier.name,
          phone: supplier.phone || '',
          email: supplier.email || '',
          address: supplier.address || '',
          gst: supplier.gst || '',
          paymentTermsDays: supplier.terms ?? supplier.paymentTermsDays ?? 30,
        },
        supplierInvoiceNumber: input.supplierInvoiceNumber,
        supplierInvoiceDate: input.supplierInvoiceDate,
        financialYear,
        orderDate: input.orderDate,
        dueDate: input.dueDate || input.orderDate,
        inclusive: input.inclusive,
        taxMode: input.taxMode,
        placeOfSupply: input.placeOfSupply,
        notes: input.notes || '',
        attachmentFileId: input.attachmentFileId,
        lines,
        ...docTotals,
        updatedAt: now,
        updatedBy: identity.userId,
      },
      $inc: {version: 1},
    },
    {returnDocument: 'after'}
  );

  if (!res) {
    throw new AppError(409, 'Conflict: Document version changed during edit.');
  }

  await recordAudit(db, {
    identity,
    action: 'purchase.updateDraft',
    entityType: 'purchase',
    entityId: purchaseId,
    before: existing,
    after: res,
    detail: `Updated draft purchase ${res.purchaseNumber}`,
  });

  return res;
}

// 3. Confirm Purchase Order
export async function confirmPurchaseOrder(
  db: Db,
  identity: Identity,
  purchaseId: string,
  input?: ConfirmPurchaseOrderInput
) {
  const tenantId = identity.tenantId;

  const fn = async (session?: ClientSession) => {
    const existing = await col<PurchaseDocument>(db, 'purchases').findOne(
      {_id: purchaseId, tenantId},
      session ? {session} : {}
    );
    if (!existing) throw new AppError(404, 'Purchase record not found.');
    if (existing.documentStatus === 'Confirmed') {
      return existing; // idempotent
    }
    if (existing.documentStatus !== 'Draft') {
      throw new AppError(400, `Cannot confirm order with status ${existing.documentStatus}.`);
    }
    if (existing.billStatus !== 'NotPosted') {
      throw new AppError(400, 'Cannot confirm an order with a posted bill.');
    }

    const filter: Filter<PurchaseDocument> = {
      _id: purchaseId,
      tenantId,
      documentStatus: 'Draft',
      billStatus: 'NotPosted',
    };
    if (input?.expectedVersion !== undefined) {
      filter.version = input.expectedVersion;
    }

    const now = new Date();
    const res = await col<PurchaseDocument>(db, 'purchases').findOneAndUpdate(
      filter,
      {
        $set: {
          documentStatus: 'Confirmed',
          updatedAt: now,
          updatedBy: identity.userId,
        },
        $inc: {version: 1},
      },
      {returnDocument: 'after', session}
    );

    if (!res) {
      throw new AppError(409, 'Concurrent update: version changed.');
    }

    await recordAudit(db, {
      identity,
      action: 'purchase.confirmOrder',
      entityType: 'purchase',
      entityId: purchaseId,
      before: existing,
      after: res,
      detail: `Confirmed purchase order ${res.purchaseNumber}`,
    }, session);

    return res;
  };

  const key = input?.idempotencyKey || `confirm-po-${purchaseId}-${input?.expectedVersion ?? 0}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'ConfirmPurchaseOrder',
    purchaseId,
    input,
    fn
  );
}

// 4. Post Bill
export async function postPurchaseBill(
  db: Db,
  identity: Identity,
  purchaseId: string,
  input: PostPurchaseBillInput
) {
  const tenantId = identity.tenantId;
  await assertAfterCutoffDate(db, tenantId, input.supplierInvoiceDate, 'Supplier invoice date');

  const fn = async (session?: ClientSession) => {
    await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());
    const existing = await col<PurchaseDocument>(db, 'purchases').findOne(
      {_id: purchaseId, tenantId},
      session ? {session} : {}
    );
    if (!existing) throw new AppError(404, 'Purchase record not found.');
    if (['Posted', 'Credited', 'FullyCredited'].includes(existing.billStatus)) {
      throw new AppError(400, 'Bill is already posted.');
    }
    if (existing.documentStatus === 'Cancelled') {
      throw new AppError(400, 'Cannot post bill for a cancelled order.');
    }

    const supInvNorm = input.supplierInvoiceNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const financialYear = deriveFinancialYear(input.supplierInvoiceDate);

    const dup = await col(db, 'purchases').findOne({
      tenantId,
      supplierId: existing.supplierId,
      financialYear,
      supplierInvoiceNumberNormalized: supInvNorm,
      billStatus: 'Posted',
      _id: {$ne: purchaseId},
    }, session ? {session} : {});
    if (dup) {
      throw new AppError(400, `Supplier bill number ${input.supplierInvoiceNumber} was already posted for this supplier in FY ${financialYear}.`);
    }

    const filter: Filter<PurchaseDocument> = {
      _id: purchaseId,
      tenantId,
      billStatus: 'NotPosted',
    };
    if (input.expectedVersion !== undefined) {
      filter.version = input.expectedVersion;
    }

    const now = new Date();
    const res = await col<PurchaseDocument>(db, 'purchases').findOneAndUpdate(
      filter,
      {
        $set: {
          billStatus: 'Posted',
          documentStatus: 'Confirmed',
          paymentStatus: 'Unpaid',
          supplierInvoiceNumber: input.supplierInvoiceNumber,
          supplierInvoiceNumberNormalized: supInvNorm,
          supplierInvoiceDate: input.supplierInvoiceDate,
          postingDate: todayInKolkata(),
          dueDate: input.dueDate || existing.dueDate,
          notes: input.notes !== undefined ? input.notes : existing.notes,
          updatedAt: now,
          updatedBy: identity.userId,
        },
        $inc: {version: 1},
      },
      {returnDocument: 'after', session}
    );

    if (!res) {
      throw new AppError(409, 'Failed to post bill due to concurrent update: version changed.');
    }

    await lockBusinessDay(db, session!, tenantId);

    await recordAudit(db, {
      identity,
      action: 'purchase.postBill',
      entityType: 'purchase',
      entityId: purchaseId,
      before: existing,
      after: res,
      detail: `Posted bill ${res.purchaseNumber} (${input.supplierInvoiceNumber})`,
    }, session);

    return res;
  };

  const supInvNorm = input.supplierInvoiceNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const key =
    input.idempotencyKey ||
    `post-bill:${tenantId}:${purchaseId}:${input.expectedVersion ?? 0}:${supInvNorm}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'PostPurchaseBill',
    purchaseId,
    input,
    fn
  );
}

// 5. Cancel Purchase Order
export async function cancelPurchaseOrder(
  db: Db,
  identity: Identity,
  purchaseId: string,
  input?: CancelPurchaseOrderInput
) {
  const tenantId = identity.tenantId;

  const fn = async (session?: ClientSession) => {
    const existing = await col<PurchaseDocument>(db, 'purchases').findOne(
      {_id: purchaseId, tenantId},
      session ? {session} : {}
    );
    if (!existing) throw new AppError(404, 'Purchase record not found.');
    if (existing.documentStatus === 'Cancelled') {
      return existing; // idempotent
    }
    if (['Posted', 'Credited', 'FullyCredited'].includes(existing.billStatus)) {
      throw new AppError(400, 'Cannot cancel a purchase order with a posted supplier bill. Use credit notes or returns instead.');
    }
    if (existing.receiptStatus !== 'NotReceived') {
      throw new AppError(400, 'Cannot cancel an order that has received goods.');
    }

    const filter: Filter<PurchaseDocument> = {
      _id: purchaseId,
      tenantId,
      billStatus: 'NotPosted',
      receiptStatus: 'NotReceived',
      documentStatus: {$ne: 'Cancelled'},
    };
    if (input?.expectedVersion !== undefined) {
      filter.version = input.expectedVersion;
    }

    const now = new Date();
    const res = await col<PurchaseDocument>(db, 'purchases').findOneAndUpdate(
      filter,
      {
        $set: {
          documentStatus: 'Cancelled',
          updatedAt: now,
          updatedBy: identity.userId,
        },
        $inc: {version: 1},
      },
      {returnDocument: 'after', session}
    );

    if (!res) {
      throw new AppError(409, 'Failed to cancel order due to concurrent update: version changed.');
    }

    await recordAudit(db, {
      identity,
      action: 'purchase.cancelOrder',
      entityType: 'purchase',
      entityId: purchaseId,
      before: existing,
      after: res,
      detail: `Cancelled purchase order ${res.purchaseNumber}`,
    }, session);

    return res;
  };

  const key = input?.idempotencyKey || `cancel-po-${purchaseId}-${input?.expectedVersion ?? 0}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'CancelPurchaseOrder',
    purchaseId,
    input,
    fn
  );
}

// 6. Close Remainder (ClosedPartlyReceived)
export async function closePurchaseRemainder(
  db: Db,
  identity: Identity,
  purchaseId: string,
  input?: CloseRemainderInput
) {
  const tenantId = identity.tenantId;

  const fn = async (session?: ClientSession) => {
    const existing = await col<PurchaseDocument>(db, 'purchases').findOne(
      {_id: purchaseId, tenantId},
      session ? {session} : {}
    );
    if (!existing) throw new AppError(404, 'Purchase record not found.');
    if (existing.receiptStatus === 'ClosedPartlyReceived') {
      return existing; // idempotent
    }
    if (existing.receiptStatus !== 'PartlyReceived') {
      throw new AppError(400, 'Remainder closure can only be performed on partly received orders.');
    }

    // Update line quantityCancelled
    const updatedLines = existing.lines.map((l: any) => {
      if (l.lineType === 'Product') {
        const remaining = Math.max(0, l.quantityOrdered - l.quantityReceived);
        return {...l, quantityCancelled: remaining};
      }
      return l;
    });

    const filter: Filter<PurchaseDocument> = {
      _id: purchaseId,
      tenantId,
      receiptStatus: 'PartlyReceived',
    };
    if (input?.expectedVersion !== undefined) {
      filter.version = input.expectedVersion;
    }

    const now = new Date();
    const res = await col<PurchaseDocument>(db, 'purchases').findOneAndUpdate(
      filter,
      {
        $set: {
          receiptStatus: 'ClosedPartlyReceived',
          lines: updatedLines,
          updatedAt: now,
          updatedBy: identity.userId,
        },
        $inc: {version: 1},
      },
      {returnDocument: 'after', session}
    );

    if (!res) {
      throw new AppError(409, 'Failed to close remainder due to concurrent update: version changed.');
    }

    await recordAudit(db, {
      identity,
      action: 'purchase.closeRemainder',
      entityType: 'purchase',
      entityId: purchaseId,
      before: existing,
      after: res,
      detail: `Closed remainder on purchase ${res.purchaseNumber}: ${input?.reason || 'Closed remainder by user'}`,
    }, session);

    return res;
  };

  const key = input?.idempotencyKey || `close-rem-${purchaseId}-${input?.expectedVersion ?? 0}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'CloseRemainder',
    purchaseId,
    input,
    fn
  );
}

// 6. Receive Goods Stock
export async function receivePurchaseStock(
  db: Db,
  identity: Identity,
  purchaseId: string,
  input: ReceiveStockInput
) {
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'ReceiveStock',
    purchaseId,
    input,
    async session => {
      await assertOperationalPostingAllowed(db, tenantId, input.receiptDate);
      await lockBusinessDay(db, session, tenantId, {date: input.receiptDate});
      const purchase = await col<PurchaseDocument>(db, 'purchases').findOne({_id: purchaseId, tenantId}, {session});
      if (!purchase) throw new AppError(404, 'Purchase record not found.');
      if (!['Posted', 'Credited', 'FullyCredited'].includes(purchase.billStatus)) {
        throw new AppError(400, 'Goods receipt requires the supplier bill to be posted first.');
      }
      if (purchase.receiptStatus === 'Received' || purchase.receiptStatus === 'ClosedPartlyReceived') {
        throw new AppError(400, `Cannot receive stock: purchase receipt status is ${purchase.receiptStatus}.`);
      }

      const receiptId = uid('RCP');
      const yearStr = new Date().getFullYear().toString();
      const receiptNumber = await nextTenantSequence(db, tenantId, 'Receipt', yearStr, 'RCP', session);

      const receiptLines: PurchaseReceiptDocument['lines'] = [];
      const lotInserts: StockLotDocument[] = [];
      const serialInserts: Array<{
        _id: string;
        tenantId: string;
        productId: string;
        lotId: string;
        serialOriginal: string;
        serialNormalized: string;
        status: 'InStock' | 'Sold' | 'Reserved' | 'Returned' | 'Defective' | 'Removed';
        version: number;
        createdAt: Date;
        updatedAt: Date;
      }> = [];
      const movementInserts: StockMovementDocument[] = [];

      for (const rl of input.lines) {
        const line = purchase.lines.find((l: any) => l.lineId === rl.lineId);
        if (!line || line.lineType !== 'Product') {
          throw new AppError(400, `Line ${rl.lineId} not found or is not a product line.`);
        }

        const remainingToReceive = line.quantityOrdered - line.quantityReceived - line.quantityCancelled;
        if (rl.quantityReceived > remainingToReceive) {
          throw new AppError(
            400,
            `Cannot receive ${rl.quantityReceived} units for line ${line.productSnapshot.name}. Remaining unreceived is ${remainingToReceive}.`
          );
        }

        let canonicalMap = new Map<string, string>();
        if (line.productSnapshot.isSerialTracked) {
          if (!rl.serials || rl.serials.length !== rl.quantityReceived) {
            throw new AppError(
              400,
              `Serialized product ${line.productSnapshot.name} requires exactly ${rl.quantityReceived} serial numbers.`
            );
          }
          canonicalMap = await assertSerialsAvailableForCreation(db, session, tenantId, rl.serials);
        }

        const lotId = uid('LOT');
        const now = new Date();

        lotInserts.push({
          _id: lotId,
          tenantId,
          productId: line.productId,
          lotType: 'Purchase',
          purchaseId,
          purchaseLineId: line.lineId,
          purchaseReceiptId: receiptId,
          receivedDate: input.receiptDate,
          costPaise: line.unitCostPaise,
          sourceReference: purchase.purchaseNumber,
          quantityReceived: rl.quantityReceived,
          quantityRemaining: rl.quantityReceived,
          quantitySellable: rl.quantityReceived,
          quantityReserved: 0,
          quantityDefective: 0,
          quantityReturned: 0,
          quantitySold: 0,
          createdAt: now,
          updatedAt: now,
        });

        if (line.productSnapshot.isSerialTracked && rl.serials) {
          for (const s of rl.serials) {
            serialInserts.push({
              _id: uid('SER'),
              tenantId,
              productId: line.productId,
              lotId,
              serialOriginal: s.trim(),
              serialNormalized: canonicalMap.get(s)!,
              status: 'InStock',
              version: 1,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        movementInserts.push({
          _id: uid('MOV'),
          tenantId,
          date: input.receiptDate,
          productId: line.productId,
          lotId,
          qty: rl.quantityReceived, // Signed integer +N
          onHandDelta: rl.quantityReceived,
          sellableDelta: rl.quantityReceived,
          defectiveDelta: 0,
          reason: 'Goods receipt',
          reference: receiptNumber,
          serials: rl.serials,
          idempotencyKey: `${input.idempotencyKey}:${line.lineId}`,
          createdAt: now,
          createdBy: identity.userId,
        });

        receiptLines.push({
          lineId: line.lineId,
          productId: line.productId,
          lotId,
          quantityReceived: rl.quantityReceived,
          serials: rl.serials || [],
        });
      }

      // Bulk write lots, serials, movements
      if (lotInserts.length) await col(db, 'stockLots').insertMany(lotInserts, {session});
      if (serialInserts.length) {
        try {
          await col(db, 'serialUnits').insertMany(serialInserts, {session});
        } catch (err: any) {
          if (err?.code === 11000) {
            throw new AppError(409, 'One or more serial numbers are already registered in company inventory.');
          }
          throw err;
        }
      }
      if (movementInserts.length) await col(db, 'stockMovements').insertMany(movementInserts, {session});

      // Update purchase lines quantityReceived
      for (const rl of input.lines) {
        const updateRes = await col(db, 'purchases').updateOne(
          {_id: purchaseId, tenantId},
          {
            $inc: {'lines.$[elem].quantityReceived': rl.quantityReceived},
            $set: {updatedAt: new Date(), updatedBy: identity.userId},
          },
          {
            arrayFilters: [
              {
                'elem.lineId': rl.lineId,
                'elem.quantityReceived': {$lte: 10000},
              },
            ],
            session,
          }
        );
        if (updateRes.modifiedCount === 0) {
          throw new AppError(409, 'Failed to update line received quantity.');
        }
      }

      // Check document overall receiptStatus
      const reloaded = await col<PurchaseDocument>(db, 'purchases').findOne({_id: purchaseId, tenantId}, {session});
      const allFullyReceived = reloaded!.lines.every((l: any) => {
        if (l.lineType !== 'Product') return true;
        return l.quantityReceived + l.quantityCancelled >= l.quantityOrdered;
      });

      const nextReceiptStatus: PurchaseReceiptStatus = allFullyReceived ? 'Received' : 'PartlyReceived';
      await col(db, 'purchases').updateOne(
        {_id: purchaseId, tenantId},
        {$set: {receiptStatus: nextReceiptStatus, updatedAt: new Date()}},
        {session}
      );

      const receiptDoc: PurchaseReceiptDocument = {
        _id: receiptId,
        receiptNumber,
        tenantId,
        purchaseId,
        purchaseNumber: purchase.purchaseNumber,
        receiptDate: input.receiptDate,
        notes: input.notes || '',
        idempotencyKey: input.idempotencyKey,
        lines: receiptLines,
        createdAt: new Date(),
        createdBy: identity.userId,
      };

      await col(db, 'purchaseReceipts').insertOne(receiptDoc, {session});
      return receiptDoc;
    }
  );
}

// Shared domain predicates for reversals
export interface CanReverseResult {
  canReverse: boolean;
  reverseBlockReason?: string;
}

export async function canReversePayment(
  db: Db,
  tenantId: string,
  payment: SupplierPaymentDocument,
  session?: ClientSession
): Promise<CanReverseResult> {
  if (payment.isReversed) {
    return { canReverse: false, reverseBlockReason: 'Already reversed' };
  }

  // Check advances created from this payment
  const advances = await col<SupplierAdvanceDocument>(db, 'supplierAdvances')
    .find({ paymentId: payment._id, tenantId }, session ? { session } : {})
    .toArray();
  for (const adv of advances) {
    if (adv.allocatedPaise > 0 || adv.refundedPaise > 0 || adv.remainingAmountPaise < adv.originalAmountPaise) {
      return { canReverse: false, reverseBlockReason: 'Advance has downstream consumption' };
    }
  }

  // Check direct allocations from this payment
  const directAllocs = await col<SupplierAllocationDocument>(db, 'supplierAllocations')
    .find({ sourceId: payment._id, tenantId, isReversal: false }, session ? { session } : {})
    .toArray();
  for (const da of directAllocs) {
    const rev = await col(db, 'supplierAllocations').findOne(
      { reversesAllocationId: da._id, tenantId },
      session ? { session } : {}
    );
    if (!rev) {
      return { canReverse: false, reverseBlockReason: 'Direct allocations exist — reverse them first' };
    }
  }

  return { canReverse: true };
}

export async function canReverseAllocation(
  db: Db,
  tenantId: string,
  allocation: SupplierAllocationDocument,
  session?: ClientSession
): Promise<CanReverseResult> {
  if (allocation.isReversal) {
    return { canReverse: false, reverseBlockReason: 'Already reversed' };
  }
  const alreadyReversed = await col(db, 'supplierAllocations').findOne(
    { tenantId, isReversal: true, reversesAllocationId: allocation._id },
    session ? { session } : {}
  );
  if (alreadyReversed) {
    return { canReverse: false, reverseBlockReason: 'Already reversed' };
  }
  return { canReverse: true };
}

export async function canReverseCreditNote(
  db: Db,
  tenantId: string,
  creditNote: SupplierCreditNoteDocument,
  session?: ClientSession
): Promise<CanReverseResult> {
  if (creditNote.isReversed) {
    return { canReverse: false, reverseBlockReason: 'Already reversed' };
  }
  if (creditNote.advanceId) {
    const adv = await col<SupplierAdvanceDocument>(db, 'supplierAdvances').findOne(
      { _id: creditNote.advanceId, tenantId },
      session ? { session } : {}
    );
    if (adv && (adv.allocatedPaise > 0 || adv.refundedPaise > 0 || adv.remainingAmountPaise < adv.originalAmountPaise)) {
      return { canReverse: false, reverseBlockReason: 'Generated advance has downstream use' };
    }
  }
  return { canReverse: true };
}

export async function canReverseRefund(
  db: Db,
  tenantId: string,
  refund: SupplierRefundDocument,
  session?: ClientSession
): Promise<CanReverseResult> {
  if (refund.isReversed) {
    return { canReverse: false, reverseBlockReason: 'Already reversed' };
  }
  const balDoc = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').findOne(
    { _id: `BAL-${tenantId}-${refund.account}`, tenantId },
    session ? { session } : {}
  );
  if (!balDoc || balDoc.balancePaise < refund.amountPaise) {
    return { canReverse: false, reverseBlockReason: `Insufficient ${refund.account} balance` };
  }
  return { canReverse: true };
}

export async function canReverseReceipt(
  db: Db,
  tenantId: string,
  receipt: PurchaseReceiptDocument,
  session?: ClientSession
): Promise<CanReverseResult> {
  if (receipt.isReversed) {
    return { canReverse: false, reverseBlockReason: 'Already reversed' };
  }
  for (const line of receipt.lines) {
    const lot = await col<StockLotDocument>(db, 'stockLots').findOne(
      { _id: line.lotId, tenantId },
      session ? { session } : {}
    );
    if (!lot) continue;
    if (
      lot.quantitySellable !== line.quantityReceived ||
      lot.quantityDefective > 0 ||
      lot.quantitySold > 0 ||
      lot.quantityReserved > 0 ||
      (lot.quantityRemoved ?? 0) > 0 ||
      (lot.quantityConsumed ?? 0) > 0 ||
      lot.quantityReturned > 0
    ) {
      return { canReverse: false, reverseBlockReason: 'Stock has downstream movements' };
    }
    if (line.serials && line.serials.length > 0) {
      for (const s of line.serials) {
        try {
          await resolveSerialUnit(db, session, tenantId, s, {
            lotId: lot._id,
            expectedStatus: 'InStock',
          });
        } catch {
          return { canReverse: false, reverseBlockReason: 'Stock has downstream movements' };
        }
      }
    }
  }
  return { canReverse: true };
}

export async function canReverseSupplierReturn(
  db: Db,
  tenantId: string,
  supplierReturn: SupplierReturnDocument,
  session?: ClientSession
): Promise<CanReverseResult> {
  if (supplierReturn.isReversed) {
    return { canReverse: false, reverseBlockReason: 'Already reversed' };
  }
  // Split-return rounding depends on the preceding active quantity. Undo in
  // reverse order rather than silently repricing later credit notes.
  const laterReturn = await col<SupplierReturnDocument>(db, 'supplierReturns').findOne({
    tenantId, purchaseId: supplierReturn.purchaseId, purchaseLineId: supplierReturn.purchaseLineId,
    _id: {$ne: supplierReturn._id}, isReversed: {$ne: true}, createdAt: {$gte: supplierReturn.createdAt},
  }, session ? {session} : {});
  if (laterReturn) return {canReverse: false, reverseBlockReason: 'Reverse later returns on this purchase line first to preserve credit rounding.'};
  if (supplierReturn.status === 'CreditAccepted' || supplierReturn.status === 'Completed') {
    if (supplierReturn.creditNoteId) {
      const cn = await col<SupplierCreditNoteDocument>(db, 'supplierCreditNotes').findOne(
        { _id: supplierReturn.creditNoteId, tenantId },
        session ? { session } : {}
      );
      if (cn && !cn.isReversed) {
        return { canReverse: false, reverseBlockReason: 'Credit note has downstream use' };
      }
    }
  }
  return { canReverse: true };
}

// Reverse Purchase Receipt
export async function reversePurchaseReceipt(
  db: Db,
  identity: Identity,
  receiptId: string,
  input: ReverseReceiptInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);

  const key = input.idempotencyKey || `rev-rcp-${receiptId}-${Date.now()}-${randomUUID()}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'ReverseReceipt',
    receiptId,
    input,
    async session => {
      await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());
      await lockBusinessDay(db, session, tenantId);
      const receipt = await col<PurchaseReceiptDocument>(db, 'purchaseReceipts').findOne(
        { _id: receiptId, tenantId },
        { session }
      );
      if (!receipt) throw new AppError(404, 'Purchase receipt not found.');

      const eligibility = await canReverseReceipt(db, tenantId, receipt, session);
      if (!eligibility.canReverse) {
        throw new AppError(400, eligibility.reverseBlockReason || 'Cannot reverse receipt.');
      }

      const now = new Date();

      for (const line of receipt.lines) {
        const lot = await col<StockLotDocument>(db, 'stockLots').findOne(
          { _id: line.lotId, tenantId },
          { session }
        );
        if (!lot) continue;

        const decDefective = Math.min(lot.quantityDefective, line.quantityReceived);
        const decSellable = line.quantityReceived - decDefective;

        await col<StockLotDocument>(db, 'stockLots').updateOne(
          { _id: lot._id, tenantId },
          {
            $inc: {
              quantityReceived: -line.quantityReceived,
              quantityRemaining: -decSellable,
              quantitySellable: -decSellable,
              quantityDefective: -decDefective,
            },
            $set: { updatedAt: now },
          },
          { session }
        );

        if (line.serials && line.serials.length > 0) {
          for (const s of line.serials) {
            const {unit} = await resolveSerialUnit(db, session, tenantId, s, {
              lotId: lot._id,
              expectedStatus: 'InStock',
            });
            await transitionSerialUnit(db, session, unit._id, {
              transition: 'SupplierReturn',
              expected: {
                tenantId,
                productId: line.productId,
                lotId: lot._id,
                status: 'InStock',
                version: unit.version,
              },
              nextState: {
                status: 'Returned',
              },
            });
          }
        }

        const movDoc: StockMovementDocument = {
          _id: uid('MOV'),
          tenantId,
          date: todayInKolkata(),
          productId: line.productId,
          lotId: lot._id,
          qty: -line.quantityReceived,
          onHandDelta: -line.quantityReceived,
          sellableDelta: -decSellable,
          defectiveDelta: -decDefective,
          reason: `Receipt reversal: ${input.reason}`,
          reference: receipt.receiptNumber,
          serials: line.serials,
          createdAt: now,
          createdBy: identity.userId,
        };
        await col(db, 'stockMovements').insertOne(movDoc, { session });

        await col(db, 'purchases').updateOne(
          { _id: receipt.purchaseId, tenantId },
          {
            $inc: { 'lines.$[elem].quantityReceived': -line.quantityReceived },
          },
          {
            arrayFilters: [{ 'elem.lineId': line.lineId }],
            session,
          }
        );
      }

      const purchase = await col<PurchaseDocument>(db, 'purchases').findOne(
        { _id: receipt.purchaseId, tenantId },
        { session }
      );
      if (purchase) {
        let totalOrd = 0;
        let totalRec = 0;
        for (const l of purchase.lines) {
          if (l.lineType === 'Product') {
            totalOrd += l.quantityOrdered;
            totalRec += l.quantityReceived;
          }
        }
        let nextReceiptStatus: PurchaseReceiptStatus = 'NotReceived';
        if (totalRec >= totalOrd && totalOrd > 0) {
          nextReceiptStatus = 'Received';
        } else if (totalRec > 0) {
          nextReceiptStatus = 'PartlyReceived';
        } else {
          nextReceiptStatus = 'NotReceived';
        }

        await col(db, 'purchases').updateOne(
          { _id: receipt.purchaseId, tenantId },
          {
            $set: { receiptStatus: nextReceiptStatus, updatedAt: now, updatedBy: identity.userId },
            $inc: { version: 1 },
          },
          { session }
        );
      }

      const updatedReceipt = await col<PurchaseReceiptDocument>(db, 'purchaseReceipts').findOneAndUpdate(
        { _id: receiptId, tenantId },
        {
          $set: {
            isReversed: true,
            reversalReason: input.reason,
            reversedAt: now,
            reversedBy: identity.userId,
          },
        },
        { returnDocument: 'after', session }
      );

      await recordAudit(db, {
        identity,
        action: 'purchase.reverseReceipt',
        entityType: 'receipt',
        entityId: receiptId,
        before: receipt,
        after: updatedReceipt,
        detail: `Reversed purchase receipt ${receipt.receiptNumber}`,
      }, session);

      return updatedReceipt;
    }
  );
}

// Quarantine Stock Lot
export async function quarantineStockLot(
  db: Db,
  identity: Identity,
  input: QuarantineStockInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);
  await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());

  const key = input.idempotencyKey || `quar-${input.lotId}-${Date.now()}-${randomUUID()}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'QuarantineStock',
    input.lotId,
    input,
    async session => {
      await lockBusinessDay(db, session, tenantId);
      const lot = await col<StockLotDocument>(db, 'stockLots').findOne(
        { _id: input.lotId, tenantId },
        { session }
      );
      if (!lot) throw new AppError(404, 'Stock lot not found.');
      if (lot.quantitySellable < input.quantity) {
        throw new AppError(400, `Insufficient sellable stock (${lot.quantitySellable}) to quarantine ${input.quantity} units.`);
      }

      const resolvedSerials: Array<{unit: any; version: number}> = [];
      if (input.serials && input.serials.length > 0) {
        if (input.serials.length !== input.quantity) {
          throw new AppError(400, 'Serials count must match quarantine quantity.');
        }
        for (const s of input.serials) {
          const res = await resolveSerialUnit(db, session, tenantId, s, {
            lotId: lot._id,
            expectedStatus: 'InStock',
          });
          resolvedSerials.push(res);
        }
      }

      const now = new Date();
      const updatedLot = await col<StockLotDocument>(db, 'stockLots').findOneAndUpdate(
        {
          _id: input.lotId,
          tenantId,
          quantitySellable: { $gte: input.quantity },
        },
        {
          $inc: { quantityRemaining: -input.quantity, quantitySellable: -input.quantity, quantityDefective: input.quantity },
          $set: { updatedAt: now },
        },
        { returnDocument: 'after', session }
      );

      if (!updatedLot) {
        throw new AppError(409, 'Failed to quarantine stock due to concurrent update.');
      }

      if (resolvedSerials.length > 0) {
        for (const item of resolvedSerials) {
          await transitionSerialUnit(db, session, item.unit._id, {
            transition: 'Quarantine',
            expected: {
              tenantId,
              productId: lot.productId,
              lotId: lot._id,
              status: 'InStock',
              version: item.version,
            },
            nextState: {
              status: 'Defective',
            },
          });
        }
      }

      // Internal condition transfer movement (qty: 0, onHandDelta: 0)
      const movDoc: StockMovementDocument = {
        _id: uid('MOV'),
        tenantId,
        date: todayInKolkata(),
        productId: lot.productId,
        lotId: lot._id,
        qty: 0,
        onHandDelta: 0,
        sellableDelta: -input.quantity,
        defectiveDelta: input.quantity,
        reason: `Stock quarantine: ${input.reason}`,
        reference: lot.sourceReference || lot._id,
        serials: input.serials,
        createdAt: now,
        createdBy: identity.userId,
      };
      await col(db, 'stockMovements').insertOne(movDoc, { session });

      await recordAudit(db, {
        identity,
        action: 'inventory.quarantine',
        entityType: 'stockLot',
        entityId: input.lotId,
        before: lot,
        after: updatedLot,
        detail: `Quarantined ${input.quantity} units in lot ${input.lotId}: ${input.reason}`,
      }, session);

      return updatedLot;
    }
  );
}

// Restore Defective Stock
export async function restoreDefectiveStock(
  db: Db,
  identity: Identity,
  input: RestoreDefectiveStockInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);
  await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());

  const key = input.idempotencyKey || `rest-${input.lotId}-${Date.now()}-${randomUUID()}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'RestoreStock',
    input.lotId,
    input,
    async session => {
      await lockBusinessDay(db, session, tenantId);
      const lot = await col<StockLotDocument>(db, 'stockLots').findOne(
        { _id: input.lotId, tenantId },
        { session }
      );
      if (!lot) throw new AppError(404, 'Stock lot not found.');
      if (lot.quantityDefective < input.quantity) {
        throw new AppError(400, `Insufficient defective stock (${lot.quantityDefective}) to restore ${input.quantity} units.`);
      }

      const resolvedSerials: Array<{unit: any; version: number}> = [];
      if (input.serials && input.serials.length > 0) {
        if (input.serials.length !== input.quantity) {
          throw new AppError(400, 'Serials count must match restore quantity.');
        }
        for (const s of input.serials) {
          const res = await resolveSerialUnit(db, session, tenantId, s, {
            lotId: lot._id,
            expectedStatus: 'Defective',
          });
          resolvedSerials.push(res);
        }
      }

      const now = new Date();
      const updatedLot = await col<StockLotDocument>(db, 'stockLots').findOneAndUpdate(
        {
          _id: input.lotId,
          tenantId,
          quantityDefective: { $gte: input.quantity },
        },
        {
          $inc: { quantityRemaining: input.quantity, quantitySellable: input.quantity, quantityDefective: -input.quantity },
          $set: { updatedAt: now },
        },
        { returnDocument: 'after', session }
      );

      if (!updatedLot) {
        throw new AppError(409, 'Failed to restore stock due to concurrent update.');
      }

      if (resolvedSerials.length > 0) {
        for (const item of resolvedSerials) {
          await transitionSerialUnit(db, session, item.unit._id, {
            transition: 'Restore',
            expected: {
              tenantId,
              productId: lot.productId,
              lotId: lot._id,
              status: 'Defective',
              version: item.version,
            },
            nextState: {
              status: 'InStock',
            },
          });
        }
      }

      // Internal condition transfer movement (qty: 0, onHandDelta: 0)
      const movDoc: StockMovementDocument = {
        _id: uid('MOV'),
        tenantId,
        date: todayInKolkata(),
        productId: lot.productId,
        lotId: lot._id,
        qty: 0,
        onHandDelta: 0,
        sellableDelta: input.quantity,
        defectiveDelta: -input.quantity,
        reason: `Stock restore: ${input.reason}`,
        reference: lot.sourceReference || lot._id,
        serials: input.serials,
        createdAt: now,
        createdBy: identity.userId,
      };
      await col(db, 'stockMovements').insertOne(movDoc, { session });

      await recordAudit(db, {
        identity,
        action: 'inventory.restore',
        entityType: 'stockLot',
        entityId: input.lotId,
        before: lot,
        after: updatedLot,
        detail: `Restored ${input.quantity} defective units in lot ${input.lotId}: ${input.reason}`,
      }, session);

      return updatedLot;
    }
  );
}

// Reverse Supplier Return
export async function reverseSupplierReturn(
  db: Db,
  identity: Identity,
  returnId: string,
  input: ReverseOperationInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);
  await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());

  const key = input.idempotencyKey || `rev-ret-${returnId}-${Date.now()}-${randomUUID()}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'ReverseReturn',
    returnId,
    input,
    async session => {
      const ret = await col<SupplierReturnDocument>(db, 'supplierReturns').findOne(
        { _id: returnId, tenantId },
        { session }
      );
      if (!ret) throw new AppError(404, 'Supplier return record not found.');

      const eligibility = await canReverseSupplierReturn(db, tenantId, ret, session);
      if (!eligibility.canReverse) {
        throw new AppError(400, eligibility.reverseBlockReason || 'Cannot reverse supplier return.');
      }

      const now = new Date();

      // Restore lot bucket
      const incField = ret.condition === 'Defective'
        ? { quantityDefective: ret.quantity, quantityReturned: -ret.quantity }
        : { quantityRemaining: ret.quantity, quantitySellable: ret.quantity, quantityReturned: -ret.quantity };

      await col<StockLotDocument>(db, 'stockLots').updateOne(
        { _id: ret.lotId, tenantId },
        {
          $inc: incField,
          $set: { updatedAt: now },
        },
        { session }
      );

      // Restore serials
      if (ret.serials && ret.serials.length > 0) {
        const nextSerialStatus = ret.condition === 'Defective' ? 'Defective' : 'InStock';
        for (const s of ret.serials) {
          const {unit} = await resolveSerialUnit(db, session, tenantId, s, {
            lotId: ret.lotId,
            expectedStatus: 'Returned',
          });
          await transitionSerialUnit(db, session, unit._id, {
            transition: 'SupplierReturnReversal',
            expected: {
              tenantId,
              productId: ret.productId,
              lotId: ret.lotId,
              status: 'Returned',
              version: unit.version,
            },
            nextState: {
              status: nextSerialStatus,
            },
          });
        }
      }

      // Decrement quantityReturned on purchase line
      await col(db, 'purchases').updateOne(
        { _id: ret.purchaseId, tenantId },
        {
          $inc: { 'lines.$[elem].quantityReturned': -ret.quantity },
          $set: { updatedAt: now, updatedBy: identity.userId },
        },
        {
          arrayFilters: [{ 'elem.lineId': ret.purchaseLineId }],
          session,
        }
      );

      // Insert positive stock movement
      const movDoc: StockMovementDocument = {
        _id: uid('MOV'),
        tenantId,
        date: todayInKolkata(),
        productId: ret.productId,
        lotId: ret.lotId,
        qty: ret.quantity,
        onHandDelta: ret.quantity,
        sellableDelta: ret.condition === 'Sellable' ? ret.quantity : 0,
        defectiveDelta: ret.condition === 'Defective' ? ret.quantity : 0,
        reason: `Supplier return reversal: ${input.reason}`,
        reference: ret.returnNumber,
        serials: ret.serials,
        createdAt: now,
        createdBy: identity.userId,
      };
      await col(db, 'stockMovements').insertOne(movDoc, { session });

      // Mark return reversed
      const updatedReturn = await col<SupplierReturnDocument>(db, 'supplierReturns').findOneAndUpdate(
        { _id: returnId, tenantId },
        {
          $set: {
            isReversed: true,
            reversalReason: input.reason,
            reversedAt: now,
            reversedBy: identity.userId,
          },
        },
        { returnDocument: 'after', session }
      );

      await recordAudit(db, {
        identity,
        action: 'purchase.reverseReturn',
        entityType: 'supplierReturn',
        entityId: returnId,
        before: ret,
        after: updatedReturn,
        detail: `Reversed supplier return ${ret.returnNumber}`,
      });

      return updatedReturn;
    }
  );
}

// 7. Record Supplier Payment & Split Components
export async function recordSupplierPayment(
  db: Db,
  identity: Identity,
  input: RecordSupplierPaymentInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);

  const totalComponentPaise = input.components.reduce((sum, c) => sum + c.amountPaise, 0);
  const totalAllocatedPaise = input.allocations.reduce((sum, a) => sum + a.amountPaise, 0);

  if (totalAllocatedPaise > totalComponentPaise) {
    throw new AppError(400, 'Total allocated amount exceeds payment component total.');
  }

  const excessPaise = totalComponentPaise - totalAllocatedPaise;
  if (excessPaise > 0 && !input.recordExcessAsAdvance) {
    throw new AppError(
      400,
      `Payment amount (₹${(totalComponentPaise / 100).toFixed(2)}) exceeds allocated dues (₹${(totalAllocatedPaise / 100).toFixed(2)}). Toggle "Record excess as supplier advance" to continue.`
    );
  }

  // Reject duplicate allocation targets in same payload
  const targetKeys = new Set<string>();
  for (const a of input.allocations) {
    const k = `${a.targetType}:${a.targetId}:${a.purchaseLineId || ''}`;
    if (targetKeys.has(k)) {
      throw new AppError(400, 'Duplicate allocation target in payment payload.');
    }
    targetKeys.add(k);
  }

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'RecordPayment',
    input.supplierId,
    input,
    async session => {
      await assertOperationalPostingAllowed(db, tenantId, input.date);
      await lockBusinessDay(db, session, tenantId, {date: input.date});
      const supplier = await col(db, 'suppliers').findOne({_id: input.supplierId, tenantId}, {session});
      if (!supplier) throw new AppError(404, 'Supplier record not found.');

      // Decrement account balances with atomic balance guard (D-019 & D-020)
      for (const comp of input.components) {
        const balRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
          {
            tenantId,
            account: comp.account,
            balancePaise: {$gte: comp.amountPaise},
          },
          {
            $inc: {balancePaise: -comp.amountPaise, version: 1},
            $set: {updatedAt: new Date()},
          },
          {session}
        );

        if (balRes.matchedCount === 0 || balRes.modifiedCount === 0) {
          throw new AppError(
            400,
            `Insufficient funds in ${comp.account} account. Cannot disburse ₹${(comp.amountPaise / 100).toFixed(2)}.`
          );
        }
      }

      const yearStr = new Date().getFullYear().toString();
      const paymentNumber = await nextTenantSequence(db, tenantId, 'Payment', yearStr, 'PAY', session);
      const paymentId = uid('PAY');
      const now = new Date();

      // Components and account movements
      const components: SupplierPaymentComponent[] = [];
      const movementInserts: Array<{
        _id: string;
        tenantId: string;
        date: string;
        account: string;
        qty: number;
        amountPaise?: number;
        direction?: 'In' | 'Out';
        category?: string;
        sourceType?: string;
        sourceId?: string;
        reason: string;
        reference: string;
        createdAt: Date;
        createdBy: string;
      }> = [];

      for (const c of input.components) {
        const movementId = uid('MOV');
        components.push({
          componentId: uid('CMP'),
          account: c.account,
          method: c.method,
          reference: c.reference,
          amountPaise: c.amountPaise,
          movementId,
        });

        movementInserts.push({
          _id: movementId,
          tenantId,
          date: input.date,
          account: c.account,
          qty: -c.amountPaise, // Signed negative integer
          amountPaise: c.amountPaise,
          direction: 'Out' as const,
          category: 'SupplierPayment' as const,
          sourceType: 'SupplierPayment' as const,
          sourceId: paymentId,
          reason: 'Supplier payment',
          reference: paymentNumber,
          createdAt: now,
          createdBy: identity.userId,
        });
      }

      await col(db, 'accountMovements').insertMany(movementInserts, {session});

      // Apply line allocations
      const allocationInserts: SupplierAllocationDocument[] = [];
      for (const alloc of input.allocations) {
        const allocId = uid('ALC');

        if (alloc.targetType === 'PurchaseLine') {
          if (!alloc.purchaseLineId) {
            throw new AppError(400, 'purchaseLineId is required when targetType is PurchaseLine.');
          }

          const updateRes = await col(db, 'purchases').updateOne(
            {
              _id: alloc.targetId,
              tenantId,
              billStatus: {$in: ['Posted', 'Credited', 'FullyCredited']},
              lines: {
                $elemMatch: {
                  lineId: alloc.purchaseLineId,
                  remainingDuePaise: {$gte: alloc.amountPaise},
                },
              },
            },
            {
              $inc: {
                'lines.$[elem].allocatedPaidPaise': alloc.amountPaise,
                'lines.$[elem].remainingDuePaise': -alloc.amountPaise,
                allocatedPaidPaise: alloc.amountPaise,
                duePaise: -alloc.amountPaise,
              },
              $set: {updatedAt: now, updatedBy: identity.userId},
            },
            {
              arrayFilters: [
                {
                  'elem.lineId': alloc.purchaseLineId,
                  'elem.remainingDuePaise': {$gte: alloc.amountPaise},
                },
              ],
              session,
            }
          );

          if (updateRes.matchedCount === 0 || updateRes.modifiedCount === 0) {
            throw new AppError(409, 'Allocation failed: target line due has changed or is insufficient.');
          }

          // Check if purchase is now fully paid
          const reloaded = await col<PurchaseDocument>(db, 'purchases').findOne({_id: alloc.targetId, tenantId}, {session});
          if (reloaded) {
            const nextPayStatus = reloaded.duePaise === 0 ? 'Paid' : 'PartlyPaid';
            await col(db, 'purchases').updateOne(
              {_id: alloc.targetId, tenantId},
              {$set: {paymentStatus: nextPayStatus}},
              {session}
            );
          }
        } else if (alloc.targetType === 'OpeningPayable') {
          const updateRes = await col(db, 'openingPayables').updateOne(
            {
              _id: alloc.targetId,
              tenantId,
              remainingAmountPaise: {$gte: alloc.amountPaise},
            },
            {
              $inc: {remainingAmountPaise: -alloc.amountPaise},
              $set: {updatedAt: now},
            },
            {session}
          );

          if (updateRes.matchedCount === 0 || updateRes.modifiedCount === 0) {
            throw new AppError(409, 'Opening payable due has changed or is insufficient.');
          }

          const reloadedOpp = await col(db, 'openingPayables').findOne({_id: alloc.targetId, tenantId}, {session});
          if (reloadedOpp) {
            const nextStatus = reloadedOpp.remainingAmountPaise === 0 ? 'Settled' : 'PartiallySettled';
            await col(db, 'openingPayables').updateOne(
              {_id: alloc.targetId, tenantId},
              {$set: {status: nextStatus}},
              {session}
            );
          }
        }

        allocationInserts.push({
          _id: allocId,
          tenantId,
          supplierId: input.supplierId,
          sourceType: 'Payment',
          sourceId: paymentId,
          targetType: alloc.targetType,
          targetId: alloc.targetId,
          purchaseLineId: alloc.purchaseLineId,
          amountPaise: alloc.amountPaise,
          effectiveDate: input.date,
          idempotencyKey: `${input.idempotencyKey}:${allocId}`,
          isReversal: false,
          createdAt: now,
          createdBy: identity.userId,
        });
      }

      if (allocationInserts.length) {
        await col(db, 'supplierAllocations').insertMany(allocationInserts, {session});
      }

      // Handle excess advance
      let advanceId: string | undefined = undefined;
      if (excessPaise > 0) {
        advanceId = uid('ADV');
        const advanceNumber = await nextTenantSequence(db, tenantId, 'Advance', yearStr, 'ADV', session);
        const advanceDoc: SupplierAdvanceDocument = {
          _id: advanceId,
          advanceNumber,
          tenantId,
          supplierId: input.supplierId,
          sourceType: 'ExplicitAdvance',
          sourceId: paymentId,
          paymentId,
          originalAmountPaise: excessPaise,
          allocatedPaise: 0,
          refundedPaise: 0,
          remainingAmountPaise: excessPaise,
          status: 'Open',
          createdAt: now,
          createdBy: identity.userId,
          updatedAt: now,
        };
        await col(db, 'supplierAdvances').insertOne(advanceDoc, {session});
      }

      const paymentDoc: SupplierPaymentDocument = {
        _id: paymentId,
        paymentNumber,
        tenantId,
        supplierId: input.supplierId,
        date: input.date,
        totalAmountPaise: totalComponentPaise,
        allocatedAmountPaise: totalAllocatedPaise,
        advanceAmountPaise: excessPaise,
        advanceId,
        notes: input.notes || '',
        idempotencyKey: input.idempotencyKey,
        components,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'supplierPayments').insertOne(paymentDoc, {session});
      return paymentDoc;
    }
  );
}

// 8. Allocate Supplier Advance
export async function allocateSupplierAdvance(
  db: Db,
  identity: Identity,
  advanceId: string,
  input: AllocateAdvanceInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);
  await assertOperationalPostingAllowed(db, tenantId, input.effectiveDate);

  const totalAllocPaise = input.allocations.reduce((sum, a) => sum + a.amountPaise, 0);

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'AllocateAdvance',
    advanceId,
    input,
    async session => {
      await lockBusinessDay(db, session, tenantId, {date: input.effectiveDate});
      // Deduct from supplierAdvance
      const advRes = await col<SupplierAdvanceDocument>(db, 'supplierAdvances').findOneAndUpdate(
        {
          _id: advanceId,
          tenantId,
          remainingAmountPaise: {$gte: totalAllocPaise},
        },
        {
          $inc: {remainingAmountPaise: -totalAllocPaise, allocatedPaise: totalAllocPaise},
          $set: {updatedAt: new Date()},
        },
        {returnDocument: 'after', session}
      );

      if (!advRes) {
        throw new AppError(400, 'Insufficient available credit on supplier advance.');
      }

      const nextStatus = deriveAdvanceStatus(advRes);
      await col(db, 'supplierAdvances').updateOne(
        {_id: advanceId, tenantId},
        {$set: {status: nextStatus}},
        {session}
      );

      const now = new Date();
      const allocationInserts: SupplierAllocationDocument[] = [];

      for (const alloc of input.allocations) {
        const allocId = uid('ALC');

        if (alloc.targetType === 'PurchaseLine') {
          const updateRes = await col(db, 'purchases').updateOne(
            {
              _id: alloc.targetId,
              tenantId,
              billStatus: {$in: ['Posted', 'Credited', 'FullyCredited']},
              lines: {
                $elemMatch: {
                  lineId: alloc.purchaseLineId,
                  remainingDuePaise: {$gte: alloc.amountPaise},
                },
              },
            },
            {
              $inc: {
                'lines.$[elem].allocatedPaidPaise': alloc.amountPaise,
                'lines.$[elem].remainingDuePaise': -alloc.amountPaise,
                allocatedPaidPaise: alloc.amountPaise,
                duePaise: -alloc.amountPaise,
              },
              $set: {updatedAt: now, updatedBy: identity.userId},
            },
            {
              arrayFilters: [
                {
                  'elem.lineId': alloc.purchaseLineId,
                  'elem.remainingDuePaise': {$gte: alloc.amountPaise},
                },
              ],
              session,
            }
          );

          if (updateRes.matchedCount === 0 || updateRes.modifiedCount === 0) {
            throw new AppError(409, 'Target purchase line due has changed or is insufficient.');
          }

          const reloaded = await col<PurchaseDocument>(db, 'purchases').findOne({_id: alloc.targetId, tenantId}, {session});
          if (reloaded) {
            const nextPayStatus = reloaded.duePaise === 0 ? 'Paid' : 'PartlyPaid';
            await col(db, 'purchases').updateOne(
              {_id: alloc.targetId, tenantId},
              {$set: {paymentStatus: nextPayStatus}},
              {session}
            );
          }
        } else if (alloc.targetType === 'OpeningPayable') {
          const updateRes = await col(db, 'openingPayables').updateOne(
            {_id: alloc.targetId, tenantId, remainingAmountPaise: {$gte: alloc.amountPaise}},
            {$inc: {remainingAmountPaise: -alloc.amountPaise}, $set: {updatedAt: now}},
            {session}
          );

          if (updateRes.matchedCount === 0 || updateRes.modifiedCount === 0) {
            throw new AppError(409, 'Opening payable due has changed or is insufficient.');
          }
        }

        allocationInserts.push({
          _id: allocId,
          tenantId,
          supplierId: advRes.supplierId,
          sourceType: 'Advance',
          sourceId: advanceId,
          targetType: alloc.targetType,
          targetId: alloc.targetId,
          purchaseLineId: alloc.purchaseLineId,
          amountPaise: alloc.amountPaise,
          effectiveDate: input.effectiveDate,
          idempotencyKey: `${input.idempotencyKey}:${allocId}`,
          isReversal: false,
          createdAt: now,
          createdBy: identity.userId,
        });
      }

      await col(db, 'supplierAllocations').insertMany(allocationInserts, {session});
      return {success: true, advanceId, allocatedPaise: totalAllocPaise, remainingAmountPaise: advRes.remainingAmountPaise};
    }
  );
}

// 9. Reverse Individual Allocation
export async function reverseSupplierAllocation(
  db: Db,
  identity: Identity,
  allocationId: string,
  input: ReverseOperationInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);

  const key = input.idempotencyKey || `rev-alloc-${allocationId}-${Date.now()}-${randomUUID()}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'ReverseAllocation',
    allocationId,
    input,
    async session => {
      await lockBusinessDay(db, session, tenantId);
      const originalAlloc = await col<SupplierAllocationDocument>(db, 'supplierAllocations').findOne(
        {_id: allocationId, tenantId},
        {session}
      );
      if (!originalAlloc) throw new AppError(404, 'Allocation record not found.');
      if (originalAlloc.isReversal) throw new AppError(400, 'Cannot reverse a reversal record.');

      const alreadyReversed = await col(db, 'supplierAllocations').findOne(
        {tenantId, isReversal: true, reversesAllocationId: allocationId},
        {session}
      );
      if (alreadyReversed) throw new AppError(400, 'This allocation was already reversed.');

      const now = new Date();
      const reversalAllocId = uid('ALC');
      const allocPaise = originalAlloc.amountPaise;

      // Handle source reversal
      if (originalAlloc.sourceType === 'Payment') {
        // Direct payment allocation reversal creates unallocated supplier advance (sourceType: 'ReversalCredit')
        const yearStr = now.getFullYear().toString();
        const advanceNumber = await nextTenantSequence(db, tenantId, 'Advance', yearStr, 'ADV', session);
        const advDoc: SupplierAdvanceDocument = {
          _id: uid('ADV'),
          advanceNumber,
          tenantId,
          supplierId: originalAlloc.supplierId,
          sourceType: 'ReversalCredit',
          sourceId: originalAlloc.sourceId,
          paymentId: originalAlloc.sourceId,
          reversalAllocationId: reversalAllocId,
          originalAmountPaise: allocPaise,
          allocatedPaise: 0,
          refundedPaise: 0,
          remainingAmountPaise: allocPaise,
          status: 'Open',
          createdAt: now,
          createdBy: identity.userId,
          updatedAt: now,
        };
        await col(db, 'supplierAdvances').insertOne(advDoc, {session});
      } else if (originalAlloc.sourceType === 'Advance') {
        // Restore advance balance
        const updatedAdv = await col<SupplierAdvanceDocument>(db, 'supplierAdvances').findOneAndUpdate(
          {_id: originalAlloc.sourceId, tenantId},
          {
            $inc: {remainingAmountPaise: allocPaise, allocatedPaise: -allocPaise},
            $set: {updatedAt: now},
          },
          {returnDocument: 'after', session}
        );
        if (updatedAdv) {
          const nextStatus = deriveAdvanceStatus(updatedAdv);
          await col(db, 'supplierAdvances').updateOne(
            {_id: originalAlloc.sourceId, tenantId},
            {$set: {status: nextStatus}},
            {session}
          );
        }
      }

      // Restore target liability
      if (originalAlloc.targetType === 'PurchaseLine' && originalAlloc.purchaseLineId) {
        await col(db, 'purchases').updateOne(
          {_id: originalAlloc.targetId, tenantId},
          {
            $inc: {
              'lines.$[elem].allocatedPaidPaise': -allocPaise,
              'lines.$[elem].remainingDuePaise': allocPaise,
              allocatedPaidPaise: -allocPaise,
              duePaise: allocPaise,
            },
            $set: {paymentStatus: 'PartlyPaid', updatedAt: now},
          },
          {
            arrayFilters: [{'elem.lineId': originalAlloc.purchaseLineId}],
            session,
          }
        );
      } else if (originalAlloc.targetType === 'OpeningPayable') {
        await col(db, 'openingPayables').updateOne(
          {_id: originalAlloc.targetId, tenantId},
          {
            $inc: {remainingAmountPaise: allocPaise},
            $set: {status: 'PartiallySettled', updatedAt: now},
          },
          {session}
        );
      }

      const reversalAllocDoc: SupplierAllocationDocument = {
        _id: reversalAllocId,
        tenantId,
        supplierId: originalAlloc.supplierId,
        sourceType: originalAlloc.sourceType,
        sourceId: originalAlloc.sourceId,
        targetType: originalAlloc.targetType,
        targetId: originalAlloc.targetId,
        purchaseLineId: originalAlloc.purchaseLineId,
        amountPaise: allocPaise,
        effectiveDate: todayInKolkata(),
        idempotencyKey: key,
        isReversal: true,
        reversesAllocationId: allocationId,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'supplierAllocations').insertOne(reversalAllocDoc, {session});
      return reversalAllocDoc;
    }
  );
}

// 10. Reverse Supplier Payment
export async function reverseSupplierPayment(
  db: Db,
  identity: Identity,
  paymentId: string,
  input: ReverseOperationInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);

  const key = input.idempotencyKey || `rev-pay-${paymentId}-${Date.now()}-${randomUUID()}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'ReversePayment',
    paymentId,
    input,
    async session => {
      await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());
      await lockBusinessDay(db, session, tenantId);
      const payment = await col<SupplierPaymentDocument>(db, 'supplierPayments').findOne({_id: paymentId, tenantId}, {session});
      if (!payment) throw new AppError(404, 'Supplier payment record not found.');
      if (payment.isReversed) throw new AppError(400, 'This payment has already been reversed.');

      // Check advances created from this payment
      const advances = await col<SupplierAdvanceDocument>(db, 'supplierAdvances').find({paymentId, tenantId}, {session}).toArray();
      for (const adv of advances) {
        if (adv.allocatedPaise > 0 || adv.refundedPaise > 0 || adv.remainingAmountPaise < adv.originalAmountPaise) {
          throw new AppError(
            400,
            `Cannot reverse payment: advance ${adv.advanceNumber} has downstream allocations or refunds. Unwind downstream records first.`
          );
        }
      }

      // Check direct allocations from this payment
      const directAllocs = await col<SupplierAllocationDocument>(db, 'supplierAllocations').find(
        {sourceId: paymentId, tenantId, isReversal: false},
        {session}
      ).toArray();

      for (const da of directAllocs) {
        const rev = await col(db, 'supplierAllocations').findOne({reversesAllocationId: da._id, tenantId}, {session});
        if (!rev) {
          throw new AppError(400, 'Cannot reverse payment: direct allocations must be reversed first.');
        }
      }

      const now = new Date();

      // Consume/close all advances created from this payment
      for (const adv of advances) {
        await col(db, 'supplierAdvances').updateOne(
          {_id: adv._id, tenantId},
          {$set: {remainingAmountPaise: 0, status: 'Consumed', updatedAt: now}},
          {session}
        );
      }

      // Restore account balances and log incoming accountMovements
      const movementInserts: any[] = [];
      for (const comp of payment.components) {
        await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
          {tenantId, account: comp.account},
          {$inc: {balancePaise: comp.amountPaise, version: 1}, $set: {updatedAt: now}},
          {session}
        );

        movementInserts.push({
          _id: uid('MOV'),
          tenantId,
          date: todayInKolkata(),
          account: comp.account,
          qty: comp.amountPaise, // Signed positive integer
          amountPaise: comp.amountPaise,
          direction: 'In' as const,
          category: 'SupplierPaymentReversal' as const,
          sourceType: 'SupplierPaymentReversal' as const,
          sourceId: paymentId,
          isReversal: true,
          reason: 'Supplier payment reversal',
          reference: payment.paymentNumber,
          createdAt: now,
          createdBy: identity.userId,
        });
      }

      await col(db, 'accountMovements').insertMany(movementInserts, {session});

      await col(db, 'supplierPayments').updateOne(
        {_id: paymentId, tenantId},
        {
          $set: {
            isReversed: true,
            reversalReason: input.reason,
            reversedAt: now,
            reversedBy: identity.userId,
          },
        },
        {session}
      );

      return {success: true, paymentId, isReversed: true};
    }
  );
}

// 11. Record Supplier Return
export async function recordSupplierReturn(
  db: Db,
  identity: Identity,
  input: SupplierReturnInput
) {
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'RecordReturn',
    input.purchaseId,
    input,
    async session => {
      await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());
      await lockBusinessDay(db, session, tenantId);
      const purchase = await col<PurchaseDocument>(db, 'purchases').findOne({_id: input.purchaseId, tenantId}, {session});
      if (!purchase) throw new AppError(404, 'Purchase record not found.');
      if (!['Posted', 'Credited', 'FullyCredited'].includes(purchase.billStatus)) throw new AppError(400, 'Cannot return goods for an unposted bill.');

      const line = purchase.lines.find((l: any) => l.lineId === input.purchaseLineId);
      if (!line || line.lineType !== 'Product') {
        throw new AppError(400, 'Purchase product line not found.');
      }

      const returnableQty = line.quantityReceived - line.quantityReturned;
      if (input.quantity > returnableQty) {
        throw new AppError(400, `Cannot return ${input.quantity} units. Eligible return quantity is ${returnableQty}.`);
      }

      // Check stockLot
      const lot = await col<StockLotDocument>(db, 'stockLots').findOne({_id: input.lotId, tenantId}, {session});
      if (!lot) throw new AppError(404, 'Stock lot not found.');
      if (lot.purchaseId !== purchase._id || lot.purchaseLineId !== line.lineId || lot.productId !== line.productId) {
        throw new AppError(400, 'Choose a stock lot received against this exact purchase line.');
      }
      const serialKeys = (input.serials || []).map(s => canonicalSerialKey(s));
      if (new Set(serialKeys).size !== serialKeys.length) throw new AppError(400, 'Duplicate serial numbers are not allowed.');
      if (!line.productSnapshot.isSerialTracked && (input.serials || []).length) throw new AppError(400, 'Quantity-tracked products do not accept serial selections.');


      if (input.condition === 'Defective') {
        if (lot.quantityDefective < input.quantity) {
          throw new AppError(400, `Lot has only ${lot.quantityDefective} defective units available to return.`);
        }
      } else {
        if (lot.quantitySellable < input.quantity) {
          throw new AppError(400, `Lot has only ${lot.quantitySellable} sellable units available to return.`);
        }
      }

      // Serial check
      const resolvedSerials: Array<{unit: any; version: number}> = [];
      if (line.productSnapshot.isSerialTracked) {
        if (!input.serials || input.serials.length !== input.quantity) {
          throw new AppError(400, `Serialized return requires exactly ${input.quantity} serial numbers.`);
        }

        const expectedStatus = input.condition === 'Defective' ? 'Defective' : 'InStock';
        for (const s of input.serials) {
          const res = await resolveSerialUnit(db, session, tenantId, s, {
            lotId: input.lotId,
            expectedStatus,
          });
          resolvedSerials.push(res);
        }
      }

      // Calculate Prorated Return Valuation
      const valSnapshot = prorateLineReturnValuation({
        quantityReturned: input.quantity,
        lineOrderedQty: line.quantityOrdered,
        previouslyReturnedQty: line.quantityReturned,
        lineTaxableBasePaise: line.taxableBasePaise,
        lineCgstPaise: line.cgstPaise,
        lineSgstPaise: line.sgstPaise,
        lineIgstPaise: line.igstPaise,
        lineTotalPaise: line.totalPaise,
        unitCostPaise: line.unitCostPaise,
        taxBasisPoints: line.taxBasisPoints,
      });

      const now = new Date();
      const yearStr = now.getFullYear().toString();
      const returnNumber = await nextTenantSequence(db, tenantId, 'Return', yearStr, 'RET', session);
      const returnId = uid('RET');

      // Decrement lot bucket
      const lotField = input.condition === 'Defective' ? 'quantityDefective' : 'quantitySellable';
      const lotIncrement: Record<string, number> = {
        [lotField]: -input.quantity,
        quantityReturned: input.quantity,
      };
      if (input.condition === 'Sellable') lotIncrement.quantityRemaining = -input.quantity;
      const changedLot = await col(db, 'stockLots').updateOne(
        {_id: input.lotId, tenantId, [lotField]: {$gte: input.quantity}},
        {
          $inc: lotIncrement,
          $set: {updatedAt: now},
        },
        {session}
      );

      if (changedLot.modifiedCount !== 1) throw new AppError(409, 'Stock changed. Reload available stock before returning.');

      // Update serials if serialized
      if (line.productSnapshot.isSerialTracked && resolvedSerials.length > 0) {
        for (const item of resolvedSerials) {
          await transitionSerialUnit(db, session, item.unit._id, {
            transition: 'SupplierReturn',
            expected: {
              tenantId,
              productId: line.productId,
              lotId: input.lotId,
              status: input.condition === 'Defective' ? 'Defective' : 'InStock',
              version: item.version,
            },
            nextState: {
              status: 'Returned',
            },
          });
        }
      }

      // Append negative stock movement
      await col(db, 'stockMovements').insertOne(
        {
          _id: uid('MOV'),
          tenantId,
          date: todayInKolkata(),
          productId: line.productId,
          lotId: input.lotId,
          qty: -input.quantity, // Signed negative integer
          onHandDelta: -input.quantity,
          sellableDelta: input.condition === 'Sellable' ? -input.quantity : 0,
          defectiveDelta: input.condition === 'Defective' ? -input.quantity : 0,
          reason: 'Supplier return',
          reference: returnNumber,
          serials: input.serials,
          idempotencyKey: `${input.idempotencyKey}:${returnId}`,
          createdAt: now,
          createdBy: identity.userId,
        },
        {session}
      );

      // Increment purchase line quantityReturned
      await col(db, 'purchases').updateOne(
        {_id: input.purchaseId, tenantId},
        {
          $inc: {'lines.$[elem].quantityReturned': input.quantity},
          $set: {updatedAt: now, updatedBy: identity.userId},
        },
        {
          arrayFilters: [{'elem.lineId': input.purchaseLineId}],
          session,
        }
      );

      const returnDoc: SupplierReturnDocument = {
        _id: returnId,
        returnNumber,
        tenantId,
        supplierId: purchase.supplierId,
        purchaseId: input.purchaseId,
        purchaseLineId: input.purchaseLineId,
        productId: line.productId,
        lotId: input.lotId,
        date: todayInKolkata(),
        quantity: input.quantity,
        serials: input.serials || [],
        ...valSnapshot,
        reason: input.reason,
        condition: input.condition,
        disposition: input.disposition,
        status: 'PendingCreditAcceptance',
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'supplierReturns').insertOne(returnDoc, {session});
      return returnDoc;
    }
  );
}

// 12. Accept Return Credit Note
export async function acceptReturnCreditNote(
  db: Db,
  identity: Identity,
  returnId: string,
  input: AcceptReturnCreditNoteInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'AcceptCreditNote',
    returnId,
    input,
    async session => {
      await assertOperationalPostingAllowed(db, tenantId, input.date);
      await lockBusinessDay(db, session, tenantId, {date: input.date});
      const ret = await col<SupplierReturnDocument>(db, 'supplierReturns').findOne({_id: returnId, tenantId}, {session});
      if (!ret) throw new AppError(404, 'Supplier return record not found.');
      if (ret.status !== 'PendingCreditAcceptance') {
        throw new AppError(400, 'Credit note for this return was already accepted.');
      }
      if (ret.isReversed) throw new AppError(409, 'This stock return was reversed.');
      if (input.acceptedCreditPaise > ret.totalReturnCreditPaise) {
        throw new AppError(400, 'Return credit cannot exceed the recorded return value. Record unrelated supplier adjustments separately.');
      }

      const purchase = await col<PurchaseDocument>(db, 'purchases').findOne({_id: ret.purchaseId, tenantId}, {session});
      if (!purchase) throw new AppError(404, 'Linked purchase bill not found.');

      const line = purchase.lines.find((l: any) => l.lineId === ret.purchaseLineId);
      if (!line) throw new AppError(404, 'Linked purchase line not found.');

      const now = new Date();
      const yearStr = now.getFullYear().toString();
      const creditNoteNumber = await nextTenantSequence(db, tenantId, 'CreditNote', yearStr, 'CRN', session);
      const creditNoteId = uid('CRN');

      let allocatedLiabilityPaise = 0;
      if (input.allocateToBillDue) {
        // Line-level payable offset (min of credit and remaining due)
        allocatedLiabilityPaise = Math.min(input.acceptedCreditPaise, line.remainingDuePaise);
      }

      const unallocatedCreditPaise = input.acceptedCreditPaise - allocatedLiabilityPaise;
      let advanceId: string | undefined = undefined;

      if (allocatedLiabilityPaise > 0) {
        await col(db, 'purchases').updateOne(
          {_id: ret.purchaseId, tenantId},
          {
            $inc: {
              'lines.$[elem].creditedLiabilityPaise': allocatedLiabilityPaise,
              'lines.$[elem].remainingDuePaise': -allocatedLiabilityPaise,
              creditedLiabilityPaise: allocatedLiabilityPaise,
              duePaise: -allocatedLiabilityPaise,
            },
            $set: {updatedAt: now, updatedBy: identity.userId},
          },
          {
            arrayFilters: [{'elem.lineId': ret.purchaseLineId}],
            session,
          }
        );

        const reloaded = await col<PurchaseDocument>(db, 'purchases').findOne({_id: ret.purchaseId, tenantId}, {session});
        if (reloaded) {
          const nextBillStatus: PurchaseBillStatus = reloaded.duePaise === 0 ? 'FullyCredited' : 'Credited';
          const nextPayStatus: PurchasePaymentStatus = reloaded.duePaise === 0 ? 'Paid' : reloaded.paymentStatus;
          await col(db, 'purchases').updateOne(
            {_id: ret.purchaseId, tenantId},
            {$set: {billStatus: nextBillStatus, paymentStatus: nextPayStatus}},
            {session}
          );
        }
      }

      if (unallocatedCreditPaise > 0) {
        advanceId = uid('ADV');
        const advanceNumber = await nextTenantSequence(db, tenantId, 'Advance', yearStr, 'ADV', session);
        const advDoc: SupplierAdvanceDocument = {
          _id: advanceId,
          advanceNumber,
          tenantId,
          supplierId: ret.supplierId,
          sourceType: 'CreditNoteExcess',
          sourceId: creditNoteId,
          creditNoteId,
          originalAmountPaise: unallocatedCreditPaise,
          allocatedPaise: 0,
          refundedPaise: 0,
          remainingAmountPaise: unallocatedCreditPaise,
          status: 'Open',
          createdAt: now,
          createdBy: identity.userId,
          updatedAt: now,
        };
        await col(db, 'supplierAdvances').insertOne(advDoc, {session});
      }

      const creditDoc: SupplierCreditNoteDocument = {
        _id: creditNoteId,
        creditNoteNumber,
        tenantId,
        supplierId: ret.supplierId,
        purchaseId: ret.purchaseId,
        purchaseNumber: purchase.purchaseNumber,
        supplierCreditNoteNumber: input.supplierCreditNoteNumber,
        supplierCreditNoteNumberNormalized: input.supplierCreditNoteNumber
          ? input.supplierCreditNoteNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
          : undefined,
        reason: 'GoodsReturn',
        date: input.date,
        acceptedCreditPaise: input.acceptedCreditPaise,
        allocatedLiabilityPaise,
        unallocatedCreditPaise,
        advanceId,
        lines: [
          {
            lineId: ret.purchaseLineId,
            productId: ret.productId,
            description: `Return credit for line ${ret.purchaseLineId}`,
            quantity: ret.quantity,
            unitCostPaise: ret.unitCostPaise,
            taxableBasePaise: ret.taxableBasePaise,
            taxBasisPoints: ret.taxBasisPoints,
            cgstPaise: ret.cgstPaise,
            sgstPaise: ret.sgstPaise,
            igstPaise: ret.igstPaise,
            totalCreditPaise: ret.totalReturnCreditPaise,
            roundingRemainderPaise: ret.roundingRemainderPaise,
          },
        ],
        returnId,
        idempotencyKey: input.idempotencyKey,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'supplierCreditNotes').insertOne(creditDoc, {session});

      await col(db, 'supplierReturns').updateOne(
        {_id: returnId, tenantId},
        {$set: {status: 'CreditAccepted', creditNoteId}},
        {session}
      );

      return creditDoc;
    }
  );
}

// 13. Create Standalone Credit Note (Price / Freight / Defective Allowance)
export async function createStandaloneCreditNote(
  db: Db,
  identity: Identity,
  input: CreateStandaloneCreditNoteInput
) {
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'StandaloneCreditNote',
    input.supplierId,
    input,
    async session => {
      await assertOperationalPostingAllowed(db, tenantId, input.date);
      await lockBusinessDay(db, session, tenantId, {date: input.date});
      const supplier = await col(db, 'suppliers').findOne({_id: input.supplierId, tenantId}, {session});
      if (!supplier) throw new AppError(404, 'Supplier not found.');

      let totalCreditPaise = 0;
      const creditLines: SupplierCreditNoteDocument['lines'] = [];

      for (const cl of input.lines) {
        const taxRate = cl.taxBasisPoints;
        const taxPaise = Math.round((cl.taxableBasePaise * taxRate) / 10000);
        const lineTotal = cl.taxableBasePaise + taxPaise;
        totalCreditPaise += lineTotal;

        const isInterState = input.taxMode === 'Inter-state';
        const igst = isInterState ? taxPaise : 0;
        const cgst = isInterState ? 0 : Math.floor(taxPaise / 2);
        const sgst = isInterState ? 0 : taxPaise - cgst;

        creditLines.push({
          lineId: cl.lineId,
          productId: cl.productId,
          description: cl.description,
          taxableBasePaise: cl.taxableBasePaise,
          taxBasisPoints: cl.taxBasisPoints,
          cgstPaise: cgst,
          sgstPaise: sgst,
          igstPaise: igst,
          totalCreditPaise: lineTotal,
        });
      }

      const now = new Date();
      const yearStr = now.getFullYear().toString();
      const creditNoteNumber = await nextTenantSequence(db, tenantId, 'CreditNote', yearStr, 'CRN', session);
      const creditNoteId = uid('CRN');

      const advanceId = uid('ADV');
      const advanceNumber = await nextTenantSequence(db, tenantId, 'Advance', yearStr, 'ADV', session);
      const advDoc: SupplierAdvanceDocument = {
        _id: advanceId,
        advanceNumber,
        tenantId,
        supplierId: input.supplierId,
        sourceType: 'CreditNoteExcess',
        sourceId: creditNoteId,
        creditNoteId,
        originalAmountPaise: totalCreditPaise,
        allocatedPaise: 0,
        refundedPaise: 0,
        remainingAmountPaise: totalCreditPaise,
        status: 'Open',
        createdAt: now,
        createdBy: identity.userId,
        updatedAt: now,
      };
      await col(db, 'supplierAdvances').insertOne(advDoc, {session});

      const creditDoc: SupplierCreditNoteDocument = {
        _id: creditNoteId,
        creditNoteNumber,
        tenantId,
        supplierId: input.supplierId,
        purchaseId: input.purchaseId,
        supplierCreditNoteNumber: input.supplierCreditNoteNumber,
        supplierCreditNoteNumberNormalized: input.supplierCreditNoteNumber
          ? input.supplierCreditNoteNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
          : undefined,
        reason: input.reason,
        date: input.date,
        acceptedCreditPaise: totalCreditPaise,
        allocatedLiabilityPaise: 0,
        unallocatedCreditPaise: totalCreditPaise,
        advanceId,
        lines: creditLines,
        idempotencyKey: input.idempotencyKey,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'supplierCreditNotes').insertOne(creditDoc, {session});
      return creditDoc;
    }
  );
}

// 14. Reverse Credit Note
export async function reverseSupplierCreditNote(
  db: Db,
  identity: Identity,
  creditNoteId: string,
  input: ReverseOperationInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);

  const key = input.idempotencyKey || `rev-cn-${creditNoteId}-${Date.now()}-${randomUUID()}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'ReverseCreditNote',
    creditNoteId,
    input,
    async session => {
      await lockBusinessDay(db, session, tenantId);
      const creditNote = await col<SupplierCreditNoteDocument>(db, 'supplierCreditNotes').findOne(
        {_id: creditNoteId, tenantId},
        {session}
      );
      if (!creditNote) throw new AppError(404, 'Credit note record not found.');
      if (creditNote.isReversed) throw new AppError(400, 'Credit note is already reversed.');

      if (creditNote.advanceId) {
        const adv = await col<SupplierAdvanceDocument>(db, 'supplierAdvances').findOne(
          {_id: creditNote.advanceId, tenantId},
          {session}
        );
        if (adv && (adv.allocatedPaise > 0 || adv.refundedPaise > 0 || adv.remainingAmountPaise < adv.originalAmountPaise)) {
          throw new AppError(
            400,
            `Cannot reverse credit note: unallocated credit advance ${adv.advanceNumber} has downstream allocations or refunds. Unwind them first.`
          );
        }
      }

      const now = new Date();

      if (creditNote.advanceId) {
        await col(db, 'supplierAdvances').updateOne(
          {_id: creditNote.advanceId, tenantId},
          {$set: {remainingAmountPaise: 0, status: 'Consumed', updatedAt: now}},
          {session}
        );
      }

      // Credit reversal must restore the same line, not just the bill header.
      if (creditNote.allocatedLiabilityPaise > 0 && creditNote.purchaseId) {
        if (creditNote.lines.length !== 1 || !creditNote.lines[0].lineId) {
          throw new AppError(409, 'This credit needs explicit line allocation history before reversal. No balances were changed.');
        }
        const lineId = creditNote.lines[0].lineId;
        const amount = creditNote.allocatedLiabilityPaise;
        const restored = await col(db, 'purchases').findOneAndUpdate(
          {_id: creditNote.purchaseId, tenantId, creditedLiabilityPaise: {$gte: amount},
            lines: {$elemMatch: {lineId, creditedLiabilityPaise: {$gte: amount}}}},
          {$inc: {creditedLiabilityPaise: -amount, duePaise: amount,
            'lines.$[line].creditedLiabilityPaise': -amount, 'lines.$[line].remainingDuePaise': amount},
           $set: {updatedAt: now, updatedBy: identity.userId}},
          {session, returnDocument: 'after', arrayFilters: [{'line.lineId': lineId}]}
        );
        if (!restored) throw new AppError(409, 'Credit allocation history does not reconcile with the bill. No balances were changed.');
        await col(db, 'purchases').updateOne({_id: creditNote.purchaseId, tenantId}, {$set: {
          billStatus: restored.creditedLiabilityPaise > 0 ? 'Credited' : 'Posted',
          paymentStatus: restored.duePaise === 0 ? 'Paid' : restored.allocatedPaidPaise > 0 ? 'PartlyPaid' : 'Unpaid',
        }}, {session});
      }

      const revDoc: SupplierCreditNoteReversalDocument = {
        _id: uid('CNR'),
        tenantId,
        creditNoteId,
        date: todayInKolkata(),
        reason: input.reason,
        idempotencyKey: key,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'supplierCreditNoteReversals').insertOne(revDoc, {session});

      await col(db, 'supplierCreditNotes').updateOne(
        {_id: creditNoteId, tenantId},
        {$set: {isReversed: true, reversalId: revDoc._id}},
        {session}
      );

      return {success: true, creditNoteId, isReversed: true};
    }
  );
}

// 15. Record Supplier Cash/Bank Refund
export async function recordSupplierRefund(
  db: Db,
  identity: Identity,
  input: RecordSupplierRefundInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'RecordRefund',
    input.advanceId,
    input,
    async session => {
      await assertOperationalPostingAllowed(db, tenantId, input.date);
      await lockBusinessDay(db, session, tenantId, {date: input.date});
      // Atomic deduction from supplierAdvances (only authoritative source)
      const advRes = await col<SupplierAdvanceDocument>(db, 'supplierAdvances').findOneAndUpdate(
        {
          _id: input.advanceId,
          tenantId,
          remainingAmountPaise: {$gte: input.amountPaise},
        },
        {
          $inc: {remainingAmountPaise: -input.amountPaise, refundedPaise: input.amountPaise},
          $set: {updatedAt: new Date()},
        },
        {returnDocument: 'after', session}
      );

      if (!advRes) {
        throw new AppError(400, 'Insufficient available credit balance for refund.');
      }

      const nextStatus = deriveAdvanceStatus(advRes);
      await col(db, 'supplierAdvances').updateOne(
        {_id: input.advanceId, tenantId},
        {$set: {status: nextStatus}},
        {session}
      );

      const now = new Date();
      const yearStr = now.getFullYear().toString();
      const refundNumber = await nextTenantSequence(db, tenantId, 'Refund', yearStr, 'RFD', session);
      const refundId = uid('RFD');
      const movementId = uid('MOV');

      // Increment shop account balance
      await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
        {tenantId, account: input.account},
        {$inc: {balancePaise: input.amountPaise, version: 1}, $set: {updatedAt: now}},
        {session}
      );

      // Append incoming accountMovement
      await col(db, 'accountMovements').insertOne(
        {
          _id: movementId,
          tenantId,
          date: input.date,
          account: input.account,
          qty: input.amountPaise, // Signed positive integer
          amountPaise: input.amountPaise,
          direction: 'In' as const,
          category: 'SupplierRefund' as const,
          sourceType: 'SupplierRefund' as const,
          sourceId: refundId,
          reason: 'Supplier refund',
          reference: refundNumber,
          createdAt: now,
          createdBy: identity.userId,
        },
        {session}
      );

      const refundDoc: SupplierRefundDocument = {
        _id: refundId,
        refundNumber,
        tenantId,
        supplierId: advRes.supplierId,
        advanceId: input.advanceId,
        amountPaise: input.amountPaise,
        account: input.account,
        date: input.date,
        reference: input.reference,
        idempotencyKey: input.idempotencyKey,
        movementId,
        isReversed: false,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'supplierRefunds').insertOne(refundDoc, {session});
      return refundDoc;
    }
  );
}

// 16. Reverse Supplier Refund
export async function reverseSupplierRefund(
  db: Db,
  identity: Identity,
  refundId: string,
  input: ReverseOperationInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);

  const key = input.idempotencyKey || `rev-rfd-${refundId}-${Date.now()}-${randomUUID()}`;
  return executeIdempotentTransaction(
    db,
    identity,
    key,
    'ReverseRefund',
    refundId,
    input,
    async session => {
      await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());
      await lockBusinessDay(db, session, tenantId);
      const refund = await col<SupplierRefundDocument>(db, 'supplierRefunds').findOne({_id: refundId, tenantId}, {session});
      if (!refund) throw new AppError(404, 'Refund record not found.');
      if (refund.isReversed) throw new AppError(400, 'Refund is already reversed.');

      // Check account balance to prevent negative balance
      const balRes = await col<TenantAccountBalanceDocument>(db, 'tenantAccountBalances').updateOne(
        {
          tenantId,
          account: refund.account,
          balancePaise: {$gte: refund.amountPaise},
        },
        {
          $inc: {balancePaise: -refund.amountPaise, version: 1},
          $set: {updatedAt: new Date()},
        },
        {session}
      );

      if (balRes.matchedCount === 0 || balRes.modifiedCount === 0) {
        throw new AppError(400, `Insufficient funds in ${refund.account} account to reverse this refund.`);
      }

      const now = new Date();
      const movementId = uid('MOV');

      // Append outgoing account movement
      await col(db, 'accountMovements').insertOne(
        {
          _id: movementId,
          tenantId,
          date: todayInKolkata(),
          account: refund.account,
          qty: -refund.amountPaise, // Signed negative integer
          amountPaise: refund.amountPaise,
          direction: 'Out' as const,
          category: 'SupplierRefundReversal' as const,
          sourceType: 'SupplierRefundReversal' as const,
          sourceId: refundId,
          isReversal: true,
          reason: 'Supplier refund reversal',
          reference: refund.refundNumber,
          createdAt: now,
          createdBy: identity.userId,
        },
        {session}
      );

      // Restore advance credit balance
      const updatedAdv = await col<SupplierAdvanceDocument>(db, 'supplierAdvances').findOneAndUpdate(
        {_id: refund.advanceId, tenantId},
        {
          $inc: {remainingAmountPaise: refund.amountPaise, refundedPaise: -refund.amountPaise},
          $set: {updatedAt: now},
        },
        {returnDocument: 'after', session}
      );
      if (updatedAdv) {
        const nextStatus = deriveAdvanceStatus(updatedAdv);
        await col(db, 'supplierAdvances').updateOne(
          {_id: refund.advanceId, tenantId},
          {$set: {status: nextStatus}},
          {session}
        );
      }

      const revDoc: SupplierRefundReversalDocument = {
        _id: uid('RFR'),
        tenantId,
        refundId,
        date: todayInKolkata(),
        reason: input.reason,
        movementId,
        idempotencyKey: key,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col(db, 'supplierRefundReversals').insertOne(revDoc, {session});

      await col(db, 'supplierRefunds').updateOne(
        {_id: refundId, tenantId},
        {$set: {isReversed: true, reversalId: revDoc._id}},
        {session}
      );

      return {success: true, refundId, isReversed: true};
    }
  );
}

// 17. Reconciled Signed Supplier Statement (Database Aggregation Pipeline)
export async function getSupplierStatement(
  db: Db,
  identity: Identity,
  supplierId: string,
  asOfDateOrParams?: string | {
    asOfDate?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    limit?: number;
  }
) {
  const tenantId = identity.tenantId;
  const supplier = await col(db, 'suppliers').findOne({_id: supplierId, tenantId});
  if (!supplier) throw new AppError(404, 'Supplier not found.');

  const params = typeof asOfDateOrParams === 'string'
    ? {asOfDate: asOfDateOrParams}
    : (asOfDateOrParams || {});

  const filterDate = params.dateTo || params.asOfDate || todayInKolkata();
  const page = Math.max(1, params.page || 1);
  // Public route caps this at 50. Internal export callers may request up to the documented export limit.
  const limit = Math.min(5000, Math.max(1, params.limit || 50));
  const skip = (page - 1) * limit;

  const dateFilter = {$lte: filterDate};

  // Pipeline constructing a normalized event stream across all source collections
  const pipeline = [
    // 1. Opening payables
    {
      $match: {
        tenantId,
        supplierId,
        $expr: {$lte: [{$ifNull: ['$date', '$cutoffDate']}, filterDate]},
      },
    },
    {
      $project: {
        _id: 1,
        date: {$ifNull: ['$date', '$cutoffDate']},
        effectiveDate: {$ifNull: ['$date', '$cutoffDate']},
        createdAt: {$ifNull: ['$createdAt', new Date(0)]},
        type: {$literal: 'OpeningPayable'},
        reference: {$ifNull: ['$reference', 'Opening Balance']},
        description: {$literal: 'Opening balance due to supplier'},
        amountPaise: '$originalAmountPaise',
      },
    },
    // 2. Posted bills
    {
      $unionWith: {
        coll: 'purchases',
        pipeline: [
          {
            $match: {
              tenantId,
              supplierId,
              billStatus: {$in: ['Posted', 'Credited', 'FullyCredited']},
              postingDate: dateFilter,
            },
          },
          {
            $project: {
              _id: 1,
              date: {$ifNull: ['$postingDate', '$orderDate']},
              effectiveDate: {$ifNull: ['$postingDate', '$orderDate']},
              createdAt: '$createdAt',
              type: {$literal: 'PurchaseBill'},
              reference: {$ifNull: ['$supplierInvoiceNumber', '$purchaseNumber']},
              description: {$concat: ['Bill ', '$purchaseNumber']},
              amountPaise: '$totalPaise',
            },
          },
        ],
      },
    },
    // 3. Accepted credit notes
    {
      $unionWith: {
        coll: 'supplierCreditNotes',
        pipeline: [
          {
            $match: {
              tenantId,
              supplierId,
              date: dateFilter,
            },
          },
          {
            $project: {
              _id: 1,
              date: '$date',
              effectiveDate: '$date',
              createdAt: '$createdAt',
              type: {$literal: 'CreditNote'},
              reference: '$creditNoteNumber',
              description: {$concat: ['Credit Note (', '$reason', ')']},
              amountPaise: {$multiply: ['$acceptedCreditPaise', -1]},
            },
          },
        ],
      },
    },
    // 4. Outgoing payments
    {
      $unionWith: {
        coll: 'supplierPayments',
        pipeline: [
          {
            $match: {
              tenantId,
              supplierId,
              date: dateFilter,
            },
          },
          {
            $project: {
              _id: 1,
              date: '$date',
              effectiveDate: '$date',
              createdAt: '$createdAt',
              type: {$literal: 'Payment'},
              reference: '$paymentNumber',
              description: {$literal: 'Disbursement to supplier'},
              amountPaise: {$multiply: ['$totalAmountPaise', -1]},
            },
          },
        ],
      },
    },
    // 5. Payment reversals
    {
      $unionWith: {
        coll: 'supplierPayments',
        pipeline: [
          {
            $match: {
              tenantId,
              supplierId,
              isReversed: true,
              date: dateFilter,
            },
          },
          {
            $project: {
              _id: {$concat: ['$_id', '-rev']},
              date: {$dateToString: {date: {$ifNull: ['$reversedAt', '$createdAt']}, format: '%Y-%m-%d', timezone: 'Asia/Kolkata'}},
              effectiveDate: {$dateToString: {date: {$ifNull: ['$reversedAt', '$createdAt']}, format: '%Y-%m-%d', timezone: 'Asia/Kolkata'}},
              createdAt: {$ifNull: ['$reversedAt', '$createdAt']},
              type: {$literal: 'PaymentReversal'},
              reference: {$concat: ['REV-', '$paymentNumber']},
              description: {$literal: 'Payment reversal'},
              amountPaise: '$totalAmountPaise',
            },
          },
        ],
      },
    },
    // 6. Incoming refunds
    {
      $unionWith: {
        coll: 'supplierRefunds',
        pipeline: [
          {
            $match: {
              tenantId,
              supplierId,
              date: dateFilter,
            },
          },
          {
            $project: {
              _id: 1,
              date: '$date',
              effectiveDate: '$date',
              createdAt: '$createdAt',
              type: {$literal: 'Refund'},
              reference: '$refundNumber',
              description: {$literal: 'Refund from supplier'},
              amountPaise: '$amountPaise',
            },
          },
        ],
      },
    },
    // 7. Credit note reversals
    {
      $unionWith: {
        coll: 'supplierCreditNoteReversals',
        pipeline: [
          {
            $match: {
              tenantId,
              date: dateFilter,
            },
          },
          {
            $lookup: {
              from: 'supplierCreditNotes',
              localField: 'creditNoteId',
              foreignField: '_id',
              as: 'cn',
            },
          },
          {$unwind: '$cn'},
          {$match: {'cn.supplierId': supplierId}},
          {
            $project: {
              _id: 1,
              date: '$date',
              effectiveDate: '$date',
              createdAt: '$createdAt',
              type: {$literal: 'CreditNoteReversal'},
              reference: {$concat: ['REV-', '$cn.creditNoteNumber']},
              description: {$literal: 'Credit note reversal'},
              amountPaise: '$cn.acceptedCreditPaise',
            },
          },
        ],
      },
    },
    // 8. Refund reversals
    {
      $unionWith: {
        coll: 'supplierRefundReversals',
        pipeline: [
          {
            $match: {
              tenantId,
              date: dateFilter,
            },
          },
          {
            $lookup: {
              from: 'supplierRefunds',
              localField: 'refundId',
              foreignField: '_id',
              as: 'rf',
            },
          },
          {$unwind: '$rf'},
          {$match: {'rf.supplierId': supplierId}},
          {
            $project: {
              _id: 1,
              date: '$date',
              effectiveDate: '$date',
              createdAt: '$createdAt',
              type: {$literal: 'RefundReversal'},
              reference: {$concat: ['REV-', '$rf.refundNumber']},
              description: {$literal: 'Refund reversal'},
              amountPaise: {$multiply: ['$rf.amountPaise', -1]},
            },
          },
        ],
      },
    },
    // Deterministic chronological sort applied once in the database
    {
      $sort: {
        effectiveDate: 1,
        createdAt: 1,
        _id: 1,
      },
    },
    // Database-side range and pagination facets without loading all events into application memory.
    // The amount before dateFrom is carried into every page in the requested period.
    {
      $facet: {
        beforePeriod: params.dateFrom
          ? [{$match: {effectiveDate: {$lt: params.dateFrom}}}, {$group: {_id: null, sum: {$sum: '$amountPaise'}}}]
          : [{$match: {_id: '__none__'}}],
        totalCount: [
          ...(params.dateFrom ? [{$match: {effectiveDate: {$gte: params.dateFrom}}}] : []),
          {$count: 'count'},
        ],
        balanceBeforePage: [
          ...(params.dateFrom ? [{$match: {effectiveDate: {$gte: params.dateFrom}}}] : []),
          ...(skip > 0
            ? [{$limit: skip}, {$group: {_id: null, sum: {$sum: '$amountPaise'}}}]
            : [{$match: {_id: '__none__'}}]),
        ],
        periodBalance: [
          ...(params.dateFrom ? [{$match: {effectiveDate: {$gte: params.dateFrom}}}] : []),
          {$group: {_id: null, sum: {$sum: '$amountPaise'}}},
        ],
        pageItems: [
          ...(params.dateFrom ? [{$match: {effectiveDate: {$gte: params.dateFrom}}}] : []),
          {$skip: skip},
          {$limit: limit},
        ],
      },
    },
  ];

  const [aggRes, openPayablesAgg, purchasesAgg, advancesAgg] = await Promise.all([
    col(db, 'openingPayables').aggregate(pipeline).toArray(),
    col(db, 'openingPayables').aggregate([
      {$match: {tenantId, supplierId, status: {$ne: 'Settled'}}},
      {$group: {_id: null, sum: {$sum: '$remainingAmountPaise'}}},
    ]).toArray(),
    col<PurchaseDocument>(db, 'purchases').aggregate([
      {$match: {tenantId, supplierId, billStatus: {$in: ['Posted', 'Credited', 'FullyCredited']}, duePaise: {$gt: 0}}},
      {$group: {_id: null, sum: {$sum: '$duePaise'}}},
    ]).toArray(),
    col<SupplierAdvanceDocument>(db, 'supplierAdvances').aggregate([
      {$match: {tenantId, supplierId, status: {$ne: 'Consumed'}}},
      {$group: {_id: null, sum: {$sum: '$remainingAmountPaise'}}},
    ]).toArray(),
  ]);

  const facet = aggRes[0] || {};
  const balanceBeforePeriod = facet.beforePeriod?.[0]?.sum || 0;
  const total = facet.totalCount?.[0]?.count || 0;
  const balanceBeforePage = balanceBeforePeriod + (facet.balanceBeforePage?.[0]?.sum || 0);
  const statementBalancePaise = balanceBeforePeriod + (facet.periodBalance?.[0]?.sum || 0);
  const pageItems = (facet.pageItems || []) as Array<{
    id: string;
    _id?: string;
    date: string;
    type: string;
    reference: string;
    description: string;
    amountPaise: number;
    runningBalancePaise: number;
  }>;

  let running = balanceBeforePage;
  for (const item of pageItems) {
    item.id = (item._id || item.id).toString();
    running += item.amountPaise;
    item.runningBalancePaise = running;
  }

  const grossOutstandingPayables = (openPayablesAgg[0]?.sum || 0) + (purchasesAgg[0]?.sum || 0);
  const availableCredits = advancesAgg[0]?.sum || 0;
  const netPositionPaise = grossOutstandingPayables - availableCredits;
  const invariantApplicable = filterDate === todayInKolkata();
  const invariantSatisfied = !invariantApplicable || statementBalancePaise === netPositionPaise;

  return {
    supplier: {
      id: supplier._id,
      name: supplier.name,
      gst: supplier.gst,
      terms: supplier.terms,
    },
    statementBalancePaise,
    grossOutstandingPayablesPaise: grossOutstandingPayables,
    availableCreditsPaise: availableCredits,
    netPositionPaise,
    balanceBeforePage,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    invariantSatisfied,
    invariantApplicable,
    items: pageItems,
  };
}

// 18. Purchases List and Full Matching Summary
export async function listPurchases(
  db: Db,
  identity: Identity,
  params: {
    page?: number;
    limit?: number;
    hasDue?: boolean;
    supplierId?: string;
    productId?: string;
    status?: string;
    documentStatus?: string;
    billStatus?: string;
    receiptStatus?: string;
    paymentStatus?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
  }
) {
  const tenantId = identity.tenantId;
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 20));
  const skip = (page - 1) * limit;

  const filter: Filter<PurchaseDocument> = {tenantId};

  if (params.hasDue) {
    filter.billStatus = {$in: ['Posted', 'Credited', 'FullyCredited']} as any;
    filter.duePaise = {$gt: 0};
  }

  if (params.supplierId) {
    filter.supplierId = params.supplierId;
  }

  if (params.productId) {
    (filter as any)['lines.productId'] = params.productId;
  }

  if (params.documentStatus) {
    filter.documentStatus = params.documentStatus as any;
  }

  if (params.billStatus) {
    filter.billStatus = params.billStatus as any;
  }

  if (params.receiptStatus) {
    filter.receiptStatus = params.receiptStatus as any;
  }

  if (params.paymentStatus) {
    filter.paymentStatus = params.paymentStatus as any;
  }

  if (params.dateFrom || params.dateTo) {
    filter.orderDate = {} as any;
    if (params.dateFrom) (filter.orderDate as any).$gte = params.dateFrom;
    if (params.dateTo) (filter.orderDate as any).$lte = params.dateTo;
  }

  if (params.status) {
    if (params.status === 'Draft' || params.status === 'Confirmed' || params.status === 'Cancelled') {
      filter.documentStatus = params.status;
    } else if (params.status === 'Posted') {
      filter.billStatus = {$in: ['Posted', 'Credited', 'FullyCredited']} as any;
    } else if (params.status === 'Unpaid' || params.status === 'PartlyPaid' || params.status === 'Paid') {
      filter.paymentStatus = params.status;
    }
  }

  if (params.search) {
    const q = escapeRegex(params.search.trim());
    filter.$or = [
      {purchaseNumber: {$regex: q, $options: 'i'}},
      {supplierInvoiceNumber: {$regex: q, $options: 'i'}},
      {'supplierSnapshot.name': {$regex: q, $options: 'i'}},
    ];
  }

  const [records, total] = await Promise.all([
    col<PurchaseDocument>(db, 'purchases').find(filter).sort({createdAt: -1}).skip(skip).limit(limit).toArray(),
    col(db, 'purchases').countDocuments(filter),
  ]);

  return {records, total, page, limit, totalPages: Math.ceil(total / limit)};
}

export async function getPurchaseSummary(
  db: Db,
  identity: Identity,
  params: {hasDue?: boolean; supplierId?: string}
) {
  const tenantId = identity.tenantId;
  const matchBase: Filter<PurchaseDocument> = {tenantId};
  if (params.supplierId) matchBase.supplierId = params.supplierId;

  const [purchasesFacet, advancesRes] = await Promise.all([
    col<PurchaseDocument>(db, 'purchases').aggregate([
      {$match: matchBase},
      {
        $facet: {
          draftCount: [
            {$match: {documentStatus: 'Draft'}},
            {$count: 'count'},
          ],
          confirmedOrderCount: [
            {$match: {documentStatus: 'Confirmed', billStatus: 'NotPosted'}},
            {$count: 'count'},
          ],
          postedTotals: [
            {$match: {billStatus: {$in: ['Posted', 'Credited', 'FullyCredited']}}},
            {
              $group: {
                _id: null,
                postedValuePaise: {$sum: '$totalPaise'},
                allocatedPaidPaise: {$sum: '$allocatedPaidPaise'},
                creditedLiabilityPaise: {$sum: '$creditedLiabilityPaise'},
              },
            },
          ],
          unpaidDue: [
            {$match: {billStatus: {$in: ['Posted', 'Credited', 'FullyCredited']}, paymentStatus: {$in: ['Unpaid', 'PartlyPaid']}}},
            {$group: {_id: null, sum: {$sum: '$duePaise'}}},
          ],
          awaitingReceiptCount: [
            {$match: {billStatus: {$in: ['Posted', 'Credited', 'FullyCredited']}, receiptStatus: 'NotReceived'}},
            {$count: 'count'},
          ],
          partlyReceivedCount: [
            {$match: {receiptStatus: 'PartlyReceived'}},
            {$count: 'count'},
          ],
          allCount: [
            {$count: 'count'},
          ],
        },
      },
    ]).toArray(),
    col<SupplierAdvanceDocument>(db, 'supplierAdvances').aggregate([
      {$match: {tenantId, ...(params.supplierId ? {supplierId: params.supplierId} : {}), status: {$ne: 'Consumed'}}},
      {$group: {_id: null, sum: {$sum: '$remainingAmountPaise'}}},
    ]).toArray(),
  ]);

  const f = purchasesFacet[0] || {};
  const draftCount = f.draftCount?.[0]?.count || 0;
  const confirmedOrderCount = f.confirmedOrderCount?.[0]?.count || 0;
  const postedTotals = f.postedTotals?.[0] || {postedValuePaise: 0, allocatedPaidPaise: 0, creditedLiabilityPaise: 0};
  const unpaidDuePaise = f.unpaidDue?.[0]?.sum || 0;
  const awaitingReceiptCount = f.awaitingReceiptCount?.[0]?.count || 0;
  const partlyReceivedCount = f.partlyReceivedCount?.[0]?.count || 0;
  const availableAdvancePaise = advancesRes?.[0]?.sum || 0;
  const totalCount = f.allCount?.[0]?.count || 0;

  return {
    count: totalCount,
    totalPaise: postedTotals.postedValuePaise || 0,
    allocatedPaidPaise: postedTotals.allocatedPaidPaise || 0,
    duePaise: unpaidDuePaise,
    creditedLiabilityPaise: postedTotals.creditedLiabilityPaise || 0,

    // Phase 3.5 precise fields
    draftCount,
    confirmedOrderCount,
    postedValuePaise: postedTotals.postedValuePaise || 0,
    unpaidDuePaise,
    awaitingReceiptCount,
    partlyReceivedCount,
    availableAdvancePaise,
  };
}

// 19. Everyday Shortcut: "Record Purchase + Receive" (Credit purchase without payment)
export async function recordReceiveShortcut(
  db: Db,
  identity: Identity,
  input: RecordReceiveInput
): Promise<{purchase: PurchaseDocument; receipt: PurchaseReceiptDocument}> {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);
  await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'RecordReceive',
    input.purchase.supplierId,
    input,
    async session => {
      // 1. Create and post bill
      const purchase = await createPurchase(db, identity, {
        ...input.purchase,
        postImmediately: true,
        supplierInvoiceNumber: input.purchase.supplierInvoiceNumber,
        supplierInvoiceDate: input.purchase.supplierInvoiceDate || todayInKolkata(),
      });

      // 2. Map clientLineKey to lineId
      const productLineMap = new Map<string, string>();
      const chargeLineKeys = new Set<string>();
      for (const line of purchase.lines) {
        if (line.lineType === 'Product') {
          if (line.clientLineKey) productLineMap.set(line.clientLineKey, line.lineId);
          productLineMap.set(line.lineId, line.lineId);
        } else {
          if (line.clientLineKey) chargeLineKeys.add(line.clientLineKey);
          chargeLineKeys.add(line.lineId);
        }
      }

      const seenReceiptKeys = new Set<string>();
      const mappedReceiptLines = input.receipt.lines.map(rl => {
        const key = rl.clientLineKey || rl.lineId;
        if (!key) {
          throw new AppError(400, 'clientLineKey or lineId is required in receipt line');
        }
        if (seenReceiptKeys.has(key)) {
          throw new AppError(400, 'Duplicate clientLineKey in receipt payload');
        }
        seenReceiptKeys.add(key);

        if (chargeLineKeys.has(key)) {
          throw new AppError(400, 'Charge lines cannot be received');
        }
        const resolvedLineId = productLineMap.get(key);
        if (!resolvedLineId) {
          throw new AppError(400, `Unknown clientLineKey or lineId: ${key}`);
        }
        return {
          ...rl,
          lineId: resolvedLineId,
        };
      });

      // 3. Receive stock
      const receipt = await receivePurchaseStock(db, identity, purchase._id, {
        receiptDate: input.receipt.receiptDate || todayInKolkata(),
        notes: input.receipt.notes,
        idempotencyKey: `${input.idempotencyKey}:rcp`,
        lines: mappedReceiptLines,
      });

      return {
        purchase,
        receipt,
      };
    }
  );
}

// 20. Everyday Shortcut: "Record Purchase + Receive + Pay"
export async function recordReceiveAndPayShortcut(
  db: Db,
  identity: Identity,
  input: RecordReceiveAndPayInput
) {
  const tenantId = identity.tenantId;
  await assertPhase3MigrationComplete(db, tenantId);
  await assertOperationalPostingAllowed(db, tenantId, todayInKolkata());

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'RecordReceivePay',
    input.purchase.supplierId,
    input,
    async session => {
      // 1. Create and post bill
      const purchase = await createPurchase(db, identity, {
        ...input.purchase,
        postImmediately: true,
        supplierInvoiceNumber: input.purchase.supplierInvoiceNumber,
        supplierInvoiceDate: input.purchase.supplierInvoiceDate || todayInKolkata(),
      });

      // 2. Map clientLineKey to lineId
      const productLineMap = new Map<string, string>();
      const chargeLineKeys = new Set<string>();
      for (const line of purchase.lines) {
        if (line.lineType === 'Product') {
          if (line.clientLineKey) productLineMap.set(line.clientLineKey, line.lineId);
          productLineMap.set(line.lineId, line.lineId);
        } else {
          if (line.clientLineKey) chargeLineKeys.add(line.clientLineKey);
          chargeLineKeys.add(line.lineId);
        }
      }

      const seenReceiptKeys = new Set<string>();
      const mappedReceiptLines = input.receipt.lines.map(rl => {
        const key = rl.clientLineKey || rl.lineId;
        if (!key) {
          throw new AppError(400, 'clientLineKey or lineId is required in receipt line');
        }
        if (seenReceiptKeys.has(key)) {
          throw new AppError(400, 'Duplicate clientLineKey in receipt payload');
        }
        seenReceiptKeys.add(key);

        if (chargeLineKeys.has(key)) {
          throw new AppError(400, 'Charge lines cannot be received');
        }
        const resolvedLineId = productLineMap.get(key);
        if (!resolvedLineId) {
          throw new AppError(400, `Unknown clientLineKey or lineId: ${key}`);
        }
        return {
          ...rl,
          lineId: resolvedLineId,
        };
      });

      // 3. Receive stock
      const receipt = await receivePurchaseStock(db, identity, purchase._id, {
        receiptDate: input.receipt.receiptDate || todayInKolkata(),
        notes: input.receipt.notes,
        idempotencyKey: `${input.idempotencyKey}:rcp`,
        lines: mappedReceiptLines,
      });

      // 4. Record payment across all lines (both Product and Charge lines)
      let remainingToAllocate = input.payment.components.reduce((sum, c) => sum + c.amountPaise, 0);
      const paymentAllocations: Array<{
        targetType: 'PurchaseLine';
        targetId: string;
        purchaseLineId: string;
        amountPaise: number;
      }> = [];

      for (const line of purchase.lines) {
        if (remainingToAllocate <= 0) break;
        const allocPaise = Math.min(line.remainingDuePaise, remainingToAllocate);
        if (allocPaise > 0) {
          paymentAllocations.push({
            targetType: 'PurchaseLine',
            targetId: purchase._id,
            purchaseLineId: line.lineId,
            amountPaise: allocPaise,
          });
          remainingToAllocate -= allocPaise;
        }
      }

      const payment = await recordSupplierPayment(db, identity, {
        supplierId: purchase.supplierId,
        date: todayInKolkata(),
        components: input.payment.components,
        allocations: paymentAllocations,
        recordExcessAsAdvance: input.payment.recordExcessAsAdvance,
        notes: input.payment.notes,
        idempotencyKey: `${input.idempotencyKey}:pay`,
      });

      // Reload purchase document to return updated paymentStatus and remaining due
      const updatedPurchase = await col<PurchaseDocument>(db, 'purchases').findOne(
        {_id: purchase._id, tenantId},
        {session}
      );

      return {
        purchase: updatedPurchase || purchase,
        receipt,
        payment,
      };
    }
  );
}

// 21. Phase 3.5 Stock Movements Conservation Check and Backfill Migration
export async function migratePhase35StockMovements(
  db: Db,
  identity: Identity,
  dryRun: boolean = true
) {
  const tenantId = identity.tenantId;
  const anomalies: string[] = [];

  // 1. Lot conservation check
  const lots = await col<StockLotDocument>(db, 'stockLots').find({tenantId}).toArray();
  for (const lot of lots) {
    const sellable = lot.quantitySellable ?? lot.quantityRemaining ?? 0;
    const sum = sellable +
                (lot.quantityReserved || 0) +
                (lot.quantityDefective || 0) +
                (lot.quantitySold || 0) +
                (lot.quantityReturned || 0) + (lot.quantityRemoved || 0) +
                (lot.quantityConsumed || 0);
    if (sum !== lot.quantityReceived) {
      anomalies.push(`Lot ${lot._id} conservation invariant failed: received=${lot.quantityReceived}, sum=${sum}`);
    }
  }

  if (anomalies.length > 0) {
    return {
      status: 'Failed',
      dryRun,
      anomalies,
      backfilledCount: 0,
      lotConservationPassed: false,
    };
  }

  // 2. Movements check and backfill
  const movements = await col<StockMovementDocument>(db, 'stockMovements').find({
    tenantId,
    onHandDelta: {$exists: false},
  }).toArray();

  const updates: Array<{id: string; onHandDelta: number; sellableDelta: number; defectiveDelta: number}> = [];

  for (const mov of movements) {
    const reason = mov.reason || '';
    if (
      reason.startsWith('Goods receipt') ||
      reason.startsWith('Opening stock') ||
      reason.startsWith('Stock adjustment')
    ) {
      updates.push({
        id: mov._id,
        onHandDelta: mov.qty,
        sellableDelta: mov.qty,
        defectiveDelta: 0,
      });
    } else if (reason.startsWith('Supplier return')) {
      const ret = await col<SupplierReturnDocument>(db, 'supplierReturns').findOne({
        tenantId,
        $or: [{returnNumber: mov.reference}, {_id: mov.reference}],
      });
      const isDefective = ret ? ret.condition === 'Defective' : reason.toLowerCase().includes('defective');
      if (isDefective) {
        updates.push({
          id: mov._id,
          onHandDelta: mov.qty,
          sellableDelta: 0,
          defectiveDelta: mov.qty,
        });
      } else {
        updates.push({
          id: mov._id,
          onHandDelta: mov.qty,
          sellableDelta: mov.qty,
          defectiveDelta: 0,
        });
      }
    } else {
      anomalies.push(`Movement ${mov._id} has unknown reason '${reason}'`);
    }
  }

  if (anomalies.length > 0) {
    return {
      status: 'Failed',
      dryRun,
      anomalies,
      backfilledCount: 0,
      lotConservationPassed: true,
    };
  }

  if (!dryRun) {
    for (const lot of lots) {
      const sellable = lot.quantitySellable ?? lot.quantityRemaining ?? 0;
      await col(db, 'stockLots').updateOne(
        {_id: lot._id, tenantId},
        {$set: {
          quantityRemaining: sellable,
          quantitySellable: sellable,
          quantityReserved: lot.quantityReserved ?? 0,
          quantityDefective: lot.quantityDefective ?? 0,
          quantitySold: lot.quantitySold ?? 0,
          quantityReturned: lot.quantityReturned ?? 0,
          quantityRemoved: lot.quantityRemoved ?? 0,
          updatedAt: lot.updatedAt ?? new Date(),
        }}
      );
    }
    for (const u of updates) {
      await col(db, 'stockMovements').updateOne(
        {_id: u.id, tenantId},
        {
          $set: {
            onHandDelta: u.onHandDelta,
            sellableDelta: u.sellableDelta,
            defectiveDelta: u.defectiveDelta,
          },
        }
      );
    }
    await col(db, 'companySettings').updateOne(
      {tenantId},
      {$set: {'phase35Migration.status': 'Completed', 'phase35Migration.migratedAt': new Date()}},
      {upsert: true}
    );
  }

  return {
    status: 'Completed',
    dryRun,
    anomalies: [],
    backfilledCount: updates.length,
    lotConservationPassed: true,
  };
}
