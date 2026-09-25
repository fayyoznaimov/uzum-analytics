"use client";
import { useEffect, useMemo, useState } from 'react';

export type PeriodPreset = 'TODAY'|'YESTERDAY'|'LAST_7'|'LAST_15'|'THIS_WEEK'|'PREV_WEEK'|'LAST_30'|'THIS_MONTH'|'PREV_MONTH'|'CUSTOM';
export type AnalyticsPeriod = { from:string; to:string; preset:PeriodPreset; compare:boolean };

const STORAGE_KEY='uzum-analytics-period-v1';
const EVENT_NAME='uzum-analytics-period-change';

function tashkentToday(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
function asDate(value:string){ return new Date(`${value}T12:00:00Z`); }
function fmt(date:Date){ return date.toISOString().slice(0,10); }
function addDays(value:string,days:number){ const d=asDate(value); d.setUTCDate(d.getUTCDate()+days); return fmt(d); }
function startOfWeek(value:string){ const d=asDate(value); const day=d.getUTCDay()||7; d.setUTCDate(d.getUTCDate()-day+1); return fmt(d); }
function startOfMonth(value:string){ return `${value.slice(0,7)}-01`; }
function endOfMonth(value:string){ const d=asDate(startOfMonth(value)); d.setUTCMonth(d.getUTCMonth()+1); d.setUTCDate(0); return fmt(d); }

export function resolvePreset(preset:PeriodPreset):AnalyticsPeriod{
  const today=tashkentToday();
  if(preset==='TODAY')return{from:today,to:today,preset,compare:true};
  if(preset==='YESTERDAY'){const d=addDays(today,-1);return{from:d,to:d,preset,compare:true};}
  if(preset==='LAST_7')return{from:addDays(today,-6),to:today,preset,compare:true};
  if(preset==='LAST_15')return{from:addDays(today,-14),to:today,preset,compare:true};
  if(preset==='THIS_WEEK'){const from=startOfWeek(today);return{from,to:today,preset,compare:true};}
  if(preset==='PREV_WEEK'){const thisMonday=startOfWeek(today);return{from:addDays(thisMonday,-7),to:addDays(thisMonday,-1),preset,compare:true};}
  if(preset==='LAST_30')return{from:addDays(today,-29),to:today,preset,compare:true};
  if(preset==='THIS_MONTH')return{from:startOfMonth(today),to:today,preset,compare:true};
  if(preset==='PREV_MONTH'){const currentStart=startOfMonth(today);const prevEnd=addDays(currentStart,-1);return{from:startOfMonth(prevEnd),to:prevEnd,preset,compare:true};}
  return{from:addDays(today,-6),to:today,preset:'CUSTOM',compare:true};
}

export function defaultPeriod(){ return resolvePreset('LAST_7'); }
export function normalizePeriod(value?:Partial<AnalyticsPeriod>|null):AnalyticsPeriod{
  const fallback=defaultPeriod();
  const from=/^\d{4}-\d{2}-\d{2}$/.test(value?.from||'')?String(value?.from):fallback.from;
  const to=/^\d{4}-\d{2}-\d{2}$/.test(value?.to||'')?String(value?.to):fallback.to;
  return {from:from<=to?from:to,to:from<=to?to:from,preset:(value?.preset||'CUSTOM') as PeriodPreset,compare:value?.compare!==false};
}
export function readPeriod():AnalyticsPeriod{
  if(typeof window==='undefined')return defaultPeriod();
  try{return normalizePeriod(JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'));}catch{return defaultPeriod();}
}
export function savePeriod(period:AnalyticsPeriod){
  if(typeof window==='undefined')return;
  const normalized=normalizePeriod(period);
  localStorage.setItem(STORAGE_KEY,JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(EVENT_NAME,{detail:normalized}));
}
export function periodQuery(period:AnalyticsPeriod){
  const q=new URLSearchParams({from:period.from,to:period.to,compare:period.compare?'1':'0'});
  return q.toString();
}
export function periodDays(period:AnalyticsPeriod){ return Math.max(1,Math.round((asDate(period.to).getTime()-asDate(period.from).getTime())/86400000)+1); }
export function formatPeriod(period:AnalyticsPeriod){
  const f=(v:string)=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:v.slice(0,4)!==tashkentToday().slice(0,4)?'numeric':undefined,timeZone:'UTC'}).format(asDate(v));
  return period.from===period.to?f(period.from):`${f(period.from)} — ${f(period.to)}`;
}
export const periodLabels:Record<PeriodPreset,string>={TODAY:'Сегодня',YESTERDAY:'Вчера',LAST_7:'Последние 7 дней',LAST_15:'Последние 15 дней',THIS_WEEK:'Эта неделя',PREV_WEEK:'Прошлая неделя',LAST_30:'Последние 30 дней',THIS_MONTH:'Этот месяц',PREV_MONTH:'Прошлый месяц',CUSTOM:'Произвольный период'};

export function useAnalyticsPeriod(){
  const [period,setPeriod]=useState<AnalyticsPeriod>(defaultPeriod());
  useEffect(()=>{
    setPeriod(readPeriod());
    const handler=(event:Event)=>setPeriod(normalizePeriod((event as CustomEvent).detail||readPeriod()));
    const storage=(event:StorageEvent)=>{if(event.key===STORAGE_KEY)setPeriod(readPeriod())};
    window.addEventListener(EVENT_NAME,handler);
    window.addEventListener('storage',storage);
    return()=>{window.removeEventListener(EVENT_NAME,handler);window.removeEventListener('storage',storage)};
  },[]);
  const query=useMemo(()=>periodQuery(period),[period]);
  return{period,query,setPeriod:savePeriod,days:periodDays(period),label:formatPeriod(period)};
}
