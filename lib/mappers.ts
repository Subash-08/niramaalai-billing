import { Customer, Supplier, Product, Enquiry, TODAY } from './domain';
import { ServiceItem, InvoiceTemplate } from './extensions';

/**
 * Canonical mappers from MongoDB backend document shapes to frontend domain types.
 * Guarantees that every mapped entity has `id: doc._id || doc.id`.
 */

export function mapCustomerFromApi(doc: any): Customer {
  return {
    id: doc._id || doc.id,
    name: doc.name || '',
    phone: doc.phone || '',
    email: doc.email || '',
    type: doc.type || 'Individual',
    address: doc.address || '',
    gst: doc.gst || '',
    creditLimit: (doc.creditLimitPaise || 0) / 100,
    paymentTerms: doc.paymentTermsDays ?? 30,
    status: doc.status || 'Active',
    notes: doc.notes || '',
    details: doc.details || {},
    outstandingDue: (doc.outstandingDuePaise || 0) / 100,
    totalSales: (doc.totalSalesPaise || 0) / 100,
    invoiceCount: doc.invoiceCount || 0,
    lastActivityDate: doc.lastActivityDate || '',
  };
}

export function mapSupplierFromApi(doc: any): Supplier {
  return {
    id: doc._id || doc.id,
    name: doc.name || '',
    phone: doc.phone || '',
    email: doc.email || '',
    address: doc.address || '',
    gst: doc.gst || '',
    terms: doc.paymentTermsDays !== undefined ? doc.paymentTermsDays : (doc.terms !== undefined ? doc.terms : 30),
    status: doc.status || 'Active',
  };
}

export function mapProductFromApi(doc: any): Product {
  const taxBasisPoints = doc.taxBasisPoints !== undefined && doc.taxBasisPoints !== null ? doc.taxBasisPoints : 1800;
  return {
    id: doc._id || doc.id,
    name: doc.name || '',
    description: doc.description || '',
    unit: doc.unit || 'Piece',
    category: doc.category || 'Accessories',
    brand: doc.brand || '',
    condition: doc.condition || 'New',
    model: doc.model || '',
    hsn: doc.hsn || '',
    cost: (doc.costPaise || 0) / 100,
    price: (doc.sellingPricePaise || 0) / 100,
    tax: taxBasisPoints / 100,
    stock: typeof doc.stock === 'number' ? doc.stock : 0,
    low: doc.low !== undefined && doc.low !== null ? doc.low : 2,
    serials: Array.isArray(doc.serials) ? doc.serials : [],
    warranty: doc.warranty !== undefined && doc.warranty !== null ? doc.warranty : 12,
    supplier: doc.preferredSupplierId || '',
    isSerialTracked: !!doc.isSerialTracked,
    status: doc.status || 'Active',
  };
}

export function mapServiceFromApi(doc: any): ServiceItem {
  const taxBasisPoints = doc.taxBasisPoints !== undefined && doc.taxBasisPoints !== null ? doc.taxBasisPoints : 1800;
  return {
    id: doc._id || doc.id,
    name: doc.name || '',
    category: doc.category || 'Maintenance',
    description: doc.description || '',
    unit: doc.unit || 'Job',
    rate: (doc.ratePaise || 0) / 100,
    tax: taxBasisPoints / 100,
    sac: doc.sac || '998713',
    warranty: doc.warranty !== undefined && doc.warranty !== null ? doc.warranty : 0,
    active: doc.status === 'Active' && doc.active !== false,
    status: doc.status || 'Active',
  };
}

export function mapTemplateFromApi(doc: any): InvoiceTemplate {
  return {
    id: doc._id || doc.id,
    name: doc.name || '',
    title: doc.title || '',
    fields: doc.fields || {},
    columns: doc.columns || [],
    paper: doc.paper || 'A4',
    orientation: doc.orientation || 'portrait',
    fontSize: doc.fontSize || 12,
    accent: doc.accent || '#6246e5',
    borders: doc.borders !== undefined ? doc.borders : true,
    striped: doc.striped !== undefined ? doc.striped : false,
    logoPosition: doc.logoPosition || 'left',
    footer: doc.footer || '',
    isDefault: !!doc.isDefault,
    status: doc.status || 'Active',
    revision: doc.currentRevision ?? doc.revision,
    currentRevision: doc.currentRevision ?? doc.revision,
  };
}

export function mapPurchaseFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    purchaseNumber: doc.purchaseNumber || '',
    supplierId: doc.supplierId || '',
    supplierSnapshot: doc.supplierSnapshot || {},
    supplierInvoiceNumber: doc.supplierInvoiceNumber || '',
    supplierInvoiceDate: doc.supplierInvoiceDate || '',
    financialYear: doc.financialYear || '',
    date: doc.orderDate || '',
    orderDate: doc.orderDate || '',
    postingDate: doc.postingDate || '',
    due: doc.dueDate || '',
    dueDate: doc.dueDate || '',
    promisedPaymentDate: doc.promisedPaymentDate,
    reference: doc.supplierInvoiceNumber || doc.purchaseNumber || '',
    documentStatus: doc.documentStatus || 'Draft',
    billStatus: doc.billStatus || 'NotPosted',
    receiptStatus: doc.receiptStatus || 'NotReceived',
    paymentStatus: doc.paymentStatus || 'NotApplicable',
    status: doc.billStatus === 'Posted' ? (doc.paymentStatus || 'Unpaid') : (doc.documentStatus || 'Draft'),
    inclusive: !!doc.inclusive,
    taxMode: doc.taxMode || 'Intra-state',
    placeOfSupply: doc.placeOfSupply || 'Tamil Nadu',
    notes: doc.notes || '',
    attachmentFileId: doc.attachmentFileId,
    total: (doc.totalPaise || 0) / 100,
    subtotal: (doc.subtotalPaise || 0) / 100,
    taxTotal: (doc.taxTotalPaise || 0) / 100,
    paid: (doc.allocatedPaidPaise || 0) / 100,
    creditedAmount: (doc.creditedLiabilityPaise || 0) / 100,
    dueAmount: (doc.duePaise || 0) / 100,
    balance: (doc.duePaise || 0) / 100,
    version: doc.version || 1,
    lines: (doc.lines || []).map((l: any) => ({
      clientLineKey: l.clientLineKey || l.lineId || '',
      lineId: l.lineId || '',
      lineType: l.lineType || 'Product',
      productId: l.productId || '',
      name: l.productSnapshot?.name || l.description || 'Product',
      description: l.description || '',
      sac: l.sac || '',
      hsn: l.productSnapshot?.hsn || l.sac || '',
      warranty: l.productSnapshot?.warrantyMonths ?? 0,
      qty: l.quantityOrdered ?? 0,
      quantityOrdered: l.quantityOrdered ?? 0,
      quantityReceived: l.quantityReceived || 0,
      quantityCancelled: l.quantityCancelled || 0,
      quantityReturned: l.quantityReturned || 0,
      rate: (l.unitCostPaise ?? l.ratePaise ?? 0) / 100,
      discount: l.discountType === 'Percentage' ? (l.discountValue || 0) / 100 : (l.discountValue || 0) / 100,
      discountType: l.discountType || 'Percentage',
      discountValue: l.discountValue || 0,
      tax: (l.taxBasisPoints ?? 0) / 100,
      taxBasisPoints: l.taxBasisPoints ?? 0,
      taxableBase: (l.taxableBasePaise || 0) / 100,
      taxAmount: (l.taxAmountPaise || 0) / 100,
      cgst: (l.cgstPaise || 0) / 100,
      sgst: (l.sgstPaise || 0) / 100,
      igst: (l.igstPaise || 0) / 100,
      total: (l.totalPaise || 0) / 100,
      paid: (l.allocatedPaidPaise || 0) / 100,
      credited: (l.creditedLiabilityPaise || 0) / 100,
      due: (l.remainingDuePaise || 0) / 100,
      serials: [],
      isSerialTracked: !!l.productSnapshot?.isSerialTracked,
    })),
  };
}

export function mapPaymentFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    paymentNumber: doc.paymentNumber || '',
    supplierId: doc.supplierId || '',
    date: doc.date || '',
    totalAmount: (doc.totalAmountPaise || 0) / 100,
    allocatedAmount: (doc.allocatedAmountPaise || 0) / 100,
    advanceAmount: (doc.advanceAmountPaise || 0) / 100,
    advanceId: doc.advanceId,
    notes: doc.notes || '',
    note: doc.notes || '',
    purpose: 'Supplier payment',
    reference: doc.paymentNumber || '',
    party: doc.supplierId || '',
    isReversed: !!doc.isReversed,
    reversalReason: doc.reversalReason,
    canReverse: doc.canReverse !== undefined ? !!doc.canReverse : !doc.isReversed,
    reverseBlockReason: doc.reverseBlockReason,
    components: (doc.components || []).map((c: any) => ({
      componentId: c.componentId,
      account: c.account,
      method: c.method || 'Cash',
      reference: c.reference || '',
      amount: (c.amountPaise || 0) / 100,
    })),
  };
}

export function mapAdvanceFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    advanceNumber: doc.advanceNumber || '',
    supplierId: doc.supplierId || '',
    sourceType: doc.sourceType || 'ExplicitAdvance',
    originalAmount: (doc.originalAmountPaise || 0) / 100,
    allocatedAmount: (doc.allocatedPaise || 0) / 100,
    refundedAmount: (doc.refundedPaise || 0) / 100,
    remainingAmount: (doc.remainingAmountPaise || 0) / 100,
    status: doc.status || 'Open',
    createdAt: doc.createdAt,
  };
}

export function mapStockLotFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    productId: doc.productId || '',
    purchaseId: doc.purchaseId,
    purchaseReceiptId: doc.purchaseReceiptId,
    batchNumber: doc.batchNumber,
    receivedDate: doc.receivedDate || '',
    quantityReceived: doc.quantityReceived || 0,
    quantitySellable: doc.quantitySellable || 0,
    quantityReserved: doc.quantityReserved || 0,
    quantityDefective: doc.quantityDefective || 0,
    quantitySold: doc.quantitySold || 0,
    quantityReturned: doc.quantityReturned || 0,
    quantityRemoved: doc.quantityRemoved ?? 0,
    unitCost: (doc.unitCostPaise || 0) / 100,
    product: doc.product ? mapProductFromApi(doc.product) : undefined,
  };
}

export function mapSerialUnitFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    serial: doc.serialOriginal || doc.serialNormalized || '',
    serialNormalized: doc.serialNormalized || '',
    productId: doc.productId || '',
    lotId: doc.lotId || '',
    status: doc.status || 'InStock',
    receivedDate: doc.receivedDate || '',
  };
}

export function mapStockMovementFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    date: doc.date || '',
    productId: doc.productId || '',
    lotId: doc.lotId,
    qty: doc.qty || 0,
    onHandDelta: doc.onHandDelta !== undefined ? doc.onHandDelta : (doc.qty || 0),
    sellableDelta: doc.sellableDelta !== undefined ? doc.sellableDelta : (doc.qty || 0),
    defectiveDelta: doc.defectiveDelta !== undefined ? doc.defectiveDelta : 0,
    reason: doc.reason || '',
    reference: doc.reference || '',
    serials: doc.serials || [],
    createdAt: doc.createdAt,
  };
}

export function mapReceiptFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    receiptNumber: doc.receiptNumber || '',
    purchaseId: doc.purchaseId || '',
    receiptDate: doc.receiptDate || '',
    notes: doc.notes || '',
    lines: (doc.lines || []).map((l: any) => ({
      lineId: l.lineId || '',
      clientLineKey: l.clientLineKey,
      productId: l.productId || '',
      lotId: l.lotId || '',
      quantityReceived: l.quantityReceived || 0,
      serials: l.serials || [],
    })),
    isReversed: !!doc.isReversed,
    reversalReason: doc.reversalReason,
    reversedAt: doc.reversedAt,
    reversedBy: doc.reversedBy,
    canReverse: doc.canReverse !== undefined ? !!doc.canReverse : !doc.isReversed,
    reverseBlockReason: doc.reverseBlockReason,
  };
}

export function mapReturnFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    returnNumber: doc.returnNumber || '',
    supplierId: doc.supplierId || '',
    purchaseId: doc.purchaseId || '',
    purchaseLineId: doc.purchaseLineId || '',
    productId: doc.productId || '',
    lotId: doc.lotId || '',
    date: doc.date || '',
    quantity: doc.quantity || 0,
    serials: doc.serials || [],
    totalReturnCredit: (doc.totalReturnCreditPaise || 0) / 100,
    reason: doc.reason || '',
    condition: doc.condition || 'Sellable',
    disposition: doc.disposition || 'ReturnedToSupplier',
    status: doc.status || 'PendingCreditAcceptance',
    creditNoteId: doc.creditNoteId,
    isReversed: !!doc.isReversed,
    reversalReason: doc.reversalReason,
    reversedAt: doc.reversedAt,
    reversedBy: doc.reversedBy,
    canReverse: doc.canReverse !== undefined ? !!doc.canReverse : !doc.isReversed,
    reverseBlockReason: doc.reverseBlockReason,
  };
}

export function mapCreditNoteFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    creditNoteNumber: doc.creditNoteNumber || '',
    supplierId: doc.supplierId || '',
    purchaseId: doc.purchaseId,
    date: doc.date || '',
    reason: doc.reason || 'GoodsReturn',
    acceptedCredit: (doc.acceptedCreditPaise || 0) / 100,
    allocatedLiability: (doc.allocatedLiabilityPaise || 0) / 100,
    unallocatedCredit: (doc.unallocatedCreditPaise || 0) / 100,
    advanceId: doc.advanceId,
    isReversed: !!doc.isReversed,
    canReverse: doc.canReverse !== undefined ? !!doc.canReverse : !doc.isReversed,
    reverseBlockReason: doc.reverseBlockReason,
  };
}

export function mapAllocationFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    sourceType: doc.sourceType || 'Payment',
    sourceId: doc.sourceId || '',
    targetType: doc.targetType || 'PurchaseLine',
    targetId: doc.targetId || '',
    purchaseLineId: doc.purchaseLineId,
    amount: (doc.amountPaise || 0) / 100,
    effectiveDate: doc.effectiveDate || '',
    isReversal: !!doc.isReversal,
    reversesAllocationId: doc.reversesAllocationId,
    canReverse: doc.canReverse !== undefined ? !!doc.canReverse : !doc.isReversal,
    reverseBlockReason: doc.reverseBlockReason,
  };
}

export function mapInvoiceFromApi(doc: any) {
  const totalPaise = doc.totalPaise || 0;
  const duePaise = doc.duePaise || 0;
  const paidPaise = Math.max(0, totalPaise - duePaise);
  const paymentStatus = doc.paymentStatus || (duePaise === 0 ? 'Paid' : paidPaise > 0 ? 'PartlyPaid' : 'Unpaid');
  return {
    id: doc._id || doc.id,
    invoiceNumber: doc.invoiceNumber || '',
    customerId: doc.customerId || '',
    date: doc.invoiceDate || '',
    due: doc.dueDate || doc.invoiceDate || '',
    promisedPaymentDate: doc.promisedPaymentDate,
    kind: (doc.invoiceKind || 'Sale') as any,
    category: (doc.businessCategory === 'NewGoods' ? 'New goods' : doc.businessCategory === 'UsedGoods' ? 'Used goods' : 'Service') as any,
    status: doc.status || 'Draft',
    paymentStatus,
    lines: (doc.lines || []).map((l: any) => ({
      invoiceLineId: l.lineId || l._id || l.id,
      productId: l.productId || '',
      name: l.description || l.productSnapshot?.name || '',
      details: l.details || '',
      unit: l.unit || 'Piece',
      printSpecifications: l.printSpecifications || {},
      qty: l.quantity || 0,
      rate: (l.unitRatePaise || 0) / 100,
      discount: (l.discountValue || 0) / 100,
      discountType: l.discountType || 'Percentage',
      tax: (l.taxBasisPoints || 0) / 100,
      taxTreatment: (l.taxTreatment || 'Taxable') as 'Taxable' | 'Exempt' | 'NonGST',
      returnedQuantity: l.returnedQuantity || 0,
      serials: (l.stockAllocations || []).flatMap((a: any) => a.serials || []),
      hsn: l.hsn || l.sac || '',
      sac: l.sac || '',
      serviceId: l.serviceId || undefined,
      warranty: l.warrantyMonths || 0,
      lineType: l.lineType || 'Product',
      stockAllocations: l.stockAllocations || [],
      clientLineKey: l.clientLineKey || l.lineId,
    })),
    inclusive: !!doc.inclusive,
    taxMode: doc.taxMode || 'Intra-state',
    placeOfSupply: doc.placeOfSupply || '',
    notes: doc.notes || '',
    profit: null,
    customerSnapshot: doc.customerSnapshot ? mapCustomerFromApi(doc.customerSnapshot) : undefined,
    templateId: doc.templateId,
    templateRevision: doc.templateRevision,
    templateSnapshot: doc.issuedSnapshot?.template,
    shopSnapshot: doc.issuedSnapshot?.seller ? {...doc.issuedSnapshot.seller, logo: doc.issuedSnapshot.seller.logoFileId ? '/api/files/' + doc.issuedSnapshot.seller.logoFileId : ''} : undefined,
    billTo: doc.billTo,
    shipTo: doc.shipTo,
    sourceId: doc.sourceQuotationId,
    printJobId: doc.printJobId || undefined,
    jobId: doc.printJobId || doc.jobId || undefined,
    total: totalPaise / 100,
    paid: paidPaise / 100,
    paidAmount: paidPaise / 100,
    dueAmount: duePaise / 100,
    version: doc.version,
    roundOff: (doc.roundOffPaise || 0) / 100,
  };
}

export function mapQuotationFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    quotationNumber: doc.quotationNumber || '',
    customerId: doc.customerId || '',
    date: doc.quotationDate || '',
    due: doc.validUntil || doc.quotationDate || '',
    validUntil: doc.validUntil,
    kind: 'Quotation' as const,
    category: (doc.businessCategory === 'NewGoods' ? 'New goods' : doc.businessCategory === 'UsedGoods' ? 'Used goods' : 'Service') as any,
    status: doc.status === 'Sent' ? 'Shared' : (doc.status || 'Draft'),
    lines: (doc.lines || []).map((l: any) => ({
      invoiceLineId: l.lineId || l._id || l.id,
      productId: l.productId || '',
      name: l.description || l.productSnapshot?.name || '',
      details: l.details || '',
      unit: l.unit || 'Piece',
      printSpecifications: l.printSpecifications || {},
      qty: l.quantity || 0,
      rate: (l.unitRatePaise || 0) / 100,
      discount: (l.discountValue || 0) / 100,
      discountType: l.discountType || 'Percentage',
      tax: (l.taxBasisPoints || 0) / 100,
      taxTreatment: (l.taxTreatment || 'Taxable') as 'Taxable' | 'Exempt' | 'NonGST',
      serials: [],
      hsn: l.hsn || l.sac || '',
      sac: l.sac || '',
      serviceId: l.serviceId || undefined,
      warranty: l.warrantyMonths || 0,
      lineType: l.lineType || 'Product',
      stockAllocations: l.stockAllocations || [],
      clientLineKey: l.clientLineKey || l.lineId,
    })),
    inclusive: !!doc.inclusive,
    taxMode: doc.taxMode || 'Intra-state',
    placeOfSupply: doc.placeOfSupply || '',
    notes: doc.notes || '',
    profit: null,
    customerSnapshot: doc.customerSnapshot ? mapCustomerFromApi(doc.customerSnapshot) : undefined,
    templateId: doc.templateId,
    templateRevision: doc.templateRevision,
    billTo: doc.billTo,
    shipTo: doc.shipTo,
    total: (doc.totalPaise || 0) / 100,
    paid: 0,
    dueAmount: (doc.totalPaise || 0) / 100,
    version: doc.version,
  };
}

export function mapReservationFromApi(doc: any) {
  return {
    id: doc._id || doc.id,
    reservationNumber: doc.reservationNumber || '',
    customerId: doc.customerId || '',
    productId: doc.productId || '',
    lotId: doc.lotId || '',
    qty: doc.quantity || 0,
    remainingQuantity: doc.remainingQuantity ?? doc.quantity,
    consumedQuantity: doc.consumedQuantity ?? 0,
    releasedQuantity: doc.releasedQuantity ?? 0,
    serials: doc.serials || [],
    date: doc.reservedAt || '',
    expires: doc.expiresAt || '',
    status: doc.status || 'Active',
    notes: doc.notes || '',
    version: doc.version,
  };
}

export function mapEnquiryFromApi(doc: any): Enquiry {
  return {
    id: doc._id || doc.id,
    customerId: doc.customerId || '',
    date: doc.date || (doc.createdAt ? new Date(doc.createdAt).toISOString().slice(0, 10) : TODAY),
    category: doc.category || 'New laptop',
    requirement: doc.requirement || '',
    budget: typeof doc.budgetPaise === 'number' ? doc.budgetPaise / 100 : (doc.budget || 0),
    status: doc.status || 'Open',
    followUp: doc.followUpDate || doc.followUp || TODAY,
    notes: doc.notes || '',
  };
}


