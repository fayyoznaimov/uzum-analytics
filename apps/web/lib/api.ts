const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
export function getToken() { return typeof window === 'undefined' ? null : localStorage.getItem('ua_token'); }
export function logout() { if(typeof window!=='undefined'){ localStorage.removeItem('ua_token'); window.location.href='/login'; } }
export async function api<T=any>(path:string, options:RequestInit={}) {
  const token=getToken();
  const res=await fetch(`${API}${path}`,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...(options.headers||{})},cache:'no-store'});
  if(res.status===401){logout();throw new Error('Сессия завершена');}
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.message||`HTTP ${res.status}`);
  return data as T;
}
export const money=(value:number)=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Math.round(value))+' сум';
export const compact=(value:number)=>new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:2}).format(value);

export async function syncAndWait() {
  const requestedAt = Date.now() - 2_000;
  await api('/sync/run', { method: 'POST' });
  // Полная синхронизация обычно укладывается в 3-4 минуты, но при 429 от Uzum
  // растягивается за 4:30 — раньше здесь стояло 180 попыток по 1 с (3 минуты),
  // и это чаще срабатывало как ложный таймаут, чем как реальная защита: прогон
  // на бэкенде успешно доходил до конца, а UI уже показывал ошибку. Бэкенд сам
  // считает прогон зависшим только через 10 минут (sync.service.ts, start()) —
  // подстраиваемся под то же число, чтобы не разъезжаться с ним.
  for (let attempt = 0; attempt < 300; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const runs = await api<any[]>('/sync/runs');
    const run = runs.find((item) => new Date(item.startedAt).getTime() >= requestedAt) || runs[0];
    if (!run || run.status === 'RUNNING') continue;
    if (run.status === 'SUCCESS') return run;
    throw new Error(run.message || 'Синхронизация завершилась с ошибкой');
  }
  throw new Error('Синхронизация продолжается дольше ожидаемого');
}

export async function apiForm<T=any>(path:string, form:FormData) {
  const token=getToken();
  const res=await fetch(`${API}${path}`,{method:'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:{})},body:form,cache:'no-store'});
  if(res.status===401){logout();throw new Error('Сессия завершена');}
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(Array.isArray(data.message)?data.message.join(', '):data.message||`HTTP ${res.status}`);
  return data as T;
}
