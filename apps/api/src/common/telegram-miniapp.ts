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
  returns: { units: number; amount: number };
  notes: string[];
  generatedAt: string;
};

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const known = (flag: unknown, value: unknown) => flag === true && value !== null && value !== undefined && Number.isFinite(Number(value));

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
    returns: { units: num(m.returnedTodayUnits), amount: num(m.returnedTodayAmount) },
    notes,
    generatedAt: now.toISOString(),
  };
}
