import { describe, expect, it } from 'vitest';
import type { AdBotStats } from '../ad-bot';
import { AUTO_BIDDER_DEFAULTS, AutoBidContext, AutoBidKeyword, AutoBidPolicy, BidLadderStep, bidForReach, decideAutoBid, formatAutoBidderReport, parseLadder, planAutoBidder, policyKey, reachForBid } from '../auto-bidder';

const now = new Date('2026-10-06T12:00:00+05:00');
const ladder: BidLadderStep[] = [
  { position: 4, cpm: 36_844, impressionPercent: 100 }, { position: 5, cpm: 36_570, impressionPercent: 90 }, { position: 7, cpm: 31_747, impressionPercent: 80 },
  { position: 9, cpm: 27_776, impressionPercent: 70 }, { position: 13, cpm: 25_281, impressionPercent: 60 }, { position: 19, cpm: 21_899, impressionPercent: 50 },
  { position: 27, cpm: 19_164, impressionPercent: 40 }, { position: 39, cpm: 15_892, impressionPercent: 30 }, { position: 51, cpm: 11_951, impressionPercent: 20 },
];
const KEY = policyKey('332097', '4160952', 'katta hammom sochiq');
const policy = (patch: Partial<AutoBidPolicy> = {}): AutoBidPolicy => ({ id: 'p1', key: KEY, adId: '1', campaignId: '332097', skuGroupId: '4160952', query: 'katta hammom sochiq', enabled: true, targetReach: 60, maxBid: 30_000, maxDrr: 10, pausedAt: null, ...patch });
const keyword = (patch: Partial<AutoBidKeyword> = {}): AutoBidKeyword => ({ campaignId: '332097', campaignName: 'Банное 100×150', adId: '1', skuGroupId: '4160952', query: 'katta hammom sochiq', cpm: 15_000, stopWords: [], ...patch });
const st = (patch: Partial<AdBotStats> = {}): AdBotStats => ({ impressions: 400, clicks: 10, sold: 1, revenue: 150_000, spend: 9_000, position: 20, ...patch });
const ctx = (patch: Partial<AutoBidContext> = {}): AutoBidContext => ({ ladder, stats7: st(), stats14: st(), lastChange: null, now, ...patch });

describe('лестница ставок', () => {
  it('парсит разные формы ответа кабинета и сортирует по охвату', () => {
    const steps = parseLadder({ payload: { ladder: [{ position: 13, cpm: 25281, impressionPercent: 60 }, { pos: 4, bid: '36844', coverage: 1 }] } });
    expect(steps).toEqual([{ position: 13, cpm: 25_281, impressionPercent: 60 }, { position: 4, cpm: 36_844, impressionPercent: 100 }]);
    expect(parseLadder(null)).toEqual([]);
    expect(parseLadder({ payload: [] })).toEqual([]);
  });
  it('цена охвата — минимальная ступень не ниже цели; недостижимый охват — верхняя ступень', () => {
    expect(bidForReach(ladder, 60)?.cpm).toBe(25_281);
    expect(bidForReach(ladder, 65)?.cpm).toBe(27_776);
    expect(bidForReach([ladder[8]], 90)?.cpm).toBe(11_951);
    expect(bidForReach([], 50)).toBeNull();
  });
  it('охват текущей ставки — самая высокая доступная ступень', () => {
    expect(reachForBid(ladder, 15_000)).toBe(20);
    expect(reachForBid(ladder, 25_281)).toBe(60);
    expect(reachForBid(ladder, 5_000)).toBe(0);
  });
});

describe('решение по слову', () => {
  it('поднимает к цене охвата, но не больше чем на 25% за запуск и с округлением вверх до 500', () => {
    const row = decideAutoBid(policy(), keyword(), ctx());
    expect(row.kind).toBe('RAISE');
    expect(row.newCpm).toBe(19_000); // 15 000 × 1,25 = 18 750 → 19 000, цель 25 281 — в следующие запуски
    expect(row.ladderCpm).toBe(25_281);
    expect(row.currentReach).toBe(20);
  });
  it('никогда не выше максимальной ставки владельца', () => {
    const row = decideAutoBid(policy({ maxBid: 20_000, targetReach: 100 }), keyword({ cpm: 18_000 }), ctx());
    expect(row.kind).toBe('RAISE');
    expect(row.newCpm).toBe(20_000);
  });
  it('ставка выше потолка — опускает к потолку', () => {
    const row = decideAutoBid(policy({ maxBid: 20_000 }), keyword({ cpm: 24_000 }), ctx());
    expect(row.kind).toBe('LOWER');
    expect(row.newCpm).toBe(20_000);
  });
  it('охват подешевел — снижает до цены охвата', () => {
    const row = decideAutoBid(policy({ targetReach: 30 }), keyword({ cpm: 19_000 }), ctx());
    expect(row.kind).toBe('LOWER');
    expect(row.newCpm).toBe(15_500); // 15 892 → вниз до 500
  });
  it('разница меньше 500 — ничего не отправляет', () => {
    const row = decideAutoBid(policy({ targetReach: 60 }), keyword({ cpm: 25_500 }), ctx());
    expect(row.kind).toBe('KEEP');
  });
  it('ДРР выше максимума при достаточных данных — потолок на запуск снижается на 15%', () => {
    const row = decideAutoBid(policy(), keyword({ cpm: 20_000 }), ctx({ stats14: st({ spend: 40_000, revenue: 200_000 }) })); // ДРР 20%
    expect(row.kind).toBe('LOWER');
    expect(row.newCpm).toBe(17_000);
    expect(row.reason).toContain('выше максимума 10%');
  });
  it('мало данных — ДРР не судим, работаем по охвату', () => {
    const row = decideAutoBid(policy(), keyword(), ctx({ stats14: st({ spend: 5_000, clicks: 3, revenue: 10_000 }) })); // ДРР 50%, но мало данных
    expect(row.kind).toBe('RAISE');
  });
  it('устойчиво критический ДРР за 7 и 14 дней — пауза и ставка на минимум', () => {
    const bad = st({ spend: 60_000, revenue: 200_000 }); // 30% > 10% × 2
    const row = decideAutoBid(policy(), keyword({ cpm: 20_000 }), ctx({ stats7: bad, stats14: bad }));
    expect(row.kind).toBe('PAUSE');
    expect(row.newCpm).toBe(9_500);
  });
  it('расход без единой продажи считается критическим ДРР', () => {
    const bad = st({ spend: 45_000, revenue: 0, sold: 0, clicks: 25 });
    expect(decideAutoBid(policy(), keyword(), ctx({ stats7: bad, stats14: bad })).kind).toBe('PAUSE');
  });
  it('критический ДРР только за 14 дней, но не за 7 — не пауза, а снижение потолка', () => {
    const row = decideAutoBid(policy(), keyword({ cpm: 20_000 }), ctx({ stats7: st({ spend: 2_000, revenue: 150_000 }), stats14: st({ spend: 60_000, revenue: 200_000 }) }));
    expect(row.kind).toBe('LOWER');
  });
  it('без ДРР-защиты ДРР не учитывается', () => {
    const bad = st({ spend: 60_000, revenue: 200_000 });
    expect(decideAutoBid(policy({ maxDrr: null }), keyword(), ctx({ stats7: bad, stats14: bad })).kind).toBe('RAISE');
  });
  it('без лестницы: мало показов — поднимает на 10%, иначе держит', () => {
    expect(decideAutoBid(policy(), keyword(), ctx({ ladder: null, stats7: st({ impressions: 20 }) })).newCpm).toBe(16_500);
    expect(decideAutoBid(policy(), keyword(), ctx({ ladder: [] })).kind).toBe('KEEP');
  });
  it('выключенная, приостановленная или недавно изменённая — без изменений', () => {
    expect(decideAutoBid(policy({ enabled: false }), keyword(), ctx()).kind).toBe('KEEP');
    expect(decideAutoBid(policy({ pausedAt: now }), keyword(), ctx()).kind).toBe('KEEP');
    expect(decideAutoBid(policy(), keyword(), ctx({ lastChange: new Date(now.getTime() - 30 * 60_000) })).kind).toBe('KEEP');
    expect(decideAutoBid(policy(), keyword(), ctx({ lastChange: new Date(now.getTime() - 3 * 3_600_000) })).kind).toBe('RAISE');
  });
});

describe('план и отчёт', () => {
  it('собирает действия в формате рекламного бота и отмечает пропавшие слова', () => {
    const plan = planAutoBidder([policy(), policy({ id: 'p2', key: policyKey('332097', '4160952', 'нет такого'), adId: '2', query: 'нет такого' })], new Map([[KEY, keyword()]]), () => ctx());
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ kind: 'RAISE', adId: '1', oldCpm: 15_000, newCpm: 19_000 });
    expect(plan.actions[0].reason).toContain('авто-ставка');
    expect(plan.notes[0]).toContain('нет такого');
  });
  it('отчёт: изменения с охватом, итог отправки, без изменений — короткая строка', () => {
    const plan = planAutoBidder([policy()], new Map([[KEY, keyword()]]), () => ctx());
    const [raw] = formatAutoBidderReport({ label: '06.10 12:00', apply: true, plan, outcomes: [{ action: plan.actions[0], ok: true, message: 'готово' }], notes: [] });
    const text = raw.replace(/ /g, ' ');
    expect(text).toContain('ставки меняются');
    expect(text).toContain('15 000 → 19 000 (охват 20% → цель 60%) ✅');
    const quiet = formatAutoBidderReport({ label: 'x', apply: false, plan: { rows: [], actions: [], notes: [] }, outcomes: [], notes: [] });
    expect(quiet[0]).toContain('Ставки на месте');
  });
  it('ключ слова не зависит от регистра, ё и знаков в запросе', () => {
    expect(policyKey('1', '2', ' Полотенце, для САУНЫ! ')).toBe('1|2|полотенце для сауны');
  });
  it('параметры по умолчанию соответствуют кабинету', () => {
    expect(AUTO_BIDDER_DEFAULTS.minBid).toBe(9_500);
    expect(AUTO_BIDDER_DEFAULTS.reachOptions).toContain(90);
  });
});
