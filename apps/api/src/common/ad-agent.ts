/**
 * Агент по рекламе: советы по «Буст заказов» (CPO) и «Буст в ТОП» (кампании), цель — больше охвата
 * и трафика на товары, которые не продаются, при ДРР не выше порога (по умолчанию 10%).
 *
 * Источники (сняты со страниц «Продвижение» и «Аналитика» кабинета 26.09.2026, токен UZUM_INTERNAL, Bearer):
 *   GET  api-seller.uzum.uz/api/seller/shop/{shopId}/product/getProducts?page&size  → productList[].skuList[] (quantityActive, avgdsales)
 *   POST api-seller.uzum.uz/api/seller/cpo/advertisements/search {page,size,activeOnly,dateTo}
 *        → payload.advertisements[]: { productId, commissionPercentage, minCpoCommission, maxCpoCommission, status }
 *   GET  api-seller.uzum.uz/api/seller/advertising/management/ad-campaign?sellerId&page&size&from&to&statusGroup=ALL
 *        → payload[]: { id, name, status, period.dateFrom, budgetConfig.weeklyAmount }
 *   GET  analytics-seller.uzum.uz/cubejs-api/v1/load?query=<json>&queryType=multi → results[0].data[]
 *        кубы: SellerReportProductFunnelSku (вся воронка товара), AdvertisingCpoFunnel (реклама CPO),
 *        AdvertisingDailyFunnel (кампании «Буст в ТОП»).
 *
 * Модуль чистый: запросы Cube, разбор ответов, правила советов и текст отчёта. Сеть — в AdAgentService.
 */
import { shiftDay, sumDays } from './auto-pricing';

export const AD_AGENT_DEFAULTS = {
  maxDrrPercent: 10,
  /** Шаг повышения ставки «Буст заказов», п.п. */
  cpoStepPercent: 2,
  /** Кампания без показов столько дней после старта — ставка слишком низкая. */
  noImpressionsDays: 2,
  /** Минимальный расход за неделю, чтобы судить о ДРР кампании. */
  minSpendForDrr: 30_000,
  /** Карточка «плохо кликается», если CTR ниже медианы магазина в столько раз. */
  weakRatio: 0.7,
  /** Товар «не продаётся», если выкупов за 28 дней не больше этой доли медианы магазина. */
  slowSellerRatio: 0.5,
  /** Не разгоняем трафик, если запаса меньше стольких дней. */
  minStockDays: 7,
};
export type AdAgentConfig = typeof AD_AGENT_DEFAULTS;

// ---------- Cube.js ----------

export const CUBE_URL = 'https://analytics-seller.uzum.uz/cubejs-api/v1/load';
type CubeQuery = Record<string, unknown>;

const FUNNEL = 'SellerReportProductFunnelSku.';
const CPO = 'AdvertisingCpoFunnel.';
const TOP = 'AdvertisingDailyFunnel.';

/** Вся воронка товаров (органика + реклама) по дням. */
export function productFunnelQuery(from: string, to: string): CubeQuery {
  return {
    measures: ['sum_imps', 'sum_views', 'sum_atc', 'generated_amount', 'completed_amount'].map((m) => FUNNEL + m),
    dimensions: [FUNNEL + 'product_id'],
    timezone: 'Asia/Tashkent',
    timeDimensions: [{ dimension: FUNNEL + 'date', dateRange: [from, to], granularity: 'day' }],
    limit: 10_000,
  };
}

/** «Буст заказов» по товарам и дням. */
export function cpoFunnelQuery(productIds: string[], from: string, to: string): CubeQuery {
  return {
    measures: ['impressions', 'clicks', 'atc', 'ordered', 'issued_goods', 'earnings', 'spendings'].map((m) => CPO + m),
    dimensions: [CPO + 'product_id'],
    timezone: 'Asia/Tashkent',
    timeDimensions: [{ dimension: CPO + 'day', dateRange: [from, to], granularity: 'day' }],
    filters: [{ member: CPO + 'product_id', operator: 'equals', values: productIds }],
    limit: 10_000,
  };
}

/** Кампании «Буст в ТОП» по дням. */
export function campaignFunnelQuery(campaignIds: string[], from: string, to: string): CubeQuery {
  return {
    measures: ['impressions_sum', 'clicks_sum', 'expenses_sum', 'atc_quantity_sum', 'sold_quantity_sum', 'revenue_final'].map((m) => TOP + m),
    dimensions: [TOP + 'ad_campaign_id'],
    timezone: 'Asia/Tashkent',
    timeDimensions: [{ dimension: TOP + 'date', dateRange: [from, to], granularity: 'day' }],
    filters: [{ member: TOP + 'ad_campaign_id', operator: 'equals', values: campaignIds }],
    limit: 10_000,
  };
}

export function cubeUrl(query: CubeQuery): string {
  return `${CUBE_URL}?query=${encodeURIComponent(JSON.stringify(query))}&queryType=multi`;
}

/** Cube ещё считает: {"error":"Continue wait"} — запрос надо повторить. */
export function isCubeContinueWait(body: any): boolean {
  return /continue wait/i.test(String(body?.error ?? ''));
}

export type DailyMetrics = Map<string, Record<string, Record<string, number>>>;

/**
 * Ответ Cube → id → день → { метрика: число }. Имена метрик без префикса куба.
 * Незнакомая форма или ошибка Cube — исключение, а не «нулевые показы».
 */
export function parseCubeDaily(body: any, idMember: string, dayMember: string): DailyMetrics {
  if (body?.error) throw new Error(`Cube: ${String(body.error).slice(0, 200)}`);
  const rows = Array.isArray(body?.results?.[0]?.data) ? body.results[0].data : Array.isArray(body?.data) ? body.data : null;
  if (!rows) throw new Error('Cube: неожиданная форма ответа (нет results[0].data)');
  const result: DailyMetrics = new Map();
  for (const row of rows) {
    const id = String(row[idMember] ?? '');
    const day = String(row[`${dayMember}.day`] ?? row[dayMember] ?? '').slice(0, 10);
    if (!id || !day) continue;
    const byDay = result.get(id) ?? {};
    const metrics: Record<string, number> = byDay[day] ?? {};
    for (const [key, value] of Object.entries(row)) {
      if (key === idMember || key.startsWith(dayMember)) continue;
      if (value === null || value === undefined || value === '') continue;
      const name = key.split('.').pop() as string;
      const number = Number(value);
      if (Number.isFinite(number)) metrics[name] = (metrics[name] ?? 0) + number;
    }
    byDay[day] = metrics;
    result.set(id, byDay);
  }
  return result;
}

/** Сумма метрики по окну дней from…to включительно. */
export function windowSum(daily: DailyMetrics, id: string, metric: string, from: string, to: string): number {
  const byDay = daily.get(id) ?? {};
  const values: Record<string, number> = {};
  for (const [day, metrics] of Object.entries(byDay)) values[day] = metrics[metric] ?? 0;
  return sumDays(values, from, to);
}

export const FUNNEL_MEMBERS = { id: FUNNEL + 'product_id', day: FUNNEL + 'date' };
export const CPO_MEMBERS = { id: CPO + 'product_id', day: CPO + 'day' };
export const TOP_MEMBERS = { id: TOP + 'ad_campaign_id', day: TOP + 'date' };

// ---------- данные для правил ----------

export type Funnel = { impressions: number; views: number; atc: number; ordered: number; sold: number };
export type AdProduct = {
  productId: string;
  title: string;
  stockUnits: number;
  /** Средние продажи в день по данным кабинета (сумма avgdsales по SKU). */
  avgDailySales: number;
  /** Вся воронка товара: 28 дней, последние 7 и предыдущие 7 дней. */
  funnel28: Funnel;
  funnel7: Funnel;
  funnelPrev7: Funnel;
  cpo: null | {
    status: string;
    commission: number;
    minCommission: number;
    maxCommission: number;
    week: { impressions: number; clicks: number; ordered: number; spend: number; revenue: number };
  };
};
export type AdCampaign = {
  id: string;
  name: string;
  status: string;
  startedOn: string | null;
  weeklyBudget: number | null;
  week: { impressions: number; clicks: number; sold: number; spend: number; revenue: number };
  month: { impressions: number; clicks: number; sold: number; spend: number; revenue: number };
};

export type AdAdvice = { priority: 1 | 2 | 3 | 4; target: string; action: string; reason: string };

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);
const fmt = (value: number) => Math.round(value).toLocaleString('ru-RU');
const p1 = (value: number | null) => (value === null ? '—' : `${(Math.round(value * 10) / 10).toLocaleString('ru-RU')}%`);
const median = (values: number[]) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const drr = (spend: number, revenue: number) => pct(spend, revenue);

/** Советы по правилам. Ничего не меняет — только список действий с причинами. */
export function adAdvice(products: AdProduct[], campaigns: AdCampaign[], today: string, cfg: AdAgentConfig = AD_AGENT_DEFAULTS): AdAdvice[] {
  const advice: AdAdvice[] = [];
  const maxDrr = cfg.maxDrrPercent;

  // Кампании «Буст в ТОП».
  for (const campaign of campaigns) {
    const target = `ТОП «${campaign.name}»`;
    const weekDrr = drr(campaign.week.spend, campaign.week.revenue);
    if (campaign.status === 'ACTIVE') {
      const runningDays = campaign.startedOn ? Math.round((Date.parse(today) - Date.parse(campaign.startedOn)) / 86_400_000) : null;
      if (campaign.week.spend >= cfg.minSpendForDrr && (weekDrr === null || weekDrr > maxDrr)) {
        advice.push({ priority: 1, target, action: 'снизить ставку или поставить на паузу', reason: `ДРР за 7 дней ${weekDrr === null ? 'без продаж' : p1(weekDrr)} при расходе ${fmt(campaign.week.spend)} сум — выше ${maxDrr}%` });
      } else if (runningDays !== null && runningDays >= cfg.noImpressionsDays && campaign.week.impressions === 0) {
        advice.push({ priority: 2, target, action: 'поднять ставку (CPM)', reason: `идёт ${runningDays} дн., показов нет — ставка проигрывает аукцион` });
      } else if (weekDrr !== null && weekDrr <= maxDrr * 0.6 && campaign.weeklyBudget && campaign.week.spend >= campaign.weeklyBudget * 0.8) {
        advice.push({ priority: 3, target, action: `увеличить недельный бюджет на 30% (до ${fmt(campaign.weeklyBudget * 1.3)} сум)`, reason: `бюджет выбран на ${Math.round((campaign.week.spend / campaign.weeklyBudget) * 100)}%, ДРР ${p1(weekDrr)} — есть запас до ${maxDrr}%` });
      }
    } else if (campaign.status === 'PAUSED' && campaign.month.sold > 0) {
      const monthDrr = drr(campaign.month.spend, campaign.month.revenue);
      if (monthDrr !== null && monthDrr <= maxDrr * 0.7) {
        advice.push({ priority: 4, target, action: 'можно снова включить', reason: `за 28 дней до паузы ДРР ${p1(monthDrr)}, продано ${campaign.month.sold} шт.` });
      }
    }
  }

  // Товары: кликабельность карточки, конверсия, трафик на неидущие.
  const withTraffic = products.filter((product) => product.funnel28.impressions >= 2_000);
  const ctrMedian = median(withTraffic.map((product) => pct(product.funnel28.views, product.funnel28.impressions) as number));
  const cartMedian = median(withTraffic.filter((product) => product.funnel28.views >= 300).map((product) => pct(product.funnel28.atc, product.funnel28.views) as number));
  const soldMedian = median(products.filter((product) => product.stockUnits > 0).map((product) => product.funnel28.sold));

  for (const product of products) {
    const target = product.title;
    if (product.stockUnits <= 0) continue;
    const stockDays = product.avgDailySales > 0 ? product.stockUnits / product.avgDailySales : null;
    const lowStock = stockDays !== null && stockDays < cfg.minStockDays;
    const ctr = pct(product.funnel28.views, product.funnel28.impressions);
    const cart = pct(product.funnel28.atc, product.funnel28.views);

    if (product.cpo && product.cpo.week.spend > 0) {
      const cpoDrr = drr(product.cpo.week.spend, product.cpo.week.revenue);
      if (cpoDrr !== null && cpoDrr > maxDrr) {
        advice.push({ priority: 1, target, action: `снизить ставку «Буст заказов» (сейчас ${product.cpo.commission}%)`, reason: `ДРР за 7 дней ${p1(cpoDrr)} — выше ${maxDrr}%` });
      }
    }
    if (ctr !== null && ctrMedian !== null && product.funnel28.impressions >= 2_000 && ctr < ctrMedian * cfg.weakRatio) {
      advice.push({ priority: 2, target, action: 'улучшить карточку в выдаче: главное фото, цена, название', reason: `открывают ${p1(ctr)} показов против ${p1(ctrMedian)} по магазину — реклама купит показы, но клики будут дорогими` });
    }
    if (cart !== null && cartMedian !== null && product.funnel28.views >= 300 && cart < cartMedian * cfg.weakRatio) {
      advice.push({ priority: 3, target, action: 'проверить цену, отзывы, описание и размеры в карточке', reason: `в корзину кладут ${p1(cart)} открытий против ${p1(cartMedian)} по магазину` });
    }

    const slowSeller = soldMedian !== null && product.funnel28.sold <= soldMedian * cfg.slowSellerRatio;
    const reachDrop = product.funnelPrev7.impressions > 0 && product.funnel7.impressions < product.funnelPrev7.impressions * 0.7;
    if (!slowSeller && !reachDrop) continue;
    const why = slowSeller
      ? `выкуплено ${product.funnel28.sold} шт. за 28 дней при медиане магазина ${soldMedian}`
      : `показы упали: ${fmt(product.funnel7.impressions)} за неделю против ${fmt(product.funnelPrev7.impressions)}`;
    if (lowStock) {
      advice.push({ priority: 4, target, action: 'трафик не разгонять до поставки', reason: `${why}, но запаса ~${Math.round(stockDays as number)} дн.` });
      continue;
    }
    if (!product.cpo || product.cpo.status !== 'ACTIVE') {
      advice.push({ priority: 2, target, action: 'включить «Буст заказов» со ставкой 3–5%', reason: `${why}; платите только за выкуп — ДРР равен ставке` });
    } else {
      const next = Math.min(product.cpo.commission + cfg.cpoStepPercent, maxDrr, product.cpo.maxCommission);
      if (next > product.cpo.commission) {
        advice.push({ priority: 2, target, action: `поднять ставку «Буст заказов» с ${product.cpo.commission}% до ${next}%`, reason: `${why}; выше ставка — больше показов, ДРР останется ≤ ${maxDrr}%` });
      }
    }
  }
  return advice.sort((a, b) => a.priority - b.priority);
}

// ---------- ИИ и отчёт ----------

export function buildAdAgentPrompt(products: AdProduct[], campaigns: AdCampaign[], advice: AdAdvice[], today: string, cfg: AdAgentConfig = AD_AGENT_DEFAULTS): string {
  const productRows = products.map((product) => ({
    товар: product.title, productId: product.productId, остаток: product.stockUnits, продажВДень: Math.round(product.avgDailySales * 10) / 10,
    воронка28дн: product.funnel28, неделя: product.funnel7, прошлаяНеделя: product.funnelPrev7,
    бустЗаказов: product.cpo ? { статус: product.cpo.status, ставка: product.cpo.commission, неделя: product.cpo.week } : 'выключен',
  }));
  const campaignRows = campaigns.map((campaign) => ({ кампания: campaign.name, статус: campaign.status, старт: campaign.startedOn, бюджетНеделя: campaign.weeklyBudget, неделя: campaign.week, дни28: campaign.month }));
  return [
    'Ты — маркетолог магазина полотенец Parisa Home на маркетплейсе Uzum (Узбекистан, суммы в сумах).',
    `Сегодня ${today}. Цели владельца: больше охвата и просмотров, дополнительный трафик на товары, которые не продаются (особенно полотенца для сауны), при ДРР не выше ${cfg.maxDrrPercent}%.`,
    '«Буст заказов» — оплата процентом только за выкупленный заказ (ДРР ≈ ставке). «Буст в ТОП» — кампании с оплатой за показы (CPM) и недельным бюджетом.',
    'Воронка: impressions — показы, views — открыли карточку, atc — добавили в корзину, ordered — заказали, sold — выкупили.',
    '',
    'Данные (JSON):',
    JSON.stringify({ товары: productRows, кампанииТОП: campaignRows }, null, 1),
    '',
    'Советы правил:',
    ...advice.map((row) => `- [${row.priority}] ${row.target}: ${row.action} — ${row.reason}`),
    '',
    'Составь план на сегодня: не больше 7 пунктов, по важности, каждый — конкретное действие в кабинете и почему (с цифрами из данных).',
    'Отдельной строкой — вывод, почему не продаётся сауна, если данные это показывают. Не выдумывай цифры, которых нет в данных. Ответ — простой текст по-русски, без Markdown-таблиц.',
  ].join('\n');
}

export function formatAdReport(input: { label: string; advice: AdAdvice[]; aiPlan: string | null; aiNote: string | null; products: AdProduct[]; campaigns: AdCampaign[]; maxDrrPercent: number }): string[] {
  const shopSpend = input.campaigns.reduce((sum, row) => sum + row.week.spend, 0) + input.products.reduce((sum, row) => sum + (row.cpo?.week.spend ?? 0), 0);
  const shopRevenue = input.campaigns.reduce((sum, row) => sum + row.week.revenue, 0) + input.products.reduce((sum, row) => sum + (row.cpo?.week.revenue ?? 0), 0);
  const lines = [
    `📣 Реклама — ${input.label}`,
    'Режим: только советы — в кабинете ничего не меняется',
    `За 7 дней: расход ${fmt(shopSpend)} сум, выручка с рекламы ${fmt(shopRevenue)} сум, ДРР ${p1(drr(shopSpend, shopRevenue))} (порог ${input.maxDrrPercent}%)`,
    '',
  ];
  if (input.aiPlan) lines.push('🧠 План на сегодня:', input.aiPlan.trim(), '');
  else if (input.aiNote) lines.push(`🧠 ${input.aiNote}`, '');
  if (input.advice.length) {
    lines.push(`Советы по правилам (${input.advice.length}):`, ...input.advice.map((row) => `• ${row.target}: ${row.action} — ${row.reason}`));
  } else {
    lines.push('По правилам всё в порядке — менять ничего не нужно.');
  }
  lines.push('', 'Воронка товаров за 28 дней (показы → открыли → корзина → выкуп):');
  for (const product of [...input.products].sort((a, b) => b.funnel28.impressions - a.funnel28.impressions)) {
    const f = product.funnel28;
    lines.push(`• ${product.title}: ${fmt(f.impressions)} → ${fmt(f.views)} (${p1(pct(f.views, f.impressions))}) → ${fmt(f.atc)} → ${fmt(f.sold)} шт.; остаток ${product.stockUnits} шт.`);
  }
  const chunks: string[] = [];
  let current = '';
  for (const text of lines) {
    const piece = text.length > 3900 ? `${text.slice(0, 3899)}…` : text;
    if (current && current.length + piece.length + 1 > 3900) { chunks.push(current); current = ''; }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Окна для отчёта: 28 дней, последние 7 и предыдущие 7 полных дней до сегодня. */
export function adWindows(today: string) {
  const to = shiftDay(today, -1);
  return { from28: shiftDay(today, -28), from7: shiftDay(today, -7), fromPrev7: shiftDay(today, -14), toPrev7: shiftDay(today, -8), to };
}
