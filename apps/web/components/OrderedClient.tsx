"use client";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import AppShell from './AppShell';
import { MetricCard, Status } from './UI';
import { api, money } from '@/lib/api';
import { useAnalyticsPeriod } from '@/lib/period';

const pct=(value:number,base:number)=>base?value/base*100:0;
const signed=(value:number)=>`${value<0?'− ':''}${money(Math.abs(value))}`;
const expenseValue=(value:number)=>value===0?'—':value<0?`+ ${money(Math.abs(value))}`:`− ${money(value)}`;
const stateLabel=(state:string)=>state==='PAID'?'выдан':state==='WAITING'?'ждёт выкупа':'в обработке';

export default function OrderedClient(){
 const [data,setData]=useState<any>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const {query}=useAnalyticsPeriod();
 const load=useCallback(async()=>{setLoading(true);setError('');try{setData(await api(`/dashboard/overview?${query}`))}catch(cause:any){setData(null);setError(cause.message||'Не удалось загрузить данные о заказанном')}finally{setLoading(false)}},[query]);
 useEffect(()=>{void load()},[load]);
 const m=data?.metrics||{};
 const orders:any[]=data?.orderedOrders||[];
 const orderedCommission=useMemo(()=>orders.reduce((sum,o)=>sum+Number(o.commission||0),0),[orders]);
 const orderedMarketplaceLogistics=useMemo(()=>orders.reduce((sum,o)=>sum+Number(o.marketplaceLogistics||0),0),[orders]);
 const potentialKnown=Boolean(m.orderedPotentialProfitKnown);
 const orderedRevenue=Number(m.orderedRevenue||0),orderedPayout=Number(m.orderedPayout||0),orderedUnits=Number(m.orderedUnits||0);
 const potentialProfit=Number(m.orderedPotentialProfit??m.orderedPotentialProfitEstimate??0);
 const rows=useMemo(()=>[
  {group:'Удержания Uzum',name:'Комиссия маркетплейса',value:orderedCommission,source:'Сумма по каждому заказанному заказу периода'},
  {group:'Удержания Uzum',name:'Логистика заказов Uzum',value:orderedMarketplaceLogistics,source:'Сумма по каждому заказанному заказу периода'},
  {group:'После выплаты',name:'Себестоимость товара',value:Number(m.orderedProductCost||0),source:'По SKU на дату заказа'},
  {group:'После выплаты',name:'Логистика поставок',value:Number(m.orderedWarehouseLogisticsCost||0),source:'По поставкам / шт.'},
  {group:'После выплаты',name:'Упаковка и доп. расходы',value:Number(m.orderedPackagingCost||0)+Number(m.orderedAdditionalCost||0),source:'По SKU'},
  {group:'После выплаты',name:'Налог',value:Number(m.orderedTaxExpense||0),source:`${Number(data?.financialSettings?.taxPercent??0)}% от суммы заказа`},
  {group:'Реклама',name:'Буст заказов',value:Number(m.orderedAdvertisingEstimate||0),source:'По ставке именно этого товара на момент заказа, не по всей кампании за день'},
  {group:'Реклама',name:'Буст в ТОП',value:Number(m.orderedTopPromotionExpense||0),source:'Кампания целиком; Uzum не даёт разбивку по товарам для этого типа буста'},
 ],[m,orderedCommission,orderedMarketplaceLogistics,data]);
 const totalCosts=rows.reduce((sum,row)=>sum+row.value,0);
 return <AppShell title="Заказано" subtitle="Что заказали покупатели в выбранном периоде: все расходы и потенциальная прибыль — независимо от того, выкупят ли ещё или нет">
  {loading?<div className="loading">Считаем заказанное…</div>:error?<div className="error-box settings-notice"><span>{error}</span><button className="ghost" onClick={()=>void load()}>Повторить</button></div>:data?.empty?<div className="error-box settings-notice"><span>Магазин ещё не подключён или не было ни одной синхронизации.</span></div>:data&&<>
   <div className="metrics-grid">
    <MetricCard label={`ЗАКАЗАНО • ${orderedUnits} ШТ.`} value={money(orderedRevenue)}/>
    <MetricCard label="ВЫПЛАТА ПО ЗАКАЗАННОМУ (расчётная)" value={money(orderedPayout)} tone="green"/>
    <MetricCard label={`ВЫКУПЛЕНО ИЗ ЭТОГО ЖЕ ПЕРИОДА • ${Number(m.paidUnits||0)} ШТ.`} value={money(Number(m.revenue||0))} tone="violet"/>
    <MetricCard label={`ОСТАЁТСЯ: ЖДЁТ ВЫКУПА • ${Number(m.waitingUnits||0)} ШТ.`} value={money(Number(m.waitingRevenue||0))} tone="orange"/>
    <MetricCard label={potentialKnown?'ПОТЕНЦИАЛЬНАЯ ПРИБЫЛЬ':'ПРИБЫЛЬ НЕ РАССЧИТАНА'} value={potentialKnown?money(potentialProfit):'—'} tone={potentialKnown?(potentialProfit>=0?'cyan':'red'):'orange'}/>
    <MetricCard label="ПОТЕНЦИАЛЬНАЯ МАРЖА" value={potentialKnown?`${pct(potentialProfit,orderedRevenue).toFixed(1)}%`:'—'} tone="blue"/>
   </div>
   {!potentialKnown&&<div className="profit-provisional"><AlertTriangle size={18}/><div><b>Потенциальная прибыль ещё не полная</b><span>Без факта выплаты: {Number(m.orderedPayoutPendingOrders||0)} заказов; себестоимость известна не для всех позиций; покрытие ставок рекламы {Number(m.orderedAdvertisingCoverage||0).toFixed(0)}%. Ноль вместо пропусков не подставляется.</span></div><Status tone="amber">расчёт неполный</Status></div>}
   <div className="profit-sales-note"><AlertTriangle size={15}/><span>Буст заказов считается по ставке конкретного товара, наблюдавшейся Uzum на момент заказа, а не как вся рекламная кампания за вчера — товар может быть выкуплен позже. Буст в ТОП Uzum не разбивает по товарам, поэтому показан только общей суммой по кампании.</span></div>
   <section className="panel"><div className="panel-head"><div><h2>За что и сколько потратится, если всё выкупят</h2><p>Сумма, доля от суммы заказов и источник каждой статьи — по когорте «заказано», не «выкуплено».</p></div><Status tone="blue">Всего {money(totalCosts)}</Status></div>
    <div className="profit-table"><div className="profit-table-row head"><span>Группа</span><span>Статья</span><span>Сумма</span><span>% от заказов</span><span>На заказ</span><span>Источник</span></div>{rows.map(row=><div className="profit-table-row" key={row.name}><span>{row.group}</span><b>{row.name}</b><strong>{expenseValue(row.value)}</strong><span>{pct(row.value,orderedRevenue).toFixed(2)}%</span><span>{expenseValue(orders.length?row.value/orders.length:0)}</span><small>{row.source}</small></div>)}</div>
   </section>
   <section className="panel"><div className="panel-head"><div><h2>Каждый заказ периода</h2><p>По дате оформления заказа (orderedAt), включая ещё не выкупленные. Отменённые заказы сюда не входят.</p></div><Status tone="green">{orders.length} заказов</Status></div>
    <div className="profit-table"><div className="profit-table-row head"><span>Заказ</span><span>Товар</span><span>Продажа</span><span>Выплата</span><span>Расходы после выплаты</span><span>Потенц. прибыль</span></div>
     {orders.map((o:any)=><div className="profit-table-row" key={o.id}>
      <span>№{o.marketplaceOrderId||o.externalId}<small>{new Date(o.orderedAt).toLocaleDateString('ru-RU',{timeZone:'Asia/Tashkent',day:'2-digit',month:'2-digit'})} • {stateLabel(o.state)}</small></span>
      <b>{o.items.map((it:any)=>it.title).join(', ')}</b>
      <strong>{money(o.gross)}</strong>
      <strong className="positive">{o.payoutReported?money(o.payout):`≈ ${money(o.payout)}`}</strong>
      <span className="expense">− {money(Number(o.productCost)+Number(o.warehouseLogisticsCost)+Number(o.packagingCost)+Number(o.additionalCost)+Number(o.tax)+Number(o.orderBoostEstimate))}<small>товар {money(o.productCost)} • налог {money(o.tax)} • буст {money(o.orderBoostEstimate)}</small></span>
      <strong className={Number(o.profitPotential)>=0?'positive':'negative'}>{o.profitPotentialKnown?money(o.profitPotential):`≈ ${money(o.profitPotential)}`}</strong>
     </div>)}
    </div>
   </section>
  </>}
 </AppShell>
}
