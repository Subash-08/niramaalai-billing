'use client';
import {ReactNode,useEffect,useRef} from 'react';
import {X,Search,Inbox,ArrowUpRight} from 'lucide-react';
export function Badge({children}:{children:ReactNode}){const s=String(children);const good=/Paid|Issued|Received|Active|Delivered|Won|Repaired|Closed|Ready|Completed|Settled/.test(s);const bad=/Overdue|Expired|Cancelled|Rejected|Low|Out of stock/.test(s);return <span className={`badge ${good?'green':bad?'red':'amber'}`}>{children}</span>;}
export function Btn({children,onClick,secondary=false,danger=false,disabled=false,type='button',className='',style}:{children:ReactNode;onClick?:()=>void;secondary?:boolean;danger?:boolean;disabled?:boolean;type?:'button'|'submit';className?:string;style?:import('react').CSSProperties}){return <button type={type} disabled={disabled} onClick={onClick} style={style} className={`btn ${secondary?'secondary':''} ${danger?'danger':''} ${className}`}>{children}</button>;}
export function PageHead({title,description,actions}:{title:string;description:string;actions?:ReactNode}){return <div className="page-head"><div><div className="eyebrow">PRINT BILLING</div><h1>{title}</h1><p>{description}</p></div><div className="actions">{actions}</div></div>;}
export function Card({title,sub,actions,children,className=''}:{title?:string;sub?:string;actions?:ReactNode;children:ReactNode;className?:string}){return <section className={`card ${className}`}>{title&&<div className="card-head"><div><h2>{title}</h2>{sub&&<p>{sub}</p>}</div>{actions}</div>}{children}</section>;}
export function Stat({label,value,detail,icon,accent='purple'}:{label:string;value:ReactNode;detail:string;icon:ReactNode;accent?:string}){return <div className="stat"><div className="stat-top"><span>{label}</span><div className={`stat-icon ${accent}`}>{icon}</div></div><strong>{value}</strong><div className="stat-bottom">{detail}<ArrowUpRight size={15}/></div></div>;}
export function Field({label,children,hint}:{label:string;children:ReactNode;hint?:string}){return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>;}
export function SearchBox({value,onChange,placeholder='Search…'}:{value:string;onChange:(v:string)=>void;placeholder?:string}){return <div className="search-field"><Search size={17}/><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)}/></div>;}
export function Empty({title='No records found',text='Try another search or add your first record.',action}:{title?:string;text?:string;action?:ReactNode}){return <div className="empty"><Inbox size={36}/><h3>{title}</h3><p>{text}</p>{action}</div>;}
export function Modal({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}){const ref=useRef<HTMLDivElement>(null);const closeRef=useRef(onClose);closeRef.current=onClose;useEffect(()=>{const previous=document.activeElement as HTMLElement;const el=ref.current;el?.querySelector<HTMLElement>('input,select,button,textarea')?.focus();const handler=(e:KeyboardEvent)=>{if(e.key==='Escape')closeRef.current();if(e.key==='Tab'){const list=el?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]');if(!list?.length)return;const first=list[0],last=list[list.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};document.addEventListener('keydown',handler);const old=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',handler);document.body.style.overflow=old;previous?.focus();};},[]);return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={ref} className={`modal ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div>{children}</div></div>;}
export function sanitizeCell(v: string | number): string {
  if (typeof v === 'number') return String(v);
  const s = String(v ?? '');
  if (/^-?\d+(\.\d+)?$/.test(s.trim())) return s;
  if (/^[=+@-]/.test(s)) return "'" + s;
  return s;
}
export function csvDownload(name: string, rows: (string | number)[][]) {
  const content = rows
    .map((r) => r.map((v) => `"${sanitizeCell(v).replaceAll('"', '""')}"`).join(','))
    .join('\r\n');
  download(name, new Blob(['\ufeff' + content], {type: 'text/csv;charset=utf-8'}));
}
export function download(name:string,blob:Blob){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
