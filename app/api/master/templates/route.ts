import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {listTemplates, createTemplate} from '@/server/master-service';
import {InvoiceTemplateInputSchema} from '@/server/master-schema';

export const runtime = 'nodejs';

export async function GET() {
  return endpoint(async () => {
    const identity = await requireIdentity();
    return listTemplates(identity);
  });
}

export async function POST(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const body = InvoiceTemplateInputSchema.parse(await jsonBody(request));
    return createTemplate(identity, body);
  });
}
