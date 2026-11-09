import { describe, expect, it } from 'vitest';
import { activeCapTests, activeFocus, AD_LADDER_FOCUS, colourStockBlock, focusDrr, colourTitle, formatCampaignSummary, formatLadderDetails, formatLadderReport, launchCampaigns, ladderCampaigns, ladderDrrVerdict, ladderKey, ladderQueryClass, LadderKeyword, narrowClass, planLadderBids, skuSizeKind, sumLadderStats } from '../ad-ladder';
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
    expect(report).toContain('Лестница: в топ-10 2 из 2 пар «цвет + запрос»; правок сейчас: 3.');
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
    expect(formatLadderReport(decisions, { apply: true })).toContain('по ДРР из топа сняты 1');
    expect(formatLadderDetails(decisions)).toContain('Не окупаются, из топ-10 убраны (1):\n  HAVANA a «полотенце банное» — ДРР 25.0 % > 10 %');
  });

  it('ДРР по запросу целиком: расход, разбитый на цвета, не прячется под порогом данных одного цвета', () => {
    const st = (spend: number, revenue: number, sold: number) => ({ impressions: 400, clicks: 15, sold, revenue, spend, position: null });
    // 19–25.10 HAVANA «банное полотенце»: 65 000 на четыре цвета, ни один не набрал 30 000; ДРР запроса 11,3 % > 10 %.
    const chrome = { ...kw('chrome', 'банное полотенце', 51_500, 50_000), stats7: st(24_000, 458_000, 3) }; // сам окупается — 5,2 %
    const khaki = { ...kw('khaki', 'банное полотенце', 47_000, 45_000), stats7: st(16_000, 0, 0) };
    const white = { ...kw('white', 'банное полотенце', 40_000, 52_000), stats7: st(15_000, 59_000, 1) };
    const milk = { ...kw('milk', 'банное полотенце', 50_000, 48_000), stats7: st(10_000, 60_000, 1) };
    expect(sumLadderStats([chrome.stats7, khaki.stats7, null])).toMatchObject({ spend: 40_000, revenue: 458_000, sold: 3 });
    const decisions = planLadderBids([chrome, khaki, white, milk]);
    expect(decisions.map((row) => [row.keyword.skuGroupId, row.role, row.action?.newCpm ?? null])).toEqual([
      ['khaki', 'other', 44_500], ['milk', 'other', 47_500], ['chrome', 'top', null], ['white', 'other', null],
    ]);
    expect(decisions[0].blocked).toBe('по запросу (все цвета) ДРР 11.3 % > 10 %');
    // без статистики — прежнее правило: два самых дешёвых цвета в топ-10
    expect(planLadderBids([chrome, khaki, white, milk].map((row) => ({ ...row, stats7: null }))).filter((row) => row.role === 'top').map((row) => row.keyword.skuGroupId)).toEqual(['khaki', 'milk']);
    // расход запроса ≥ 50 000 без продаж — всем цветам минимальная ставка
    const a = { ...kw('a', 'полотенце банное', 30_000, 28_000), stats7: st(26_000, 0, 0) };
    const b = { ...kw('b', 'полотенце банное', 31_000, 29_000), stats7: st(26_000, 0, 0) };
    expect(actions([a, b])).toEqual([['a', 'LOWER', 9_500], ['b', 'LOWER', 9_500]]);
  });

  it('остаток размера: цвет без размера запроса не боевой и идёт на минимум, топ-10 — следующим цветам (J403 03.11)', () => {
    expect(['БЕЛЫЙ-Банный', 'СЕРЫЙ-70 x140', 'КРЕМОВ-банны', 'РОЗОВ-Микс', 'БЕЖЕВ-Havana', 'ГОЛУБ-комплек', 'БЕЛЫЙ-Сауна', 'НГОЛУБ-сауна', 'СЕРЫЙ-лицево', 'БЕЛЫЙ-50 x 90', 'ГОЛУБ-салфетк', 'beach', 'БЕЛЫЙ'].map(skuSizeKind))
      .toEqual(['bath', 'bath', 'bath', 'set', 'set', 'set', 'big', 'big', 'face', 'face', 'hand', 'big', null]);
    const white = [{ title: 'БЕЛЫЙ-Банный', quantity: 0 }, { title: 'БЕЛЫЙ-Лицевой', quantity: 20 }, { title: 'БЕЛЫЙ-Микс', quantity: 0 }, { title: 'БЕЛЫЙ-Сауна', quantity: 9 }];
    expect(colourStockBlock('полотенце банное', white)).toBe('у цвета нет банного в наличии');
    expect(colourStockBlock('sochiq yuz va hammom', white)).toBe('у цвета нет банного в наличии');
    expect(colourStockBlock('Набор полотенец', white)).toBe('у цвета нет наборов в наличии');
    expect(colourStockBlock("sochiq to'plami", white)).toBe('у цвета нет наборов в наличии');
    for (const q of ['полотенце для лица', 'полотенце для сауны', 'полотенце для бани', 'полотенце']) expect(colourStockBlock(q, white)).toBeNull();
    // у HAVANA 100×150 нет вовсе — фраза про баню выбрана сознательно; нет данных об остатке — не блокируем
    expect(colourStockBlock('полотенце для бани', [{ title: 'БЕЛЫЙ-50 x 90', quantity: 29 }, { title: 'БЕЛЫЙ-70 x140', quantity: 0 }])).toBeNull();
    expect(colourStockBlock('полотенце банное', null)).toBeNull();
    // сауна 2263224: у цвета один SKU без размера в названии
    expect(colourStockBlock('sauna sochiq', [{ title: 'СВЕТКОР', quantity: 0 }])).toBe('у цвета нет остатка');
    expect(colourStockBlock('sauna sochiq', [{ title: 'СВЕТКОР', quantity: 2 }])).toBeNull();
    // белый — самый дешёвый топ-10, но без 70×140: на минимум даже в паузе после правки, боевые — серый и розовый
    const w = { ...kw('white', 'полотенце банное', 60_000, 45_000), skus: white };
    const grey = { ...kw('grey', 'полотенце банное', 15_000, 50_000), skus: [{ title: 'СЕРЫЙ-Банный', quantity: 8 }] };
    const pink = { ...kw('pink', 'полотенце банное', 37_500, 52_000), skus: [{ title: 'РОЗОВ-Банный', quantity: 9 }] };
    const decisions = planLadderBids([w, grey, pink], undefined, new Set([ladderKey(w)]));
    expect(decisions.map((row) => [row.keyword.skuGroupId, row.role, row.action?.newCpm ?? null])).toEqual([['white', 'other', 9_500], ['grey', 'top', 51_500], ['pink', 'top', 54_000]]);
    expect(decisions[0]).toMatchObject({ noStock: 'у цвета нет банного в наличии', blocked: null });
    expect(decisions[0].action?.reason).toBe('лестница: у цвета нет банного в наличии — ставка на минимум');
    const report = formatLadderReport(decisions, { apply: true, titles: new Map([['white', 'белый']]) });
    expect(report).toContain('⚠ Нет или меньше 5 шт, реклама на минимуме: HAVANA: белый (банное)');
    expect(report).not.toContain('по ДРР');
    expect(formatLadderDetails(decisions)).toContain('HAVANA: white — у цвета нет банного в наличии: «полотенце банное»');
    // остатки не получены — прежнее правило
    expect(planLadderBids([w, grey, pink].map((row) => ({ ...row, skus: null }))).filter((row) => row.role === 'top').map((row) => row.keyword.skuGroupId)).toEqual(['white', 'grey']);
  });

  it('тест потолка: цвет держим в топ-10 до своего потолка, пока ДРР ≤ порога теста; после срока — обычный потолок', () => {
    const blue = { ...kw('blue', 'sochiq', 16_500, 30_000), campaignId: '305122' };
    const test = { campaignId: '305122', skuGroupId: 'blue', query: 'sochiq', cap: 35_000, maxDrr: 8, until: '2026-11-03' };
    expect(planLadderBids([blue])[0]).toMatchObject({ role: 'other', action: null }); // потолок «узбекских основных» 25 000
    expect(planLadderBids([blue], undefined, new Set(), new Set(), {}, [test])[0]).toMatchObject({ role: 'top', action: { kind: 'RAISE', newCpm: 31_000 } });
    const costly = { ...blue, cpm: 31_000, stats7: { impressions: 2000, clicks: 60, sold: 4, revenue: 380_000, spend: 34_000, position: null } }; // ДРР 8,9 %
    expect(planLadderBids([costly], undefined, new Set(), new Set(), {}, [test])[0]).toMatchObject({ role: 'other', blocked: 'ДРР 8.9 % > 8 %', action: { kind: 'LOWER', newCpm: 29_500 } });
    expect(activeCapTests('2026-11-03').filter((row) => row.campaignId === '305122').map((row) => row.query)).toEqual(['sochiq', 'sochiqlar', 'полотенце банное']);
    // 04.11: голубой j471 на «полотенце банное» до 65 000 неделю — топ-10 голубого дороже потолка банных 60 000
    expect(activeCapTests('2026-11-04').filter((row) => row.campaignId === '305122')).toEqual([{ campaignId: '305122', skuGroupId: '5374111', query: 'полотенце банное', cap: 65_000, maxDrr: 8, until: '2026-11-11' }]);
    const sky = { ...kw('5374111', 'полотенце банное', 9_500, 61_000), campaignId: '305122' };
    expect(planLadderBids([sky])[0]).toMatchObject({ role: 'other', action: null });
    expect(planLadderBids([sky], undefined, new Set(), new Set(), {}, activeCapTests('2026-11-04'))[0]).toMatchObject({ role: 'top', action: { kind: 'RAISE', newCpm: 63_000 } });
    expect(activeCapTests('2026-11-12').filter((row) => row.campaignId === '305122')).toEqual([]);
  });

  it('кампания «держим в топ-10»: оба цвета в топе по любой фразе до общего потолка ставки', () => {
    const pink = { ...kw('pink', 'полотенце для рук', 15_000, 41_546), campaignId: '337334' };
    const blue = { ...kw('blue', 'полотенце для рук', 15_000, 45_000), campaignId: '337334' };
    expect(planLadderBids([pink, blue], undefined, new Set(), new Set(), {}).map((row) => row.role)).toEqual(['other', 'other']); // потолок «остальных» 20 000
    const held = planLadderBids([pink, blue], undefined, new Set(), new Set(), { '337334': 2 });
    expect(held.map((row) => [row.keyword.skuGroupId, row.role, row.action?.newCpm])).toEqual([['pink', 'top', 43_000], ['blue', 'top', 46_500]]);
  });

  it('льгота запуска новинки: ДРР не проверяется до конца срока', () => {
    const st = { impressions: 1000, clicks: 30, sold: 0, revenue: 0, spend: 60_000, position: null };
    const fresh = { ...kw('a', 'полотенце банное', 48_000, 45_760), campaignId: '337334', stats7: st };
    expect(planLadderBids([fresh], undefined, new Set(), new Set(['337334']))[0]).toMatchObject({ role: 'top', blocked: null });
    expect(planLadderBids([fresh])[0]).toMatchObject({ role: 'other' });
    expect([...launchCampaigns('2026-10-20', { '337334': '2026-11-01' })]).toEqual(['337334']);
    expect([...launchCampaigns('2026-11-02', { '337334': '2026-11-01' })]).toEqual([]);
    // 04.11.2026 («лишь бы не просрать деньги»): льгота и тесты потолков Сердечек сняты — ДРР 53 % за 7 дней.
    expect([...launchCampaigns('2026-11-10')]).toEqual([]);
    expect(activeCapTests('2026-11-10').filter((row) => row.campaignId === '337334')).toEqual([]);
  });

  it('узкие ключи товара: один цвет в топ-10 до потолка карточки, свой ДРР, стоп после 25 000 без продаж', () => {
    expect(narrowClass('332097', 'Полотенце  100х150')).toMatchObject({ name: 'узкие ключи товара', cap: 45_000, colors: 1, maxDrr: 9, noSaleSpend: 25_000 });
    expect(narrowClass('286528', 'sochiq')).toBeNull();
    expect(narrowClass('286528', 'полотенце 100х150')).toBeNull(); // узкие ключи — свои у каждой кампании
    expect(narrowClass('337334', "qo'l sochiq")).toMatchObject({ cap: 25_000, maxDrr: 12 });
    expect(ladderCampaigns()).toContain('305326'); // плед в лестнице
    const sauna = (g: string, query: string, cpm: number, top10: number | null) => ({ ...kw(g, query, cpm, top10), campaignId: '332097' });
    // Топ-10 «полотенце 100х150» 17 893 (лестница 04.11): один цвет поднимаем, второй не трогаем (в классе «наборы, сауна» было бы два).
    const plan = planLadderBids([sauna('a', 'полотенце 100х150', 9_500, 17_893), sauna('b', 'полотенце 100х150', 9_500, 19_000)]);
    expect(plan.map((row) => [row.keyword.skuGroupId, row.role, row.action?.newCpm ?? null])).toEqual([['a', 'top', 18_500], ['b', 'other', null]]);
    // «полотенце банное большое» — топ-10 66 208 дороже потолка сауны 45 000: не в топе.
    expect(planLadderBids([sauna('a', 'полотенце банное большое', 9_500, 66_208)])[0]).toMatchObject({ role: 'other', action: null });
    // 26 000 за 7 дней без продаж — ставка на минимум (у общих классов порог 50 000).
    const dry = { impressions: 900, clicks: 12, sold: 0, revenue: 0, spend: 26_000, position: null };
    expect(planLadderBids([{ ...sauna('a', 'sauna sochiq', 20_000, 14_201), stats7: dry }])[0]).toMatchObject({ role: 'other', action: { kind: 'LOWER', newCpm: 9_500 } });
    expect(planLadderBids([{ ...sauna('a', 'полотенце банное', 20_000, 14_201), stats7: dry }])[0]).toMatchObject({ role: 'top', action: { newCpm: 15_000 } }); // общий класс: 26 000 без продаж ещё не повод
    // Свой потолок ДРР карточки: HAVANA 9 % — при ДРР 10 % узкая фраза не в топе.
    const havana = { ...kw('k', 'полотенце банное мужское', 9_500, 12_230), stats7: { impressions: 2_000, clicks: 40, sold: 3, revenue: 400_000, spend: 40_000, position: null } };
    expect(planLadderBids([havana])[0]).toMatchObject({ role: 'other', blocked: 'ДРР 10.0 % > 9 %' });
  });

  it('сводка кампании: ДРР и предупреждение о бюджете одной строкой', () => {
    expect(formatCampaignSummary({ name: 'Сауна 100×150', spend7: 140_000, revenue7: 1_000_000, sold7: 6, weekSpend: 120_000, weeklyBudget: 150_000, daysPassed: 3 }).replace(/ /g, ' '))
      .toBe('Сауна 100×150 — 140 тыс., 6 прод., ДРР 14,0 % · ⚠ бюджет 150 тыс. кончится до воскресенья');
    expect(formatCampaignSummary({ name: 'Плед', spend7: 836, revenue7: 0, sold7: 0, weekSpend: 0, weeklyBudget: 150_000, daysPassed: 0 })).toBe('Плед — 836 сум, 0 прод., продаж с рекламы нет');
    // понедельник: за неделю данных ещё нет — темп не считаем
    expect(formatCampaignSummary({ name: 'J471', spend7: 159_000, revenue7: 4_748_000, sold7: 52, weekSpend: 0, weeklyBudget: 250_000, daysPassed: 0 })).toBe('J471 — 159 тыс., 52 прод., ДРР 3,3 %');
    expect(formatCampaignSummary({ name: 'J403', spend7: 0, revenue7: 0, sold7: 0, weekSpend: 160_000, weeklyBudget: 150_000, daysPassed: 5 })).toContain('бюджет кончился');
  });

  it('отчёт в Telegram короткий: итог, кампании по расходу, одна строка лестницы, только то, что требует действий', () => {
    expect(colourTitle([{ title: 'БЕЛЫЙ-Банный' }])).toBe('белый');
    expect(colourTitle([{ title: 'НГОЛУБ-сауна' }])).toBe('нголуб');
    expect(colourTitle([{ title: 'БЕЛЫЙ' }])).toBe('белый');
    expect(colourTitle([])).toBeNull();
    const campaigns = [
      { name: 'J471', spend7: 159_194, revenue7: 4_748_000, sold7: 52, weekSpend: 0, weeklyBudget: 250_000, daysPassed: 0 },
      { name: 'HAVANA', spend7: 171_283, revenue7: 3_545_000, sold7: 45, weekSpend: 0, weeklyBudget: 250_000, daysPassed: 0 },
    ];
    const rows = [kw('khaki', 'полотенце банное', 55_000, 45_760), kw('white', 'полотенце банное', 51_000, 54_576)];
    const report = formatLadderReport(planLadderBids(rows), { apply: true, campaigns, edits: { count: 274, hours: 24 } });
    expect(report.replace(/ /g, ' ').split('\n')).toEqual([
      '📶 Реклама «Буст в ТОП» за 7 дней: 330 тыс., продаж 97, ДРР 4,0 %',
      'HAVANA — 171 тыс., 45 прод., ДРР 4,8 %',
      'J471 — 159 тыс., 52 прод., ДРР 3,4 %',
      '',
      'Лестница: в топ-10 2 из 2 пар «цвет + запрос»; правок за сутки: 274.',
    ]);
    expect(formatLadderReport([], { apply: false })).toContain('Режим предложений');
    expect(formatLadderReport([], { apply: true, failed: 2, notes: ['кампания Плед не активна — пропущена'] })).toContain('⚠ Не прошло правок: 2\n⚠ кампания Плед не активна — пропущена');
  });

  it('мало остатка (меньше 5 шт нужного размера): цвет не боевой и на минимуме; 5 шт и больше — как раньше', () => {
    const skus = [{ title: 'РОЗОВ-лицевой', quantity: 4 }, { title: 'РОЗОВ-банный', quantity: 9 }, { title: 'РОЗОВ-комплек', quantity: 3 }];
    expect(colourStockBlock('полотенце для лица', skus, 5)).toBe('у цвета лицевого осталось 4 шт');
    expect(colourStockBlock('полотенце банное', skus, 5)).toBeNull();
    expect(colourStockBlock('набор полотенец', skus, 5)).toBe('у цвета наборов осталось 3 шт');
    expect(colourStockBlock('полотенце', [{ title: 'БЕЛЫЙ', quantity: 3 }], 5)).toBe('у цвета осталось 3 шт');
    expect(colourStockBlock('полотенце для лица', skus)).toBeNull(); // без порога — прежнее правило «только ноль»
    const pink = { ...kw('pink', 'полотенце для лица', 30_000, 20_000), skus };
    const blue = { ...kw('blue', 'полотенце для лица', 15_000, 25_000), skus: [{ title: 'ГОЛУБ-лицевой', quantity: 14 }] };
    const decisions = planLadderBids([pink, blue]);
    expect(decisions.map((row) => [row.keyword.skuGroupId, row.role, row.action?.newCpm ?? null])).toEqual([['pink', 'other', 9_500], ['blue', 'top', 26_000]]);
    expect(formatLadderReport(decisions, { apply: true, titles: new Map([['pink', 'розовый']]) })).toContain('⚠ Нет или меньше 5 шт, реклама на минимуме: HAVANA: розовый (лицевое 4 шт)');
  });

  it('акцент: Сердечки, сауна и 100×150 у J471/J403 — потолок ДРР 15 % до 03.12, остальное по-старому', () => {
    const focus = activeFocus('2026-11-10');
    expect(focus).toHaveLength(4);
    expect(activeFocus('2026-12-04')).toHaveLength(0);
    expect(focusDrr('337334', 'полотенце для лица', focus)).toBe(15);
    expect(focusDrr('332097', 'большое полотенце', focus)).toBe(15);
    expect(focusDrr('305122', 'полотенце для сауны', focus)).toBe(15);
    expect(focusDrr('305122', 'полотенце банное', focus)).toBeNull();
    expect(focusDrr('286528', 'полотенце для сауны', focus)).toBeNull(); // у HAVANA нет 100×150
    expect(AD_LADDER_FOCUS.every((row) => row.until === '2026-12-03')).toBe(true);
    // Сердечки, узкая фраза: свой потолок 12 %, ДРР 13,3 % — без акцента не в топе, с акцентом в топе.
    const hearts = { ...kw('pink', 'детское полотенце', 9_500, 12_000), campaignId: '337334', stats7: { impressions: 2_000, clicks: 40, sold: 3, revenue: 300_000, spend: 40_000, position: null } };
    expect(planLadderBids([hearts])[0]).toMatchObject({ role: 'other', blocked: 'ДРР 13.3 % > 12 %' });
    expect(planLadderBids([hearts], undefined, undefined, undefined, undefined, [], undefined, focus)[0]).toMatchObject({ role: 'top', blocked: null, action: { newCpm: 12_500 } });
  });

  it('ставка не выше потолка 70 000 и не ниже минимума', () => {
    const [cheap] = planLadderBids([kw('a', 'набор полотенец', 9_500, 9_000)]);
    expect(cheap.target).toBe(9_500);
    expect(cheap.action).toBeNull();
    expect(actions([kw('a', 'полотенце банное', 40_000, 69_000), kw('b', 'полотенце банное', 9_500, 58_000)])).toEqual([['b', 'RAISE', 60_000]]);
    // наборы: потолок класса = общий потолок ставки 70 000
    expect(actions([kw('a', 'набор полотенец', 40_000, 69_000), kw('b', 'набор полотенец', 9_500, 58_000)])).toEqual([['b', 'RAISE', 60_000], ['a', 'RAISE', 70_000]]);
  });

  it('топ-10 дороже потолка: к потолку не поднимаем и цвет не боевой (Сердечки 31.10–02.11: 70 000 за 13-е место)', () => {
    const dear = planLadderBids([kw('a', 'набор полотенец', 40_000, 80_000)])[0];
    expect(dear).toMatchObject({ role: 'other', action: null });
    const held = planLadderBids([{ ...kw('p', 'полотенце для рук', 33_500, 131_064), campaignId: '337334' }], undefined, new Set(), new Set(), { '337334': 2 })[0];
    expect(held).toMatchObject({ role: 'other', action: null });
    // чуть дешевле потолка — по-прежнему боевой
    expect(planLadderBids([kw('a', 'набор полотенец', 40_000, 67_000)])[0]).toMatchObject({ role: 'top', action: { newCpm: 69_500 } });
  });
});
