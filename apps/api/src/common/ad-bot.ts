/**
 * Рекламный бот «Буст в ТОП»: правила изменения ставок и ключевых слов. Модуль чистый — без сети.
 *
 * Данные (снято из кабинета 28.09.2026, модуль mf-paid-promotion):
 *  - слова кампании: GET /seller/advertising/management/ad-campaign/{id}/advertisement?page&size (size ≤ 10)
 *    → payload.skuGroupAdvertisements[].advertisements[] { id, skuGroupId, cpm, query, stopWords, promotionType };
 *  - статистика слова: Cube AdvertisingDailyFunnel по bid_id (= id объявления): показы, клики, продажи, выручка,
 *    расход, средняя позиция; реальные запросы покупателей — AdvertisingFeedDailyFunnel.search_query;
 *  - запись: PUT /seller/advertising/management/ad-campaign/{id}
 *    { advertisements: [{ action: NEW | EDIT | SUSPEND, advertisement: { id?, cpm, promotionType, query?, skuGroupId, stopWords? } }],
 *      budgetConfig: { reset, uniformDistribution, weeklyAmount }, name, period: { dateFrom, dateTo, isEndless } } → 204.
 *    Отправляются только изменённые объявления; бюджет, название и период бот не меняет.
 *
 * Правила (окно 14 дней, охват — 7 дней), цель — ДРР ≤ maxDrrPercent:
 *  - мало остатка у цвета (≤ lowStockUnits) — ставка на минимум;
 *  - расход без продаж ≥ zeroSaleSpendRatio × цены товара при ≥ minClicksToJudge кликов — снизить на cutPercent,
 *    а если ставка уже минимальная и расход ≥ цены товара — остановить слово;
 *  - есть продажи: ДРР > цели ×1.5 — снизить на lowerPercent, ДРР > цели — на половину lowerPercent;
 *    ДРР ≤ половины цели, ≥ 2 продаж и позиция ниже topPosition — поднять на raisePercent;
 *  - мало показов за 7 дней при нормальном ДРР (или без лишнего расхода) — поднять на raisePercent (охват);
 *  - новые слова: реальные запросы покупателей с продажами, которых ещё нет у этого цвета, — не больше
 *    newKeywordsPerGroup на цвет, ставка — медиана ставок цвета;
 *  - минус-слова: слово из запросов покупателей, по которым за 28 дней ≥ stopMinImpressions показов или
 *    ≥ stopMinClicks кликов и ни одной продажи и корзины, если его нет ни в одном продающем запросе цвета и в самой
 *    фразе; добавляется во все слова цвета (Uzum: не больше maxStopWords минус-слов, от minStopWordLength букв),
 *    сначала самые «дорогие» по показам. Оплата — за показы, поэтому чужие запросы и раздувают ДРР.
 * Защиты: ставка minBid…maxBid, шаг — только проценты выше, слово меняем не чаще раза в cooldownDays,
 * не больше maxChangesPerRun изменений за запуск (сначала снижения и остановки, потом новые слова, потом повышения).
 */

export const AD_BOT_DEFAULTS = {
  maxDrrPercent: 10,
  minBid: 9_500,
  maxBid: 50_000,
  /** Потолок ставки по кампании (campaignId → сум), ниже общего maxBid: AD_BOT_CAMPAIGN_MAX_BID=332097:18500,… */
  campaignMaxBid: {} as Record<string, number>,
  bidRounding: 500,
  raisePercent: 10,
  lowerPercent: 15,
  cutPercent: 25,
  minClicksToJudge: 25,
  zeroSaleSpendRatio: 0.5,
  suspendSpendRatio: 1,
  lowImpressions7: 150,
  // Повышать «ради охвата» только если слово вообще показывается: при 0–7
  // показах непонятно, ставка ли причина, и рост вслепую лишь жёг бы бюджет.
  reachRaiseMinImpressions14: 10,
  goodDrrRatio: 0.5,
  topPosition: 5,
  lowStockUnits: 3,
  /** Цвет вернулся на склад, а ставка осталась на минимуме после «остаток ≤ 3» и показов нет — поднять сразу
   * до этой ставки: правило «ради охвата» требует ≥ 10 показов, и с нуля слово само никогда не выбралось бы. */
  restockBid: 15_000,
  newKeywordMinSold: 1,
  /** Не больше одной новой фразы на цвет за запуск. */
  newKeywordsPerGroup: 1,
  /** Узбекские (латиница) запросы берём и без продажи — но от стольких кликов И корзин: при пороге
   * «1 клик» бот 06.10.2026 добавил «sochiq nabor banya xalat» и «barashka pled». */
  uzbekKeywordMinClicks: 3,
  uzbekKeywordMinAtc: 1,
  /** Стартовая ставка любой новой фразы — минимальная, а не медиана цвета: 06.10.2026 «штаны мужские
   * теплые для дома» получили 20 000 по медиане. Дальше ставку ведут правила по ДРР. */
  newKeywordBid: 9_500,
  uzbekKeywordBid: 9_500,
  /** Новая фраза берётся, только если в запросе есть слово товара и нет запретного: Uzum подбирает показы
   * широко, и в запросах с продажей бывают посторонние вещи («штаны», «халат», «barashka pled»). */
  productWords: ['полотен', 'sochiq', 'сочик', 'махров', 'банн', 'плед', 'pled', 'покрывал', 'yopinchiq', 'adyol', 'parisa'] as string[],
  junkWords: ['штаны', 'брюки', 'халат', 'xalat', 'barashka', 'kiyim', 'костюм', 'kostyum', 'носки', 'футболк', 'шапк', 'одеял', 'пижам', 'джинс', 'куртк', 'платье', 'тапоч', 'свитер', 'шорты', 'белье', 'трусы'] as string[],
  /** Потолок ДРР цвета зависит от запаса (правило A12). Цвет с запасом от стольких дней — медленный:
   * ему реклама нужна ради оборота склада, и потолок ДРР равен его марже минус запас… */
  slowStockDays: 60,
  /** …минус столько п.п. (половина приписанных продаж случилась бы и без рекламы — страховка)… */
  marginDrrGapPoints: 5,
  /** …но не выше этого. Для цветов с нормальным запасом потолок — maxDrrPercent. */
  maxDrrCeilingPercent: 30,
  maxQueryLength: 60,
  cooldownDays: 3,
  maxChangesPerRun: 30,
  stopMinImpressions: 300,
  stopMinClicks: 10,
  maxStopWords: 58,
  minStopWordLength: 3,
  newStopWordsPerGroup: 10,
};
export type AdBotConfig = typeof AD_BOT_DEFAULTS;

export type AdBotKeyword = {
  campaignId: string;
  campaignName: string;
  adId: string;
  skuGroupId: string;
  query: string;
  cpm: number;
  stopWords: string[];
};
export type AdBotStats = { impressions: number; clicks: number; sold: number; revenue: number; spend: number; position: number | null };
export type AdBotGroup = {
  skuGroupId: string;
  title: string;
  stock: number | null;
  price: number | null;
  /** Запас в днях по кабинету (сумма остатков / сумма средних продаж в день); Infinity — остаток есть, продаж нет. */
  daysOfStock?: number | null;
  /** Маржа цвета по текущей цене, % (минимум по SKU цвета с известной себестоимостью). */
  marginPercent?: number | null;
};

/** Потолок ДРР для цвета (A12): медленному запасу разрешаем ДРР до «маржа − запас», остальным — общую цель. */
export function groupDrrTarget(group: AdBotGroup | undefined, cfg: Pick<AdBotConfig, 'maxDrrPercent' | 'slowStockDays' | 'marginDrrGapPoints' | 'maxDrrCeilingPercent'> = AD_BOT_DEFAULTS): number {
  const days = group?.daysOfStock;
  const margin = group?.marginPercent;
  if (days === null || days === undefined || days < cfg.slowStockDays) return cfg.maxDrrPercent;
  if (margin === null || margin === undefined) return cfg.maxDrrPercent;
  return Math.max(cfg.maxDrrPercent, Math.min(cfg.maxDrrCeilingPercent, margin - cfg.marginDrrGapPoints));
}
export type AdBotFeedQuery = { skuGroupId: string; searchQuery: string; impressions: number; clicks: number; atc?: number; sold: number; revenue: number };

export type AdBotActionKind = 'LOWER' | 'SUSPEND' | 'STOPWORDS' | 'ADD' | 'RAISE';
export type AdBotAction = {
  kind: AdBotActionKind;
  campaignId: string;
  campaignName: string;
  skuGroupId: string;
  groupTitle: string;
  adId: string | null;
  query: string;
  oldCpm: number | null;
  newCpm: number;
  stopWords: string[];
  /** Минус-слова, добавленные ботом в этот запуск (уже внутри stopWords). */
  addedStopWords?: string[];
  reason: string;
};

export type AdBotInput = {
  keywords: AdBotKeyword[];
  /** Статистика по id объявления: за 14 и за 7 дней. */
  stats14: Map<string, AdBotStats>;
  stats7: Map<string, AdBotStats>;
  groups: Map<string, AdBotGroup>;
  feed: AdBotFeedQuery[];
  /** Когда бот последний раз менял слово: ключ — id объявления или `${skuGroupId}|${query}` для новых. */
  lastChange: Map<string, Date>;
  now: Date;
};

export type AdBotPlan = { actions: AdBotAction[]; deferred: AdBotAction[]; notes: string[] };

const EMPTY: AdBotStats = { impressions: 0, clicks: 0, sold: 0, revenue: 0, spend: 0, position: null };
const DAY_MS = 86_400_000;

export const normalizeQuery = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Ставка в пределах minBid…maxBid, округление до bidRounding в сторону изменения. */
/** Запрос на латинице (узбекский: «sochiq», «yuz va hammom») — без кириллицы, с буквами. */
export function isLatinQuery(query: string): boolean {
  return /[a-z]/.test(query) && !/[а-яё]/i.test(query);
}

export function clampBid(value: number, direction: 'up' | 'down', cfg: Pick<AdBotConfig, 'minBid' | 'maxBid' | 'bidRounding'> = AD_BOT_DEFAULTS): number {
  const step = Math.max(1, cfg.bidRounding);
  const rounded = direction === 'up' ? Math.ceil(value / step) * step : Math.floor(value / step) * step;
  return Math.min(cfg.maxBid, Math.max(cfg.minBid, rounded));
}

export const drrPercent = (stats: AdBotStats): number | null => (stats.revenue > 0 ? (stats.spend / stats.revenue) * 100 : null);

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const fmt = (value: number) => Math.round(value).toLocaleString('ru-RU');

/** Решение по одному слову (без лимита на число изменений). null — оставить как есть. */
/** Конфиг для кампании: общий, но с её потолком ставки, если задан. */
export function configFor(campaignId: string, cfg: AdBotConfig = AD_BOT_DEFAULTS): AdBotConfig {
  const cap = cfg.campaignMaxBid[campaignId];
  return cap && cap < cfg.maxBid ? { ...cfg, maxBid: Math.max(cfg.minBid, cap) } : cfg;
}

export function decideKeyword(keyword: AdBotKeyword, input: AdBotInput, base: AdBotConfig = AD_BOT_DEFAULTS): AdBotAction | null {
  const cfg = configFor(keyword.campaignId, base);
  const last = input.lastChange.get(keyword.adId);
  if (last && input.now.getTime() - last.getTime() < cfg.cooldownDays * DAY_MS) return null;
  const s14 = input.stats14.get(keyword.adId) ?? EMPTY;
  const s7 = input.stats7.get(keyword.adId) ?? EMPTY;
  const group = input.groups.get(keyword.skuGroupId);
  const price = group?.price ?? null;
  const stockOk = group?.stock === null || group?.stock === undefined || group.stock > cfg.lowStockUnits;
  const action = (kind: AdBotActionKind, newCpm: number, reason: string): AdBotAction | null => {
    if (kind !== 'SUSPEND' && newCpm === keyword.cpm) return null;
    return {
      kind, campaignId: keyword.campaignId, campaignName: keyword.campaignName, skuGroupId: keyword.skuGroupId,
      groupTitle: group?.title ?? keyword.skuGroupId, adId: keyword.adId, query: keyword.query,
      oldCpm: keyword.cpm, newCpm, stopWords: keyword.stopWords, reason,
    };
  };
  const lower = (percent: number, reason: string) => action('LOWER', clampBid(keyword.cpm * (1 - percent / 100), 'down', cfg), reason);
  const raise = (reason: string) => action('RAISE', clampBid(keyword.cpm * (1 + cfg.raisePercent / 100), 'up', cfg), reason);
  const drr = drrPercent(s14);
  const target = groupDrrTarget(group, cfg);
  const slow = target > cfg.maxDrrPercent ? ` (запас ${Math.round(group?.daysOfStock ?? 0)} дн., маржа ${group?.marginPercent?.toFixed(0)}% — потолок ${target.toFixed(0)}%)` : '';
  const period = `за 14 дн.: показов ${s14.impressions}, кликов ${s14.clicks}, продаж ${s14.sold}, расход ${fmt(s14.spend)}${drr !== null ? `, ДРР ${drr.toFixed(1)}%` : ''}${slow}`;

  if (group?.stock !== null && group?.stock !== undefined && group.stock <= cfg.lowStockUnits) {
    return keyword.cpm > cfg.minBid ? action('LOWER', cfg.minBid, `мало остатка у цвета (${group.stock} шт.) — ставка на минимум`) : null;
  }
  if (group?.stock !== null && group?.stock !== undefined && group.stock > cfg.lowStockUnits && keyword.cpm <= cfg.minBid && s7.impressions === 0 && price !== null) {
    return action('RAISE', clampBid(cfg.restockBid, 'down', cfg), `цвет снова на складе (${group.stock} шт.), ставка на минимуме и показов нет — возвращаем ${fmt(cfg.restockBid)}`);
  }
  if (s14.sold === 0 && price !== null && s14.clicks >= cfg.minClicksToJudge && s14.spend >= cfg.zeroSaleSpendRatio * price) {
    if (keyword.cpm > cfg.minBid) return lower(cfg.cutPercent, `нет продаж при расходе ${fmt(s14.spend)} (${period})`);
    if (s14.spend >= cfg.suspendSpendRatio * price) return action('SUSPEND', keyword.cpm, `нет продаж, ставка уже минимальная, расход ≥ цены товара — слово остановлено (${period})`);
    return null;
  }
  if (drr !== null && drr > target * 1.5) return lower(cfg.lowerPercent, `ДРР ${drr.toFixed(1)}% — выше цели ${target.toFixed(0)}% в 1,5 раза (${period})`);
  if (drr !== null && drr > target) return lower(cfg.lowerPercent / 2, `ДРР ${drr.toFixed(1)}% выше цели ${target.toFixed(0)}% (${period})`);
  if (!stockOk) return null;
  if (drr !== null && drr <= target * cfg.goodDrrRatio && s14.sold >= 2 && (s14.position === null || s14.position > cfg.topPosition)) {
    return raise(`выгодное слово: ДРР ${drr.toFixed(1)}%, позиция ${s14.position?.toFixed(1) ?? '—'} — поднимаем выше (${period})`);
  }
  // «Нет данных» ≠ «всё хорошо»: если цвет не сматчился (нет ни ДРР, ни цены),
  // слово нельзя судить — и поднимать его тоже нельзя, иначе убыточное слово
  // росло бы на каждый прогон до максимума. Тот же принцип, что в автоценах:
  // «маржа не рассчитана — не трогаем».
  const cheap = drr !== null ? drr <= target : price !== null && s14.spend < cfg.zeroSaleSpendRatio * price;
  if (s7.impressions < cfg.lowImpressions7 && cheap && s14.impressions >= cfg.reachRaiseMinImpressions14) return raise(`мало показов: ${s7.impressions} за 7 дн. — поднимаем ради охвата (${period})`);
  return null;
}

/** Новые слова из реальных запросов покупателей с продажами, которых ещё нет у цвета. */
/** Запрос про наш товар: есть слово товара и нет запретного (по нормализованному запросу, по вхождению). */
export function isRelevantQuery(query: string, cfg: Pick<AdBotConfig, 'productWords' | 'junkWords'> = AD_BOT_DEFAULTS): boolean {
  const text = normalizeQuery(query);
  if (!text) return false;
  if (cfg.junkWords.some((word) => text.includes(normalizeQuery(word)))) return false;
  return cfg.productWords.some((word) => text.includes(normalizeQuery(word)));
}

export function newKeywords(input: AdBotInput, cfg: AdBotConfig = AD_BOT_DEFAULTS): AdBotAction[] {
  const byGroup = new Map<string, AdBotKeyword[]>();
  for (const keyword of input.keywords) byGroup.set(keyword.skuGroupId, [...(byGroup.get(keyword.skuGroupId) ?? []), keyword]);
  const actions: AdBotAction[] = [];
  for (const [skuGroupId, keywords] of byGroup) {
    const group = input.groups.get(skuGroupId);
    if (group?.stock !== null && group?.stock !== undefined && group.stock <= cfg.lowStockUnits) continue;
    const existing = new Set(keywords.map((row) => normalizeQuery(row.query)));
    const stopWords = keywords[0].stopWords;
    const stop = stopWords.map(normalizeQuery).filter(Boolean);
    const candidates = new Map<string, AdBotFeedQuery>();
    for (const row of input.feed) {
      if (row.skuGroupId !== skuGroupId) continue;
      const query = normalizeQuery(row.searchQuery);
      const uzbek = isLatinQuery(query) && row.clicks >= cfg.uzbekKeywordMinClicks && (row.atc ?? 0) >= cfg.uzbekKeywordMinAtc;
      if (row.sold < cfg.newKeywordMinSold && !uzbek) continue;
      if (!query || query.length > cfg.maxQueryLength || existing.has(query)) continue;
      if (!isRelevantQuery(query, cfg)) continue;
      if (stop.some((word) => query.split(' ').includes(word))) continue;
      if (input.lastChange.has(`${skuGroupId}|${query}`)) continue;
      const prev = candidates.get(query);
      candidates.set(query, prev ? { ...prev, sold: prev.sold + row.sold, clicks: prev.clicks + row.clicks, revenue: prev.revenue + row.revenue } : { ...row, searchQuery: query });
    }
    const top = [...candidates.values()].sort((a, b) => b.sold - a.sold || b.clicks - a.clicks).slice(0, cfg.newKeywordsPerGroup);
    for (const row of top) {
      const withoutSale = row.sold < cfg.newKeywordMinSold;
      actions.push({
        kind: 'ADD', campaignId: keywords[0].campaignId, campaignName: keywords[0].campaignName, skuGroupId,
        groupTitle: group?.title ?? skuGroupId, adId: null, query: row.searchQuery, oldCpm: null,
        newCpm: clampBid(withoutSale ? cfg.uzbekKeywordBid : cfg.newKeywordBid, 'down', configFor(keywords[0].campaignId, cfg)), stopWords,
        reason: withoutSale
          ? `узбекский запрос без продажи, но с кликами (${row.clicks} за 28 дн.) — пробуем по минимальной ставке`
          : `покупатели находили цвет по этому запросу: продаж ${row.sold}, кликов ${row.clicks} за 28 дн.`,
      });
    }
  }
  return actions;
}

export type StopWordCandidate = { word: string; impressions: number; clicks: number; queries: string[] };

/** Минус-слова цвета из запросов покупателей без продаж и корзин (см. правила в шапке). */
export function stopWordCandidates(skuGroupId: string, keywords: AdBotKeyword[], feed: AdBotFeedQuery[], cfg: AdBotConfig = AD_BOT_DEFAULTS): StopWordCandidate[] {
  const rows = feed.filter((row) => row.skuGroupId === skuGroupId);
  const words = (value: string) => normalizeQuery(value).split(' ').filter(Boolean);
  const protectedWords = new Set<string>();
  for (const row of rows) if (row.sold > 0 || (row.atc ?? 0) > 0) words(row.searchQuery).forEach((word) => protectedWords.add(word));
  for (const keyword of keywords) words(keyword.query).forEach((word) => protectedWords.add(word));
  const existing = new Set(keywords.flatMap((keyword) => keyword.stopWords.map(normalizeQuery)));
  const stats = new Map<string, StopWordCandidate>();
  for (const row of rows) {
    if (row.sold > 0 || (row.atc ?? 0) > 0) continue;
    for (const word of new Set(words(row.searchQuery))) {
      if (word.length < cfg.minStopWordLength || /^\d+$/.test(word) || protectedWords.has(word) || existing.has(word)) continue;
      // Формы слова самого товара («пледы» при ключе «плед») — не мусор, а
      // целевой запрос с проблемой конверсии; общий корень от 4 букв защищает.
      if ([...protectedWords].some((safe) => safe.length >= 4 && word.length >= 4 && (safe.startsWith(word) || word.startsWith(safe)))) continue;
      const item = stats.get(word) ?? { word, impressions: 0, clicks: 0, queries: [] };
      item.impressions += row.impressions;
      item.clicks += row.clicks;
      if (item.queries.length < 3) item.queries.push(normalizeQuery(row.searchQuery));
      stats.set(word, item);
    }
  }
  return [...stats.values()]
    .filter((row) => row.impressions >= cfg.stopMinImpressions || row.clicks >= cfg.stopMinClicks)
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
}

const PRIORITY: Record<AdBotActionKind, number> = { SUSPEND: 0, LOWER: 1, STOPWORDS: 2, ADD: 3, RAISE: 4 };

export function planAdBot(input: AdBotInput, cfg: AdBotConfig = AD_BOT_DEFAULTS): AdBotPlan {
  const notes: string[] = [];
  const decided = input.keywords.map((keyword) => decideKeyword(keyword, input, cfg)).filter((row): row is AdBotAction => row !== null);
  const actions = [...decided, ...newKeywords(input, cfg)];

  // Минус-слова: добавляем во все слова цвета — в уже запланированное изменение или отдельным EDIT без смены ставки.
  const byGroup = new Map<string, AdBotKeyword[]>();
  for (const keyword of input.keywords) byGroup.set(keyword.skuGroupId, [...(byGroup.get(keyword.skuGroupId) ?? []), keyword]);
  for (const [skuGroupId, keywords] of byGroup) {
    const allCandidates = stopWordCandidates(skuGroupId, keywords, input.feed, cfg);
    const manual = allCandidates.filter((row) => row.clicks >= cfg.stopMinClicks);
    if (manual.length) notes.push(`${input.groups.get(skuGroupId)?.title ?? skuGroupId}: минус-слова с заметными кликами — только вручную: ${manual.map((row) => `«${row.word}» (${row.clicks} кликов, ${row.impressions} показов)`).join(', ')} — покупатели считают запрос релевантным, автоблок отрезал бы целевой трафик`);
    const candidates = allCandidates.filter((row) => row.clicks < cfg.stopMinClicks);
    if (!candidates.length) continue;
    const room = Math.max(0, cfg.maxStopWords - Math.max(...keywords.map((keyword) => keyword.stopWords.length)));
    const picked = candidates.slice(0, Math.min(room, cfg.newStopWordsPerGroup));
    if (candidates.length > picked.length) notes.push(`${input.groups.get(skuGroupId)?.title ?? skuGroupId}: ещё ${candidates.length - picked.length} минус-слов не добавлено${room < candidates.length ? ` (лимит Uzum ${cfg.maxStopWords})` : ''}`);
    if (!picked.length) continue;
    const words = picked.map((row) => row.word);
    const why = `минус-слова ${picked.map((row) => `«${row.word}» (${row.impressions} показов, ${row.clicks} кликов, 0 продаж)`).join(', ')}; запросы вроде: ${picked[0].queries.join('; ')}`;
    for (const keyword of keywords) {
      if (actions.some((row) => row.kind === 'SUSPEND' && row.adId === keyword.adId)) continue;
      const stopWords = [...keyword.stopWords, ...words.filter((word) => !keyword.stopWords.map(normalizeQuery).includes(word))];
      const planned = actions.find((row) => row.adId === keyword.adId);
      if (planned) { planned.stopWords = stopWords; planned.addedStopWords = words; planned.reason += `; ${why}`; continue; }
      // Кулдаун распространяется и на чистые правки минус-слов: без него слово
      // редактировалось бы каждый день, и лимит изменений за прогон оставался
      // бы единственным тормозом.
      const last = input.lastChange.get(keyword.adId);
      if (last && input.now.getTime() - last.getTime() < cfg.cooldownDays * DAY_MS) continue;
      actions.push({
        kind: 'STOPWORDS', campaignId: keyword.campaignId, campaignName: keyword.campaignName, skuGroupId,
        groupTitle: input.groups.get(skuGroupId)?.title ?? skuGroupId, adId: keyword.adId, query: keyword.query,
        oldCpm: keyword.cpm, newCpm: keyword.cpm, stopWords, addedStopWords: words, reason: why,
      });
    }
    for (const row of actions) if (row.kind === 'ADD' && row.skuGroupId === skuGroupId) { row.stopWords = [...new Set([...row.stopWords, ...words])]; row.addedStopWords = words; }
  }
  const all = actions.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  const limit = Math.max(0, cfg.maxChangesPerRun);
  if (all.length > limit) notes.push(`изменений ${all.length}, за запуск делаем не больше ${limit} — остальные в следующий раз`);
  return { actions: all.slice(0, limit), deferred: all.slice(limit), notes };
}

/** Тело PUT для кампании: только изменения, бюджет/название/период — как есть. */
export function buildCampaignUpdate(campaign: { name: string; budgetConfig: any; period: any }, actions: AdBotAction[], budget?: { weeklyAmount?: number; uniform?: boolean }) {
  return {
    advertisements: actions.map((row) => {
      if (row.kind === 'ADD') return { action: 'NEW', advertisement: { cpm: row.newCpm, promotionType: 'QUERY', query: row.query, skuGroupId: Number(row.skuGroupId), stopWords: row.stopWords } };
      if (row.kind === 'SUSPEND') return { action: 'SUSPEND', advertisement: { id: Number(row.adId), cpm: row.oldCpm, promotionType: 'QUERY', query: row.query, skuGroupId: Number(row.skuGroupId), stopWords: row.stopWords } };
      return { action: 'EDIT', advertisement: { id: Number(row.adId), cpm: row.newCpm, promotionType: 'QUERY', query: row.query, skuGroupId: Number(row.skuGroupId), stopWords: row.stopWords } };
    }),
    budgetConfig: {
      reset: false,
      uniformDistribution: budget?.uniform ?? Boolean(campaign.budgetConfig?.uniformDistribution),
      weeklyAmount: budget?.weeklyAmount ?? (Number(campaign.budgetConfig?.weeklyAmount) || 0),
    },
    name: campaign.name,
    period: { dateFrom: campaign.period?.dateFrom ?? '', dateTo: campaign.period?.dateTo ?? '', isEndless: Boolean(campaign.period?.isEndless) },
  };
}

export type SeedPhrase = { query: string; cpm: number };
/** Правка минус-слов существующих фраз кампании: убрать remove, добавить add; если список упёрся в 58 —
 * сначала выбросить dropIfFull (бесполезные слова), что не влезло — не добавлять. onlyLatin — только узбекские фразы. */
export type SeedStopWords = { add?: string[]; remove?: string[]; dropIfFull?: string[]; onlyLatin?: boolean };
/** campaignId «*» — все активные кампании (только для stopWords и suspend). suspend — остановить фразы по точному
 * совпадению; suspendGroups — остановить все фразы цветов (по id группы); budgetWeekly / uniform — бюджет кампании. */
export type SeedSpec = {
  campaignId: string;
  phrases?: SeedPhrase[];
  stopWords?: SeedStopWords;
  suspend?: string[];
  suspendGroups?: string[];
  budgetWeekly?: number;
  uniform?: boolean;
};

function mergeStopWords(current: string[], rule: SeedStopWords, limit: number): string[] | null {
  const norm = (word: string) => normalizeQuery(word);
  const removeSet = new Set((rule.remove ?? []).map(norm));
  let next = current.filter((word) => !removeSet.has(norm(word)));
  const have = new Set(next.map(norm));
  const toAdd = (rule.add ?? []).filter((word) => norm(word) && !have.has(norm(word)));
  const drop = [...(rule.dropIfFull ?? [])].map(norm);
  for (const word of toAdd) {
    while (next.length >= limit && drop.length) {
      const victim = drop.shift() as string;
      next = next.filter((row) => norm(row) !== victim);
    }
    if (next.length >= limit) break;
    next.push(word);
  }
  const same = next.length === current.length && next.every((word, index) => word === current[index]);
  return same ? null : next;
}

/**
 * Ручной посев фраз (scripts/seed-keywords.ts): в каждый цвет кампании добавить фразы, которых там нет,
 * а существующим с другой ставкой — поставить заданную. Правила бота здесь не применяются.
 * Новым узбекским (латиница) фразам минус-слово «soch» заменяется на «soch uchun» / «sochlar uchun»:
 * как Uzum сравнивает минус-слова — целиком или по части — неизвестно, и «soch» мог бы перекрыть «sochiq».
 */
export function seedKeywordActions(keywords: AdBotKeyword[], specs: SeedSpec[], cfg: AdBotConfig = AD_BOT_DEFAULTS): AdBotAction[] {
  const actions: AdBotAction[] = [];
  for (const spec of specs) {
    const own = spec.campaignId === '*' ? keywords : keywords.filter((row) => row.campaignId === spec.campaignId);
    if (spec.suspend?.length || spec.suspendGroups?.length) {
      const targets = new Set((spec.suspend ?? []).map(normalizeQuery));
      const groups = new Set(spec.suspendGroups ?? []);
      for (const row of own) {
        const byQuery = targets.has(normalizeQuery(row.query));
        const byGroup = groups.has(row.skuGroupId);
        if (!byQuery && !byGroup) continue;
        actions.push({ kind: 'SUSPEND', campaignId: row.campaignId, campaignName: row.campaignName, skuGroupId: row.skuGroupId, groupTitle: row.skuGroupId, adId: row.adId, query: row.query, oldCpm: row.cpm, newCpm: row.cpm, stopWords: row.stopWords, reason: byGroup ? 'ручная остановка цвета: нет остатка до дозаказа' : 'ручная остановка: запрос не про товар' });
      }
    }
    const suspended = new Set(spec.suspendGroups ?? []);
    if (spec.campaignId === '*') { if (!spec.stopWords) continue; }
    if (spec.stopWords) {
      for (const row of own) {
        if (suspended.has(row.skuGroupId)) continue;
        if (spec.stopWords.onlyLatin && !isLatinQuery(normalizeQuery(row.query))) continue;
        const merged = mergeStopWords(row.stopWords, spec.stopWords, cfg.maxStopWords);
        if (!merged) continue;
        const delta = `${merged.length - row.stopWords.length >= 0 ? '+' : ''}${merged.length - row.stopWords.length}`;
        actions.push({ kind: 'STOPWORDS', campaignId: row.campaignId, campaignName: row.campaignName, skuGroupId: row.skuGroupId, groupTitle: row.skuGroupId, adId: row.adId, query: row.query, oldCpm: row.cpm, newCpm: row.cpm, stopWords: merged, reason: `ручная правка минус-слов (${row.stopWords.length} → ${merged.length}, ${delta})` });
      }
    }
    if (spec.campaignId === '*') continue;
    for (const skuGroupId of [...new Set(own.map((row) => row.skuGroupId))]) {
      if (suspended.has(skuGroupId)) continue;
      const inGroup = own.filter((row) => row.skuGroupId === skuGroupId);
      const baseStop = inGroup[0].stopWords;
      const common = { campaignId: spec.campaignId, campaignName: inGroup[0].campaignName, skuGroupId, groupTitle: skuGroupId };
      for (const phrase of spec.phrases ?? []) {
        const query = normalizeQuery(phrase.query);
        if (!query) continue;
        const cpm = clampBid(phrase.cpm, 'down', cfg);
        const existing = inGroup.find((row) => normalizeQuery(row.query) === query);
        if (existing) {
          if (existing.cpm === cpm) continue;
          actions.push({ ...common, kind: existing.cpm > cpm ? 'LOWER' : 'RAISE', adId: existing.adId, query: existing.query, oldCpm: existing.cpm, newCpm: cpm, stopWords: existing.stopWords, reason: `ручная ставка ${fmt(cpm)} (было ${fmt(existing.cpm)})` });
          continue;
        }
        let stopWords = baseStop;
        if (isLatinQuery(query) && baseStop.some((word) => normalizeQuery(word) === 'soch')) {
          stopWords = [...baseStop.filter((word) => normalizeQuery(word) !== 'soch'), 'soch uchun', 'sochlar uchun'].slice(0, cfg.maxStopWords);
        }
        actions.push({ ...common, kind: 'ADD', adId: null, query: phrase.query.trim(), oldCpm: null, newCpm: cpm, stopWords, reason: 'ручной посев фразы' });
      }
    }
  }
  // Одно объявление — одна правка в PUT: ставку и минус-слова по одному adId сливаем.
  const merged: AdBotAction[] = [];
  const byAd = new Map<string, AdBotAction>();
  for (const row of actions) {
    if (!row.adId) { merged.push(row); continue; }
    const prev = byAd.get(row.adId);
    if (!prev) { byAd.set(row.adId, row); merged.push(row); continue; }
    const cpmChange = [prev, row].find((item) => item.kind === 'LOWER' || item.kind === 'RAISE' || item.kind === 'SUSPEND');
    const words = [prev, row].find((item) => item.kind === 'STOPWORDS');
    Object.assign(prev, {
      kind: cpmChange?.kind ?? prev.kind,
      newCpm: cpmChange?.newCpm ?? prev.newCpm,
      stopWords: words?.stopWords ?? prev.stopWords,
      reason: `${prev.reason}; ${row.reason}`,
    });
  }
  return merged;
}

export const AD_BOT_LABELS: Record<AdBotActionKind, string> = { LOWER: '⬇️ снизить', SUSPEND: '⛔ остановить', STOPWORDS: '🚫 минус-слова', ADD: '➕ новое слово', RAISE: '⬆️ поднять' };

export type AdBotOutcome = { action: AdBotAction; ok: boolean; message: string };

/** Отчёт в Telegram: что сделано (или предложено) по кампаниям, кусками до 3900 символов. */
export function formatAdBotReport(input: { label: string; apply: boolean; plan: AdBotPlan; outcomes: AdBotOutcome[]; notes: string[]; keywordsCount: number }): string[] {
  const head = `🤖 Рекламный бот, ${input.label} — ${input.apply ? 'ставки меняются' : 'только предложения, ничего не меняется'}\nСлов в кампаниях: ${input.keywordsCount}; изменений: ${input.plan.actions.length}${input.plan.deferred.length ? `, отложено ${input.plan.deferred.length}` : ''}`;
  const lines: string[] = [];
  for (const note of [...input.notes, ...input.plan.notes]) lines.push(`⚠️ ${note}`);
  const outcome = new Map(input.outcomes.map((row) => [row.action, row]));
  let campaign = '';
  for (const row of input.plan.actions) {
    if (row.campaignName !== campaign) { campaign = row.campaignName; lines.push('', `📣 ${campaign}`); }
    const bid = row.kind === 'ADD' ? `ставка ${fmt(row.newCpm)}` : row.kind === 'SUSPEND' ? `ставка была ${fmt(row.oldCpm ?? 0)}` : row.kind === 'STOPWORDS' ? `+ ${row.addedStopWords?.join(', ')}` : `${fmt(row.oldCpm ?? 0)} → ${fmt(row.newCpm)}`;
    const done = outcome.get(row);
    lines.push(`${AD_BOT_LABELS[row.kind]} «${row.query}» — ${row.groupTitle}: ${bid}${done ? (done.ok ? ' ✅' : ` ❌ ${done.message}`) : ''}`);
    lines.push(`   ${row.reason}`);
  }
  if (!input.plan.actions.length) lines.push('', 'Менять нечего: ставки в норме.');
  const chunks: string[] = [];
  let current = head;
  for (const line of lines) {
    if (current.length + line.length + 1 > 3900) { chunks.push(current); current = line; } else current += `\n${line}`;
  }
  chunks.push(current);
  return chunks;
}
