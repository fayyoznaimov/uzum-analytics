import { describe, expect, it } from 'vitest';
import { buildFboSupplySummary, normalizeSku, recognizeHavanaSku, recognizeSupplySku } from '../fbo-supply-summary';

describe('FBO Havana / J475 supply summary', () => {
  // Havana и J475 — один и тот же товар и одни и те же коды цвета (239–244),
  // но на Uzum это ДВЕ РАЗНЫЕ карточки с разными словами для одного цвета.
  // В SKU-тексте это не отличить по префиксу — обе пишутся HAVANA-…/
  // HAVANASAUNA-…. Отличает только слово цвета: Havana — СЕРЫЙ/ЗЕЛХАКИ/
  // СВЕТКОР/БЕЖЕВ/ПАСТКОР/БЕЛЫЙ, J475 — ХРОМ/ПРИГХАК/ШОКОЛ/МОЛОЧ/КРЕМОВ/ПРОЗР.
  it.each([
    ['FAYYOZ-HAVANASAUNA-ЗЕЛХАКИ', 'сауна', 240, 'Зелёный хаки'],
    ['FAYYOZ-HAVANA-ЗЕЛХАКИ-50 x 90', 'лицевой', 240, 'Зелёный хаки'],
    ['FAYYOZ-HAVANA-ЗЕЛХАКИ-70 x 140', 'банный', 240, 'Зелёный хаки'],
    ['FAYYOZ-HAVANA-ЗЕЛХАКИ-Havana', 'комплект', 240, 'Зелёный хаки'],
    ['FAYYOZ-HAVANA-СЕРЫЙ-Havana', 'комплект', 239, 'Серый'],
    ['FAYYOZ-HAVANA-СВЕТКОР-Havana', 'комплект', 241, 'Светло-коричневый'],
    ['FAYYOZ-HAVANA-БЕЖЕВ-Havana', 'комплект', 242, 'Бежевый'],
    ['FAYYOZ-HAVANA-ПАСТКОР-Havana', 'комплект', 243, 'Пастельно-коралловый'],
    ['FAYYOZ-HAVANA-БЕЛЫЙ-Havana', 'комплект', 244, 'Белый'],
  ])('recognizes Havana %s', (sku, type, colorCode, color) => {
    expect(recognizeHavanaSku(sku)).toEqual({ design: 'Havana', type, colorCode, color });
  });

  it.each([
    ['FAYYOZ-HAVANASAUNA-ПРИГХАК', 'сауна', 240, 'Зелёный хаки'],
    ['FAYYOZ-HAVANA-ПРИГХАК-50 x 90', 'лицевой', 240, 'Зелёный хаки'],
    ['FAYYOZ-HAVANA-ХРОМ-70 x 140', 'банный', 239, 'Серый'],
    ['FAYYOZ-HAVANA-ШОКОЛ-Havana', 'комплект', 241, 'Светло-коричневый'],
    ['FAYYOZ-HAVANA-МОЛОЧ-Havana', 'комплект', 242, 'Бежевый'],
    ['FAYYOZ-HAVANA-КРЕМОВ-Havana', 'комплект', 243, 'Пастельно-коралловый'],
    ['FAYYOZ-HAVANA-ПРОЗР-Havana', 'комплект', 244, 'Белый'],
  ])('recognizes J475 %s (same HAVANA prefix, different color word)', (sku, type, colorCode, color) => {
    expect(recognizeSupplySku(sku)).toEqual({ product: 'J475', design: 'J475', type, colorCode, color });
    // recognizeHavanaSku — строго Havana, для J475 обязан вернуть null.
    expect(recognizeHavanaSku(sku)).toBeNull();
  });

  it('does not merge Havana and J475 of the same color into one line', () => {
    // Реальная жалоба: поставка с обоими дизайнами одного цвета схлопывалась
    // в одну строку с общим числом — склад не понимал, сколько взять с какой
    // стойки отдельно.
    const result = buildFboSupplySummary('MIXED', [
      { sku: 'FAYYOZ-HAVANA-СЕРЫЙ-50 x 90', quantity: 5 },   // Havana, код 239
      { sku: 'FAYYOZ-HAVANA-ХРОМ-50 x 90', quantity: 10 },   // J475, тот же код 239
    ]);
    const havana = result.groups.find((g) => g.design === 'Havana' && g.type === 'лицевой');
    const j475 = result.groups.find((g) => g.design === 'J475' && g.type === 'лицевой');
    expect(havana?.items).toEqual([{ colorCode: 239, color: 'Серый', quantity: 5 }]);
    expect(j475?.items).toEqual([{ colorCode: 239, color: 'Серый', quantity: 10 }]);
    expect(result.parsedTotal).toBe(15);
    expect(result.groups).toHaveLength(2);
  });

  it('normalizes dimensions and dashes', () => {
    expect(normalizeSku('  fayyoz–havana–зелхаки–50 × 90 ')).toBe('FAYYOZ-HAVANA-ЗЕЛХАКИ-50X90');
  });

  it('a bare numeric color code with no word alias defaults to Havana', () => {
    // Голый код (03240, 240) без слова цвета не отличить от J475 — оставляем
    // Havana, так исторически размечены такие документы.
    expect(recognizeHavanaSku('FAYYOZ-HAVANA-03240-50X90')?.colorCode).toBe(240);
    expect(recognizeHavanaSku('FAYYOZ-HAVANA-240-50X90')?.colorCode).toBe(240);
  });

  it('aggregates one logical key exactly once and preserves totals', () => {
    const result = buildFboSupplySummary(3698534, [
      { sku: 'FAYYOZ-HAVANA-ЗЕЛХАКИ-50X90', quantity: 4 },
      { sku: 'FAYYOZ-HAVANA-ЗЕЛХАКИ-50 x 90', quantity: 6 },
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].items).toEqual([{ colorCode: 240, color: 'Зелёный хаки', quantity: 10 }]);
    expect(result.sourceTotal).toBe(10);
    expect(result.parsedTotal).toBe(10);
    expect(result.isValid).toBe(true);
  });

  it('does not guess unknown nomenclature', () => {
    const result = buildFboSupplySummary(3698534, [{ sku: 'UNKNOWN-SKU', quantity: 3 }]);
    expect(result.parsedTotal).toBe(0);
    expect(result.sourceTotal).toBe(3);
    expect(result.isValid).toBe(false);
    expect(result.unrecognizedItems).toEqual([{ sku: 'UNKNOWN-SKU', quantity: 3 }]);
    expect(result.formattedText).toContain('⚠️ Не распознано');
  });

  it.each([
    ['FAYYOZ-J403-РОЗОВ-Банный', 'J403', 'банный', 'Розовый'],
    ['FAYYOZ-J403-БЕЖЕВ-Микс', 'J403', 'комплект', 'Бежевый'],
    ['FAYYOZ-J471-НГОЛУБ-банны', 'J471', 'банный', 'Небесно-голубой'],
    ['FAYYOZ-J471-КРЕМОВ-лицево', 'J471', 'лицевой', 'Кремовый'],
    ['FAYYOZ-J471-МЯТН-сауна', 'J471', 'сауна', 'Мятный'],
    ['FAYYOZ-J471-СИРЕН-микс', 'J471', 'комплект', 'Сиреневый'],
  ])('recognizes %s', (sku, design, type, color) => {
    expect(recognizeSupplySku(sku)).toMatchObject({ design, type, color });
  });

  it('formats the real invoice number and all configured designs', () => {
    const result = buildFboSupplySummary('110003834444', [
      { sku: 'FAYYOZ-HAVANASAUNA-ЗЕЛХАКИ', quantity: 6 },
      { sku: 'FAYYOZ-J403-РОЗОВ-Банный', quantity: 6 },
      { sku: 'FAYYOZ-J471-НГОЛУБ-банны', quantity: 30 },
    ]);
    expect(result.sourceTotal).toBe(42);
    expect(result.parsedTotal).toBe(42);
    expect(result.isValid).toBe(true);
    expect(result.formattedText).toContain('**Поставка №110003834444**');
    expect(result.formattedText.startsWith('Havana sauna\n240 - 6 та\nобщий 6 та')).toBe(true);
    expect(result.formattedText.indexOf('**Общий: 42 та**')).toBeLessThan(result.formattedText.indexOf('**Поставка №110003834444**'));
    expect(result.formattedText).toContain('240 - 6 та');
    expect(result.formattedText).toContain('J403 банный');
    expect(result.formattedText).toContain('Небесно-голубой - 30 та');
  });

  it('reconciles the real acceptance act (3942699) — Havana and J475 split correctly, totals match', () => {
    // Настоящий документ директора: 33 строки, 214 шт. Текст SKU везде «HAVANA»
    // (даже для J475-строк) — J475 в нём видно только по слову цвета.
    const items: Array<[string, number]> = [
      ['FAYYOZ-J403-РОЗОВ-Микс', 5], ['FAYYOZ-J403-РОЗОВ-Банный', 5],
      ['FAYYOZ-J403-СЕРЫЙ-Сауна', 5], ['FAYYOZ-J403-СЕРЫЙ-Микс', 5],
      ['FAYYOZ-J403-БЕЛЫЙ-Сауна', 5], ['FAYYOZ-J403-БЕЛЫЙ-Микс', 5],
      ['FAYYOZ-J403-БЕЖЕВ-Банный', 5], ['FAYYOZ-J471-РОЗОВ-микс', 4],
      // J475 (ПРОЗР, ПРИГХАК, КРЕМОВ, ХРОМ, ШОКОЛ, МОЛОЧ) — 15 строк, 115 шт.
      ['FAYYOZ-HAVANA-ПРОЗР-Havana', 5], ['FAYYOZ-HAVANA-ПРИГХАК-50 x 90', 15],
      ['FAYYOZ-HAVANA-ПРИГХАК-Havana', 5], ['FAYYOZ-HAVANA-КРЕМОВ-Havana', 5],
      ['FAYYOZ-HAVANA-ХРОМ-70x140', 5], ['FAYYOZ-HAVANA-ШОКОЛ-Havana', 5],
      ['FAYYOZ-HAVANA-ПРОЗР-70x140', 5], ['FAYYOZ-HAVANA-ПРИГХАК-70x140', 5],
      ['FAYYOZ-HAVANA-КРЕМОВ-70x140', 5], ['FAYYOZ-HAVANA-ПРОЗР-50 x 90', 15],
      ['FAYYOZ-HAVANA-МОЛОЧ-Havana', 5], ['FAYYOZ-HAVANA-ШОКОЛ-50 x 90', 15],
      ['FAYYOZ-HAVANA-ХРОМ-50 x 90', 15], ['FAYYOZ-HAVANA-ХРОМ-Havana', 5],
      ['FAYYOZ-HAVANASAUNA-ШОКОЛ', 5],
      // Havana (СЕРЫЙ, БЕЛЫЙ, ЗЕЛХАКИ, СВЕТКОР, ПАСТКОР, БЕЖЕВ) — 10 строк, 60 шт.
      ['FAYYOZ-HAVANA-СЕРЫЙ-70x140', 5], ['FAYYOZ-HAVANA-БЕЛЫЙ-70x140', 5],
      ['FAYYOZ-HAVANA-ЗЕЛХАКИ-70x140', 5], ['FAYYOZ-HAVANA-ЗЕЛХАКИ-50 x 90', 15],
      ['FAYYOZ-HAVANA-СЕРЫЙ-Havana', 5], ['FAYYOZ-HAVANA-СВЕТКОР-Havana', 5],
      ['FAYYOZ-HAVANA-ПАСТКОР-Havana', 5], ['FAYYOZ-HAVANA-БЕЛЫЙ-Havana', 5],
      ['FAYYOZ-HAVANA-ЗЕЛХАКИ-Havana', 5], ['FAYYOZ-HAVANA-БЕЖЕВ-Havana', 5],
    ];
    const result = buildFboSupplySummary(3942699, items.map(([sku, quantity]) => ({ sku, quantity })));
    expect(result.sourceTotal).toBe(214);
    expect(result.parsedTotal).toBe(214);
    expect(result.isValid).toBe(true);
    expect(result.unrecognizedItems).toEqual([]);
    const j475Total = result.groups.filter((g) => g.design === 'J475').reduce((sum, g) => sum + g.total, 0);
    const havanaTotal = result.groups.filter((g) => g.design === 'Havana').reduce((sum, g) => sum + g.total, 0);
    expect(j475Total).toBe(115);
    expect(havanaTotal).toBe(60);
  });
});
