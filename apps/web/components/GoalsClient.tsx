"use client";
import { useCallback, useEffect, useState } from 'react';
import { Calendar, RefreshCw, Target } from 'lucide-react';
import AppShell from './AppShell';
import { Progress } from './UI';
import { api, money } from '@/lib/api';

const labels:Record<string,string>={ORDERED_REVENUE:'Сумма заказов',REVENUE:'Оплаченные продажи',PROFIT:'Чистая прибыль',ORDERS:'Оплаченные заказы',UNITS:'Продано единиц',ROAS:'Выручка магазина / рекламные расходы'};
const goalValue=(metric:string,value:number|null)=>value===null?'—':metric==='UNITS'?`${value} шт.`:metric==='ORDERS'?`${value} заказов`:metric==='ROAS'?`${Number(value).toFixed(2)}x`:money(value);

export default function GoalsClient(){
 const [rows,setRows]=useState<any[]>([]);const [loading,setLoading]=useState(false);const [updated,setUpdated]=useState<Date|null>(null);const [error,setError]=useState('');
 const load=useCallback(async()=>{setLoading(true);setError('');try{setRows(await api<any[]>('/goals'));setUpdated(new Date())}catch(e:any){setRows([]);setError(e.message||'Не удалось загрузить цели')}finally{setLoading(false)}},[]);
 useEffect(()=>{load();const timer=setInterval(load,30000);return()=>clearInterval(timer)},[load]);
 return <AppShell periodEnabled={false} title="Цели" subtitle={`Цели по заданным периодам${updated?` • обновлено ${updated.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`:''}`} actions={<button className="ghost" onClick={load} disabled={loading}><RefreshCw size={16}/>{loading?'Обновление...':'Обновить'}</button>}>
  {error&&<div className="error-box settings-notice"><span>{error}</span><button className="ghost" onClick={()=>void load()}>Повторить</button></div>}
  <div className="goal-cards">{rows.map(g=><article className="goal-card" key={g.id}><div className="goal-card-head"><div className="goal-icon"><Target/></div><div><span>{g.period==='WEEKLY'?'НЕДЕЛЬНАЯ':g.period==='MONTHLY'?'МЕСЯЧНАЯ':'ПОЛЬЗОВАТЕЛЬСКАЯ'} ЦЕЛЬ</span><h2>{g.metricLabel||labels[g.metric]||g.metric}</h2></div></div><strong>{g.metricKnown===false?'—':goalValue(g.metric,g.current)} / {goalValue(g.metric,g.targetValue)}</strong>{g.metric==='ROAS'&&<small>Магазинный коэффициент без атрибуции продаж кампаниям</small>}{g.metricKnown===false?<small>Текущее значение и прогресс скрыты, пока не поступят выплаты, себестоимость и финальные рекламные списания.</small>:<Progress value={g.progress}/>}<div className="goal-meta"><span><Calendar size={15}/>{new Date(g.startAt).toLocaleDateString('ru-RU')} — {new Date(g.endAt).toLocaleDateString('ru-RU')}</span><b>{g.progress===null?'ожидает факт':`${g.progress}%`}</b></div></article>)}</div>
 </AppShell>
}
