import {MongoClient} from 'mongodb';

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || 'niramaalai';
if (!uri) throw new Error('MONGODB_URI is not configured.');

const requiredIndexes = {
  invoices: ['tenantId_1_status_1_invoiceDate_-1', 'tenantId_1_customerId_1_status_1_invoiceDate_-1'],
  customerReceipts: ['tenantId_1_customerId_1_date_-1', 'tenantId_1_invoiceId_1'],
  paymentVouchers: ['tenantId_1_voucherNumber_1', 'tenantId_1_date_-1_createdAt_-1'],
  products: ['tenantId_1_status_1_createdAt_-1', 'tenantId_1_name_1'],
  serviceCatalog: ['tenantId_1_name_1'],
};

const client = new MongoClient(uri, {serverSelectionTimeoutMS: 10000});
try {
  await client.connect();
  const db = client.db(databaseName);
  await db.command({ping: 1});
  const missing = [];
  for (const [collection, expectedNames] of Object.entries(requiredIndexes)) {
    const actual = new Set((await db.collection(collection).indexes()).map(index => index.name));
    for (const name of expectedNames) if (!actual.has(name)) missing.push(`${collection}:${name}`);
  }
  if (missing.length) {
    console.error(`Atlas verification failed: ${missing.length} required index(es) missing.`);
    for (const item of missing) console.error(`- ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`Atlas verification passed: database=${db.databaseName}, connection=ok, requiredIndexes=ok`);
  }
} finally {
  await client.close();
}
