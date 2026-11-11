"use client";
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ArrowRight, WalletCards } from 'lucide-react';
import AppShell from './AppShell';
import { MetricCard, Status } from './UI';
import { compact, money } from '@/lib/api';
import { useOverview } from '@/lib/overview';

// Главная по образцу «Сигналов» Sellium (владелец 09.11.2026: «лишней хуйни нету»): четыре цифры,
// кошелёк, одна панель «что требует внимания» со вкладками-счётчиками, график и топ товаров.
// Разложение денег — на «Профите», календарь корзины — в «Кошельке», движение заказов — в «Заказах».
type SignalRow = { key: string; lead?: string; title: string; sub?: string; right?: string; tone?: string };
type Signal = { key: string; label: string; count: string; hot: boolean; tone: 'red' | 'amber' | 'gray'; href: string; link: string; empty: string; rows: SignalRow[]; note?: string };
const dayMonth = (value: string) => new Date(value).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit' });

// Каждая цифра здесь — ровно то, что считает API, без пересчёта на клиенте (деньги: дезинформация дорого стоит).
// Не выводить на Главную payoutForecast.summary.needsReconcile: это сумма ВСЕХ прошлых дат графика
// за окно кошелька (~2,5 месяца), а не недостача; и next7Days/dueToday — до вычета расходов Uzum.
function buildSignals(data: any): Signal[] {
 const risks: any[] = data.risks || []; const risksTotal = Number(data.risksTotal ?? risks.length); const stale = data.staleWaitingOrders || { count: 0, orders: [] }; const m = data.metrics || {};
 const missingCost = Number(m.realizedMissingCostItems || 0); const returned = Number(m.returnedTodayUnits || 0);
 const reportAsOf = data.inventorySummary?.reportAsOf ? new Date(data.inventorySummary.reportAsOf).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' }) : null;
 return [
  { key: 'stock', label: 'Остатки', count: String(risksTotal), hot: risksTotal > 0, tone: risks.some((r) => r.stock <= 5) ? 'red' : 'amber', href: '/warehouse', link: 'Открыть склад', empty: reportAsOf ? `По отчёту остатков Uzum от ${reportAsOf} ничего не заканчивается.` : 'Ничего не заканчивается.', note: [reportAsOf ? `По отчёту остатков Uzum от ${reportAsOf}` : 'По текущим остаткам SKU (отчёт остатков Uzum не загружен)', risksTotal > risks.length ? `показаны ${risks.length} из ${risksTotal}` : ''].filter(Boolean).join(' • '), rows: risks.map((r) => ({ key: String(r.id), title: r.title, sub: [r.sku, r.daysLeft == null ? null : `запас на ${r.daysLeft} дн.`, r.recommendedSupply ? `довезти ${r.recommendedSupply} шт.` : null].filter(Boolean).join(' • '), right: `${r.stock} шт.`, tone: r.stock <= 5 ? 'red' : 'amber' })) },
  { key: 'stale', label: 'Ждут выкупа', count: String(stale.count || 0), hot: stale.count > 0, tone: 'amber', href: '/ordered', link: 'Открыть заказы', empty: `Нет заказов, которые ждут выдачи дольше ${stale.cutoffDays ?? 7} дней.`, note: stale.count ? `${stale.count} заказов • ${stale.units} шт. • ${money(stale.amount)} — на 8-й день Uzum обычно снимает бронь` : undefined, rows: (stale.orders || []).slice(0, 8).map((o: any) => ({ key: String(o.id), lead: `${o.daysWaiting} дн.`, title: o.title, sub: `${o.sellerSku || '—'} • №${o.marketplaceOrderId || o.externalId} • заказан ${dayMonth(o.orderedAt)}`, right: money(o.amount) })) },
  { key: 'cost', label: 'Себестоимость', count: String(missingCost), hot: missingCost > 0, tone: 'amber', href: '/costs', link: 'Заполнить себестоимость', empty: 'Себестоимость есть у всех проданных позиций.', rows: missingCost ? [{ key: 'cost', title: `Нет себестоимости у ${missingCost} позиций`, sub: 'Прибыль по ним не считается и нулём не подменяется.' }] : [] },
  { key: 'returns', label: 'Возвраты', count: String(returned), hot: returned > 0, tone: 'gray', href: '/ordered', link: 'Открыть заказы', empty: 'За период возвратов нет.', rows: returned ? [{ key: 'ret', title: `Вернули ${returned} шт. за период`, sub: 'по журналу логистики возвратов Uzum' }] : [] },
 ];
}

function Signals({ data }: { data: any }) {
 const signals = buildSignals(data); const [picked, setPicked] = useState<string | null>(null);
 const active = signals.find((s) => s.key === picked) || signals.find((s) => s.hot) || signals[0];
 return <section className="panel signals"><div className="panel-head"><h2>Требует внимания</h2></div>
  <div className="sig-tabs" role="tablist">{signals.map((s) => <button key={s.key} role="tab" aria-selected={s.key === active.key} className={s.key === active.key ? 'active' : ''} onClick={() => setPicked(s.key)}><span>{s.label}</span><i className={s.hot ? s.tone : 'zero'}>{s.count}</i></button>)}</div>
  <div className="sig-body">{active.note && <p className="sig-note">{active.note}</p>}{active.rows.length ? active.rows.map((r) => <div className="sig-row" key={r.key}>{r.lead && <b className="sig-lead">{r.lead}</b>}<div><strong>{r.title}</strong>{r.sub && <span>{r.sub}</span>}</div>{r.right && <em className={r.tone || ''}>{r.right}</em>}</div>) : <div className="sig-empty">{active.empty}</div>}<a className="sig-link" href={active.href}>{active.link} <ArrowRight size={15}/></a></div>
 </section>;
}

export default function DashboardClient() {
 const { data, loading, error, reload: load, days } = useOverview();
 const pf = data?.payoutForecast; const pfToday: string = pf?.today || '';
 // «Следующая выплата» — та же строка графика, что в шапке «Кошелька»: заказы минус расходы Uzum.
 const nextPayout = (pf?.payoutDailyRows || []).find((row: any) => row.date >= pfToday) || null;
 const nextPayoutEstimate = Number(nextPayout?.expensesEstimate || 0) > 0;
 // С 11.11.2026 ближайшая выплата = накоплено по кабинету Uzum + наш прогноз того, что попадёт в корзину до даты.
 const npf = pf?.summary?.nextPayoutForecast || null;
 const orderedPayoutPending = Number(data?.metrics?.orderedPayoutPendingOrders || 0);
 // «Можно вывести» — по кабинету Uzum (снимок раз в 15 минут), время снимка обязательно. Если кабинет недоступен
 // (Cloudflare) — свежий финотчёт или наш расчёт, и подпись прямо говорит, что это расчёт: 11.11.2026 он разошёлся
 // с кабинетом на 0,9 млн (5 967 521 против 6 887 440). Старое: 10.11 стояли 170 640 сум из финотчёта на 01.08.
 const hm = (iso?: string | null) => iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
 const dm = (day?: string | null) => day ? new Date(`${day}T12:00:00+05:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '';
 const availableSource = pf?.summary?.availableSource;
 const statementAsOf = availableSource === 'financial-statement' && pf?.summary?.statementAsOf ? new Date(pf.summary.statementAsOf) : null;
 const balanceStale = availableSource !== 'cabinet';
 const balanceSource = availableSource === 'cabinet' ? `по кабинету Uzum на ${hm(pf.summary.cabinetBalanceAt)}${pf.summary.cabinetPeriodTo ? `, накоплено по ${dm(pf.summary.cabinetPeriodTo)}` : ''}` : `${statementAsOf ? `по финотчёту Uzum от ${statementAsOf.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit' })}` : 'расчёт, может отличаться от кабинета'}${pf?.summary?.cabinetBalanceAt ? ` — кабинет Uzum недоступен с ${hm(pf.summary.cabinetBalanceAt)}` : ''}`;
 const realizedInputsKnown = Number(data?.metrics?.realizedPayoutPendingOrders || 0) === 0 && Number(data?.metrics?.realizedMissingCostItems || 0) === 0;
 const realizedProfitKnown = data?.metrics?.profitKnown === true;
 return <AppShell title="Главная">
  {loading ? <div className="loading">Загружаем аналитику…</div> : error ? <div className="error-box settings-notice"><span>{error}</span><button className="ghost" onClick={() => void load()}>Повторить</button></div> : data && <>
   <div className="metrics-grid home-metrics"><MetricCard label="ЗАКАЗАНО" value={money(data.metrics.orderedRevenue)} sub={`${data.metrics.orderedUnits} шт. • ${data.metrics.orders} заказов • без отменённых и возвращённых`}/><MetricCard label={orderedPayoutPending ? 'ВЫПЛАТА UZUM • НЕ ПО ВСЕМ ЗАКАЗАМ' : 'ВЫПЛАТА UZUM ПО ЭТИМ ЗАКАЗАМ'} value={money(data.metrics.orderedPayout)} sub={orderedPayoutPending ? `без ${orderedPayoutPending} заказов: Uzum ещё не прислал по ним выплату` : 'комиссия и логистика Uzum уже вычтены'} tone={orderedPayoutPending ? 'orange' : 'green'}/><MetricCard label="ВЫКУПЛЕНО" value={money(data.metrics.revenue)} sub={`${data.metrics.paidUnits} шт. • по дате выдачи`} change={data.comparison?.deltas?.revenue} tone="orange"/><MetricCard label={realizedInputsKnown ? (realizedProfitKnown ? 'ПРИБЫЛЬ ПО ВЫКУПАМ' : 'ПРИБЫЛЬ • НЕ ФИНАЛЬНО') : 'ПРИБЫЛЬ НЕ РАССЧИТАНА'} value={realizedInputsKnown ? money(data.metrics.sellerProfitAfterAdsAndProductCost) : '—'} tone={realizedProfitKnown ? 'dark' : 'orange'}/></div>
   {!realizedInputsKnown && <div className="profit-provisional"><AlertTriangle size={18}/><div><b>Прибыль не рассчитана: {[Number(data.metrics.realizedMissingCostItems || 0) > 0 ? `нет себестоимости у ${data.metrics.realizedMissingCostItems} позиций` : '', Number(data.metrics.realizedPayoutPendingOrders || 0) > 0 ? `Uzum ещё не прислал выплату по ${data.metrics.realizedPayoutPendingOrders} выкупам` : ''].filter(Boolean).join(', ')}</b></div><Status tone="amber">неполный расчёт</Status></div>}
   {realizedInputsKnown && !realizedProfitKnown && <div className="profit-provisional"><AlertTriangle size={18}/><div><b>Прибыль на сейчас: свежие списания Uzum за рекламу ещё придут и могут её уменьшить</b></div><Status tone="amber">факт на сейчас</Status></div>}
   {pf && <section className="wallet-strip"><div className="ws-head"><div className="ws-ico"><WalletCards size={18}/></div><div><b>Кошелёк</b><span>сейчас, не зависит от периода</span></div></div><div className="ws-cell"><span>МОЖНО ВЫВЕСТИ</span><b className="good">{money(Number(pf.summary?.availableToWithdraw || 0))}</b><small className={balanceStale ? '' : 'muted'}>{balanceSource}</small></div>{npf ? <div className="ws-cell"><span>ВЫПЛАТА {new Date(`${npf.date}T12:00:00+05:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).toUpperCase()} • ПРОГНОЗ</span><b>{money(Number(npf.amount))}</b><small className="muted">накоплено {compact(Number(npf.accumulated))} + до выплаты ещё ≈ {compact(Number(npf.toCome))}</small></div> : <div className="ws-cell"><span>СЛЕДУЮЩАЯ ВЫПЛАТА{nextPayout ? `, ${new Date(`${nextPayout.date}T12:00:00+05:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : ''} • РАСЧЁТ</span><b>{nextPayout ? money(Number(nextPayout.netAmount ?? nextPayout.bankAmount)) : '—'}</b>{nextPayoutEstimate && <small>часть расходов — оценка</small>}</div>}<div className="ws-cell"><span>В УДЕРЖАНИИ {pf.holdDays} ДН.</span><b>{money(Number(pf.summary?.inReturnHold || 0))}</b></div><a href="/wallet">Открыть кошелёк <ArrowRight size={15}/></a></section>}
   <Signals data={data}/>
   <div className="home-grid">
    <section className="panel chart-panel"><div className="panel-head"><h2>Выкуплено по {data.chartGranularity === 'hour' ? 'часам' : data.chartGranularity === 'week' ? 'неделям' : data.chartGranularity === 'month' ? 'месяцам' : 'дням'}</h2><Status tone="violet">{days} дн. • {money(data.metrics.revenue)}</Status></div><div className="chart-wrap"><ResponsiveContainer width="100%" height={285}><AreaChart data={data.chart}><defs><linearGradient id="sales" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="currentColor" stopOpacity={0.32}/><stop offset="95%" stopColor="currentColor" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="label" tickFormatter={(v) => data.chartGranularity === 'day' || data.chartGranularity === 'week' ? String(v).slice(5) : String(v)}/><YAxis tickFormatter={(v) => `${Math.round(v / 1_000_000)}м`}/><Tooltip formatter={(v: any) => money(Number(v))}/><Area type="monotone" dataKey="revenue" stroke="currentColor" fill="url(#sales)" strokeWidth={3}/></AreaChart></ResponsiveContainer></div></section>
    <section className="panel"><div className="panel-head"><h2>Топ товаров по выкупам</h2><a href="/products">Все товары <ArrowRight size={15}/></a></div><div className="top-list">{data.topProducts.map((row: any, index: number) => <div className="top-row" key={`${row.title}-${index}`}><i>{index + 1}</i><div><strong>{row.title}</strong><span>{row.units} шт. • прибыль {row.profitKnown ? money(row.profit) : 'не рассчитана'}</span></div><b>{money(row.revenue)}</b></div>)}</div></section>
   </div>
  </>}
 </AppShell>;
}
