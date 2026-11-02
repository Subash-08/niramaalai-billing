import {z} from 'zod';
import {CalendarDateSchema} from './master-schema';

export const PrintJobStatusSchema = z.enum(['Received','Designing','AwaitingApproval','Approved','Printing','Finishing','Ready','Delivered','Cancelled']);

const SpecificationsSchema = z.record(
  z.string().trim().min(1).max(60),
  z.string().trim().max(300)
).refine(value => Object.keys(value).length <= 20, 'Use no more than 20 print-job details.').default({});

export const CreatePrintJobSchema = z.object({
  customerId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  quantity: z.number().int().min(1).max(1_000_000),
  unit: z.string().trim().min(1).max(30).default('Job'),
  dueDate: CalendarDateSchema,
  specifications: SpecificationsSchema,
  notes: z.string().trim().max(2000).default(''),
});

export const UpdatePrintJobSchema = CreatePrintJobSchema.extend({
  status: PrintJobStatusSchema,
  invoiceId: z.string().trim().max(128).optional().default(''),
  expectedVersion: z.number().int().min(1),
});
