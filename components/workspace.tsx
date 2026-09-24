'use client';
import {usePathname,useSearchParams} from 'next/navigation';
import Dashboard from './dashboard';
import People from './people';
import Inventory from './inventory';
import Documents,{DocumentComposer} from './documents';
import Reports from './reports';
import Settings from './settings';
import AccountAccess from './account-access';
import Templates from './templates';
import ServiceCatalog from './service-catalog';
import PrintJobs from './print-jobs';
import Payments from './payments';
import {Empty} from './ui';
import Link from 'next/link';
import {useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {useStore} from './store';

export default function Workspace(){
  const path=usePathname();
  const query=useSearchParams();
  const routeKey=path+query.toString();
  const router=useRouter();
  const {isLive,isLoading}=useStore();

  useEffect(()=>{
    const ctx=(document as Document&{modelContext?:{registerTool:(t:unknown,o:unknown)=>unknown}}).modelContext;
    if(!ctx?.registerTool)return;
    const controller=new AbortController();
    try{
      Promise.resolve(ctx.registerTool({
        name:'start_new_invoice',
        description:'Navigate to the new invoice form. Does not issue an invoice or alter balances.',
        inputSchema:{type:'object',properties:{},additionalProperties:false},
        execute:(input:unknown)=>{
          if(!input||typeof input!=='object'||Object.keys(input).length)throw new Error('Expected an empty object.');
          router.push('/sales/new');
          return {status:'navigating',path:'/sales/new'};
        }
      },{signal:controller.signal})).catch(()=>{});
    }catch{}
    return()=>controller.abort();
  },[router]);

  const [section,id]=path.split('/').filter(Boolean);
  if(isLoading)return <div className="empty">Loading your company account…</div>;
  if(!isLive&&section!=='account')return <AccountAccess/>;
  if(!section)return <Dashboard/>;
  switch(section){
    case 'account':return <AccountAccess/>;
    case 'customers':return <People id={id}/>;
    case 'inventory':case 'products':return <Inventory id={id}/>;
    case 'payments':return <Payments id={id}/>;
    case 'sales':return id==='new'?<DocumentComposer key={routeKey}/>:<Documents id={id}/>;
    case 'templates':return <Templates/>;
    case 'service-catalog':return <ServiceCatalog/>;
    case 'print-jobs':return <PrintJobs/>;
    case 'reports':return <Reports/>;
    case 'settings':return <Settings/>;
    default:return <Empty title="Page not found" action={<Link href="/">Go to dashboard</Link>}/>;
  }
}
