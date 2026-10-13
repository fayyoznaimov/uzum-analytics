import { describe, expect, it } from 'vitest';
import {
  classifyTransition,
  formatWatchMessage,
  pickStuckOrders,
  pickTransitions,
  warehouseEvents,
} from '../returns-watch';

const order = (over: Record<string, any> = {}) => ({
  id: 'o1',
  marketplaceOrderId: '108565279',
  state: 'WAITING',
  orderedAt: new Date('2026-05-25T10:00:00Z'),
  issuedAt: null,
  returnedUnits: 0,
  grossRevenue: 95750,
  payout: 74685,
  items: [{ sku: { sellerSku: 'FAYYOZ-HAVANA-ЗЕЛХАКИ-70 x140' } }],
  ...over,
});

describe('pickStuckOrders', () => {
  const now = new Date('2026-10-13T10:00:00Z');

  it('берёт только заказы, которые ждут выдачи дольше порога', () => {
    const rows = pickStuckOrders([
      order(),
      order({ id: 'o2', marketplaceOrderId: '129331245', orderedAt: new Date('2026-10-11T10:00:00Z') }),
    ], { cutoffDays: 14, now });
    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe('108565279');
    expect(rows[0].daysStuck).toBe(141);
    expect(rows[0].skus).toEqual(['FAYYOZ-HAVANA-ЗЕЛХАКИ-70 x140']);
  });

  it('не считает зависшими выданные и уже возвращённые', () => {
    expect(pickStuckOrders([order({ issuedAt: new Date('2026-06-01T10:00:00Z') })], { cutoffDays: 14, now })).toEqual([]);
    expect(pickStuckOrders([order({ returnedUnits: 1 })], { cutoffDays: 14, now })).toEqual([]);
    expect(pickStuckOrders([order({ state: 'PAID' })], { cutoffDays: 14, now })).toEqual([]);
  });

  it('сортирует от самого старого', () => {
    const rows = pickStuckOrders([
      order({ id: 'o2', marketplaceOrderId: '127306487', orderedAt: new Date('2026-09-08T10:00:00Z') }),
      order(),
    ], { cutoffDays: 14, now });
    expect(rows.map((row) => row.number)).toEqual(['108565279', '127306487']);
  });
});

describe('pickTransitions', () => {
  const now = new Date('2026-10-13T10:00:00Z');

  it('ловит только переходы из ожидания и помнит, сколько заказ висел', () => {
    const events = pickTransitions([
      { id: 'h1', fromStatus: 'WAITING', toStatus: 'CANCELED', changedAt: new Date('2026-10-13T09:00:00Z'), order: order({ marketplaceOrderId: '115753914', orderedAt: new Date('2026-07-08T10:00:00Z') }) },
      { id: 'h2', fromStatus: 'CREATED', toStatus: 'PAID', changedAt: new Date('2026-10-13T09:00:00Z'), order: order({ marketplaceOrderId: '133725513' }) },
    ], { cutoffDays: 14, now });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('RETURNED');
    expect(events[0].number).toBe('115753914');
    expect(events[0].daysStuck).toBe(96);
  });

  it('различает возврат, выдачу и прочие статусы', () => {
    expect(classifyTransition('CANCELED')).toBe('RETURNED');
    expect(classifyTransition('RETURNED')).toBe('RETURNED');
    expect(classifyTransition('PAID')).toBe('ISSUED');
    expect(classifyTransition('OTHER')).toBe('MOVED');
  });
});

describe('warehouseEvents', () => {
  const before = new Map([
    ['s1', { skuId: 's1', sellerSku: 'HAVANA-СЕРЫЙ-50 x 90', available: 11, returnedTotal: 110, defectedTotal: 0 }],
    ['s2', { skuId: 's2', sellerSku: 'HAVANA-ЗЕЛХАКИ-70 x140', available: 0, returnedTotal: 20, defectedTotal: 0 }],
    ['s3', { skuId: 's3', sellerSku: 'J471-РОЗОВ-микс', available: 2, returnedTotal: 5, defectedTotal: 0 }],
  ]);

  it('видит возврат, который доехал до склада', () => {
    const events = warehouseEvents(before, [
      { skuId: 's1', sellerSku: 'HAVANA-СЕРЫЙ-50 x 90', available: 12, returnedTotal: 111, defectedTotal: 0 },
    ]);
    expect(events).toEqual([{ kind: 'BACK_IN_STOCK', skuId: 's1', sellerSku: 'HAVANA-СЕРЫЙ-50 x 90', units: 1, available: 12, capturedKey: '' }]);
  });

  it('отличает оформленный возврат от принятого на склад', () => {
    const events = warehouseEvents(before, [
      { skuId: 's2', sellerSku: 'HAVANA-ЗЕЛХАКИ-70 x140', available: 0, returnedTotal: 21, defectedTotal: 0 },
    ]);
    expect(events[0].kind).toBe('RETURN_REGISTERED');
    expect(events[0].units).toBe(1);
  });

  it('отдельно показывает брак', () => {
    const events = warehouseEvents(before, [
      { skuId: 's3', sellerSku: 'J471-РОЗОВ-микс', available: 2, returnedTotal: 6, defectedTotal: 1 },
    ]);
    expect(events.map((event) => event.kind)).toEqual(['BACK_AS_DEFECT', 'RETURN_REGISTERED']);
  });

  it('молчит без изменений и без прошлого снимка', () => {
    expect(warehouseEvents(before, [{ skuId: 's1', sellerSku: 'a', available: 11, returnedTotal: 110, defectedTotal: 0 }])).toEqual([]);
    expect(warehouseEvents(before, [{ skuId: 'new', sellerSku: 'b', available: 5, returnedTotal: 1, defectedTotal: 0 }])).toEqual([]);
  });

  it('не считает возвратом уменьшение остатка от продаж', () => {
    expect(warehouseEvents(before, [
      { skuId: 's1', sellerSku: 'HAVANA-СЕРЫЙ-50 x 90', available: 9, returnedTotal: 110, defectedTotal: 0 },
    ])).toEqual([]);
  });
});

describe('formatWatchMessage', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  const stuck = pickStuckOrders([order()], { cutoffDays: 14, now });

  it('без событий не пишет ничего', () => {
    expect(formatWatchMessage({ transitions: [], warehouse: [], stillStuck: stuck })).toBe('');
  });

  it('собирает письмо по разделам и добавляет остаток зависших', () => {
    const transitions = pickTransitions([
      { id: 'h1', fromStatus: 'WAITING', toStatus: 'CANCELED', changedAt: new Date('2026-10-13T09:00:00Z'), order: order({ marketplaceOrderId: '115753914', orderedAt: new Date('2026-07-08T10:00:00Z'), grossRevenue: 69900 }) },
    ], { cutoffDays: 14, now });
    const text = formatWatchMessage({
      transitions,
      warehouse: [{ kind: 'BACK_IN_STOCK', skuId: 's1', sellerSku: 'HAVANA-СЕРЫЙ-50 x 90', units: 1, available: 12, capturedKey: '' }],
      stillStuck: stuck,
    });
    const plain = text.replace(/\u00a0/g, ' ');
    expect(text).toContain('Закрыты возвратом');
    expect(text).toContain('№115753914');
    expect(plain).toContain('69 900 сум не придут');
    expect(text).toContain('снова в продаже');
    expect(text).toContain('+1 шт., доступно 12');
    expect(plain).toContain('Ещё висят: 1 заказов на 95 750 сум');
    expect(text).toContain('141 дн.');
  });

  it('сообщает, когда зависших не осталось', () => {
    const text = formatWatchMessage({
      transitions: pickTransitions([
        { id: 'h1', fromStatus: 'WAITING', toStatus: 'PAID', changedAt: new Date('2026-10-13T09:00:00Z'), order: order() },
      ], { cutoffDays: 14, now }),
      warehouse: [],
      stillStuck: [],
    });
    expect(text).toContain('Наконец выданы');
    expect(text).toContain('Зависших заказов больше нет.');
  });
});
