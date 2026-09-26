import { describe, expect, it } from 'vitest';
import {
  adAdvice,
  AdCampaign,
  AdProduct,
  adWindows,
  campaignFunnelQuery,
  cubeUrl,
  formatAdReport,
  Funnel,
  FUNNEL_MEMBERS,
  isCubeContinueWait,
  parseCubeDaily,
  productFunnelQuery,
  windowSum,
} from '../ad-agent';

const today = '2026-09-26';
const f = (impressions: number, views: number, atc: number, ordered: number, sold: number): Funnel => ({ impressions, views, atc, ordered, sold });

// Воронка за 28 дней снята из кабинета 26.09.2026.
function product(id: string, title: string, funnel28: Funnel, patch: Partial<AdProduct> = {}): AdProduct {
  return {
    productId: id, title, stockUnits: 100, avgDailySales: 1, funnel28,
    funnel7: f(funnel28.impressions / 4, funnel28.views / 4, 0, 0, 0), funnelPrev7: f(funnel28.impressions / 4, funnel28.views / 4, 0, 0, 0),
    cpo: { status: 'ACTIVE', commission: 3, minCommission: 3, maxCommission: 60, week: { impressions: 1000, clicks: 50, ordered: 5, spend: 15_000, revenue: 500_000 } },
    ...patch,
  };
}
const shop = () => [
  product('2197711', 'Полотенце пышное 600 г/м²', f(256_362, 31_827, 1_323, 477, 327)),
  product('2898275', 'Набор полотенец махровых', f(107_640, 9_862, 396, 133, 106)),
  product('2872482', 'Полотенце банное 100% хлопок', f(54_235, 5_579, 251, 97, 80)),
  product('2263224', 'Банное полотенце большое 100×150 (сауна)', f(24_523, 1_761, 86, 30, 25), { stockUnits: 41, avgDailySales: 0.7 }),
  product('2880108', 'Хлопковый плед', f(10_848, 669, 37, 9, 6)),
];
const campaign = (patch: Partial<AdCampaign>): AdCampaign => ({
  id: '1', name: 'Кампания', status: 'ACTIVE', startedOn: '2026-09-01', weeklyBudget: 150_000,
  week: { impressions: 3_000, clicks: 150, sold: 10, spend: 60_000, revenue: 1_200_000 },
  month: { impressions: 10_000, clicks: 500, sold: 40, spend: 200_000, revenue: 4_000_000 },
  ...patch,
});

describe('Cube', () => {
  it('запросы в формате кабинета и URL с queryType=multi', () => {
    const query = productFunnelQuery('2026-08-29', '2026-09-25') as any;
    expect(query.measures).toContain('SellerReportProductFunnelSku.sum_imps');
    expect(query.timeDimensions[0]).toEqual({ dimension: 'SellerReportProductFunnelSku.date', dateRange: ['2026-08-29', '2026-09-25'], granularity: 'day' });
    expect((campaignFunnelQuery(['332097'], 'a', 'b') as any).filters[0]).toEqual({ member: 'AdvertisingDailyFunnel.ad_campaign_id', operator: 'equals', values: ['332097'] });
    expect(cubeUrl({ a: 1 })).toBe('https://analytics-seller.uzum.uz/cubejs-api/v1/load?query=%7B%22a%22%3A1%7D&queryType=multi');
  });

  it('разбирает ответ по дням, пропуская null; «Continue wait» и ошибки распознаёт', () => {
    const body = { results: [{ data: [
      { 'SellerReportProductFunnelSku.product_id': '2263224', 'SellerReportProductFunnelSku.date.day': '2026-09-19T00:00:00.000', 'SellerReportProductFunnelSku.date': '2026-09-19T00:00:00.000', 'SellerReportProductFunnelSku.sum_imps': '385', 'SellerReportProductFunnelSku.completed_amount': null },
      { 'SellerReportProductFunnelSku.product_id': '2263224', 'SellerReportProductFunnelSku.date.day': '2026-09-20T00:00:00.000', 'SellerReportProductFunnelSku.date': '2026-09-20T00:00:00.000', 'SellerReportProductFunnelSku.sum_imps': '459', 'SellerReportProductFunnelSku.completed_amount': '1' },
    ] }] };
    const daily = parseCubeDaily(body, FUNNEL_MEMBERS.id, FUNNEL_MEMBERS.day);
    expect(daily.get('2263224')).toEqual({ '2026-09-19': { sum_imps: 385 }, '2026-09-20': { sum_imps: 459, completed_amount: 1 } });
    expect(windowSum(daily, '2263224', 'sum_imps', '2026-09-19', '2026-09-25')).toBe(844);
    expect(windowSum(daily, 'нет', 'sum_imps', '2026-09-19', '2026-09-25')).toBe(0);
    expect(isCubeContinueWait({ error: 'Continue wait' })).toBe(true);
    expect(() => parseCubeDaily({ error: 'Invalid token' }, 'a', 'b')).toThrow('Invalid token');
    expect(() => parseCubeDaily({ payload: [] }, 'a', 'b')).toThrow('неожиданная форма');
  });

  it('окна: полные дни до вчера', () => {
    expect(adWindows(today)).toEqual({ from28: '2026-08-29', from7: '2026-09-19', fromPrev7: '2026-09-12', toPrev7: '2026-09-18', to: '2026-09-25' });
  });
});

describe('советы', () => {
  it('сауна и плед: карточку открывают реже, чем по магазину; сауне поднять ставку «Буст заказов»', () => {
    const advice = adAdvice(shop(), [], today);
    const sauna = advice.filter((row) => row.target.includes('сауна'));
    expect(sauna.map((row) => row.action)).toContain('поднять ставку «Буст заказов» с 3% до 5%');
    expect(advice.some((row) => row.target === 'Хлопковый плед' && row.action.startsWith('улучшить карточку'))).toBe(true);
    expect(advice.some((row) => row.target === 'Полотенце пышное 600 г/м²')).toBe(false);
  });

  it('ставка не выше порога ДРР и максимума Uzum; мало запаса — трафик не разгонять', () => {
    const items = shop();
    items[3].cpo!.commission = 9;
    expect(adAdvice(items, [], today).find((row) => row.target.includes('сауна') && row.action.startsWith('поднять'))?.action).toBe('поднять ставку «Буст заказов» с 9% до 10%');
    items[3].cpo!.commission = 10;
    expect(adAdvice(items, [], today).some((row) => row.target.includes('сауна') && row.action.startsWith('поднять'))).toBe(false);
    items[3].stockUnits = 3;
    expect(adAdvice(items, [], today).find((row) => row.target.includes('сауна') && row.priority === 4)?.action).toBe('трафик не разгонять до поставки');
  });

  it('«Буст заказов» выключен у неидущего товара — включить; ДРР выше порога — снизить', () => {
    const items = shop();
    items[3].cpo = null;
    expect(adAdvice(items, [], today).some((row) => row.target.includes('сауна') && row.action.startsWith('включить «Буст заказов»'))).toBe(true);
    items[0].cpo!.week = { impressions: 1000, clicks: 10, ordered: 1, spend: 60_000, revenue: 400_000 };
    expect(adAdvice(items, [], today)[0]).toMatchObject({ priority: 1, target: 'Полотенце пышное 600 г/м²' });
  });

  it('кампании ТОП: ДРР выше порога, нет показов, бюджет выбран при низком ДРР, пауза с хорошим ДРР', () => {
    const advice = adAdvice([], [
      campaign({ id: '299724', name: 'Сауна', week: { impressions: 1_500, clicks: 50, sold: 3, spend: 80_000, revenue: 540_000 } }),
      campaign({ id: '332097', name: 'Банное 100×150', startedOn: '2026-09-23', week: { impressions: 0, clicks: 0, sold: 0, spend: 0, revenue: 0 } }),
      campaign({ id: '286528', name: 'Микс', week: { impressions: 3_000, clicks: 150, sold: 30, spend: 140_000, revenue: 3_000_000 } }),
      campaign({ id: '305326', name: 'YD', status: 'PAUSED', month: { impressions: 1_000, clicks: 50, sold: 5, spend: 20_000, revenue: 500_000 } }),
      campaign({ id: '1', name: 'Новая', startedOn: '2026-09-26', week: { impressions: 0, clicks: 0, sold: 0, spend: 0, revenue: 0 } }),
    ], today);
    expect(advice.map((row) => [row.target, row.action])).toEqual([
      ['ТОП «Сауна»', 'снизить ставку или поставить на паузу'],
      ['ТОП «Банное 100×150»', 'поднять ставку (CPM)'],
      ['ТОП «Микс»', `увеличить недельный бюджет на 30% (до ${(195_000).toLocaleString('ru-RU')} сум)`],
      ['ТОП «YD»', 'можно снова включить'],
    ]);
  });

  it('отчёт: режим советов, ДРР, ИИ-план или пометка, воронка товаров', () => {
    const products = shop();
    const [text] = formatAdReport({ label: '26.09 10:00', advice: adAdvice(products, [], today), aiPlan: '1. Поднять ставку сауны до 5%.', aiNote: null, products, campaigns: [], maxDrrPercent: 10 });
    expect(text).toContain('только советы');
    expect(text).toContain('ДРР 3%');
    expect(text).toContain('🧠 План на сегодня:\n1. Поднять ставку сауны до 5%.');
    expect(text).toMatch(/Банное полотенце большое 100×150 \(сауна\): 24\s523 → 1\s761 \(7,2%\)/);
    const [noAi] = formatAdReport({ label: 'x', advice: [], aiPlan: null, aiNote: 'ИИ-план не получен', products: [], campaigns: [], maxDrrPercent: 10 });
    expect(noAi).toContain('🧠 ИИ-план не получен');
    expect(noAi).toContain('менять ничего не нужно');
  });
});
