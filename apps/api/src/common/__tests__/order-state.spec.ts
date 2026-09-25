import { describe, expect, it } from 'vitest';
import { classifyOrderState, classifyStoredOrder, resolveOrderReportDate } from '../order-state';

describe('order state mapping', () => {
  it('treats PROCESSING with dateIssued from Uzum as paid', () => {
    expect(classifyOrderState({ status: 'PROCESSING', dateIssued: '2026-07-13T10:00:00Z' })).toBe('PAID');
  });
  it('treats PROCESSING without issue date as waiting', () => {
    expect(classifyOrderState({ status: 'PROCESSING' })).toBe('WAITING');
  });
  it('does not use stored compatibility dateIssued as proof of payment', () => {
    expect(classifyStoredOrder({ status: 'PROCESSING', state: 'WAITING', paidAt: null })).toBe('WAITING');
  });
  it('recognizes canonical saved state', () => {
    expect(classifyStoredOrder({ status: 'PROCESSING', state: 'PAID', paidAt: null })).toBe('PAID');
  });

  it('preserves the old report date when Uzum temporarily omits dates', () => {
    const existing = new Date('2026-07-01T10:00:00Z');
    expect(resolveOrderReportDate(null, null, existing, new Date('2026-07-13T10:00:00Z'))).toEqual(existing);
  });
  it('prioritizes cancellation and returns', () => {
    expect(classifyOrderState({ status: 'CANCELED', dateIssued: new Date() })).toBe('CANCELED');
    expect(classifyOrderState({ status: 'PROCESSING', amount: 2, amountReturns: 2 })).toBe('RETURNED');
  });
});
