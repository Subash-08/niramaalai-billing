import {endpoint, requireIdentity} from '@/server/auth';
import {exportMasterData} from '@/server/master-service';

export const runtime = 'nodejs';

export async function GET() {
  return endpoint(async () => {
    const identity = await requireIdentity();
    return exportMasterData(identity);
  });
}
