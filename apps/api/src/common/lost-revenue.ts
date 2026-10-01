import { tashkentKey } from './period';

/**
 * Упущенная выручка: сколько продаж потеряно, пока SKU был без остатка.
 * Это ОЦЕНКА по определению (продажи, которых не было, нельзя измерить):
 * скорость продаж берётся из дней, когда товар БЫЛ в наличии, и умножается
 * на дни без остатка. Все потребители обязаны показывать результат с
 * пометкой «оценка» — в духе инварианта «известное против оценки».
 */

export type StockPoint = { at: Date; amount: number };
export type SkuSale = { at: Date; units: number; revenue: number };

export type LostRevenueRow = {
  outOfStockDays: number;
  inStockDays: number;
  soldUnits: number;
  soldRevenue: number;
  /** шт./день по дням в наличии; null — товара не было в наличии ни дня или продаж не было. */
  dailyRate: number | null;
  lostUnitsEstimate: number;
  lostRevenueEstimate: number;
};

const DAY_MS = 86_400_000;

/** Дни Asia/Tashkent в [from; to), для каждого — остаток на полдень дня. */
export function lostRevenueForSku(
  snapshots: StockPoint[],
  sales: SkuSale[],
  from: Date,
  to: Date,
): LostRevenueRow {
  const sorted = [...snapshots].sort((a, b) => a.at.getTime() - b.at.getTime());
  let outOfStockDays = 0;
  let inStockDays = 0;
  if (sorted.length) {
    for (let cursor = from.getTime(); cursor < to.getTime(); cursor += DAY_MS) {
      const dayKey = tashkentKey(new Date(cursor));
      const noon = new Date(`${dayKey}T12:00:00+05:00`);
      // Остаток на полдень дня: последний снапшот не позже полудня; до первого
      // снапшота считаем, что остаток был таким же, как в первом (снапшоты
      // пишутся только при изменении).
      let amount = sorted[0].amount;
      for (const point of sorted) {
        if (point.at.getTime() <= noon.getTime()) amount = point.amount;
        else break;
      }
      if (amount <= 0) outOfStockDays += 1;
      else inStockDays += 1;
    }
  }
  const soldUnits = sales.reduce((sum, sale) => sum + sale.units, 0);
  const soldRevenue = sales.reduce((sum, sale) => sum + sale.revenue, 0);
  const dailyRate = inStockDays > 0 && soldUnits > 0 ? soldUnits / inStockDays : null;
  const avgPrice = soldUnits > 0 ? soldRevenue / soldUnits : 0;
  const lostUnitsEstimate = dailyRate !== null ? dailyRate * outOfStockDays : 0;
  return {
    outOfStockDays,
    inStockDays,
    soldUnits,
    soldRevenue,
    dailyRate,
    lostUnitsEstimate,
    lostRevenueEstimate: lostUnitsEstimate * avgPrice,
  };
}
