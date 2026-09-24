import 'server-only';
import {Db, ClientSession} from 'mongodb';
import {z} from 'zod';
import {Identity} from './security';
import {AppError} from './db';
import {recordAudit} from './audit';
import {assertSalePostingDay} from './sales-posting';
import {ensureAccountBalances} from './account-initialization';
import {col, executeIdempotentTransaction, nextTenantSequence} from './purchase-service';
import {uid} from '../lib/domain';
import {isValidCalendarDate} from './master-schema';

const Id = z.string().trim().min(1).max(128);
const PaidVoucherSchema = z.object({
  date: z.string().refine(isValidCalendarDate, 'Invalid date.'),
  payeeName: z.string().trim().min(1, 'Payee name is required.').max(150),
  amountPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  account: z.enum(['Cash', 'Bank']),
  method: z.enum(['Cash', 'UPI', 'BankTransfer', 'Card', 'Cheque']),
  purpose: z.string().trim().min(2, 'Purpose is required.').max(500),
  reference: z.string().trim().max(100).default(''),
  notes: z.string().trim().max(1000).default(''),
  idempotencyKey: Id,
}).superRefine((v, ctx) => {
  if ((v.account === 'Cash') !== (v.method === 'Cash')) ctx.addIssue({code: 'custom', path: ['method'], message: 'Cash account requires Cash; other methods require Bank.'});
});

const ListSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  dateFrom: z.string().refine(isValidCalendarDate).optional(),
  dateTo: z.string().refine(isValidCalendarDate).optional(),
  search: z.string().trim().max(100).optional(),
}).refine(v => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, 'Date range is reversed.');

function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export async function createPaidVoucher(db: Db, identity: Identity, raw: unknown) {
  const input = PaidVoucherSchema.parse(raw);
  return executeIdempotentTransaction(db, identity, input.idempotencyKey, 'paymentVoucher.create', undefined, input,
    async (session: ClientSession) => {
      await assertSalePostingDay(db, identity.tenantId, input.date, session);
      await ensureAccountBalances(db, identity.tenantId, session);
      const now = new Date();
      const balance = await col(db, 'tenantAccountBalances').updateOne({
        tenantId: identity.tenantId, account: input.account, balancePaise: {$gte: input.amountPaise},
      }, {$inc: {balancePaise: -input.amountPaise, version: 1}, $set: {updatedAt: now}}, {session});
      if (balance.matchedCount !== 1) throw new AppError(409, `Insufficient ${input.account.toLowerCase()} balance for this payment.`);

      const id = uid('PV');
      const voucherNumber = await nextTenantSequence(db, identity.tenantId, 'PaymentVoucher', input.date.slice(0, 4), 'PV', session);
      const [settingsDoc, tenantDoc] = await Promise.all([
        col(db, 'companySettings').findOne({tenantId: identity.tenantId}, {session}),
        col(db, 'tenants').findOne({_id: identity.tenantId}, {session}),
      ]);
      const companySnapshot = {
        name: settingsDoc?.name || tenantDoc?.companyName || 'My Store',
        phone: settingsDoc?.phone || '',
        email: settingsDoc?.email || '',
        address: settingsDoc?.address || '',
        gst: settingsDoc?.gst || '',
        logoFileId: settingsDoc?.logoFileId || null,
      };
      const voucher = {_id: id, tenantId: identity.tenantId, voucherNumber, ...input, companySnapshot,
        isReversed: false, createdAt: now, createdBy: identity.userId};
      delete (voucher as any).idempotencyKey;
      await col(db, 'paymentVouchers').insertOne(voucher, {session});
      await col(db, 'accountMovements').insertOne({_id: uid('ACM'), tenantId: identity.tenantId,
        account: input.account, date: input.date, qty: -input.amountPaise, amountPaise: input.amountPaise,
        direction: 'Out', category: 'Expense', paymentMethod: input.method, reason: input.purpose,
        reference: voucherNumber, externalReference: input.reference, partyName: input.payeeName,
        sourceType: 'PaymentVoucher', sourceId: id, isReversed: false, createdAt: now, createdBy: identity.userId}, {session});
      await recordAudit(db, {identity, action: 'Create', entityType: 'paymentVoucher', entityId: id,
        detail: `Payment voucher ${voucherNumber} created`, after: {voucherNumber, amountPaise: input.amountPaise}}, session);
      return voucher;
    });
}

export async function getTenantAccountBalances(db: Db, identity: Identity) {
  await ensureAccountBalances(db, identity.tenantId);
  const rows = await col(db, 'tenantAccountBalances').find({tenantId: identity.tenantId}).toArray();
  const balances: Record<'Cash' | 'Bank', number> = {Cash: 0, Bank: 0};
  for (const r of rows) {
    if (r.account === 'Cash' || r.account === 'Bank') {
      balances[r.account as 'Cash' | 'Bank'] = r.balancePaise || 0;
    }
  }
  return balances;
}

export async function listPaidVouchers(db: Db, identity: Identity, raw: unknown) {
  const q = ListSchema.parse(raw); const filter: Record<string, any> = {tenantId: identity.tenantId};
  if (q.dateFrom || q.dateTo) filter.date = {...(q.dateFrom && {$gte: q.dateFrom}), ...(q.dateTo && {$lte: q.dateTo})};
  if (q.search) { const s = escapeRegex(q.search); filter.$or = [{voucherNumber: {$regex: s, $options: 'i'}}, {payeeName: {$regex: s, $options: 'i'}}, {purpose: {$regex: s, $options: 'i'}}, {reference: {$regex: s, $options: 'i'}}]; }
  const skip = (q.page - 1) * q.limit;
  const [items, total, balances, sumAgg] = await Promise.all([
    col(db, 'paymentVouchers').find(filter).sort({date: -1, createdAt: -1}).skip(skip).limit(q.limit).toArray(),
    col(db, 'paymentVouchers').countDocuments(filter),
    getTenantAccountBalances(db, identity).catch(() => ({Cash: 0, Bank: 0})),
    col(db, 'paymentVouchers').aggregate([
      {$match: filter},
      {$group: {_id: null, totalPaidPaise: {$sum: '$amountPaise'}}},
    ]).toArray(),
  ]);
  const totalPaidPaise = sumAgg[0]?.totalPaidPaise || 0;
  return {items, total, totalPaidPaise, page: q.page, limit: q.limit, totalPages: Math.max(1, Math.ceil(total / q.limit)), balances};
}

export async function getPaidVoucher(db: Db, identity: Identity, id: string) {
  const item = await col(db, 'paymentVouchers').findOne({_id: id, tenantId: identity.tenantId});
  if (!item) throw new AppError(404, 'Payment voucher not found.');
  return item;
}

