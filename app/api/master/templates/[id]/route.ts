import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {getTemplateById, updateTemplate, archiveTemplate} from '@/server/master-service';
import {InvoiceTemplateInputSchema} from '@/server/master-schema';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const {id} = await context.params;
    return getTemplateById(identity, id);
  });
}

export async function PUT(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    const body = InvoiceTemplateInputSchema.parse(await jsonBody(request));
    return updateTemplate(identity, id, body);
  });
}

export async function DELETE(request: Request, context: {params: Promise<{id: string}>}) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const {id} = await context.params;
    return archiveTemplate(identity, id);
  });
}
