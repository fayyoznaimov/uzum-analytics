import { describe, expect, it } from 'vitest';
import { LossInput, lossReport, lossRow } from '../inventory-losses';

const sku = (patch: Partial<LossInput>): LossInput => ({
  skuId: 's1', sellerSku: 'HAV-50x90-GR', title: 'HAVANA', accepted: 100, sold: 60, inOrders: 5, maybeReturning: 0, stock: 30, defective: 0, unitCost: 20_000, ...patch,
});

describe('расчёт потерь по SKU', () => {
  it('всё нашлось — потерь нет', () => {
    const row = lossRow(sku({ stock: 35 }));
    expect(row.gap).toBe(0);
    expect(row.notFound).toBe(0);
    expect(row.status).toBe('ok');
  });

  it('разница покрыта отменами и возвратами, которые ещё могут ехать на склад, — не потеря', () => {
    const row = lossRow(sku({ maybeReturning: 7 }));
    expect(row.gap).toBe(5);
    expect(row.notFound).toBe(0);
    expect(row.status).toBe('returning');
  });

  it('1–2 штуки из сотни — шум учёта, а не «проверить»', () => {
    const row = lossRow(sku({ stock: 33 }));
    expect(row.notFound).toBe(2);
    expect(row.status).toBe('small');
    expect(row.notFoundCost).toBe(40_000);
  });

  it('много не найдено — «проверить», сумма по себестоимости', () => {
    const row = lossRow(sku({ accepted: 50, sold: 10, inOrders: 0, stock: 10, defective: 2, maybeReturning: 3 }));
    expect(row.gap).toBe(28);
    expect(row.notFound).toBe(25);
    expect(row.status).toBe('check');
    expect(row.notFoundCost).toBe(500_000);
  });

  it('продано и лежит больше, чем принято, — не хватает истории поставок, потерю не выдумываем', () => {
    const row = lossRow(sku({ accepted: 10 }));
    expect(row.gap).toBeLessThan(0);
    expect(row.notFound).toBe(0);
    expect(row.notFoundCost).toBeNull();
    expect(row.status).toBe('no-history');
  });

  it('без себестоимости сумма неизвестна (null), а не 0', () => {
    const row = lossRow(sku({ stock: 20, unitCost: null }));
    expect(row.notFound).toBe(15);
    expect(row.notFoundCost).toBeNull();
  });

  it('брак, который кабинет не читал, считается нулём только в разнице, но SKU помечен', () => {
    const report = lossReport([sku({ defective: null, stock: 35 })]);
    expect(report.rows[0].status).toBe('ok');
    expect(report.summary.defectiveUnknownSkus).toBe(1);
  });

  it('итоги не смешивают SKU без истории поставок с остальными, «проверить» — первыми', () => {
    const report = lossReport([
      sku({ skuId: 'a', stock: 35 }),
      sku({ skuId: 'b', accepted: 5 }),
      sku({ skuId: 'c', stock: 10, unitCost: null }),
      sku({ skuId: 'd', accepted: 0, sold: 0, inOrders: 0, stock: 0 }),
    ]);
    // «проверить» → «нет истории поставок» → «всё на месте»; SKU без движения не показывается.
    expect(report.rows.map((row) => row.skuId)).toEqual(['c', 'b', 'a']);
    expect(report.summary.accepted).toBe(200);
    expect(report.summary.notFound).toBe(25);
    expect(report.summary.notFoundCost).toBe(0);
    expect(report.summary.notFoundUnitsWithoutCost).toBe(25);
    expect(report.summary.checkSkus).toBe(1);
    expect(report.summary.noHistorySkus).toBe(1);
  });
});
