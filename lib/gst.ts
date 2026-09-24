/** Shared UI arithmetic. Amount discounts apply to the whole line before tax. */
export function roundMoney(value:number){return Math.round((value+Number.EPSILON)*100)/100;}
export type GstInput={qty:number;rate:number;tax:number;discount:number;discountType?:'Percentage'|'Amount';taxTreatment?:'Taxable'|'Exempt'|'NonGST'};
export function calculateGst(l:GstInput,inclusive:boolean,taxMode:'Intra-state'|'Inter-state'='Intra-state'){
 const gross=l.qty*l.rate;
 const discount=l.discountType==='Amount'?l.discount:gross*l.discount/100;
 const discounted=roundMoney(gross-discount);
 const taxRate=(l.taxTreatment==='Exempt'||l.taxTreatment==='NonGST')?0:l.tax;
 const base=roundMoney((inclusive&&taxRate>0)?discounted/(1+taxRate/100):discounted);
 const tax=roundMoney((inclusive&&taxRate>0)?discounted-base:base*taxRate/100);
 const total=roundMoney(inclusive?discounted:base+tax);
 const igst=taxMode==='Inter-state'?tax:0;const cgst=igst?0:roundMoney(tax/2),sgst=igst?0:roundMoney(tax-cgst);
 return {base,tax,total,cgst,sgst,igst,discount:roundMoney(discount)};
}
