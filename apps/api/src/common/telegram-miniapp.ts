import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Мини-приложение Telegram («Профит сегодня»): проверка подписи initData и
 * сборка сводки из метрик дашборда.
 *
 * Авторизация здесь — не JWT: Telegram подписывает initData HMAC-ключом,
 * производным от токена бота, поэтому подпись проверяется локально, а наружу
 * открыт только один read-only эндпоинт. Инвариант «известное против оценки»
 * сохраняется: прибыль отдаётся числом только когда она известна целиком,
 * иначе null — клиент обязан показать «не рассчитана», а не ноль.
 */

export type MiniAppPeriodKey = 'today' | 'yesterday' | 'week' | 'month';

export type MiniAppUser = { id: string; firstName: string; username: string | null; authDate: Date };

const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

/** Поля initData в виде словаря; значения уже декодированы. */
export function parseInitData(initData: string) {
  const params = new URLSearchParams(String(initData || ''));
  const fields: Record<string, string> = {};
  for (const [key, value] of params.entries()) fields[key] = value;
  return fields;
}

/**
 * Проверка подписи initData по алгоритму Telegram: secret = HMAC_SHA256(токен
 * бота) с ключом «WebAppData», затем HMAC этим секретом по строке из всех полей
 * кроме hash, отсортированных по имени. Бросает понятную по-русски ошибку —
 * её текст виден в мини-приложении.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  options: { maxAgeSeconds?: number; now?: Date } = {},
): MiniAppUser {
  if (!initData) throw new Error('Нет данных Telegram: откройте мини-приложение кнопкой в боте');
  if (!botToken) throw new Error('Telegram-бот не настроен');
  const fields = parseInitData(initData);
  const hash = fields.hash;
  if (!hash) throw new Error('Подпись Telegram отсутствует');
  const checkString = Object.keys(fields)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest('hex');
  const given = Buffer.from(hash, 'hex');
  const mine = Buffer.from(expected, 'hex');
  if (given.length !== mine.length || !timingSafeEqual(given, mine)) throw new Error('Подпись Telegram не совпала');
  const authDateSeconds = Number(fields.auth_date || 0);
  if (!Number.isFinite(authDateSeconds) || authDateSeconds <= 0) throw new Error('Подпись Telegram без даты');
  const now = options.now ? options.now.getTime() : Date.now();
  const maxAge = options.maxAgeSeconds ?? MAX_INIT_DATA_AGE_SECONDS;
  if (now - authDateSeconds * 1000 > maxAge * 1000) throw new Error('Данные Telegram устарели: откройте мини-приложение заново');
  let user: any = {};
  try {
    user = fields.user ? JSON.parse(fields.user) : {};
  } catch {
    throw new Error('Не удалось прочитать пользователя Telegram');
  }
  const id = String(user?.id ?? '').trim();
  if (!id) throw new Error('Не удалось прочитать пользователя Telegram');
  return {
    id,
    firstName: String(user?.first_name || '').trim(),
    username: user?.username ? String(user.username) : null,
    authDate: new Date(authDateSeconds * 1000),
  };
}

/** Период мини-приложения: те же четыре окна, что и у кнопок бота. */
export function miniAppRange(period: MiniAppPeriodKey, today: string) {
  const shift = (dateKey: string, delta: number) => {
    const date = new Date(`${dateKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
  };
  switch (period) {
    case 'yesterday': return { from: shift(today, -1), to: shift(today, -1), title: 'Вчера' };
    case 'week': return { from: shift(today, -6), to: today, title: '7 дней' };
    case 'month': return { from: `${today.slice(0, 7)}-01`, to: today, title: 'С начала месяца' };
    default: return { from: today, to: today, title: 'Сегодня' };
  }
}

export function normalizeMiniAppPeriod(value: unknown): MiniAppPeriodKey {
  const key = String(value || '').toLowerCase();
  return key === 'yesterday' || key === 'week' || key === 'month' ? key : 'today';
}

export type MiniAppRisk = {
  title: string; sku: string | null; stock: number;
  daysLeft: number | null; recommendedSupply: number | null; status: string;
};
export type MiniAppTopProduct = { title: string; units: number; revenue: number; profit: number | null };
export type MiniAppGoal = { metric: string; current: number; target: number; progress: number };
/** Строка разложения денег. value = null, когда итог прятать нельзя подменять нулём. */
export type MiniAppWaterfallRow = { key: string; label: string; value: number | null; percent: number; kind: string };
export type MiniAppChartPoint = { label: string; revenue: number };
export type MiniAppInsight = { tone: string; title: string; text: string };

export type MiniAppSummary = {
  period: { key: MiniAppPeriodKey; from: string; to: string; title: string };
  shop: string | null;
  ordered: {
    units: number; revenue: number; payout: number;
    /** null — потенциальная прибыль по заказам не известна целиком. */
    potentialProfit: number | null;
    /** Модельная оценка (в т.ч. с оценочной рекламой) — показывать только как оценку. */
    potentialProfitEstimate: number | null;
    costCoverage: number | null;
    advertisingCoverage: number | null;
  };
  bought: { units: number; revenue: number; payout: number };
  profit: {
    /** Финальная прибыль: null, пока хоть один вход неизвестен. */
    net: number | null;
    marginPercent: number | null;
    /** Прибыль по фактическим данным «на сейчас»: модельная реклама в неё не входит. */
    current: number | null;
    currentMarginPercent: number | null;
    final: boolean;
    /** Что ещё может уточнить число. */
    pending: string[];
  };
  expenses: {
    cogs: number; commission: number; commissionPercent: number;
    logistics: number; advertising: number; advertisingPercent: number;
    tax: number; otherFees: number; total: number;
  };
  returns: { units: number; amount: number; orders: number };
  /** Движение заказов периода: заказы и выкупы — независимые потоки. */
  orders: { created: number; paid: number; waiting: number; waitingUnits: number; waitingRevenue: number };
  /** Кошелёк: когда деньги попадут в корзину вывода. null — прогноз не посчитан. */
  wallet: {
    availableToWithdraw: number; inReturnHold: number; dueToday: number;
    next7Days: number; needsReconcile: number;
    overallBalance: number | null; holdDays: number | null; schedule: string | null;
  } | null;
  advertising: {
    expense: number; percent: number; orderBoost: number; topPromotion: number;
    /** Модельная оценка свежих списаний: в факт и прибыль не входит. */
    estimate: number; hasEstimate: boolean; mayBeIncomplete: boolean;
  };
  stock: {
    skus: number; endingSoon: number; recommendedSupply: number;
    marketplaceUnits: number; availableForSale: number; value: number;
    potentialPayout: number | null; reportAsOf: string | null;
  };
  risks: MiniAppRisk[];
  topProducts: MiniAppTopProduct[];
  goals: MiniAppGoal[];
  /** Заказы, которые висят без выкупа дольше порога: деньги под риском. */
  stale: { cutoffDays: number; count: number; units: number; amount: number };
  waterfall: MiniAppWaterfallRow[];
  chart: { granularity: string; points: MiniAppChartPoint[] };
  insights: MiniAppInsight[];
  catalog: { products: number; skus: number; supplies: number };
  notes: string[];
  generatedAt: string;
};

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const maybe = (value: unknown) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
const known = (flag: unknown, value: unknown) => flag === true && value !== null && value !== undefined && Number.isFinite(Number(value));
const text = (value: unknown, limit = 220) => String(value ?? '').slice(0, limit);

/**
 * Сводка для мини-приложения из ответа DashboardService.overview.
 * Чистая функция: вся арифметика и все решения «известно / не рассчитана» здесь.
 */
export function buildMiniAppSummary(
  overview: any,
  period: { key: MiniAppPeriodKey; from: string; to: string; title: string },
  now: Date = new Date(),
): MiniAppSummary {
  const m = overview?.metrics || {};
  const revenue = num(m.revenue);
  const profitKnown = known(m.profitKnown, m.profit);
  const orderedProfitKnown = known(m.orderedPotentialProfitKnown, m.orderedPotentialProfit);
  const commission = num(m.commission);
  const advertising = num(m.advertisingExpense);
  const cogs = num(m.cogs);
  const tax = num(m.taxExpense);
  const logistics = num(m.marketplaceLogistics);
  const otherFees = num(m.otherMarketplaceFeesExpense) + num(m.otherMarketplaceDeductions);
  // Прибыль «на сейчас» — это факт: выплата, себестоимость, комиссия, налог и
  // пришедшие рекламные списания. Модельная реклама в неё не входит, поэтому
  // число может только уточниться вниз, когда Uzum спишет рекламу за день.
  const currentProfit = Number.isFinite(Number(m.profit)) ? num(m.profit) : null;
  const payoutPendingOrders = num(m.realizedPayoutPendingOrders);
  const missingCostItems = num(m.realizedMissingCostItems);
  const pending: string[] = [];
  if (payoutPendingOrders > 0) pending.push(`заказов без отчёта Uzum о выплате: ${payoutPendingOrders}`);
  if (missingCostItems > 0) pending.push(`позиций без себестоимости: ${missingCostItems}`);
  if (!profitKnown && payoutPendingOrders === 0 && missingCostItems === 0) {
    pending.push('реклама за свежие дни — Uzum списывает её на следующий день');
  }
  const notes: string[] = [];
  if (profitKnown) notes.push('Период закрыт: все расходы пришли от Uzum, реклама учтена по факту.');
  else if (currentProfit === null) notes.push('Чистая прибыль не рассчитана: нет фактических данных по периоду.');
  else notes.push(`Прибыль «на сейчас» — по фактическим данным. Уточнится: ${pending.join('; ')}.`);
  if (!orderedProfitKnown) notes.push('Прибыль по заказам — ожидаемая: пока известны не все расходы по заказанному.');

  const ads = overview?.advertising || {};
  const forecast = overview?.payoutForecast || null;
  const walletSummary = forecast?.summary || null;
  const inventory = overview?.inventorySummary || null;
  const stale = overview?.staleWaitingOrders || {};
  // Себестоимость и неизвестные входы прячут только итог, а не известные части:
  // те же правила, что на основном экране «Разложение денег».
  const partialKeys = new Set(['payout', 'productCost', 'warehouseLogistics', 'packagingAdditional']);
  const inputsKnown = payoutPendingOrders === 0 && missingCostItems === 0;
  const waterfall: MiniAppWaterfallRow[] = Array.isArray(overview?.waterfall)
    ? overview.waterfall.map((row: any) => ({
      key: String(row?.key || ''),
      label: text(row?.label, 90),
      value: String(row?.key) === 'profit' && !profitKnown ? null : maybe(row?.value),
      percent: num(row?.percent),
      kind: !inputsKnown && partialKeys.has(String(row?.key)) ? 'partial' : String(row?.type || 'expense'),
    }))
    : [];

  return {
    period,
    shop: overview?.shop?.name ? String(overview.shop.name) : null,
    ordered: {
      units: num(m.orderedUnits),
      revenue: num(m.orderedRevenue),
      payout: num(m.orderedPayout),
      potentialProfit: orderedProfitKnown ? num(m.orderedPotentialProfit) : null,
      potentialProfitEstimate: Number.isFinite(Number(m.orderedPotentialProfitEstimate)) ? num(m.orderedPotentialProfitEstimate) : null,
      costCoverage: Number.isFinite(Number(m.orderedCostCoverage)) ? num(m.orderedCostCoverage) : null,
      advertisingCoverage: Number.isFinite(Number(m.orderedAdvertisingCoverage)) ? num(m.orderedAdvertisingCoverage) : null,
    },
    bought: { units: num(m.paidUnits), revenue, payout: num(m.payout) },
    profit: {
      net: profitKnown ? num(m.profit) : null,
      marginPercent: profitKnown && revenue > 0 ? num(m.profit) / revenue * 100 : null,
      current: currentProfit,
      currentMarginPercent: currentProfit !== null && revenue > 0 ? currentProfit / revenue * 100 : null,
      final: profitKnown,
      pending,
    },
    expenses: {
      cogs, commission,
      commissionPercent: Number.isFinite(Number(m.commissionPercent)) ? num(m.commissionPercent) : revenue > 0 ? commission / revenue * 100 : 0,
      logistics, advertising,
      advertisingPercent: revenue > 0 ? advertising / revenue * 100 : 0,
      tax, otherFees,
      total: cogs + commission + logistics + advertising + tax + otherFees,
    },
    returns: { units: num(m.returnedTodayUnits), amount: num(m.returnedTodayAmount), orders: num(m.returnedTodayOrders) },
    orders: {
      created: num(m.orders),
      paid: num(m.paidOrders),
      waiting: num(m.waitingOrders),
      waitingUnits: num(m.waitingUnits),
      waitingRevenue: num(m.waitingRevenue),
    },
    wallet: walletSummary ? {
      availableToWithdraw: num(walletSummary.availableToWithdraw),
      inReturnHold: num(walletSummary.inReturnHold),
      dueToday: num(walletSummary.dueToday),
      next7Days: num(walletSummary.next7Days),
      needsReconcile: num(walletSummary.needsReconcile),
      overallBalance: maybe(walletSummary.overallBalance),
      holdDays: maybe(forecast?.holdDays),
      schedule: forecast?.schedule ? text(forecast.schedule, 80) : null,
    } : null,
    advertising: {
      expense: num(ads.totalExpense ?? m.advertisingExpense),
      percent: Number.isFinite(Number(ads.effectivePercent)) ? num(ads.effectivePercent) : revenue > 0 ? advertising / revenue * 100 : 0,
      orderBoost: num(ads.orderBoostExpense ?? m.orderBoostExpense),
      topPromotion: num(ads.topPromotionExpense ?? m.topPromotionExpense),
      estimate: num(ads.provisionalOrderBoostExpense),
      hasEstimate: Boolean(ads.hasEstimate) || num(ads.provisionalOrderBoostExpense) > 0,
      mayBeIncomplete: Boolean(ads.freshExpenseMayBeIncomplete || ads.orderBoostExpensePending || ads.topExpensePending),
    },
    stock: {
      skus: num(inventory?.skuCount ?? m.skus),
      endingSoon: num(inventory?.endingSoonSkus),
      recommendedSupply: num(inventory?.recommendedSupply),
      marketplaceUnits: num(inventory?.marketplaceTotal),
      availableForSale: num(inventory?.availableForSale),
      value: num(m.stockValue),
      potentialPayout: maybe(inventory?.potentialPayout),
      reportAsOf: inventory?.reportAsOf ? new Date(inventory.reportAsOf).toISOString() : null,
    },
    risks: (Array.isArray(overview?.risks) ? overview.risks : []).slice(0, 6).map((row: any) => ({
      title: text(row?.title, 80),
      sku: row?.sku ? text(row.sku, 40) : null,
      stock: num(row?.stock),
      daysLeft: maybe(row?.daysLeft),
      recommendedSupply: maybe(row?.recommendedSupply),
      status: text(row?.status, 30),
    })),
    topProducts: (Array.isArray(overview?.topProducts) ? overview.topProducts : []).slice(0, 5).map((row: any) => ({
      title: text(row?.title, 80),
      units: Math.round(num(row?.units)),
      revenue: num(row?.revenue),
      // Прибыль по товару отдаём числом только когда она известна целиком.
      profit: row?.profitKnown === true ? num(row?.profit) : null,
    })),
    goals: (Array.isArray(overview?.goals) ? overview.goals : [])
      .filter((goal: any) => maybe(goal?.current) !== null && maybe(goal?.progress) !== null && maybe(goal?.targetValue ?? goal?.target) !== null)
      .slice(0, 6)
      .map((goal: any) => ({
        metric: text(goal?.metric, 40),
        current: num(goal.current),
        target: num(goal.targetValue ?? goal.target),
        progress: num(goal.progress),
      })),
    stale: {
      cutoffDays: num(stale?.cutoffDays),
      count: num(stale?.count),
      units: num(stale?.units),
      amount: num(stale?.amount),
    },
    waterfall,
    chart: {
      granularity: text(overview?.chartGranularity || 'day', 10),
      // Хвост периода: на телефоне больше 14 столбиков не читается.
      points: (Array.isArray(overview?.chart) ? overview.chart : []).slice(-14).map((point: any) => ({
        label: text(point?.label, 20),
        revenue: num(point?.revenue),
      })),
    },
    insights: (Array.isArray(overview?.insights) ? overview.insights : []).slice(0, 6).map((row: any) => ({
      tone: text(row?.tone, 12) || 'info',
      title: text(row?.title, 60),
      text: text(row?.text, 240),
    })),
    catalog: { products: num(m.products), skus: num(m.skus), supplies: num(m.supplies) },
    notes,
    generatedAt: now.toISOString(),
  };
}
