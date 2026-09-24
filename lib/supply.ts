import {State,Line,Bill} from './domain';
import {purchaseLineBalances} from './settlement';
export function supplyReferences(s:State,l:Line){if(!l.productId)return [];return s.purchases.filter(p=>p.status==='Received'&&p.lines.some(x=>x.productId===l.productId&&(l.purchaseId?p.id===l.purchaseId:l.serials.length>0&&l.serials.some(n=>x.serials.includes(n)))));}
export function supplyStatus(s:State,l:Line){return supplyReferences(s,l).map(p=>{const row=purchaseLineBalances(s,p).find(x=>x.productId===l.productId)!;return {id:p.id,supplierId:p.supplierId,productId:l.productId,due:row.due,status:row.due===0?'Paid':row.paid>0?'Partly paid':'Unpaid'};});}
