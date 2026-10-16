import { describe, expect, it } from 'vitest';
import { formatLadderReport, ladderQueryClass, LadderKeyword, planLadderBids } from '../ad-ladder';
import { BidLadderStep } from '../auto-bidder';

/** Лестница кабинета: позиции 4…51 ↔ 100…20 % показов, цена топ-10 (позиция 9) = top10. */
const ladder = (top10: number): BidLadderStep[] => [
  { position: 4, cpm: Math.round(top10 * 1.15), impressionPercent: 100 },
  { position: 5, cpm: Math.round(top10 * 1.1), impressionPercent: 90 },
  { position: 7, cpm: Math.round(top10 * 1.05), impressionPercent: 80 },
  { position: 9, cpm: top10, impressionPercent: 70 },
  { position: 13, cpm: Math.round(top10 * 0.85), impressionPercent: 60 },
  { position: 19, cpm: Math.round(top10 * 0.7), impressionPercent: 50 },
];
const kw = (skuGroupId: string, query: string, cpm: number, top10: number | null): LadderKeyword => ({
  campaignId: '286528', campaignName: 'HAVANA', adId: `${skuGroupId}-${query}`, skuGroupId, query, cpm, stopWords: [], ladder: top10 === null ? null : ladder(top10),
});
const actions = (rows: LadderKeyword[]) => planLadderBids(rows).filter((row) => row.action).map((row) => [row.keyword.skuGroupId, row.action?.kind, row.action?.newCpm]);

describe('лестница ставок', () => {
  it('классы запросов: банные и наборы, лицевые, остальные', () => {
    expect(ladderQueryClass('Набор полотенец').name).toBe('банные и наборы');
    expect(ladderQueryClass('полотенце для лица').cap).toBe(40_000);
    expect(ladderQueryClass('sochiq').colors).toBe(2);
    expect(ladderQueryClass('полотенце банное для тела').name).toBe('банные и наборы');
    expect(ladderQueryClass("sochiq to'plami").cap).toBe(20_000);
  });

  it('два самых дешёвых цвета — в топ-10 с запасом 3 %, переплата снимается, остальные не поднимаются', () => {
    const rows = [
      kw('khaki', 'полотенце банное', 51_000, 45_760), // переплата → 47 500
      kw('white', 'полотенце банное', 51_000, 54_576), // вне топ-10 → 56 500
      kw('chrome', 'полотенце банное', 51_000, 57_181), // третий цвет, ниже топ-10 — не трогаем
      kw('milk', 'полотенце банное', 62_000, 61_435), // третий… четвёртый цвет в топ-10 сам — опустить ниже топ-10
    ];
    expect(actions(rows)).toEqual([['khaki', 'LOWER', 47_500], ['white', 'RAISE', 56_500], ['milk', 'LOWER', 60_500]]);
    const report = formatLadderReport(planLadderBids(rows), { apply: true });
    expect(report).toContain('Боевых пар «цвет + запрос»: 2, в топ-10 после правок: 2');
  });

  it('потолок класса: дорогой топ-10 не покупаем; дешёвый топ — любому цвету; без лестницы — без правок', () => {
    expect(actions([kw('blue', 'полотенце банное', 50_000, 63_363)])).toEqual([]);
    expect(actions([kw('a', 'vanna sochiq', 9_500, 11_965), kw('b', 'vanna sochiq', 9_500, 14_000), kw('c', 'vanna sochiq', 9_500, 19_000)]))
      .toEqual([['a', 'RAISE', 12_500], ['b', 'RAISE', 14_500]]);
    expect(actions([kw('a', 'sochiq', 9_500, 11_965), kw('b', 'sochiq', 17_000, 16_038), kw('c', 'sochiq', 15_000, 22_099)]))
      .toEqual([['a', 'RAISE', 12_500]]);
    expect(actions([kw('a', 'yuz sochiqlar', 9_500, 29_958)])).toEqual([]);
    expect(actions([kw('a', 'sochiqlar', 15_000, null)])).toEqual([]);
  });

  it('мелкая разница не дёргает объявление; ставка в топ-10 без переплаты остаётся', () => {
    expect(actions([kw('a', 'набор полотенец', 13_000, 12_029)])).toEqual([]);
    expect(actions([kw('a', 'набор полотенец', 35_000, 12_029)])).toEqual([['a', 'LOWER', 12_500]]);
  });

  it('ставка не выше потолка 70 000 и не ниже минимума', () => {
    const [cheap] = planLadderBids([kw('a', 'набор полотенец', 9_500, 9_000)]);
    expect(cheap.target).toBe(9_500);
    expect(cheap.action).toBeNull();
    expect(actions([kw('a', 'набор полотенец', 40_000, 69_000), kw('b', 'набор полотенец', 9_500, 58_000)])).toEqual([['b', 'RAISE', 60_000]]);
  });
});
