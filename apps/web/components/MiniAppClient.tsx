"use client";
import { useCallback, useEffect, useState } from 'react';
import '../app/miniapp.css';

// Мини-приложение Telegram: «сколько купили сегодня и сколько на этом заработали».
// Авторизации по паролю здесь нет — бэкенд проверяет подпись initData токеном
// бота, поэтому экран открывается только из бота и только у владельца.

const API = process.env.NEXT_PUBLIC_API_URL || '/api';
const PERIODS: Array<[string, string]> = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', '7 дней'], ['month', 'Месяц']];
const money = (value: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(value))} сум`;
const units = (value: number) => `${new Intl.NumberFormat('ru-RU').format(value)} шт.`;
const percent = (value: number) => `${value.toFixed(1)}%`;

type Summary = {
  period: { key: string; from: string; to: string; title: string };
  shop: string | null;
  ordered: { units: number; revenue: number; payout: number; potentialProfit: number | null; potentialProfitEstimate: number | null; costCoverage: number | null; advertisingCoverage: number | null };
  bought: { units: number; revenue: number; payout: number };
  profit: { net: number | null; marginPercent: number | null };
  expenses: { cogs: number; commission: number; commissionPercent: number; logistics: number; advertising: number; advertisingPercent: number; tax: number; otherFees: number; total: number };
  returns: { units: number; amount: number };
  notes: string[];
  generatedAt: string;
};

function tg() { return typeof window === 'undefined' ? null : (window as any).Telegram?.WebApp || null; }

/** Скрипт Telegram подключается на клиенте: без него initData недоступен. */
function useTelegram() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (tg()) { tg().ready?.(); tg().expand?.(); setReady(true); return; }
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.async = true;
    script.onload = () => { tg()?.ready?.(); tg()?.expand?.(); setReady(true); };
    script.onerror = () => setReady(true);
    document.head.appendChild(script);
  }, []);
  return ready;
}

/** Прибыль показываем числом только когда бэкенд её знает целиком, иначе — «не рассчитана». */
function Profit({ value, suffix }: { value: number | null; suffix?: string }) {
  if (value === null) return <b className="tg-unknown">не рассчитана</b>;
  return <b className={value >= 0 ? 'tg-green' : 'tg-red'}>{money(value)}{suffix || ''}</b>;
}

export default function MiniAppClient() {
  const ready = useTelegram();
  const [period, setPeriod] = useState('today');
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (key: string) => {
    setLoading(true); setError('');
    try {
      const initData = tg()?.initData || '';
      const response = await fetch(`${API}/miniapp/summary?period=${key}`, { headers: { 'x-telegram-init-data': initData }, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(Array.isArray(body?.message) ? body.message.join(', ') : body?.message || `HTTP ${response.status}`);
      setData(body as Summary);
    } catch (e: any) {
      setError(String(e?.message || 'Не удалось загрузить данные'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (ready) void load(period); }, [ready, period, load]);

  const title = data?.period.title || PERIODS.find(([key]) => key === period)?.[1] || '';
  return <div className="tg-app">
    <div className="tg-head"><h1>{data?.shop || 'Профит магазина'}</h1><span>{data ? `обновлено ${new Date(data.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tashkent' })}` : ''}</span></div>
    <div className="tg-periods">{PERIODS.map(([key, label]) => <button key={key} className={key === period ? 'on' : ''} onClick={() => setPeriod(key)}>{label}</button>)}</div>
    {error && <div className="tg-state"><b>Не получилось</b>{error}</div>}
    {!error && loading && !data && <><div className="tg-skeleton"/><div className="tg-skeleton"/><div className="tg-skeleton"/></>}
    {!error && data && <>
      <section className="tg-card">
        <h2>Выкуплено • {title}</h2>
        <div className="tg-hero"><strong>{units(data.bought.units)}</strong><small>на {money(data.bought.revenue)}</small></div>
        <div className="tg-row"><span>Выплата Uzum по выкупам</span><b>{money(data.bought.payout)}</b></div>
        <div className="tg-row big"><span>Чистая прибыль</span><Profit value={data.profit.net}/></div>
        <div className="tg-row"><span>Чистая маржа</span><b>{data.profit.marginPercent === null ? <span className="tg-unknown">—</span> : percent(data.profit.marginPercent)}</b></div>
      </section>
      <section className="tg-card">
        <h2>Заказано • ожидаемый профит</h2>
        <div className="tg-hero"><strong>{units(data.ordered.units)}</strong><small>на {money(data.ordered.revenue)}</small></div>
        <div className="tg-row"><span>Выплата Uzum по заказам</span><b>{money(data.ordered.payout)}</b></div>
        <div className="tg-row big"><span>Ожидаемая прибыль</span><Profit value={data.ordered.potentialProfit}/></div>
        {data.ordered.potentialProfit === null && data.ordered.potentialProfitEstimate !== null
          && <p className="tg-sub">Оценка: {money(data.ordered.potentialProfitEstimate)} — не факт, часть расходов по заказанному ещё не пришла от Uzum.</p>}
      </section>
      <section className="tg-card">
        <h2>Расходы по выкупленному</h2>
        <div className="tg-row"><span>Себестоимость</span><b>{money(data.expenses.cogs)}</b></div>
        <div className="tg-row"><span>Комиссия Uzum • {percent(data.expenses.commissionPercent)}</span><b>{money(data.expenses.commission)}</b></div>
        <div className="tg-row"><span>Логистика маркетплейса</span><b>{money(data.expenses.logistics)}</b></div>
        <div className="tg-row"><span>Реклама • {percent(data.expenses.advertisingPercent)} от выручки</span><b>{money(data.expenses.advertising)}</b></div>
        <div className="tg-row"><span>Налог</span><b>{money(data.expenses.tax)}</b></div>
        {data.expenses.otherFees > 0 && <div className="tg-row"><span>Прочие сборы Uzum</span><b>{money(data.expenses.otherFees)}</b></div>}
        <div className="tg-row big"><span>Всего расходов</span><b>{money(data.expenses.total)}</b></div>
      </section>
      {data.returns.units > 0 && <section className="tg-card">
        <h2>Возвраты за день</h2>
        <div className="tg-row"><span>Вернули</span><b>{units(data.returns.units)} • {money(data.returns.amount)}</b></div>
      </section>}
      <div className="tg-notes">{data.notes.map((note) => <p key={note}>{note}</p>)}</div>
    </>}
    <button className="tg-refresh" disabled={loading} onClick={() => void load(period)}>{loading ? 'Обновляю…' : 'Обновить'}</button>
  </div>;
}
