import {z} from 'zod';
import {isValidCalendarDate} from './master-schema';

export const AccountSchema = z.enum(['Cash', 'Bank']);
export type Account = z.infer<typeof AccountSchema>;

export const PaymentMethodSchema = z.enum(['Cash', 'UPI', 'BankTransfer', 'Card', 'Cheque']);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const MoneyInCategorySchema = z.enum(['OwnerContribution', 'OtherReceipt']);
export type MoneyInCategory = z.infer<typeof MoneyInCategorySchema>;

export const MoneyOutCategorySchema = z.enum(['Expense', 'OwnerWithdrawal']);
export type MoneyOutCategory = z.infer<typeof MoneyOutCategorySchema>;

export const ExpenseTypeSchema = z.enum([
  'Rent',
  'Electricity',
  'InternetAndPhone',
  'TeaAndRefreshments',
  'ShopMaintenance',
  'StationeryAndPrinting',
  'PackagingAndDelivery',
  'StaffWelfare',
  'MarketingAndPromotion',
  'SoftwareAndSubscriptions',
  'BankCharges',
  'MiscellaneousExpense',
]);
export type ExpenseType = z.infer<typeof ExpenseTypeSchema>;

export const OtherReceiptTypeSchema = z.enum([
  'ScrapSale',
  'OldAssetSale',
  'CashbackAndReward',
  'InterestReceived',
  'CommissionIncome',
  'RentalIncome',
  'InsuranceClaim',
  'MiscellaneousIncome',
]);
export type OtherReceiptType = z.infer<typeof OtherReceiptTypeSchema>;

export const RecordMoneyInSchema = z.object({
  date: z.string().refine(isValidCalendarDate, 'Invalid date format (YYYY-MM-DD)'),
  account: AccountSchema,
  method: PaymentMethodSchema,
  amountPaise: z.number().int().positive('Amount must be positive integer paise'),
  category: MoneyInCategorySchema,
  subCategory: OtherReceiptTypeSchema.optional(),
  reason: z.string().min(2, 'Reason is required').max(500),
  reference: z.string().max(100).optional(),
  payerName: z.string().max(100).optional(),
  idempotencyKey: z.string().min(8).max(128),
}).refine(data => {
  if (data.account === 'Cash') return data.method === 'Cash';
  return data.method !== 'Cash';
}, {
  message: 'Payment method is incompatible with the selected account.',
  path: ['method'],
});
export type RecordMoneyInInput = z.infer<typeof RecordMoneyInSchema>;

export const RecordMoneyOutSchema = z.object({
  date: z.string().refine(isValidCalendarDate, 'Invalid date format (YYYY-MM-DD)'),
  account: AccountSchema,
  method: PaymentMethodSchema,
  amountPaise: z.number().int().positive('Amount must be positive integer paise'),
  category: MoneyOutCategorySchema,
  subCategory: ExpenseTypeSchema.optional(),
  reason: z.string().min(2, 'Reason is required').max(500),
  reference: z.string().max(100).optional(),
  payeeName: z.string().max(100).optional(),
  idempotencyKey: z.string().min(8).max(128),
}).refine(data => {
  if (data.account === 'Cash') return data.method === 'Cash';
  return data.method !== 'Cash';
}, {
  message: 'Payment method is incompatible with the selected account.',
  path: ['method'],
});
export type RecordMoneyOutInput = z.infer<typeof RecordMoneyOutSchema>;

export const RecordTransferSchema = z.object({
  date: z.string().refine(isValidCalendarDate, 'Invalid date format (YYYY-MM-DD)'),
  fromAccount: AccountSchema,
  toAccount: AccountSchema,
  amountPaise: z.number().int().positive('Amount must be positive integer paise'),
  reason: z.string().min(2, 'Reason is required').max(500),
  reference: z.string().max(100).optional(),
  idempotencyKey: z.string().min(8).max(128),
}).refine(data => data.fromAccount !== data.toAccount, {
  message: 'From and To accounts must be different',
  path: ['toAccount'],
});
export type RecordTransferInput = z.infer<typeof RecordTransferSchema>;

export const ReverseMoneySchema = z.object({
  reason: z.string().min(3, 'Reversal reason is required').max(500),
  idempotencyKey: z.string().min(8).max(128),
});
export type ReverseMoneyInput = z.infer<typeof ReverseMoneySchema>;

export const MoneyListQuerySchema = z.object({
  date: z.string().refine(isValidCalendarDate, 'Invalid date format').optional(),
  dateFrom: z.string().refine(isValidCalendarDate, 'Invalid date format').optional(),
  dateTo: z.string().refine(isValidCalendarDate, 'Invalid date format').optional(),
  account: z.enum(['All', 'Cash', 'Bank']).optional().default('All'),
  category: z.string().optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(5000).optional().default(50),
});
export type MoneyListQueryInput = z.infer<typeof MoneyListQuerySchema>;
