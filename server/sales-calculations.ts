import 'server-only';

export type SaleTaxMode = 'Intra-state' | 'Inter-state';
export type SaleDiscountType = 'Percentage' | 'Amount';

export type SaleLineCalculationInput = {
  quantity: number;
  unitRatePaise: number;
  inclusive: boolean;
  taxBasisPoints: number;
  discountType: SaleDiscountType;
  discountValue: number;
};

export type SaleLineCalculation = {
  grossPaise: number;
  discountPaise: number;
  taxableBasePaise: number;
  taxPaise: number;
  totalPaise: number;
};

function assertInteger(name: string, value: number) {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer.`);
}

export function sumSalePaise(values: number[]): number {
  let total = 0n;
  for (const value of values) {
    assertInteger('Amount', value);
    total += BigInt(value);
  }
  const result = Number(total);
  assertInteger('Total', result);
  return result;
}

/** Max intermediate product we allow before BigInt becomes mandatory (2^52). */
const MAX_INTERMEDIATE = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991

/** Round a BigInt division result toward nearest integer (half-up). */
function bigRound(numerator: bigint, denominator: bigint): number {
  const q = numerator / denominator;
  const rem = numerator % denominator;
  // half-up: if 2*rem >= denominator, round up
  const rounded = rem * 2n >= denominator ? q + 1n : q;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new Error('Rounded paise value overflows safe integer range.');
  return result;
}

export function calculateSaleLinePaise(input: SaleLineCalculationInput): SaleLineCalculation {
  assertInteger('quantity', input.quantity);
  assertInteger('unitRatePaise', input.unitRatePaise);
  assertInteger('taxBasisPoints', input.taxBasisPoints);
  assertInteger('discountValue', input.discountValue);
  if (input.quantity < 1 || input.unitRatePaise < 0) throw new Error('Quantity and rate are invalid.');
  if (input.taxBasisPoints < 0 || input.taxBasisPoints > 10000) throw new Error('GST rate is invalid.');
  if (input.discountValue < 0 || !['Percentage', 'Amount'].includes(input.discountType)) throw new Error('Discount is invalid.');

  const grossPaise = input.quantity * input.unitRatePaise;
  assertInteger('grossPaise', grossPaise);

  let discountPaise: number;
  if (input.discountType === 'Percentage') {
    if (input.discountValue > 10000) throw new Error('Percentage discount cannot exceed 100%.');
    // grossPaise * discountValue may overflow if both are very large; use BigInt path when needed.
    const intermediate = grossPaise * input.discountValue;
    if (Math.abs(intermediate) > MAX_INTERMEDIATE) {
      discountPaise = bigRound(BigInt(grossPaise) * BigInt(input.discountValue), 10000n);
    } else {
      discountPaise = Math.round(intermediate / 10000);
    }
  } else {
    discountPaise = input.discountValue;
  }

  if (discountPaise < 0 || discountPaise > grossPaise) throw new Error('Discount cannot exceed the line value.');

  const discountedPaise = grossPaise - discountPaise;

  let taxableBasePaise: number;
  let taxPaise: number;

  if (input.inclusive && input.taxBasisPoints > 0) {
    // taxableBase = discountedPaise * 10000 / (10000 + taxBasisPoints)
    const num = BigInt(discountedPaise) * 10000n;
    const den = BigInt(10000 + input.taxBasisPoints);
    taxableBasePaise = bigRound(num, den);
    taxPaise = discountedPaise - taxableBasePaise;
  } else {
    taxableBasePaise = discountedPaise;
    if (input.taxBasisPoints > 0) {
      // taxPaise = taxableBase * taxBasisPoints / 10000
      const intermediate = taxableBasePaise * input.taxBasisPoints;
      if (Math.abs(intermediate) > MAX_INTERMEDIATE) {
        taxPaise = bigRound(BigInt(taxableBasePaise) * BigInt(input.taxBasisPoints), 10000n);
      } else {
        taxPaise = Math.round(intermediate / 10000);
      }
    } else {
      taxPaise = 0;
    }
  }

  return {
    grossPaise,
    discountPaise,
    taxableBasePaise,
    taxPaise,
    totalPaise: input.inclusive ? discountedPaise : sumSalePaise([taxableBasePaise, taxPaise]),
  };
}

export function splitSaleTax(taxPaise: number, taxMode: SaleTaxMode) {
  assertInteger('taxPaise', taxPaise);
  if (taxPaise < 0 || !['Intra-state', 'Inter-state'].includes(taxMode)) throw new Error('Tax split is invalid.');
  if (taxMode === 'Inter-state') return {cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise};
  const cgstPaise = Math.round(taxPaise / 2);
  return {cgstPaise, sgstPaise: taxPaise - cgstPaise, igstPaise: 0};
}

export function calculateSaleDocumentTotals(lines: Array<SaleLineCalculation & ReturnType<typeof splitSaleTax>>, roundOffPaise = 0) {
  assertInteger('roundOffPaise', roundOffPaise);
  if (Math.abs(roundOffPaise) > 99 || !lines.length) throw new Error('Invalid document rounding or empty document.');
  for (const line of lines) {
    for (const value of Object.values(line).filter(v => typeof v === 'number')) {
      assertInteger('Line value', value);
      if (value < 0) throw new Error('Line values must be non-negative.');
    }
    if (sumSalePaise([line.cgstPaise, line.sgstPaise, line.igstPaise]) !== line.taxPaise || sumSalePaise([line.taxableBasePaise, line.taxPaise]) !== line.totalPaise) throw new Error('Line tax components do not reconcile.');
  }
  const totals = lines.reduce((sum, line) => ({
    grossPaise: sumSalePaise([sum.grossPaise, line.grossPaise]),
    discountPaise: sumSalePaise([sum.discountPaise, line.discountPaise]),
    taxableBasePaise: sumSalePaise([sum.taxableBasePaise, line.taxableBasePaise]),
    taxPaise: sumSalePaise([sum.taxPaise, line.taxPaise]),
    cgstPaise: sumSalePaise([sum.cgstPaise, line.cgstPaise]),
    sgstPaise: sumSalePaise([sum.sgstPaise, line.sgstPaise]),
    igstPaise: sumSalePaise([sum.igstPaise, line.igstPaise]),
    lineTotalPaise: sumSalePaise([sum.lineTotalPaise, line.totalPaise]),
  }), {grossPaise: 0, discountPaise: 0, taxableBasePaise: 0, taxPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, lineTotalPaise: 0});
  const totalPaise = sumSalePaise([totals.lineTotalPaise, roundOffPaise]);
  if (totalPaise < 0) throw new Error('Document total cannot be negative.');
  return {...totals, roundOffPaise, totalPaise};
}

/**
 * Compute the paise credit for a partial return on one invoice line.
 *
 * Uses the cumulative-floor-difference method to guarantee that across
 * any number of partial returns the credited amounts sum to exactly
 * `originalLineTotalPaise` with zero loss or excess:
 *
 *   floor(total * (alreadyReturnedQty + returnQty) / originalQty)
 *   - floor(total * alreadyReturnedQty / originalQty)
 *
 * The last return (when remaining = 0) automatically absorbs any rounding
 * remainder because the cumulative credit reaches exactly originalTotal.
 *
 * @param originalLineTotalPaise   The immutable issued line total.
 * @param originalQuantity         The issued line quantity.
 * @param alreadyReturnedQuantity  Units already returned on this line (from prior return records).
 * @param alreadyCreditedPaise     Sum of paise already credited by prior returns (for over-return guard).
 * @param returnQuantity           Quantity being returned in this operation.
 */
export function prorateSaleReturnPaise(input: {
  originalLineTotalPaise: number;
  originalQuantity: number;
  alreadyReturnedQuantity: number;
  alreadyCreditedPaise: number;
  returnQuantity: number;
}) {
  Object.entries(input).forEach(([key, value]) => assertInteger(key, value));
  const {originalLineTotalPaise, originalQuantity, alreadyReturnedQuantity, alreadyCreditedPaise, returnQuantity} = input;
  if (originalLineTotalPaise < 0 || alreadyCreditedPaise < 0) throw new Error('Return values cannot be negative.');

  if (originalQuantity < 1) throw new Error('originalQuantity must be >= 1.');
  if (alreadyReturnedQuantity < 0 || alreadyReturnedQuantity >= originalQuantity)
    throw new Error('alreadyReturnedQuantity is out of range.');
  if (returnQuantity < 1 || returnQuantity > originalQuantity - alreadyReturnedQuantity)
    throw new Error('Return quantity is invalid or exceeds remaining returnable quantity.');

  const maximumRemaining = originalLineTotalPaise - alreadyCreditedPaise;
  if (maximumRemaining < 0) throw new Error('Existing return credits exceed the original line total.');

  // Cumulative credit BEFORE this return
  const cumBefore = Number(BigInt(originalLineTotalPaise) * BigInt(alreadyReturnedQuantity) / BigInt(originalQuantity));
  if (alreadyCreditedPaise !== cumBefore) throw new Error('Prior return credit does not reconcile with cumulative returned quantity. Reconcile before continuing.');

  // Cumulative credit AFTER this return
  const afterQty = alreadyReturnedQuantity + returnQuantity;
  const cumAfter = afterQty === originalQuantity
    ? originalLineTotalPaise  // final return: absorb remainder
    : Number(BigInt(originalLineTotalPaise) * BigInt(afterQty) / BigInt(originalQuantity));

  const prorated = cumAfter - cumBefore;
  if (prorated > maximumRemaining) throw new Error('Return exceeds remaining credit.');
  return prorated;
}

/** Return totals must be the sum of the credited base and tax components.
 * Independently prorating the grand total can disagree with that sum on a
 * partial return, even when each scalar proration eventually reconciles. */
export function prorateSaleReturnComponents(input: {
  original: {taxableBasePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number};
  alreadyCredited: {taxableBasePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number};
  originalQuantity: number; alreadyReturnedQuantity: number; returnQuantity: number;
}) {
  const keys = ['taxableBasePaise', 'cgstPaise', 'sgstPaise', 'igstPaise'] as const;
  if (sumSalePaise(keys.map(key => input.original[key])) !== input.original.totalPaise) throw new Error('Original return components do not reconcile.');
  const result = {taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0};
  for (const key of keys) result[key] = prorateSaleReturnPaise({originalLineTotalPaise: input.original[key],
    alreadyCreditedPaise: input.alreadyCredited[key], originalQuantity: input.originalQuantity,
    alreadyReturnedQuantity: input.alreadyReturnedQuantity, returnQuantity: input.returnQuantity});
  const taxPaise = sumSalePaise([result.cgstPaise, result.sgstPaise, result.igstPaise]);
  return {...result, taxPaise, totalPaise: sumSalePaise([result.taxableBasePaise, taxPaise])};
}
