import {z} from 'zod';
import {isValidCalendarDate} from './master-schema';

export const ProfitEntrySchema = z.object({
  id: z.string().min(1),
  type: z.enum(['Invoice', 'Return', 'Adjustment']),
  profitPaise: z.number().int(),
});
export type ProfitEntry = z.infer<typeof ProfitEntrySchema>;

export const SaveProfitEntriesSchema = z.object({
  entries: z.array(ProfitEntrySchema),
});
export type SaveProfitEntriesInput = z.infer<typeof SaveProfitEntriesSchema>;

export const SaveReconciliationDraftSchema = z.object({
  cashCountPaise: z.number().int().nonnegative().optional(),
  bankCountPaise: z.number().int().nonnegative().optional(),
  note: z.string().max(1000).optional(),
  holiday: z.boolean().optional().default(false),
});
export type SaveReconciliationDraftInput = z.infer<typeof SaveReconciliationDraftSchema>;

export const CloseBusinessDaySchema = z.object({
  cashCountPaise: z.number().int().nonnegative(),
  bankCountPaise: z.number().int().nonnegative(),
  note: z.string().max(1000).optional(),
  reviewVersion: z.number().int().optional(),
  holiday: z.boolean().optional().default(false),
  idempotencyKey: z.string().min(8).max(128),
});
export type CloseBusinessDayInput = z.infer<typeof CloseBusinessDaySchema>;

export const ScheduleHolidaySchema = z.object({
  date: z.string().refine(isValidCalendarDate, 'Invalid date format'),
  reason: z.string().min(2, 'Reason is required').max(200),
});
export type ScheduleHolidayInput = z.infer<typeof ScheduleHolidaySchema>;

export const ManualProfitAdjustmentSchema = z.object({
  date: z.string().refine(isValidCalendarDate, 'Invalid date format'),
  originalDocumentType: z.enum(['Invoice', 'ServiceJob']),
  originalDocumentId: z.string().min(1),
  originalDocumentNumber: z.string().min(1),
  triggerType: z.enum(['CustomerReturn', 'InvoiceReversal', 'Correction']),
  triggerReference: z.string().min(1),
  signedAdjustmentPaise: z.number().int(),
  reason: z.string().min(3).max(500),
  idempotencyKey: z.string().min(8).max(128),
});
export type ManualProfitAdjustmentInput = z.infer<typeof ManualProfitAdjustmentSchema>;

export const BulkHolidayCloseSchema = z.object({
  fromDate: z.string().refine(isValidCalendarDate, 'Invalid fromDate format'),
  toDate: z.string().refine(isValidCalendarDate, 'Invalid toDate format'),
  reason: z.string().trim().min(2, 'Reason is required').max(200),
  confirmedNoRealWorldActivity: z.literal(true, {
    message:
      'You must explicitly confirm that no real-world business transactions occurred on these dates (including sales, customer UPI/bank collections, cash movements, supplier bills/payments, stock receipts/returns, or service intake/repair/delivery).',
  }),
  reviewVersion: z.number().int({ message: 'reviewVersion is required' }),
  idempotencyKey: z.string().min(8).max(128),
});
export type BulkHolidayCloseInput = z.infer<typeof BulkHolidayCloseSchema>;

