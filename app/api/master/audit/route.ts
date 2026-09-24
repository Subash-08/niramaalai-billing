import {endpoint, requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {listAuditHistory} from '@/server/audit';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const db = await database();
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const entityType = url.searchParams.get('entityType') || undefined;
    const entityId = url.searchParams.get('entityId') || undefined;

    return listAuditHistory(db, identity, {page, limit, entityType, entityId});
  });
}
