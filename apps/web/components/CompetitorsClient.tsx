"use client";
import { useEffect, useState } from 'react';
import { Chrome, ExternalLink, Plus, RefreshCw, Trash2 } from 'lucide-react';
import AppShell from './AppShell';
import { Status } from './UI';
import { api, money } from '@/lib/api';

const ago=(value:string|null)=>{if(!value)return 'ещё не выходило на связь';const mins=Math.round((Date.now()-new Date(value).getTime())/60_000);if(mins<2)return 'только что';if(mins<60)return `${mins} мин назад`;const hours=Math.round(mins/60);return hours<48?`${hours} ч назад`:`${Math.round(hours/24)} дн назад`;};
const dt=(value:string)=>new Date(value).toLocaleString('ru-RU',{timeZone:'Asia/Tashkent',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});

export default function CompetitorsClient(){
 const [data,setData]=useState<any>(null);const [positions,setPositions]=useState<any[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');
 const [url,setUrl]=useState('');const [busy,setBusy]=useState('');const [notice,setNotice]=useState('');const [pairCode,setPairCode]=useState<string|null>(null);
 const load=async()=>{setLoading(true);setError('');try{const [list,pos]=await Promise.all([api('/competitors'),api('/competitors/positions').catch(()=>[])]);setData(list);setPositions(pos)}catch(e:any){setError(e.message||'Не удалось загрузить конкурентов')}finally{setLoading(false)}};
 useEffect(()=>{void load()},[]);
 async function add(){if(!url.trim())return;setBusy('add');setNotice('');try{await api('/competitors',{method:'POST',body:JSON.stringify({url})});setUrl('');await load()}catch(e:any){setNotice(e.message)}finally{setBusy('')}}
 async function remove(id:string){setBusy(id);try{await api(`/competitors/${id}`,{method:'DELETE'});await load()}catch(e:any){setNotice(e.message)}finally{setBusy('')}}
 async function pairing(){setBusy('pair');setNotice('');try{const r:any=await api('/competitors/pairing-code',{method:'POST'});setPairCode(r.code)}catch(e:any){setNotice(e.message)}finally{setBusy('')}}
 const ext=data?.extension;
 return <AppShell periodEnabled={false} title="Конкуренты" subtitle="Чужие карточки uzum.uz: цены, остатки и продажи по дельте заказов. Данные снимает ваше Chrome-расширение" actions={<button className="ghost" onClick={()=>void load()}><RefreshCw size={16}/>Обновить</button>}>
  {notice&&<div className="error-box settings-notice"><span>{notice}</span><button className="ghost" onClick={()=>setNotice('')}>Закрыть</button></div>}
  {loading?<div className="loading">Загружаем конкурентов…</div>:error?<div className="error-box settings-notice"><span>{error}</span><button className="ghost" onClick={()=>void load()}>Повторить</button></div>:<>
   <section className="panel" style={{padding:'16px 22px',display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
    <Chrome size={20} style={{color:ext?.paired?'#0E7A4E':'#9AA0AE',flexShrink:0}}/>
    <div style={{flexGrow:1}}>
     <b style={{fontSize:14}}>Chrome-расширение{ext?.paired?' подключено':' не подключено'}</b>
     <span style={{display:'block',fontSize:12.5,color:'var(--muted)'}}>{ext?.paired?`Последний сбор: ${ago(ext.lastSeenAt)}. Публичный каталог Uzum закрыт для серверов, поэтому данные снимает браузер, пока он открыт.`:'Сгенерируйте код, установите расширение «Uzum Монитор» и введите код при первом запуске.'}</span>
    </div>
    {pairCode&&<b style={{fontSize:22,letterSpacing:'.15em',background:'#F1EDFF',color:'#5536D1',borderRadius:10,padding:'8px 16px'}}>{pairCode}</b>}
    <button className="primary" disabled={busy==='pair'} onClick={pairing}>{pairCode?'Новый код':'Код для расширения'}</button>
   </section>
   <section className="panel" style={{padding:'16px 22px',display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
    <input value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void add()}} placeholder="Ссылка на карточку конкурента: https://uzum.uz/ru/product/…" style={{flexGrow:1,minWidth:280,padding:'10px 12px',border:'1px solid var(--line)',borderRadius:10,font:'inherit',fontSize:13.5,outline:'none'}}/>
    <button className="primary" disabled={busy==='add'} onClick={()=>void add()}><Plus size={16}/>Следить</button>
   </section>
   <section className="panel"><div className="panel-head"><div><h2>Карточки под наблюдением</h2><p>Продажи конкурента ≈ прирост счётчика заказов между замерами. Алерты о демпинге приходят в Telegram</p></div><Status tone="violet">{data?.competitors?.length||0}</Status></div>
    {data?.competitors?.length?<table><thead><tr><th>Товар</th><th>Цена</th><th>Изм.</th><th>Наличие</th><th>Заказов всего</th><th>+ за период</th><th>Рейтинг</th><th>Замер</th><th></th></tr></thead><tbody>
     {data.competitors.map((c:any)=><tr key={c.id}><td style={{maxWidth:320}}><a href={c.url} target="_blank" rel="noreferrer" style={{display:'flex',gap:6,alignItems:'center'}}><span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.title||`Карточка ${c.externalId}`}</span><ExternalLink size={13}/></a></td>
      <td><b>{c.latest?money(c.latest.price):'ждём замер'}</b></td>
      <td>{c.priceDeltaPercent===null?'—':<b style={{color:c.priceDeltaPercent<0?'#C2362B':c.priceDeltaPercent>0?'#0E7A4E':'inherit'}}>{c.priceDeltaPercent>0?'+':''}{c.priceDeltaPercent.toFixed(1)}%</b>}</td>
      <td>{c.latest?.available??'—'}</td><td>{c.latest?.ordersAmount??'—'}</td><td>{c.ordersDelta===null?'—':`+${c.ordersDelta}`}</td><td>{c.latest?.rating??'—'}</td>
      <td style={{color:'var(--muted)',fontSize:12.5}}>{c.latest?dt(c.latest.capturedAt):'—'}</td>
      <td><button className="ghost" disabled={busy===c.id} onClick={()=>void remove(c.id)} aria-label="Перестать следить"><Trash2 size={15}/></button></td></tr>)}
    </tbody></table>:<div className="payout-empty">Добавьте ссылки на карточки конкурентов — система начнёт снимать цены и остатки при каждом заходе расширения.</div>}
   </section>
   <section className="panel"><div className="panel-head"><div><h2>Позиции ваших карточек в поиске</h2><p>По ключевым запросам рекламного бота; собирает то же расширение</p></div><Status tone="blue">{positions.length}</Status></div>
    {positions.length?<table><thead><tr><th>Запрос</th><th>Позиция</th><th>Страница</th><th>Результатов</th><th>Замер</th></tr></thead><tbody>
     {positions.map((p:any)=><tr key={p.query}><td><b>{p.query}</b></td><td>{p.latest.position??'не в топе'}</td><td>{p.latest.page??'—'}</td><td>{p.latest.totalResults??'—'}</td><td style={{color:'var(--muted)',fontSize:12.5}}>{dt(p.latest.capturedAt)}</td></tr>)}
    </tbody></table>:<div className="payout-empty">Появятся после первого сбора расширением.</div>}
   </section>
  </>}
 </AppShell>
}
