import { describe, expect, it } from 'vitest';
import { AD_BOT_DEFAULTS, AdBotInput, AdBotKeyword, AdBotStats, buildCampaignUpdate, clampBid, configFor, decideKeyword, formatAdBotReport, groupDrrTarget, isRelevantQuery, newKeywords, normalizeQuery, planAdBot, seedKeywordActions, stopWordCandidates } from '../ad-bot';

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
  it('медленный запас (≥ 60 дн.) и известная маржа — потолок ДРР = маржа − 5 п.п., но не выше 30 и не ниже цели', () => {
    const slow = (patch = {}) => new Map([['4160950', { skuGroupId: '4160950', title: 'СЕРЫЙ', stock: 40, price: 200_000, daysOfStock: 90, marginPercent: 23, ...patch }]]);
    expect(groupDrrTarget(slow().get('4160950'))).toBe(18);
    expect(groupDrrTarget(slow({ marginPercent: 40 }).get('4160950'))).toBe(30);
    expect(groupDrrTarget(slow({ marginPercent: 12 }).get('4160950'))).toBe(10);
    expect(groupDrrTarget(slow({ daysOfStock: 20 }).get('4160950'))).toBe(10);
    expect(groupDrrTarget(slow({ marginPercent: null }).get('4160950'))).toBe(10);
    expect(groupDrrTarget(slow({ daysOfStock: Infinity }).get('4160950'))).toBe(18);
    // ДРР 20% при потолке 18% — снижаем на половину шага; при обычном запасе то же слово получило бы −15%
    const row = decide({ groups: slow() }, { sold: 1, revenue: 200_000, spend: 40_000 });
    expect(row).toMatchObject({ kind: 'LOWER', newCpm: 18_500 });
    expect(row?.reason).toContain('потолок 18%');
    // ДРР 15% при потолке 18% — не трогаем; при потолке 10% снизили бы
    expect(decide({ groups: slow() }, { sold: 1, revenue: 200_000, spend: 30_000 })).toBeNull();
    expect(decide({}, { sold: 1, revenue: 200_000, spend: 30_000 })?.kind).toBe('LOWER');
  });
  it('узбекская фраза без продаж — не поднимаем выше 9 500 ни ради охвата, ни «снова на складе»; с продажей — как обычно', () => {
    const groups = new Map([['4160950', { skuGroupId: '4160950', title: 'ШОКОЛ', stock: 19, price: 69_200 }]]);
    const uz = (patch: Partial<AdBotKeyword>, s14: Partial<AdBotStats>, s7: Partial<AdBotStats>) => decideKeyword(kw({ query: 'sochiqlar', ...patch }), input({ groups, keywords: [kw({ query: 'sochiqlar', ...patch })] }, s14, s7));
    expect(uz({ cpm: 9_500 }, { impressions: 0, clicks: 0 }, { impressions: 0 })).toBeNull();
    expect(uz({ cpm: 9_500 }, { impressions: 100, clicks: 2, spend: 3_000 }, { impressions: 40 })).toBeNull();
    expect(uz({ cpm: 9_500, query: 'сочиклар' }, { impressions: 100, clicks: 2, spend: 3_000 }, { impressions: 40 })).toBeNull();
    expect(uz({ cpm: 20_000 }, { sold: 3, revenue: 600_000, spend: 20_000, position: 9 }, {})).toMatchObject({ kind: 'RAISE', newCpm: 22_000 });
    expect(uz({ cpm: 20_000 }, { spend: 120_000, clicks: 40 }, {})).toMatchObject({ kind: 'LOWER' });
  });
  it('мало остатка — ставка на минимум и не поднимаем', () => {
    const groups = new Map([['4160950', { skuGroupId: '4160950', title: 'СЕРЫЙ', stock: 2, price: 200_000 }]]);
    expect(decide({ groups }, { impressions: 100 }, { impressions: 40 })).toMatchObject({ kind: 'LOWER', newCpm: 9_500 });
  });
  it('товар вернулся, ставка на минимуме и показов нет — сразу возвращаем 15 000, не ждём 10 показов', () => {
    const groups = new Map([['4160950', { skuGroupId: '4160950', title: 'ШОКОЛ', stock: 19, price: 69_200 }]]);
    const back = decideKeyword(kw({ cpm: 9_500 }), input({ groups }, { impressions: 0, clicks: 0 }, { impressions: 0 }));
    expect(back).toMatchObject({ kind: 'RAISE', newCpm: 15_000 });
    expect(back?.reason).toContain('снова на складе');
    // показы есть — обычные правила, не этот
    expect(decideKeyword(kw({ cpm: 9_500 }), input({ groups }, { impressions: 30, clicks: 1 }, { impressions: 12 }))?.reason).not.toContain('снова на складе');
    // потолок кампании ограничивает и этот возврат
    expect(decideKeyword(kw({ cpm: 9_500 }), input({ groups }, { impressions: 0 }, { impressions: 0 }), { ...AD_BOT_DEFAULTS, campaignMaxBid: { '332097': 12_000 } })?.newCpm).toBe(12_000);
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
  it('берём реальные запросы с продажами, которых нет у цвета и без стоп-слов; ставка — минимальная, не медиана', () => {
    const rows = newKeywords(input({ feed }));
    expect(rows.map((row) => row.query)).toEqual(['полотенце для бани большое']);
    expect(rows[0]).toMatchObject({ kind: 'ADD', newCpm: 9_500, skuGroupId: '4160950', stopWords: ['вафельное'] });
  });
  it('узбекский запрос (латиница) берём без продажи только при ≥ 3 кликах и корзине — по 9 500; русский без продажи — нет', () => {
    const uz = [
      ...feed,
      { skuGroupId: '4160950', searchQuery: 'sochiqlar', impressions: 900, clicks: 4, atc: 1, sold: 0, revenue: 0 },
      { skuGroupId: '4160950', searchQuery: 'katta sochiq', impressions: 900, clicks: 4, atc: 0, sold: 0, revenue: 0 },
      { skuGroupId: '4160950', searchQuery: 'sochiq to\'plami', impressions: 300, clicks: 2, atc: 1, sold: 0, revenue: 0 },
      { skuGroupId: '4160950', searchQuery: 'полотенце махровое', impressions: 900, clicks: 9, sold: 0, revenue: 0 },
    ];
    const rows = newKeywords(input({ feed: uz }), { ...AD_BOT_DEFAULTS, newKeywordsPerGroup: 3 });
    expect(rows.map((row) => row.query)).toEqual(['полотенце для бани большое', 'sochiqlar']);
    expect(rows[1]).toMatchObject({ newCpm: 9_500 });
    expect(rows[1].reason).toContain('узбекский запрос без продажи');
  });
  it('посторонние запросы не добавляем даже с продажей: нет слова товара или есть запретное; не больше одной фразы на цвет', () => {
    const junk = [
      ...feed,
      { skuGroupId: '4160950', searchQuery: 'штаны мужские теплые для дома', impressions: 500, clicks: 20, sold: 2, revenue: 300_000 },
      { skuGroupId: '4160950', searchQuery: 'sochiq nabor banya xalat', impressions: 500, clicks: 5, atc: 2, sold: 0, revenue: 0 },
      { skuGroupId: '4160950', searchQuery: 'barashka pled', impressions: 500, clicks: 5, atc: 2, sold: 1, revenue: 150_000 },
      { skuGroupId: '4160950', searchQuery: 'полотенце махровое большое', impressions: 500, clicks: 5, sold: 4, revenue: 800_000 },
    ];
    const rows = newKeywords(input({ feed: junk }));
    expect(rows.map((row) => row.query)).toEqual(['полотенце махровое большое']);
    expect(isRelevantQuery('плед для пикника')).toBe(true);
    expect(isRelevantQuery('yopinchiq 100x170')).toBe(true);
    expect(isRelevantQuery('костюм для бани')).toBe(false);
    expect(isRelevantQuery('детская кроватка')).toBe(false);
  });
  it('план: сначала снижения, потом новые слова, потом повышения; лимит за запуск', () => {
    const keywords = [kw(), kw({ adId: '2', query: 'большое полотенце' })];
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
      { action: 'NEW', advertisement: { cpm: 9_500, promotionType: 'QUERY', query: 'полотенце для бани большое', skuGroupId: 4160950, stopWords: ['вафельное'] } },
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

describe('ручной посев фраз', () => {
  it('новые фразы — во все цвета кампании, существующим — заданная ставка; «soch» у узбекских новых фраз заменяется на «soch uchun»', () => {
    const keywords = [
      kw(),
      kw({ adId: '2', skuGroupId: '777', query: 'полотенце для сауны', cpm: 30_000, stopWords: ['soch', 'вафельное'] }),
      kw({ adId: '3', campaignId: '286528', campaignName: 'HAVANA', skuGroupId: '5856539', query: 'полотенце', cpm: 40_000, stopWords: [] }),
    ];
    const actions = seedKeywordActions(keywords, [{ campaignId: '332097', phrases: [{ query: 'Полотенце для сауны', cpm: 25_000 }, { query: 'sauna sochiq', cpm: 15_000 }, { query: 'полотенце 100х150', cpm: 30_000 }] }]);
    expect(actions.map((row) => [row.skuGroupId, row.kind, row.query, row.newCpm])).toEqual([
      ['4160950', 'RAISE', 'полотенце для сауны', 25_000],
      ['4160950', 'ADD', 'sauna sochiq', 15_000],
      ['4160950', 'ADD', 'полотенце 100х150', 30_000],
      ['777', 'LOWER', 'полотенце для сауны', 25_000],
      ['777', 'ADD', 'sauna sochiq', 15_000],
      ['777', 'ADD', 'полотенце 100х150', 30_000],
    ]);
    expect(actions[1].stopWords).toEqual(['вафельное']);
    expect(actions[4].stopWords).toEqual(['вафельное', 'soch uchun', 'sochlar uchun']);
    expect(actions[5].stopWords).toEqual(['soch', 'вафельное']);
    // чужая кампания не тронута; совпадающая ставка — без действия
    expect(seedKeywordActions(keywords, [{ campaignId: '286528', phrases: [{ query: 'полотенце', cpm: 40_000 }] }])).toEqual([]);
    // onlyExisting — в цвета без фразы не добавляем; exceptGroups — цвет не трогаем
    const only = seedKeywordActions(keywords, [{ campaignId: '332097', phrases: [{ query: 'полотенце для сауны', cpm: 9_500, onlyExisting: true, exceptGroups: ['777'] }, { query: 'sauna sochiq', cpm: 9_500, onlyExisting: true }] }]);
    expect(only.map((row) => [row.skuGroupId, row.kind, row.newCpm])).toEqual([['4160950', 'LOWER', 9_500]]);
  });
  it('правка минус-слов: убрать, добавить, при полном списке выбросить бесполезные; только узбекские фразы', () => {
    const full = Array.from({ length: 56 }, (_, index) => `слово${index}`).concat(['soch', 'майнкрафт']);
    const keywords = [
      kw({ adId: '1', query: 'sauna sochiq', cpm: 15_000, stopWords: full }),
      kw({ adId: '2', query: 'полотенце для сауны', cpm: 20_000, stopWords: ['soch'] }),
      kw({ adId: '3', query: 'katta sochiq', cpm: 15_000, stopWords: ['oshxona', 'salfetka'] }),
    ];
    const rows = seedKeywordActions(keywords, [{ campaignId: '332097', stopWords: { remove: ['soch'], add: ['soch uchun', 'sochlar uchun', 'oshxona', 'salfetka'], dropIfFull: ['майнкрафт', 'волка'], onlyLatin: true } }]);
    // остановка по точному запросу во всех кампаниях («*») и целого цвета по id группы
    const stop = seedKeywordActions(keywords, [{ campaignId: '*', suspend: ['Sauna  sochiq', 'штаны'] }]);
    expect(stop.map((row) => [row.adId, row.kind])).toEqual([['1', 'SUSPEND']]);
    const stopGroup = seedKeywordActions(keywords, [{ campaignId: '332097', suspendGroups: ['4160950'], phrases: [{ query: 'banya sochiq', cpm: 9_500 }], stopWords: { add: ['костюм'] } }]);
    // остановленный цвет: только SUSPEND — ни новых фраз, ни правок минус-слов ему не нужно
    expect(stopGroup.map((row) => [row.skuGroupId, row.kind])).toEqual([['4160950', 'SUSPEND'], ['4160950', 'SUSPEND'], ['4160950', 'SUSPEND']]);
    expect(stopGroup[0].reason).toContain('цвета');
    // потолок ставки по кампании: 50 000 → 18 500 только для 332097
    const capped = { ...AD_BOT_DEFAULTS, campaignMaxBid: { '332097': 18_500 } };
    expect(clampBid(40_000, 'up', configFor('332097', capped))).toBe(18_500);
    expect(clampBid(40_000, 'up', configFor('286528', capped))).toBe(40_000);
    expect(decideKeyword(kw({ cpm: 18_000 }), input({}, { sold: 3, revenue: 600_000, spend: 20_000, position: 9 }), capped)?.newCpm).toBe(18_500);
    // копирование объявлений цвета-источника в пустой цвет (возобновление группы / новый цвет)
    const cloned = seedKeywordActions(keywords, [{ campaignId: '332097', cloneGroups: { '999': '4160950' } }]);
    expect(cloned.map((row) => [row.skuGroupId, row.kind, row.query, row.newCpm])).toEqual([
      ['999', 'ADD', 'sauna sochiq', 15_000], ['999', 'ADD', 'полотенце для сауны', 20_000], ['999', 'ADD', 'katta sochiq', 15_000],
    ]);
    expect(cloned[0].stopWords).toEqual(keywords[0].stopWords);
    expect(cloned[0].reason).toContain('скопировано из цвета 4160950');
    // бюджет кампании через buildCampaignUpdate
    const body = buildCampaignUpdate({ name: 'x', budgetConfig: { weeklyAmount: 150_000, uniformDistribution: false }, period: { dateFrom: '2026-09-26', dateTo: null, isEndless: true } }, [], { weeklyAmount: 50_000, uniform: true });
    expect(body.budgetConfig).toEqual({ reset: false, uniformDistribution: true, weeklyAmount: 50_000 });
    expect(body.advertisements).toEqual([]);
    // русская фраза (adId 2) не тронута; у adId 3 просто добавились две минус-фразы
    expect(rows.map((row) => [row.adId, row.kind, row.newCpm])).toEqual([['1', 'STOPWORDS', 15_000], ['3', 'STOPWORDS', 15_000]]);
    expect(rows[1].stopWords).toEqual(['oshxona', 'salfetka', 'soch uchun', 'sochlar uchun', 'detskiy', 'qogoz', 'moshina', 'tabletka'].filter((word) => ['oshxona', 'salfetka', 'soch uchun', 'sochlar uchun'].includes(word)));
    const words = rows[0].stopWords;
    expect(words).toHaveLength(58);
    expect(words).not.toContain('soch');
    expect(words).not.toContain('майнкрафт');
    expect(words).toContain('soch uchun');
    expect(words).toContain('sochlar uchun');
    // 56 + 2 новых = 58: место под oshxona/salfetka не нашлось — они не добавлены, лимит не нарушен
    expect(words).not.toContain('oshxona');
    expect(rows[0].reason).toContain('58 → 58');
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
