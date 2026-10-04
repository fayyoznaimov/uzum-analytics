"use client";
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Status } from './UI';
import { api, money } from '@/lib/api';

const CHANNELS=[['INSTAGRAM','Instagram'],['TELEGRAM','Telegram-канал'],['BLOGGER','Блогер'],['OTHER','Другое']];
const PRODUCTS=[['2197711','Полотенца HAVANA'],['2898275','Набор J471'],['2872482','Набор J403'],['2263224','Сауна 100×150'],['2880108','Плед 100×170']];
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent'}).format(new Date());
const verdict=(e:any)=>!e?<Status tone="gray">оценка через 7 дней</Status>:e.verdict==='HELPED'?<Status tone="green">помогло</Status>:e.verdict==='NO_EFFECT'?<Status tone="amber">без эффекта</Status>:<Status tone="gray">мало данных</Status>;

/** Внешний трафик: кампании вне Uzum, оценка через 7 дней по воронке против остального магазина. */
export default function MarketingPanel(){
 const [rows,setRows]=useState<any[]>([]);const [form,setForm]=useState({channel:'INSTAGRAM',productExternalId:'2197711',startDate:today(),budget:'',note:''});const [busy,setBusy]=useState(false);const [notice,setNotice]=useState('');
 const load=()=>api<any[]>('/marketing-experiments').then(setRows).catch((e:any)=>setNotice(e.message));
 useEffect(()=>{void load()},[]);
 async function add(){setBusy(true);setNotice('');try{await api('/marketing-experiments',{method:'POST',body:JSON.stringify({...form,budget:form.budget===''?null:Number(form.budget)})});setForm({...form,budget:'',note:''});await load()}catch(e:any){setNotice(e.message)}finally{setBusy(false)}}
 async function remove(id:string){try{await api(`/marketing-experiments/${id}`,{method:'DELETE'});await load()}catch(e:any){setNotice(e.message)}}
 const product=(id:string)=>PRODUCTS.find(p=>p[0]===id)?.[1]||id;const channel=(id:string)=>CHANNELS.find(c=>c[0]===id)?.[1]||id;
 return <section className="panel"><div className="panel-head"><div><h2>Внешний трафик</h2><p>Запишите кампанию в Instagram, Telegram или у блогера — через 7 дней система сравнит воронку товара с остальным магазином и скажет, был ли эффект и сколько стоил дополнительный заказ</p></div><Status tone="violet">{rows.length}</Status></div>
  {notice&&<div className="error-box settings-notice"><span>{notice}</span><button className="ghost" onClick={()=>setNotice('')}>Закрыть</button></div>}
  <div className="mk-form"><select value={form.channel} onChange={e=>setForm({...form,channel:e.target.value})}>{CHANNELS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select><select value={form.productExternalId} onChange={e=>setForm({...form,productExternalId:e.target.value})}>{PRODUCTS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select><input type="date" value={form.startDate} onChange={e=>setForm({...form,startDate:e.target.value})} aria-label="Дата старта"/><input inputMode="numeric" placeholder="Бюджет, сум" value={form.budget} onChange={e=>setForm({...form,budget:e.target.value.replace(/[^\d]/g,'')})}/><input placeholder="Заметка (канал, креатив)" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/><button className="primary" disabled={busy} onClick={()=>void add()}><Plus size={16}/>Записать</button></div>
  {rows.length?<table><thead><tr><th>Старт</th><th>Канал</th><th>Товар</th><th>Бюджет</th><th>Итог</th><th>Подробно</th><th></th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td>{r.startDate}</td><td>{channel(r.channel)}{r.note?<small style={{display:'block',color:'var(--muted)'}}>{r.note}</small>:null}</td><td>{product(r.productExternalId)}</td><td>{r.budget?money(r.budget):'—'}</td><td>{verdict(r.evaluation)}</td><td style={{fontSize:12.5,color:'var(--muted)',maxWidth:420}}>{r.evaluation?.note||'—'}</td><td><button className="ghost" onClick={()=>void remove(r.id)} aria-label="Удалить"><Trash2 size={15}/></button></td></tr>)}</tbody></table>:<div className="payout-empty">Пока нет кампаний. Запустили пост или рекламу — запишите здесь в тот же день.</div>}
 </section>
}
