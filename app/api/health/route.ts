import {database} from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = Date.now();
  try {
    const db = await database();
    await db.command({ping: 1});
    return Response.json(
      {status: 'ok', database: 'connected', latencyMs: Date.now() - startedAt},
      {headers: {'Cache-Control': 'no-store'}}
    );
  } catch (error) {
    console.error('[HEALTH_CHECK_FAILED]', error);
    return Response.json(
      {status: 'unavailable', database: 'disconnected'},
      {status: 503, headers: {'Cache-Control': 'no-store'}}
    );
  }
}
