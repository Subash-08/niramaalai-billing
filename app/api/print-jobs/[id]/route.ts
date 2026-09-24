import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database, AppError} from '@/server/db';
import {updatePrintJob} from '@/server/print-job-service';
export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
export async function GET(_: Request, {params}: Context) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const {id} = await params;
    const db = await database();
    const job = await db.collection<any>('printJobs').findOne({_id: id, tenantId: identity.tenantId});
    if (!job) throw new AppError(404, 'Print job not found.');
    return job;
  });
}
export async function PUT(request: Request, {params}: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await params;
    return updatePrintJob(await database(), identity, id, await jsonBody(request));
  });
}
