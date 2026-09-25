"use client";
import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Landmark, TrendingUp, WalletCards } from 'lucide-react';
import AppShell from './AppShell';
import { MetricCard, Status } from './UI';
import { api, money } from '@/lib/api';
import { useAnalyticsPeriod } from '@/lib/period';

function dayLabel(value:string){return new Date(`${value}T12:00:00+05:00`).toLocaleDateString('ru-RU',{day:'2-digit',month:'short'});}
function pointLabel(value:string){return /^\d{4}-\d{2}-\d{2}$/.test(value)?dayLabel(value):value;}
export default function MonthlyClient(){
 const [data,setData]=useState<any>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const {query}=useAnalyticsPeriod();
 useEffect(()=>{setLoading(true);setError('');api(`/dashboard/overview?${query}`).then(setData).catch((e:Error)=>{setData(null);setError(e.message)}).finally(()=>setLoading(false))},[query]);
 const m=data?.metrics||{};const chart=data?.chart||[];
 const profitKnown=m.profitKnown===true;
 const advertisingRevenue=Number(m.revenue??0);const advertisingEffectivePercent=Number(data?.advertising?.effectivePercent??(advertisingRevenue>0?Number(data?.advertising?.totalExpense??m.advertisingExpense??0)/advertisingRevenue*100:0));const advertisingMayBeIncomplete=Boolean(data?.advertising?.freshExpenseMayBeIncomplete||data?.advertising?.orderBoostExpensePending||data?.advertising?.topExpensePending);
 const best=useMemo(()=>[...(data?.profitDays||[])].sort((a:any,b:any)=>(b.orderedRevenue||0)-(a.orderedRevenue||0)).slice(0,5),[data]);
 return <AppShell title="Ежемесячные отчёты" subtitle="Месяц, неделя или произвольный период: выручка, выплата, прибыль, расходы и календарь денег">
 {loading?<div className="loading">Собираем отчёт…</div>:error?<div className="error-box settings-notice">{error}</div>:<>
  <div className="metrics-grid"><MetricCard label="ОПЛАЧЕННЫЕ ПРОДАЖИ" value={money(m.revenue||0)} change={data?.comparison?.deltas?.revenue}/><MetricCard label="К ВЫПЛАТЕ" value={money(m.payout||0)} change={data?.comparison?.deltas?.payout} tone="green"/><MetricCard label={profitKnown?'ЧИСТАЯ ПРИБЫЛЬ':'ПРИБЫЛЬ НЕ РАССЧИТАНА'} value={profitKnown?money(m.profit||0):'—'} tone={profitKnown?'cyan':'orange'}/><MetricCard label="УЧТЕННЫЕ РАСХОДЫ" value={money(Math.abs(m.expenses||0))} tone="red"/><MetricCard label="ВЫКУПЫ" value={String(m.paidOrders||0)} tone="orange"/><MetricCard label="СРЕДНИЙ ЧЕК" value={money(m.paidOrders?m.revenue/m.paidOrders:0)} tone="blue"/></div>
  <section className="panel monthly-hero"><div className="monthly-hero-card"><CalendarDays/><span>КАЛЕНДАРЬ ПЕРИОДА</span><b>{chart.length} дней/точек</b><small>детализация меняется автоматически: час, день, неделя, месяц</small></div><div className="monthly-hero-card"><WalletCards/><span>КОРЗИНА ВЫВОДА</span><b>{money(data?.payoutForecast?.summary?.basketNext7||0)}</b><small>попадёт в корзину за 7 дней</small></div><div className="monthly-hero-card"><Landmark/><span>ВЫПЛАТЫ UZUM</span><b>{money(data?.payoutForecast?.summary?.next7Days||0)}</b><small>по выбранному графику</small></div><div className="monthly-hero-card"><TrendingUp/><span>{profitKnown?'ЧИСТАЯ МАРЖА':'МАРЖА НЕ РАССЧИТАНА'}</span><b>{profitKnown&&m.revenue?((m.profit||0)/m.revenue*100).toFixed(1)+'%':'—'}</b><small>{profitKnown?`реклама: фактический ДРР ${advertisingEffectivePercent.toFixed(1)}%; налог ${Number(data?.financialSettings?.taxPercent??0)}%`:`Нет полного набора выплат, себестоимости или финальных рекламных списаний${advertisingMayBeIncomplete?' за свежий период':''}; ноль не подставляется.`}</small></div></section>
  <section className="panel"><div className="panel-head"><div><h2>Календарь продаж</h2><p>Быстрый визуальный контроль сильных и слабых периодов.</p></div><Status tone="green">период</Status></div><div className="calendar-bars">{chart.length?chart.map((d:any,index:number)=>{const key=String(d.date||d.label||index);return <div key={key} title={`${pointLabel(key)} — ${money(d.revenue||0)}`}><span style={{height:`${Math.max(8,Math.min(100,((d.revenue||0)/Math.max(1,...chart.map((x:any)=>x.revenue||0))*100)))}%`}}/><small>{pointLabel(key)}</small></div>}):<div className="payout-empty">Нет данных за период.</div>}</div></section>
  <section className="panel"><div className="panel-head"><div><h2>Лучшие дни</h2><p>Дни с максимальной выручкой фактических выкупов. Прибыль скрыта для дней с неполными исходными данными.</p></div><Status tone="blue">top</Status></div><div className="modern-table"><div className="modern-row head"><span>Дата</span><span>Выручка</span><span>К выплате</span><span>Прибыль</span><span>Выкупы</span><span>Единицы</span></div>{best.map((d:any)=>{const dayProfitKnown=d.profitKnown===true;return <div className="modern-row" key={d.date}><b>{dayLabel(d.date)}</b><span>{money(d.orderedRevenue||0)}</span><span>{money(d.payout||0)}</span><strong className={dayProfitKnown?((d.profit||0)>=0?'positive':'negative'):''}>{dayProfitKnown?money(d.profit||0):'—'}</strong><span>{d.orderedOrders||0}</span><span>{d.orderedUnits||0}</span></div>})}</div></section>
 </>}
 </AppShell>
}
