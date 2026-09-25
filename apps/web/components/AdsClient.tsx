"use client";
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, BarChart3, CircleDollarSign, MousePointerClick, PiggyBank, Search, Target, TrendingUp } from 'lucide-react';
import AppShell from './AppShell';
import { MetricCard, Status } from './UI';
import { api, money } from '@/lib/api';
import { useAnalyticsPeriod } from '@/lib/period';

export default function AdsClient(){
 const [data,setData]=useState<any>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const {query}=useAnalyticsPeriod();
 const load=useCallback(async()=>{setLoading(true);setError('');try{setData(await api(`/dashboard/overview?${query}`))}catch(e:any){setData(null);setError(e.message||'Не удалось загрузить рекламные расходы')}finally{setLoading(false)}},[query]);
 useEffect(()=>{void load()},[load]);

 const m=data?.metrics||{};const ads=data?.advertising||{};
 const revenue=Math.max(0,Number(m.revenue??0));
 const orderBoostSpend=Number(ads.orderBoostExpense??0);
 const topPromotionSpend=Number(ads.topPromotionExpense??0);
 const orderBoostProvisional=Math.max(0,Number(ads.provisionalOrderBoostExpense??0));
 const topPromotionProvisional=Math.max(0,Number(ads.provisionalTopPromotionExpense??0));
 const orderBoostFactual=Number(ads.factualOrderBoostExpense??ads.confirmedOrderBoostExpense??orderBoostSpend);
 const topPromotionFactual=Number(ads.factualTopPromotionExpense??ads.confirmedTopPromotionExpense??topPromotionSpend);
 const provisionalSpend=Math.max(0,Number(ads.provisionalExpense??(orderBoostProvisional+topPromotionProvisional)));
 const adSpend=Number(ads.totalExpense??m.advertisingExpense??(orderBoostSpend+topPromotionSpend));
 const effectivePercent=Number(ads.effectivePercent??(revenue?adSpend/revenue*100:0));
 const roas=adSpend>0?revenue/adSpend:0;const storeProfit=Number(m.profit??0);const storeProfitKnown=m.profitKnown!==false;
 const hasProvisional=Boolean(ads.hasEstimate||provisionalSpend>0);const mayBeIncomplete=Boolean(ads.freshExpenseMayBeIncomplete||ads.orderBoostExpensePending||ads.topExpensePending);
 const rows=[
   {name:'Буст заказов',spend:orderBoostSpend,factual:orderBoostFactual,provisional:orderBoostProvisional,share:revenue?orderBoostSpend/revenue*100:0,status:orderBoostProvisional>0?'Факт; оценка отдельно':ads.orderBoostExpensePending?'Свежий факт может дополниться':'Факт finance/expenses',tone:orderBoostProvisional>0||ads.orderBoostExpensePending?'amber':orderBoostSpend?'green':'gray'},
   {name:'Буст в ТОП',spend:topPromotionSpend,factual:topPromotionFactual,provisional:topPromotionProvisional,share:revenue?topPromotionSpend/revenue*100:0,status:ads.topExpensePending?'Свежий факт может дополниться':'Факт finance/expenses',tone:ads.topExpensePending?'amber':topPromotionSpend?'green':'gray'},
 ];

 return <AppShell title="Реклама" subtitle="Фактические списания, предварительные суммы и общий ДРР магазина без ложной атрибуции продаж кампаниям">
 {loading?<div className="loading">Загружаем рекламу…</div>:error?<div className="error-box settings-notice"><span>{error}</span><button className="ghost" onClick={()=>void load()}>Повторить</button></div>:data&&<>
  <div className="metrics-grid"><MetricCard label="ПОДТВЕРЖДЁННАЯ РЕКЛАМА" value={money(adSpend)} tone="orange"/><MetricCard label="ВЫРУЧКА МАГАЗИНА" value={money(revenue)} tone="blue"/><MetricCard label="ВЫРУЧКА / РЕКЛАМНЫЕ РАСХОДЫ" value={adSpend>0?`${roas.toFixed(2)}x`:'—'} tone="green"/><MetricCard label="ФАКТИЧЕСКИЙ ДРР" value={revenue?`${effectivePercent.toFixed(1)}%`:'—'} tone="violet"/><MetricCard label={storeProfitKnown?'ЧИСТАЯ ПРИБЫЛЬ МАГАЗИНА':'ПРИБЫЛЬ НЕ РАССЧИТАНА'} value={storeProfitKnown?money(storeProfit):'—'} tone={storeProfitKnown?(storeProfit>=0?'cyan':'red'):'gray'}/><MetricCard label="СТАТУС ПЕРИОДА" value={mayBeIncomplete?'Свежий, не финальный':'Факт Uzum'} tone={mayBeIncomplete?'orange':'green'}/></div>
   {!storeProfitKnown&&<div className="profit-provisional"><AlertTriangle size={18}/><div><b>Нет полного набора данных для прибыли</b><span>Число скрыто: отсутствующая выплата или себестоимость не заменяется нулём.</span></div><Status tone="amber">прибыль неизвестна</Status></div>}
   {(hasProvisional||mayBeIncomplete)&&<div className="profit-provisional"><AlertTriangle size={18}/><div><b>{hasProvisional?'Модельная оценка показана отдельно от факта':'Свежие расходы могут прийти с задержкой'}</b><span>{hasProvisional?`Оценка по ставкам товаров — ${money(provisionalSpend)}. Она не включена в подтверждённый расход или прибыль.`:'В итог включены только уже поступившие строки finance/expenses; период пока не считается финальным.'}</span></div><Status tone="amber">{hasProvisional?'оценка отдельно':'не финально'}</Status></div>}
  <section className="panel ad-hero"><div className="ad-flow"><div><BarChart3/><b>Показы</b><span>нужен рекламный отчёт</span></div><ArrowRight/><div><MousePointerClick/><b>Клики</b><span>нужен рекламный отчёт</span></div><ArrowRight/><div><Target/><b>Заказы кампании</b><span>пока не атрибутируются</span></div><ArrowRight/><div><PiggyBank/><b>Прибыль кампании</b><span>пока не рассчитывается</span></div></div></section>
  <section className="panel"><div className="panel-head"><div><h2>Источники рекламных расходов</h2><p>Расходы взяты из finance/expenses. Продажи и прибыль кампаний не подменяются общей выручкой магазина.</p></div><Status tone={hasProvisional||mayBeIncomplete?'amber':'green'}>{hasProvisional?'факт; оценка отдельно':mayBeIncomplete?'факт на сейчас':'факт Uzum'}</Status></div><div className="modern-table"><div className="modern-row head"><span>Источник</span><span>Всего</span><span>Подтверждено</span><span>Оценка</span><span>% выручки магазина</span><span>Продажи кампании</span><span>Статус</span></div>{rows.map(r=><div className="modern-row" key={r.name}><b>{r.name}</b><span>{money(r.spend)}</span><span>{money(r.factual)}</span><span>{r.provisional?money(r.provisional):'—'}</span><span>{revenue?`${r.share.toFixed(1)}%`:'—'}</span><span>нет атрибуции</span><Status tone={r.tone}>{r.status}</Status></div>)}</div></section>
  <section className="panel"><div className="panel-head"><div><h2>Кампании буста в ТОП</h2><p>{ads.campaignsFallback?`За выбранный период списаний ещё нет. Показан последний доступный состав кампаний за ${ads.campaignDataDate||'предыдущий день'}; его расход не добавлен в выбранный период.`:ads.note}</p></div><Status tone="blue">{ads.campaigns?.length||0} кампаний</Status></div><div className="modern-table"><div className="modern-row head"><span>ID кампании</span><span>Расход</span><span>Списаний</span></div>{(ads.campaigns||[]).map((r:any)=><div className="modern-row" key={r.id}><b>{r.id}</b><span>{money(r.spend)}</span><span>{r.entries}</span></div>)}</div></section>
  <section className="panel"><div className="panel-head"><div><h2>Что появится после рекламного отчёта</h2><p>Для этих выводов нужны показы, клики и продажи, атрибутированные Uzum конкретной кампании.</p></div><Status tone="blue">ожидает данные</Status></div><div className="insight-grid"><div><AlertTriangle/><b>Расход без продаж</b><span>Запросы и кампании, где деньги ушли, а заказов нет.</span></div><div><CircleDollarSign/><b>Убыточная реклама</b><span>Чистая прибыль кампании после себестоимости, без подмены магазинной прибылью.</span></div><div><Search/><b>Поисковые запросы</b><span>Какие запросы продают, а какие только расходуют бюджет.</span></div><div><TrendingUp/><b>Рост бюджета</b><span>Где можно увеличить рекламу без потери маржи.</span></div></div></section>
 </>}
 </AppShell>
}
