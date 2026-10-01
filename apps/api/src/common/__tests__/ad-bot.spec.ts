import { describe, expect, it } from 'vitest';
import { AD_BOT_DEFAULTS, AdBotInput, AdBotKeyword, AdBotStats, buildCampaignUpdate, clampBid, decideKeyword, formatAdBotReport, newKeywords, normalizeQuery, planAdBot, stopWordCandidates } from '../ad-bot';

const now = new Date('2026-09-28T11:00:00+05:00');
const kw = (patch: Partial<AdBotKeyword> = {}): AdBotKeyword => ({
  campaignId: '332097', campaignName: 'Банное 100×150', adId: '1', skuGroupId: '4160950', query: 'полотенце для сауны', cpm: 20_000, stopWords: ['вафельное'], ...patch,
});
const st = (patch: Partial<AdBotStats> = {}): AdBotStats => ({ impressions: 1_000, clicks: 30, sold: 0, revenue: 0, spend: 0, position: 8, ...patch });
function input(patch: Partial<AdBotInput> = {}, s14: Partial<AdBotStats> = {}, s7: Partial<AdBotStats> = {}): AdBotInput {
  return {
    keywords: [kw()],
    stats14: new Map([['1', st(s14)]]),
    stats7: new Map([['1', st({ impressions: 500, ...s7 })]]),
    groups: new Map([['4160950', { skuGroupId: '4160950', title: 'HAVANASAUNA-БЕЛЫЙ', stock: 10, price: 200_000 }]]),
    feed: [],
    lastChange: new Map(),
    now,
    ...patch,
  };
}
const decide = (patch: Partial<AdBotInput> = {}, s14: Partial<AdBotStats> = {}, s7: Partial<AdBotStats> = {}) => decideKeyword(kw(), input(patch, s14, s7));

describe('ставки', () => {
  it('в пределах 9 500…50 000, округление до 500 в сторону изменения', () => {
    expect(clampBid(17_100, 'down')).toBe(17_000);
    expect(clampBid(22_100, 'up')).toBe(22_500);
    expect(clampBid(5_000, 'down')).toBe(9_500);
    expect(clampBid(80_000, 'up')).toBe(50_000);
  });
  it('запросы сравниваются без регистра, ё и знаков', () => {
    expect(normalizeQuery('  Полотенце, для САУНЫ! ')).toBe('полотенце для сауны');
    expect(normalizeQuery('ёлка')).toBe('елка');
  });
});

describe('решения по слову', () => {
  it('нет продаж при расходе ≥ половины цены товара — снижаем на 25%', () => {
    const row = decide({}, { spend: 120_000, clicks: 40 });
    expect(row?.kind).toBe('LOWER');
    expect(row?.newCpm).toBe(15_000);
    expect(row?.reason).toContain('нет продаж');
  });
  it('ставка уже минимальная и расход ≥ цены — останавливаем слово; меньше — ждём', () => {
    const low = (spend: number) => decideKeyword(kw({ cpm: 9_500 }), input({ keywords: [kw({ cpm: 9_500 })] }, { spend, clicks: 40 }));
    expect(low(210_000)?.kind).toBe('SUSPEND');
    expect(low(150_000)).toBeNull();
  });
  it('мало кликов — о слове без продаж не судим', () => {
    expect(decide({}, { spend: 120_000, clicks: 10 }, { impressions: 500 })).toBeNull();
  });
  it('ДРР выше цели в 1,5 раза — −15%, просто выше цели — −7,5%', () => {
    expect(decide({}, { sold: 1, revenue: 200_000, spend: 40_000 })).toMatchObject({ kind: 'LOWER', newCpm: 17_000 });
    expect(decide({}, { sold: 1, revenue: 200_000, spend: 24_000 })).toMatchObject({ kind: 'LOWER', newCpm: 18_500 });
  });
  it('выгодное слово ниже 5-й позиции — поднимаем на 10%; уже в топе — не трогаем', () => {
    expect(decide({}, { sold: 3, revenue: 600_000, spend: 20_000, position: 9 })).toMatchObject({ kind: 'RAISE', newCpm: 22_000 });
    expect(decide({}, { sold: 3, revenue: 600_000, spend: 20_000, position: 3 })).toBeNull();
  });
  it('мало показов за 7 дней и расход в норме — поднимаем ради охвата', () => {
    const row = decide({}, { impressions: 100, clicks: 2, spend: 3_000 }, { impressions: 40 });
    expect(row).toMatchObject({ kind: 'RAISE', newCpm: 22_000 });
    expect(row?.reason).toContain('мало показов');
  });
  it('мало остатка — ставка на минимум и не поднимаем', () => {
    const groups = new Map([['4160950', { skuGroupId: '4160950', title: 'СЕРЫЙ', stock: 2, price: 200_000 }]]);
    expect(decide({ groups }, { impressions: 100 }, { impressions: 40 })).toMatchObject({ kind: 'LOWER', newCpm: 9_500 });
  });
  it('цвет не сматчился (нет ни цены, ни ДРР) — не судим и НЕ поднимаем', () => {
    // Раньше слово без данных о товаре считалось «дёшевым» и росло на каждый
    // прогон до максимума. «Нет данных» ≠ «всё хорошо».
    const noGroup = decide({ groups: new Map() }, { impressions: 9_000, clicks: 200, spend: 300_000, sold: 0 }, { impressions: 40 });
    expect(noGroup).toBeNull();
    const noPrice = decideKeyword(kw(), input({ groups: new Map([['4160950', { skuGroupId: '4160950', title: 'HAVANASAUNA-БЕЛЫЙ', stock: 10, price: null }]]) }, { impressions: 100, clicks: 2, spend: 3_000 }, { impressions: 40 }));
    expect(noPrice).toBeNull();
  });
  it('слово меняли меньше 3 дней назад — не трогаем', () => {
    const lastChange = new Map([['1', new Date('2026-09-27T11:00:00+05:00')]]);
    expect(decide({ lastChange }, { spend: 120_000, clicks: 40 })).toBeNull();
  });
});

describe('новые слова и план', () => {
  const feed = [
    { skuGroupId: '4160950', searchQuery: 'Полотенце для бани большое', impressions: 50, clicks: 5, sold: 2, revenue: 400_000 },
    { skuGroupId: '4160950', searchQuery: 'полотенце для сауны', impressions: 50, clicks: 5, sold: 3, revenue: 600_000 },
    { skuGroupId: '4160950', searchQuery: 'полотенце вафельное', impressions: 50, clicks: 5, sold: 1, revenue: 100_000 },
    { skuGroupId: '999', searchQuery: 'чужой цвет', impressions: 50, clicks: 5, sold: 5, revenue: 100_000 },
  ];
  it('берём реальные запросы с продажами, которых нет у цвета и без стоп-слов; ставка — медиана цвета', () => {
    const rows = newKeywords(input({ feed }));
    expect(rows.map((row) => row.query)).toEqual(['полотенце для бани большое']);
    expect(rows[0]).toMatchObject({ kind: 'ADD', newCpm: 20_000, skuGroupId: '4160950', stopWords: ['вафельное'] });
  });
  it('план: сначала снижения, потом новые слова, потом повышения; лимит за запуск', () => {
    const keywords = [kw(), kw({ adId: '2', query: 'katta sochiq' })];
    const data = input({ keywords, feed, stats14: new Map([['1', st({ spend: 120_000, clicks: 40 })], ['2', st({ impressions: 50 })]]), stats7: new Map([['2', st({ impressions: 10 })]]) });
    const plan = planAdBot(data);
    expect(plan.actions.map((row) => row.kind)).toEqual(['LOWER', 'ADD', 'RAISE']);
    const limited = planAdBot(data, { ...AD_BOT_DEFAULTS, maxChangesPerRun: 2 });
    expect(limited.actions).toHaveLength(2);
    expect(limited.deferred.map((row) => row.kind)).toEqual(['RAISE']);
  });
  it('тело PUT: только изменения, бюджет/название/период как есть', () => {
    const plan = planAdBot(input({ feed }, { spend: 120_000, clicks: 40 }));
    const body = buildCampaignUpdate({ name: 'Банное 100×150', budgetConfig: { weeklyAmount: 150_000, uniformDistribution: false }, period: { dateFrom: '2026-09-26', dateTo: null, isEndless: true } }, plan.actions);
    expect(body.advertisements).toEqual([
      { action: 'EDIT', advertisement: { id: 1, cpm: 15_000, promotionType: 'QUERY', query: 'полотенце для сауны', skuGroupId: 4160950, stopWords: ['вафельное'] } },
      { action: 'NEW', advertisement: { cpm: 20_000, promotionType: 'QUERY', query: 'полотенце для бани большое', skuGroupId: 4160950, stopWords: ['вафельное'] } },
    ]);
    expect(body.budgetConfig).toEqual({ reset: false, uniformDistribution: false, weeklyAmount: 150_000 });
    expect(body.period).toEqual({ dateFrom: '2026-09-26', dateTo: '', isEndless: true });
  });
  it('отчёт: по кампаниям, со ставками и причинами', () => {
    const plan = planAdBot(input({ feed }, { spend: 120_000, clicks: 40 }));
    const text = formatAdBotReport({ label: '28.09, 11:00', apply: true, plan, outcomes: [{ action: plan.actions[0], ok: true, message: 'готово' }], notes: [], keywordsCount: 1 }).join('\n');
    expect(text).toContain('ставки меняются');
    expect(text).toContain('📣 Банное 100×150');
    expect(text).toMatch(/⬇️ снизить «полотенце для сауны» — HAVANASAUNA-БЕЛЫЙ: 20\s000 → 15\s000 ✅/);
    expect(text).toContain('➕ новое слово «полотенце для бани большое»');
  });
});

describe('минус-слова', () => {
  const g = '4160950';
  const feed = [
    { skuGroupId: g, searchQuery: 'полотенце для сауны большое', impressions: 900, clicks: 20, atc: 2, sold: 3, revenue: 600_000 },
    { skuGroupId: g, searchQuery: 'халат для сауны', impressions: 400, clicks: 3, atc: 0, sold: 0, revenue: 0 },
    { skuGroupId: g, searchQuery: 'халат махровый женский', impressions: 150, clicks: 4, atc: 0, sold: 0, revenue: 0 },
    { skuGroupId: g, searchQuery: 'шапка для бани', impressions: 120, clicks: 2, atc: 0, sold: 0, revenue: 0 },
    { skuGroupId: g, searchQuery: 'полотенце детское 70', impressions: 350, clicks: 12, atc: 1, sold: 0, revenue: 0 },
    { skuGroupId: g, searchQuery: 'коврик 100', impressions: 500, clicks: 1, atc: 0, sold: 0, revenue: 0 },
  ];
  it('слово из запросов без продаж и корзин, которого нет в продающих запросах и во фразе', () => {
    const rows = stopWordCandidates(g, [kw({ stopWords: [] })], feed);
    expect(rows.map((row) => row.word)).toEqual(['халат', 'коврик']);
    expect(rows[0]).toMatchObject({ impressions: 550, clicks: 7 });
  });
  it('корзина — не минус-слово; уже добавленные и числа не повторяем; шапка — мало показов и кликов', () => {
    const rows = stopWordCandidates(g, [kw({ stopWords: ['Халат'] })], feed).map((row) => row.word);
    expect(rows).toEqual(['коврик']);
    expect(rows).not.toContain('детское');
    expect(rows).not.toContain('100');
    expect(rows).not.toContain('шапка');
  });
  it('план: минус-слова во все слова цвета — отдельным изменением без смены ставки или вместе со ставкой', () => {
    const keywords = [kw({ stopWords: [] }), kw({ adId: '2', query: 'katta sochiq', stopWords: [] })];
    const data = input({ keywords, feed, stats14: new Map([['1', st({ spend: 120_000, clicks: 40 })], ['2', st({ impressions: 5_000 })]]), stats7: new Map([['2', st({ impressions: 1_000 })]]) });
    const plan = planAdBot(data);
    const lower = plan.actions.find((row) => row.adId === '1')!;
    expect(lower).toMatchObject({ kind: 'LOWER', newCpm: 15_000, stopWords: ['халат', 'коврик'], addedStopWords: ['халат', 'коврик'] });
    const stop = plan.actions.find((row) => row.adId === '2')!;
    expect(stop).toMatchObject({ kind: 'STOPWORDS', oldCpm: 20_000, newCpm: 20_000, stopWords: ['халат', 'коврик'] });
    expect(buildCampaignUpdate({ name: 'x', budgetConfig: {}, period: {} }, [stop]).advertisements[0]).toEqual({ action: 'EDIT', advertisement: { id: 2, cpm: 20_000, promotionType: 'QUERY', query: 'katta sochiq', skuGroupId: 4160950, stopWords: ['халат', 'коврик'] } });
    const text = formatAdBotReport({ label: 'x', apply: false, plan, outcomes: [], notes: [], keywordsCount: 2 }).join('\n');
    expect(text).toContain('🚫 минус-слова «katta sochiq» — HAVANASAUNA-БЕЛЫЙ: + халат, коврик');
    expect(text).toContain('только предложения');
  });
  it('кулдаун действует и на чистую правку минус-слов', () => {
    const feed = [
      { skuGroupId: '4160950', searchQuery: 'полотенце детское', impressions: 500, clicks: 7, sold: 0, atc: 0, revenue: 0 },
      { skuGroupId: '4160950', searchQuery: 'полотенце для сауны', impressions: 900, clicks: 25, sold: 3, atc: 2, revenue: 500_000 },
    ];
    const fresh = planAdBot(input({ feed }));
    expect(fresh.actions.some((row) => row.kind === 'STOPWORDS')).toBe(true);
    const cooled = planAdBot(input({ feed, lastChange: new Map([['1', new Date(now.getTime() - 86_400_000)]]) }));
    expect(cooled.actions.some((row) => row.kind === 'STOPWORDS')).toBe(false);
  });
  it('слово с заметными кликами — не автоминус, а «на ручную проверку» в заметках', () => {
    // «adyol»-кейс: 657 показов и 10 кликов без продаж — покупатели считают
    // запрос релевантным; автоблок отрезал бы целевой узбекоязычный трафик.
    const risky = [...feed, { skuGroupId: g, searchQuery: 'adyol katta', impressions: 657, clicks: 12, atc: 0, sold: 0, revenue: 0 }];
    const plan = planAdBot(input({ keywords: [kw({ stopWords: [] })], feed: risky }, { impressions: 5_000 }, { impressions: 1_000 }));
    expect(plan.actions.flatMap((row) => row.addedStopWords || [])).not.toContain('adyol');
    expect(plan.notes.join(' ')).toContain('только вручную');
    expect(plan.notes.join(' ')).toContain('adyol');
  });
  it('форма слова самого товара («пледы» при ключе «плед») не предлагается в минус', () => {
    const pledFeed = [
      { skuGroupId: g, searchQuery: 'плед тёплый', impressions: 900, clicks: 20, atc: 1, sold: 2, revenue: 400_000 },
      { skuGroupId: g, searchQuery: 'пледы недорого', impressions: 400, clicks: 5, atc: 0, sold: 0, revenue: 0 },
    ];
    const rows = stopWordCandidates(g, [kw({ query: 'плед', stopWords: [] })], pledFeed).map((row) => row.word);
    expect(rows).not.toContain('пледы');
  });
  it('лимит Uzum 58 минус-слов: добавляем только сколько влезает', () => {
    const full = Array.from({ length: 57 }, (_, index) => `слово${index}`);
    const plan = planAdBot(input({ keywords: [kw({ stopWords: full })], feed }, { impressions: 5_000 }, { impressions: 1_000 }));
    expect(plan.actions[0].addedStopWords).toEqual(['халат']);
    expect(plan.notes.join(' ')).toContain('ещё 1 минус-слов не добавлено (лимит Uzum 58)');
  });
});
