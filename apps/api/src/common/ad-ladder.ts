/**
 * «Лестница ставок» — ежедневная сверка ставок «Буст в ТОП» с лестницей охвата кабинета (решение владельца 16.10.2026).
 *
 * Цель владельца: по каждому релевантному запросу карточка в топ-10 одним-двумя цветами, остальные цвета «по серединке»,
 * без переплаты. Лестница кабинета (common/auto-bidder.ts → parseLadder) у каждого цвета своя: на «наборе полотенец»
 * у HAVANA топ-10 хаки стоил 12 029, молочного — 45 910. Поэтому правило работает по запросу целиком:
 *
 *   1. Для каждой пары «кампания + запрос» берём цвета с непустой лестницей и цену топ-10 (самая дешёвая ступень
 *      с позицией ≤ topPosition, у кабинета это позиция 9 = 70 % показов).
 *   2. Боевые цвета запроса — до `colors` самых дешёвых, чья цена топ-10 с запасом укладывается в потолок класса
 *      запроса; плюс любой цвет, чей топ-10 дешевле `cheapTop` (такой топ почти ничего не стоит).
 *      Ставка боевого цвета = цена топ-10 + `marginPercent` %, округление вверх до `rounding`.
 *   3. Остальные цвета не поднимаем; если ставка у них сама дотягивает до топ-10 или выше цены 100 % —
 *      снижаем до ступени ниже топ-10.
 *   4. Правим, только если ставка вне топ-10, переплачивает больше `overpayTolerance` или вышла за 100 %:
 *      каждая правка в Uzum пересоздаёт объявление, дёргать его ради 500 сум незачем.
 *
 * Модуль чистый — без сети и БД. Сервис: modules/ads/ad-ladder.service.ts.
 */
import { AdBotAction, AdBotKeyword, AdBotStats, normalizeQuery } from './ad-bot';
import { BidLadderStep, bidForPosition, bidForReach, policyKey, positionForBid } from './auto-bidder';

/** Кампании полотенец (HAVANA, j471, J403, «Банное 100×150» 332097 — сауна 2263224, с 17.10.2026) — по умолчанию; AD_LADDER_CAMPAIGNS переопределяет
 * списком id через запятую. Неактивная (на паузе) кампания пропускается с пометкой в отчёте. */
export const AD_LADDER_DEFAULT_CAMPAIGNS = ['286528', '305122', '305324', '332097', '337334'];

/**
 * Запуск новинки: до указанного дня (включительно, Ташкент) проверка ДРР кампании не действует — у товара без
 * отзывов первые продажи дорогие, и потолок 6 % задушил бы его в первые дни. Топ-10 и потолки ставок работают как обычно.
 * 337334 — «Сердечки 3480224 новинка» (жаккард с сердечками), создана 18.10.2026, льгота 14 дней.
 */
export const AD_LADDER_LAUNCH_UNTIL: Record<string, string> = { '337334': '2026-11-01' };
export function launchCampaigns(today: string, table: Record<string, string> = AD_LADDER_LAUNCH_UNTIL): Set<string> {
  return new Set(Object.entries(table).filter(([, until]) => today <= until).map(([id]) => id));
}

export function ladderCampaigns(): string[] {
  const raw = String(process.env.AD_LADDER_CAMPAIGNS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  return raw.length ? raw : AD_LADDER_DEFAULT_CAMPAIGNS;
}
export const ladderEnabled = () => process.env.AD_LADDER_ENABLED !== 'false';

/** maxDrr — потолок ДРР класса, %; нет — общий maxDrrPercent. */
export type LadderQueryClass = { name: string; match: (query: string) => boolean; cap: number; colors: number; maxDrr?: number };

export const AD_LADDER_DEFAULTS = {
  topPosition: 10,
  /** Запас сверх цены ступени: лестница за день сдвигается. */
  marginPercent: 3,
  rounding: 500,
  minBid: 9_500,
  maxBid: 70_000,
  /** Топ-10 дешевле этого — берём для любого цвета запроса. */
  cheapTop: 15_000,
  /** Ставка боевого цвета выше нужной больше чем на столько (сум и % от нужной, берётся большее) — снижаем.
   * Сверка идёт каждый час, а лестница гуляет за день (16–17.10: топ-10 одного слова 43 тыс. утром и 26 тыс. днём) —
   * запас не даёт дёргать объявление на каждом колебании. */
  overpayTolerance: 2_000,
  overpayPercent: 10,
  /** Слово, которое лестница уже правила за столько часов, не трогаем — кроме подъёма боевого цвета, выпавшего из топ-10. */
  cooldownHours: 2,
  /** ДРР за 7 дней (реклама / выручка с рекламы по Cube AdvertisingDailyFunnel, ключ «цвет|запрос»). Владелец 17.10: «нужно
   * следить за расходами кампаний и ДРР». Судим только при достаточных данных; слово с ДРР выше потолка класса не держим
   * в топ-10, при ДРР выше вдвое или расходе без продаж — ставка на минимум. */
  maxDrrPercent: 10,
  judgeMinSpend: 30_000,
  judgeMinClicks: 20,
  noSaleSpend: 50_000,
  /** Классы запросов (первое совпадение): потолок цены топ-10 и сколько цветов держать в топе. */
  classes: [
    // Владелец 17.10.2026: «набор полотенец, комплект, сауна — там вся маржа»: чек комплекта 160–250 тыс., сауны 160 тыс.,
    // поэтому топ-10 по этим запросам покупаем до общего потолка ставки (AD_BOT_MAX_BID, 70 000).
    { name: 'наборы, комплекты, сауна', match: (q: string) => /(набор|комплект|саун|бан[яи]|бассейн|sauna|basseyn|to ?plam|nabor|komplekt|katta|100 ?[xх] ?150|большое полотенце)/.test(q), cap: 70_000, colors: 2, maxDrr: 10 },
    { name: 'банные', match: (q: string) => /^(полотенце банное|банное полотенце)( |$)/.test(q), cap: 60_000, colors: 2 },
    { name: 'лицевые', match: (q: string) => /^полотенце для лица$/.test(q), cap: 40_000, colors: 2 },
    // sochiq / sochiqlar — самые объёмные запросы (прогноз кабинета 16.10: ≈ 5 100 и 7 100 показов против 3 900 у «полотенце банное»).
    { name: 'узбекские основные', match: (q: string) => /^(sochiq|sochiqlar|yuz sochiq)$/.test(q), cap: 25_000, colors: 2 },
    { name: 'остальные', match: () => true, cap: 20_000, colors: 1 },
  ] as LadderQueryClass[],
};
export type AdLadderConfig = typeof AD_LADDER_DEFAULTS;

export type LadderKeyword = AdBotKeyword & { ladder: BidLadderStep[] | null; stats7?: AdBotStats | null };
export type LadderDecision = {
  keyword: LadderKeyword;
  role: 'top' | 'other' | 'no-ladder';
  top10: BidLadderStep | null;
  full: BidLadderStep | null;
  target: number | null;
  positionBefore: number | null;
  positionAfter: number | null;
  action: AdBotAction | null;
  /** ДРР за 7 дней, % (null — выручки нет) и почему слово не держим в топе. */
  drr: number | null;
  blocked: string | null;
};

/** ДРР и вердикт по статистике слова за 7 дней. */
export function ladderDrrVerdict(stats: AdBotStats | null | undefined, maxDrr: number, cfg: Pick<AdLadderConfig, 'judgeMinSpend' | 'judgeMinClicks' | 'noSaleSpend'> = AD_LADDER_DEFAULTS): { drr: number | null; blocked: string | null; severe: boolean } {
  if (!stats) return { drr: null, blocked: null, severe: false };
  const drr = stats.revenue > 0 ? (stats.spend / stats.revenue) * 100 : null;
  if (stats.sold === 0 && stats.spend >= cfg.noSaleSpend) return { drr, blocked: `расход ${fmt(stats.spend)} за 7 дней без продаж`, severe: true };
  const enough = stats.spend >= cfg.judgeMinSpend || stats.clicks >= cfg.judgeMinClicks;
  if (enough && drr !== null && drr > maxDrr) return { drr, blocked: `ДРР ${drr.toFixed(1)} % > ${maxDrr} %`, severe: drr > 2 * maxDrr };
  return { drr, blocked: null, severe: false };
}

const roundUp = (value: number, step: number) => Math.ceil(value / Math.max(1, step)) * Math.max(1, step);
const roundDown = (value: number, step: number) => Math.floor(value / Math.max(1, step)) * Math.max(1, step);
const fmt = (value: number) => Math.round(value).toLocaleString('ru-RU');

export function ladderQueryClass(query: string, cfg: Pick<AdLadderConfig, 'classes'> = AD_LADDER_DEFAULTS): LadderQueryClass {
  const q = normalizeQuery(query);
  return cfg.classes.find((row) => row.match(q)) ?? cfg.classes[cfg.classes.length - 1];
}

/** Ключ слова для паузы после правки: «кампания|цвет|запрос», как у авто-ставки (id объявления Uzum меняет при каждой правке). */
export const ladderKey = (keyword: Pick<AdBotKeyword, 'campaignId' | 'skuGroupId' | 'query'>) => policyKey(keyword.campaignId, keyword.skuGroupId, keyword.query);

/** Решения по всем словам: какие цвета держать в топ-10 и какие ставки поставить. recent — слова, правленные за cooldownHours;
 * launch — кампании на льготе запуска (ДРР не проверяется). */
export function planLadderBids(keywords: LadderKeyword[], cfg: AdLadderConfig = AD_LADDER_DEFAULTS, recent: Set<string> = new Set(), launch: Set<string> = new Set()): LadderDecision[] {
  const decisions: LadderDecision[] = [];
  const byQuery = new Map<string, LadderKeyword[]>();
  for (const keyword of keywords) {
    const key = `${keyword.campaignId}|${normalizeQuery(keyword.query)}`;
    byQuery.set(key, [...(byQuery.get(key) ?? []), keyword]);
  }
  for (const rows of byQuery.values()) {
    const cls = ladderQueryClass(rows[0].query, cfg);
    const priced = rows
      .map((keyword) => {
        const steps = keyword.ladder ?? [];
        const top10 = steps.length ? bidForPosition(steps, cfg.topPosition) : null;
        const target = top10 ? Math.min(cfg.maxBid, Math.max(cfg.minBid, roundUp(top10.cpm * (1 + cfg.marginPercent / 100), cfg.rounding))) : null;
        const verdict = launch.has(keyword.campaignId) ? { drr: null, blocked: null, severe: false } : ladderDrrVerdict(keyword.stats7, cls.maxDrr ?? cfg.maxDrrPercent, cfg);
        return { keyword, steps, top10, full: steps.length ? bidForReach(steps, 100) : null, target, verdict };
      })
      .sort((a, b) => (a.top10?.cpm ?? Infinity) - (b.top10?.cpm ?? Infinity));
    let chosen = 0;
    for (const row of priced) {
      const { keyword, steps, top10, full, target, verdict } = row;
      const base = { keyword, top10, full, positionBefore: steps.length ? positionForBid(steps, keyword.cpm) : null, drr: verdict.drr, blocked: verdict.blocked };
      if (!top10 || target === null) {
        decisions.push({ ...base, role: 'no-ladder', target: null, positionAfter: base.positionBefore, action: null });
        continue;
      }
      const isTop = !verdict.blocked && target <= cls.cap && (chosen < cls.colors || top10.cpm <= cfg.cheapTop);
      if (isTop) chosen++;
      const common = { campaignId: keyword.campaignId, campaignName: keyword.campaignName, skuGroupId: keyword.skuGroupId, groupTitle: keyword.skuGroupId, adId: keyword.adId, query: keyword.query, oldCpm: keyword.cpm, stopWords: keyword.stopWords };
      let next: number | null = null;
      let reason = '';
      const cooling = recent.has(ladderKey(keyword));
      if (isTop) {
        const outOfTop = keyword.cpm < top10.cpm;
        const overpay = keyword.cpm > target + Math.max(cfg.overpayTolerance, (target * cfg.overpayPercent) / 100) || (full !== null && keyword.cpm > full.cpm);
        if (outOfTop || (overpay && !cooling)) {
          next = target;
          reason = `лестница: топ-10 (${cls.name}) стоит ${fmt(top10.cpm)}, позиция ${top10.position}; ${outOfTop ? 'ставка была ниже топ-10' : 'была переплата'}`;
        }
      } else if (verdict.severe) {
        // ДРР выше потолка вдвое или расход без продаж — слово не окупается: ставка на минимум (выключает только владелец).
        if (keyword.cpm > cfg.minBid && !cooling) {
          next = cfg.minBid;
          reason = `лестница: ${verdict.blocked} — ставка на минимум`;
        }
      } else {
        const belowTop = top10.cpm - cfg.rounding;
        const inTop = keyword.cpm >= top10.cpm;
        const overFull = full !== null && keyword.cpm > full.cpm;
        if ((inTop || overFull) && belowTop >= cfg.minBid && !cooling) {
          next = Math.max(cfg.minBid, roundDown(belowTop, cfg.rounding));
          reason = verdict.blocked
            ? `лестница: ${verdict.blocked} — не держим в топ-10 (${fmt(top10.cpm)})`
            : `лестница: цвет не боевой для «${keyword.query}» — ниже топ-10 (${fmt(top10.cpm)})${overFull ? ', была ставка выше цены 100 %' : ''}`;
        }
      }
      const action: AdBotAction | null = next !== null && next !== keyword.cpm ? { ...common, kind: next > keyword.cpm ? 'RAISE' : 'LOWER', newCpm: next, reason } : null;
      const finalCpm = action?.newCpm ?? keyword.cpm;
      decisions.push({ ...base, role: isTop ? 'top' : 'other', target: isTop ? target : null, positionAfter: positionForBid(steps, finalCpm), action });
    }
  }
  return decisions;
}

/** Отчёт владельцу: что поменяли и где боевые цвета не попадают в топ-10. */
/** Сводка кампании для отчёта: расход и выручка с рекламы за 7 дней, расход с понедельника и недельный бюджет. */
export type LadderCampaignSummary = { name: string; spend7: number; revenue7: number; sold7: number; weekSpend: number; weeklyBudget: number | null; daysPassed: number };

export function formatCampaignSummary(row: LadderCampaignSummary): string {
  const drr = row.revenue7 > 0 ? `${((row.spend7 / row.revenue7) * 100).toFixed(1)} %` : row.spend7 > 0 ? 'нет продаж' : '—';
  let budget = '';
  if (row.weeklyBudget) {
    const used = Math.round((row.weekSpend / row.weeklyBudget) * 100);
    budget = ` · с понедельника ${fmt(row.weekSpend)} из ${fmt(row.weeklyBudget)} (${used} %)`;
    if (row.weekSpend >= row.weeklyBudget) budget += ' — ⚠ бюджет кончился, показов до понедельника нет';
    else if (row.daysPassed > 0 && (row.weekSpend / row.daysPassed) * 7 > row.weeklyBudget) budget += ' — ⚠ при таком темпе кончится раньше воскресенья';
  }
  return `«${row.name}»: реклама за 7 дней ${fmt(row.spend7)}, выручка ${fmt(row.revenue7)}, продаж ${row.sold7}, ДРР ${drr}${budget}`;
}

export function formatLadderReport(decisions: LadderDecision[], opts: { apply: boolean; failed?: number; titles?: Map<string, string>; notes?: string[]; campaigns?: LadderCampaignSummary[] }): string {
  const title = (id: string) => opts.titles?.get(id) ?? id;
  const changed = decisions.filter((row) => row.action);
  const lines = [`📶 Лестница ставок «Буст в ТОП» — ${opts.apply ? 'применено' : 'только предложения'}`];
  const tops = decisions.filter((row) => row.role === 'top');
  const inTop = tops.filter((row) => row.positionAfter !== null && row.positionAfter <= 10).length;
  lines.push(`Боевых пар «цвет + запрос»: ${tops.length}, в топ-10 после правок: ${inTop}. Правок: ${changed.length}${opts.failed ? `, не прошло: ${opts.failed}` : ''}.`);
  if (opts.campaigns?.length) lines.push('', '💰 Расход и ДРР', ...opts.campaigns.map(formatCampaignSummary));
  const blocked = decisions.filter((row) => row.blocked).sort((a, b) => (b.keyword.stats7?.spend ?? 0) - (a.keyword.stats7?.spend ?? 0));
  if (blocked.length) lines.push('', `Не окупаются, из топ-10 убраны (${blocked.length}): ${blocked.slice(0, 8).map((row) => `${title(row.keyword.skuGroupId)} «${row.keyword.query}» — ${row.blocked}`).join('; ')}`);
  const byCampaign = new Map<string, LadderDecision[]>();
  for (const row of changed) byCampaign.set(row.keyword.campaignName, [...(byCampaign.get(row.keyword.campaignName) ?? []), row]);
  for (const [name, rows] of byCampaign) {
    lines.push('', `«${name}»`);
    for (const row of rows) {
      const a = row.action as AdBotAction;
      lines.push(`${a.kind === 'RAISE' ? '⬆️' : '⬇️'} ${title(a.skuGroupId)} «${a.query}» ${fmt(a.oldCpm ?? 0)} → ${fmt(a.newCpm)} (позиция ${row.positionBefore ?? '—'} → ${row.positionAfter ?? '—'})`);
    }
  }
  const missing = decisions.filter((row) => row.role === 'other' && row.top10 && ladderQueryClass(row.keyword.query).colors > 0)
    .filter((row) => !decisions.some((other) => other.role === 'top' && other.keyword.campaignId === row.keyword.campaignId && normalizeQuery(other.keyword.query) === normalizeQuery(row.keyword.query)));
  const queries = [...new Set(missing.map((row) => `«${row.keyword.query}» (топ-10 от ${fmt(Math.min(...missing.filter((m) => m.keyword.query === row.keyword.query).map((m) => m.top10?.cpm ?? Infinity)))})`))];
  if (queries.length) lines.push('', `Дороже потолка, ни один цвет не в топ-10: ${queries.slice(0, 15).join(', ')}`);
  for (const note of opts.notes ?? []) lines.push(`⚠ ${note}`);
  return lines.join('\n');
}
