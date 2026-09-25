import 'server-only';
import {z} from 'zod';
import {todayInKolkata} from './purchase-schema';
import {CalendarDateSchema, normalizeSerial} from './master-schema';

const CalendarDate = CalendarDateSchema;
const Id = z.string().trim().min(1).max(128);
// MongoDB may store omitted optional references as null. Required links
// still use Id; only optional links normalize null to absence.
const OptionalId = Id.nullish().transform(value => value ?? undefined);
const Paise = z.number().int().min(0).max(1_000_000_000_00);
const PositivePaise = z.number().int().min(1).max(1_000_000_000_00);
const IdempotencyKey = z.string().trim().min(1).max(128);
const TaxMode = z.enum(['Intra-state', 'Inter-state']);
const DiscountType = z.enum(['Percentage', 'Amount']);

export const SaleStockAllocationInputSchema = z.object({
  lotId: Id,
  reservationId: Id.nullish(),
  quantity: z.number().int().min(1).max(100000),
  serials: z.array(z.string().trim().min(1).max(200)).max(1000).default([]),
});

const CommonLine = z.object({
  clientLineKey: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(300),
  details: z.string().trim().max(1000).default(''),
  unit: z.string().trim().min(1).max(30).default('Piece'),
  printSpecifications: z.object({
    size: z.string().trim().max(100).optional(),
    material: z.string().trim().max(150).optional(),
    gsm: z.string().trim().max(50).optional(),
    colour: z.string().trim().max(100).optional(),
    sides: z.string().trim().max(50).optional(),
    finishing: z.string().trim().max(200).optional(),
    deliveryDate: CalendarDate.optional(),
    notes: z.string().trim().max(500).optional(),
  }).optional().default({}),
  quantity: z.number().int().min(1).max(100000),
  unitRatePaise: Paise,
  discountType: DiscountType.default('Percentage'),
  discountValue: Paise.default(0),
  taxBasisPoints: z.number().int().min(0).max(10000),
  taxTreatment: z.enum(['Taxable', 'Exempt', 'NonGST']).default('Taxable'),
});

export const SaleLineInputSchema = z.discriminatedUnion('lineType', [
  CommonLine.extend({
    lineType: z.literal('Product'), productId: Id, hsn: z.string().trim().min(1).max(20),
    stockAllocations: z.array(SaleStockAllocationInputSchema).max(100).default([]),
    warrantyMonths: z.number().int().min(0).max(240).default(0),
  }),
  CommonLine.extend({
    lineType: z.literal('Service'), serviceId: OptionalId, sac: z.string().trim().min(1).max(20),
    serviceJobId: OptionalId,
    warrantyMonths: z.number().int().min(0).max(240).default(0),
  }),
  CommonLine.extend({
    lineType: z.literal('ConsumedPart'),
    serviceJobId: Id,
    partId: Id,
    productId: Id,
    lotId: OptionalId,
    hsn: z.string().trim().min(1).max(20).default('847330'),
    warrantyMonths: z.number().int().min(0).max(240).default(0),
    serials: z.array(z.string()).default([]),
  }),
  CommonLine.extend({
    lineType: z.literal('Charge'), sac: z.string().trim().min(1).max(20),
  }),
]);

export const CustomerAddressSnapshotSchema = z.object({
  name: z.string().trim().min(1).max(200), phone: z.string().trim().max(30).default(''),
  address: z.string().trim().max(1000).default(''), state: z.string().trim().max(100).default(''),
  stateCode: z.string().trim().max(5).default(''), postalCode: z.string().trim().max(20).default(''),
});

/**
 * Cross-line validation used by both invoice draft and quotation schemas.
 * Extracted as a reusable superRefine so it can be applied after extending
 * (Zod v3 does not allow .omit()/.extend() on schemas that already have refinements).
 */
function lineValidation(value: {lines: z.infer<typeof SaleLineInputSchema>[]; invoiceKind: 'Sale' | 'Service'}, context: z.RefinementCtx) {
  const keys = new Set<string>();
  const serials = new Set<string>();
  value.lines.forEach((line, index) => {
    if (keys.has(line.clientLineKey)) context.addIssue({code: z.ZodIssueCode.custom, path: ['lines', index, 'clientLineKey'], message: 'Duplicate line key.'});
    keys.add(line.clientLineKey);
    if (line.taxTreatment !== 'Taxable' && line.taxBasisPoints !== 0) context.addIssue({code: z.ZodIssueCode.custom, path: ['lines', index, 'taxBasisPoints'], message: 'Exempt and non-GST lines must use 0% tax.'});
    if (line.discountType === 'Percentage' && line.discountValue > 10000) context.addIssue({code: z.ZodIssueCode.custom, path: ['lines', index, 'discountValue'], message: 'Percentage discount cannot exceed 100%.'});
    if (line.lineType === 'Product') {
      if (line.stockAllocations.length && line.stockAllocations.reduce((sum, item) => sum + item.quantity, 0) !== line.quantity) context.addIssue({code: 'custom', path: ['lines', index, 'stockAllocations'], message: 'Leave stock unallocated in a draft, or allocate the full line quantity.'});
      const lots = new Set<string>();
      for (const allocation of line.stockAllocations) {
        const sourceKey = JSON.stringify([allocation.lotId, allocation.reservationId ?? null]);
        if (lots.has(sourceKey)) context.addIssue({code: 'custom', path: ['lines', index, 'stockAllocations'], message: 'Combine allocations from the same lot and stock hold within one line.'});
        lots.add(sourceKey);
        for (const serial of allocation.serials) {
          const normalized = normalizeSerial(serial);
          if (!normalized || serials.has(normalized)) context.addIssue({code: 'custom', path: ['lines', index, 'stockAllocations'], message: 'Invalid or duplicate serial number.'});
          serials.add(normalized);
        }
      }
    }
  });
}

// Base object (no superRefine yet) — allows .extend() for quotation schema.
const InvoiceDraftBase = z.object({
  idempotencyKey: IdempotencyKey,
  customerId: Id,
  invoiceKind: z.enum(['Sale', 'Service']),
  businessCategory: z.enum(['NewGoods', 'UsedGoods', 'Service']),
  invoiceDate: CalendarDate.default(() => todayInKolkata()),
  dueDate: CalendarDate.nullish(),
  inclusive: z.boolean(), taxMode: TaxMode, placeOfSupply: z.string().trim().min(1).max(100),
  shipTo: CustomerAddressSnapshotSchema.nullish(),
  billTo: CustomerAddressSnapshotSchema.nullish(),
  templateId: Id, templateRevision: z.number().int().min(1),
  sourceQuotationId: Id.nullish(), serviceJobId: Id.nullish(), enquiryId: Id.nullish(), reservationId: Id.nullish(),
  printJobId: Id.nullish(),
  orderReference: z.string().trim().max(100).default(''), deliveryNote: z.string().trim().max(100).default(''),
  dispatchThrough: z.string().trim().max(100).default(''), notes: z.string().trim().max(4000).default(''),
  roundOffPaise: z.number().int().min(-99).max(99).default(0),
  lines: z.array(SaleLineInputSchema).min(1).max(200),
});

export const CreateInvoiceDraftSchema = InvoiceDraftBase.superRefine(lineValidation).refine(v => !v.dueDate || v.dueDate >= v.invoiceDate, {message: 'Due date cannot precede invoice date.', path: ['dueDate']});
export const UpdateInvoiceDraftSchema = z.object({expectedVersion: z.number().int().min(1), draft: CreateInvoiceDraftSchema});
export const CancelInvoiceDraftSchema = z.object({expectedVersion: z.number().int().min(1), idempotencyKey: IdempotencyKey, reason: z.string().trim().min(1).max(500)});

export const SalesListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['Draft', 'Issued', 'Cancelled', 'Paid', 'PartlyPaid', 'Unpaid', 'Sent', 'Accepted', 'Rejected', 'Converted', 'Expired']).optional(),
  customerId: Id.optional(), search: z.string().trim().max(100).optional(),
  businessCategory: z.enum(['NewGoods', 'UsedGoods', 'Service']).optional(),
  dateFrom: CalendarDate.optional(), dateTo: CalendarDate.optional(),
  hasDue: z.enum(['true', 'false']).optional(),
}).refine(v => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {message: 'Date range is reversed.'});

export const PaymentComponentSchema = z.object({
  account: z.enum(['Cash', 'Bank']), method: z.enum(['Cash', 'UPI', 'BankTransfer', 'Card']),
  amountPaise: PositivePaise, reference: z.string().trim().max(100).default(''),
}).refine(v => (v.account === 'Cash') === (v.method === 'Cash'), {message: 'Cash payments use Cash; UPI, card, cheque and bank transfers use Bank.'});

export const IssueInvoiceSchema = z.object({
  draftId: Id, expectedVersion: z.number().int().min(1), idempotencyKey: IdempotencyKey,
  paymentComponents: z.array(PaymentComponentSchema).max(10).default([]),
  applyCustomerAdvancePaise: Paise.default(0),
  recordExcessAsCustomerAdvance: z.boolean().default(false),
  creditLimitOverride: z.boolean().default(false),
  creditLimitOverrideReason: z.string().trim().max(500).default(''),
});

// Quotation extends the base (without reservationId) then applies the same line validation.
export const CreateQuotationSchema = InvoiceDraftBase
  .omit({reservationId: true})
  .extend({
    validUntil: CalendarDate, quotationDate: CalendarDate.default(() => todayInKolkata()),
  })
  .superRefine(lineValidation)
  .refine(v => v.validUntil >= v.quotationDate, {message: 'Expiry cannot precede quotation date.', path: ['validUntil']});

export const ConvertQuotationSchema = z.object({quotationId: Id, expectedVersion: z.number().int().min(1), invoiceDate: CalendarDate.default(() => todayInKolkata()), idempotencyKey: IdempotencyKey});
export const UpdateQuotationSchema = z.object({expectedVersion: z.number().int().min(1), quotation: CreateQuotationSchema});
export const CancelQuotationSchema = z.object({expectedVersion: z.number().int().min(1), idempotencyKey: IdempotencyKey, reason: z.string().trim().min(1).max(500)});
export const ReopenQuotationSchema = z.object({expectedVersion: z.number().int().min(1), idempotencyKey: IdempotencyKey, validUntil: CalendarDate});
export const ShareQuotationSchema = z.object({
  expectedVersion: z.number().int().min(1),
  idempotencyKey: IdempotencyKey,
  channel: z.enum(['Manual', 'WhatsApp', 'Email', 'Print']).default('Manual'),
});

export const ReservationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['Active', 'Fulfilled', 'Released', 'Expired']).optional(),
  customerId: Id.optional(),
  productId: Id.optional(),
  dateFrom: CalendarDate.optional(),
  dateTo: CalendarDate.optional(),
  search: z.string().trim().max(100).optional(),
}).refine(v => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {message: 'Date range is reversed.'});

export const RecordCustomerReceiptSchema = z.object({
  customerId: Id, date: CalendarDate.default(() => todayInKolkata()),
  components: z.array(PaymentComponentSchema).min(1).max(10),
  allocations: z.array(z.object({targetType: z.literal('Invoice'), targetId: Id, amountPaise: PositivePaise})).length(1, 'Select exactly one invoice for this receipt.'),
  recordExcessAsCustomerAdvance: z.boolean().default(false), notes: z.string().trim().max(2000).default(''), idempotencyKey: IdempotencyKey,
});

export const CreateStockReservationSchema = z.object({
  customerId: Id, productId: Id, lotId: Id, quantity: z.number().int().min(1).max(100000),
  serials: z.array(z.string().trim().min(1).max(200)).max(1000).default([]),
  reservedAt: CalendarDate.default(() => todayInKolkata()), expiresAt: CalendarDate,
  enquiryId: Id.optional(), quotationId: Id.optional(), notes: z.string().trim().max(1000).default(''), idempotencyKey: IdempotencyKey,
}).refine(v => v.expiresAt >= v.reservedAt, {message: 'Hold expiry cannot precede its creation date.', path: ['expiresAt']});

export const ReleaseStockReservationSchema = z.object({
  reservationId: Id, expectedVersion: z.number().int().min(1), idempotencyKey: IdempotencyKey,
  reason: z.string().trim().min(1).max(1000),
});

export const CreateCustomerReturnSchema = z.object({
  invoiceId: Id, invoiceLineId: Id, quantity: z.number().int().min(1).max(100000),
  serials: z.array(z.string().trim().min(1).max(200)).max(1000).default([]),
  date: CalendarDate.default(() => todayInKolkata()), reason: z.string().trim().min(1).max(1000),
  stockDisposition: z.enum(['RestockSellable', 'Quarantine', 'NoStock']),
  settlement: z.enum(['CustomerCredit', 'RefundNow']),
  refundComponents: z.array(z.object({account: z.enum(['Cash', 'Bank']), method: z.enum(['Cash', 'UPI', 'BankTransfer']), amountPaise: PositivePaise, reference: z.string().trim().max(100).default('')})).max(10).default([]),
  idempotencyKey: IdempotencyKey,
});

export const AllocateCustomerAdvanceSchema = z.object({
  advanceId: Id,
  expectedVersion: z.number().int().min(1),
  allocations: z.array(z.object({targetType: z.enum(['Invoice', 'OpeningReceivable']), targetId: Id, amountPaise: PositivePaise})).min(1).max(200),
  effectiveDate: CalendarDate.default(() => todayInKolkata()),
  idempotencyKey: IdempotencyKey,
});

export const RefundCustomerAdvanceSchema = z.object({
  advanceId: Id,
  expectedVersion: z.number().int().min(1),
  account: z.enum(['Cash', 'Bank']),
  amountPaise: PositivePaise,
  refundDate: CalendarDate.default(() => todayInKolkata()),
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: IdempotencyKey,
});

export const ReverseCustomerReceiptSchema = z.object({
  receiptId: Id,
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: IdempotencyKey,
});

export const ReverseCustomerAllocationSchema = z.object({
  allocationId: Id,
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: IdempotencyKey,
});

export const ReverseCustomerRefundSchema = z.object({
  refundId: Id,
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: IdempotencyKey,
});

export const CustomerStatementQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  fromDate: CalendarDate.optional(),
  toDate: CalendarDate.optional(),
}).refine(v => !v.fromDate || !v.toDate || v.fromDate <= v.toDate, {message: 'Date range is reversed.'});

export const CustomerReceiptsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  customerId: Id.optional(),
  dateFrom: CalendarDate.optional(),
  dateTo: CalendarDate.optional(),
  search: z.string().trim().max(100).optional(),
}).refine(v => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {message: 'Date range is reversed.'});

export type CreateInvoiceDraftInput = z.infer<typeof CreateInvoiceDraftSchema>;
export type IssueInvoiceInput = z.infer<typeof IssueInvoiceSchema>;
export type RecordCustomerReceiptInput = z.infer<typeof RecordCustomerReceiptSchema>;
export type AllocateCustomerAdvanceInput = z.infer<typeof AllocateCustomerAdvanceSchema>;
export type RefundCustomerAdvanceInput = z.infer<typeof RefundCustomerAdvanceSchema>;
export type ReverseCustomerReceiptInput = z.infer<typeof ReverseCustomerReceiptSchema>;
export type ReverseCustomerAllocationInput = z.infer<typeof ReverseCustomerAllocationSchema>;
export type ReverseCustomerRefundInput = z.infer<typeof ReverseCustomerRefundSchema>;
export type CustomerStatementQueryInput = z.infer<typeof CustomerStatementQuerySchema>;
export type CustomerReceiptsListQueryInput = z.infer<typeof CustomerReceiptsListQuerySchema>;
export type CreateStockReservationInput = z.infer<typeof CreateStockReservationSchema>;
export type CreateCustomerReturnInput = z.infer<typeof CreateCustomerReturnSchema>;
