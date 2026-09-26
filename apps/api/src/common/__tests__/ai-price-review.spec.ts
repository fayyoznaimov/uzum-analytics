import { describe, expect, it } from 'vitest';
import { applyAiPriceReview, buildAiPriceReviewPrompt, parseAiPriceReview } from '../ai-price-review';
import { AutoDecision, AutoPricingPlan } from '../auto-pricing';

const decision = (skuId: string, currentPrice: number, newPrice: number, patch: Partial<AutoDecision> = {}): AutoDecision => ({
  skuId, productId: 'P', title: `SKU-${skuId}`, role: 'MARGINAL', status: 'CHANGE', rule: 'FLOW', kind: 'BASE', saleId: null, saleTitle: null,
  currentPrice, newPrice, deltaPercent: ((newPrice - currentPrice) / currentPrice) * 100, reason: 'поток',
  metrics: { daysOfStock: 20, daysOfStockSource: 'оборачиваемость', units7: 7, units28: 10, marginPercent: 30, marginAfterPercent: null },
  ...patch,
});
const up = decision('1', 30_000, 30_600);
const down = decision('2', 30_000, 29_400, { rule: 'SLOW' });
const plan = (changes: AutoDecision[]): AutoPricingPlan => ({ changes, deferred: [], recommendations: [], holds: [], skips: [] });

describe('ИИ-проверка автоцен', () => {
  it('задание содержит кандидатов, ограничения и формат ответа', () => {
    const prompt = buildAiPriceReviewPrompt([up], new Map(), '2026-09-26');
    expect(prompt).toContain('"skuId": "1"');
    expect(prompt).toContain('"proposedPrice": 30600');
    expect(prompt).toContain('не можешь менять направление');
    expect(prompt).toContain('"verdict":"APPROVE|REJECT|ADJUST"');
  });

  it('разбирает ответ в ```json``` и проверяет каждый вердикт', () => {
    const text = 'Вот решение:\n```json\n[' +
      '{"skuId":"1","verdict":"ADJUST","price":30300,"comment":"поднять мягче"},' +
      '{"skuId":"2","verdict":"approve","comment":"продаж нет"},' +
      '{"skuId":"999","verdict":"APPROVE","comment":"чужой"}]\n```';
    expect(parseAiPriceReview(text, [up, down])).toEqual([
      { skuId: '1', verdict: 'ADJUST', price: 30_300, comment: 'поднять мягче' },
      { skuId: '2', verdict: 'APPROVE', price: 29_400, comment: 'продаж нет' },
    ]);
  });

  it('ИИ не может усилить или развернуть изменение; пропущенный SKU — не одобрен', () => {
    const text = '[{"skuId":"1","verdict":"ADJUST","price":31000,"comment":"больше"},{"skuId":"2","verdict":"ADJUST","price":30500,"comment":"вверх"}]';
    const review = parseAiPriceReview(text, [up, down, decision('3', 10_000, 10_300)]);
    expect(review.map((row) => row.verdict)).toEqual(['REJECT', 'REJECT', 'REJECT']);
    expect(review[0].comment).toContain('недопустимую цену 31000');
    expect(review[2].comment).toBe('ИИ не ответил по этому SKU — не меняем');
    expect(() => parseAiPriceReview('не знаю', [up])).toThrow('JSON');
  });

  it('применение: одобренные и смягчённые остаются, отклонённые уходят в «без изменений»', () => {
    const result = applyAiPriceReview(plan([up, down]), [
      { skuId: '1', verdict: 'ADJUST', price: 30_300, comment: 'мягче' },
      { skuId: '2', verdict: 'REJECT', price: null, comment: 'рано' },
    ]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ skuId: '1', newPrice: 30_300, deltaPercent: 1 });
    expect(result.changes[0].reason).toContain('ИИ смягчил');
    expect(result.holds[0]).toMatchObject({ skuId: '2', status: 'HOLD' });
    expect(result.holds[0].reason).toContain('ИИ отклонил: рано');
    expect(applyAiPriceReview(plan([up]), []).changes).toEqual([]);
  });
});
