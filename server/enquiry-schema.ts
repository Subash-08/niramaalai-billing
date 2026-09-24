import {z} from 'zod';
import {CalendarDateSchema} from './master-schema';

export const EnquiryCategorySchema = z.enum([
  'New laptop',
  'Used laptop',
  'PC build',
  'Accessories',
  'Other',
]);
export type EnquiryCategory = z.infer<typeof EnquiryCategorySchema>;

export const EnquiryStatusSchema = z.enum([
  'Open',
  'Contacted',
  'Quoted',
  'Won',
  'Closed',
]);
export type EnquiryStatus = z.infer<typeof EnquiryStatusSchema>;

export const CreateEnquirySchema = z.object({
  customerId: z.string().min(1, 'Customer is required'),
  category: EnquiryCategorySchema.default('New laptop'),
  requirement: z.string().trim().min(1, 'Requirement is required').max(1000),
  budgetPaise: z.number().int().nonnegative().optional().default(0),
  budget: z.number().nonnegative().optional(),
  followUpDate: CalendarDateSchema,
  notes: z.string().trim().max(1000).optional().default(''),
  idempotencyKey: z.string().min(8).max(128).optional(),
}).transform(val => {
  if (val.budget !== undefined && val.budgetPaise === 0) {
    return {
      ...val,
      budgetPaise: Math.round(val.budget * 100),
    };
  }
  return val;
});
export type CreateEnquiryInput = z.infer<typeof CreateEnquirySchema>;

export const UpdateEnquirySchema = z.object({
  customerId: z.string().min(1).optional(),
  category: EnquiryCategorySchema.optional(),
  requirement: z.string().trim().min(1).max(1000).optional(),
  budgetPaise: z.number().int().nonnegative().optional(),
  budget: z.number().nonnegative().optional(),
  followUpDate: CalendarDateSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
  status: EnquiryStatusSchema.optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).transform(val => {
  if (val.budget !== undefined && val.budgetPaise === undefined) {
    return {
      ...val,
      budgetPaise: Math.round(val.budget * 100),
    };
  }
  return val;
});
export type UpdateEnquiryInput = z.infer<typeof UpdateEnquirySchema>;

export const EnquiryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  customerId: z.string().optional(),
  status: z.string().optional(),
  category: z.string().optional(),
  search: z.string().optional(),
});
export type EnquiryListQueryInput = z.infer<typeof EnquiryListQuerySchema>;
