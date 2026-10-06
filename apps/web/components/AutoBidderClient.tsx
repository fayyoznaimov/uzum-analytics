"use client";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Crosshair, PauseCircle, Play, RefreshCw, ShieldCheck, Target, X } from 'lucide-react';
import AppShell from './AppShell';
import { MetricCard, Status } from './UI';
import { api, money } from '@/lib/api';

type Campaign={id:string;name:string;status:string;skuGroups:number;weeklyBudget:number|null;remainingBudget:number|null;period:{from:string|null;to:string|null;endless:boolean}|null;managed:number;paused:number};
type Policy={enabled:boolean;targetReach:number;maxBid:number;maxDrr:number|null;pausedAt:string|null;pausedNote:string|null;lastRunAt:string|null;lastBid:number|null;lastNote:string|null};
type LadderStep={position:number|null;cpm:number;impressionPercent:number};
type Keyword={adId:string;skuGroupId:string;query:string;cpm:number;stopWords:number;minBid:number;stats:{impressions:number;clicks:number;sold:number;revenue:number;spend:number;position:number|null;ctr:number|null;drr:number|null;roas:number|null};ladder:LadderStep[]|null;reach:number|null;targetCpm:number|null;policy:Policy|null;lastChange:{at:string;oldCpm:number|null;newCpm:number;reason:string}|null};
type Detail={campaign:{id:string;name:string;status:string;weeklyBudget:number|null;remainingBudget:number|null};apply:boolean;ladder:boolean;minBid:number;reachOptions:number[];period:{from:string;to:string};keywords:Keyword[]};

const num=(v:number)=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Math.round(v));
const dash=(v:number|null|undefined,f:(x:number)=>string)=>v===null||v===undefined||!Number.isFinite(v)?'—':f(v);
const date=(v:string|null)=>v?new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Asia/Tashkent'}).format(new Date(v)):'';
const dateTime=(v:string|null)=>v?new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tashkent'}).format(new Date(v)):'';

export default function AutoBidderClient(){
 const [list,setList]=useState<{apply:boolean;ladder:boolean;campaigns:Campaign[]}|null>(null);
 const [detail,setDetail]=useState<Detail|null>(null);const [selected,setSelected]=useState<string|null>(null);
 const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [editing,setEditing]=useState<Keyword|null>(null);
 const [runMsg,setRunMsg]=useState('');const [running,setRunning]=useState(false);
 const loadList=useCallback(async()=>{setLoading(true);setError('');try{setList(await api('/ads/auto-bidder/campaigns'))}catch(e:any){setList(null);setError(e.message||'Не удалось загрузить кампании')}finally{setLoading(false)}},[]);
 const loadDetail=useCallback(async(id:string)=>{setLoading(true);setError('');try{setDetail(await api(`/ads/auto-bidder/campaigns/${id}/keywords`))}catch(e:any){setDetail(null);setError(e.message||'Не удалось загрузить слова кампании')}finally{setLoading(false)}},[]);
 useEffect(()=>{void loadList()},[loadList]);
 useEffect(()=>{if(selected)void loadDetail(selected);else setDetail(null)},[selected,loadDetail]);
 const runNow=async()=>{setRunning(true);setRunMsg('');try{const r:any=await api('/ads/auto-bidder/run',{method:'POST',body:JSON.stringify({apply:false})});setRunMsg((r.messages||[]).join('\n')||(r.notes||[]).join('; ')||'Проверка выполнена');if(selected)await loadDetail(selected);else await loadList()}catch(e:any){setRunMsg(`Ошибка: ${e.message}`)}finally{setRunning(false)}};

 const totals=useMemo(()=>{const c=list?.campaigns||[];return{active:c.filter(x=>x.status==='ACTIVE').length,managed:c.reduce((s,x)=>s+x.managed,0),paused:c.reduce((s,x)=>s+x.paused,0)}},[list]);
 const kw=detail?.keywords||[];
 const attention=kw.filter(k=>k.policy?.enabled&&(k.policy.pausedAt||(k.policy.maxDrr!==null&&k.stats.drr!==null&&k.stats.drr>k.policy.maxDrr)||k.cpm>k.policy.maxBid));

 return <AppShell title="Авто-ставка" subtitle="Держим ставку слова на нужном охвате: конкурент перебил — поднимем, охват подешевел — снизим. Никогда выше вашего максимума и максимального ДРР." periodEnabled={false} actions={<><button className="ghost" onClick={()=>void runNow()} disabled={running}><RefreshCw size={16} className={running?'spin':''}/>{running?'Проверяем…':'Проверить сейчас'}</button>{selected&&<button className="ghost" onClick={()=>setSelected(null)}><ArrowLeft size={16}/>К кампаниям</button>}</>}>
 {runMsg&&<div className={`ab-run ${runMsg.startsWith('Ошибка')?'error':''}`}><pre>{runMsg}</pre><button className="ghost" onClick={()=>setRunMsg('')}><X size={14}/></button></div>}
 {error&&<div className="error-box settings-notice"><span>{error}</span><button className="ghost" onClick={()=>selected?void loadDetail(selected):void loadList()}>Повторить</button></div>}
 {loading&&<div className="loading">Загружаем из кабинета Uzum…</div>}
 {!loading&&!selected&&list&&<>
  <div className="metrics-grid"><MetricCard label="АКТИВНЫХ КАМПАНИЙ" value={String(totals.active)} tone="blue"/><MetricCard label="СЛОВ НА АВТО-СТАВКЕ" value={String(totals.managed)} tone="violet"/><MetricCard label="ПРИОСТАНОВЛЕНО ПО ДРР" value={String(totals.paused)} tone={totals.paused?'orange':'green'}/><MetricCard label="РЕЖИМ" value={list.apply?'Ставки меняются':'Только предложения'} tone={list.apply?'green':'orange'}/><MetricCard label="ЛЕСТНИЦА ОХВАТА" value={list.ladder?'Подключена':'Нет'} tone={list.ladder?'green':'gray'}/></div>
  {!list.apply&&<div className="profit-provisional"><ShieldCheck size={18}/><div><b>Автобид работает в режиме предложений</b><span>Решения пишутся в журнал и в Telegram, ставки в кабинете не меняются. Чтобы включить изменения, задайте AUTO_BIDDER_APPLY=true в .env на сервере.</span></div><Status tone="amber">предложения</Status></div>}
  {!list.ladder&&<div className="profit-provisional"><AlertTriangle size={18}/><div><b>Лестница ставок кабинета не подключена</b><span>Без неё автобид не знает цену охвата: держит ставку в пределах потолка и ДРР и поднимает её на 10%, если показов мало. Задайте AD_BID_LADDER_URL в .env — шаблон запроса кабинета с подстановками {'{campaignId}'}, {'{adId}'}, {'{skuGroupId}'}, {'{query}'}.</span></div><Status tone="amber">нет лестницы</Status></div>}
  <section className="panel"><div className="panel-head"><div><h2>Рекламные кампании «Буст в ТОП»</h2><p>Откройте кампанию, чтобы увидеть её ключевые слова и включить авто-ставку.</p></div><Status tone="blue">{list.campaigns.length} кампаний</Status></div>
   <div className="modern-table"><div className="modern-row ab-campaigns head"><span>Кампания</span><span>Период</span><span>Бюджет в неделю</span><span>Остаток</span><span>На авто-ставке</span><span>Статус</span><span></span></div>
   {list.campaigns.map(c=><div className="modern-row ab-campaigns" key={c.id}><div><b>{c.name}</b><small>ID: {c.id}{c.skuGroups?` • ${c.skuGroups} цв.`:''}</small></div><span>{c.period?(c.period.endless?'Бессрочный':`до ${date(c.period.to)}`):'—'}<small>{c.period?.from?`с ${date(c.period.from)}`:''}</small></span><span>{dash(c.weeklyBudget,money)}</span><span>{dash(c.remainingBudget,money)}</span><span>{c.managed?<Status tone={c.paused?'amber':'violet'}>{c.managed} слов{c.paused?` • ${c.paused} пауза`:''}</Status>:'—'}</span><Status tone={c.status==='ACTIVE'?'green':'gray'}>{c.status==='ACTIVE'?'Активна':'Неактивна'}</Status><button className="primary ab-open" onClick={()=>setSelected(c.id)}>Открыть</button></div>)}
   {!list.campaigns.length&&<div className="ab-empty">Кампаний «Буст в ТОП» в кабинете не найдено за последние 28 дней.</div>}</div></section>
 </>}
 {!loading&&selected&&detail&&<>
  <section className="panel ab-hero"><div className="ab-hero-main"><div className="ab-hero-icon"><Crosshair size={22}/></div><div><h2>{detail.campaign.name}</h2><p>Ключевые слова кампании, их охват и показатели за {date(detail.period.from+'T12:00:00Z')} — {date(detail.period.to+'T12:00:00Z')}</p></div></div><div className="ab-hero-side"><span>Бюджет в неделю</span><b>{dash(detail.campaign.weeklyBudget,money)}</b>{detail.campaign.remainingBudget!==null&&<small>остаток {money(detail.campaign.remainingBudget)}</small>}</div></section>
  <div className="metrics-grid"><MetricCard label="КЛЮЧЕВЫХ СЛОВ" value={String(kw.length)} tone="blue"/><MetricCard label="НА АВТО-СТАВКЕ" value={String(kw.filter(k=>k.policy?.enabled).length)} tone="violet"/><MetricCard label="ТРЕБУЮТ ВНИМАНИЯ" value={String(attention.length)} tone={attention.length?'orange':'green'}/><MetricCard label="РЕЖИМ" value={detail.apply?'Ставки меняются':'Предложения'} tone={detail.apply?'green':'orange'}/></div>
  {attention.length>0&&<div className="profit-provisional"><AlertTriangle size={18}/><div><b>Слова, где автобид упёрся в ограничения</b><span>{attention.map(k=>`«${k.query}»: ${k.policy?.pausedAt?'приостановлено по ДРР':k.cpm>(k.policy?.maxBid??0)?'ставка выше вашего максимума':'ДРР выше максимума'}`).join('; ')}</span></div><Status tone="amber">{attention.length}</Status></div>}
  <section className="panel"><div className="panel-head"><div><h2>Ключевые слова <Status tone="violet">{kw.length}</Status></h2><p>Ставка — текущая в кабинете; охват — какую долю показов она покупает по лестнице; остальное — статистика Uzum за 7 дней.</p></div><button className="ghost" onClick={()=>void loadDetail(selected)}><RefreshCw size={15}/>Обновить</button></div>
   <div className="modern-table"><div className="modern-row ab-keywords head"><span>Ключевое слово</span><span>Ставка</span><span>Охват</span><span>Показы</span><span>CTR</span><span>Клики</span><span>Продажи</span><span>Выручка</span><span>Расход</span><span>ДРР</span><span>ROAS</span><span>Ср. поз.</span><span>Действия</span></div>
   {kw.map(k=>{const p=k.policy;const on=Boolean(p?.enabled);const s=k.stats;const empty=!s.impressions&&!s.spend;return <div className={`modern-row ab-keywords${on?' on':''}`} key={k.adId}><div className="ab-word"><span className={`ab-dot${on?(p?.pausedAt?' paused':' on'):''}`}>{on?(p?.pausedAt?<PauseCircle size={14}/>:<Target size={14}/>):<Target size={14}/>}</span><div><b>{k.query}</b>{on&&p&&<small>{p.pausedAt?`пауза: ${p.pausedNote?.slice(0,90)||'ДРР'}`:`охват ${p.targetReach}% • макс. ${num(p.maxBid)}${p.maxDrr!==null?` • ДРР ≤ ${p.maxDrr}%`:''}${p.lastRunAt?` • проверено ${dateTime(p.lastRunAt)}`:''}`}</small>}</div></div><b>{num(k.cpm)}</b><span>{k.reach===null?'—':`${k.reach}%`}{k.targetCpm!==null&&on&&<small>цель {num(k.targetCpm)}</small>}</span><span>{empty?'—':num(s.impressions)}</span><span>{empty?'—':dash(s.ctr,v=>`${v.toFixed(1)}%`)}</span><span>{empty?'—':num(s.clicks)}</span><span>{empty?'—':num(s.sold)}</span><span>{empty?'—':num(s.revenue)}</span><span>{empty?'—':num(s.spend)}</span><span className={p&&p.maxDrr!==null&&s.drr!==null&&s.drr>p.maxDrr?'ab-bad':''}>{empty?'—':dash(s.drr,v=>`${v.toFixed(1)}%`)}</span><span>{empty?'—':dash(s.roas,v=>`${v.toFixed(1)}x`)}</span><span>{empty?'—':dash(s.position,v=>`~ ${v.toFixed(1)}`)}</span><button className={on?'ghost ab-btn':'primary ab-btn'} onClick={()=>setEditing(k)}>{on?<><Target size={14}/>Настроить</>:<><Play size={14}/>Включить</>}</button></div>})}
   {!kw.length&&<div className="ab-empty">В кампании нет ключевых слов типа «запрос».</div>}</div></section>
 </>}
 {editing&&detail&&<PolicyDialog keyword={editing} detail={detail} onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);if(selected)await loadDetail(selected)}}/>}
 </AppShell>
}

function PolicyDialog({keyword,detail,onClose,onSaved}:{keyword:Keyword;detail:Detail;onClose:()=>void;onSaved:()=>Promise<void>}){
 const p=keyword.policy;
 const [reach,setReach]=useState<number>(p?.targetReach??90);const [maxBid,setMaxBid]=useState<string>(String(p?.maxBid??Math.max(keyword.cpm,keyword.minBid)));const [maxDrr,setMaxDrr]=useState<string>(p?.maxDrr!==null&&p?.maxDrr!==undefined?String(p.maxDrr):'');
 const [saving,setSaving]=useState(false);const [err,setErr]=useState('');
 const ladder=keyword.ladder&&keyword.ladder.length?keyword.ladder:null;
 const priceFor=(r:number)=>{if(!ladder)return null;const sorted=[...ladder].sort((a,b)=>a.impressionPercent-b.impressionPercent||a.cpm-b.cpm);return (sorted.find(s=>s.impressionPercent>=r)??sorted[sorted.length-1])?.cpm??null};
 const bid=Number(maxBid.replace(/\s/g,''));const drr=maxDrr.trim()===''?null:Number(maxDrr.replace(',','.'));
 const target=priceFor(reach);
 const warnings:string[]=[];
 if(!Number.isFinite(bid)||bid<keyword.minBid)warnings.push(`Максимум ниже минимальной ставки по этому запросу (${num(keyword.minBid)} сум) — с ним реклама показываться не будет.`);
 else{if(bid<keyword.cpm)warnings.push(`Максимум ниже текущей ставки ${num(keyword.cpm)} — автобид опустит ставку до ${num(bid)}.`);if(target!==null&&target>bid)warnings.push(`Охват ${reach}% сейчас стоит ${num(target)} — дороже вашего максимума; автобид остановится на ${num(bid)}.`);}
 if(drr!==null&&(!Number.isFinite(drr)||drr<=0||drr>100))warnings.push('Максимальный ДРР — число от 0 до 100 %.');
 const invalid=!Number.isFinite(bid)||bid<keyword.minBid||(drr!==null&&(!Number.isFinite(drr)||drr<=0||drr>100));
 const save=async()=>{setSaving(true);setErr('');try{await api(`/ads/auto-bidder/keywords/${keyword.adId}`,{method:'PUT',body:JSON.stringify({campaignId:detail.campaign.id,skuGroupId:keyword.skuGroupId,query:keyword.query,targetReach:reach,maxBid:Math.round(bid),maxDrr:drr,enabled:true})});await onSaved()}catch(e:any){setErr(e.message||'Не удалось сохранить')}finally{setSaving(false)}};
 const disable=async()=>{setSaving(true);setErr('');try{await api(`/ads/auto-bidder/keywords/${keyword.adId}`,{method:'DELETE'});await onSaved()}catch(e:any){setErr(e.message||'Не удалось выключить')}finally{setSaving(false)}};
 return <div className="ab-overlay" onClick={onClose}><div className="ab-dialog" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true">
  <div className="ab-dialog-head"><div><h3>{p?.enabled?'Настроить авто-ставку':'Включить авто-ставку'}</h3><p>Ключевое слово: «{keyword.query}»</p></div><button className="ghost" onClick={onClose} aria-label="Закрыть"><X size={16}/></button></div>
  <div className="ab-current"><span>Текущая ставка</span><b>{num(keyword.cpm)} сум</b>{keyword.reach!==null&&<small>покупает ≈ {keyword.reach}% показов</small>}</div>
  <label className="ab-field"><span>Желаемый охват</span><select value={reach} onChange={e=>setReach(Number(e.target.value))}>{detail.reachOptions.map(r=>{const price=priceFor(r);return <option key={r} value={r}>{r}% — {price===null?(ladder?'нет данных':'цена неизвестна без лестницы'):`${num(price)} сум`}</option>})}</select><small>Ставка покупает охват показов, а не место в выдаче: Uzum ранжирует по эффективному CPM с учётом продаж, конверсии и рейтинга товара. Поэтому позицию нельзя купить ставкой, а охват — можно.</small></label>
  <label className="ab-field"><span>Максимальная ставка</span><input inputMode="numeric" value={maxBid} onChange={e=>setMaxBid(e.target.value)}/><small>Выше этой суммы ставка не поднимется ни при каких условиях. Минимальная ставка по запросу — {num(keyword.minBid)} сум.</small></label>
  <label className="ab-field"><span>Максимальный ДРР, %</span><input inputMode="decimal" placeholder="Не задан — защита выключена" value={maxDrr} onChange={e=>setMaxDrr(e.target.value)}/><small>Контроль ДРР начинается после накопления данных (расход от 30 000 сум или 20 кликов за 14 дней). При повышенном ДРР потолок ставки снижается, при устойчиво критическом — автобид приостанавливается.</small></label>
  {warnings.map(w=><div className="ab-warn" key={w}><AlertTriangle size={15}/><span>{w}</span></div>)}
  {err&&<div className="error-box">{err}</div>}
  {!detail.apply&&<div className="ab-note">Режим предложений: решения попадут в журнал и Telegram, ставка в кабинете не изменится, пока на сервере не включён AUTO_BIDDER_APPLY=true.</div>}
  <div className="ab-dialog-actions">{p?.enabled&&<button className="ghost ab-danger" onClick={()=>void disable()} disabled={saving}>Выключить</button>}<span className="ab-spacer"/><button className="ghost" onClick={onClose} disabled={saving}>Отмена</button><button className="primary" onClick={()=>void save()} disabled={saving||invalid}>{saving?'Сохраняем…':p?.enabled?'Сохранить':'Включить'}</button></div>
 </div></div>
}
