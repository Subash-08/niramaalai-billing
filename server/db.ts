import 'server-only';
import {MongoClient} from 'mongodb';
import dns from 'node:dns';

// Public DNS override is strictly opt-in via environment configuration
// (e.g. ENABLE_PUBLIC_DNS_OVERRIDE=true or MONGODB_DNS_SERVERS=8.8.8.8,1.1.1.1)
if (process.env.ENABLE_PUBLIC_DNS_OVERRIDE === 'true' || process.env.MONGODB_DNS_SERVERS) {
  try {
    const servers = process.env.MONGODB_DNS_SERVERS
      ? process.env.MONGODB_DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean)
      : ['8.8.8.8', '1.1.1.1'];
    if (servers.length > 0) {
      dns.setServers(servers);
    }
  } catch (err: any) {
    console.warn('[db] Failed to configure optional public DNS servers:', err?.message || err);
  }
}

export class AppError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const globalDb = globalThis as typeof globalThis & {
  itechMongo?: Promise<MongoClient>;
  itechIndexes?: Promise<void>;
  indexIntegrityVerified?: boolean;
  indexIntegrityErrors?: string[];
};

function isDnsDiscoveryError(err: any): boolean {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  const syscall = err.syscall || err.cause?.syscall;
  const msg = `${err.message || ''} ${err.cause?.message || ''}`;
  return (
    code === 'ETIMEOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    syscall === 'querySrv' ||
    syscall === 'queryTxt' ||
    msg.includes('querySrv') ||
    msg.includes('queryTxt')
  );
}

async function connectClient(primaryUri: string): Promise<MongoClient> {
  const fallbackUri = process.env.MONGODB_FALLBACK_URI;
  let primaryClient: MongoClient | undefined;

  try {
    primaryClient = new MongoClient(primaryUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    return await primaryClient.connect();
  } catch (err: any) {
    if (primaryClient) {
      await primaryClient.close().catch(() => {});
    }

    if (fallbackUri && isDnsDiscoveryError(err)) {
      console.warn(
        `[db] Primary DNS discovery timed out or failed (${err.code || err.syscall || 'discovery_error'}). Attempting optional MONGODB_FALLBACK_URI...`
      );
      let fallbackClient: MongoClient | undefined;
      try {
        fallbackClient = new MongoClient(fallbackUri, {
          maxPoolSize: 10,
          serverSelectionTimeoutMS: 5000,
        });
        return await fallbackClient.connect();
      } catch (fallbackErr: any) {
        if (fallbackClient) {
          await fallbackClient.close().catch(() => {});
        }
        console.error(
          `[db] Fallback connection failed (${fallbackErr.code || fallbackErr.message}).`
        );
        throw fallbackErr;
      }
    }

    throw err;
  }
}

export async function mongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new AppError(503, 'MongoDB is not configured. The demo is still available.');
  if (!globalDb.itechMongo) {
    globalDb.itechMongo = connectClient(uri).catch(e => {
      globalDb.itechMongo = undefined;
      throw e;
    });
  }
  return globalDb.itechMongo;
}

export async function database() {
  return (await mongo()).db(process.env.MONGODB_DB || 'billing_dev');
}

export function assertWriteIntegrity() {
  if (globalDb.indexIntegrityErrors && globalDb.indexIntegrityErrors.length > 0) {
    throw new AppError(
      500,
      'Database write operation suspended due to index integrity requirements. Please contact the administrator.'
    );
  }
}

function canonicalStringify(val: any): string {
  if (val === undefined || val === null) return '';
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(val).sort();
  return '{' + keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(val[k])}`).join(',') + '}';
}

async function safeCreateIndex(
  col: any,
  keys: Record<string, 1 | -1 | string>,
  options?: any
) {
  const existing = await col.listIndexes().toArray().catch(() => []);
  const keyJson = canonicalStringify(keys);
  const matched = existing.find((idx: any) => canonicalStringify(idx.key) === keyJson);

  if (matched) {
    // 1. Verify uniqueness
    const reqUnique = Boolean(options?.unique);
    const actUnique = Boolean(matched.unique);
    if (reqUnique !== actUnique) {
      const msg = `Incompatible index on ${col.collectionName}: key ${keyJson} requires unique=${reqUnique}, but existing index '${matched.name}' has unique=${actUnique}. Conflict report: Uniqueness constraint mismatch. Migration proposal: Review collection for duplicate records and execute an administrative index migration to reconcile '${matched.name}'. Automatic index drop is prohibited.`;
      console.error(`[db:index-integrity-error] ${msg}`);
      globalDb.indexIntegrityErrors = [...(globalDb.indexIntegrityErrors || []), msg];
      throw new AppError(500, 'Database index integrity check failed. Write access is suspended pending administrative migration.');
    }

    // 2. Verify partialFilterExpression (must not accept unexpected partial where full is required, and vice versa)
    const hasReqPartial = Boolean(options?.partialFilterExpression);
    const hasActPartial = Boolean(matched.partialFilterExpression);
    if (hasReqPartial !== hasActPartial) {
      const msg = `Incompatible index on ${col.collectionName}: key ${keyJson} requires ${hasReqPartial ? 'partialFilterExpression' : 'full index'}, but existing index '${matched.name}' has ${hasActPartial ? 'partialFilterExpression' : 'full index'}. Conflict report: Filter scope mismatch. Migration proposal: An administrator must verify query predicates and migrate index '${matched.name}'. Automatic drop is prohibited.`;
      console.error(`[db:index-integrity-error] ${msg}`);
      globalDb.indexIntegrityErrors = [...(globalDb.indexIntegrityErrors || []), msg];
      throw new AppError(500, 'Database index integrity check failed. Write access is suspended pending administrative migration.');
    }
    if (hasReqPartial && hasActPartial) {
      const reqPartial = canonicalStringify(options.partialFilterExpression);
      const actPartial = canonicalStringify(matched.partialFilterExpression);
      if (reqPartial !== actPartial) {
        const msg = `Incompatible index on ${col.collectionName}: key ${keyJson} requires partialFilterExpression=${reqPartial}, but existing index '${matched.name}' has ${actPartial}. Conflict report: Filter expression mismatch. Migration proposal: Verify predicate coverage and migrate index '${matched.name}'.`;
        console.error(`[db:index-integrity-error] ${msg}`);
        globalDb.indexIntegrityErrors = [...(globalDb.indexIntegrityErrors || []), msg];
        throw new AppError(500, 'Database index integrity check failed. Write access is suspended pending administrative migration.');
      }
    }

    // 3. Verify expireAfterSeconds (TTL)
    const reqTTL = options?.expireAfterSeconds !== undefined ? options.expireAfterSeconds : undefined;
    const actTTL = matched.expireAfterSeconds !== undefined ? matched.expireAfterSeconds : undefined;
    if (reqTTL !== actTTL) {
      const msg = `Incompatible index on ${col.collectionName}: key ${keyJson} requires expireAfterSeconds=${reqTTL}, but existing index '${matched.name}' has expireAfterSeconds=${actTTL}. Conflict report: TTL mismatch. Migration proposal: Adjust TTL settings on '${matched.name}'.`;
      console.error(`[db:index-integrity-error] ${msg}`);
      globalDb.indexIntegrityErrors = [...(globalDb.indexIntegrityErrors || []), msg];
      throw new AppError(500, 'Database index integrity check failed. Write access is suspended pending administrative migration.');
    }

    // 4. Verify collation if specified
    if (options?.collation || matched.collation) {
      const reqCollation = options?.collation ? canonicalStringify(options.collation) : '';
      const actCollation = matched.collation ? canonicalStringify(matched.collation) : '';
      if (reqCollation !== actCollation) {
        const msg = `Incompatible index on ${col.collectionName}: key ${keyJson} requires collation=${reqCollation || 'none'}, but existing index '${matched.name}' has collation=${actCollation || 'none'}.`;
        console.error(`[db:index-integrity-error] ${msg}`);
        globalDb.indexIntegrityErrors = [...(globalDb.indexIntegrityErrors || []), msg];
        throw new AppError(500, 'Database index integrity check failed. Write access is suspended pending administrative migration.');
      }
    }

    return matched.name;
  }

  // If index does not exist, create it
  try {
    return await col.createIndex(keys, options);
  } catch (err: any) {
    const msg = `Failed to create required index on ${col.collectionName} ${keyJson}: ${err?.message || err}`;
    console.error(`[db:index-create-error] ${msg}`);
    globalDb.indexIntegrityErrors = [...(globalDb.indexIntegrityErrors || []), msg];
    throw new AppError(500, 'Database index creation failed. Write access is suspended.');
  }
}

export async function ensureIndexes() {
  if (!globalDb.itechIndexes || !globalDb.indexIntegrityVerified) {
    globalDb.indexIntegrityErrors = [];
    globalDb.itechIndexes = (async () => {
      const db = await database();
      await Promise.all([
        // Authentication and tenancy
        safeCreateIndex(db.collection('authUsers'), {email: 1}, {unique: true}),
        safeCreateIndex(db.collection('authUsers'), {tenantId: 1}),
        safeCreateIndex(db.collection('authSessions'), {expiresAt: 1}, {expireAfterSeconds: 0}),
        safeCreateIndex(db.collection('authSessions'), {userId: 1}),
        safeCreateIndex(db.collection('authSessions'), {token: 1}, {unique: true}),
        safeCreateIndex(db.collection('authAccounts'), {providerId: 1, accountId: 1}, {unique: true}),
        safeCreateIndex(db.collection('authRateLimits'), {key: 1}, {unique: true}),
        safeCreateIndex(db.collection('rateLimits'), {expiresAt: 1}, {expireAfterSeconds: 0}),

        // Company files and private storage
        safeCreateIndex(db.collection('files'), {tenantId: 1, createdAt: -1}),
        safeCreateIndex(db.collection('files'), {tenantId: 1, _id: 1, storageConnectionId: 1, status: 1}),
        safeCreateIndex(db.collection('storageConnections'), {tenantId: 1, _id: 1}),
        safeCreateIndex(db.collection('storageConnections'), {tenantId: 1, status: 1}),
        safeCreateIndex(db.collection('pendingUploads'), {tenantId: 1, userId: 1, status: 1}),
        safeCreateIndex(db.collection('pendingUploads'), {tenantId: 1, status: 1, expiresAt: 1}),
        safeCreateIndex(db.collection('pendingUploads'), {tenantId: 1, userId: 1, createdAt: -1}),
        safeCreateIndex(db.collection('pendingUploads'), {tenantId: 1, publicId: 1}, {unique: true}),

        // Company settings and billing catalogues
        safeCreateIndex(db.collection('companySettings'), {tenantId: 1}, {unique: true}),
        safeCreateIndex(db.collection('customers'), {tenantId: 1, status: 1, createdAt: -1}),
        safeCreateIndex(db.collection('customers'), {tenantId: 1, name: 1}),
        safeCreateIndex(db.collection('customers'), {tenantId: 1, phone: 1}),
        safeCreateIndex(db.collection('customers'), {tenantId: 1, gstNormalized: 1}, {
          unique: true,
          partialFilterExpression: {gstNormalized: {$type: 'string', $gt: ''}, status: 'Active'},
        }),
        safeCreateIndex(db.collection('products'), {tenantId: 1, status: 1, createdAt: -1}),
        safeCreateIndex(db.collection('products'), {tenantId: 1, name: 1}),
        safeCreateIndex(db.collection('products'), {tenantId: 1, category: 1}),
        safeCreateIndex(db.collection('serviceCatalog'), {tenantId: 1, name: 1}),
        safeCreateIndex(db.collection('serviceCatalog'), {tenantId: 1, status: 1, active: 1}),
        safeCreateIndex(db.collection('printJobs'), {tenantId: 1, status: 1, dueDate: 1}),
        safeCreateIndex(db.collection('printJobs'), {tenantId: 1, jobNumber: 1}, {unique: true}),

        // Templates and audit trail
        safeCreateIndex(db.collection('invoiceTemplates'), {tenantId: 1, nameNormalized: 1}, {
          unique: true,
          partialFilterExpression: {status: 'Active'},
        }),
        safeCreateIndex(db.collection('invoiceTemplates'), {tenantId: 1, isDefault: 1}, {
          unique: true,
          partialFilterExpression: {isDefault: true, status: 'Active'},
        }),
        safeCreateIndex(db.collection('templateRevisions'), {tenantId: 1, templateId: 1, revision: 1}, {unique: true}),
        safeCreateIndex(db.collection('auditHistory'), {tenantId: 1, timestamp: -1}),
        safeCreateIndex(db.collection('auditHistory'), {tenantId: 1, entityType: 1, entityId: 1}),

        // Invoices, one-invoice receipts and money paid
        safeCreateIndex(db.collection('openingSetups'), {tenantId: 1}, {unique: true}),
        safeCreateIndex(db.collection('openingReceivables'), {tenantId: 1, customerId: 1, status: 1}),
        safeCreateIndex(db.collection('invoices'), {tenantId: 1, invoiceNumber: 1}, {
          unique: true,
          partialFilterExpression: {status: 'Issued', invoiceNumber: {$type: 'string', $gt: ''}},
        }),
        safeCreateIndex(db.collection('invoices'), {tenantId: 1, status: 1, invoiceDate: -1}),
        safeCreateIndex(db.collection('invoices'), {tenantId: 1, customerId: 1, status: 1, invoiceDate: -1}),
        safeCreateIndex(db.collection('invoices'), {tenantId: 1, duePaise: 1, status: 1}),
        safeCreateIndex(db.collection('customerReceipts'), {tenantId: 1, receiptNumber: 1}, {unique: true}),
        safeCreateIndex(db.collection('customerReceipts'), {tenantId: 1, customerId: 1, date: -1}),
        safeCreateIndex(db.collection('customerReceipts'), {tenantId: 1, invoiceId: 1}),
        safeCreateIndex(db.collection('customerAllocations'), {tenantId: 1, targetType: 1, targetId: 1}),
        safeCreateIndex(db.collection('customerAllocations'), {tenantId: 1, sourceId: 1}),
        safeCreateIndex(db.collection('customerAllocations'), {tenantId: 1, customerId: 1, effectiveDate: -1}),
        safeCreateIndex(db.collection('paymentVouchers'), {tenantId: 1, voucherNumber: 1}, {unique: true}),
        safeCreateIndex(db.collection('paymentVouchers'), {tenantId: 1, date: -1, createdAt: -1}),
        safeCreateIndex(db.collection('tenantCounters'), {tenantId: 1, sequenceType: 1, year: 1}, {unique: true}),
        safeCreateIndex(db.collection('idempotencyOperations'), {tenantId: 1, idempotencyKey: 1}, {unique: true}),
      ]);
      globalDb.indexIntegrityVerified = true;
    })().catch(e => {
      globalDb.itechIndexes = undefined;
      globalDb.indexIntegrityVerified = false;
      throw e;
    });
  }
  return globalDb.itechIndexes;
}
