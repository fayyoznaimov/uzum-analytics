"use client";
import { useEffect, useRef, useState } from 'react';
import { CalendarRange, Check, ChevronDown } from 'lucide-react';
import { AnalyticsPeriod, PeriodPreset, formatPeriod, periodLabels, resolvePreset, useAnalyticsPeriod } from '@/lib/period';

const presets:PeriodPreset[]=['TODAY','YESTERDAY','LAST_7','LAST_15','THIS_WEEK','PREV_WEEK','LAST_30','THIS_MONTH','PREV_MONTH','CUSTOM'];

export default function PeriodPicker(){
 const {period,setPeriod}=useAnalyticsPeriod();
 const [open,setOpen]=useState(false);const [draft,setDraft]=useState<AnalyticsPeriod>(period);const box=useRef<HTMLDivElement>(null);
 useEffect(()=>setDraft(period),[period]);
 useEffect(()=>{const close=(e:MouseEvent)=>{if(box.current&&!box.current.contains(e.target as Node))setOpen(false)};document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close)},[]);
 function choose(preset:PeriodPreset){if(preset==='CUSTOM'){setDraft(v=>({...v,preset}));return;}const next={...resolvePreset(preset),compare:draft.compare};setDraft(next);setPeriod(next);setOpen(false)}
 function apply(){setPeriod({...draft,preset:'CUSTOM'});setOpen(false)}
 return <div className="period-picker" ref={box}>
  <button className="period-trigger" onClick={()=>setOpen(v=>!v)}><CalendarRange size={16}/><span><small>ПЕРИОД</small><b>{formatPeriod(period)}</b></span><ChevronDown size={15}/></button>
  {open&&<div className="period-popover">
    <div className="period-presets">{presets.map(p=><button key={p} className={draft.preset===p?'selected':''} onClick={()=>choose(p)}>{periodLabels[p]}{draft.preset===p&&<Check size={14}/>}</button>)}</div>
    <div className="period-custom"><label>С<input type="date" value={draft.from} onChange={e=>setDraft({...draft,from:e.target.value,preset:'CUSTOM'})}/></label><label>По<input type="date" value={draft.to} onChange={e=>setDraft({...draft,to:e.target.value,preset:'CUSTOM'})}/></label><label className="compare-toggle"><input type="checkbox" checked={draft.compare} onChange={e=>setDraft({...draft,compare:e.target.checked})}/><span>Сравнить с предыдущим периодом</span></label><button className="primary" onClick={apply}>Применить</button></div>
  </div>}
 </div>
}
