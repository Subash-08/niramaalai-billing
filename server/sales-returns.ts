import 'server-only';
import {Db, ClientSession} from 'mongodb';
import {AppError} from './db';
import {Identity} from './security';
import {recordAudit} from './audit';
import {uid} from '../lib/domain';
import {todayInKolkata} from './purchase-schema';
import {canonicalSerialKey, resolveSerialUnit, transitionSerialUnit} from './serial-identity';
import {sumSalePaise, prorateSaleReturnComponents} from './sales-calculations';
import {
  CreateCustomerReturnSchema,
  CreateCustomerReturnInput,
} from './sales-schema';
import {
  assertSalePostingDay,
} from './sales-posting';
import {
  col,
  nextTenantSequence,
  executeIdempotentTransaction,
} from './purchase-service';
import type {InvoiceDocument} from './sales-service';

export type CustomerReturnDocument = {
  _id: string;
  tenantId: string;
  returnNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceLineId: string;
  customerId: string;
  customerSnapshot: {
    name: string;
    phone?: string;
  };
  productId?: string;
  productSnapshot?: {
    name: string;
    hsn: string;
  };
  quantity: number;
  serials: string[];
  date: string;
  reason: string;
  stockDisposition: 'RestockSellable' | 'Quarantine' | 'NoStock';
  settlement: 'CustomerCredit' | 'RefundNow';
  taxableBasePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  refundPaise: number;
  creditToInvoice?: number;
  eligibleRefundPaise?: number;
  lotRestorations?: Array<{lotId: string; qty: number}>;
  creditAdvanceId?: string;
  createdAt: Date;
  createdBy: string;
};

export async function createCustomerReturn(
  db: Db,
  identity: Identity,
  raw: unknown
) {
  const input = CreateCustomerReturnSchema.parse(raw);
  const tenantId = identity.tenantId;

  return executeIdempotentTransaction(
    db,
    identity,
    input.idempotencyKey,
    'createCustomerReturn',
    input.invoiceId,
    input,
    async (session: ClientSession) => {
      await assertSalePostingDay(db, tenantId, input.date, session);

      const invoice = await col<InvoiceDocument>(db, 'invoices').findOne(
        {_id: input.invoiceId, tenantId, status: 'Issued'},
        {session}
      );
      if (!invoice) throw new AppError(404, 'Issued invoice not found.');

      // Find the specific line
      const line = (invoice.lines || []).find(
        (l: any) => l.lineId === input.invoiceLineId || l.clientLineKey === input.invoiceLineId
      );
      if (!line) throw new AppError(404, 'Invoice line not found.');

      // Customer financial lock & serialization
      const customer = await col(db, 'customers').findOneAndUpdate(
        {_id: invoice.customerId, tenantId, status: 'Active'},
        {$inc: {financialVersion: 1}},
        {session, returnDocument: 'after'}
      );
      if (!customer) throw new AppError(404, 'Customer not found or archived.');

      // Calculate prior returns on this specific line
      const lineKey = line.lineId;
      const priorReturns = await col<CustomerReturnDocument>(db, 'customerReturns')
        .find({tenantId, invoiceId: invoice._id, invoiceLineId: {$in: [line.lineId, line.clientLineKey].filter(Boolean)}}, {session})
        .toArray();

      const alreadyReturnedQuantity = priorReturns.reduce((sum, r) => sum + r.quantity, 0);
      if (alreadyReturnedQuantity + input.quantity > line.quantity) {
        throw new AppError(400, `Return quantity (${input.quantity}) exceeds remaining returnable quantity (${line.quantity - alreadyReturnedQuantity}).`);
      }

      const alreadyCredited = {
        taxableBasePaise: priorReturns.reduce((s, r) => s + (r.taxableBasePaise || 0), 0),
        cgstPaise: priorReturns.reduce((s, r) => s + (r.cgstPaise || 0), 0),
        sgstPaise: priorReturns.reduce((s, r) => s + (r.sgstPaise || 0), 0),
        igstPaise: priorReturns.reduce((s, r) => s + (r.igstPaise || 0), 0),
      };

      const prorated = prorateSaleReturnComponents({
        original: {
          taxableBasePaise: line.taxableBasePaise || 0,
          cgstPaise: line.cgstPaise || 0,
          sgstPaise: line.sgstPaise || 0,
          igstPaise: line.igstPaise || 0,
          totalPaise: line.totalPaise || 0,
        },
        alreadyCredited,
        originalQuantity: line.quantity,
        alreadyReturnedQuantity,
        returnQuantity: input.quantity,
      });

      const refundPaise = prorated.totalPaise;
      const now = new Date();
      const year = input.date.slice(0, 4);
      const returnId = uid('CRN');
      const returnNumber = await nextTenantSequence(db, tenantId, 'Return', year, 'RTN', session);

      // Restorations must be backed by this exact invoice line's issued allocations.
      const lotRestorations: Array<{lotId: string; qty: number}> = [];
      const serialDocs: any[] = [];
      const canonicalSerials = (input.serials || []).map(canonicalSerialKey);
      if (new Set(canonicalSerials).size !== canonicalSerials.length) {
        throw new AppError(400, 'Return serial numbers must be distinct.');
      }

      const isPhysical = (line.lineType === 'Product' || line.lineType === 'ConsumedPart') && line.productId;
      const isConsumedPart = line.lineType === 'ConsumedPart';

      if (isPhysical) {
        if (input.stockDisposition === 'NoStock') {
          throw new AppError(400, 'Choose sellable or defective stock for a physical product or consumed part return.');
        }

        const tracked = !!line.productSnapshot?.isSerialTracked;
        if (tracked ? canonicalSerials.length !== input.quantity : canonicalSerials.length !== 0) {
          throw new AppError(400, tracked ? 'Select every returned serial number.' : 'This product does not track serial numbers.');
        }

        let allocations = line.stockAllocations ?? [];
        if (!allocations.length && isConsumedPart) {
          let lotId = line.lotId;
          let sers = line.serials || [];
          if ((!lotId || !sers.length) && line.serviceJobId && line.partId) {
            const jobDoc = await col(db, 'serviceJobs').findOne({_id: line.serviceJobId, tenantId}, {session});
            const partDoc = (jobDoc?.parts || []).find((p: any) => p.partId === line.partId);
            if (partDoc) {
              lotId = lotId || partDoc.lotId;
              if (!sers.length && partDoc.serials?.length) sers = partDoc.serials;
            }
          }
          if (lotId) {
            allocations = [{lotId, quantity: line.quantity, serials: sers}];
          }
        }

        const issuedPerLot = new Map<string, number>();
        const issuedSerialLots = new Map<string, string>();
        for (const allocation of allocations) {
          issuedPerLot.set(allocation.lotId, (issuedPerLot.get(allocation.lotId) ?? 0) + allocation.quantity);
          for (const serial of allocation.serials ?? []) {
            issuedSerialLots.set(canonicalSerialKey(serial), allocation.lotId);
          }
        }

        const returnedPerLot = new Map<string, number>();
        for (const prior of priorReturns) {
          if (!prior.lotRestorations?.length) {
            throw new AppError(409, 'An earlier return has no source-lot history. Reconcile that record before returning more stock.');
          }
          for (const restored of prior.lotRestorations) {
            returnedPerLot.set(restored.lotId, (returnedPerLot.get(restored.lotId) ?? 0) + restored.qty);
          }
        }

        if (tracked) {
          const lots = new Map<string, number>();
          for (const rawSerial of (input.serials || [])) {
            let resolved;
            try {
              resolved = await resolveSerialUnit(db, session, tenantId, rawSerial, {
                productId: line.productId,
                expectedStatus: isConsumedPart ? 'ConsumedInService' : 'Sold',
                expectedInvoiceId: isConsumedPart ? undefined : invoice._id,
              });
            } catch (err: any) {
              if (err instanceof AppError && err.status === 404) {
                throw new AppError(400, `Serial "${rawSerial}" does not exist or was not billed on this invoice.`);
              }
              throw err;
            }
            const {unit, version} = resolved;
            if (!isConsumedPart && unit.invoiceLineId && unit.invoiceLineId !== line.lineId) {
              throw new AppError(400, `Serial ${rawSerial} was not sold on this invoice line or is not available for return.`);
            }
            if (isConsumedPart && line.serviceJobId && unit.serviceJobId && unit.serviceJobId !== line.serviceJobId) {
              throw new AppError(400, `Serial ${rawSerial} belongs to a different service job.`);
            }
            if (unit.replacedBySerial) {
              throw new AppError(409, `Serial ${rawSerial} was already replaced under warranty and cannot be returned directly.`);
            }

            const lotId = unit.lotId;
            if (!lotId) {
              throw new AppError(409, `Serial ${rawSerial} has no traceable source stock lot.`);
            }
            serialDocs.push({unit, version});
            lots.set(lotId, (lots.get(lotId) ?? 0) + 1);
          }
          for (const [lotId, qty] of lots) {
            lotRestorations.push({lotId, qty});
          }
        } else {
          let remaining = input.quantity;
          for (const [lotId, issued] of issuedPerLot) {
            const available = issued - (returnedPerLot.get(lotId) ?? 0);
            if (available < 0) throw new AppError(409, 'Source-lot return history is inconsistent.');
            const qty = Math.min(remaining, available);
            if (qty > 0) lotRestorations.push({lotId, qty});
            remaining -= qty;
          }
          if (remaining !== 0) {
            throw new AppError(409, 'Issued source lots cannot cover this return. No stock was changed.');
          }
        }

        const restock = input.stockDisposition === 'RestockSellable';
        for (const {lotId, qty} of lotRestorations) {
          if (isConsumedPart) {
            const checkLot = await col(db, 'stockLots').findOne({_id: lotId, tenantId, productId: line.productId}, {session});
            if (!checkLot || (checkLot.quantityConsumed ?? 0) < qty) {
              throw new AppError(409, 'Return exceeds the quantity consumed from this source lot.');
            }
            const result = await col(db, 'stockLots').updateOne(
              {_id: lotId, tenantId, productId: line.productId, quantityConsumed: {$gte: qty}},
              {
                $inc: {
                  quantityConsumed: -qty,
                  quantitySellable: restock ? qty : 0,
                  quantityRemaining: restock ? qty : 0,
                  quantityDefective: restock ? 0 : qty,
                  version: 1,
                },
                $set: {updatedAt: now},
              },
              {session}
            );
            if (result.matchedCount !== 1) throw new AppError(409, 'Consumed stock changed. Reload before returning.');

            await col(db, 'stockMovements').insertOne(
              {
                _id: uid('STM'),
                tenantId,
                productId: line.productId,
                lotId,
                date: input.date,
                type: restock ? 'SaleReturnRestock' : 'SaleReturnDefective',
                qty,
                onHandDelta: qty,
                sellableDelta: restock ? qty : 0,
                defectiveDelta: restock ? 0 : qty,
                consumedDelta: -qty,
                reference: returnNumber,
                invoiceId: invoice._id,
                invoiceLineId: line.lineId,
                returnId,
                createdAt: now,
                createdBy: identity.userId,
              },
              {session}
            );
          } else {
            if (qty + (returnedPerLot.get(lotId) ?? 0) > (issuedPerLot.get(lotId) ?? 0)) {
              // If it's a warranty replacement unit return, verify quantitySold on lot
              const checkLot = await col(db, 'stockLots').findOne({_id: lotId, tenantId, productId: line.productId}, {session});
              if (!checkLot || checkLot.quantitySold < qty) {
                throw new AppError(409, 'Return exceeds the quantity sold from this source lot.');
              }
            }
            const result = await col(db, 'stockLots').updateOne(
              {_id: lotId, tenantId, productId: line.productId, quantitySold: {$gte: qty}},
              {
                $inc: {
                  quantitySold: -qty,
                  quantitySellable: restock ? qty : 0,
                  quantityRemaining: restock ? qty : 0,
                  quantityDefective: restock ? 0 : qty,
                  version: 1,
                },
                $set: {updatedAt: now},
              },
              {session}
            );
            if (result.matchedCount !== 1) throw new AppError(409, 'Sold stock changed. Reload before returning.');

            await col(db, 'stockMovements').insertOne(
              {
                _id: uid('STM'),
                tenantId,
                productId: line.productId,
                lotId,
                date: input.date,
                type: restock ? 'SaleReturnRestock' : 'SaleReturnDefective',
                qty,
                onHandDelta: qty,
                sellableDelta: restock ? qty : 0,
                defectiveDelta: restock ? 0 : qty,
                soldDelta: -qty,
                reference: returnNumber,
                invoiceId: invoice._id,
                invoiceLineId: line.lineId,
                returnId,
                createdAt: now,
                createdBy: identity.userId,
              },
              {session}
            );
          }
        }

        for (const item of serialDocs) {
          if (isConsumedPart) {
            await transitionSerialUnit(db, session, item.unit._id, {
              transition: 'CustomerReturn',
              expected: {
                tenantId,
                productId: line.productId,
                lotId: item.unit.lotId,
                status: 'ConsumedInService',
                version: item.version,
              },
              nextState: {
                status: restock ? 'InStock' : 'Defective',
                lastReturnId: returnId,
                serviceJobId: null,
                reservationId: null,
                invoiceId: null,
                soldInvoiceId: null,
                invoiceLineId: null,
              },
            });
          } else {
            await transitionSerialUnit(db, session, item.unit._id, {
              transition: 'CustomerReturn',
              expected: {
                tenantId,
                productId: line.productId,
                lotId: item.unit.lotId,
                status: 'Sold',
                invoiceId: invoice._id,
                invoiceLineId: line.lineId,
                version: item.version,
              },
              nextState: {
                status: restock ? 'InStock' : 'Defective',
                lastReturnId: returnId,
                reservationId: null,
                invoiceId: null,
                soldInvoiceId: null,
                invoiceLineId: null,
              },
            });
          }
        }

        if (isConsumedPart && line.serviceJobId && line.partId) {
          await col(db, 'serviceJobs').updateOne(
            {_id: line.serviceJobId, tenantId, 'parts.partId': line.partId},
            {
              $set: {
                'parts.$.returned': true,
                'parts.$.returnId': returnId,
                updatedAt: now,
              },
            },
            {session}
          );
        }

        // Warranty adjustments
        if (tracked) {
          await col(db, 'warranties').updateMany(
            {
              tenantId,
              invoiceId: invoice._id,
              invoiceLineId: line.lineId,
              $or: [
                {serial: {$in: canonicalSerials}},
                {serialNumber: {$in: canonicalSerials}},
                {serial: {$in: input.serials || []}},
                {serialNumber: {$in: input.serials || []}},
              ],
            },
            {
              $set: {status: 'Returned', returnId, returnedAt: now, updatedAt: now},
              $inc: {version: 1},
            },
            {session}
          );
        } else {
          // Track remaining covered quantity on non-serialized warranties
          const nonSerWar = await col(db, 'warranties').findOne(
            {tenantId, invoiceId: invoice._id, invoiceLineId: line.lineId, status: 'Active'},
            {session}
          );
          if (nonSerWar) {
            const currentRem = nonSerWar.remainingQuantity ?? nonSerWar.quantity ?? line.quantity;
            const remW = currentRem - input.quantity;
            await col(db, 'warranties').updateOne(
              {_id: nonSerWar._id, tenantId},
              {
                $set: {
                  remainingQuantity: Math.max(0, remW),
                  status: remW <= 0 ? 'Returned' : 'Active',
                  returnId,
                  updatedAt: now,
                },
                $inc: {version: 1},
              },
              {session}
            );
          }
        }
      } else if (input.stockDisposition !== 'NoStock' || input.serials.length) {
        throw new AppError(400, 'Service and charge credits must use No stock and no serials.');
      }

      // Financial Settlement: Unpaid-due-first settlement contract
      const invDue = invoice.duePaise || 0;
      const creditToInvoice = Math.min(refundPaise, invDue);
      const eligibleRefundPaise = refundPaise - creditToInvoice;

      if (creditToInvoice > 0) {
        const newDue = invDue - creditToInvoice;
        const paymentStatus = newDue === 0 ? 'Paid' : 'PartlyPaid';
        // Note: credit decreases duePaise and increases allocatedCreditPaise, NOT allocatedPaidPaise.
        await col(db, 'invoices').updateOne(
          {_id: invoice._id, tenantId},
          {
            $inc: {
              duePaise: -creditToInvoice,
              allocatedCreditPaise: creditToInvoice,
              version: 1,
            },
            $set: {paymentStatus, updatedAt: now},
          },
          {session}
        );

        await col(db, 'customerAllocations').insertOne(
          {
            _id: uid('CAL'),
            tenantId,
            customerId: invoice.customerId,
            targetType: 'Invoice',
            targetId: invoice._id,
            invoiceId: invoice._id,
            sourceType: 'ReturnCredit',
            sourceId: returnId,
            amountPaise: creditToInvoice,
            allocatedPaise: creditToInvoice,
            isReversal: false,
            effectiveDate: input.date,
            date: input.date,
            createdAt: now,
            createdBy: identity.userId,
          },
          {session}
        );
      }

      if (input.settlement === 'CustomerCredit' && input.refundComponents.length) {
        throw new AppError(400, 'Customer credit cannot include a cash or bank refund.');
      }
      for (const component of input.refundComponents) {
        if ((component.account === 'Cash') !== (component.method === 'Cash')) {
          throw new AppError(400, 'Cash payments use Cash; UPI and bank transfer use Bank.');
        }
      }

      let creditAdvanceId: string | undefined;

      if (input.settlement === 'CustomerCredit') {
        if (eligibleRefundPaise > 0) {
          creditAdvanceId = uid('ADV');
          const advanceNumber = await nextTenantSequence(db, tenantId, 'Advance', year, 'ADV', session);
          await col(db, 'customerAdvances').insertOne(
            {
              _id: creditAdvanceId,
              tenantId,
              advanceNumber,
              customerId: invoice.customerId,
              customerSnapshot: {
                name: customer.name,
                phone: customer.phone,
              },
              sourceType: 'CreditNote',
              sourceId: returnId,
              date: input.date,
              originalAmountPaise: eligibleRefundPaise,
              remainingAmountPaise: eligibleRefundPaise,
              status: 'Available',
              version: 1,
              createdAt: now,
              createdBy: identity.userId,
            },
            {session}
          );
        }
      } else if (input.settlement === 'RefundNow') {
        const totalRefundPaid = sumSalePaise(input.refundComponents.map(c => c.amountPaise));
        if (totalRefundPaid !== eligibleRefundPaise) {
          throw new AppError(
            400,
            `Refund payments (${totalRefundPaid / 100}) must equal eligible cash refund (${eligibleRefundPaise / 100}) after offsetting unpaid due of ${creditToInvoice / 100}.`
          );
        }

        for (const comp of input.refundComponents) {
          const accResult = await col(db, 'tenantAccountBalances').updateOne(
            {
              tenantId,
              account: comp.account,
              balancePaise: {$gte: comp.amountPaise},
            },
            {
              $inc: {balancePaise: -comp.amountPaise, version: 1},
              $set: {updatedAt: now},
            },
            {session}
          );
          if (accResult.matchedCount !== 1) {
            throw new AppError(409, `Insufficient funds in ${comp.account} to pay customer refund.`);
          }

          await col(db, 'accountMovements').insertOne(
            {
              _id: uid('ACM'),
              tenantId,
              account: comp.account,
              date: input.date,
              qty: -comp.amountPaise,
              reason: 'Customer return refund',
              reference: returnNumber,
              sourceType: 'CustomerReturnRefund',
              sourceId: returnId,
              createdAt: now,
              createdBy: identity.userId,
            },
            {session}
          );

          const rfdId = uid('CRF');
          const refundNumber = await nextTenantSequence(db, tenantId, 'Refund', year, 'RFD', session);
          await col(db, 'customerRefunds').insertOne(
            {
              _id: rfdId,
              tenantId,
              refundNumber,
              customerId: invoice.customerId,
              returnId,
              account: comp.account,
              amountPaise: comp.amountPaise,
              refundDate: input.date,
              reason: input.reason || 'Customer return refund',
              isReversed: false,
              createdAt: now,
              createdBy: identity.userId,
            },
            {session}
          );
        }
      }

      // Maintain operational returnedQuantity and creditedReturnPaise projections on invoice & line
      await col(db, 'invoices').updateOne(
        {_id: invoice._id, tenantId, 'lines.lineId': line.lineId},
        {
          $inc: {
            returnedQuantity: input.quantity,
            creditedReturnPaise: refundPaise,
            'lines.$.returnedQuantity': input.quantity,
            'lines.$.creditedReturnPaise': refundPaise,
            version: 1,
          },
          $set: {updatedAt: now},
        },
        {session}
      );

      const returnRecord: CustomerReturnDocument = {
        _id: returnId,
        tenantId,
        returnNumber,
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceNumber || invoice._id,
        invoiceLineId: lineKey,
        customerId: invoice.customerId,
        customerSnapshot: {
          name: customer.name,
          phone: customer.phone,
        },
        productId: line.productId,
        productSnapshot: line.productSnapshot,
        quantity: input.quantity,
        serials: input.serials,
        date: input.date,
        reason: input.reason,
        stockDisposition: input.stockDisposition,
        settlement: input.settlement,
        taxableBasePaise: prorated.taxableBasePaise,
        cgstPaise: prorated.cgstPaise,
        sgstPaise: prorated.sgstPaise,
        igstPaise: prorated.igstPaise,
        taxPaise: prorated.taxPaise,
        refundPaise,
        creditToInvoice,
        eligibleRefundPaise,
        lotRestorations,
        creditAdvanceId,
        createdAt: now,
        createdBy: identity.userId,
      };

      await col<CustomerReturnDocument>(db, 'customerReturns').insertOne(returnRecord, {session});

      // Profit review integration:
      // Before closing: invalidate affected invoice profit review atomically
      // After closing: preserve original profit and create a pending linked current-day adjustment review
      const isOriginalDateClosed = Boolean(
        await col(db, 'dailyClosings').findOne({tenantId, date: invoice.invoiceDate}, {session})
      );

      if (!isOriginalDateClosed) {
        await col(db, 'invoices').updateOne(
          {_id: invoice._id, tenantId},
          {
            $set: {manualProfitPaise: null, profitInvalidatedReason: `Customer return ${returnNumber}`, updatedAt: now},
            $inc: {version: 1},
          },
          {session}
        );
      } else {
        const existingAdj = await col(db, 'manualProfitAdjustments').findOne(
          {tenantId, triggerType: 'CustomerReturn', triggerReference: returnId},
          {session}
        );
        if (!existingAdj) {
          await col(db, 'manualProfitAdjustments').insertOne(
            {
              _id: uid('MPA'),
              tenantId,
              date: input.date,
              originalDocumentType: 'Invoice',
              originalDocumentId: invoice._id,
              originalDocumentNumber: invoice.invoiceNumber || invoice._id,
              triggerType: 'CustomerReturn',
              triggerReference: returnId,
              signedAdjustmentPaise: null,
              status: 'Pending',
              reason: `Customer return ${returnNumber} on closed invoice ${invoice.invoiceNumber || invoice._id}`,
              createdAt: now,
              createdBy: identity.userId,
            },
            {session}
          );
        }
      }

      await recordAudit(db, {
        identity,
        action: 'Create',
        entityType: 'customerReturn',
        entityId: returnId,
        detail: `Return ${returnNumber} of ${refundPaise / 100}`,
        after: {returnNumber, refundPaise, creditToInvoice, eligibleRefundPaise},
      }, session);

      return returnRecord;
    }
  );
}

export async function listCustomerReturns(
  db: Db,
  identity: Identity,
  query: any = {}
) {
  const tenantId = identity.tenantId;
  const filter: Record<string, any> = {tenantId};
  if (query.customerId) filter.customerId = query.customerId;
  if (query.invoiceId) filter.invoiceId = query.invoiceId;
  if (query.productId) filter.productId = query.productId;
  if (query.dateFrom || query.dateTo) {
    filter.date = {
      ...(query.dateFrom && {$gte: query.dateFrom}),
      ...(query.dateTo && {$lte: query.dateTo}),
    };
  }

  const page = Math.max(1, parseInt(query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));

  const [items, total] = await Promise.all([
    col<CustomerReturnDocument>(db, 'customerReturns')
      .find(filter)
      .sort({date: -1, createdAt: -1})
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    col(db, 'customerReturns').countDocuments(filter),
  ]);

  return {items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit))};
}
