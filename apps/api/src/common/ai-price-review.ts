/**
 * ИИ-проверка автоцен: правила (auto-pricing.ts) предлагают изменения, Claude через OpenClaw
 * одобряет, отклоняет или смягчает каждое. ИИ не может предложить новое изменение, развернуть
 * направление или сделать шаг больше, чем у правила: цена «ADJUST» должна лежать строго между
 * текущей и предложенной правилом (включая её). Всё, что ИИ не одобрил явно, не применяется.
 *
 * Модуль чистый: текст запроса, разбор ответа и применение вердиктов к плану. Вызов — в сервисе.
 */
import { AUTO_RULE_LABELS, AutoDecision, AutoPricingPlan, AutoPricingSkuInput, AutoRule } from './auto-pricing';

export type AiVerdict = 'APPROVE' | 'REJECT' | 'ADJUST';
export type AiReviewItem = { skuId: string; verdict: AiVerdict; price: number | null; comment: string };

const round1 = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

/** Текст задания для Claude: правила, ограничения, кандидаты и формат ответа. */
export function buildAiPriceReviewPrompt(candidates: AutoDecision[], inputs: Map<string, AutoPricingSkuInput>, today: string): string {
  const rows = candidates.map((row) => {
    const input = inputs.get(row.skuId);
    return {
      skuId: row.skuId,
      title: row.title,
      role: row.role === 'LOCOMOTIVE' ? 'локомотив (лицевое, держит трафик)' : 'маржинальный',
      rule: row.rule ? AUTO_RULE_LABELS[row.rule as AutoRule] : null,
      ruleReason: row.reason,
      where: row.kind === 'PROMO' ? `цена в акции «${row.saleTitle}»` : 'базовая цена',
      currentPrice: row.currentPrice,
      proposedPrice: row.newPrice,
      deltaPercent: row.deltaPercent,
      stock: input?.stock ?? null,
      daysOfStock: row.metrics.daysOfStock,
      buyouts7d: row.metrics.units7,
      buyouts28d: row.metrics.units28,
      marginPercentNow: round1(row.metrics.marginPercent),
      marginPercentAfter: round1(row.metrics.marginAfterPercent),
      unitCost: input?.unitCost ?? null,
      advertisingChangedThisWeek: input?.adChange.changed ? input.adChange.reason : false,
      recentPriceChanges: (input?.history ?? []).slice(0, 5).map((event) => ({
        date: event.at.toISOString().slice(0, 10), from: event.oldPrice, to: event.newPrice, rule: event.rule ?? 'вручную',
      })),
    };
  });
  return [
    'Ты — аналитик цен магазина полотенец Parisa Home на маркетплейсе Uzum (Узбекистан, цены в сумах).',
    `Сегодня ${today}. Правила автоцен предложили изменения ниже. Проверь каждое и реши: одобрить, отклонить или смягчить.`,
    '',
    'Как устроены правила:',
    '- локомотивы (лицевые полотенца) держат трафик: цену за спрос не поднимаем, только +3% при запасе < 3 дней и возврат после поставки;',
    '- маржинальные: запас < 7 дней → +3%; выкупы за неделю ≥ 1,2× среднего за 28 дней → +2%; после повышения выкупы упали на 35% → вернуть цену; ≤ 1 выкупа за 28 дней → −2%, если маржа не ниже минимума;',
    '- продажи считаются по выкупам (выдано покупателю, без возвратов); маржа — оценка: выплата Uzum − реклама − налог − себестоимость.',
    '',
    'Ограничения, которые нельзя нарушать:',
    '- ты не можешь предлагать изменения для других SKU и не можешь менять направление изменения;',
    '- ADJUST — только более мягкое изменение: цена строго между currentPrice и proposedPrice (proposedPrice тоже можно), целое число, лучше кратное 100;',
    '- сомневаешься или данных мало — REJECT: цена в этот раз не изменится, правило проверит её снова в следующий запуск.',
    '',
    'Кандидаты (JSON):',
    JSON.stringify(rows, null, 1),
    '',
    'Ответь ТОЛЬКО JSON-массивом, по одному элементу на каждого кандидата, без текста вокруг:',
    '[{"skuId":"…","verdict":"APPROVE|REJECT|ADJUST","price":число или null,"comment":"одно короткое предложение по-русски — почему"}]',
  ].join('\n');
}

/** Последний JSON-массив в тексте (ответ может прийти в ```json … ```). */
function extractJsonArray(text: string): unknown[] | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  for (let end = cleaned.lastIndexOf(']'); end !== -1; end = cleaned.lastIndexOf(']', end - 1)) {
    for (let start = cleaned.lastIndexOf('[', end); start !== -1; start = cleaned.lastIndexOf('[', start - 1)) {
      try {
        const value = JSON.parse(cleaned.slice(start, end + 1));
        if (Array.isArray(value)) return value;
      } catch {
        // не тот фрагмент — пробуем шире
      }
    }
  }
  return null;
}

/**
 * Разбор ответа ИИ с проверкой каждого вердикта. Незнакомый SKU игнорируется, пропущенный кандидат —
 * не одобрен, ADJUST вне допустимого диапазона превращается в REJECT.
 */
export function parseAiPriceReview(text: string, candidates: AutoDecision[]): AiReviewItem[] {
  const rows = extractJsonArray(text);
  if (!rows) throw new Error('ИИ ответил не JSON-массивом');
  const byId = new Map(candidates.map((row) => [row.skuId, row]));
  const answered = new Map<string, AiReviewItem>();
  for (const raw of rows as any[]) {
    const skuId = String(raw?.skuId ?? '').trim();
    const candidate = byId.get(skuId);
    if (!candidate || answered.has(skuId)) continue;
    const verdict = String(raw?.verdict ?? '').toUpperCase();
    const comment = String(raw?.comment ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'без комментария';
    if (verdict === 'APPROVE') {
      answered.set(skuId, { skuId, verdict: 'APPROVE', price: candidate.newPrice, comment });
    } else if (verdict === 'ADJUST') {
      const price = Number(raw?.price);
      const current = candidate.currentPrice as number;
      const proposed = candidate.newPrice as number;
      const inRange = Number.isInteger(price) && price !== current && price >= Math.min(current, proposed) && price <= Math.max(current, proposed);
      answered.set(skuId, inRange
        ? { skuId, verdict: 'ADJUST', price, comment }
        : { skuId, verdict: 'REJECT', price: null, comment: `ИИ предложил недопустимую цену ${raw?.price ?? '—'} — не меняем (${comment})` });
    } else {
      answered.set(skuId, { skuId, verdict: 'REJECT', price: null, comment });
    }
  }
  return candidates.map((row) => answered.get(row.skuId) ?? { skuId: row.skuId, verdict: 'REJECT', price: null, comment: 'ИИ не ответил по этому SKU — не меняем' });
}

/** План после ИИ: одобренные (и смягчённые) остаются изменениями, отклонённые уходят в «без изменений». */
export function applyAiPriceReview(plan: AutoPricingPlan, review: AiReviewItem[]): AutoPricingPlan {
  const byId = new Map(review.map((row) => [row.skuId, row]));
  const changes: AutoDecision[] = [];
  const rejected: AutoDecision[] = [];
  for (const row of plan.changes) {
    const item = byId.get(row.skuId);
    if (!item || item.verdict === 'REJECT' || item.price === null) {
      rejected.push({ ...row, status: 'HOLD', reason: `${row.reason}; ИИ отклонил: ${item?.comment ?? 'нет ответа'}` });
      continue;
    }
    const current = row.currentPrice as number;
    const deltaPercent = Math.round(((item.price - current) / current) * 10_000) / 100;
    const note = item.verdict === 'ADJUST' ? `ИИ смягчил до ${item.price.toLocaleString('ru-RU')}: ${item.comment}` : `ИИ: ${item.comment}`;
    changes.push({ ...row, newPrice: item.price, deltaPercent, reason: `${row.reason}; ${note}` });
  }
  return { ...plan, changes, holds: [...rejected, ...plan.holds] };
}
