"use client";
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ClipboardList, Image as ImageIcon, Search, Star, Wand2 } from 'lucide-react';
import AppShell from './AppShell';
import { Status } from './UI';
import { api, money } from '@/lib/api';
import { useAnalyticsPeriod } from '@/lib/period';

export default function QualityClient(){
 const [data,setData]=useState<any>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [q,setQ]=useState('');const {query}=useAnalyticsPeriod();
 useEffect(()=>{setLoading(true);setError('');api(`/dashboard/overview?${query}`).then(setData).catch((e:Error)=>{setData(null);setError(e.message)}).finally(()=>setLoading(false))},[query]);
 const rows=useMemo(()=>{const needle=q.trim().toLowerCase();return(data?.topProducts||[]).filter((p:any)=>!needle||p.title?.toLowerCase().includes(needle))},[data,q]);
 const knownProfitRows=rows.filter((row:any)=>row.profitKnown===true).length;
 return <AppShell title="Качество карточек" subtitle="Только подтверждённые данные; скоринг появится после подключения каталога Uzum">
 {loading?<div className="loading">Проверяем доступные данные…</div>:error?<div className="error-box settings-notice">{error}</div>:<>
  <section className="empty-state"><Wand2/><h2>Данных для оценки качества карточек пока нет</h2><p>Текущий API не отдаёт фото, полноту описания, характеристики и другие признаки карточки. Поэтому интерфейс не рассчитывает искусственный score и не придумывает рекомендации.</p></section>
  <div className="toolbar"><div className="search grow"><Search size={17}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Поиск по доступным товарам…"/></div><Status tone="gray">без score</Status></div>
  <section className="panel"><div className="panel-head"><div><h2>Доступные коммерческие показатели</h2><p>Это топ товаров из аналитики продаж, а не оценка качества их карточек. Прибыль показывается только при полном наборе исходных данных.</p></div><Status tone="blue">прибыль рассчитана: {knownProfitRows}/{rows.length}</Status></div>{rows.length?<div className="modern-table"><div className="modern-row head" style={{gridTemplateColumns:'2fr repeat(3,1fr)',minWidth:650}}><span>Товар</span><span>Выручка</span><span>Единицы</span><span>Прибыль</span></div>{rows.map((row:any)=>{const profitKnown=row.profitKnown===true;return <div className="modern-row" style={{gridTemplateColumns:'2fr repeat(3,1fr)',minWidth:650}} key={row.id||row.title}><b>{row.title}</b><span>{money(Number(row.revenue??0))}</span><span>{Number(row.units??0)} шт.</span><strong className={profitKnown?(Number(row.profit??0)>=0?'positive':'negative'):''}>{profitKnown?money(Number(row.profit??0)):'—'}</strong></div>})}</div>:<div className="payout-empty">В доступном топе нет товаров по этому запросу.</div>}</section>
  <section className="panel"><div className="panel-head"><div><h2>Что нужно подключить для честной оценки</h2><p>После появления этих полей можно будет вводить проверяемые правила и показывать основание каждого вывода.</p></div><Status tone="blue">ожидает API</Status></div><div className="insight-grid"><div><ImageIcon/><b>Фото</b><span>Количество, разрешение и наличие инфографики.</span></div><div><ClipboardList/><b>Описание</b><span>Заполненность характеристик, размеры, состав и преимущества.</span></div><div><Star/><b>Отзывы</b><span>Рейтинг, темы негатива и ответы продавца.</span></div><div><AlertTriangle/><b>Конверсия</b><span>Показы, открытия карточки и покупки из каталога.</span></div></div></section>
 </>}
 </AppShell>
}
