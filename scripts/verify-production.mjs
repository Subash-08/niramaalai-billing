const origin = (process.env.APP_ORIGIN || process.argv[2] || '').replace(/\/$/, '');

if (!origin || !/^https:\/\//i.test(origin)) {
  throw new Error('Set APP_ORIGIN to the deployed HTTPS origin or pass it as the first argument.');
}

async function request(path, init) {
  const response = await fetch(origin + path, {redirect: 'manual', ...init});
  const text = await response.text();
  return {response, text};
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const health = await request('/api/health');
assert(health.response.status === 200, `/api/health returned ${health.response.status}`);
assert(health.response.headers.get('content-type')?.includes('application/json'), '/api/health did not return JSON.');
const healthBody = JSON.parse(health.text);
assert(healthBody.status === 'ok' && healthBody.database === 'connected', '/api/health reports an unhealthy database.');

const requiredHeaders = [
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
];
for (const header of requiredHeaders) {
  assert(health.response.headers.has(header), `Missing production header: ${header}`);
}
assert(!health.response.headers.has('x-powered-by'), 'X-Powered-By must be disabled.');

for (const path of ['/api/company/dashboard', '/api/sales/invoices', '/api/payments/vouchers', '/api/master/customers']) {
  const result = await request(path);
  assert(result.response.status === 401, `${path} must return 401 without a session; received ${result.response.status}.`);
  assert(result.response.headers.get('content-type')?.includes('application/json'), `${path} must return JSON.`);
}

const removedAccountLedger = await request('/api/payments/accounts');
assert(removedAccountLedger.response.status === 404, 'Removed cash/bank account API must return 404.');
assert(removedAccountLedger.response.headers.get('content-type')?.includes('application/json'), 'Unknown API routes must return JSON.');

console.log(JSON.stringify({
  origin,
  health: 'ok',
  database: 'connected',
  protectedRoutes: 'ok',
  removedAccountLedger: 'not-found',
  securityHeaders: 'ok',
}, null, 2));

