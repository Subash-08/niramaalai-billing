import {endpoint, requireIdentity} from '@/server/auth';
import {database} from '@/server/db';
import {col} from '@/server/purchase-service';
import {getTenantAccountBalances} from '@/server/payment-voucher-service';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return endpoint(async () => {
    const identity = await requireIdentity();
    const db = await database();
    const tenantId = identity.tenantId;

    const url = new URL(request.url);
    const dateFrom = url.searchParams.get('dateFrom') || undefined;
    const dateTo = url.searchParams.get('dateTo') || undefined;

    const receiptFilter: Record<string, any> = {tenantId, isReversed: {$ne: true}};
    const voucherFilter: Record<string, any> = {tenantId, isReversed: {$ne: true}};

    if (dateFrom || dateTo) {
      const dateRange: Record<string, any> = {};
      if (dateFrom) dateRange.$gte = dateFrom;
      if (dateTo) dateRange.$lte = dateTo;
      receiptFilter.date = dateRange;
      voucherFilter.date = dateRange;
    }

    const [receiptAgg, voucherAgg, balances] = await Promise.all([
      col(db, 'customerReceipts').aggregate([
        {$match: receiptFilter},
        {$group: {_id: null, totalReceivedPaise: {$sum: '$totalAmountPaise'}, count: {$sum: 1}}},
      ]).toArray(),
      col(db, 'paymentVouchers').aggregate([
        {$match: voucherFilter},
        {$group: {_id: null, totalPaidPaise: {$sum: '$amountPaise'}, count: {$sum: 1}}},
      ]).toArray(),
      getTenantAccountBalances(db, identity).catch(() => ({Cash: 0, Bank: 0})),
    ]);

    return {
      totalReceivedPaise: receiptAgg[0]?.totalReceivedPaise || 0,
      totalPaidPaise: voucherAgg[0]?.totalPaidPaise || 0,
      receiptCount: receiptAgg[0]?.count || 0,
      voucherCount: voucherAgg[0]?.count || 0,
      cashBalancePaise: balances.Cash || 0,
      bankBalancePaise: balances.Bank || 0,
    };
  });
}
