'use client';
import {useCallback, useEffect, useState} from 'react';
import Link from 'next/link';
import {CalendarClock} from 'lucide-react';
import {PageHead, Card, Btn, Empty, Badge} from './ui';
import {money} from '@/lib/domain';
import {useStore} from './store';

export default function CustomerDues(){
  const {isLive, notify} = useStore();
  const [rows,setRows]=useState<any[]>([]),[loading,setLoading]=useState(true);
  const load=useCallback(async()=>{
    if(!isLive)return;
    setLoading(true);
    try{
      const response=await fetch('/api/sales/invoices?status=Unpaid&hasDue=true&limit=100');
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'Failed to load customer dues.');
      setRows(data.items||data.records||data.invoices||[]);
    }catch(error){notify(error instanceof Error?error.message:'Failed to load customer dues.');}
    finally{setLoading(false);}
  },[isLive,notify]);
  useEffect(()=>{void load();},[load]);
  const today=new Date().toISOString().slice(0,10);
  return <>
    <PageHead title="Customer dues" description="Outstanding invoices, payment reminders and quick payment actions."/>
    <Card>
      {loading?<div className="body-pad">Loading customer dues…</div>:!rows.length?<Empty title="No customer dues" text="Paid invoices disappear from this page automatically."/>:
      <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Invoice date</th><th>Next due date</th><th>Outstanding</th><th>Reminder</th><th/></tr></thead><tbody>
        {rows.map(row=>{
          const id=row._id||row.id; const number=row.invoiceNumber||row.publicId||id;
          const dueDate=row.promisedPaymentDate||row.dueDate||'';
          const duePaise=row.duePaise??row.remainingDuePaise??Math.max(0,(row.totalPaise||0)-(row.paidPaise||0));
          const dismissed=!!row.dueReminderDismissed;
          return <tr key={id}><td><Link className="text-link" href={`/sales/${id}`}>{number}</Link></td><td>{row.customerSnapshot?.name||row.customerName||'Customer'}</td><td>{row.invoiceDate||row.date}</td><td>{dueDate||'Not set'}</td><td><strong>{money(duePaise/100)}</strong></td><td>{dismissed?<Badge>Dismissed</Badge>:dueDate&&dueDate<today?<Badge>Overdue</Badge>:dueDate?<Badge>Scheduled</Badge>:<span className="muted">No reminder</span>}</td><td><div className="action-cell"><Link className="btn secondary" href={`/payments?invoiceId=${encodeURIComponent(id)}&customerId=${encodeURIComponent(row.customerId||'')}`}>Record payment</Link>{dueDate&&<Btn secondary onClick={async()=>{const response=await fetch(`/api/sales/invoices/${encodeURIComponent(id)}/reminder`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({dismissed:!dismissed})});if(response.ok){window.dispatchEvent(new Event('billing-data-changed'));void load();}else notify('Could not update reminder.');}}>{dismissed?'Restore':'Clear reminder'}</Btn>}</div></td></tr>
        })}
      </tbody></table></div>}
    </Card>
  </>;
}
