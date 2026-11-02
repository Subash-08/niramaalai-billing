/**
 * One definition of GST versus Non-GST for lists, reports and exports.
 * An invoice is Non-GST only when it has at least one line and every line is
 * explicitly marked NonGST. Empty or legacy/mixed invoices stay in GST so
 * they cannot silently enter the Non-GST register.
 */
export const nonGstInvoiceExpression = {
  $and: [
    {$gt: [{$size: {$ifNull: ['$lines', []]}}, 0]},
    {
      $eq: [
        {
          $size: {
            $filter: {
              input: {$ifNull: ['$lines', []]},
              as: 'line',
              cond: {$eq: ['$$line.taxTreatment', 'NonGST']},
            },
          },
        },
        {$size: {$ifNull: ['$lines', []]}},
      ],
    },
  ],
};

export function invoiceTaxTypeQuery(taxType: string | undefined): Record<string, unknown> {
  if (taxType === 'NonGST') return {$expr: nonGstInvoiceExpression};
  if (taxType === 'GST') return {$expr: {$not: [nonGstInvoiceExpression]}};
  return {};
}

export function isNonGstInvoiceLines(lines: Array<{taxTreatment?: string}> | undefined): boolean {
  return !!lines?.length && lines.every(line => line.taxTreatment === 'NonGST');
}
