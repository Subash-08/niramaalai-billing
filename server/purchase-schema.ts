import {z} from 'zod';
import {CalendarDateSchema, isValidCalendarDate} from './master-schema';

export {CalendarDateSchema, isValidCalendarDate};

export function todayInKolkata(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

export function deriveFinancialYear(dateStr: string): string {
  const parts = dateStr.split('-').map(Number);
  const y = parts[0] || 2026;
  const m = parts[1] || 4;
  if (m >= 4) {
    return `${y}-${y + 1}`;
  } else {
    return `${y - 1}-${y}`;
  }
}

export const PurchaseDocumentStatusEnum = z.enum(['Draft', 'Confirmed', 'Cancelled']);
export type PurchaseDocumentStatus = z.infer<typeof PurchaseDocumentStatusEnum>;

export const PurchaseBillStatusEnum = z.enum(['NotPosted', 'Posted', 'Credited', 'FullyCredited']);
export type PurchaseBillStatus = z.infer<typeof PurchaseBillStatusEnum>;

export const PurchaseReceiptStatusEnum = z.enum(['NotReceived', 'PartlyReceived', 'Received', 'ClosedPartlyReceived']);
export type PurchaseReceiptStatus = z.infer<typeof PurchaseReceiptStatusEnum>;

export const PurchasePaymentStatusEnum = z.enum(['NotApplicable', 'Unpaid', 'PartlyPaid', 'Paid']);
export type PurchasePaymentStatus = z.infer<typeof PurchasePaymentStatusEnum>;

export const DiscountTypeEnum = z.enum(['Percentage', 'Amount']);
export type DiscountType = z.infer<typeof DiscountTypeEnum>;

export const TaxModeEnum = z.enum(['Intra-state', 'Inter-state']);
export type TaxMode = z.infer<typeof TaxModeEnum>;

export const SupplierPaymentMethodEnum = z.enum(['Cash', 'BankTransfer', 'UPI', 'Cheque', 'Split']);
export type SupplierPaymentMethod = z.infer<typeof SupplierPaymentMethodEnum>;

export const SupplierAdvanceStatusEnum = z.enum(['Open', 'PartlyConsumed', 'Consumed']);
export type SupplierAdvanceStatus = z.infer<typeof SupplierAdvanceStatusEnum>;

export function deriveAdvanceStatus(adv: { remainingAmountPaise: number; originalAmountPaise: number }): SupplierAdvanceStatus {
  if (adv.remainingAmountPaise >= adv.originalAmountPaise) return 'Open';
  if (adv.remainingAmountPaise > 0) return 'PartlyConsumed';
  return 'Consumed';
}

export const SupplierAdvanceSourceTypeEnum = z.enum(['PaymentOverpay', 'ExplicitAdvance', 'CreditNoteExcess', 'ReversalCredit']);
export type SupplierAdvanceSourceType = z.infer<typeof SupplierAdvanceSourceTypeEnum>;

export const SupplierReturnConditionEnum = z.enum(['Sellable', 'Defective']);
export type SupplierReturnCondition = z.infer<typeof SupplierReturnConditionEnum>;

export const SupplierReturnDispositionEnum = z.enum(['ReturnedToSupplier', 'ScrappedOnSite']);
export type SupplierReturnDisposition = z.infer<typeof SupplierReturnDispositionEnum>;

export const SupplierReturnStatusEnum = z.enum(['PendingCreditAcceptance', 'CreditAccepted', 'Completed']);
export type SupplierReturnStatus = z.infer<typeof SupplierReturnStatusEnum>;

export const SupplierCreditNoteReasonEnum = z.enum([
  'UndeliveredBilledGoods',
  'PriceReduction',
  'FreightCredit',
  'DefectiveAllowance',
  'GoodsReturn'
]);
export type SupplierCreditNoteReason = z.infer<typeof SupplierCreditNoteReasonEnum>;

// Server-side operational limits
export const MAX_PURCHASE_LINES = 100;
export const MAX_LINE_QTY = 10000;
export const MAX_UNIT_RATE_PAISE = 1000000000; // ₹1 crore
export const MAX_PURCHASE_TOTAL_PAISE = 5000000000; // ₹5 crore
export const MAX_ALLOCATIONS_PER_PAYMENT = 100;
export const MAX_SERIALS_COUNT = 10000;
export const MAX_SERIAL_LENGTH = 64;
export const MAX_NOTES_LENGTH = 1000;
export const MAX_EXPORT_ROWS = 5000;

export const PurchaseListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  hasDue: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  supplierId: z.string().trim().max(128).optional(),
  productId: z.string().trim().max(128).optional(),
  status: z.string().trim().max(32).optional(),
  documentStatus: PurchaseDocumentStatusEnum.optional(),
  billStatus: PurchaseBillStatusEnum.optional(),
  receiptStatus: PurchaseReceiptStatusEnum.optional(),
  paymentStatus: PurchasePaymentStatusEnum.optional(),
  dateFrom: CalendarDateSchema.optional(),
  dateTo: CalendarDateSchema.optional(),
  search: z.string().trim().max(200).optional(),
}).refine(q => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
  message: 'Date from must be on or before date to.',
  path: ['dateTo'],
});

export const InventoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  productId: z.string().trim().max(128).optional(),
  lotId: z.string().trim().max(128).optional(),
  status: z.enum(['InStock', 'Reserved', 'Sold', 'Returned', 'Defective']).optional(),
  search: z.string().trim().max(200).optional(),
  dateFrom: CalendarDateSchema.optional(),
  dateTo: CalendarDateSchema.optional(),
}).refine(q => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
  message: 'Date from must be on or before date to.',
  path: ['dateTo'],
});

export const SupplierHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  dateFrom: CalendarDateSchema.optional(),
  dateTo: CalendarDateSchema.optional(),
}).refine(q => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
  message: 'Date from must be on or before date to.',
  path: ['dateTo'],
});

export const SupplierStatementQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  asOfDate: CalendarDateSchema.optional(),
  dateFrom: CalendarDateSchema.optional(),
  dateTo: CalendarDateSchema.optional(),
}).refine(q => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
  message: 'Date from must be on or before date to.',
  path: ['dateTo'],
});

export const SupplierTransactionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  supplierId: z.string().trim().max(128).optional(),
  purchaseId: z.string().trim().max(128).optional(),
  dateFrom: CalendarDateSchema.optional(),
  dateTo: CalendarDateSchema.optional(),
}).refine(q => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
  message: 'Date from must be on or before date to.',
  path: ['dateTo'],
});

// Input schemas
export const PurchaseLineInputSchema = z.object({
  clientLineKey: z.string().trim().min(1).max(64).optional(),
  lineId: z.string().trim().optional(),
  lineType: z.enum(['Product', 'Charge']).default('Product'),
  productId: z.string().trim().optional(),
  description: z.string().trim().max(200).optional(),
  sac: z.string().trim().max(20).optional(),
  quantityOrdered: z.number().int().min(1).max(MAX_LINE_QTY).default(1),
  unitCostPaise: z.number().int().min(0).max(MAX_UNIT_RATE_PAISE),
  discountType: DiscountTypeEnum.default('Percentage'),
  discountValue: z.number().int().min(0).max(MAX_UNIT_RATE_PAISE).default(0), // Basis points (0..10000) or paise
  taxBasisPoints: z.number().int().min(0).max(10000).default(1800), // e.g. 1800 = 18.00%
});

export type PurchaseLineInput = z.infer<typeof PurchaseLineInputSchema>;

export const CreatePurchaseSchema = z.object({
  supplierId: z.string().trim().min(1, 'Supplier is required'),
  orderDate: CalendarDateSchema.default(() => todayInKolkata()),
  dueDate: CalendarDateSchema.optional(),
  supplierInvoiceNumber: z.string().trim().max(100).optional(),
  supplierInvoiceDate: CalendarDateSchema.optional(),
  inclusive: z.boolean().default(false),
  taxMode: TaxModeEnum.default('Intra-state'),
  placeOfSupply: z.string().trim().max(100).default('Tamil Nadu'),
  notes: z.string().trim().max(MAX_NOTES_LENGTH).optional().default(''),
  attachmentFileId: z.string().trim().optional(),
  postImmediately: z.boolean().default(false),
  lines: z.array(PurchaseLineInputSchema)
    .min(1, 'At least one line is required')
    .max(MAX_PURCHASE_LINES)
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((l, i) => {
        if (l.clientLineKey) {
          if (seen.has(l.clientLineKey)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, 'clientLineKey'],
              message: 'Duplicate clientLineKey',
            });
          } else {
            seen.add(l.clientLineKey);
          }
        }
      });
    }),
});

export type CreatePurchaseInput = z.infer<typeof CreatePurchaseSchema>;

export const UpdatePurchaseDraftSchema = z.object({
  version: z.number().int().min(1, 'Version is required for optimistic concurrency'),
  supplierId: z.string().trim().min(1, 'Supplier is required'),
  orderDate: CalendarDateSchema,
  dueDate: CalendarDateSchema.optional(),
  supplierInvoiceNumber: z.string().trim().max(100).optional(),
  supplierInvoiceDate: CalendarDateSchema.optional(),
  inclusive: z.boolean().default(false),
  taxMode: TaxModeEnum.default('Intra-state'),
  placeOfSupply: z.string().trim().max(100).default('Tamil Nadu'),
  notes: z.string().trim().max(MAX_NOTES_LENGTH).optional().default(''),
  attachmentFileId: z.string().trim().optional(),
  lines: z.array(PurchaseLineInputSchema)
    .min(1, 'At least one line is required')
    .max(MAX_PURCHASE_LINES)
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((l, i) => {
        if (l.clientLineKey) {
          if (seen.has(l.clientLineKey)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, 'clientLineKey'],
              message: 'Duplicate clientLineKey',
            });
          } else {
            seen.add(l.clientLineKey);
          }
        }
      });
    }),
});

export type UpdatePurchaseDraftInput = z.infer<typeof UpdatePurchaseDraftSchema>;

export const ConfirmPurchaseOrderSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type ConfirmPurchaseOrderInput = z.infer<typeof ConfirmPurchaseOrderSchema>;

export const CancelPurchaseOrderSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  reason: z.string().trim().min(1).max(500).optional().default('Cancelled order'),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type CancelPurchaseOrderInput = z.infer<typeof CancelPurchaseOrderSchema>;

export const CloseRemainderSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  reason: z.string().trim().min(1).max(500).optional().default('Closed remainder by user'),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type CloseRemainderInput = z.infer<typeof CloseRemainderSchema>;

export const PostPurchaseBillSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  supplierInvoiceNumber: z.string().trim().min(1, 'Supplier bill/invoice number is required').max(100),
  supplierInvoiceDate: CalendarDateSchema,
  dueDate: CalendarDateSchema.optional(),
  notes: z.string().trim().max(MAX_NOTES_LENGTH).optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});

export type PostPurchaseBillInput = z.infer<typeof PostPurchaseBillSchema>;

export const QuarantineStockSchema = z.object({
  lotId: z.string().trim().min(1, 'Stock lot ID is required'),
  quantity: z.number().int().min(1, 'Quantity must be at least 1').max(MAX_LINE_QTY),
  serials: z.array(z.string().trim().min(1).max(MAX_SERIAL_LENGTH)).optional().default([]),
  reason: z.string().trim().min(1, 'Quarantine reason is required').max(500),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type QuarantineStockInput = z.infer<typeof QuarantineStockSchema>;

export const RestoreDefectiveStockSchema = z.object({
  lotId: z.string().trim().min(1, 'Stock lot ID is required'),
  quantity: z.number().int().min(1, 'Quantity must be at least 1').max(MAX_LINE_QTY),
  serials: z.array(z.string().trim().min(1).max(MAX_SERIAL_LENGTH)).optional().default([]),
  reason: z.string().trim().min(1, 'Restore reason is required').max(500),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type RestoreDefectiveStockInput = z.infer<typeof RestoreDefectiveStockSchema>;

export const ReverseReceiptSchema = z.object({
  reason: z.string().trim().min(1, 'Reversal reason is required').max(500),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type ReverseReceiptInput = z.infer<typeof ReverseReceiptSchema>;

export const ReceiveStockLineInputSchema = z.object({
  lineId: z.string().trim().min(1, 'Line ID is required').optional(),
  clientLineKey: z.string().trim().min(1).max(64).optional(),
  quantityReceived: z.number().int().min(1).max(MAX_LINE_QTY),
  serials: z.array(z.string().trim().min(1).max(MAX_SERIAL_LENGTH)).optional().default([]),
});

export const ReceiveStockSchema = z.object({
  receiptDate: CalendarDateSchema.default(() => todayInKolkata()),
  notes: z.string().trim().max(MAX_NOTES_LENGTH).optional().default(''),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key is required'),
  lines: z.array(ReceiveStockLineInputSchema).min(1, 'At least one receipt line is required'),
});

export type ReceiveStockInput = z.infer<typeof ReceiveStockSchema>;

export const PaymentComponentInputSchema = z.object({
  account: z.enum(['Cash', 'Bank']),
  method: z.enum(['Cash', 'BankTransfer', 'UPI', 'Cheque']).default('Cash'),
  reference: z.string().trim().max(100).optional().default(''),
  amountPaise: z.number().int().min(1, 'Payment component amount must be positive').max(MAX_PURCHASE_TOTAL_PAISE),
});

export const PaymentAllocationInputSchema = z.object({
  targetType: z.enum(['PurchaseLine', 'OpeningPayable']),
  targetId: z.string().trim().min(1, 'Target ID is required'),
  purchaseLineId: z.string().trim().optional(),
  amountPaise: z.number().int().min(1, 'Allocation amount must be positive').max(MAX_PURCHASE_TOTAL_PAISE),
});

export const RecordSupplierPaymentSchema = z.object({
  supplierId: z.string().trim().min(1, 'Supplier ID is required'),
  date: CalendarDateSchema.default(() => todayInKolkata()),
  components: z.array(PaymentComponentInputSchema).min(1, 'At least one payment component is required'),
  allocations: z.array(PaymentAllocationInputSchema).max(MAX_ALLOCATIONS_PER_PAYMENT).default([]),
  recordExcessAsAdvance: z.boolean().default(false),
  notes: z.string().trim().max(MAX_NOTES_LENGTH).optional().default(''),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key is required'),
});

export type RecordSupplierPaymentInput = z.infer<typeof RecordSupplierPaymentSchema>;

export const AllocateAdvanceSchema = z.object({
  allocations: z.array(PaymentAllocationInputSchema).min(1, 'At least one allocation target is required').max(MAX_ALLOCATIONS_PER_PAYMENT),
  effectiveDate: CalendarDateSchema.default(() => todayInKolkata()),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key is required'),
});

export type AllocateAdvanceInput = z.infer<typeof AllocateAdvanceSchema>;

export const SupplierReturnSchema = z.object({
  purchaseId: z.string().trim().min(1, 'Purchase ID is required'),
  purchaseLineId: z.string().trim().min(1, 'Purchase line ID is required'),
  lotId: z.string().trim().min(1, 'Stock lot ID is required'),
  quantity: z.number().int().min(1).max(MAX_LINE_QTY),
  serials: z.array(z.string().trim().min(1).max(MAX_SERIAL_LENGTH)).optional().default([]),
  reason: z.string().trim().min(1, 'Return reason is required').max(500),
  condition: SupplierReturnConditionEnum.default('Sellable'),
  disposition: SupplierReturnDispositionEnum.default('ReturnedToSupplier'),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key is required'),
});

export type SupplierReturnInput = z.infer<typeof SupplierReturnSchema>;

export const AcceptReturnCreditNoteSchema = z.object({
  supplierCreditNoteNumber: z.string().trim().max(100).optional(),
  date: CalendarDateSchema.default(() => todayInKolkata()),
  acceptedCreditPaise: z.number().int().min(1, 'Credit note value must be positive'),
  allocateToBillDue: z.boolean().default(true),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key is required'),
});

export type AcceptReturnCreditNoteInput = z.infer<typeof AcceptReturnCreditNoteSchema>;

export const CreateStandaloneCreditNoteSchema = z.object({
  supplierId: z.string().trim().min(1, 'Supplier ID is required'),
  purchaseId: z.string().trim().optional(),
  supplierCreditNoteNumber: z.string().trim().max(100).optional(),
  reason: SupplierCreditNoteReasonEnum,
  date: CalendarDateSchema.default(() => todayInKolkata()),
  taxMode: TaxModeEnum.default('Intra-state'),
  lines: z.array(z.object({
    lineId: z.string().trim().optional(),
    productId: z.string().trim().optional(),
    description: z.string().trim().min(1).max(200),
    taxableBasePaise: z.number().int().min(0),
    taxBasisPoints: z.number().int().min(0).max(10000).default(1800),
  })).min(1, 'At least one credit line is required'),
  allocateToBillDue: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key is required'),
});

export type CreateStandaloneCreditNoteInput = z.infer<typeof CreateStandaloneCreditNoteSchema>;

export const RecordSupplierRefundSchema = z.object({
  advanceId: z.string().trim().min(1, 'Advance ID is required'),
  amountPaise: z.number().int().min(1, 'Refund amount must be positive'),
  account: z.enum(['Cash', 'Bank']),
  date: CalendarDateSchema.default(() => todayInKolkata()),
  reference: z.string().trim().max(100).default(''),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key is required'),
});

export type RecordSupplierRefundInput = z.infer<typeof RecordSupplierRefundSchema>;

export const ReverseOperationSchema = z.object({
  reason: z.string().trim().min(1, 'Reversal reason is required').max(500),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});

export type ReverseOperationInput = z.infer<typeof ReverseOperationSchema>;

export const RecordReceiveSchema = z.object({
  purchase: CreatePurchaseSchema.extend({
    supplierInvoiceNumber: z.string().trim().min(1, 'Supplier invoice number is required').max(100),
    supplierInvoiceDate: CalendarDateSchema,
    postImmediately: z.literal(true).default(true),
  }),
  receipt: z.object({
    receiptDate: CalendarDateSchema.default(() => todayInKolkata()),
    lines: z.array(ReceiveStockLineInputSchema).min(1, 'At least one receipt line is required'),
    notes: z.string().trim().max(MAX_NOTES_LENGTH).optional().default(''),
  }),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key is required').max(128),
});

export type RecordReceiveInput = z.infer<typeof RecordReceiveSchema>;

export const RecordReceiveAndPaySchema = z.object({
  purchase: CreatePurchaseSchema.extend({
    supplierInvoiceNumber: z.string().trim().min(1, 'Supplier invoice number is required').max(100),
    supplierInvoiceDate: CalendarDateSchema,
    postImmediately: z.literal(true).default(true),
  }),
  receipt: z.object({
    receiptDate: CalendarDateSchema.default(() => todayInKolkata()),
    lines: z.array(ReceiveStockLineInputSchema).min(1, 'At least one receipt line is required'),
    notes: z.string().trim().max(MAX_NOTES_LENGTH).optional().default(''),
  }),
  payment: z.object({
    components: z.array(PaymentComponentInputSchema).min(1, 'At least one payment component is required'),
    recordExcessAsAdvance: z.boolean().default(false),
    notes: z.string().trim().max(MAX_NOTES_LENGTH).optional().default(''),
  }),
  idempotencyKey: z.string().trim().min(1, 'Idempotency key is required').max(128),
});

export type RecordReceiveAndPayInput = z.infer<typeof RecordReceiveAndPaySchema>;

// Document Interfaces
export interface PurchaseDocument {
  _id: string;
  purchaseNumber: string;
  tenantId: string;
  version: number;
  supplierId: string;
  supplierSnapshot: {
    name: string;
    phone: string;
    email: string;
    address: string;
    gst: string;
    paymentTermsDays: number;
  };
  supplierInvoiceNumber?: string;
  supplierInvoiceNumberNormalized?: string;
  supplierInvoiceDate?: string;
  financialYear: string;
  orderDate: string;
  postingDate?: string;
  dueDate: string;

  documentStatus: PurchaseDocumentStatus;
  billStatus: PurchaseBillStatus;
  receiptStatus: PurchaseReceiptStatus;
  paymentStatus: PurchasePaymentStatus;

  inclusive: boolean;
  taxMode: TaxMode;
  placeOfSupply: string;
  currency: 'INR';
  notes: string;
  attachmentFileId?: string;

  lines: Array<PurchaseProductLine | PurchaseChargeLine>;

  subtotalPaise: number;
  taxTotalPaise: number;
  totalPaise: number;
  allocatedPaidPaise: number;
  creditedLiabilityPaise: number;
  duePaise: number;

  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface PurchaseProductLine {
  clientLineKey?: string;
  lineId: string;
  lineType: 'Product';
  productId: string;
  productSnapshot: {
    name: string;
    category: string;
    brand: string;
    model: string;
    condition: 'New' | 'Used';
    hsn: string;
    isSerialTracked: boolean;
  };
  quantityOrdered: number;
  quantityReceived: number;
  quantityCancelled: number;
  quantityReturned: number;
  unitCostPaise: number;
  discountType: DiscountType;
  discountValue: number;
  taxBasisPoints: number;
  taxableBasePaise: number;
  taxAmountPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  creditedLiabilityPaise: number;
  allocatedPaidPaise: number;
  remainingDuePaise: number;
}

export interface PurchaseChargeLine {
  clientLineKey?: string;
  lineId: string;
  lineType: 'Charge';
  description: string;
  sac: string;
  ratePaise: number;
  discountType: DiscountType;
  discountValue: number;
  taxBasisPoints: number;
  taxableBasePaise: number;
  taxAmountPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  creditedLiabilityPaise: number;
  allocatedPaidPaise: number;
  remainingDuePaise: number;
}

export interface PurchaseReceiptDocument {
  _id: string;
  receiptNumber: string;
  tenantId: string;
  purchaseId: string;
  purchaseNumber: string;
  receiptDate: string;
  notes: string;
  idempotencyKey: string;
  lines: Array<{
    lineId: string;
    productId: string;
    lotId: string;
    quantityReceived: number;
    serials: string[];
  }>;
  isReversed?: boolean;
  reversalReason?: string;
  reversedAt?: Date;
  reversedBy?: string;
  createdAt: Date;
  createdBy: string;
}

export interface StockLotDocument {
  _id: string;
  tenantId: string;
  productId: string;
  lotType: 'Opening' | 'Purchase' | 'Adjustment';
  purchaseId?: string;
  purchaseLineId?: string;
  purchaseReceiptId?: string;
  receivedDate: string;
  costPaise: number;
  sourceReference: string;

  quantityReceived: number;
  /** Compatibility mirror of quantitySellable used by Phase 2 stock summaries. */
  quantityRemaining?: number;
  quantitySellable: number;
  quantityReserved: number;
  quantityDefective: number;
  quantityReturned: number;
  quantitySold: number;
  quantityRemoved?: number;

  createdAt: Date;
  updatedAt: Date;
}

export interface StockMovementDocument {
  _id: string;
  tenantId: string;
  date: string;
  productId: string;
  lotId?: string;
  lotAllocations?: Array<{lotId: string; quantity: number; serials: string[]}>;
  removedDelta?: number;
  qty: number; // Signed integer (+N In, -N Out)
  onHandDelta?: number;
  sellableDelta?: number;
  defectiveDelta?: number;
  reason: string;
  reference: string;
  serials?: string[];
  idempotencyKey?: string;
  createdAt: Date;
  createdBy: string;
}

export interface SupplierPaymentComponent {
  componentId: string;
  account: 'Cash' | 'Bank';
  method: 'Cash' | 'BankTransfer' | 'UPI' | 'Cheque';
  reference?: string;
  amountPaise: number;
  movementId: string;
}

export interface SupplierPaymentDocument {
  _id: string;
  paymentNumber: string;
  tenantId: string;
  supplierId: string;
  date: string;
  totalAmountPaise: number;
  allocatedAmountPaise: number;
  advanceAmountPaise: number;
  advanceId?: string;
  notes: string;
  idempotencyKey: string;

  components: SupplierPaymentComponent[];

  isReversed: boolean;
  reversalPaymentId?: string;
  reversalReason?: string;
  reversedAt?: Date;
  reversedBy?: string;
  createdAt: Date;
  createdBy: string;
}

export interface SupplierAllocationDocument {
  _id: string;
  tenantId: string;
  supplierId: string;

  sourceType: 'Payment' | 'Advance' | 'CreditNote';
  sourceId: string;
  paymentComponentId?: string;

  targetType: 'PurchaseLine' | 'OpeningPayable';
  targetId: string;
  purchaseLineId?: string;

  amountPaise: number;
  effectiveDate: string;
  idempotencyKey?: string;

  isReversal: boolean;
  reversesAllocationId?: string;

  createdAt: Date;
  createdBy: string;
}

export interface SupplierAdvanceDocument {
  _id: string;
  advanceNumber: string;
  tenantId: string;
  supplierId: string;
  sourceType: SupplierAdvanceSourceType;
  sourceId: string;
  creditNoteId?: string;
  paymentId?: string;
  reversalAllocationId?: string;

  originalAmountPaise: number;
  allocatedPaise: number;
  refundedPaise: number;
  remainingAmountPaise: number;

  status: SupplierAdvanceStatus;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
}

export interface SupplierCreditNoteDocument {
  _id: string;
  creditNoteNumber: string;
  tenantId: string;
  supplierId: string;
  purchaseId?: string;
  purchaseNumber?: string;
  supplierCreditNoteNumber?: string;
  supplierCreditNoteNumberNormalized?: string;
  reason: SupplierCreditNoteReason;
  date: string;

  acceptedCreditPaise: number;
  allocatedLiabilityPaise: number;
  unallocatedCreditPaise: number;
  advanceId?: string;

  lines: Array<{
    lineId?: string;
    productId?: string;
    description: string;
    quantity?: number;
    unitCostPaise?: number;
    taxableBasePaise: number;
    taxBasisPoints: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalCreditPaise: number;
    roundingRemainderPaise?: number;
  }>;
  returnId?: string;
  idempotencyKey?: string;

  isReversed: boolean;
  reversalId?: string;
  createdAt: Date;
  createdBy: string;
}

export interface SupplierCreditNoteReversalDocument {
  _id: string;
  tenantId: string;
  creditNoteId: string;
  date: string;
  reason: string;
  idempotencyKey: string;
  createdAt: Date;
  createdBy: string;
}

export interface SupplierReturnDocument {
  _id: string;
  returnNumber: string;
  tenantId: string;
  supplierId: string;
  purchaseId: string;
  purchaseLineId: string;
  productId: string;
  lotId: string;
  date: string;
  quantity: number;
  serials: string[];

  unitCostPaise: number;
  taxableBasePaise: number;
  taxBasisPoints: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalReturnCreditPaise: number;
  roundingRemainderPaise?: number;

  reason: string;
  condition: SupplierReturnCondition;
  disposition: SupplierReturnDisposition;
  status: SupplierReturnStatus;
  creditNoteId?: string;
  idempotencyKey?: string;
  isReversed?: boolean;
  reversalReason?: string;
  reversedAt?: Date;
  reversedBy?: string;
  createdAt: Date;
  createdBy: string;
}

export interface SupplierRefundDocument {
  _id: string;
  refundNumber: string;
  tenantId: string;
  supplierId: string;
  advanceId: string;
  amountPaise: number;
  account: 'Cash' | 'Bank';
  date: string;
  reference: string;
  idempotencyKey?: string;
  movementId: string;

  isReversed: boolean;
  reversalId?: string;
  createdAt: Date;
  createdBy: string;
}

export interface SupplierRefundReversalDocument {
  _id: string;
  tenantId: string;
  refundId: string;
  date: string;
  reason: string;
  movementId: string;
  idempotencyKey: string;
  createdAt: Date;
  createdBy: string;
}

export interface TenantAccountBalanceDocument {
  _id: string; // "BAL-{tenantId}-{account}"
  tenantId: string;
  account: 'Cash' | 'Bank';
  balancePaise: number;
  version: number;
  updatedAt: Date;
}

export interface TenantCounterDocument {
  _id: string; // "CNT-{tenantId}-{sequenceType}-{year}"
  tenantId: string;
  sequenceType: 'Purchase' | 'Receipt' | 'Payment' | 'CreditNote' | 'Return' | 'Refund' | 'Advance' | 'Quotation' | 'Invoice' | 'ServiceInvoice' | 'ServiceJob' | 'Enquiry';
  year: string;
  currentValue: number;
  updatedAt: Date;
}

export interface IdempotencyOperationDocument {
  _id: string; // "IDEMP-{tenantId}-{key}"
  tenantId: string;
  idempotencyKey: string;
  operationType: string;
  targetId?: string;
  requestFingerprint: string;
  statusCode: number;
  responseBody: unknown;
  createdAt: Date;
}

// Line and Document Valuation Engine
export function calculateLinePaise(params: {
  quantity: number;
  unitCostPaise: number;
  discountType: DiscountType;
  discountValue: number;
  taxBasisPoints: number;
  inclusive: boolean;
  taxMode: TaxMode;
}) {
  const {quantity, unitCostPaise, discountType, discountValue, taxBasisPoints, inclusive, taxMode} = params;
  const grossPaise = quantity * unitCostPaise;
  const discountPaise = discountType === 'Amount'
    ? Math.min(discountValue, grossPaise)
    : Math.round((grossPaise * discountValue) / 10000);
  const discountedPaise = Math.max(0, grossPaise - discountPaise);

  let taxableBasePaise: number;
  let taxAmountPaise: number;
  let totalPaise: number;

  if (inclusive) {
    taxableBasePaise = Math.round((discountedPaise * 10000) / (10000 + taxBasisPoints));
    taxAmountPaise = discountedPaise - taxableBasePaise;
    totalPaise = discountedPaise;
  } else {
    taxableBasePaise = discountedPaise;
    taxAmountPaise = Math.round((taxableBasePaise * taxBasisPoints) / 10000);
    totalPaise = taxableBasePaise + taxAmountPaise;
  }

  let igstPaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;

  if (taxMode === 'Inter-state') {
    igstPaise = taxAmountPaise;
  } else {
    cgstPaise = Math.floor(taxAmountPaise / 2);
    sgstPaise = taxAmountPaise - cgstPaise;
  }

  return {
    taxableBasePaise,
    taxAmountPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalPaise,
  };
}

export function calculatePurchaseDocumentTotals(lines: Array<{
  taxableBasePaise: number;
  taxAmountPaise: number;
  totalPaise: number;
  creditedLiabilityPaise?: number;
  allocatedPaidPaise?: number;
}>) {
  let subtotalPaise = 0;
  let taxTotalPaise = 0;
  let totalPaise = 0;
  let creditedLiabilityPaise = 0;
  let allocatedPaidPaise = 0;

  for (const l of lines) {
    subtotalPaise += l.taxableBasePaise;
    taxTotalPaise += l.taxAmountPaise;
    totalPaise += l.totalPaise;
    creditedLiabilityPaise += l.creditedLiabilityPaise || 0;
    allocatedPaidPaise += l.allocatedPaidPaise || 0;
  }

  const duePaise = Math.max(0, totalPaise - creditedLiabilityPaise - allocatedPaidPaise);

  return {
    subtotalPaise,
    taxTotalPaise,
    totalPaise,
    creditedLiabilityPaise,
    allocatedPaidPaise,
    duePaise,
  };
}

export function prorateLineReturnValuation(params: {
  quantityReturned: number;
  lineOrderedQty: number;
  previouslyReturnedQty: number;
  lineTaxableBasePaise: number;
  lineCgstPaise: number;
  lineSgstPaise: number;
  lineIgstPaise: number;
  lineTotalPaise: number;
  unitCostPaise: number;
  taxBasisPoints: number;
}) {
  const {
    quantityReturned,
    lineOrderedQty,
    previouslyReturnedQty,
    lineTaxableBasePaise,
    lineCgstPaise,
    lineSgstPaise,
    lineIgstPaise,
    lineTotalPaise,
    unitCostPaise,
    taxBasisPoints,
  } = params;

  if (![quantityReturned, lineOrderedQty, previouslyReturnedQty, lineTaxableBasePaise,
    lineCgstPaise, lineSgstPaise, lineIgstPaise, lineTotalPaise].every(Number.isSafeInteger) ||
    quantityReturned <= 0 || lineOrderedQty <= 0 || previouslyReturnedQty < 0 ||
    previouslyReturnedQty + quantityReturned > lineOrderedQty ||
    [lineTaxableBasePaise, lineCgstPaise, lineSgstPaise, lineIgstPaise, lineTotalPaise].some(n => n < 0)) {
    throw new Error('Invalid quantities or amounts for return proration');
  }
  // Differences of cumulative shares conserve every paise across split returns.
  const share = (amount: number) => Number(
    BigInt(amount) * BigInt(previouslyReturnedQty + quantityReturned) / BigInt(lineOrderedQty) -
    BigInt(amount) * BigInt(previouslyReturnedQty) / BigInt(lineOrderedQty));
  const proratedTaxableBase = share(lineTaxableBasePaise);
  const proratedCgst = share(lineCgstPaise);
  const proratedSgst = share(lineSgstPaise);
  const proratedIgst = share(lineIgstPaise);
  const totalReturnCreditPaise = share(lineTotalPaise);
  const roundingRemainderPaise = totalReturnCreditPaise - proratedTaxableBase - proratedCgst - proratedSgst - proratedIgst;

  return {
    unitCostPaise,
    taxBasisPoints,
    taxableBasePaise: proratedTaxableBase,
    cgstPaise: proratedCgst,
    sgstPaise: proratedSgst,
    igstPaise: proratedIgst,
    totalReturnCreditPaise,
    roundingRemainderPaise: roundingRemainderPaise !== 0 ? roundingRemainderPaise : undefined,
  };
}
