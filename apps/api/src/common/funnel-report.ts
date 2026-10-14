/**
 * Отчёт «Воронка» для разбора карточек (методика Ивана Куликовского, ecomHUB 10.10.2026):
 * показы → открытия карточки → корзина → заказ → выкуп — по магазину, товарам, цветам и SKU, по неделям.
 *
 * Источник — Cube кабинета Uzum, куб SellerReportProductFunnelSku (тот же, что у агента рекламы):
 *   sum_imps          показы карточки (поиск, каталог, реклама);
 *   sum_views         открытия карточки;
 *   sum_atc           добавления в корзину;
 *   generated_amount  заказано, шт.;
 *   completed_amount  выкуплено, шт.
 * Выкуп за период — это выдачи в эти дни, а не выкуп именно этих заказов (выдача идёт с лагом
 * в несколько дней), поэтому «заказ → выкуп» за неделю — ориентир, а не точная доля.
 * Только чтение: в кабинете ничего не меняется.
 */
import { cubeUrl } from './ad-agent';
import { shiftDay } from './auto-pricing';

const F = 'SellerReportProductFunnelSku.';
export const FUNNEL_REPORT_ROW_LIMIT = 10_000;

export type FunnelCounts = { impressions: number; views: number; atc: number; ordered: number; sold: number };
export type FunnelRates = {
  /** Открытия / показы, % (CTR). */
  ctr: number | null;
  /** Корзины / открытия, %. */
  cart: number | null;
  /** Заказы (шт.) / корзины, %. */
  order: number | null;
  /** Выкуплено / заказано, % — ориентир из-за лага выдачи. */
  buyout: number | null;
  /** Заказы / открытия, % — итоговая конверсия карточки. */
  viewToOrder: number | null;
};

/**
 * Ориентиры из доклада Куликовского (бренд косметики GAYA, Россия): CTR около 5 %, корзина около 30 %,
 * заказ из корзины 17–18 %. Для полотенец на Uzum это не норма, а точка сравнения; главное сравнение —
 * с собственным средним по магазину.
 */
export const IVAN_BENCHMARKS = { ctr: 5, cart: 30, order: 17.5 } as const;

export type StepKey = 'ctr' | 'cart' | 'order';
export const STEP_LABELS: Record<StepKey, string> = {
  ctr: 'Показ → открытие (CTR)',
  cart: 'Открытие → корзина',
  order: 'Корзина → заказ',
};
/** Чем влиять на шаг — слайд «Конверсия — главный рычаг». */
export const STEP_HINTS: Record<StepKey, string> = {
  ctr: 'главное фото, цена, рейтинг',
  cart: 'слайды 2–5, название и характеристики (SEO), отзывы и ответы на них',
  order: 'цена со скидкой, срок доставки «завтра», остаток нужного цвета и размера',
};
/** Минимум данных, чтобы судить о шаге: иначе доля скачет от пары кликов. */
const STEP_MIN = { ctr: 1_000, cart: 150, order: 15 } as const;
/** Шаг считаем слабым, если он ниже среднего по магазину больше чем на 15 %. */
const WEAK_RATIO = 0.85;

export function funnelSkuQuery(from: string, to: string, limit = FUNNEL_REPORT_ROW_LIMIT) {
  return {
    measures: ['sum_imps', 'sum_views', 'sum_atc', 'generated_amount', 'completed_amount'].map((m) => F + m),
    dimensions: [F + 'product_id', F + 'sku_id'],
    timezone: 'Asia/Tashkent',
    timeDimensions: [{ dimension: F + 'date', dateRange: [from, to], granularity: 'day' }],
    limit,
  };
}
export const funnelSkuUrl = (from: string, to: string) => cubeUrl(funnelSkuQuery(from, to));

/** Окно отчёта: `days` полных дней, последний — вчера по Ташкенту. Округляем до целых недель (7…56). */
export function funnelWindow(today: string, days = 28): { from: string; to: string; days: number } {
  const weeks = Math.min(8, Math.max(1, Math.floor((Number.isFinite(days) && days > 0 ? days : 28) / 7)));
  const to = shiftDay(today, -1);
  return { from: shiftDay(to, -(weeks * 7 - 1)), to, days: weeks * 7 };
}

export type FunnelDayRow = FunnelCounts & { productId: string; skuId: string; day: string };

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Ответ Cube → строки «товар × SKU × день». Ошибка Cube или незнакомая форма — исключение, а не нули. */
export function parseFunnelRows(body: any): FunnelDayRow[] {
  if (body?.error) throw new Error(`Cube: ${String(body.error).slice(0, 200)}`);
  const rows = Array.isArray(body?.results?.[0]?.data) ? body.results[0].data : Array.isArray(body?.data) ? body.data : null;
  if (!rows) throw new Error('Cube: неожиданная форма ответа (нет results[0].data)');
  const result: FunnelDayRow[] = [];
  for (const row of rows) {
    const productId = String(row[F + 'product_id'] ?? '');
    const day = String(row[F + 'date.day'] ?? row[F + 'date'] ?? '').slice(0, 10);
    if (!productId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    result.push({
      productId,
      skuId: String(row[F + 'sku_id'] ?? ''),
      day,
      impressions: num(row[F + 'sum_imps']),
      views: num(row[F + 'sum_views']),
      atc: num(row[F + 'sum_atc']),
      ordered: num(row[F + 'generated_amount']),
      sold: num(row[F + 'completed_amount']),
    });
  }
  return result;
}

const zero = (): FunnelCounts => ({ impressions: 0, views: 0, atc: 0, ordered: 0, sold: 0 });
const add = (target: FunnelCounts, row: FunnelCounts) => {
  target.impressions += row.impressions;
  target.views += row.views;
  target.atc += row.atc;
  target.ordered += row.ordered;
  target.sold += row.sold;
};
const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

export function funnelRates(c: FunnelCounts): FunnelRates {
  return {
    ctr: share(c.views, c.impressions),
    cart: share(c.atc, c.views),
    order: share(c.ordered, c.atc),
    buyout: share(c.sold, c.ordered),
    viewToOrder: share(c.ordered, c.views),
  };
}

export type SkuInfo = {
  skuId: string;
  productId: string;
  productTitle: string;
  /** Цвет для группировки (см. skuColor). */
  color: string | null;
  size: string | null;
  stock: number | null;
  /** Название SKU из кабинета без префикса продавца, например «HAVANA-ХРОМ-50X90». */
  title?: string | null;
};

/** Сокращения цветов в названиях SKU магазина → названия цветов на Uzum. */
const COLOR_ABBR: Array<[string, string]> = [
  ['ЗЕЛХАК', 'Зелёный хаки'], ['СВЕТКОР', 'Светло-коричневый'], ['ПАСТКОР', 'Пастельно-коралловый'], ['ПРИГХАК', 'Приглушённый хаки'],
  ['БЕЖЕВ', 'Бежевый'], ['ШОКОЛ', 'Шоколадный'], ['МОЛОЧ', 'Молочный'], ['КРЕМОВ', 'Кремовый'], ['ПРОЗР', 'Прозрачный'],
  ['РОЗОВ', 'Розовый'], ['СИРЕН', 'Сиреневый'], ['МЯТН', 'Мятный'], ['ГОЛУБ', 'Голубой'], ['ПЕРСИК', 'Персиковый'], ['КОРИЧН', 'Коричневый'],
];
const SIZE_TOKEN = /^\d+\s*[XХ×*]\s*\d+(?:\s*[/+]\s*\d+\s*[XХ×*]\s*\d+)*$/i;
const TYPE_TOKEN = /^(?:ЛИЦ|БАН|САУН|КОМПЛ|НАБОР|МИКС|MIX|SET|ДЛЯ)/i;

export const cleanSkuTitle = (value: unknown) => String(value ?? '').replace(/^FAYYOZ-/i, '').replace(/\s+/g, ' ').trim();

/**
 * Цвет SKU для группировки воронки. Порядок: поле цвета → характеристика «Цвет»/«Rang» из кабинета →
 * слово цвета в названии SKU («HAVANA-ХРОМ-50X90» → «Хром»). Поле Sku.color из синхронизации обычно пустое,
 * а коды поставок (recognizeSupplySku) сводят «Хром» и «Серый» в один код — для воронки это не годится.
 */
export function skuColor(input: { color?: string | null; characteristics?: unknown; titles?: Array<string | null | undefined> }): string | null {
  const direct = String(input.color ?? '').trim();
  if (direct) return direct;
  if (Array.isArray(input.characteristics)) {
    for (const item of input.characteristics as any[]) {
      const name = String(item?.title ?? item?.name ?? item?.characteristic?.title ?? '');
      const value = String(item?.value?.title ?? item?.value?.text ?? item?.value ?? '').trim();
      if (/^(цвет|rang|color)/i.test(name) && value && !value.startsWith('#')) return value;
    }
  }
  for (const title of input.titles ?? []) {
    const tokens = cleanSkuTitle(title).toUpperCase().replace(/[‐‑‒–—−]/g, '-').split('-').map((token) => token.trim()).filter(Boolean);
    const rest = (tokens.length > 1 ? tokens.slice(1) : tokens).filter((token) => !SIZE_TOKEN.test(token) && !TYPE_TOKEN.test(token) && !/^\d+$/.test(token) && /[А-ЯЁA-Z]/.test(token));
    if (!rest.length) continue;
    const word = rest.join(' ');
    const known = COLOR_ABBR.find(([abbr]) => word.startsWith(abbr));
    if (known) return known[1];
    return word.charAt(0) + word.slice(1).toLowerCase();
  }
  return null;
}

const colorKey = (info: SkuInfo | undefined, skuId: string) => info?.color?.trim() || (skuId ? 'цвет не указан' : 'без SKU');
export type FunnelWeek = { from: string; to: string; label: string };
export type FunnelLine = {
  key: string;
  label: string;
  counts: FunnelCounts;
  rates: FunnelRates;
  /** Недели от старой к новой, как в `report.weeks`. */
  weeks: FunnelCounts[];
  stock: number | null;
};
export type WeakStep = { step: StepKey; label: string; hint: string; rate: number; shopRate: number; ratio: number; benchmark: number };
export type FunnelProduct = FunnelLine & { productId: string; weakStep: WeakStep | null; colors: FunnelLine[]; skus: FunnelLine[] };
export type FunnelReport = {
  today: string;
  from: string;
  to: string;
  days: number;
  weeks: FunnelWeek[];
  shop: FunnelLine;
  daily: Array<{ day: string; counts: FunnelCounts }>;
  products: FunnelProduct[];
  /** Предупреждения — показываются первыми. */
  warnings: string[];
  notes: string[];
};

const shortDay = (key: string) => `${key.slice(8, 10)}.${key.slice(5, 7)}`;

/** Самый слабый шаг товара относительно магазина (только где хватает данных). */
export function weakStep(line: FunnelLine, shop: FunnelLine): WeakStep | null {
  const base: Record<StepKey, number> = { ctr: line.counts.impressions, cart: line.counts.views, order: line.counts.atc };
  let worst: WeakStep | null = null;
  for (const step of ['ctr', 'cart', 'order'] as StepKey[]) {
    const rate = line.rates[step];
    const shopRate = shop.rates[step];
    if (rate === null || shopRate === null || shopRate <= 0 || base[step] < STEP_MIN[step]) continue;
    const ratio = rate / shopRate;
    if (ratio >= WEAK_RATIO) continue;
    if (!worst || ratio < worst.ratio) worst = { step, label: STEP_LABELS[step], hint: STEP_HINTS[step], rate, shopRate, ratio, benchmark: IVAN_BENCHMARKS[step] };
  }
  return worst;
}

export function buildFunnelReport(input: { rows: FunnelDayRow[]; skus: SkuInfo[]; today: string; from: string; to: string; truncated?: boolean }): FunnelReport {
  const { from, to } = input;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const weekCount = Math.max(1, Math.floor(days / 7));
  const weeks: FunnelWeek[] = [];
  for (let index = weekCount - 1; index >= 0; index--) {
    const weekTo = shiftDay(to, -7 * index);
    const weekFrom = shiftDay(weekTo, -6);
    weeks.push({ from: weekFrom, to: weekTo, label: `${shortDay(weekFrom)}–${shortDay(weekTo)}` });
  }
  const weekIndex = (day: string) => weeks.findIndex((week) => day >= week.from && day <= week.to);

  const skuInfo = new Map(input.skus.map((sku) => [sku.skuId, sku]));
  const productTitle = new Map<string, string>();
  for (const sku of input.skus) if (!productTitle.has(sku.productId)) productTitle.set(sku.productId, sku.productTitle);

  type Acc = { counts: FunnelCounts; weeks: FunnelCounts[] };
  const acc = (): Acc => ({ counts: zero(), weeks: weeks.map(zero) });
  const shopAcc = acc();
  const dailyMap = new Map<string, FunnelCounts>();
  const products = new Map<string, { acc: Acc; colors: Map<string, Acc>; skus: Map<string, Acc> }>();

  for (const row of input.rows) {
    if (row.day < from || row.day > to) continue;
    const w = weekIndex(row.day);
    const put = (target: Acc) => {
      add(target.counts, row);
      if (w >= 0) add(target.weeks[w], row);
    };
    put(shopAcc);
    const daily = dailyMap.get(row.day) ?? zero();
    add(daily, row);
    dailyMap.set(row.day, daily);
    const product = products.get(row.productId) ?? { acc: acc(), colors: new Map(), skus: new Map() };
    put(product.acc);
    const info = skuInfo.get(row.skuId);
    const colorName = colorKey(info, row.skuId);
    const color = product.colors.get(colorName) ?? acc();
    put(color);
    product.colors.set(colorName, color);
    const skuKey = row.skuId || '—';
    const sku = product.skus.get(skuKey) ?? acc();
    put(sku);
    product.skus.set(skuKey, sku);
    products.set(row.productId, product);
  }

  const line = (key: string, label: string, a: Acc, stock: number | null): FunnelLine => ({ key, label, counts: a.counts, rates: funnelRates(a.counts), weeks: a.weeks, stock });
  const shop = line('shop', 'Весь магазин', shopAcc, null);
  const stockOf = (filter: (sku: SkuInfo) => boolean) => {
    const matched = input.skus.filter(filter);
    return matched.length && matched.every((sku) => sku.stock !== null) ? matched.reduce((sum, sku) => sum + (sku.stock as number), 0) : null;
  };

  const productLines: FunnelProduct[] = [...products.entries()].map(([productId, product]) => {
    const colors = [...product.colors.entries()]
      .map(([color, a]) => line(color, color, a, stockOf((sku) => sku.productId === productId && colorKey(sku, sku.skuId) === color)))
      .sort((a, b) => b.counts.impressions - a.counts.impressions);
    const skus = [...product.skus.entries()]
      .map(([skuId, a]) => {
        const info = skuInfo.get(skuId);
        const label = cleanSkuTitle(info?.title) || [info?.color, info?.size].map((part) => part?.trim()).filter(Boolean).join(' · ') || `SKU ${skuId}`;
        return line(skuId, label, a, info?.stock ?? null);
      })
      .sort((a, b) => b.counts.ordered - a.counts.ordered || b.counts.views - a.counts.views);
    const base = line(productId, productTitle.get(productId) || `Товар ${productId}`, product.acc, stockOf((sku) => sku.productId === productId));
    return { ...base, productId, weakStep: weakStep(base, shop), colors, skus };
  });
  productLines.sort((a, b) => b.counts.impressions - a.counts.impressions);

  const daily: Array<{ day: string; counts: FunnelCounts }> = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) daily.push({ day, counts: dailyMap.get(day) ?? zero() });

  const notes = [
    'Источник: аналитика кабинета Uzum (куб SellerReportProductFunnelSku), дни по Ташкенту, последний день — вчера.',
    '«Заказ → выкуп» за неделю — ориентир: выкуп считается по дню выдачи, а не по дню заказа.',
    `Ориентиры Куликовского (косметика GAYA): CTR около ${IVAN_BENCHMARKS.ctr} %, корзина около ${IVAN_BENCHMARKS.cart} %, заказ из корзины 17–18 %. Главное сравнение — со средним по своему магазину.`,
    'Слабый шаг — тот, где товар ниже среднего по магазину больше чем на 15 %, при минимуме данных: 1 000 показов для CTR, 150 открытий для корзины, 15 корзин для заказа.',
  ];
  const warnings: string[] = [];
  if (input.truncated) warnings.push(`Внимание: Cube вернул ${FUNNEL_REPORT_ROW_LIMIT} строк — это предел, последние дни могли не попасть. Сократите период.`);

  return { today: input.today, from, to, days, weeks, shop, daily, products: productLines, warnings, notes };
}

// ---------- вывод ----------

const fmt = (value: number) => Math.round(value).toLocaleString('ru-RU');
const p1 = (value: number | null) => (value === null ? '—' : `${(Math.round(value * 10) / 10).toLocaleString('ru-RU')}%`);
const change = (now: number, before: number) => (before > 0 ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}%` : now > 0 ? 'новое' : '—');
const lastTwo = (lineValue: FunnelLine) => {
  const n = lineValue.weeks.length;
  return { last: lineValue.weeks[n - 1] ?? zero(), prev: n > 1 ? lineValue.weeks[n - 2] : null };
};
const countsLine = (c: FunnelCounts) => {
  const r = funnelRates(c);
  return `${fmt(c.impressions)} → ${fmt(c.views)} (${p1(r.ctr)}) → корзина ${fmt(c.atc)} (${p1(r.cart)}) → заказ ${fmt(c.ordered)} (${p1(r.order)}) → выкуп ${fmt(c.sold)}`;
};

/** Текст для лога GitHub Actions. */
export function renderFunnelText(report: FunnelReport): string[] {
  const lines = [
    ...report.warnings.map((warning) => `ВНИМАНИЕ: ${warning}`),
    `Воронка продаж ${report.from} … ${report.to} (${report.days} дн.)`,
    'показы → открытия (CTR) → корзина (% от открытий) → заказ, шт. (% от корзин) → выкуп, шт.',
    '',
    `Магазин: ${countsLine(report.shop.counts)}`,
    ...report.weeks.map((week, index) => `  ${week.label}: ${countsLine(report.shop.weeks[index])}`),
    '',
  ];
  for (const product of report.products) {
    const { last, prev } = lastTwo(product);
    lines.push(`■ ${product.label} (${product.productId})${product.stock !== null ? `, остаток ${fmt(product.stock)} шт.` : ''}`);
    lines.push(`  ${report.days} дн.: ${countsLine(product.counts)}`);
    if (prev) lines.push(`  неделя к неделе: показы ${change(last.impressions, prev.impressions)}, открытия ${change(last.views, prev.views)}, заказы ${change(last.ordered, prev.ordered)}`);
    if (product.weakStep) {
      const w = product.weakStep;
      lines.push(`  слабый шаг: ${w.label} — ${p1(w.rate)} против ${p1(w.shopRate)} по магазину; влиять: ${w.hint}`);
    }
    for (const color of product.colors.slice(0, 12)) lines.push(`    ${color.label}: ${countsLine(color.counts)}${color.stock !== null ? `; остаток ${fmt(color.stock)}` : ''}`);
    if (product.colors.length > 12) lines.push(`    … ещё ${product.colors.length - 12} цв. — в HTML-отчёте`);
    lines.push('');
  }
  lines.push(...report.notes.map((note) => `* ${note}`));
  return lines;
}

const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

function rateCell(rate: number | null, shopRate: number | null, benchmark?: number, enoughData = true) {
  if (rate === null) return '<td class="num muted">—</td>';
  const tone = enoughData && shopRate !== null && shopRate > 0 ? (rate < shopRate * WEAK_RATIO ? 'bad' : rate > shopRate * 1.15 ? 'good' : '') : '';
  const title = [shopRate !== null ? `магазин ${p1(shopRate)}` : '', benchmark ? `ориентир Ивана ${p1(benchmark)}` : '', enoughData ? '' : 'мало данных'].filter(Boolean).join(' · ');
  return `<td class="num ${tone}" title="${esc(title)}">${esc(p1(rate))}</td>`;
}

function funnelRow(label: string, c: FunnelCounts, shop: FunnelLine, extra = '') {
  const r = funnelRates(c);
  return `<tr><th scope="row">${label}</th><td class="num">${fmt(c.impressions)}</td><td class="num">${fmt(c.views)}</td>${rateCell(r.ctr, shop.rates.ctr, IVAN_BENCHMARKS.ctr, c.impressions >= STEP_MIN.ctr)}<td class="num">${fmt(c.atc)}</td>${rateCell(r.cart, shop.rates.cart, IVAN_BENCHMARKS.cart, c.views >= STEP_MIN.cart)}<td class="num">${fmt(c.ordered)}</td>${rateCell(r.order, shop.rates.order, IVAN_BENCHMARKS.order, c.atc >= STEP_MIN.order)}<td class="num">${fmt(c.sold)}</td>${rateCell(r.buyout, null)}${extra}</tr>`;
}

const HEAD = (first: string, extra = '') => `<thead><tr><th scope="col">${first}</th><th scope="col">Показы</th><th scope="col">Открытия</th><th scope="col">CTR</th><th scope="col">Корзина</th><th scope="col">% корзины</th><th scope="col">Заказы, шт.</th><th scope="col">% заказа</th><th scope="col">Выкуп, шт.</th><th scope="col">% выкупа</th>${extra}</tr></thead>`;

function funnelSteps(c: FunnelCounts) {
  const r = funnelRates(c);
  const steps = [
    { label: 'Показы', value: c.impressions, rate: null as number | null, rateLabel: '' },
    { label: 'Открытия', value: c.views, rate: r.ctr, rateLabel: 'CTR' },
    { label: 'Корзина', value: c.atc, rate: r.cart, rateLabel: 'от открытий' },
    { label: 'Заказы', value: c.ordered, rate: r.order, rateLabel: 'от корзин' },
    { label: 'Выкуп', value: c.sold, rate: r.buyout, rateLabel: 'от заказов' },
  ];
  const max = Math.max(1, c.impressions);
  return `<div class="steps">${steps
    .map((step) => {
      const width = Math.max(2, Math.sqrt(step.value / max) * 100);
      return `<div class="step"><div class="step-head"><span>${step.label}</span><b>${fmt(step.value)}</b></div><div class="bar"><span style="width:${width.toFixed(1)}%"></span></div><div class="step-rate">${step.rate === null ? '&nbsp;' : `${esc(p1(step.rate))} ${step.rateLabel}`}</div></div>`;
    })
    .join('')}</div>`;
}

function dailyChart(daily: FunnelReport['daily']) {
  if (!daily.length) return '';
  const w = 720, h = 200, pad = 28;
  const peak = Math.max(0, ...daily.map((d) => d.counts.ordered));
  const maxOrders = Math.max(1, peak);
  const step = (w - pad * 2) / daily.length;
  const bars = daily
    .map((d, index) => {
      const bh = (d.counts.ordered / maxOrders) * (h - pad * 2);
      const x = pad + index * step + 1;
      const y = h - pad - bh;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, step - 2).toFixed(1)}" height="${bh.toFixed(1)}"><title>${esc(d.day)}: заказов ${fmt(d.counts.ordered)}, открытий ${fmt(d.counts.views)}, CTR ${esc(p1(funnelRates(d.counts).ctr))}</title></rect>`;
    })
    .join('');
  const ticks = daily
    .filter((_, index) => index % 7 === 0 || index === daily.length - 1)
    .map((d) => `<text x="${(pad + daily.indexOf(d) * step + step / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(shortDay(d.day))}</text>`)
    .join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Заказы по дням"><text x="${pad}" y="18" class="axis">${peak > 0 ? `заказы по дням, максимум ${fmt(peak)} шт.` : 'заказов за период нет'}</text>${bars}${ticks}</svg>`;
}

/** Самодостаточный HTML для встречи: без внешних библиотек и шрифтов, светлая и тёмная тема. */
export function renderFunnelHtml(report: FunnelReport): string {
  const weekHead = report.weeks.map((week) => `<th scope="col">${esc(week.label)}</th>`).join('');
  const weekly = HEAD('Неделя') + `<tbody>${report.weeks.map((week, index) => funnelRow(esc(week.label), report.shop.weeks[index], report.shop)).join('')}</tbody>`;
  const overview = HEAD('Товар', '<th scope="col">Остаток</th><th scope="col">Слабый шаг</th>') +
    `<tbody>${report.products
      .map((product) => funnelRow(`<a href="#p${esc(product.productId)}">${esc(product.label)}</a>`, product.counts, report.shop, `<td class="num">${product.stock === null ? '—' : fmt(product.stock)}</td><td>${product.weakStep ? esc(product.weakStep.label) : '<span class="muted">—</span>'}</td>`))
      .join('')}</tbody>`;
  const productBlocks = report.products
    .map((product) => {
      const { last, prev } = lastTwo(product);
      const trend = report.weeks
        .map((week, index) => {
          const c = product.weeks[index];
          const r = funnelRates(c);
          return `<td class="num">${fmt(c.ordered)}<small>${esc(p1(r.ctr))} · ${esc(p1(r.cart))}</small></td>`;
        })
        .join('');
      const weak = product.weakStep
        ? `<p class="callout"><b>Слабый шаг: ${esc(product.weakStep.label)}</b> — ${esc(p1(product.weakStep.rate))} против ${esc(p1(product.weakStep.shopRate))} в среднем по магазину (ориентир Ивана ${esc(p1(product.weakStep.benchmark))}). Чем влиять: ${esc(product.weakStep.hint)}.</p>`
        : '<p class="muted">Ни один шаг не ниже среднего по магазину больше чем на 15 % (или мало данных).</p>';
      const wow = prev ? `<p class="muted">Последняя неделя к предыдущей: показы ${esc(change(last.impressions, prev.impressions))}, открытия ${esc(change(last.views, prev.views))}, корзины ${esc(change(last.atc, prev.atc))}, заказы ${esc(change(last.ordered, prev.ordered))}.</p>` : '';
      return `<section class="product" id="p${esc(product.productId)}">
<h3>${esc(product.label)} <span class="muted">· ${esc(product.productId)}${product.stock !== null ? ` · остаток ${fmt(product.stock)} шт.` : ''}</span></h3>
${funnelSteps(product.counts)}
${weak}${wow}
<div class="scroll"><table><thead><tr><th scope="col">По неделям</th>${weekHead}</tr></thead><tbody><tr><th scope="row">Заказы, шт.<small>CTR · % корзины</small></th>${trend}</tr></tbody></table></div>
<h4>Цвета</h4>
<div class="scroll"><table>${HEAD('Цвет', '<th scope="col">Остаток</th>')}<tbody>${product.colors.map((color) => funnelRow(esc(color.label), color.counts, report.shop, `<td class="num">${color.stock === null ? '—' : fmt(color.stock)}</td>`)).join('')}</tbody></table></div>
<details><summary>Все SKU (${product.skus.length})</summary><div class="scroll"><table>${HEAD('SKU', '<th scope="col">Остаток</th>')}<tbody>${product.skus.map((sku) => funnelRow(`${esc(sku.label)}<small>${esc(sku.key)}</small>`, sku.counts, report.shop, `<td class="num">${sku.stock === null ? '—' : fmt(sku.stock)}</td>`)).join('')}</tbody></table></div></details>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Воронка Parisa Home</title>
<style>
:root{--bg:#f7f6f3;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e3e1dc;--accent:#2f6f5e;--bar:#9cc3b5;--good:#1f7a4d;--bad:#b3261e;--callout:#fff4e5}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1f;--ink:#ececec;--muted:#a0a0a6;--line:#333;--accent:#7cc4ad;--bar:#3f7d6b;--good:#6fd39b;--bad:#ff8a80;--callout:#3a2f1f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px 16px 48px}
main{max-width:1080px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px}h3{font-size:16px;margin:0 0 10px}h4{margin:18px 0 6px;font-size:14px}
.muted{color:var(--muted)}small{display:block;color:var(--muted);font-size:11px;font-weight:400}
.card,.product{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:8px 0 12px}
.step-head{display:flex;justify-content:space-between;gap:6px;font-size:12px}.step-head b{font-size:15px}
.bar{height:10px;background:var(--line);border-radius:5px;overflow:hidden;margin:4px 0}.bar span{display:block;height:100%;background:var(--accent)}
.step-rate{font-size:12px;color:var(--muted)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
thead th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
td.good{color:var(--good);font-weight:600}td.bad{color:var(--bad);font-weight:600}
.callout{background:var(--callout);border-radius:8px;padding:10px 12px}
a{color:var(--accent)}details{margin-top:10px}summary{cursor:pointer;color:var(--accent)}
.chart{width:100%;height:auto}.chart rect{fill:var(--bar)}.chart text{font-size:16px;fill:var(--muted)}
ul.notes{padding-left:18px;color:var(--muted);font-size:12px}
@media (max-width:640px){.steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><main>
<h1>Воронка продаж Parisa Home</h1>
<p class="muted">${esc(report.from)} … ${esc(report.to)} · ${report.days} дн. · сформировано ${esc(report.today)} · зелёным — выше среднего по магазину, красным — ниже на 15 % и больше</p>
${report.warnings.map((warning) => `<p class="callout"><b>${esc(warning)}</b></p>`).join('')}
<section class="card"><h3>Весь магазин</h3>${funnelSteps(report.shop.counts)}${dailyChart(report.daily)}</section>
<h2>По неделям</h2><div class="card scroll"><table>${weekly}</table></div>
<h2>Товары</h2><div class="card scroll"><table>${overview}</table></div>
${productBlocks}
<h2>Как читать</h2><ul class="notes">${report.notes.map((note) => `<li>${esc(note)}</li>`).join('')}<li>Шаги и чем на них влиять: ${(['ctr', 'cart', 'order'] as StepKey[]).map((step) => `${esc(STEP_LABELS[step])} — ${esc(STEP_HINTS[step])}`).join('; ')}.</li></ul>
</main></body></html>
`;
}
