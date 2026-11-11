import { describe, expect, it } from 'vitest';
import { LossInput, lossReport, lossRow, lossSkuKey, mergeLossInputs } from '../inventory-losses';

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

  it('старый и новый SKU одного товара (J471 «лицевой» → «лицево») склеиваются — потеря не выдумывается', () => {
    // Сверка 10.11.2026: накладные на новом SKU, часть продаж осталась на старом.
    const fresh = sku({ skuId: 'new', sellerSku: 'FAYYOZ-J471-КРЕМОВ-лицево', accepted: 115, sold: 37, inOrders: 7, stock: 28, maybeReturning: 15, defective: 0 });
    const old = sku({ skuId: 'old', sellerSku: 'FAYYOZ-J471-КРЕМОВ-лицевой', accepted: 0, sold: 28, inOrders: 0, stock: 0, maybeReturning: 0, defective: null, unitCost: null });
    expect(lossSkuKey(fresh.sellerSku)).toBe(lossSkuKey(old.sellerSku));
    const separate = lossReport([fresh, old]);
    expect(separate.rows.find((row) => row.skuId === 'new')?.status).toBe('check');
    expect(separate.rows.find((row) => row.skuId === 'old')?.status).toBe('no-history');
    const merged = mergeLossInputs([fresh, old]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ accepted: 115, sold: 65, defective: 0, unitCost: 20_000, mergedSkus: 2 });
    // 115 − 65 − 7 − 28 = 15 — ровно столько отмен и возвратов ещё могут ехать на склад.
    expect(lossRow(merged[0])).toMatchObject({ gap: 15, notFound: 0, status: 'returning' });
  });

  it('склеенная строка берёт артикул и себестоимость у живого SKU, в каком бы порядке ни пришли строки', () => {
    // Сверка 11.11.2026: J471 СИРЕН — у старого SKU себестоимость 0, у нового 17 330; итог прыгал от порядка строк.
    const fresh = sku({ skuId: 'new', sellerSku: 'FAYYOZ-J471-СИРЕН-лицево', accepted: 34, sold: 15, stock: 16, unitCost: 17_330 });
    const old = sku({ skuId: 'old', sellerSku: 'FAYYOZ-J471-СИРЕН-лицевой', accepted: 20, sold: 1, stock: 0, unitCost: 0 });
    for (const order of [[fresh, old], [old, fresh]]) {
      const [merged] = mergeLossInputs(order);
      expect(merged).toMatchObject({ skuId: 'new', sellerSku: 'FAYYOZ-J471-СИРЕН-лицево', accepted: 54, sold: 16, stock: 16, unitCost: 17_330, mergedSkus: 2 });
    }
    // Если себестоимость задана только у старого SKU — берётся она; нулевая не считается заданной.
    expect(mergeLossInputs([{ ...fresh, unitCost: null }, { ...old, unitCost: 15_000 }])[0].unitCost).toBe(15_000);
    expect(mergeLossInputs([{ ...fresh, unitCost: 0 }, old])[0].unitCost).toBeNull();
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
