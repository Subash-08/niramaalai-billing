import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';

if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
const email = process.argv.slice(2).filter(a => a !== '--')[0]?.trim().toLowerCase();
if (!email || !process.env.MONGODB_URI) {
  throw new Error('Usage: npm run account:approve -- email@example.com (configure .env.local first)');
}

const client = await new MongoClient(process.env.MONGODB_URI).connect();
try {
  const db = client.db(process.env.MONGODB_DB || 'niramaalai');
  const user = await db.collection('authUsers').findOne({email});
  if (!user) throw new Error('Account not found.');
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const approvedAt = new Date();
      await db.collection('authUsers').updateOne(
        {_id: user._id}, {$set: {verified: true, disabled: false, verifiedAt: approvedAt}}, {session}
      );
      await db.collection('tenants').updateOne(
        {_id: user.tenantId}, {$set: {verified: true, disabled: false, verifiedAt: approvedAt}}, {session}
      );
      await db.collection('auditHistory').insertOne({
        _id: randomUUID(),
        tenantId: user.tenantId,
        action: 'Company approved',
        entityType: 'tenant',
        entityId: user.tenantId,
        performedBy: 'operator-cli',
        detail: `Approved account ${email}`,
        timestamp: approvedAt,
      }, {session});
    });
  } finally {
    await session.endSession();
  }
  console.log('Company account approved and enabled.');
} finally {
  await client.close();
}
