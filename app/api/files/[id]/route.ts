import {endpoint, requireIdentity} from '@/server/auth';
import {getFile, rfc5987Encode} from '@/server/storage';
import {Readable} from 'node:stream';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const identity = await requireIdentity();
    const {id} = await context.params;
    const {record, stream, size} = await getFile(identity, id);

    const webStream = stream instanceof ReadableStream ? stream : Readable.toWeb(stream as any);

    return new Response(webStream as any, {
      headers: {
        'Content-Type': record.type,
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename*=UTF-8''${rfc5987Encode(record.name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    return endpoint(async () => {
      throw e;
    });
  }
}
