'use client';
import {useState} from 'react';
import {Card} from './ui';
import {money} from '@/lib/domain';

export default function LiveSalesChart({rows, today}: {rows: {date: string; salesPaise: number; count: number}[]; today: string}) {
  const [days, setDays] = useState(30);
  const [type, setType] = useState('Bar');
  const dates = Array.from({length: days}, (_, i) => new Date(Date.parse(today + 'T00:00:00Z') - (days - i - 1) * 86400000).toISOString().slice(0, 10));
  const values = dates.map(date => ({date, amount: rows.find(r => r.date === date)?.salesPaise || 0}));
  const max = Math.max(1, ...values.map(r => r.amount));
  const points = values.map((r, i) => `${35 + i * 700 / (days - 1)},${205 - r.amount / max * 165}`).join(' ');
  return <Card title="Sales trend" sub="Issued invoice value including tax. Collections and return credits are separate measures.">
    <div className="toolbar"><select aria-label="Sales chart period" value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select><select aria-label="Chart type" value={type} onChange={e => setType(e.target.value)}><option>Bar</option><option>Line</option><option>Area</option></select><strong>{money(values.reduce((n, r) => n + r.amount, 0) / 100)}</strong></div>
    <svg viewBox="0 0 780 245" role="img" aria-label="Live issued sales by business date" style={{width:'100%', maxHeight:300}}>
      <line x1="25" x2="750" y1="205" y2="205" stroke="#94a3b8"/>
      {type === 'Bar' ? values.map((r,i) => <rect key={r.date} x={30 + i * 715 / days} y={205 - r.amount / max * 165} width={Math.max(4, 715 / days - 5)} height={r.amount / max * 165} fill="#6246e5" rx="3"><title>{r.date}: {money(r.amount / 100)}</title></rect>) : <>{type === 'Area' && <polygon points={`35,205 ${points} 735,205`} fill="#ddd6fe"/>}<polyline points={points} fill="none" stroke="#6246e5" strokeWidth="3"/>{values.map((r,i) => <circle key={r.date} cx={35 + i * 700 / (days - 1)} cy={205 - r.amount / max * 165} r="3" fill="#6246e5"><title>{r.date}: {money(r.amount / 100)}</title></circle>)}</>}
      <text x="30" y="230" fontSize="12">{dates[0]}</text><text x="735" y="230" fontSize="12" textAnchor="end">{today}</text>
    </svg>
  </Card>;
}
