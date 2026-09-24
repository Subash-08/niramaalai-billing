import {z} from 'zod';

export const phoneRegex = /^[0-9+ ()-]{10,15}$/;
export const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
export const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export function isValidCalendarDate(val: string): boolean {
  if (!dateRegex.test(val)) return false;
  const [y, m, d] = val.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const CalendarDateSchema = z.string().trim().refine(isValidCalendarDate, 'Must be a valid calendar date in YYYY-MM-DD format');

export function normalizeSerial(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export function normalizeGstin(g: string): string {
  return g.trim().toUpperCase();
}

export function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export const CompanySettingsSchema = z.object({
  name: z.string().trim().min(1, 'Company name is required').max(120),
  phone: z.string().trim().min(5).max(20),
  email: z.string().trim().email('Invalid email address').or(z.literal('')),
  address: z.string().trim().max(500),
  gst: z.string().trim().regex(gstinRegex, 'Invalid GSTIN format').or(z.literal('')),
  state: z.string().trim().max(100).optional().default(''),
  stateCode: z.string().trim().regex(/^\d{2}$/, 'State code must contain exactly 2 digits').or(z.literal('')).optional().default(''),
  postalCode: z.string().trim().regex(/^\d{6}$/, 'Postal code must contain exactly 6 digits').or(z.literal('')).optional().default(''),
  bank: z.string().trim().max(100),
  account: z.string().trim().max(50),
  ifsc: z.string().trim().max(20),
  declaration: z.string().trim().max(1000),
  logoFileId: z.string().trim().max(100).optional(),
}).strict();

export type CompanySettingsInput = z.infer<typeof CompanySettingsSchema>;

export const CustomerDetailsSchema = z.object({
  contactPerson: z.string().trim().max(100).optional().default(''),
  alternatePhone: z.string().trim().max(20).optional().default(''),
  city: z.string().trim().max(100).optional().default(''),
  state: z.string().trim().max(100).optional().default(''),
  postalCode: z.string().trim().max(20).optional().default(''),
  country: z.string().trim().max(100).optional().default('India'),
  shippingAddress: z.string().trim().max(500).optional().default(''),
  paymentTerms: z.string().trim().max(10).optional().default('0'),
  creditLimit: z.string().trim().max(20).optional().default(''),
  language: z.string().trim().max(50).optional().default('Tamil'),
  reference: z.string().trim().max(100).optional().default(''),
}).partial();

export const CustomerInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  phone: z.string().trim().min(1, 'Customer phone number is required').max(30)
    .regex(/^[+()0-9 .-]+$/, 'Enter a valid phone number')
    .refine(value => { const digits = value.replace(/\D/g, ''); return digits.length >= 10 && digits.length <= 15; }, 'Enter 10 to 15 phone digits, including country code when applicable'),
  email: z.string().trim().email().or(z.literal('')).optional().default(''),
  address: z.string().trim().max(500).optional().default(''),
  gst: z.string().trim().toUpperCase().regex(gstinRegex, 'Invalid GSTIN format').or(z.literal('')).optional().default(''),
  type: z.enum(['Individual', 'Business']).default('Individual'),
  creditLimitPaise: z.number().int().min(0).optional().default(0),
  paymentTermsDays: z.number().int().min(0).max(365).optional().default(30),
  notes: z.string().trim().max(1000).optional().default(''),
  details: CustomerDetailsSchema.optional().default({}),
}).strict();

export type CustomerInput = z.infer<typeof CustomerInputSchema>;

export const SupplierInputSchema = z.preprocess((val: any) => {
  if (val && typeof val === 'object') {
    const terms = val.terms !== undefined ? val.terms : val.paymentTermsDays;
    return {
      ...val,
      terms: terms !== undefined ? terms : 30,
      paymentTermsDays: terms !== undefined ? terms : 30,
    };
  }
  return val;
}, z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(120),
  phone: z.string().trim().max(20).optional().default(''),
  email: z.string().trim().email().or(z.literal('')).optional().default(''),
  address: z.string().trim().max(500).optional().default(''),
  gst: z.string().trim().regex(gstinRegex, 'Invalid GSTIN format').or(z.literal('')).optional().default(''),
  terms: z.number().int().min(0, 'Terms must be non-negative').max(365).default(30),
  paymentTermsDays: z.number().int().min(0, 'Payment terms must be non-negative').max(365).optional().default(30),
}).strict());

export type SupplierInput = z.infer<typeof SupplierInputSchema>;

export const ProductCategoryEnum = z.string().trim().min(1, 'Category is required').max(80);

export const SERIALIZED_CATEGORIES: string[] = ['Laptops', 'Monitors', 'Prebuilt PCs', 'Printers'];

export const ProductInputSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(150),
  description: z.string().trim().max(1000).default(''),
  unit: z.string().trim().min(1).max(30).default('Piece'),
  category: ProductCategoryEnum,
  brand: z.string().trim().max(80).default(''),
  condition: z.enum(['New', 'Used']).default('New'),
  model: z.string().trim().max(120).default(''),
  hsn: z.string().trim().max(15).default(''),
  costPaise: z.number().int().min(0, 'Cost in paise must be non-negative'),
  sellingPricePaise: z.number().int().min(0, 'Price in paise must be non-negative'),
  priceEntryMode: z.enum(['Inclusive', 'Exclusive']).default('Inclusive'),
  taxBasisPoints: z.number().int().min(0).max(10000).default(1800), // 1800 = 18.00%
  low: z.number().int().min(0).max(10000).default(2),
  warranty: z.number().int().min(0).max(120).default(12),
  preferredSupplierId: z.string().trim().max(100).optional().default(''),
  isSerialTracked: z.boolean().optional(),
}).strict();

export type ProductInput = z.infer<typeof ProductInputSchema>;

export const StockAdjustmentInputSchema = z.object({
  delta: z.number().int().min(-10000).max(10000).refine((n) => n !== 0, 'Quantity delta cannot be zero'),
  serials: z.array(z.string().trim().min(1)).optional().default([]),
  reason: z.string().trim().min(1, 'Reason is required').max(200),
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
}).strict();

export type StockAdjustmentInput = z.infer<typeof StockAdjustmentInputSchema>;

export const ServiceCatalogInputSchema = z.object({
  name: z.string().trim().min(1, 'Service name is required').max(150),
  category: z.string().trim().min(1, 'Category is required').max(80),
  description: z.string().trim().max(500).default(''),
  unit: z.string().trim().min(1).max(30).default('Job'),
  ratePaise: z.number().int().min(0, 'Rate in paise must be non-negative'),
  taxBasisPoints: z.number().int().min(0).max(10000).default(1800),
  sac: z.string().trim().max(15).default('998713'),
  warranty: z.number().int().min(0).max(60).default(0),
  active: z.boolean().default(true),
}).strict();

export type ServiceCatalogInput = z.infer<typeof ServiceCatalogInputSchema>;

export const TEMPLATE_FIELD_KEYS = [
  'logo', 'shopName', 'shopAddress', 'shopGst', 'shopPhone', 'shopEmail',
  'customerName', 'customerAddress', 'customerPhone', 'customerGst', 'shipping',
  'number', 'date', 'due', 'reference', 'order', 'delivery', 'dispatch', 'destination',
  'serials', 'model', 'warranty', 'subtotal', 'taxes', 'grandTotal', 'amountWords',
  'taxSummary', 'payments', 'bank', 'notes', 'declaration', 'signatures', 'footer'
] as const;

export const TEMPLATE_COLUMN_IDS = [
  'index', 'description', 'hsn', 'tax', 'qty', 'rateIncl', 'rateExcl',
  'discount', 'warranty', 'amount'
] as const;

export const TemplateColumnSchema = z.object({
  id: z.string().refine((val) => TEMPLATE_COLUMN_IDS.includes(val as any), 'Invalid column id'),
  label: z.string().trim().min(1).max(80),
  show: z.boolean(),
  align: z.enum(['left', 'right', 'center']),
});

export const InvoiceTemplateInputSchema = z.object({
  name: z.string().trim().min(1, 'Template name is required').max(80),
  title: z.string().trim().max(80).default(''),
  paper: z.enum(['A4', 'Letter']).default('A4'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  fontSize: z.number().int().min(9).max(16).default(11),
  accent: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex accent color').default('#373737'),
  borders: z.boolean().default(true),
  striped: z.boolean().default(false),
  logoPosition: z.enum(['left', 'center', 'right']).default('left'),
  fields: z.record(z.string(), z.boolean()).refine((f) => {
    return Object.keys(f).every((k) => TEMPLATE_FIELD_KEYS.includes(k as any));
  }, 'Invalid template field key').default({}),
  columns: z.array(TemplateColumnSchema).refine((cols) => {
    const visible = cols.filter((c) => c.show);
    const ids = cols.map((c) => c.id);
    const uniqueIds = new Set(ids);
    return visible.length >= 2 && ids.length === uniqueIds.size;
  }, 'At least two visible unique columns are required').default([
    {id: 'index', label: '#', show: true, align: 'left'},
    {id: 'description', label: 'Item & Description', show: true, align: 'left'},
    {id: 'qty', label: 'Qty', show: true, align: 'right'},
    {id: 'amount', label: 'Amount', show: true, align: 'right'},
  ]),
  footer: z.string().trim().max(300).default('This is a computer generated invoice.'),
  isDefault: z.boolean().optional().default(false),
  expectedRevision: z.number().int().min(1).optional(),
}).strict();

export type InvoiceTemplateInput = z.infer<typeof InvoiceTemplateInputSchema>;

export const DraftReceivableSchema = z.object({
  customerId: z.string().trim().min(1, 'Customer is required'),
  reference: z.string().trim().max(100).default('Opening invoice'),
  date: CalendarDateSchema,
  amountPaise: z.number().int().min(1, 'Amount in paise must be greater than zero'),
  notes: z.string().trim().max(200).optional().default(''),
});

export const DraftPayableSchema = z.object({
  supplierId: z.string().trim().min(1, 'Supplier is required'),
  reference: z.string().trim().max(100).default('Opening purchase'),
  date: CalendarDateSchema,
  amountPaise: z.number().int().min(1, 'Amount in paise must be greater than zero'),
  notes: z.string().trim().max(200).optional().default(''),
});

export const DraftStockLotSchema = z.preprocess((val: any) => {
  if (val && typeof val === 'object') {
    return {
      ...val,
      qty: val.qty !== undefined ? val.qty : val.quantity,
      costPaise: val.costPaise !== undefined ? val.costPaise : val.unitCostPaise,
    };
  }
  return val;
}, z.object({
  productId: z.string().trim().min(1, 'Product is required'),
  qty: z.number().int().min(1, 'Quantity must be greater than zero'),
  costPaise: z.number().int().min(0, 'Cost must be non-negative'),
  receivedDate: CalendarDateSchema.optional(),
  serials: z.array(z.string().trim().min(1)).default([]),
}));

export const OpeningDraftSchema = z.object({
  cutoffDate: CalendarDateSchema,
  openingCashPaise: z.number().int().min(0, 'Opening cash must be non-negative'),
  openingBankPaise: z.number().int().min(0, 'Opening bank must be non-negative'),
  draftReceivables: z.array(DraftReceivableSchema).default([]),
  draftPayables: z.array(DraftPayableSchema).default([]),
  draftStockLots: z.array(DraftStockLotSchema).default([]),
}).strict().superRefine((data, ctx) => {
  for (let i = 0; i < data.draftReceivables.length; i++) {
    if (data.draftReceivables[i].date > data.cutoffDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Receivable date (${data.draftReceivables[i].date}) cannot be after cutoff date (${data.cutoffDate})`,
        path: ['draftReceivables', i, 'date'],
      });
    }
  }
  for (let i = 0; i < data.draftPayables.length; i++) {
    if (data.draftPayables[i].date > data.cutoffDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Payable date (${data.draftPayables[i].date}) cannot be after cutoff date (${data.cutoffDate})`,
        path: ['draftPayables', i, 'date'],
      });
    }
  }
  for (let i = 0; i < data.draftStockLots.length; i++) {
    if (data.draftStockLots[i].receivedDate && data.draftStockLots[i].receivedDate! > data.cutoffDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Stock lot date (${data.draftStockLots[i].receivedDate}) cannot be after cutoff date (${data.cutoffDate})`,
        path: ['draftStockLots', i, 'receivedDate'],
      });
    }
  }
});

export type OpeningDraftInput = z.infer<typeof OpeningDraftSchema>;

export const FinalizeOpeningOptionsSchema = z.object({
  expectedDraftVersion: z.number().int().optional(),
}).optional();

export type FinalizeOpeningOptions = z.infer<typeof FinalizeOpeningOptionsSchema>;

export const CorrectOpeningCutoffSchema = z.object({
  expectedCutoffDate: CalendarDateSchema,
  newCutoffDate: CalendarDateSchema,
  confirmation: z.literal(true, {
    error: 'Confirm that no operational transactions have been recorded before correcting the cutoff.',
  }),
}).strict();

export type CorrectOpeningCutoffInput = z.infer<typeof CorrectOpeningCutoffSchema>;

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional().default(''),
  category: z.string().trim().max(80).optional(),
  type: z.enum(['Individual', 'Business', 'Dealer']).optional(),
  status: z.enum(['Active', 'Archived', 'All']).optional().default('Active'),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
