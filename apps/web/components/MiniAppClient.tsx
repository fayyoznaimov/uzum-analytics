"use client";
import { useCallback, useEffect, useState } from 'react';
import '../app/miniapp.css';

// Мини-приложение Telegram: те же метрики, что на основном экране «Обзор», —
// продажи, выкупы, прибыль, расходы, кошелёк, реклама, склад, цели и подсказки.
// Авторизации по паролю здесь нет — бэкенд проверяет подпись initData токеном
// бота, поэтому экран открывается только из бота и только у владельца.

const API = process.env.NEXT_PUBLIC_API_URL || '/api';
const PERIODS: Array<[string, string]> = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', '7 дней'], ['month', 'Месяц']];
const money = (value: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(value))} сум`;
const short = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)} млн`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)} тыс`;
  return String(Math.round(value));
};
const units = (value: number) => `${new Intl.NumberFormat('ru-RU').format(value)} шт.`;
const percent = (value: number) => `${value.toFixed(1)}%`;
const GOALS: Record<string, string> = {
  ORDERED_REVENUE: 'Сумма заказов', REVENUE: 'Оплаченные продажи', PROFIT: 'Чистая прибыль',
  ORDERS: 'Оплаченные заказы', UNITS: 'Продано единиц', ROAS: 'Выручка / реклама',
};
const goalValue = (metric: string, value: number) => metric === 'ORDERS' || metric === 'UNITS'
  ? units(value)
  : metric === 'ROAS' ? `${value.toFixed(2)}x` : money(value);

type Summary = {
  period: { key: string; from: string; to: string; title: string };
  shop: string | null;
  ordered: { units: number; revenue: number; payout: number; potentialProfit: number | null; potentialProfitEstimate: number | null; costCoverage: number | null; advertisingCoverage: number | null };
  bought: { units: number; revenue: number; payout: number };
  profit: { net: number | null; marginPercent: number | null; current: number | null; currentMarginPercent: number | null; final: boolean; pending: string[] };
  expenses: { cogs: number; commission: number; commissionPercent: number; logistics: number; advertising: number; advertisingPercent: number; tax: number; otherFees: number; total: number };
  returns: { units: number; amount: number; orders: number };
  orders: { created: number; paid: number; waiting: number; waitingUnits: number; waitingRevenue: number };
  wallet: { availableToWithdraw: number; inReturnHold: number; dueToday: number; next7Days: number; needsReconcile: number; overallBalance: number | null; holdDays: number | null; schedule: string | null } | null;
  advertising: { expense: number; percent: number; orderBoost: number; topPromotion: number; estimate: number; hasEstimate: boolean; mayBeIncomplete: boolean };
  stock: { skus: number; endingSoon: number; recommendedSupply: number; marketplaceUnits: number; availableForSale: number; value: number; potentialPayout: number | null; reportAsOf: string | null };
  risks: Array<{ title: string; sku: string | null; stock: number; daysLeft: number | null; recommendedSupply: number | null; status: string }>;
  topProducts: Array<{ title: string; units: number; revenue: number; profit: number | null }>;
  goals: Array<{ metric: string; current: number; target: number; progress: number }>;
  stale: { cutoffDays: number; count: number; units: number; amount: number };
  waterfall: Array<{ key: string; label: string; value: number | null; percent: number; kind: string }>;
  chart: { granularity: string; points: Array<{ label: string; revenue: number }> };
  insights: Array<{ tone: string; title: string; text: string }>;
  catalog: { products: number; skus: number; supplies: number };
  notes: string[];
  generatedAt: string;
};

function tg() { return typeof window === 'undefined' ? null : (window as any).Telegram?.WebApp || null; }

const INIT_DATA_KEY = 'uzum-miniapp-init-data';

/**
 * initData из адреса страницы. Telegram кладёт подпись в фрагмент
 * (#tgWebAppData=...), а telegram-web-app.js лишь разбирает его, поэтому адрес —
 * единственный источник, который работает даже когда скрипт с telegram.org не
 * загрузился: у операторов в UZ домен telegram.org нередко режется, и тогда
 * window.Telegram не появляется вовсе.
 */
export function readInitDataFromUrl(hash: string, search: string): string {
  for (const raw of [hash, search]) {
    if (!raw) continue;
    const value = new URLSearchParams(raw.replace(/^[#?]/, '')).get('tgWebAppData');
    if (value) return value;
  }
  return '';
}

/** Подпись Telegram: из SDK, если он доступен, иначе из адреса страницы. */
function useTelegram() {
  const [state, setState] = useState<{ ready: boolean; initData: string; source: string }>({ ready: false, initData: '', source: '' });
  useEffect(() => {
    const fromUrl = readInitDataFromUrl(window.location.hash, window.location.search);
    // Переключение периода не теряет подпись, даже если Telegram вычистил фрагмент.
    try {
      if (fromUrl) sessionStorage.setItem(INIT_DATA_KEY, fromUrl);
    } catch { /* приватный режим — просто обойдёмся адресом */ }
    const stored = (() => { try { return sessionStorage.getItem(INIT_DATA_KEY) || ''; } catch { return ''; } })();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      tg()?.ready?.();
      tg()?.expand?.();
      const sdk = tg()?.initData || '';
      const initData = sdk || fromUrl || stored;
      setState({ ready: true, initData, source: sdk ? 'скрипт Telegram' : fromUrl ? 'адрес страницы' : stored ? 'сессия' : 'нет' });
    };
    if (tg()) { finish(); return; }
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.async = true;
    script.onload = finish;
    script.onerror = finish;
    document.head.appendChild(script);
    // Скрипт может висеть без ответа (заблокированный домен) — не ждём его дольше 2 секунд.
    const timer = setTimeout(finish, 2000);
    return () => clearTimeout(timer);
  }, []);
  return state;
}

/**
 * Финальное число — без оговорок. Пока период не закрыт, показываем факт
 * «на сейчас» с пометкой: прятать его целиком незачем — это не модель, а
 * пришедшие от Uzum данные, которые могут только уточниться.
 */
function Profit({ value, current, final }: { value: number | null; current?: number | null; final?: boolean }) {
  const shown = value !== null ? value : current ?? null;
  if (shown === null) return <b className="tg-unknown">не рассчитана</b>;
  return <b className={shown >= 0 ? 'tg-green' : 'tg-red'}>
    {money(shown)}
    {value === null && final !== true ? <span className="tg-tag">на сейчас</span> : null}
  </b>;
}

/** Плитка «подпись — число» для блоков с четырьмя-пятью показателями. */
function Cell({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'green' | 'red' | 'amber' }) {
  return <div className="tg-cell">
    <span>{label}</span>
    <b className={tone ? `tg-${tone}` : ''}>{value}</b>
    {hint ? <small>{hint}</small> : null}
  </div>;
}

/** Столбики выручки: без библиотек, чтобы мини-приложение грузилось мгновенно. */
function Bars({ points, granularity }: { points: Array<{ label: string; revenue: number }>; granularity: string }) {
  const max = points.reduce((top, point) => Math.max(top, point.revenue), 0);
  if (!points.length || max <= 0) return <p className="tg-sub">За период нет выкупов для графика.</p>;
  const label = (value: string) => granularity === 'day' || granularity === 'week' ? value.slice(5) : value;
  return <div className="tg-bars">{points.map((point, index) => <div className="tg-bar" key={`${point.label}-${index}`} title={`${point.label}: ${money(point.revenue)}`}>
    <i style={{ height: `${Math.max(3, point.revenue / max * 100)}%` }}/>
    <u>{label(point.label)}</u>
  </div>)}</div>;
}

export default function MiniAppClient() {
  const { ready, initData, source } = useTelegram();
  const [period, setPeriod] = useState('today');
  const [cache, setCache] = useState<Record<string, Summary>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const data = cache[period] || null;

  const load = useCallback(async (key: string, auth: string, from: string) => {
    setLoading(true); setError('');
    try {
      // Только латиница: HTTP-заголовок с кириллицей роняет запрос.
      const diagnostics = JSON.stringify({
        src: from === 'скрипт Telegram' ? 'sdk' : from === 'адрес страницы' ? 'url' : from === 'сессия' ? 'session' : 'none',
        sdk: Boolean(tg()),
        hash: typeof window === 'undefined' ? 0 : window.location.hash.length,
        platform: tg()?.platform || '',
        version: tg()?.version || '',
      });
      const response = await fetch(`${API}/miniapp/summary?period=${key}`, {
        headers: { 'x-telegram-init-data': auth, 'x-miniapp-client': diagnostics },
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (!auth) throw new Error('Telegram не передал подпись. Откройте мини-приложение кнопкой «📱 Профит сегодня» в меню бота, а не ссылкой из браузера. Если открыли кнопкой — покажите эту строку, она уже в логах сервера.');
        throw new Error(Array.isArray(body?.message) ? body.message.join(', ') : body?.message || `HTTP ${response.status}`);
      }
      setCache((loaded) => ({ ...loaded, [key]: body as Summary }));
    } catch (e: any) {
      setError(String(e?.message || 'Не удалось загрузить данные'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    // Через туннель каждый запрос стоит около секунды, поэтому остальные периоды
    // подгружаем в фоне сразу после открытого: переключение потом мгновенное.
    void (async () => {
      await load(period, initData, source);
      for (const [key] of PERIODS) if (key !== period) await load(key, initData, source);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, initData, source, load]);

  useEffect(() => {
    if (ready && !cache[period]) void load(period, initData, source);
  }, [ready, period, cache, initData, source, load]);

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
        <div className="tg-row big"><span>Чистая прибыль</span><Profit value={data.profit.net} current={data.profit.current} final={data.profit.final}/></div>
        <div className="tg-row"><span>Чистая маржа</span><b>{(data.profit.marginPercent ?? data.profit.currentMarginPercent) === null
          ? <span className="tg-unknown">—</span>
          : percent((data.profit.marginPercent ?? data.profit.currentMarginPercent) as number)}</b></div>
        {!data.profit.final && data.profit.pending.length > 0
          && <p className="tg-sub">Уточнится: {data.profit.pending.join('; ')}.</p>}
      </section>
      <section className="tg-card">
        <h2>Заказано • ожидаемый профит</h2>
        <div className="tg-hero"><strong>{units(data.ordered.units)}</strong><small>на {money(data.ordered.revenue)}</small></div>
        <div className="tg-row"><span>Выплата Uzum по заказам</span><b>{money(data.ordered.payout)}</b></div>
        <div className="tg-row big"><span>Ожидаемая прибыль</span><Profit value={data.ordered.potentialProfit} current={data.ordered.potentialProfitEstimate} final={false}/></div>
        {data.ordered.potentialProfit === null && data.ordered.potentialProfitEstimate !== null
          && <p className="tg-sub">Это оценка: часть расходов по заказанному ещё не пришла от Uzum.</p>}
      </section>

      {data.wallet && <section className="tg-card">
        <h2>Кошелёк</h2>
        <div className="tg-cells">
          <Cell label="МОЖНО ВЫВЕСТИ" value={money(data.wallet.availableToWithdraw)} tone="green"/>
          <Cell label={`В УДЕРЖАНИИ ${data.wallet.holdDays ?? '—'} ДН.`} value={money(data.wallet.inReturnHold)}/>
          <Cell label="ПО ГРАФИКУ СЕГОДНЯ" value={money(data.wallet.dueToday)}/>
          <Cell label="БЛИЖАЙШИЕ 7 ДНЕЙ" value={money(data.wallet.next7Days)}/>
        </div>
        {data.wallet.needsReconcile > 0 && <div className="tg-row"><span>Нужно сверить (прошлые даты)</span><b className="tg-red">{money(data.wallet.needsReconcile)}</b></div>}
        {data.wallet.overallBalance !== null && <div className="tg-row"><span>Общий баланс магазина</span><b>{money(data.wallet.overallBalance)}</b></div>}
        {data.wallet.schedule && <p className="tg-sub">График выплат: {data.wallet.schedule}.</p>}
      </section>}

      <section className="tg-card">
        <h2>Движение заказов</h2>
        <div className="tg-cells">
          <Cell label="СОЗДАНО ЗАКАЗОВ" value={units(data.orders.created)} hint={`${units(data.ordered.units)} в заказах`}/>
          <Cell label="ВЫКУПИЛИ" value={units(data.bought.units)} hint={`${data.orders.paid} заказов`}/>
          <Cell label="ЖДУТ ВЫКУПА" value={units(data.orders.waitingUnits)} hint={money(data.orders.waitingRevenue)} tone={data.orders.waitingUnits > 0 ? 'amber' : undefined}/>
          <Cell label="ВОЗВРАТЫ" value={units(data.returns.units)} hint={money(data.returns.amount)} tone={data.returns.units > 0 ? 'red' : undefined}/>
        </div>
        {data.stale.count > 0 && <p className="tg-sub">Висят без выкупа дольше {data.stale.cutoffDays} дн.: {data.stale.count} заказов • {units(data.stale.units)} • {money(data.stale.amount)}. На 8-й день Uzum обычно снимает бронь.</p>}
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

      <section className="tg-card">
        <h2>Реклама • ДРР {percent(data.advertising.percent)}</h2>
        <div className="tg-row"><span>Буст заказов (факт Uzum)</span><b>{money(data.advertising.orderBoost)}</b></div>
        <div className="tg-row"><span>Буст в ТОП (факт Uzum)</span><b>{money(data.advertising.topPromotion)}</b></div>
        <div className="tg-row big"><span>Всего списано</span><b>{money(data.advertising.expense)}</b></div>
        {data.advertising.hasEstimate && <p className="tg-sub">Отдельно модельная оценка свежих списаний {money(data.advertising.estimate)} — в факт и прибыль не включена.</p>}
        {data.advertising.mayBeIncomplete && <p className="tg-sub">Свежие дни ещё не финальны: Uzum списывает рекламу на следующий день.</p>}
      </section>

      <section className="tg-card">
        <h2>Динамика выкупов</h2>
        <Bars points={data.chart.points} granularity={data.chart.granularity}/>
      </section>

      {data.topProducts.length > 0 && <section className="tg-card">
        <h2>Топ товаров</h2>
        <div className="tg-list">{data.topProducts.map((row, index) => <div className="tg-item" key={`${row.title}-${index}`}>
          <i>{index + 1}</i>
          <div><strong>{row.title}</strong><span>{units(row.units)} • прибыль {row.profit === null ? 'не рассчитана' : money(row.profit)}</span></div>
          <b>{short(row.revenue)}</b>
        </div>)}</div>
      </section>}

      <section className="tg-card">
        <h2>Склад</h2>
        {/* Покрытие в днях и «довезти» есть только в отчёте Uzum по складу: без него
            не подставляем нули, а показываем то, что действительно известно. */}
        {data.stock.reportAsOf
          ? <div className="tg-cells">
            <Cell label="НА МАРКЕТПЛЕЙСЕ" value={units(data.stock.marketplaceUnits)} hint={`${data.stock.skus} SKU`}/>
            <Cell label="ЗАКАНЧИВАЮТСЯ" value={`${data.stock.endingSoon} SKU`} tone={data.stock.endingSoon > 0 ? 'amber' : undefined}/>
            <Cell label="ДОВЕЗТИ" value={units(data.stock.recommendedSupply)}/>
            <Cell label="СТОИМОСТЬ ЗАПАСА" value={money(data.stock.value)}/>
          </div>
          : <div className="tg-cells">
            <Cell label="SKU В КАТАЛОГЕ" value={String(data.stock.skus)}/>
            <Cell label="СТОИМОСТЬ ЗАПАСА" value={money(data.stock.value)}/>
          </div>}
        {!data.stock.reportAsOf && <p className="tg-sub">Отчёт Uzum по складу не загружен: покрытие в днях и «сколько довезти» считать нечем. Остатки ниже — из карточек товаров.</p>}
        {data.risks.length > 0 && <div className="tg-list">{data.risks.map((row, index) => <div className="tg-item" key={`${row.sku || row.title}-${index}`}>
          <i className={row.stock <= 5 ? 'bad' : 'warn'}>{row.stock}</i>
          <div><strong>{row.title}</strong><span>{row.sku || '—'} • {row.daysLeft === null ? 'нет отчёта по покрытию' : `запас на ${row.daysLeft} дн.`}{row.recommendedSupply ? ` • довезти ${row.recommendedSupply} шт.` : ''}</span></div>
          <b>{row.status}</b>
        </div>)}</div>}
      </section>

      {data.goals.length > 0 && <section className="tg-card">
        <h2>Цели</h2>
        <div className="tg-list">{data.goals.map((goal, index) => <div className="tg-goal" key={`${goal.metric}-${index}`}>
          <div className="tg-goal-head"><strong>{GOALS[goal.metric] || goal.metric}</strong><em>{Math.round(goal.progress)}%</em></div>
          <span>{goalValue(goal.metric, goal.current)} / {goalValue(goal.metric, goal.target)}</span>
          <div className="tg-progress"><i style={{ width: `${Math.max(0, Math.min(100, goal.progress))}%` }}/></div>
        </div>)}</div>
      </section>}

      {data.waterfall.length > 0 && <details className="tg-card tg-fold">
        <summary><h2>Разложение денег: от заказа до прибыли</h2></summary>
        <div className="tg-flow">{data.waterfall.map((row) => <div className={`tg-flow-row ${row.kind}`} key={row.key}>
          <div><span>{row.label}</span><small>{row.value === null ? 'прибыль не финальна или нет исходных данных' : row.kind === 'partial' ? 'показана только известная часть' : `${Math.abs(row.percent).toFixed(1)}% от продаж`}</small></div>
          <b>{row.value === null ? '—' : `${row.value < 0 ? '− ' : row.kind === 'subtotal' || row.kind === 'profit' || row.kind === 'loss' ? '= ' : '+ '}${money(Math.abs(row.value))}`}</b>
        </div>)}</div>
      </details>}

      {data.insights.length > 0 && <details className="tg-card tg-fold">
        <summary><h2>Умные подсказки</h2></summary>
        <div className="tg-list">{data.insights.map((row, index) => <div className={`tg-insight ${row.tone}`} key={`${row.title}-${index}`}>
          <strong>{row.title}</strong><span>{row.text}</span>
        </div>)}</div>
      </details>}

      <div className="tg-notes">
        {data.notes.map((note) => <p key={note}>{note}</p>)}
        <p>Каталог: {data.catalog.products} товаров • {data.catalog.skus} SKU • поставок за период: {data.catalog.supplies}.</p>
      </div>
    </>}
    <button className="tg-refresh" disabled={loading} onClick={() => void load(period, initData, source)}>{loading ? 'Обновляю…' : 'Обновить'}</button>
    <p className="tg-diag">подпись: {source || '—'}</p>
  </div>;
}
