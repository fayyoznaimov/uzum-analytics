"use client";
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import AppShell from './AppShell';
import { MetricCard, Status } from './UI';
import { api, money } from '@/lib/api';

// Расчёт потерь FBO (владелец 10.11.2026 после видео Sellium). Каждая составляющая видна отдельно; «не найдено» —
// только сверх возвратов, которые ещё могут ехать на склад; строки без истории поставок в итог не входят.
const STATUS: Record<string, [string, string]> = { check: ['Проверить', 'red'], small: ['Мелочь', 'gray'], returning: ['Возможно едут обратно', 'blue'], 'no-history': ['Нет истории поставок', 'amber'], ok: ['Всё на месте', 'green'] };
const FILTERS: Array<[string, string]> = [['problem', 'Проверить'], ['returning', 'Едут обратно'], ['no-history', 'Нет истории'], ['all', 'Все']];
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

export default function LossesClient(){
 const [data,setData]=useState<any>(null);const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [filter,setFilter]=useState('problem');const [q,setQ]=useState('');
 const load=()=>{setLoading(true);setError('');api('/warehouse/losses').then(setData).catch((e:any)=>setError(e.message)).finally(()=>setLoading(false))};
 useEffect(load,[]);
 const rows=useMemo(()=>(data?.rows||[]).filter((r:any)=>filter==='all'||(filter==='problem'?['check','small'].includes(r.status):r.status===filter)).filter((r:any)=>!q||`${r.title} ${r.sellerSku}`.toLowerCase().includes(q.toLowerCase())),[data,filter,q]);
 const count=(key:string)=>(data?.rows||[]).filter((r:any)=>key==='all'||(key==='problem'?['check','small'].includes(r.status):r.status===key)).length;
 const s=data?.summary;const c=data?.coverage;
 return <AppShell periodEnabled={false} title="Склад и поставки">
  {error&&<div className="error-box settings-notice"><span>{error}</span></div>}
  {loading&&!data?<div className="loading">Считаем, где товар…</div>:data&&<>
   <div className="metrics-grid home-metrics"><MetricCard label="ПРИНЯТО ПО НАКЛАДНЫМ" value={`${s.accepted} шт.`} sub={`${c.fboSupplies} накладных FBO с ${date(c.firstSupplyAt)}`}/><MetricCard label="ПРОДАНО" value={`${s.sold} шт.`} sub={`ещё ${s.inOrders} шт. в заказах, не выданы`} tone="green"/><MetricCard label="НА СКЛАДЕ UZUM" value={`${s.stock} шт.`} sub={`брак ${s.defective} шт.${s.defectiveUnknownSkus?` • по ${s.defectiveUnknownSkus} SKU брак не читали`:''}`} tone="blue"/><MetricCard label={s.notFound?'НЕ НАЙДЕНО':'ВСЁ НАЙДЕНО'} value={`${s.notFound} шт.`} sub={s.notFound?`≈ ${money(s.notFoundCost)} по себестоимости${s.notFoundUnitsWithoutCost?` + ${s.notFoundUnitsWithoutCost} шт. без себестоимости`:''}`:`ещё ${s.maybeReturning} шт. могут ехать обратно`} tone={s.notFound?'orange':'green'}/></div>
   {(c.ordersBeforeSupplies||c.unmatchedAccepted>0||c.unlinkedOrderUnits>0||s.noHistorySkus>0)&&<div className="profit-provisional"><AlertTriangle size={18}/><div><b>{[s.noHistorySkus?`У ${s.noHistorySkus} SKU продано и лежит больше, чем принято по накладным в базе — в итог не входят`:'',c.ordersBeforeSupplies?`заказы есть с ${date(c.firstOrderAt)}, а первая накладная — ${date(c.firstSupplyAt)}`:'',c.unmatchedAccepted?`${c.unmatchedAccepted} шт. в накладных не сопоставлены с SKU`:'',c.unlinkedOrderUnits?`${c.unlinkedOrderUnits} шт. в заказах без привязки к SKU`:''].filter(Boolean).join('; ')}</b></div><Status tone="amber">неполная история</Status></div>}
   <details className="panel collapse losses-method"><summary><div className="panel-head"><h2>Как считается</h2></div></summary><p>Принято по накладным − продано − в заказах − на складе − брак. Отмены и возвраты за {c.returnTransitDays} дней ({s.maybeReturning} шт.) считаются «возможно едут обратно»: после отказа товар неделями едет из ПВЗ на склад, это ещё не потеря. «Проверить» — когда не найдено от 3 шт. и от 10 % принятого. Вывоз товара продавцом со склада здесь не виден: если вывозили, он попадёт в «не найдено». Брак — по кабинету Uzum{c.defectSnapshotAt?` на ${date(c.defectSnapshotAt)}`:''}.</p></details>
   <div className="losses-filters">{FILTERS.map(([key,label])=><button key={key} className={filter===key?'active':''} onClick={()=>setFilter(key)}>{label} <i>{count(key)}</i></button>)}<div className="search"><Search size={16}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Поиск товара или SKU"/></div></div>
   <section className="panel table-panel"><table><thead><tr><th>Товар / SKU</th><th>Принято</th><th>Продано</th><th>В заказах</th><th>На складе</th><th>Брак</th><th>Едут обратно?</th><th>Не найдено</th><th>≈ по себестоимости</th><th>Статус</th></tr></thead><tbody>{rows.length?rows.map((r:any)=><tr key={r.skuId}><td style={{maxWidth:320}}><b style={{display:'block',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.title}</b><span>{r.sellerSku}{r.mergedSkus>1?` • ${r.mergedSkus} SKU Uzum (старый и новый)`:''}</span></td><td>{r.accepted}</td><td>{r.sold}</td><td>{r.inOrders}</td><td>{r.stock}</td><td>{r.defective??'—'}</td><td>{r.maybeReturning}</td><td>{r.status==='no-history'?<span>на {-r.gap} шт. больше принятого</span>:<b className={r.status==='check'?'negative':''}>{r.notFound}</b>}</td><td>{r.status==='no-history'||!r.notFound?'—':r.notFoundCost===null?'нет себестоимости':money(r.notFoundCost)}</td><td><Status tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Status></td></tr>):<tr><td colSpan={10} className="losses-empty">{filter==='problem'?'Расхождений нет: всё принятое либо продано, либо в заказах, либо на складе.':'Нет строк.'}</td></tr>}</tbody></table></section>
  </>}
 </AppShell>
}
