import { tashkentKey } from './period';

export type ProfitDayOrder = {
  date: Date; revenue: number; units: number; payout: number; productCost: number;
  packagingAndAdditional: number; marketplaceLogistics: number;
  warehouseLogistics: number; tax: number;
};

export type ProfitDayPurchase = { date: Date; revenue: number; units: number };
export type ProfitDayAd = { date: Date; amount: number };

export type ProfitDay = {
  date: string; orderedRevenue: number; orderedUnits: number; orderedOrders: number;
  advertising: number; productCost: number; packagingAndAdditional: number;
  logistics: number; marketplaceLogistics: number; warehouseLogistics: number;
  tax: number; payout: number; purchasedRevenue: number; purchasedUnits: number;
  orders: number; profit: number;
  // Сборы Uzum, не привязанные к конкретному заказу: хранение на складе,
  // штрафы приёмки, доп. услуги и т.п. (ledger-строки finance/expenses любых
  // кодов, кроме рекламы/логистики заказа/логистики поставки — те уже учтены
  // отдельно). Нельзя разнести по заказам, поэтому это только дневная/периодная сумма.
  otherFees: number;
  // Все расходы после выплаты, кроме рекламы: себестоимость, упаковка/прочее,
  // логистика поставок, налог и прочие сборы Uzum. Комиссия и логистика
  // заказа уже вычтены в payout.
  expensesExAdvertising: number;
  // Прибыль до вычета любой рекламы. Известна для свежих дней, когда ledger
  // рекламы ещё не пришёл, но выплата и себестоимость уже есть.
  profitExAdvertising: number;
  // Рекламный расход с динамической подстановкой: фактический ledger, а при его
  // отсутствии — оценка по последней наблюдавшейся ставке товара («процент за продажу»).
  advertisingEstimated: number;
  advertisingIsEstimated: boolean;
  // profitExAdvertising − advertisingEstimated. Показывается за вчера/сегодня
  // вместо прочерка, помечается как оценка.
  profitEstimated: number;
};

export function buildProfitDays(
  from: Date,
  to: Date,
  orders: ProfitDayOrder[],
  purchases: ProfitDayPurchase[],
  ads: ProfitDayAd[],
  estimatedAds: ProfitDayAd[] = [],
  otherFees: ProfitDayAd[] = [],
) {
  const byDate = new Map<string, ProfitDay>();
  for (let cursor = new Date(from); cursor <= to; cursor = new Date(cursor.getTime() + 86_400_000)) {
    const date = tashkentKey(cursor);
    byDate.set(date, {
      date, orderedRevenue: 0, orderedUnits: 0, orderedOrders: 0, advertising: 0,
      productCost: 0, packagingAndAdditional: 0, logistics: 0,
      marketplaceLogistics: 0, warehouseLogistics: 0, tax: 0, payout: 0,
      purchasedRevenue: 0, purchasedUnits: 0, orders: 0, profit: 0, otherFees: 0,
      expensesExAdvertising: 0, profitExAdvertising: 0,
      advertisingEstimated: 0, advertisingIsEstimated: false, profitEstimated: 0,
    });
  }
  for (const order of orders) {
    const day = byDate.get(tashkentKey(order.date));
    if (!day) continue;
    day.orderedRevenue += order.revenue;
    day.orderedUnits += order.units;
    day.orderedOrders += 1;
    day.productCost += order.productCost;
    day.packagingAndAdditional += order.packagingAndAdditional;
    day.marketplaceLogistics += order.marketplaceLogistics;
    day.warehouseLogistics += order.warehouseLogistics;
    day.logistics += order.marketplaceLogistics + order.warehouseLogistics;
    day.tax += order.tax;
    day.payout += order.payout;
  }
  for (const purchase of purchases) {
    const day = byDate.get(tashkentKey(purchase.date));
    if (!day) continue;
    day.purchasedRevenue += purchase.revenue;
    day.purchasedUnits += purchase.units;
    day.orders += 1;
  }
  for (const ad of ads) {
    const day = byDate.get(tashkentKey(ad.date));
    if (day) day.advertising += ad.amount;
  }
  const estimateByDate = new Map<string, number>();
  for (const ad of estimatedAds) {
    const key = tashkentKey(ad.date);
    if (byDate.has(key)) estimateByDate.set(key, (estimateByDate.get(key) ?? 0) + ad.amount);
  }
  for (const fee of otherFees) {
    const day = byDate.get(tashkentKey(fee.date));
    if (day) day.otherFees += fee.amount;
  }
  for (const day of byDate.values()) {
    day.expensesExAdvertising = day.productCost + day.packagingAndAdditional + day.warehouseLogistics + day.tax + day.otherFees;
    day.profitExAdvertising = day.payout - day.expensesExAdvertising;
    day.profit = day.profitExAdvertising - day.advertising;
    const hasLedgerAdvertising = Math.abs(day.advertising) > 0.0001;
    const estimate = estimateByDate.get(day.date) ?? 0;
    day.advertisingEstimated = hasLedgerAdvertising ? day.advertising : estimate;
    day.advertisingIsEstimated = !hasLedgerAdvertising && estimate > 0;
    day.profitEstimated = day.profitExAdvertising - day.advertisingEstimated;
  }
  const days = [...byDate.values()].reverse();
  const totals = days.reduce((sum, day) => {
    sum.orderedRevenue += day.orderedRevenue; sum.orderedUnits += day.orderedUnits;
    sum.purchasedRevenue += day.purchasedRevenue; sum.purchasedUnits += day.purchasedUnits;
    sum.advertising += day.advertising;
    sum.advertisingEstimated += day.advertisingEstimated;
    sum.costs += day.productCost + day.packagingAndAdditional + day.warehouseLogistics + day.tax;
    sum.otherFees += day.otherFees;
    sum.expensesExAdvertising += day.expensesExAdvertising;
    sum.profitExAdvertising += day.profitExAdvertising;
    sum.profit += day.profit;
    sum.profitEstimated += day.profitEstimated;
    return sum;
  }, { orderedRevenue: 0, orderedUnits: 0, purchasedRevenue: 0, purchasedUnits: 0, advertising: 0, advertisingEstimated: 0, costs: 0, otherFees: 0, expensesExAdvertising: 0, profitExAdvertising: 0, profit: 0, profitEstimated: 0 });
  return {
    days,
    summary: {
      ...totals,
      averagePurchasedAmount: totals.purchasedUnits ? totals.purchasedRevenue / totals.purchasedUnits : 0,
      averageDailyRevenue: totals.orderedRevenue / Math.max(1, days.length),
      marginPercent: totals.orderedRevenue ? totals.profit / totals.orderedRevenue * 100 : 0,
      marginEstimatedPercent: totals.orderedRevenue ? totals.profitEstimated / totals.orderedRevenue * 100 : 0,
    },
  };
}
