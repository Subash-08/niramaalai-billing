'use client';
import {useCallback,useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {Plus,RefreshCw,Truck} from 'lucide-react';
import {useStore} from './store';
import {PageHead,Card,Btn,Field,Modal,SearchBox,Badge,Empty} from './ui';
import {TODAY,uid,dateLabel} from '@/lib/domain';
import SearchSelect from './search-select';
import DeliveryChallanModal from './delivery-challan-modal';

type PrintJob={_id:string;jobNumber:string;customerId:string;title:string;description:string;quantity:number;unit:string;dueDate:string;status:string;specifications:Record<string,string>;notes:string;invoiceId?:string;version:number};
const statuses=['Received','Designing','AwaitingApproval','Approved','Printing','Finishing','Ready','Delivered','Cancelled'];
const units=['Piece','Sheet','Page','Set','Book','Box','Square foot','Roll','Pack','Job'];
const empty=(customerId=''):PrintJob=>({_id:uid('JOB'),jobNumber:'New',customerId,title:'',description:'',quantity:1,unit:'Job',dueDate:TODAY,status:'Received',specifications:{size:'',material:'',gsm:'',colour:'',sides:'',finishing:''},notes:'',version:1});

export default function PrintJobs(){
  const {state,isLive,notify}=useStore();
  const [records,setRecords]=useState<PrintJob[]>([]),[q,setQ]=useState(''),[status,setStatus]=useState('All'),[form,setForm]=useState<PrintJob|null>(null),[busy,setBusy]=useState(false);
  const [challanJob, setChallanJob] = useState<PrintJob | null>(null);

  const load=useCallback(async()=>{if(!isLive)return;setBusy(true);try{const p=new URLSearchParams();if(q)p.set('q',q);if(status!=='All')p.set('status',status);const res=await fetch(`/api/print-jobs?${p}`);const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not load print jobs.');setRecords(data.records||[]);}catch(e){notify(e instanceof Error?e.message:'Could not load print jobs.');}finally{setBusy(false);}},[isLive,q,status,notify]);
  useEffect(()=>{const timer=setTimeout(load,200);return()=>clearTimeout(timer);},[load]);
  const visible=useMemo(()=>isLive?records:records.filter(j=>(j.title+j.description).toLowerCase().includes(q.toLowerCase())&&(status==='All'||j.status===status)),[isLive,records,q,status]);

  async function save(){if(!form)return;if(!form.customerId||!form.title.trim()){notify('Choose a customer and enter a job title.');return;}setBusy(true);try{if(!isLive){setRecords(r=>r.some(x=>x._id===form._id)?r.map(x=>x._id===form._id?form:x):[{...form,jobNumber:`JOB-${String(r.length+1).padStart(5,'0')}`},...r]);setForm(null);notify('Print job saved in demo workspace.');return;}const existing=records.some(x=>x._id===form._id);const res=await fetch(existing?`/api/print-jobs/${form._id}`:'/api/print-jobs',{method:existing?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(existing?{customerId:form.customerId,title:form.title,description:form.description,quantity:form.quantity,unit:form.unit,dueDate:form.dueDate,status:form.status,specifications:form.specifications,notes:form.notes,invoiceId:form.invoiceId||'',expectedVersion:form.version}:{customerId:form.customerId,title:form.title,description:form.description,quantity:form.quantity,unit:form.unit,dueDate:form.dueDate,specifications:form.specifications,notes:form.notes})});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not save print job.');setForm(null);notify('Print job saved.');await load();}catch(e){notify(e instanceof Error?e.message:'Could not save print job.');}finally{setBusy(false);}}

  return <>
    <PageHead title="Print jobs" description="Track customer work from receipt through designing, printing, finishing and delivery." actions={<Btn onClick={()=>setForm(empty(state.customers[0]?.id||''))}><Plus size={16}/>New print job</Btn>}/>
    <Card>
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search jobs…"/>
        <select value={status} onChange={e=>setStatus(e.target.value)}>
          <option>All</option>
          {statuses.map(s=><option key={s}>{s}</option>)}
        </select>
        <Btn secondary onClick={load}><RefreshCw size={15}/>Refresh</Btn>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Customer</th>
              <th>Quantity</th>
              <th>Due</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(j=>(
              <tr key={j._id}>
                <td>
                  <strong>{j.jobNumber}</strong>
                  <small>{j.title}</small>
                  <small>{j.description}</small>
                </td>
                <td>{state.customers.find(c=>c.id===j.customerId)?.name||'Customer'}</td>
                <td>{j.quantity} {j.unit}</td>
                <td>{dateLabel(j.dueDate)}</td>
                <td><Badge>{j.status}</Badge></td>
                <td>
                  <div className="action-cell">
                    <Btn secondary onClick={()=>setForm({...j,specifications:{...j.specifications}})}>Edit</Btn>
                    <button type="button" className="btn secondary" onClick={()=>setChallanJob(j)} title="Delivery Challan">
                      <Truck size={13} style={{marginRight: '3px'}}/> Challan
                    </button>
                    {j.invoiceId ? (
                      <Link className="btn secondary" href={`/sales/${encodeURIComponent(j.invoiceId)}`}>View invoice</Link>
                    ) : (
                      <Link className="btn secondary" href={`/sales/new?customer=${encodeURIComponent(j.customerId)}&printJob=${encodeURIComponent(j._id)}`}>Create invoice</Link>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!visible.length&&<Empty title={busy?'Loading print jobs…':'No print jobs found'}/>}
    </Card>

    {form&&<Modal title={form.jobNumber==='New'?'New print job':form.jobNumber} onClose={()=>setForm(null)} wide>
      <div className="form-body form-grid">
        <div className="full">
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Customer <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
          </label>
          <SearchSelect
            placeholder="Search customer by name, phone, GST..."
            value={form.customerId}
            options={state.customers.map(c=>({value: c.id, label: c.name, sublabel: `${c.phone}${c.gst ? ` · GST: ${c.gst}` : ''}`}))}
            onSearch={async (query, signal) => {
              if (!isLive) {
                const qLower = query.toLowerCase();
                return state.customers
                  .filter(c => c.name.toLowerCase().includes(qLower) || c.phone.includes(qLower) || (c.gst && c.gst.toLowerCase().includes(qLower)))
                  .map(c => ({value: c.id, label: c.name, sublabel: `${c.phone}${c.gst ? ` · GST: ${c.gst}` : ''}`}));
              }
              const res = await fetch(`/api/master/customers?q=${encodeURIComponent(query)}&limit=30`, {signal});
              if (!res.ok) return [];
              const data = await res.json();
              return (data.records || []).map((c: any) => ({
                value: c._id || c.id,
                label: c.name,
                sublabel: `${c.phone}${c.gst ? ` · GST: ${c.gst}` : ''}`,
              }));
            }}
            onChange={(val)=>setForm({...form, customerId: val})}
          />
        </div>
        <Field label="Job title"><input required value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></Field>
        <div className="full"><Field label="Description"><textarea required value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></Field></div>
        <Field label="Quantity"><input type="number" min="1" value={form.quantity} onChange={e=>setForm({...form,quantity:+e.target.value})}/></Field>
        <Field label="Unit"><select value={form.unit} onChange={e=>setForm({...form,unit:e.target.value})}>{units.map(u=><option key={u}>{u}</option>)}</select></Field>
        <Field label="Due date"><input type="date" value={form.dueDate} onChange={e=>setForm({...form,dueDate:e.target.value})}/></Field>
        {form.jobNumber!=='New'&&<Field label="Status"><select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>{statuses.map(s=><option key={s}>{s}</option>)}</select></Field>}
        {[['size','Size'],['material','Paper / material'],['gsm','GSM'],['colour','Colour'],['sides','Printing sides'],['finishing','Finishing']].map(([key,label])=><Field key={key} label={label}><input value={form.specifications?.[key]||''} onChange={e=>setForm({...form,specifications:{...form.specifications,[key]:e.target.value}})}/></Field>)}
        <div className="full"><Field label="Internal notes"><textarea value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></Field></div>
      </div>
      <div className="form-actions"><Btn secondary onClick={()=>setForm(null)}>Cancel</Btn><Btn disabled={busy} onClick={save}>{busy?'Saving…':'Save job'}</Btn></div>
    </Modal>}

    {challanJob && (
      <DeliveryChallanModal
        docData={{
          ...challanJob,
          jobNumber: challanJob.jobNumber,
          date: challanJob.dueDate,
          title: challanJob.title,
          description: challanJob.description,
          quantity: challanJob.quantity,
          unit: challanJob.unit,
          specifications: challanJob.specifications,
          notes: challanJob.notes,
        }}
        onClose={() => setChallanJob(null)}
      />
    )}
  </>;
}
