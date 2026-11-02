'use client';
import {useState} from 'react';
import {Plus,Pencil,Trash2} from 'lucide-react';
import {ServiceItem} from '@/lib/extensions';
import {uid,money} from '@/lib/domain';
import {useStore} from './store';
import {PageHead,Card,SearchBox,Btn,Modal,Field,Badge,Empty} from './ui';

const serviceCategories=['Digital printing','Offset printing','Designing','Branding','Cards & invitations','Books & brochures','Labels & stickers','Banners & signage','Finishing','Other'];
const units=['Piece','Sheet','Page','Set','Book','Box','Square foot','Roll','Pack','Job'];
const gstRates=[5,12,18,28];

export default function ServiceCatalog(){
  const {state,setState,notify,isLive,saveServiceApi,archiveServiceApi}=useStore();
  const [q,setQ]=useState('');
  const [form,setForm]=useState<ServiceItem|null>(null);
  const [saving,setSaving]=useState(false);
  const list=state.serviceCatalog.filter(service=>(service.name+service.category+service.description).toLowerCase().includes(q.toLowerCase()));
  const close=()=>setForm(null);
  return <>
    <PageHead title="Service catalogue" description="Save print and design services with their descriptions, units, rates and GST details." actions={<Btn onClick={()=>setForm({id:uid('SRV'),name:'',category:'Digital printing',description:'',unit:'Job',rate:0,tax:18,sac:'998912',warranty:0,active:true})}><Plus size={16}/>Add service</Btn>}/>
    <Card>
      <div className="toolbar"><SearchBox value={q} onChange={setQ} placeholder="Search services…"/></div>
      <div className="table-wrap"><table><thead><tr><th>Service</th><th>Category</th><th>Unit</th><th>Rate incl. GST</th><th>GST / SAC</th><th>Status</th><th/></tr></thead><tbody>
        {list.map(service=><tr key={service.id}><td>{service.name}<small>{service.description}</small></td><td>{service.category}</td><td>{service.unit||'Job'}</td><td>{money(service.rate)}</td><td>{service.tax}%<small>{service.sac}</small></td><td><Badge>{service.active?'Active':'Inactive'}</Badge></td><td><div className="action-cell"><button className="icon-btn" aria-label={`Edit ${service.name}`} onClick={()=>setForm({...service,tax:gstRates.includes(service.tax)?service.tax:18})}><Pencil size={16}/></button><button className="icon-btn" aria-label={`Archive ${service.name}`} onClick={async()=>{if(confirm(`Archive service "${service.name}"?`)){if(isLive)await archiveServiceApi(service.id);else{setState(current=>({...current,serviceCatalog:current.serviceCatalog.filter(item=>item.id!==service.id)}));notify('Service removed.');}}}}><Trash2 size={16}/></button></div></td></tr>)}
      </tbody></table></div>
      {!list.length&&<Empty/>}
    </Card>
    {form&&<Modal title="Service details" onClose={close}><form onSubmit={async event=>{event.preventDefault();setSaving(true);try{if(isLive){const existing=state.serviceCatalog.some(item=>item.id===form.id);if(await saveServiceApi(form,existing?form.id:undefined))close();}else{setState(current=>({...current,serviceCatalog:current.serviceCatalog.some(item=>item.id===form.id)?current.serviceCatalog.map(item=>item.id===form.id?form:item):[...current.serviceCatalog,form]}));notify('Service saved. It is now available in invoice forms.');close();}}finally{setSaving(false);}}}>
      <div className="form-body form-grid">
        <Field label="Service name"><input required value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/></Field>
        <Field label="Category"><select value={form.category} onChange={event=>setForm({...form,category:event.target.value})}>{serviceCategories.map(category=><option key={category}>{category}</option>)}</select></Field>
        <Field label="Billing unit"><select value={form.unit||'Job'} onChange={event=>setForm({...form,unit:event.target.value})}>{units.map(unit=><option key={unit}>{unit}</option>)}</select></Field>
        <Field label="Standard rate including tax"><input required type="number" min="0" step="0.01" value={form.rate} onChange={event=>setForm({...form,rate:+event.target.value})}/></Field>
        <Field label="GST rate %"><select value={form.tax} onChange={event=>setForm({...form,tax:+event.target.value})}>{gstRates.map(rate=><option key={rate} value={rate}>{rate}%</option>)}</select></Field>
        <Field label="SAC"><input value={form.sac} onChange={event=>setForm({...form,sac:event.target.value})}/></Field>
        <div className="full"><Field label="Service description"><textarea required value={form.description} onChange={event=>setForm({...form,description:event.target.value})} placeholder="Describe the printing, design, material or finishing work"/></Field></div>
        <label className="check-row"><input type="checkbox" checked={form.active} onChange={event=>setForm({...form,active:event.target.checked})}/>Available for billing</label>
      </div>
      <div className="form-actions"><Btn secondary onClick={close}>Cancel</Btn><Btn disabled={saving} type="submit">{saving?'Saving…':'Save service'}</Btn></div>
    </form></Modal>}
  </>;
}
