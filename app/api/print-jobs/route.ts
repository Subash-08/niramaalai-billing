import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database} from '@/server/db';
import {createPrintJob} from '@/server/print-job-service';
import {z} from 'zod';
import {PrintJobStatusSchema} from '@/server/print-job-schema';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const url = new URL(request.url);
    const q = z.string().max(100).parse(url.searchParams.get('q') || '').trim();
    const status = url.searchParams.get('status');
    const filter: Record<string, unknown> = {tenantId: identity.tenantId};
    if (status && status !== 'All') filter.status = PrintJobStatusSchema.parse(status);
    if (q) {
      const literal = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = ['title','description','jobNumber'].map(field => ({[field]: {$regex: literal, $options: 'i'}}));
    }
    const db = await database();
    const page = z.coerce.number().int().min(1).max(100000).parse(url.searchParams.get('page') || 1);
    const limit = z.coerce.number().int().min(1).max(500).parse(url.searchParams.get('limit') || 100);
    const records = await db.collection('printJobs').find(filter).sort({dueDate: 1, _id: 1}).skip((page-1)*limit).limit(limit).toArray();
    const total = await db.collection('printJobs').countDocuments(filter);
    return {records, total, page, totalPages: Math.max(1, Math.ceil(total/limit))};
  });
}
export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    return createPrintJob(await database(), identity, await jsonBody(request));
  });
}
