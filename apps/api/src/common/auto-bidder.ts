/**
 * Автобиддер «Буст в ТОП»: держит ставку ключевого слова на желаемом охвате показов и не даёт ей выйти
 * за потолок владельца и за максимальный ДРР. Модуль чистый — без сети и БД.
 *
 * Идея (как у «авто-ставки» SellerX): ставка в Uzum покупает не позицию, а охват показов — кабинет ранжирует
 * по эффективному CPM с учётом продаж, конверсии и рейтинга товара. Поэтому для слова задаются три вещи:
 *  - желаемый охват (10…100 %) — по «лестнице» кабинета (позиция → CPM → % показов) выбирается минимальная
 *    ставка, которая его покупает; если конкурент перебил — поднимаем, если охват подешевел — снижаем;
 *  - максимальная ставка — выше неё автобид не поднимает ни при каких условиях (минимум Uzum — 9 500);
 *  - максимальный ДРР — после накопления данных (расход ≥ drrMinSpend или кликов ≥ drrMinClicks за 14 дн.):
 *    ДРР выше максимума → потолок на этот запуск снижается на drrLowerPercent; ДРР выше максимума в criticalDrrRatio
 *    раз и за 7, и за 14 дней → автобид приостанавливается, ставка на минимум (расход без единой продажи
 *    считается критическим ДРР).
 * Без лестницы (эндпоинт кабинета не настроен) охват оценить нельзя: автобид только держит ставку в пределах
 * потолка и ДРР, а при малом числе показов за 7 дней поднимает её на raisePercent — пока не упрётся в потолок.
 * Защиты: шаг не больше maxStepPercent за запуск, изменения меньше minStepAmount не отправляются,
 * слово не трогаем чаще раза в cooldownMinutes.
 */
import type { AdBotAction, AdBotStats } from './ad-bot';
import { drrPercent } from './ad-bot';

export const AUTO_BIDDER_DEFAULTS = {
  minBid: 9_500,
  bidRounding: 500,
  reachOptions: [100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
  maxStepPercent: 25,
  minStepAmount: 500,
  cooldownMinutes: 120,
  drrMinSpend: 30_000,
  drrMinClicks: 20,
  drrLowerPercent: 15,
  criticalDrrRatio: 2,
  lowImpressions7: 100,
  raisePercent: 10,
};
export type AutoBidderConfig = typeof AUTO_BIDDER_DEFAULTS;

/** Ступень лестницы кабинета: какая ставка покупает какой охват (и какую примерно позицию). */
export type BidLadderStep = { position: number | null; cpm: number; impressionPercent: number };

export type AutoBidPolicy = {
  adId: string;
  campaignId: string;
  skuGroupId: string;
  query: string;
  enabled: boolean;
  targetReach: number;
  maxBid: number;
  maxDrr: number | null;
  pausedAt: Date | null;
};

export type AutoBidKeyword = {
  campaignId: string;
  campaignName: string;
  adId: string;
  skuGroupId: string;
  query: string;
  cpm: number;
  stopWords: string[];
  groupTitle?: string;
};

export type AutoBidDecisionKind = 'RAISE' | 'LOWER' | 'PAUSE' | 'KEEP';
export type AutoBidDecision = {
  kind: AutoBidDecisionKind;
  newCpm: number;
  reason: string;
  /** ДРР за 14 дней, если есть выручка. */
  drr: number | null;
  /** Ставка, которую лестница просит за желаемый охват (до потолков); null — лестницы нет. */
  ladderCpm: number | null;
  /** Какой охват покупает текущая ставка по лестнице; null — лестницы нет. */
  currentReach: number | null;
  /** Потолок ставки на этот запуск (после защиты по ДРР). */
  cap: number;
};

export type AutoBidContext = {
  ladder: BidLadderStep[] | null;
  stats7: AdBotStats;
  stats14: AdBotStats;
  lastChange: Date | null;
  now: Date;
};

const EMPTY: AdBotStats = { impressions: 0, clicks: 0, sold: 0, revenue: 0, spend: 0, position: null };
const fmt = (value: number) => Math.round(value).toLocaleString('ru-RU');

/** Лестница из ответа кабинета: принимаем массив или объект с payload/data/ladder; поля — в разных написаниях. */
export function parseLadder(raw: unknown): BidLadderStep[] {
  const pick = (value: any): any[] | null => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return null;
    for (const key of ['ladder', 'steps', 'positions', 'bids', 'items', 'content', 'payload', 'data']) {
      const inner = pick(value[key]);
      if (inner) return inner;
    }
    return null;
  };
  const rows = pick(raw) ?? [];
  const num = (value: unknown) => (value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null);
  const steps: BidLadderStep[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const cpm = num(row.cpm ?? row.bid ?? row.price ?? row.amount);
    const percent = num(row.impressionPercent ?? row.impressionsPercent ?? row.impressionShare ?? row.coverage ?? row.reach ?? row.percent);
    if (cpm === null || percent === null || cpm <= 0) continue;
    steps.push({ position: num(row.position ?? row.pos ?? row.rank), cpm, impressionPercent: percent > 1 ? percent : percent * 100 });
  }
  return steps.sort((a, b) => a.impressionPercent - b.impressionPercent || a.cpm - b.cpm);
}

/** Минимальная ставка лестницы, покупающая охват ≥ targetReach; охват недостижим — верхняя ступень. */
export function bidForReach(ladder: BidLadderStep[], targetReach: number): BidLadderStep | null {
  if (!ladder.length) return null;
  const sorted = [...ladder].sort((a, b) => a.impressionPercent - b.impressionPercent || a.cpm - b.cpm);
  return sorted.find((step) => step.impressionPercent >= targetReach) ?? sorted[sorted.length - 1];
}

/** Какой охват покупает ставка cpm: самая высокая ступень с ценой ≤ cpm; ниже первой ступени — 0. */
export function reachForBid(ladder: BidLadderStep[], cpm: number): number | null {
  if (!ladder.length) return null;
  const affordable = ladder.filter((step) => step.cpm <= cpm);
  return affordable.length ? Math.max(...affordable.map((step) => step.impressionPercent)) : 0;
}

export function roundBid(value: number, direction: 'up' | 'down', cfg: Pick<AutoBidderConfig, 'bidRounding'> = AUTO_BIDDER_DEFAULTS) {
  const step = Math.max(1, cfg.bidRounding);
  return direction === 'up' ? Math.ceil(value / step) * step : Math.floor(value / step) * step;
}

/** Решение по одному слову. KEEP — ничего не отправлять. */
export function decideAutoBid(policy: AutoBidPolicy, keyword: AutoBidKeyword, ctx: AutoBidContext, cfg: AutoBidderConfig = AUTO_BIDDER_DEFAULTS): AutoBidDecision {
  const s7 = ctx.stats7 ?? EMPTY;
  const s14 = ctx.stats14 ?? EMPTY;
  const drr14 = drrPercent(s14);
  const drr7 = drrPercent(s7);
  const ladder = ctx.ladder && ctx.ladder.length ? ctx.ladder : null;
  const ladderStep = ladder ? bidForReach(ladder, policy.targetReach) : null;
  const currentReach = ladder ? reachForBid(ladder, keyword.cpm) : null;
  const base = { drr: drr14, ladderCpm: ladderStep?.cpm ?? null, currentReach };
  const keep = (reason: string, cap = policy.maxBid): AutoBidDecision => ({ kind: 'KEEP', newCpm: keyword.cpm, reason, cap, ...base });

  if (!policy.enabled) return keep('авто-ставка выключена');
  if (policy.pausedAt) return keep('авто-ставка приостановлена защитой по ДРР — включите заново вручную');
  if (ctx.lastChange && ctx.now.getTime() - ctx.lastChange.getTime() < cfg.cooldownMinutes * 60_000) return keep(`ставку меняли меньше ${cfg.cooldownMinutes} мин назад`);

  const stats = `за 14 дн.: показов ${s14.impressions}, кликов ${s14.clicks}, продаж ${s14.sold}, расход ${fmt(s14.spend)}${drr14 !== null ? `, ДРР ${drr14.toFixed(1)}%` : ''}`;
  let cap = Math.max(cfg.minBid, policy.maxBid);
  const notes: string[] = [];

  // Защита по ДРР — только когда данных достаточно, чтобы судить.
  const enough = s14.spend >= cfg.drrMinSpend || s14.clicks >= cfg.drrMinClicks;
  if (policy.maxDrr !== null && policy.maxDrr > 0 && enough) {
    const critical = policy.maxDrr * cfg.criticalDrrRatio;
    const over14 = drr14 === null ? s14.spend > 0 : drr14 > critical;
    const over7 = drr7 === null ? s7.spend > 0 : drr7 > critical;
    if (over14 && over7) {
      const newCpm = Math.min(keyword.cpm, cfg.minBid);
      return {
        kind: 'PAUSE', newCpm, cap: cfg.minBid, ...base,
        reason: `ДРР ${drr14 === null ? 'без продаж' : `${drr14.toFixed(1)}%`} — выше максимума ${policy.maxDrr}% в ${cfg.criticalDrrRatio} раза и за 7, и за 14 дней: авто-ставка приостановлена, ставка на минимум (${stats})`,
      };
    }
    if (drr14 !== null && drr14 > policy.maxDrr) {
      cap = Math.max(cfg.minBid, Math.min(cap, roundBid(keyword.cpm * (1 - cfg.drrLowerPercent / 100), 'down', cfg)));
      notes.push(`ДРР ${drr14.toFixed(1)}% выше максимума ${policy.maxDrr}% — потолок на этот запуск ${fmt(cap)}`);
    }
  }

  // Целевая ставка: по лестнице — цена желаемого охвата; без лестницы — держим, при малом охвате поднимаем.
  let target: number;
  let why: string;
  if (ladderStep) {
    target = ladderStep.cpm;
    const reached = ladderStep.impressionPercent >= policy.targetReach;
    why = `охват ${policy.targetReach}% ${reached ? 'стоит' : `недостижим, максимум ${ladderStep.impressionPercent}% за`} ${fmt(ladderStep.cpm)}${ladderStep.position !== null ? ` (позиция ≈ ${ladderStep.position})` : ''}; сейчас ставка ${fmt(keyword.cpm)} покупает ${currentReach ?? 0}%`;
  } else if (s7.impressions < cfg.lowImpressions7 && keyword.cpm < cap) {
    target = keyword.cpm * (1 + cfg.raisePercent / 100);
    why = `лестницы ставок нет; показов за 7 дн. мало (${s7.impressions}) — поднимаем на ${cfg.raisePercent}% ради охвата`;
  } else {
    target = keyword.cpm;
    why = 'лестницы ставок нет — охват оценить нельзя, держим ставку в пределах потолка и ДРР';
  }
  target = Math.min(cap, Math.max(cfg.minBid, target));

  // Шаг за запуск ограничен; мелкие сдвиги не отправляем; округление — в сторону изменения.
  if (target > keyword.cpm) target = Math.min(target, keyword.cpm * (1 + cfg.maxStepPercent / 100));
  else if (target < keyword.cpm) target = Math.max(target, keyword.cpm * (1 - cfg.maxStepPercent / 100));
  const delta = target - keyword.cpm;
  if (Math.abs(delta) < cfg.minStepAmount) return keep([why, ...notes, stats].join('; '), cap);
  target = roundBid(target, delta > 0 ? 'up' : 'down', cfg);
  target = Math.min(Math.max(cap, cfg.minBid), Math.max(cfg.minBid, target));
  if (target === keyword.cpm) return keep([why, ...notes, stats].join('; '), cap);
  return {
    kind: delta > 0 ? 'RAISE' : 'LOWER', newCpm: target, cap, ...base,
    reason: [why, ...notes, stats].join('; '),
  };
}

export type AutoBidderPlanRow = { policy: AutoBidPolicy; keyword: AutoBidKeyword; decision: AutoBidDecision };
export type AutoBidderPlan = { rows: AutoBidderPlanRow[]; actions: AdBotAction[]; notes: string[] };

/** План по всем включённым словам: действия в формате рекламного бота — их отправляет тот же PUT кампании. */
export function planAutoBidder(policies: AutoBidPolicy[], keywords: Map<string, AutoBidKeyword>, context: (adId: string) => AutoBidContext, cfg: AutoBidderConfig = AUTO_BIDDER_DEFAULTS): AutoBidderPlan {
  const rows: AutoBidderPlanRow[] = [];
  const actions: AdBotAction[] = [];
  const notes: string[] = [];
  for (const policy of policies) {
    const keyword = keywords.get(policy.adId);
    if (!keyword) { notes.push(`«${policy.query}»: слова больше нет в кампании ${policy.campaignId} — авто-ставка пропущена`); continue; }
    const decision = decideAutoBid(policy, keyword, context(policy.adId), cfg);
    rows.push({ policy, keyword, decision });
    if (decision.kind === 'KEEP') continue;
    if (decision.newCpm === keyword.cpm) continue;
    actions.push({
      kind: decision.kind === 'RAISE' ? 'RAISE' : 'LOWER',
      campaignId: keyword.campaignId, campaignName: keyword.campaignName, skuGroupId: keyword.skuGroupId,
      groupTitle: keyword.groupTitle ?? keyword.skuGroupId, adId: keyword.adId, query: keyword.query,
      oldCpm: keyword.cpm, newCpm: decision.newCpm, stopWords: keyword.stopWords,
      reason: `авто-ставка: ${decision.reason}`,
    });
  }
  return { rows, actions, notes };
}

const LABELS: Record<AutoBidDecisionKind, string> = { RAISE: '⬆️ подняли', LOWER: '⬇️ снизили', PAUSE: '⏸ приостановили', KEEP: '• без изменений' };

/** Отчёт в Telegram, кусками до 3900 символов. Без действий — одна короткая строка. */
export function formatAutoBidderReport(input: { label: string; apply: boolean; plan: AutoBidderPlan; outcomes: Array<{ action: AdBotAction; ok: boolean; message: string }>; notes: string[] }): string[] {
  const changed = input.plan.rows.filter((row) => row.decision.kind !== 'KEEP');
  const head = `🎯 Авто-ставка, ${input.label} — ${input.apply ? 'ставки меняются' : 'только предложения, ничего не меняется'}\nСлов на авто-ставке: ${input.plan.rows.length}; изменений: ${changed.length}`;
  const lines: string[] = [];
  for (const note of [...input.notes, ...input.plan.notes]) lines.push(`⚠️ ${note}`);
  const outcome = new Map(input.outcomes.map((row) => [row.action.adId, row]));
  let campaign = '';
  for (const row of changed) {
    if (row.keyword.campaignName !== campaign) { campaign = row.keyword.campaignName; lines.push('', `📣 ${campaign}`); }
    const done = outcome.get(row.keyword.adId);
    const verb = input.apply ? LABELS[row.decision.kind] : LABELS[row.decision.kind].replace('подняли', 'поднять').replace('снизили', 'снизить').replace('приостановили', 'приостановить');
    lines.push(`${verb} «${row.keyword.query}»: ${fmt(row.keyword.cpm)} → ${fmt(row.decision.newCpm)}${row.decision.currentReach !== null ? ` (охват ${row.decision.currentReach}% → цель ${row.policy.targetReach}%)` : ''}${done ? (done.ok ? ' ✅' : ` ❌ ${done.message}`) : ''}`);
    lines.push(`   ${row.decision.reason}`);
  }
  if (!changed.length) lines.push('', 'Ставки на месте: охват и ДРР в пределах заданного.');
  const chunks: string[] = [];
  let current = head;
  for (const line of lines) {
    if (current.length + line.length + 1 > 3900) { chunks.push(current); current = line; } else current += `\n${line}`;
  }
  chunks.push(current);
  return chunks;
}
