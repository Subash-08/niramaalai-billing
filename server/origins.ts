import 'server-only';
import {AppError} from './db';

function normalizeOrigin(rawUrl: string, name: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new AppError(500, `Missing required configuration for ${name}.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new AppError(500, `Invalid URL format for ${name}: "${rawUrl}".`);
  }

  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new AppError(500, `Production origin ${name} must use HTTPS: "${rawUrl}".`);
  }

  if (parsed.username || parsed.password) {
    throw new AppError(500, `Origin ${name} must not contain user credentials: "${rawUrl}".`);
  }

  if (parsed.search || parsed.hash) {
    throw new AppError(500, `Origin ${name} must not contain query parameters or fragments.`);
  }

  if (parsed.pathname && parsed.pathname !== '/') {
    throw new AppError(500, `Origin ${name} must not contain a path component: "${rawUrl}".`);
  }

  return parsed.origin;
}

export function getCanonicalOrigin(): string {
  let appOriginRaw = process.env.APP_ORIGIN;
  let betterAuthUrlRaw = process.env.BETTER_AUTH_URL;

  // On Vercel deployments, if environment variables contain legacy localhost values,
  // resolve them to the actual Vercel HTTPS production origin.
  if (process.env.VERCEL) {
    const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'niramaalai-billing.vercel.app';
    const vercelHttps = `https://${vercelHost}`;
    if (!appOriginRaw || appOriginRaw.includes('localhost') || !appOriginRaw.startsWith('https://')) {
      appOriginRaw = vercelHttps;
    }
    if (!betterAuthUrlRaw || betterAuthUrlRaw.includes('localhost') || !betterAuthUrlRaw.startsWith('https://')) {
      betterAuthUrlRaw = vercelHttps;
    }
  }

  if (appOriginRaw && betterAuthUrlRaw) {
    const appNorm = normalizeOrigin(appOriginRaw, 'APP_ORIGIN');
    const authNorm = normalizeOrigin(betterAuthUrlRaw, 'BETTER_AUTH_URL');
    if (appNorm !== authNorm) {
      throw new AppError(
        500,
        `Configuration mismatch: APP_ORIGIN (${appNorm}) and BETTER_AUTH_URL (${authNorm}) must have matching origins.`
      );
    }
    return appNorm;
  }

  if (appOriginRaw) return normalizeOrigin(appOriginRaw, 'APP_ORIGIN');
  if (betterAuthUrlRaw) return normalizeOrigin(betterAuthUrlRaw, 'BETTER_AUTH_URL');

  if (process.env.NODE_ENV === 'production') {
    throw new AppError(503, 'Configure APP_ORIGIN or BETTER_AUTH_URL for this deployment.');
  }

  return 'http://localhost:3000';
}

export function getTrustedOrigins(): string[] {
  const allowed = new Set<string>();
  const canonical = getCanonicalOrigin();
  allowed.add(canonical);

  if (process.env.VERCEL) {
    if (process.env.VERCEL_URL) allowed.add(`https://${process.env.VERCEL_URL}`);
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) allowed.add(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
    allowed.add('https://niramaalai-billing.vercel.app');
  }

  // Additional approved origins (e.g. approved custom domains or preview deployments)
  const additional = process.env.ADDITIONAL_ALLOWED_ORIGINS || '';
  if (additional.trim()) {
    const items = additional.split(',').map((s) => s.trim()).filter(Boolean);
    for (const item of items) {
      if (item.includes('*')) {
        throw new AppError(500, `Wildcard origins are not permitted in ADDITIONAL_ALLOWED_ORIGINS: "${item}".`);
      }
      allowed.add(normalizeOrigin(item, 'ADDITIONAL_ALLOWED_ORIGINS'));
    }
  }

  // Development origins: strictly localhost when not in production
  if (process.env.NODE_ENV !== 'production') {
    allowed.add('http://localhost:3000');
    allowed.add('http://127.0.0.1:3000');
  }

  return Array.from(allowed);
}

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin || typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  const trusted = getTrustedOrigins();
  return trusted.includes(trimmed);
}
