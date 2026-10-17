import { describe, expect, it } from 'vitest';
import { formatCampaignSummary, formatLadderReport, ladderDrrVerdict, ladderKey, ladderQueryClass, LadderKeyword, planLadderBids } from '../ad-ladder';
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
    expect(ladderQueryClass('Набор полотенец').name).toBe('наборы, комплекты, сауна');
    expect(ladderQueryClass('комплект полотенец').cap).toBe(70_000);
    expect(ladderQueryClass('полотенце для сауны').name).toBe('наборы, комплекты, сауна');
    expect(ladderQueryClass("sochiq to'plami").name).toBe('наборы, комплекты, сауна');
    expect(ladderQueryClass('sochiq nabor').name).toBe('наборы, комплекты, сауна');
    for (const q of ['полотенце для бани', 'katta hammom sochiq', 'sochiq 100x150', 'полотенце 100х150', 'полотенце для бассейна', 'basseyn sochiq']) expect(ladderQueryClass(q).name).toBe('наборы, комплекты, сауна');
    expect(ladderQueryClass('sochiq yuz va hammom').name).toBe('остальные');
    expect(ladderQueryClass('полотенце для лица').cap).toBe(40_000);
    expect(ladderQueryClass('sochiq').colors).toBe(2);
    expect(ladderQueryClass('полотенце банное для тела').name).toBe('банные');
    expect(ladderQueryClass('vanna sochiq').cap).toBe(20_000);
  });

  it('два самых дешёвых цвета — в топ-10 с запасом 3 %, переплата снимается, остальные не поднимаются', () => {
    const rows = [
      kw('khaki', 'полотенце банное', 55_000, 45_760), // переплата больше 10 % → 47 500
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

  it('сверка каждый час: переплата до 10 % не трогается, после правки слово 2 часа не дёргаем — кроме выпадения из топ-10', () => {
    expect(actions([kw('a', 'полотенце банное', 51_000, 45_760)])).toEqual([]);
    const over = kw('a', 'полотенце банное', 60_000, 45_760);
    const out = kw('b', 'полотенце банное', 40_000, 47_000);
    const recent = new Set([ladderKey(over), ladderKey(out)]);
    expect(planLadderBids([over, out], undefined, recent).filter((row) => row.action).map((row) => [row.keyword.skuGroupId, row.action?.newCpm])).toEqual([['b', 48_500]]);
    expect(actions([over, out])).toEqual([['a', 'LOWER', 47_500], ['b', 'RAISE', 48_500]]);
  });

  it('ДРР за 7 дней: мало данных — не судим; выше потолка — не в топе; вдвое выше или без продаж — на минимум', () => {
    const st = (spend: number, revenue: number, sold: number, clicks = 10) => ({ impressions: 1000, clicks, sold, revenue, spend, position: null });
    expect(ladderDrrVerdict(st(20_000, 100_000, 1), 10).blocked).toBeNull(); // мало данных
    expect(ladderDrrVerdict(st(40_000, 300_000, 2), 10).blocked).toMatch(/ДРР 13\.3/);
    expect(ladderDrrVerdict(st(40_000, 300_000, 2), 15).blocked).toBeNull(); // потолок выше ДРР — слово в порядке
    expect(ladderQueryClass('комплект полотенец').maxDrr).toBe(10); // наборы, комплекты, сауна — 10 % (владелец 17.10)
    expect(ladderDrrVerdict(st(60_000, 0, 0), 10)).toMatchObject({ severe: true });
    const rich = { ...kw('a', 'полотенце банное', 48_000, 45_760), stats7: st(40_000, 160_000, 1) }; // ДРР 25 % — вдвое выше 10 %
    const ok = { ...kw('b', 'полотенце банное', 40_000, 47_000), stats7: st(40_000, 800_000, 5) };
    const decisions = planLadderBids([rich, ok]);
    expect(decisions.map((row) => [row.keyword.skuGroupId, row.role, row.action?.newCpm ?? null])).toEqual([['a', 'other', 9_500], ['b', 'top', 48_500]]);
    expect(formatLadderReport(decisions, { apply: true })).toContain('Не окупаются, из топ-10 убраны (1)');
  });

  it('сводка кампании: ДРР, расход с понедельника и предупреждение о бюджете', () => {
    expect(formatCampaignSummary({ name: 'Сауна', spend7: 140_000, revenue7: 1_000_000, sold7: 6, weekSpend: 120_000, weeklyBudget: 150_000, daysPassed: 3 }))
      .toBe('«Сауна»: реклама за 7 дней 140\u00a0000, выручка 1\u00a0000\u00a0000, продаж 6, ДРР 14.0 % · с понедельника 120\u00a0000 из 150\u00a0000 (80 %) — ⚠ при таком темпе кончится раньше воскресенья');
    expect(formatCampaignSummary({ name: 'J403', spend7: 0, revenue7: 0, sold7: 0, weekSpend: 160_000, weeklyBudget: 150_000, daysPassed: 5 })).toContain('бюджет кончился');
  });

  it('ставка не выше потолка 70 000 и не ниже минимума', () => {
    const [cheap] = planLadderBids([kw('a', 'набор полотенец', 9_500, 9_000)]);
    expect(cheap.target).toBe(9_500);
    expect(cheap.action).toBeNull();
    expect(actions([kw('a', 'полотенце банное', 40_000, 69_000), kw('b', 'полотенце банное', 9_500, 58_000)])).toEqual([['b', 'RAISE', 60_000]]);
    // наборы: потолок класса = общий потолок ставки 70 000
    expect(actions([kw('a', 'набор полотенец', 40_000, 69_000), kw('b', 'набор полотенец', 9_500, 58_000)])).toEqual([['b', 'RAISE', 60_000], ['a', 'RAISE', 70_000]]);
  });
});
