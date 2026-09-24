import {endpoint, requireIdentity, checkOrigin, jsonBody} from '@/server/auth';
import {getCompanySettings, updateCompanySettings, updateCompanyLogo} from '@/server/master-service';
import {CompanySettingsSchema} from '@/server/master-schema';
import {AppError} from '@/server/db';

export const runtime = 'nodejs';

export async function GET() {
  return endpoint(async () => {
    const identity = await requireIdentity();
    return getCompanySettings(identity);
  });
}

export async function PUT(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const body = CompanySettingsSchema.parse(await jsonBody(request));
    return updateCompanySettings(identity, body);
  });
}

export async function PATCH(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    const identity = await requireIdentity();
    const body = await jsonBody(request);
    if ('logoFileId' in body) {
      const logoFileId = typeof body.logoFileId === 'string' && body.logoFileId.trim() ? body.logoFileId.trim() : null;
      return updateCompanyLogo(identity, logoFileId);
    }
    throw new AppError(400, 'Unsupported PATCH field.');
  });
}

