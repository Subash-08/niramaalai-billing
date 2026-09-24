// Run npm run test:core. Compile the real implementation with the installed compiler.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {CreateInvoiceDraftSchema} = require('../.billing-test/server/sales-schema.js');
const {calculateSaleLinePaise} = require('../.billing-test/server/sales-calculations.js');
const {mapInvoiceFromApi} = require('../.billing-test/lib/mappers.js');
const {totals} = require('../.billing-test/lib/domain.js');
const dbModule = require('../.billing-test/server/db.js');
const {createPrintJob, updatePrintJob} = require('../.billing-test/server/print-job-service.js');

const common = {description:'Print item', clientLineKey:'one', quantity:2, unitRatePaise:11800, discountType:'Percentage', discountValue:1000, taxBasisPoints:1800};
test('mixed invoice keeps product stock allocation and non-stock service details', () => {
  const result = CreateInvoiceDraftSchema.parse({idempotencyKey:'new',customerId:'c',invoiceKind:'Sale',businessCategory:'NewGoods',invoiceDate:'2026-09-24',inclusive:true,taxMode:'Intra-state',placeOfSupply:'Tamil Nadu',templateId:'t',templateRevision:1,lines:[
    {...common,lineType:'Product',productId:'p',hsn:'4901',stockAllocations:[{lotId:'lot',quantity:2}]},
    {...common,clientLineKey:'two',lineType:'Service',serviceId:'s',sac:'9989',details:'Two-sided cards',unit:'Set',printSpecifications:{gsm:'300',sides:'Both'}},
  ]});
  assert.equal(result.lines[0].stockAllocations[0].quantity,2);
  assert.equal(result.lines[1].unit,'Set');
  assert.equal(result.lines[1].printSpecifications.gsm,'300');
  assert.equal(result.lines[1].stockAllocations,undefined);
});
for (const discountType of ['Percentage','Amount']) test(`${discountType} discount round-trips without multiplying by 100`,()=>{
  const input = {...common,discountType,inclusive:true};
  const expected = calculateSaleLinePaise(input);
  const mapped = mapInvoiceFromApi({invoiceDate:'2026-09-24',inclusive:true,lines:[{...input,lineType:'Service',sac:'9989',serviceId:'s',details:'Design description',unit:'Job',printSpecifications:{size:'A4'}}],issuedSnapshot:{seller:{name:'Original seller'},template:{name:'Original template'}}});
  assert.equal(Math.round(totals(mapped).total*100),expected.totalPaise);
  assert.equal(mapped.lines[0].discount,10);
  assert.equal(mapped.lines[0].hsn,'9989');
  assert.equal(mapped.lines[0].serviceId,'s');
  assert.equal(mapped.shopSnapshot.name,'Original seller');
  assert.equal(mapped.templateSnapshot.name,'Original template');
});

const identity={tenantId:'tenant-a',userId:'user-a'};
const jobInput={customerId:'customer-a',title:'Cards',description:'Printed cards',quantity:100,unit:'Piece',dueDate:'2026-09-30',specifications:{gsm:'300'},notes:''};
function fixture({customer=true,job=null,auditFails=false}={}) {
  const state={counter:0,jobs:[],audits:[],job};
  const session={async withTransaction(fn){const before=structuredClone(state);try{return await fn();}catch(error){Object.assign(state,before);throw error;}},async endSession(){}};
  dbModule.mongo=async()=>({startSession:()=>session});
  const db={collection(name){return {
    async findOne(filter){
      if(name==='customers')return customer&&filter.tenantId===identity.tenantId&&filter._id==='customer-a'?{_id:'customer-a'}:null;
      if(name==='printJobs')return state.job&&filter.tenantId===state.job.tenantId&&filter._id===state.job._id?state.job:null;
      return null;
    },
    async findOneAndUpdate(filter,update,opts){assert.equal(opts.session,session);if(name==='tenantCounters')return {currentValue:++state.counter};if(name==='printJobs'){state.job={...state.job,...update.$set,version:state.job.version+1};return state.job;}},
    async insertOne(record,opts){assert.equal(opts.session,session);if(name==='auditHistory'){if(auditFails)throw Error('Audit unavailable');state.audits.push(record);}if(name==='printJobs')state.jobs.push(record);},
  };}};
  return {db,state};
}
test('print jobs use separate atomic sequence numbers and audit writes',async()=>{
  const {db,state}=fixture();
  const a=await createPrintJob(db,identity,jobInput),b=await createPrintJob(db,identity,jobInput);
  assert.equal(a.jobNumber,'JOB-00001');assert.equal(b.jobNumber,'JOB-00002');assert.notEqual(a._id,b._id);assert.equal(state.audits.length,2);
});
test('failed audit rolls back print job and counter',async()=>{
  const {db,state}=fixture({auditFails:true});await assert.rejects(createPrintJob(db,identity,jobInput),/Audit unavailable/);assert.equal(state.counter,0);assert.equal(state.jobs.length,0);
});
test('foreign customer cannot create a print job',async()=>{
  const {db,state}=fixture({customer:false});await assert.rejects(createPrintJob(db,identity,jobInput),/Customer not found/);assert.equal(state.counter,0);
});
test('foreign job and stale versions cannot be updated',async()=>{
  const foreign=fixture({job:{_id:'job',tenantId:'tenant-b',version:1}});
  await assert.rejects(updatePrintJob(foreign.db,identity,'job',{...jobInput,status:'Designing',expectedVersion:1}),/not found/);
  const stale=fixture({job:{_id:'job',tenantId:'tenant-a',version:2}});
  await assert.rejects(updatePrintJob(stale.db,identity,'job',{...jobInput,status:'Designing',expectedVersion:1}),/changed/);
});
test('issued invoice links cannot be cleared or reassigned by editing print job',async()=>{
  const {db}=fixture({job:{_id:'job',tenantId:'tenant-a',version:1,invoiceId:'invoice-a'}});
  await assert.rejects(updatePrintJob(db,identity,'job',{...jobInput,status:'Ready',invoiceId:'',expectedVersion:1}),/Invoice links/);
});
