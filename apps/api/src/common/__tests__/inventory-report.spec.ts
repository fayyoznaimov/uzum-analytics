import { describe, expect, it } from 'vitest';
import { parseInventoryMatrix } from '../inventory-report';

const headers = [
  'Магазин','Название товара','ID товара','SKU','Штрихкод','Заканчивается','Индикатор обеспеченности',
  'Плановая дата, когда закончатся текущие остатки','Обеспеченность (на сколько дней хватит текущих остатков), дней',
  'Рекомендованное количество на поставку, шт','На вашей стороне (на складе FBS), шт',
  'На стороне маркетплейса (всего в продаже, в пути, на складах и фотостудии), шт','В поставке (создана накладная), шт',
  'В продаже, шт','В пути до клиента (в логистике), шт','В пути от клиента (возвраты и отказы), шт',
  'На складе длительного хранения (СДХ), шт','На фотостудии, шт','Брак на складе, шт',
  'Потенциальная сумма к получению за 1 шт, сум','Потенциальная сумма к получению за все остатки, сум',
];

describe('Uzum inventory report parser', () => {
  it('parses exact Russian headers and negative payout', () => {
    const matrix = [
      ['Отчёт сформирован 13 июля 2026 10:28'],
      headers,
      ['PARISAHOME','Havana','123','HAVANA-50','4780000000001','Да','Низкая','15.07.2026',2,12,0,5,1,3,1,1,0,0,0,-1000,-5000],
    ];
    const report = parseInventoryMatrix(matrix,'hash');
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ sellerSku:'HAVANA-50', endingSoon:true, coverageDays:2, recommendedSupply:12, marketplaceTotal:5, potentialPayoutUnit:-1000, potentialPayoutTotal:-5000 });
    expect(report.reportAsOf?.toISOString()).toBe('2026-07-13T05:28:00.000Z');
  });

  it('rejects unrelated spreadsheets', () => {
    expect(() => parseInventoryMatrix([['foo','bar']])).toThrow(/SKU/);
  });
});
