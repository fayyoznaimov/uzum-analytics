"use client";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BadgePercent, ChevronDown, ChevronRight, CircleDollarSign, Megaphone, PackageCheck, ReceiptText, TrendingUp, Truck } from 'lucide-react';
import AppShell from './AppShell';
import { MetricCard, Status } from './UI';
import { api, money } from '@/lib/api';
import { useAnalyticsPeriod } from '@/lib/period';

const pct=(value:number,base:number)=>base?value/base*100:0;
const signed=(value:number)=>`${value<0?'− ':''}${money(Math.abs(value))}`;
const expenseValue=(value:number)=>value===0?'—':value<0?`+ ${money(Math.abs(value))}`:`− ${money(value)}`;
const adValue=(value:number,estimated:boolean)=>value===0?'—':`${estimated?'≈ ':''}− ${money(Math.abs(value))}`;
const dayLabel=(value:string)=>new Date(`${value}T12:00:00+05:00`).toLocaleDateString('ru-RU',{weekday:'short',day:'2-digit',month:'long'});

export default function ProfitClient(){
 const [data,setData]=useState<any>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [openOrders,setOpenOrders]=useState<Record<string,boolean>>({});const {query}=useAnalyticsPeriod();
 const load=useCallback(async()=>{setLoading(true);setError('');try{setData(await api(`/dashboard/overview?${query}`))}catch(cause:any){setData(null);setError(cause.message||'Не удалось загрузить данные о прибыли')}finally{setLoading(false)}},[query]);
 useEffect(()=>{void load()},[load]);
 const m=data?.metrics||{};const ads=data?.advertising||{};
 const orderedPotentialKnown=Boolean(m.orderedPotentialProfitKnown);
 const realizedInputsKnown=Number(m.realizedPayoutPendingOrders||0)===0&&Number(m.realizedMissingCostItems||0)===0;
 const realizedProfitKnown=m.profitKnown===true;
 const daySummary=data?.profitDaysSummary||{};
 const revenue=Number(m.revenue||0),payout=Number(m.payout||0),profit=Number(m.profit||0),units=Number(m.paidUnits||0);
 const rows=useMemo(()=>[
  {group:'Удержания Uzum',name:'Комиссия маркетплейса',value:Number(m.commission||0),source:'API; при неполной разбивке — расчёт из выплаты'},
  {group:'Удержания Uzum',name:'Логистика заказов Uzum',value:Number(m.marketplaceLogistics||0),source:'Доступная разбивка API'},
  {group:'Удержания Uzum',name:'Прочие удержания Uzum',value:Number(m.otherMarketplaceDeductions||0),source:'Остаток между продажей, выплатой и известными удержаниями'},
  {group:'После выплаты',name:'Себестоимость товара',value:Number(m.productCost||0),source:'По SKU'},
  {group:'После выплаты',name:'Логистика поставок',value:Number(m.warehouseLogisticsCost||0),source:'По поставкам / шт.'},
  {group:'После выплаты',name:'Упаковка',value:Number(m.packagingCost||0),source:'По SKU'},
  {group:'После выплаты',name:'Дополнительные расходы',value:Number(m.additionalCost||0),source:'По SKU'},
  {group:'После выплаты',name:'Налог',value:Number(m.taxExpense||0),source:`${Number(data?.financialSettings?.taxPercent??0)}% от продажи`},
  {group:'После выплаты',name:'Хранение, штрафы и доп. услуги Uzum',value:Number(data?.otherFees?.amount||0),source:(data?.otherFees?.breakdown||[]).slice(0,3).map((b:any)=>`${b.label} ×${b.count}`).join('; ')||'Ledger finance/expenses вне рекламы и логистики'},
  {group:'Реклама',name:'Буст заказов',value:Number(m.orderBoostExpense||0),source:Number(ads.provisionalOrderBoostExpense??0)>0?'Факт; модельная оценка отдельно':'Факт finance/expenses'},
  {group:'Реклама',name:'Буст в ТОП',value:Number(m.topPromotionExpense||0),source:ads.topExpensePending?'Поступивший факт; свежий период не финален':'Факт finance/expenses'},
 ],[m,ads,data]);
 const totalCosts=rows.reduce((sum,row)=>sum+row.value,0);
 const cogs=Number(m.productCost||0)+Number(m.warehouseLogisticsCost||0)+Number(m.packagingCost||0)+Number(m.additionalCost||0);
 const adSpend=Number(m.advertisingExpense||0);
 const signals=useMemo(()=>{
  const result:{tone:string;icon:any;title:string;text:string}[]=[];
  const margin=pct(profit,revenue),adRatio=pct(adSpend,revenue),cogsRatio=pct(cogs,revenue),payoutRatio=pct(payout,revenue);
  result.push({tone:profit>=0?'green':'red',icon:TrendingUp,title:'Чистая маржа',text:`${margin.toFixed(1)}% — отношение чистой прибыли к оплаченной выручке за период.`});
  result.push({tone:'blue',icon:Megaphone,title:'Фактический ДРР',text:adSpend<0?`Чистая корректировка рекламы составила ${adRatio.toFixed(1)}% выручки: возвраты превысили списания.`:`Рекламные списания составили ${adRatio.toFixed(1)}% оплаченной выручки.`});
  result.push({tone:'blue',icon:PackageCheck,title:'Доля полной себестоимости',text:`Товар, упаковка, дополнительные расходы и логистика поставок составили ${cogsRatio.toFixed(1)}% выручки.`});
  result.push({tone:'blue',icon:BadgePercent,title:'Доля выплаты Uzum',text:`Фактическая выплата составила ${payoutRatio.toFixed(1)}% оплаченной выручки.`});
  return result;
 },[profit,revenue,adSpend,cogs,payout]);
 return <AppShell title="Профит" subtitle="Полная экономика оплаченных продаж за выбранный период: от цены заказа до чистой прибыли">
  {loading?<div className="loading">Считаем прибыль и расходы…</div>:error?<div className="error-box settings-notice"><span>{error}</span><button className="ghost" onClick={()=>void load()}>Повторить</button></div>:data?.empty?<div className="error-box settings-notice"><span>Магазин ещё не подключён или не было ни одной синхронизации. Откройте «Настройки», добавьте ключи Uzum и запустите синхронизацию — после этого появятся данные о прибыли.</span></div>:data&&<>
   <div className="metrics-grid">
    <MetricCard label={`ЗАКАЗАНО ЗА ПЕРИОД • ${Number(m.orderedUnits||0)} ШТ.`} value={money(Number(m.orderedRevenue||0))}/>
    <MetricCard label="ВЫПЛАТА UZUM ПО ЗАКАЗАМ ПЕРИОДА" value={money(Number(m.orderedPayout||0))} tone="green"/>
    <MetricCard label={`ВЫКУПЛЕНО ЗА ПЕРИОД • ${units} ШТ.`} value={money(revenue)} tone="violet"/>
    <MetricCard label="ВЫПЛАТА ПО ВЫКУПАМ ПЕРИОДА" value={realizedInputsKnown?money(payout):'—'} tone="green"/>
    <MetricCard label={realizedInputsKnown?(realizedProfitKnown?'ЧИСТАЯ ПРИБЫЛЬ':'ПРИБЫЛЬ НА СЕЙЧАС • НЕ ФИНАЛЬНО'):'ПРИБЫЛЬ НЕ РАССЧИТАНА'} value={realizedInputsKnown?money(profit):'—'} change={realizedProfitKnown?data?.comparison?.deltas?.profit:undefined} tone={realizedProfitKnown?(profit>=0?'cyan':'red'):'orange'}/>
    <MetricCard label={realizedProfitKnown?'ЧИСТАЯ МАРЖА':'МАРЖА НА СЕЙЧАС'} value={realizedInputsKnown?`${pct(profit,revenue).toFixed(1)}%`:'—'} tone="blue"/>
   </div>
   {!realizedInputsKnown&&<div className="profit-provisional"><AlertTriangle size={18}/><div><b>Не хватает исходных данных для прибыли</b><span>Без фактической выплаты Uzum: {Number(m.realizedPayoutPendingOrders||0)} строк{(m.realizedPayoutPendingOrderRefs||[]).length?` (№ ${(m.realizedPayoutPendingOrderRefs||[]).join(', ')}${Number(m.realizedPayoutPendingOrders||0)>(m.realizedPayoutPendingOrderRefs||[]).length?' …':''})`:''} — по свежим заказам факт придёт после удержания. Без заданной себестоимости: {Number(m.realizedMissingCostItems||0)} позиций{(m.realizedMissingCostSkus||[]).length?` (${(m.realizedMissingCostSkus||[]).join(', ')}${Number(m.realizedMissingCostItems||0)>(m.realizedMissingCostSkus||[]).length?' …':''})`:''} — задайте себестоимость этих SKU в разделе «Себестоимость». Ноль вместо пропусков в прибыль не подставляется.</span></div><Status tone="amber">расчёт скрыт</Status></div>}
   {(ads.topExpensePending||ads.orderBoostExpensePending||ads.hasEstimate)&&<div className="profit-provisional"><AlertTriangle size={18}/><div><b>Свежий период ещё не финальный</b><span>В прибыль включены только поступившие списания Uzum. Модельная оценка Буста заказов {Number(ads.provisionalOrderBoostExpense||0)>0?money(Number(ads.provisionalOrderBoostExpense)):'недоступна'} и не прибавляется к факту; Буст в ТОП появится только по ledger.</span></div><Status tone="amber">факт на сейчас</Status></div>}
   {Boolean(data?.otherFees?.balanceCorrectionAnomaly)&&<div className="profit-provisional"><AlertTriangle size={18}/><div><b>Перераспределение баланса между магазинами</b><span>За период разовая корректировка {money(Number(data.otherFees.balanceCorrectionAnomaly))} — это не расход, в прибыль не включена. Сверьте вручную в кабинете Uzum.</span></div><Status tone="amber">не расход</Status></div>}
   <section className="panel"><div className="panel-head"><div><h2>Выкуплено и осталось ждать</h2><p>Из заказанного в периоде: что уже выкуплено покупателем, а что ещё в ожидании его оплаты/получения.</p></div><Status tone={Number(m.waitingUnits||0)?'amber':'green'}>{Number(m.waitingUnits||0)} шт. в ожидании</Status></div>
    <div className="profit-days-summary">
     <div><span>Выкуплено</span><b className="positive">{money(revenue)}</b><small>{units} шт.</small></div>
     <div><span>Осталось: ждёт выкупа</span><b className={Number(m.waitingUnits||0)?'negative':'positive'}>{money(Number(m.waitingRevenue||0))}</b><small>{Number(m.waitingUnits||0)} шт. • {Number(m.waitingOrders||0)} заказов</small></div>
    </div>
   </section>
   {data?.staleWaitingOrders&&<section className="panel"><div className="panel-head"><div><h2>Заказы старше 7 дней — риск отмены</h2><p>{data.staleWaitingOrders.note}</p></div><Status tone={data.staleWaitingOrders.count?'amber':'green'}>{data.staleWaitingOrders.count} шт.</Status></div>
    {data.staleWaitingOrders.count?<>
     <div className="profit-days-summary">
      <div><span>Заказов под риском</span><b>{data.staleWaitingOrders.count}</b></div>
      <div><span>Штук</span><b>{data.staleWaitingOrders.units}</b></div>
      <div><span>Сумма под риском</span><b className="negative">{money(data.staleWaitingOrders.amount)}</b></div>
     </div>
     <div className="profit-table"><div className="profit-table-row head"><span>Заказ</span><span>Товар</span><span>Дней в ожидании</span><span>Шт.</span><span>Сумма</span><span></span></div>
      {data.staleWaitingOrders.orders.map((o:any)=><div className="profit-table-row" key={o.id}><span>№{o.marketplaceOrderId||o.externalId}</span><b>{o.title}{o.sellerSku?` • ${o.sellerSku}`:''}</b><strong className="negative">{o.daysWaiting} дн.</strong><span>{o.units}</span><span>{money(o.amount)}</span><small/></div>)}
     </div>
    </>:<div className="payout-empty">Заказов старше 7 дней в ожидании нет.</div>}
   </section>}
   <section className="panel profit-days-panel"><div className="panel-head"><div><h2>Фактический профит по дням</h2><p>Единый контракт: выданные покупателям заказы по issuedAt и рекламный ledger по serviceAt того же дня.</p></div><Status tone="green">{data?.profitDays?.length||0} дней</Status></div>
    <div className="profit-days-summary">
     <div><span>Всего выкупили</span><b>{money(daySummary.orderedRevenue||0)}</b><small>{Number(daySummary.orderedUnits||0)} шт.</small></div>
     <div><span>Средняя сумма выкупа</span><b>{money(daySummary.averagePurchasedAmount||0)}</b><small>на 1 шт.</small></div>
     <div><span>Средние продажи в день</span><b>{money(daySummary.averageDailyRevenue||0)}</b><small>за {Number(data?.period?.days??data?.profitDays?.length??0)} дн.</small></div>
     <div><span>Расходы без рекламы</span><b className="negative">− {money(daySummary.expensesExAdvertising||0)}</b><small>себестоимость, поставка, налог</small></div>
     <div><span>Общий профит</span><b className={(daySummary.profitKnown?Number(daySummary.profit):Number(daySummary.profitEstimated))>=0?'positive':'negative'}>{daySummary.profitKnown?signed(Number(daySummary.profit||0)):daySummary.profitEstimateKnown?`≈ ${signed(Number(daySummary.profitEstimated||0))}`:'—'}</b><small>{daySummary.profitKnown?`реклама ${expenseValue(Number(daySummary.advertising||0))}`:daySummary.profitEstimateKnown?`реклама ≈ ${expenseValue(Number(daySummary.advertisingEstimated||0))} по ставке товара`:'неполные выплаты или себестоимость'}</small></div>
     <div><span>Общая маржа</span><b className={(daySummary.profitKnown?Number(daySummary.marginPercent):Number(daySummary.marginEstimatedPercent))>=0?'positive':'negative'}>{daySummary.profitKnown?`${Number(daySummary.marginPercent||0).toFixed(1)}%`:daySummary.profitEstimateKnown?`≈ ${Number(daySummary.marginEstimatedPercent||0).toFixed(1)}%`:'—'}</b><small>профит / заказы</small></div>
    </div>
    <div className="profit-days-list">{(data?.profitDays||[]).map((day:any)=><div className="profit-day-row" key={day.date}>
     <div className="profit-day-date"><b>{dayLabel(day.date)}</b><small>{day.orderedOrders} выкупов</small></div>
     <div><span>Выдано покупателям</span><strong>{money(day.orderedRevenue)}</strong><small>{day.orderedUnits} шт.</small></div>
     <div><span>Заплатит Uzum</span><strong className="positive">{money(day.payout)}</strong><small>после комиссии и удержаний</small></div>
      <div className="expense"><span>На рекламу</span><b>{adValue(Number(day.advertisingEstimated),Boolean(day.advertisingIsEstimated))}</b><small>{day.advertisingIsEstimated?'оценка по ставке товара':'факт finance/expenses'}</small></div>
     <div className="expense"><span>Расходы без рекламы</span><b>− {money(Number(day.expensesExAdvertising))}</b><small>себестоимость {money(Number(day.productCost)+Number(day.packagingAndAdditional))} • поставка {money(day.warehouseLogistics)} • налог {money(day.tax)}</small></div>
     <div className="expense"><span>Логистика</span><b>− {money(day.logistics)}</b><small>Uzum {money(day.marketplaceLogistics)} • поставка {money(day.warehouseLogistics)}</small></div>
     {(()=>{const shown=day.profitKnown?Number(day.profit):Number(day.profitEstimated);const ok=day.profitKnown||day.profitEstimateKnown;return <div className={shown>=0?'profit-day-result positive-bg':'profit-day-result negative-bg'}><span>{day.profitKnown?'Профит по поступившему факту':'Профит за день · оценка рекламы'}</span><strong>{day.profitKnown?signed(Number(day.profit)):day.profitEstimateKnown?`≈ ${signed(Number(day.profitEstimated))}`:'—'}</strong><b className={shown>=0?'positive':'negative'}>{ok?`${day.profitKnown?'':'≈ '}${pct(shown,Number(day.orderedRevenue)).toFixed(1)}% маржа`:'исходные данные неполны'}</b><small>{day.profitKnown?`выплата ${money(day.payout)} • налог ${money(day.tax)}`:`без рекламы ${signed(Number(day.profitExAdvertising))} • реклама по ставке товара`}</small></div>})()}
    </div>)}</div>
   </section>
   <section className="panel profit-flow potential-flow"><div className="panel-head"><div><h2>Потенциальная прибыль по заказам периода</h2><p>Заказы созданы в выбранном периоде, но прибыль ещё не зафиксирована выкупом. Выплата взята из API Uzum уже после комиссии и логистики.</p></div><Status tone="amber">предварительно</Status></div>
     <div className="profit-equation"><div><ReceiptText/><span>Заказано покупателями</span><b>{money(Number(m.orderedRevenue||0))}</b></div><i>−</i><div><BadgePercent/><span>Удержания Uzum</span><b>{money(Math.max(0,Number(m.orderedRevenue||0)-Number(m.orderedPayout||0)))}</b></div><i>=</i><div><CircleDollarSign/><span>Потенциальная выплата</span><b>{money(Number(m.orderedPayout||0))}</b></div><i>−</i><div><Truck/><span>Товар, поставка, налог, Буст заказов и факт ТОП</span><b>{money(Number(m.orderedCogs||0)+Number(m.orderedTaxExpense||0)+Number(m.orderedAdvertisingEstimate||0)+Number(m.orderedTopPromotionExpense||0))}</b></div><i>=</i><div className={orderedPotentialKnown&&Number(m.orderedPotentialProfit)>=0?'result positive-bg':'result negative-bg'}><TrendingUp/><span>Потенциальная прибыль</span><b>{orderedPotentialKnown?money(Number(m.orderedPotentialProfit)):'—'}</b><small>{orderedPotentialKnown?'полный расчёт':`${Number(m.orderedPayoutPendingOrders||0)} выплат без факта; покрытие ставок ${Number(m.orderedAdvertisingCoverage||0).toFixed(0)}%; свежий TOP может дополниться`}</small></div></div>
   </section>
   <section className="panel profit-flow"><div className="panel-head"><div><h2>От выкупленного товара до чистой прибыли</h2><p>Это расчёт по товарам, фактически выданным покупателям в выбранном периоде. Дата создания заказа может быть более ранней.</p></div><Status tone="green">{data?.period?.days||1} дн.</Status></div>
    <div className="profit-equation"><div><ReceiptText/><span>Выкуплено покупателями</span><b>{money(revenue)}</b></div><i>−</i><div><BadgePercent/><span>Удержания Uzum</span><b>{money(revenue-payout)}</b></div><i>=</i><div><CircleDollarSign/><span>Выплата по выкупам</span><b>{realizedInputsKnown?money(payout):'—'}</b></div><i>−</i><div><Truck/><span>Расходы после выплаты</span><b>{realizedInputsKnown?money(payout-profit):'—'}</b></div><i>=</i><div className={realizedInputsKnown&&profit>=0?'result positive-bg':'result negative-bg'}><TrendingUp/><span>{realizedProfitKnown?'Чистая прибыль':'Прибыль на сейчас'}</span><b>{realizedInputsKnown?money(profit):'—'}</b><small>{realizedProfitKnown?'финальный расчёт':'реклама свежего периода может дополниться'}</small></div></div>
   </section>
   <section className="panel"><div className="panel-head"><div><h2>За что и сколько вы платите</h2><p>Сумма, доля от оплаченных продаж и источник каждого расхода.</p></div><Status tone="blue">Всего {money(totalCosts)}</Status></div>
    <div className="profit-table"><div className="profit-table-row head"><span>Группа</span><span>Статья</span><span>Сумма</span><span>% продаж</span><span>На товар</span><span>Источник</span></div>{rows.map(row=><div className="profit-table-row" key={row.name}><span>{row.group}</span><b>{row.name}</b><strong>{expenseValue(row.value)}</strong><span>{pct(row.value,revenue).toFixed(2)}%</span><span>{expenseValue(units?row.value/units:0)}</span><small>{row.source}</small></div>)}</div>
   </section>
   <section className="panel profit-sales-panel"><div className="panel-head"><div><h2>Каждый выкуп, выданный в периоде</h2><p>Это старые и новые заказы, которые покупатели фактически получили в выбранном периоде. Нажмите строку, чтобы увидеть товары и SKU.</p></div><Status tone="green">{(data?.profitOrders||[]).length} выкупов</Status></div>
    <div className="profit-sales-table">
     <div className="profit-sale-row head"><span></span><span>Заказ / выдача</span><span>Товары</span><span>Продажа</span><span>Комиссия</span><span>Логистика Uzum</span><span>Выплата</span><span>Товар</span><span>Поставка</span><span>Налог</span><span>Буст заказов</span><span>Буст в ТОП</span><span>Профит</span></div>
     {(data?.profitOrders||[]).map((order:any)=>{const opened=Boolean(openOrders[order.id]);return <div className="profit-sale-wrap" key={order.id}>
      <button className="profit-sale-row" onClick={()=>setOpenOrders(v=>({...v,[order.id]:!opened}))}>
       <span>{opened?<ChevronDown/>:<ChevronRight/>}</span><span><b>№{order.marketplaceOrderId||order.externalId}</b><small>{new Date(order.issuedAt).toLocaleString('ru-RU',{timeZone:'Asia/Tashkent',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</small></span><span><b>{order.units} шт.</b><small>{order.items?.[0]?.title||'—'}</small></span><strong>{money(order.gross)}</strong><span className="expense">− {money(order.commission)}</span><span className="expense">− {money(order.marketplaceLogistics)}</span><b className="positive">{order.payoutReported?money(order.payout):'—'}</b><span className="expense">{order.costsKnown?`− ${money(order.productCost)}`:'—'}</span><span className="expense">{order.costsKnown?`− ${money(order.warehouseLogisticsCost)}`:'—'}</span><span className="expense">− {money(order.tax)}</span><span className="expense">{expenseValue(Number(order.orderBoost))}</span><span className="expense">{expenseValue(Number(order.topPromotion))}</span><strong className={order.profit>=0?'positive':'negative'}>{order.profitKnown?money(order.profit):'—'}<small>{order.profitKnown?`${Number(order.marginPercent||0).toFixed(1)}%`:'неполно'}</small></strong>
      </button>
      {opened&&<div className="profit-sale-items">{(order.items||[]).map((item:any)=><div key={item.id}><span>{item.title}</span><b>{item.sellerSku||'Без SKU'}</b><span>{item.quantity} шт.</span><strong>{money(item.amount)}</strong></div>)}</div>}
     </div>})}
    </div>
    <div className="profit-sales-note"><AlertTriangle size={15}/><span>{ads.allocationNote||'Буст заказов привязан к товарам по ID; только Буст в ТОП и непривязанный остаток распределены расчётно.'}</span></div>
   </section>
   {realizedProfitKnown&&<section className="panel"><div className="panel-head"><div><h2>Наблюдаемые соотношения</h2><p>Только арифметика по доступным данным периода, без нормативных порогов.</p></div><Status tone="violet">факт</Status></div><div className="profit-signals">{signals.map(({tone,icon:Icon,title,text})=><div className={tone} key={title}><Icon/><b>{title}</b><span>{text}</span></div>)}</div></section>}
   <section className="panel"><div className="panel-head"><div><h2>Прибыль по товарам</h2><p>Прибыль показывается только при наличии выплаты, себестоимости и финальной рекламы.</p></div><Status tone="green">топ по выручке</Status></div><div className="profit-products"><div className="profit-product-row head"><span>Товар</span><span>Продажи</span><span>Шт.</span><span>Прибыль</span><span>Маржа</span></div>{(data?.topProducts||[]).map((row:any)=><div className="profit-product-row" key={row.title}><b>{row.title}</b><span>{money(row.revenue)}</span><span>{row.units}</span><strong className={row.profit>=0?'positive':'negative'}>{row.profitKnown?signed(row.profit):'—'}</strong><span>{row.profitKnown?`${pct(row.profit,row.revenue).toFixed(1)}%`:'неполно'}</span></div>)}</div></section>
  </>}
 </AppShell>
}
