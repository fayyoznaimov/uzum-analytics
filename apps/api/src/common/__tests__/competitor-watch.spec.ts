import { describe, expect, it } from 'vitest';
import { competitorAlerts, normalizeSnapshot, parseUzumProductUrl } from '../competitor-watch';

describe('разбор ссылок uzum.uz', () => {
  it('ID из полной ссылки, короткой и голого числа', () => {
    expect(parseUzumProductUrl('https://uzum.uz/ru/product/komplekt-postelnogo-belya-1456789?skuid=5')).toBe('1456789');
    expect(parseUzumProductUrl('https://uzum.uz/uz/product/1456789')).toBe('1456789');
    expect(parseUzumProductUrl(' 2197711 ')).toBe('2197711');
  });
  it('мусор не проходит', () => {
    expect(parseUzumProductUrl('https://uzum.uz/ru/category/tekstil')).toBeNull();
    expect(parseUzumProductUrl('abc')).toBeNull();
    expect(parseUzumProductUrl('')).toBeNull();
  });
});

describe('нормализация снапшота', () => {
  it('числа приводятся, мусорные поля — null, без цены строка отбрасывается', () => {
    expect(normalizeSnapshot({ productId: '123456', price: '159000', ordersAmount: '88', rating: 4.7, available: null })).toMatchObject({ productId: '123456', price: 159000, ordersAmount: 88, rating: 4.7, available: null });
    expect(normalizeSnapshot({ productId: '123456', price: 0 })).toBeNull();
    expect(normalizeSnapshot({ productId: 'x', price: 100000 })).toBeNull();
  });
});

describe('алерты по конкуренту', () => {
  const next = { price: 97_000, available: 10 };
  it('снижение ≥3% — демпинг-алерт, меньше порога — тишина', () => {
    const drop = competitorAlerts('Плед X', { price: 100_000, available: 10 }, next);
    expect(drop).toHaveLength(1);
    expect(drop[0].type).toBe('PRICE_DROP');
    expect(drop[0].text).toContain('100 000 → 97 000');
    expect(competitorAlerts('Плед X', { price: 99_000, available: 10 }, next)).toHaveLength(0);
  });
  it('первый замер — без алертов; рост цены и переходы наличия ловятся', () => {
    expect(competitorAlerts('X', null, next)).toHaveLength(0);
    expect(competitorAlerts('X', { price: 90_000, available: 10 }, next)[0].type).toBe('PRICE_RISE');
    expect(competitorAlerts('X', { price: 97_000, available: 5 }, { price: 97_000, available: 0 })[0].type).toBe('OUT_OF_STOCK');
    expect(competitorAlerts('X', { price: 97_000, available: 0 }, { price: 97_000, available: 7 })[0].type).toBe('BACK_IN_STOCK');
  });
});
