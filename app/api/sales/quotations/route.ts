import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {database, AppError} from '@/server/db';
import {createQuotation, listQuotations} from '@/server/sales-service';
import {CreateQuotationSchema} from '@/server/sales-schema';
export const runtime = 'nodejs';
export async function GET(request: Request) { return endpoint(async () => { const identity = await requireIdentity(); const params: any = Object.fromEntries(new URL(request.url).searchParams); if (!params.search && params.q) params.search = params.q; return listQuotations(await database(), identity, params); }); }
export async function POST(request: Request) { return endpoint(async () => { checkOrigin(request); const identity = await requireIdentity(); try { return createQuotation(await database(), identity, CreateQuotationSchema.parse(await jsonBody(request))); } catch (error: any) { if (error?.issues) throw new AppError(400, error.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join(', ')); throw error; } }); }
