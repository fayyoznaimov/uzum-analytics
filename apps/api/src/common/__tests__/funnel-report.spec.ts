import { describe, expect, it } from 'vitest';
import {
  buildFunnelReport,
  funnelRates,
  funnelSkuQuery,
  funnelWindow,
  parseFunnelRows,
  renderFunnelHtml,
  renderFunnelText,
  skuColor,
  type FunnelDayRow,
  type SkuInfo,
} from '../funnel-report';

const F = 'SellerReportProductFunnelSku.';
const cubeRow = (productId: string, skuId: string, day: string, imps: number, views: number, atc: number, ordered: number, sold: number | null) => ({
  [F + 'product_id']: productId,
  [F + 'sku_id']: skuId,
  [F + 'date.day']: `${day}T00:00:00.000`,
  [F + 'date']: `${day}T00:00:00.000`,
  [F + 'sum_imps']: String(imps),
  [F + 'sum_views']: String(views),
  [F + 'sum_atc']: String(atc),
  [F + 'generated_amount']: String(ordered),
  [F + 'completed_amount']: sold === null ? null : String(sold),
});
const row = (productId: string, skuId: string, day: string, impressions: number, views: number, atc: number, ordered: number, sold = 0): FunnelDayRow => ({ productId, skuId, day, impressions, views, atc, ordered, sold });

describe('окно и запрос воронки', () => {
  it('28 дней по вчерашний день по Ташкенту', () => {
    expect(funnelWindow('2026-10-14', 28)).toEqual({ from: '2026-09-16', to: '2026-10-13', days: 28 });
  });
  it('период округляется до целых недель и ограничен 1–8 неделями', () => {
    expect(funnelWindow('2026-10-14', 10).days).toBe(7);
    expect(funnelWindow('2026-10-14', 3).days).toBe(7);
    expect(funnelWindow('2026-10-14', 100).days).toBe(56);
    expect(funnelWindow('2026-10-14', Number.NaN).days).toBe(28);
    // пустое поле «Период» в Actions → 0 → по умолчанию 28, а не неделя
    expect(funnelWindow('2026-10-14', 0).days).toBe(28);
  });
  it('запрос по товару и SKU по дням, с выкупом', () => {
    const query = funnelSkuQuery('2026-09-16', '2026-10-13');
    expect(query.dimensions).toEqual([F + 'product_id', F + 'sku_id']);
    expect(query.measures).toContain(F + 'completed_amount');
    expect(query.timeDimensions[0]).toMatchObject({ dateRange: ['2026-09-16', '2026-10-13'], granularity: 'day' });
  });
});

describe('разбор ответа Cube', () => {
  it('строки из results[0].data, строки-числа и null', () => {
    const rows = parseFunnelRows({ results: [{ data: [cubeRow('2197711', '11627806', '2026-10-01', 1000, 50, 10, 3, null)] }] });
    expect(rows).toEqual([{ productId: '2197711', skuId: '11627806', day: '2026-10-01', impressions: 1000, views: 50, atc: 10, ordered: 3, sold: 0 }]);
  });
  it('ошибка Cube и незнакомая форма — исключение, а не нули', () => {
    expect(() => parseFunnelRows({ error: 'Continue wait' })).toThrow(/Cube/);
    expect(() => parseFunnelRows({ foo: 1 })).toThrow(/неожиданная форма/);
  });
  it('строки без товара или даты пропускаются', () => {
    expect(parseFunnelRows({ data: [{ [F + 'product_id']: '', [F + 'date.day']: '2026-10-01' }, { [F + 'product_id']: '1', [F + 'date.day']: '' }] })).toEqual([]);
  });
});

describe('сборка отчёта', () => {
  const skus: SkuInfo[] = [
    { skuId: 's1', productId: 'A', productTitle: 'HAVANA', color: 'Белый', size: '50×90', stock: 10 },
    { skuId: 's2', productId: 'A', productTitle: 'HAVANA', color: 'Белый', size: '70×140', stock: 5 },
    { skuId: 's3', productId: 'A', productTitle: 'HAVANA', color: 'Серый', size: '50×90', stock: 0 },
    { skuId: 't1', productId: 'B', productTitle: 'J471 <лёгкое>', color: 'Розовый', size: null, stock: 7 },
  ];
  const rows: FunnelDayRow[] = [
    // A: хороший CTR и корзина
    row('A', 's1', '2026-09-16', 10_000, 600, 180, 40, 30),
    row('A', 's2', '2026-10-13', 10_000, 600, 180, 40, 35),
    row('A', 's3', '2026-10-10', 2_000, 100, 30, 5, 5),
    // B: CTR в два раза ниже магазина
    row('B', 't1', '2026-10-12', 20_000, 400, 120, 30, 20),
    // вне окна — не считается
    row('A', 's1', '2026-09-15', 99_999, 9_999, 999, 99, 99),
  ];
  const report = buildFunnelReport({ rows, skus, today: '2026-10-14', from: '2026-09-16', to: '2026-10-13' });

  it('магазин: сумма по окну, вне окна не попадает', () => {
    expect(report.shop.counts).toEqual({ impressions: 42_000, views: 1_700, atc: 510, ordered: 115, sold: 90 });
    expect(report.daily).toHaveLength(28);
  });
  it('4 недели от старой к новой, строки ложатся в свою неделю', () => {
    expect(report.weeks.map((week) => week.label)).toEqual(['16.09–22.09', '23.09–29.09', '30.09–06.10', '07.10–13.10']);
    expect(report.shop.weeks[0].ordered).toBe(40);
    expect(report.shop.weeks[3].ordered).toBe(75);
  });
  it('товары по убыванию показов, цвета сгруппированы, остатки по цвету', () => {
    expect(report.products.map((product) => product.productId)).toEqual(['A', 'B']);
    const a = report.products[0];
    expect(a.label).toBe('HAVANA');
    expect(a.stock).toBe(15);
    expect(a.colors.map((color) => [color.label, color.counts.ordered, color.stock])).toEqual([
      ['Белый', 80, 15],
      ['Серый', 5, 0],
    ]);
    expect(a.skus[0].label).toBe('Белый · 50×90');
  });
  it('слабый шаг: CTR у товара B ниже магазина больше чем на 15 %', () => {
    const b = report.products[1];
    expect(funnelRates(b.counts).ctr).toBeCloseTo(2, 5);
    expect(b.weakStep?.step).toBe('ctr');
    expect(report.products[0].weakStep).toBeNull();
  });
  it('мало данных — шаг не судим', () => {
    const tiny = buildFunnelReport({ rows: [row('A', 's1', '2026-10-01', 100, 1, 0, 0), row('B', 't1', '2026-10-01', 50_000, 5_000, 1_000, 300)], skus, today: '2026-10-14', from: '2026-09-16', to: '2026-10-13' });
    expect(tiny.products.find((product) => product.productId === 'A')?.weakStep).toBeNull();
  });
  it('неизвестный SKU попадает в товар, а не теряется', () => {
    const r = buildFunnelReport({ rows: [row('C', 'x9', '2026-10-01', 500, 20, 5, 1)], skus, today: '2026-10-14', from: '2026-09-16', to: '2026-10-13' });
    expect(r.products[0].label).toBe('Товар C');
    expect(r.products[0].colors[0].label).toBe('цвет не указан');
    expect(r.products[0].skus[0].label).toBe('SKU x9');
  });
  it('предупреждение при упоре в лимит строк — первым в тексте и в HTML', () => {
    const r = buildFunnelReport({ rows, skus, today: '2026-10-14', from: '2026-09-16', to: '2026-10-13', truncated: true });
    expect(r.warnings[0]).toMatch(/предел/);
    expect(renderFunnelText(r)[0]).toMatch(/^ВНИМАНИЕ: .*предел/);
    const html = renderFunnelHtml(r);
    expect(html.indexOf('предел')).toBeLessThan(html.indexOf('Весь магазин'));
    expect(report.warnings).toEqual([]);
  });
  it('название SKU из кабинета — подпись строки SKU', () => {
    const r = buildFunnelReport({ rows: [row('A', 's1', '2026-10-01', 500, 20, 5, 1)], skus: [{ ...skus[0], title: 'FAYYOZ-HAVANA-БЕЛЫЙ-50X90' }], today: '2026-10-14', from: '2026-09-16', to: '2026-10-13' });
    expect(r.products[0].skus[0].label).toBe('HAVANA-БЕЛЫЙ-50X90');
  });
  it('текст и HTML: заголовки на русском, названия экранированы', () => {
    const text = renderFunnelText(report).join('\n');
    expect(text).toContain('Воронка продаж 2026-09-16 … 2026-10-13');
    expect(text).toContain('слабый шаг: Показ → открытие (CTR)');
    const html = renderFunnelHtml(report);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('J471 &lt;лёгкое&gt;');
    expect(html).not.toContain('J471 <лёгкое>');
    expect(html).toContain('Слабый шаг: Показ → открытие (CTR)');
    expect(html).toContain('ориентир Ивана 5%');
    expect(html).not.toContain('17.5%');
  });
  it('график без заказов не пишет «максимум 1»', () => {
    const empty = buildFunnelReport({ rows: [row('A', 's1', '2026-10-01', 500, 20, 5, 0)], skus, today: '2026-10-14', from: '2026-09-16', to: '2026-10-13' });
    const html = renderFunnelHtml(empty);
    expect(html).toContain('заказов за период нет');
    expect(html).not.toContain('максимум 1 шт');
  });
  it('пустой отчёт не падает', () => {
    const none = buildFunnelReport({ rows: [], skus: [], today: '2026-10-14', from: '2026-09-16', to: '2026-10-13' });
    expect(none.products).toEqual([]);
    expect(funnelRates(none.shop.counts).ctr).toBeNull();
    expect(() => renderFunnelHtml(none)).not.toThrow();
    expect(renderFunnelText(none).length).toBeGreaterThan(0);
  });
  it('без достаточных данных доля не красится', () => {
    // товар с 300 показами и CTR вдвое ниже магазина: подсказка «мало данных», без красного
    const r = buildFunnelReport({ rows: [...rows, row('D', 'd1', '2026-10-01', 300, 6, 1, 0)], skus, today: '2026-10-14', from: '2026-09-16', to: '2026-10-13' });
    const html = renderFunnelHtml(r);
    const productRow = html.split('<tr>').find((cell) => cell.includes('#pD'));
    expect(productRow).toBeDefined();
    expect(productRow).toContain('мало данных');
    expect(productRow).not.toContain('class="num bad"');
  });
});

describe('цвет SKU', () => {
  it('поле цвета важнее всего', () => {
    expect(skuColor({ color: 'Белый', titles: ['HAVANA-ХРОМ-50X90'] })).toBe('Белый');
  });
  it('характеристика «Цвет» / «Rang» из кабинета, hex-коды пропускаются', () => {
    expect(skuColor({ characteristics: [{ title: 'Rang', value: 'Oq' }] })).toBe('Oq');
    expect(skuColor({ characteristics: [{ title: 'Цвет', value: '#ffffff' }], titles: ['J403-БЕЛЫЙ-70X140'] })).toBe('Белый');
  });
  it('слово цвета из названия SKU: префикс продавца, модель, размер и тип отбрасываются', () => {
    expect(skuColor({ titles: ['FAYYOZ-HAVANA-ХРОМ-50X90'] })).toBe('Хром');
    expect(skuColor({ titles: ['FAYYOZ-HAVANASAUNA-БЕЛЫЙ'] })).toBe('Белый');
    expect(skuColor({ titles: ['HAVANA-ЗЕЛХАКИ-70 x140'] })).toBe('Зелёный хаки');
    expect(skuColor({ titles: ['J471-СИРЕН-50X85/70X135'] })).toBe('Сиреневый');
    expect(skuColor({ titles: ['HAVANA-ПРИГХАК-КОМПЛЕКТ'] })).toBe('Приглушённый хаки');
    // реальные названия из базы: модель внутри цвета и «небесно-голубой» сокращением
    expect(skuColor({ titles: ['J475-ХРОМ HAVANA-50X90'] })).toBe('Хром');
    expect(skuColor({ titles: ['J471-НГОЛУБ-50X85'] })).toBe('Небесно-голубой');
  });
  it('нет цвета — null, а не мусор', () => {
    expect(skuColor({ titles: ['HAVANA-50X90'] })).toBeNull();
    expect(skuColor({ titles: [null, ''] })).toBeNull();
    expect(skuColor({})).toBeNull();
  });
});
