import {z} from 'zod';
import {isValidCalendarDate} from './master-schema';

export const DeviceTypeSchema = z.enum([
  'Laptop',
  'Desktop',
  'Printer',
  'Monitor',
  'UPS',
  'Component',
  'Other',
]);

export const ServiceJobStatusSchema = z.enum([
  'Received',
  'Diagnosing',
  'EstimatePending',
  'EstimateApproved',
  'EstimateRejected',
  'WorkInProgress',
  'WaitingForParts',
  'ReadyForDelivery',
  'Delivered',
  'Unrepaired',
  'Cancelled',
]);

export const EstimateStatusSchema = z.enum(['Pending', 'Approved', 'Rejected']);

export const CreateServiceJobSchema = z.object({
  customerId: z.string().min(1, 'Customer is required'),
  device: z.object({
    type: DeviceTypeSchema,
    brand: z.string().trim().min(1, 'Brand is required').max(50),
    model: z.string().trim().min(1, 'Model is required').max(50),
    serialNumber: z.string().trim().max(100).optional(),
    accessories: z.string().max(300).optional(),
    conditionNotes: z.string().max(500).optional(),
    photos: z.array(z.string()).max(5).optional().default([]),
  }),
  reportedProblem: z.string().trim().min(3, 'Reported problem is required').max(1000),
  initialEstimatePaise: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().min(8).max(128),
});
export type CreateServiceJobInput = z.infer<typeof CreateServiceJobSchema>;

export const UpdateServiceJobStatusSchema = z.object({
  status: ServiceJobStatusSchema,
  notes: z.string().max(1000).optional(),
  diagnosticNotes: z.string().max(1000).optional(),
  photos: z.array(z.string().min(1).max(128)).max(5).optional(),
  expectedVersion: z.number().int().nonnegative(),
});
export type UpdateServiceJobStatusInput = z.infer<typeof UpdateServiceJobStatusSchema>;

export const UpdateEstimateSchema = z.object({
  estimatedCostPaise: z.number().int().nonnegative(),
  status: EstimateStatusSchema,
  notes: z.string().max(500).optional(),
  expectedVersion: z.number().int().nonnegative(),
});
export type UpdateEstimateInput = z.infer<typeof UpdateEstimateSchema>;

export const IssueServicePartSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  lotId: z.string().min(1, 'Stock lot is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  serials: z.array(z.string()).default([]),
  billingRatePaise: z.number().int().nonnegative('Billing rate is required'),
  taxBasisPoints: z.number().int().min(0).max(10000).default(1800),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(128),
});
export type IssueServicePartInput = z.infer<typeof IssueServicePartSchema>;

export const ReverseServicePartSchema = z.object({
  condition: z.enum(['Sellable', 'Defective']),
  reason: z.string().min(3, 'Reversal reason is required').max(500),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(128),
});
export type ReverseServicePartInput = z.infer<typeof ReverseServicePartSchema>;

export const ServiceJobListQuerySchema = z.object({
  status: z.string().optional(),
  customerId: z.string().optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});
export type ServiceJobListQueryInput = z.infer<typeof ServiceJobListQuerySchema>;
