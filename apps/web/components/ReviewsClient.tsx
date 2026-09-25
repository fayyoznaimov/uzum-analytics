"use client";
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Languages, MessageSquareText, RefreshCw, Search, Send, Sparkles, Star, UserRound } from 'lucide-react';
import AppShell from './AppShell';
import { MetricCard, Status } from './UI';
import { api } from '@/lib/api';

type ReviewItem = {
 id:string;
 externalId:string;
 rating:number;
 publishedAt:string|null;
 productTitle:string;
 productImageUrl:string|null;
 skuTitle:string|null;
 sellerSku:string|null;
 customerName:string;
 content:string|null;
 pros:string|null;
 cons:string|null;
 replyStatus:string;
 replyText:string|null;
 answered:boolean;
 aiReplyText:string|null;
 aiReplyLanguage:string|null;
 aiReplyRisk:string|null;
};

function object(value:any):Record<string,any>{return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}
function text(...values:any[]){for(const value of values){if(value===null||value===undefined)continue;const result=String(value).trim();if(result)return result}return''}
function number(value:any,fallback=0){const parsed=Number(value);return Number.isFinite(parsed)?parsed:fallback}
function ratingText(value:number|null|undefined){return value?value.toFixed(2):'—'}
function Stars({value}:{value:number}){return <span className="review-stars" aria-label={`${value} из 5`}>{[1,2,3,4,5].map(star=><Star key={star} className={star<=Math.round(value)?'filled':''}/>)}</span>}
function feedItems(value:any){return Array.isArray(value?.items)?value.items:[]}
function feedSummary(value:any){return object(value?.summary)}
function normalizeReview(rawValue:any,index:number):ReviewItem{
 const raw=object(rawValue);const product=object(raw.product);const sku=object(raw.sku);const customer=object(raw.customer||raw.author);const reply=object(raw.reply||raw.sellerReply);
 const replyStatus=text(raw.replyStatus,raw.responseStatus,reply.status,raw.answerStatus);
 // Uzum не отдаёт текст ответа продавца в этой ленте (только replyStatus), так что
 // для отзывов, отвеченных через этот кабинет, единственный источник текста —
 // наш же aiReplyText, сохранённый при отправке. Для отзывов, отвеченных вручную
 // прямо в Uzum до этого бота, текста нет и взять его неоткуда.
 const replyText=text(raw.replyText,raw.sellerReplyText,reply.text,reply.content,raw.answer,raw.aiReplyText);
 const normalizedStatus=replyStatus.toUpperCase();
 const answered=raw.needsReply===undefined
  ? Boolean(raw.isAnswered??raw.answered??raw.hasReply??replyText)||['ANSWERED','REPLIED','PUBLISHED','SENT','COMPLETED'].some(status=>normalizedStatus.includes(status))
  : !Boolean(raw.needsReply);
 return{
  id:text(raw.id,raw.externalId,raw.reviewId,`review-${index}`),
  externalId:text(raw.externalId,raw.reviewId,raw.id),
  rating:Math.max(0,Math.min(5,number(raw.rating??raw.stars??raw.rate))),
  publishedAt:text(raw.dateCreated,raw.publishedAt,raw.reviewedAt,raw.createdAt,raw.date)||null,
  productTitle:text(product.title,product.name,raw.productTitle,raw.productName,raw.title,'Товар без названия'),
  productImageUrl:text(raw.productPhotoUrl,product.imageUrl,product.image,raw.productImageUrl,raw.imageUrl)||null,
  skuTitle:text(sku.title,sku.name,raw.skuTitle,raw.variantTitle,raw.skuName)||null,
  sellerSku:text(sku.sellerSku,raw.sellerSku,raw.article,sku.externalId)||null,
  customerName:raw.anonymous?'Анонимный покупатель':text(customer.name,customer.displayName,raw.customerName,raw.authorName,raw.userName,'Покупатель Uzum'),
  content:text(raw.content,raw.text,raw.comment,raw.reviewText,raw.message)||null,
  pros:text(raw.pros,raw.advantages,raw.positive)||null,
  cons:text(raw.cons,raw.disadvantages,raw.negative)||null,
  replyStatus:replyStatus|| (answered?'ANSWERED':'UNANSWERED'),
  replyText:replyText||null,
  answered,
  aiReplyText:text(raw.aiReplyText)||null,
  aiReplyLanguage:text(raw.aiReplyLanguage)||null,
  aiReplyRisk:text(raw.aiReplyRisk)||null,
 };
}
function reviewDate(value:string|null){
 if(!value)return'Дата не указана';
 const numeric=Number(value);const date=Number.isFinite(numeric)&&numeric>0?new Date(numeric<10_000_000_000?numeric*1000:numeric):new Date(value);
 return Number.isNaN(date.getTime())?'Дата не указана':new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tashkent'}).format(date);
}
function replyPresentation(item:ReviewItem){
 const status=item.replyStatus.toUpperCase();
 if(item.answered)return{label:'Есть ответ',tone:'green'};
 if(status.includes('ERROR')||status.includes('FAIL'))return{label:'Ошибка статуса',tone:'red'};
 if(status.includes('MODERAT'))return{label:'На модерации',tone:'blue'};
 return{label:'Без ответа',tone:'amber'};
}

export default function ReviewsClient(){
 const [data,setData]=useState<any>(null);const [feed,setFeed]=useState<any>(null);
 const [aggregateLoading,setAggregateLoading]=useState(true);const [feedLoading,setFeedLoading]=useState(true);
 const [aggregateError,setAggregateError]=useState('');const [feedError,setFeedError]=useState('');const [syncError,setSyncError]=useState('');const [syncNotice,setSyncNotice]=useState('');
 const [q,setQ]=useState('');const [rating,setRating]=useState('all');const [reply,setReply]=useState('all');const [feedPage,setFeedPage]=useState(1);const [syncing,setSyncing]=useState(false);
 const [autoRunning,setAutoRunning]=useState(false);
 const [generating,setGenerating]=useState('');
 const [sending,setSending]=useState('');
 const [draftEdits,setDraftEdits]=useState<Record<string,string>>({});
 async function generateDraft(id:string){
  setGenerating(id);setFeedError('');
  try{await api(`/reviews/${id}/ai-draft`,{method:'POST',body:'{}'});await loadFeed(feedPage)}catch(e:any){setFeedError(e.message||'Не удалось создать AI-ответ')}finally{setGenerating('')}
 }
 async function sendDraft(id:string,content:string){
  setSending(id);setFeedError('');
  try{await api(`/reviews/${id}/send-reply`,{method:'POST',body:JSON.stringify({content})});await loadFeed(feedPage)}catch(e:any){setFeedError(e.message||'Не удалось отправить ответ в Uzum')}finally{setSending('')}
 }
 async function loadAggregates(){setAggregateLoading(true);setAggregateError('');try{setData(await api('/reviews'))}catch(e:any){setAggregateError(e.message||'Не удалось загрузить сводку отзывов')}finally{setAggregateLoading(false)}}
 async function loadFeed(page=feedPage){
  setFeedLoading(true);setFeedError('');
  const params=new URLSearchParams({page:String(page),size:'30',filter:reply==='unanswered'?'NO_REPLY':'ALL'});
  if(/^\d$/.test(rating))params.set('rating',rating);
  if(q.trim())params.set('search',q.trim());
  try{setFeed(await api(`/reviews/feed?${params.toString()}`))}catch(e:any){setFeedError(e.message||'Не удалось загрузить тексты отзывов')}finally{setFeedLoading(false)}
 }
 useEffect(()=>{void loadAggregates()},[]);
 useEffect(()=>{setFeedPage(1)},[q,rating,reply]);
 useEffect(()=>{const timer=setTimeout(()=>void loadFeed(feedPage),250);return()=>clearTimeout(timer)},[q,rating,reply,feedPage]);
 const rawReviews=useMemo<ReviewItem[]>(()=>feedItems(feed).map((item:any,index:number)=>normalizeReview(item,index)),[feed]);
 const reviews=rawReviews;
 const aggregateItems=data?.items||[];
 const summary=data?.summary||{};const capability=data?.capability||{};const importedSummary=feedSummary(feed);const pagination=object(feed?.pagination);
 const importedTotal=number(importedSummary.total,rawReviews.length);const storedTotal=number(summary.storedReviews,importedTotal);
 const unanswered=number(importedSummary.unanswered,rawReviews.filter(item=>!item.answered).length);
 const answered=Math.max(0,importedTotal-unanswered);const totalPages=Math.max(1,number(pagination.pages,1));const currentPage=Math.max(1,number(pagination.page,feedPage));
 async function sync(){
  setSyncing(true);setSyncError('');setSyncNotice('');
  try{
   const filter=reply==='unanswered'?'NO_REPLY':'ALL';
   const result:any=await api('/reviews/sync',{method:'POST',body:JSON.stringify({filter})});
   setFeedPage(1);
   await Promise.all([loadAggregates(),loadFeed(1)]);
   const count=number(result?.saved??result?.imported??result?.records??result?.count,-1);
   setSyncNotice(result?.message|| (count>=0?`Импорт завершён: ${count} отзывов`:'Отзывы обновлены'));
  }catch(e:any){setSyncError(e.message||'Импорт отзывов не запустился')}finally{setSyncing(false)}
 }
 async function runAutoReply(){
  setAutoRunning(true);setSyncError('');setSyncNotice('');
  try{
   const result:any=await api('/reviews/auto-reply/run',{method:'POST'});
   await Promise.all([loadAggregates(),loadFeed(feedPage)]);
   setSyncNotice(result?.accepted===false&&result?.alreadyRunning
    ?'Автообработка уже выполняется'
    :`Проверено ${result?.checked??0} · создано черновиков ${result?.generated??0} · отправлено ${result?.sent??0} · на проверку ${result?.reviewRequired??0}`);
  }catch(e:any){setSyncError(e.message||'Не удалось запустить автообработку отзывов')}finally{setAutoRunning(false)}
 }
 const initialLoading=aggregateLoading&&feedLoading&&!data&&!feed;
 return <AppShell periodEnabled={false} title="Отзывы" subtitle="Реальные тексты отзывов Uzum и очередь контроля ответов" actions={<><button className="ghost" onClick={runAutoReply} disabled={autoRunning}><Sparkles size={16} className={autoRunning?'spin':''}/>{autoRunning?'Обрабатываем…':'Запустить автообработку'}</button><button className="primary" onClick={sync} disabled={syncing}><RefreshCw size={16} className={syncing?'spin':''}/>{syncing?'Импортируем…':'Импортировать отзывы'}</button></>}>
  {initialLoading?<div className="loading">Получаем отзывы из Uzum…</div>:<>
   {(aggregateError||syncError)&&<div className="review-error"><AlertTriangle/><span>{aggregateError||syncError}</span></div>}
   {syncNotice&&<div className="review-success"><CheckCircle2/><span>{syncNotice}</span></div>}
   <div className="metrics-grid four"><MetricCard label="ОТЗЫВОВ И ОЦЕНОК" value={String(summary.totalFeedbacks||0)} tone="violet"/><MetricCard label="СРЕДНИЙ РЕЙТИНГ" value={ratingText(summary.averageRating)} tone="green"/><MetricCard label="ТОВАРОВ С ОТЗЫВАМИ" value={String(summary.productsWithFeedbacks||0)} tone="blue"/><MetricCard label="РЕЙТИНГ НИЖЕ 4,5" value={String(summary.lowRatedProducts||0)} tone={summary.lowRatedProducts?'red':'green'}/></div>
   <section className="review-capability"><div><MessageSquareText/><span><b>Агрегаты подключены</b><small>{capability.source||'Uzum Seller OpenAPI'}</small></span><Status tone="green">работает</Status></div><div className={feedError?'pending':''}><Languages/><span><b>Тексты отзывов</b><small>{feedError||`В базе ${storedTotal} · в текущем фильтре ${importedTotal}`}</small></span><Status tone={feedError?'amber':'green'}>{feedError?'ошибка':'подключено'}</Status></div><div><Clock3/><span><b>Режим чтения</b><small>Ответы и AI-действия на этой странице пока не отправляются.</small></span><Status tone="gray">безопасно</Status></div></section>
   <div className="review-toolbar"><div className="search grow"><Search size={17}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Товар, SKU, покупатель или текст…"/></div><select value={rating} onChange={e=>setRating(e.target.value)}><option value="all">Все оценки</option><option value="1">1 звезда</option><option value="2">2 звезды</option><option value="3">3 звезды</option><option value="4">4 звезды</option><option value="5">5 звёзд</option></select><select value={reply} onChange={e=>setReply(e.target.value)}><option value="all">Все статусы</option><option value="unanswered">Без ответа</option></select><span>{importedTotal} найдено</span></div>
   <section className="panel review-feed"><div className="panel-head"><div><h2>Очередь отзывов</h2><p>Закреплённые и свежие отзывы из внутренней ленты Uzum. Данные доступны только для просмотра.</p></div><div className="review-feed-totals"><Status tone="amber">Без ответа {unanswered}</Status><Status tone="green">С ответом {answered}</Status></div></div>
    {feedLoading&&feed&&<div className="review-feed-refresh"><RefreshCw className="spin"/>Обновляем очередь…</div>}
    {feedLoading&&!feed?<div className="review-inline-loading"><RefreshCw className="spin"/>Загружаем тексты…</div>:feedError?<div className="review-empty"><AlertTriangle/><b>Текстовая лента недоступна</b><span>{feedError}</span><button className="ghost" onClick={()=>void loadFeed(currentPage)}>Повторить</button></div>:reviews.length?<><div className="review-feed-list">{reviews.map(item=>{const state=replyPresentation(item);return <article className={`review-card ${item.answered?'answered':'unanswered'}`} key={item.id}><header className="review-card-head"><div className="review-card-product">{item.productImageUrl?<img src={item.productImageUrl} alt=""/>:<span className="review-image-placeholder"><Star/></span>}<div><b>{item.productTitle}</b><small>{[item.skuTitle,item.sellerSku&&`SKU ${item.sellerSku}`].filter(Boolean).join(' · ')||'SKU не указан'}</small></div></div><div className="review-card-status"><div><b>{item.rating?item.rating.toFixed(1):'—'}</b><Stars value={item.rating}/></div><Status tone={state.tone}>{state.label}</Status></div></header><div className="review-card-meta"><span><UserRound/> {item.customerName}</span><span><Clock3/> {reviewDate(item.publishedAt)}</span>{item.externalId&&<span>ID {item.externalId}</span>}</div><div className="review-card-copy">{item.content&&<div className="review-copy-main"><span>Отзыв</span><p>{item.content}</p></div>}{item.pros&&<div className="review-copy-pros"><span>Плюсы</span><p>{item.pros}</p></div>}{item.cons&&<div className="review-copy-cons"><span>Минусы</span><p>{item.cons}</p></div>}{!item.content&&!item.pros&&!item.cons&&<div className="review-copy-empty">Покупатель оставил только оценку.</div>}</div>{item.answered&&<div className="review-existing-reply"><CheckCircle2/><div><span>Ответ продавца</span>{item.replyText?<p>{item.replyText}</p>:<p className="review-copy-empty">Отвечено в Uzum — текст ответа этот кабинет не видит (Uzum не отдаёт его через API), проверить можно только в приложении Uzum.</p>}</div></div>}</article>})}</div>{totalPages>1&&<div className="review-pagination"><button className="ghost" disabled={currentPage<=1||feedLoading} onClick={()=>setFeedPage(Math.max(1,currentPage-1))}><ChevronLeft/>Назад</button><span>Страница <b>{currentPage}</b> из <b>{totalPages}</b></span><button className="ghost" disabled={currentPage>=totalPages||feedLoading} onClick={()=>setFeedPage(Math.min(totalPages,currentPage+1))}>Дальше<ChevronRight/></button></div>}</>:<div className="review-empty"><MessageSquareText/><b>Ничего не найдено</b><span>{q||rating!=='all'||reply!=='all'?'Измените поиск или фильтры.':'Нажмите «Импортировать отзывы», чтобы получить текстовую ленту Uzum.'}</span></div>}
   </section>
   <section className="panel review-catalog"><div className="panel-head"><div><h2>Рейтинг по товарам</h2><p>Агрегаты из карточек магазина сохранены отдельно от импортированной текстовой ленты.</p></div><Status tone="blue">{summary.totalFeedbacks||0} всего</Status></div>{aggregateLoading&&!data?<div className="review-inline-loading"><RefreshCw className="spin"/>Загружаем агрегаты…</div>:<div className="review-product-table"><div className="review-product-row head"><span>Товар / SKU</span><span>Рейтинг</span><span>Отзывы</span><span>Остаток</span><span>Просмотры</span><span>Конверсия</span><span>Состояние</span></div>{aggregateItems.map((item:any)=><div className="review-product-row" key={item.id}><div className="review-product-name">{item.imageUrl?<img src={item.imageUrl} alt=""/>:<span className="review-image-placeholder"><Star/></span>}<span><b>{item.title}</b><small>{item.sellerSkus?.slice(0,2).join(' · ')||`ID ${item.externalId}`}</small></span></div><div><b>{item.rating?item.rating.toFixed(1):'—'}</b><Stars value={item.rating||0}/></div><strong>{item.feedbacks}</strong><span>{item.stock} шт.</span><span>{item.viewers||'—'}</span><span>{item.conversion?`${item.conversion}%`:'—'}</span><Status tone={!item.feedbacks?'gray':item.rating<4.5?'red':item.rating<4.8?'amber':'green'}>{!item.feedbacks?'нет отзывов':item.rating<4.5?'внимание':item.rating<4.8?'следить':'хорошо'}</Status></div>)}</div>}
   </section>
   <section className="panel"><div className="panel-head"><div><h2>AI-ответы на проверку</h2><p>Сначала исходный отзыв покупателя, ниже — редактируемый ответ магазина.</p></div><Status tone="green">💚 только зелёное</Status></div><div className="review-feed-list">{reviews.filter(item=>!item.answered).map(item=>{const draft=draftEdits[item.id]??item.aiReplyText??'';return <article className="review-card unanswered" key={`ai-${item.id}`}><header className="review-card-head"><div className="review-card-product">{item.productImageUrl?<img src={item.productImageUrl} alt=""/>:<span className="review-image-placeholder"><Star/></span>}<div><b>{item.productTitle}</b><small>{item.skuTitle||item.sellerSku||'SKU не указан'}</small></div></div><div className="review-card-status"><div><b>{item.rating.toFixed(1)}</b><Stars value={item.rating}/></div></div></header><div className="review-card-meta"><span><UserRound/> {item.customerName}</span><span><Clock3/> {reviewDate(item.publishedAt)}</span></div><div className="review-card-copy">{item.content&&<div className="review-copy-main"><span>Отзыв покупателя</span><p>{item.content}</p></div>}{item.pros&&<div className="review-copy-pros"><span>Плюсы</span><p>{item.pros}</p></div>}{item.cons&&<div className="review-copy-cons"><span>Минусы</span><p>{item.cons}</p></div>}{!item.content&&!item.pros&&!item.cons&&<div className="review-copy-empty">Покупатель оставил только оценку {item.rating}★.</div>}</div><div className="review-existing-reply"><MessageSquareText/><div><span>Ответ магазина</span>{item.aiReplyText?<textarea value={draft} maxLength={350} rows={3} onChange={e=>setDraftEdits({...draftEdits,[item.id]:e.target.value})}/>:<p>Черновик ещё не создан.</p>}<div className="card-actions"><Status tone={item.aiReplyRisk==='LOW'?'green':'amber'}>{item.aiReplyText?(item.aiReplyRisk==='LOW'?'можно отправлять':'нужна проверка'):'ожидает'}</Status>{item.aiReplyText&&<small>{draft.length}/350</small>}<button className="ghost" disabled={generating===item.id||sending===item.id} onClick={()=>void generateDraft(item.id)}>{generating===item.id?'Генерируем…':item.aiReplyText?'Перегенерировать':'Создать ответ'}</button>{item.aiReplyText&&<button className="primary" disabled={sending===item.id||!draft.trim()} onClick={()=>void sendDraft(item.id,draft)}><Send size={16}/>{sending===item.id?'Отправляем…':'Отправить в Uzum'}</button>}</div></div></div></article>})}</div></section>
  </>}
 </AppShell>
}
