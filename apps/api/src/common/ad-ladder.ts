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
 *   5. Цвет без нужного запросу размера в наличии (colourStockBlock) боевым не бывает, его ставка — на минимум;
 *      место в топ-10 занимает следующий по цене цвет, с поставкой цвет возвращается сам.
 *   6. Узкие ключи товара (AD_LADDER_NARROW, с 04.11.2026) вместо класса по словам: один цвет в топ-10 до потолка карточки,
 *      свой потолок ДРР карточки и стоп после 25 000 за 7 дней без продаж.
 *
 * Модуль чистый — без сети и БД. Сервис: modules/ads/ad-ladder.service.ts.
 */
import { AdBotAction, AdBotKeyword, AdBotStats, normalizeQuery } from './ad-bot';
import { BidLadderStep, bidForPosition, bidForReach, policyKey, positionForBid } from './auto-bidder';

/** Кампании полотенец (HAVANA, j471, J403, «Банное 100×150» 332097 — сауна 2263224, с 17.10.2026) — по умолчанию; AD_LADDER_CAMPAIGNS переопределяет
 * списком id через запятую. Неактивная (на паузе) кампания пропускается с пометкой в отчёте. */
export const AD_LADDER_DEFAULT_CAMPAIGNS = ['286528', '305122', '305324', '332097', '337334', '305326'];
// 305326 «YD» — плед 2880108, с 04.11.2026 (узкие ключи пледа, AD_LADDER_NARROW).

/**
 * Запуск новинки: до указанного дня (включительно, Ташкент) проверка ДРР кампании не действует — у товара без
 * отзывов первые продажи дорогие, и потолок 6 % задушил бы его в первые дни. Топ-10 и потолки ставок работают как обычно.
 * 337334 — «Сердечки 3480224 новинка» (жаккард с сердечками), создана 18.10.2026, льгота 14 дней.
 */
export const AD_LADDER_LAUNCH_UNTIL: Record<string, string> = {};
// 02.11.2026 льгота Сердечек продлевалась до 16.11 («нужно 250 продаж»). 04.11.2026 снята вместе с тестами потолков 70 000
// (владелец: «лишь бы не просрать деньги»): за 7 дней 41 836 рекламы при ДРР 53 %, «sochiq yuz va hammom» и
// «sochiqlar hammom yuz va» за 14 дней 58 000 без продаж. Сердечки теперь под общими правилами и узкими ключами (AD_LADDER_NARROW).
/**
 * Кампании, где каждый активный цвет держим в топ-10 по каждой фразе — потолок класса не действует, только общий потолок
 * ставки maxBid (AD_BOT_MAX_BID). Значение — сколько цветов держать. 337334 «Сердечки»: владелец 18.10.2026 — «рекламируй
 * только 2 цвета и нужно держать их в топ-10» (розовый 6472969 и голубой 6472965, остальные цвета остановлены посевом).
 */
export const AD_LADDER_HOLD_TOP: Record<string, number> = {};
// 337334 «Сердечки» держали в топ-10 до потолка с 18.10 по 02.11.2026: за 31.10–02.11 ставки ушли к 70 000 на «полотенце детское»,
// «для лица», «для рук» и покупали 13–23 места без продаж (владелец 02.11: снять режим, вернуть классовые потолки).

/**
 * Тест потолка (до until включительно, Ташкент): цвет держим в топ-10 по запросу до cap, пока его ДРР за 7 дней ≤ maxDrr —
 * выше ставка уходит ниже топ-10, после until действует обычный потолок класса. Владелец 27.10.2026 («го делай»): j471 на
 * sochiq стоял 16-м при потолке 25 000 и всё равно продавал — небесно-голубой 10 продаж за 19–25.10 при ДРР 4,8 %, на
 * sochiqlar серый — 4 продажи при 6 %; неделю пробуем топ-10 до 35 000, стоп при ДРР выше 8 %.
 */
export type LadderCapTest = { campaignId: string; skuGroupId: string; query: string; cap: number; maxDrr: number; until: string };
// Тесты потолков Сердечек (HEARTS_PUSH_QUERIES: 11 фраз × 2 цвета до 70 000, ДРР до 30 %, 02–16.11.2026) сняты 04.11.2026
// («лишь бы не просрать деньги»): за 7 дней ДРР 53 %, две узбекские фразы «для лица и тела» — 58 000 без продаж.
export const AD_LADDER_CAP_TESTS: LadderCapTest[] = [
  { campaignId: '305122', skuGroupId: '5374111', query: 'sochiq', cap: 35_000, maxDrr: 8, until: '2026-11-03' },
  { campaignId: '305122', skuGroupId: '5374108', query: 'sochiqlar', cap: 35_000, maxDrr: 8, until: '2026-11-03' },
  // Владелец 04.11.2026 («Да, подними»): у серого j471 кончились 70×135, стоп-правило остатков сняло его с «полотенце банное»
  // (49 000 → 9 500), а 03.11 его объявление там дало 18 кликов и 3 продажи — покупатели брали голубое банное. Топ-10 голубого
  // стоит больше потолка банных 60 000, и j471 выпал из топ-10 запроса. Неделю держим голубой до 65 000, стоп при ДРР выше 8 %.
  { campaignId: '305122', skuGroupId: '5374111', query: 'полотенце банное', cap: 65_000, maxDrr: 8, until: '2026-11-11' },
];

/**
 * Узкие ключи товара (владелец 04.11.2026: «для каждого товара есть своё уникальное ключевое слово… нужно, чтобы оно было
 * недорогим… хочу быть в топ-10 по всем самым популярным узким ключевым словам»; «лишь бы не просрать деньги»). Списки собраны
 * из спроса ZoomSelling 03.11, продающих запросов покупателей (куб AdvertisingFeedDailyFunnel, 60 дней) и цены мест по лестнице
 * кабинета 04.11 — `Uzum/Узкие_ключи_и_минус_слова_2026-11-04.md`. Узкий запрос — про размер, назначение, материал или аудиторию
 * товара; у многих топ-10 стоит минимальную ставку (никто не торгуется), средний чек выше широких (HAVANA «набор полотенец
 * махровые банное» — 127 тыс. против 70 тыс. по «sochiqlar»).
 * На узкой фразе один цвет держим в топ-10 до cap; ДРР за 7 дней — свой потолок карточки, около трети маржи до рекламы
 * (HAVANA 28 %, J471 32 %, J403 40 %, сауна и плед 27 %, Сердечки 38 %); 25 000 за 7 дней без продаж — ставка на минимум.
 * Узкая фраза, у которой топ-10 дороже cap, в топ не идёт — отчёт показывает её в «дороже потолка».
 */
export type LadderNarrow = { cap: number; maxDrr: number; queries: string[] };
export const AD_LADDER_NARROW_NO_SALE_SPEND = 25_000;
export const AD_LADDER_NARROW: Record<string, LadderNarrow> = {
  // Сауна 100×150 (2263224): размер, баня/сауна/бассейн/пляж; дороже 45 000 («полотенце банное большое» 66 тыс., «banya sochiq» 60 тыс.) — ниже топа.
  // 07.11.2026: «sauna», «сауна», «для бани», «banya uchun» сняты — за 05–06.11 482 показа и 8 300 без корзин: покупатели искали
  // костюмы для сауны, термометры, мыло и веники; фразы без слова «полотенце/sochiq» ловят чужой спрос.
  '332097': { cap: 45_000, maxDrr: 9, queries: ['банное полотенце большое', 'sauna sochiq', 'полотенце 100х150', 'sochiq 100x150', 'katta sochiqlar', 'katta sochiq', 'sochiq katta', 'katta hammom sochiq', 'bani sochiq katta', 'katta bani sochiqlar', 'basseyn sochiq', 'полотенце для бассейна', 'полотенце для бани', 'полотенца для сауны', 'полотенце для сауны', 'большое полотенце', 'полотенце большое', 'полотенце банное евро', 'plyaj sochiq', 'пляжное полотенце', 'полотенце пляжное'] },
  // Плед-полотенце 100×170 (2880108): махровый хлопковый, пляж/дача/кафе; «плед», «pled», «плед для пикника» — не узкие (0 корзин).
  '305326': { cap: 30_000, maxDrr: 9, queries: ['махровый плед', 'плед махровый', 'плед хлопковый', 'хлопковый плед', 'плед полотенце', 'плед кафе', 'дорожный плед', 'пляжное полотенце', 'полотенце пляжное', 'plyaj sochiq', 'плед с бахромой', 'летний плед', 'плед летний', 'плед для дачи', 'плед в полоску', 'полосатый плед', 'yozgi pled', 'плед на кресло', 'плед 100х170'] },
  // Сердечки (3480224): рисунок, дети, подарок, для рук.
  '337334': { cap: 25_000, maxDrr: 12, queries: ['полотенце с сердечками', 'yurakchali sochiq', 'детское полотенце', "bolalar sochig'i", 'детское полотенце для лица', 'полотенце детское для рук', 'полотенце для девочек', 'полотенце для девочки', 'sochiq yuz uchun', 'yuz uchun sochiq', 'полотенце махровое жаккард', 'qol sochiqlar', "qo'l sochiq", 'полотенце розовое', 'махровые полотенца для рук'] },
  // HAVANA (2197711): плотное 600 г, мужское, наборы, размеры 70×140 / 50×90.
  '286528': { cap: 30_000, maxDrr: 9, queries: ['набор полотенец махровые банное', 'полотенце банное мужское', 'erkaklar sochiq', 'sochiq erkaklar uchun', 'sochiq erkaklar', 'sochiq erkak', 'мужское полотенце', 'полотенце банное махровое', 'полотенце 70х140', 'полотенце махровое 70х140', 'полотенце 50х90', 'полотенце банное 70х140', 'qalin sochiq', 'полотенце плотное', 'толстое полотенце', 'махровые полотенца', 'полотенце банное черное', 'полотенце банное 600 г'] },
  // J471 (2898275): мягкое, для лица и тела, душ, голубой цвет, 70×135.
  '305122': { cap: 30_000, maxDrr: 10, queries: ['полотенце для лица и тела', 'набор полотенец махровые', 'sochiq yuz', 'yumshoq sochiq', 'momiq sochiq', 'мягкое полотенце', 'dush uchun sochiq', 'dush sochiq', 'голубое полотенце', 'полотенце банное голубое', 'полотенце 70х135', 'полотенце банное 70х135', 'полотенца махровые пушистые мягкие', 'полотенце махровое', 'махровое полотенце', 'махровая полотенце', 'sochiq mini'] },
  // J403 (2872482): белое/серое, с бордюром, для бассейна и ног.
  '305324': { cap: 30_000, maxDrr: 13, queries: ['banni sochiqlar', 'oq sochiq', 'белое банное полотенце', 'белые банные полотенца', 'белое полотенце', 'полотенце для бассейна', 'полотенце для ног', 'полотенца для ног', 'махровое полотенце банное', 'серое полотенце', 'полотенце банное серое', 'полотенце с бордюром', 'полотенце 70х140 хлопок', 'полотенце банное хлопок', 'полотенца банное', 'полотенца отдельные'] },
};

/** Класс «узкие ключи товара» для фразы кампании; null — фраза не узкая (действуют классы по словам). */
export function narrowClass(campaignId: string, query: string, table: Record<string, LadderNarrow> = AD_LADDER_NARROW): LadderQueryClass | null {
  const row = table[campaignId];
  const q = normalizeQuery(query);
  if (!row || !row.queries.some((item) => normalizeQuery(item) === q)) return null;
  return { name: 'узкие ключи товара', match: () => true, cap: row.cap, colors: 1, maxDrr: row.maxDrr, noSaleSpend: AD_LADDER_NARROW_NO_SALE_SPEND };
}

export function activeCapTests(today: string, table: LadderCapTest[] = AD_LADDER_CAP_TESTS): LadderCapTest[] {
  return table.filter((row) => today <= row.until);
}

/**
 * Акцент (до until включительно, Ташкент): у фраз кампании потолок ДРР не ниже maxDrr — лестница держит их в топ-10 там,
 * где обычный потолок класса или узких ключей снял бы. query — только фразы, подходящие под regexp; нет — все фразы кампании.
 * Владелец 09.11.2026 («нужно как можно больше сделать акцент на Сердечках и 100×150»): ходовые размеры до поставки 22.11
 * почти кончились, остаток — Сердечки (237 шт) и 100×150 (183 шт; цены сауны и J403 снижены до 159 000, J471 — до 139 000).
 * До конца акции #444 (03.12) — Сердечки целиком, сауна целиком и фразы про 100×150 у J471 и J403.
 */
export type LadderFocus = { campaignId: string; query?: RegExp; maxDrr: number; until: string; note: string };
export const BIG_SIZE_QUERY = /(саун|бан[яи]|бассейн|sauna|basseyn|banya|katta|100 ?[xх]? ?150|больш)/;
export const AD_LADDER_FOCUS: LadderFocus[] = [
  { campaignId: '337334', maxDrr: 15, until: '2026-12-03', note: 'Сердечки' },
  { campaignId: '332097', maxDrr: 15, until: '2026-12-03', note: 'сауна 100×150' },
  { campaignId: '305122', query: BIG_SIZE_QUERY, maxDrr: 15, until: '2026-12-03', note: 'J471 100×150' },
  { campaignId: '305324', query: BIG_SIZE_QUERY, maxDrr: 15, until: '2026-12-03', note: 'J403 100×150' },
];

export function activeFocus(today: string, table: LadderFocus[] = AD_LADDER_FOCUS): LadderFocus[] {
  return table.filter((row) => today <= row.until);
}

/** Потолок ДРР акцента для фразы кампании; null — фраза не в акценте. */
export function focusDrr(campaignId: string, query: string, focus: LadderFocus[]): number | null {
  const q = normalizeQuery(query);
  const hits = focus.filter((row) => row.campaignId === campaignId && (!row.query || row.query.test(q)));
  return hits.length ? Math.max(...hits.map((row) => row.maxDrr)) : null;
}

export function launchCampaigns(today: string, table: Record<string, string> = AD_LADDER_LAUNCH_UNTIL): Set<string> {
  return new Set(Object.entries(table).filter(([, until]) => today <= until).map(([id]) => id));
}

export function ladderCampaigns(): string[] {
  const raw = String(process.env.AD_LADDER_CAMPAIGNS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  return raw.length ? raw : AD_LADDER_DEFAULT_CAMPAIGNS;
}
export const ladderEnabled = () => process.env.AD_LADDER_ENABLED !== 'false';

/** maxDrr — потолок ДРР класса, %; нет — общий maxDrrPercent. noSaleSpend — расход за 7 дней без продаж, после которого
 * ставка на минимум; нет — общий noSaleSpend. */
export type LadderQueryClass = { name: string; match: (query: string) => boolean; cap: number; colors: number; maxDrr?: number; noSaleSpend?: number };

export const AD_LADDER_DEFAULTS = {
  topPosition: 10,
  /** Запас сверх цены ступени: лестница за день сдвигается. */
  marginPercent: 3,
  rounding: 500,
  minBid: 9_500,
  /** Цвет, у которого нужного запросу размера меньше стольких штук, в топ-10 не держим и ставим минимальную ставку
   * (colourStockBlock). Владелец 09.11.2026: до поставки 22.11 ходовые размеры почти кончились — реклама на последние
   * 1–4 штуки только торопит их и тратит деньги, которые нужны Сердечкам и 100×150. AD_LADDER_MIN_STOCK переопределяет. */
  minStock: 5,
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

export type LadderSizeKind = 'set' | 'big' | 'bath' | 'face' | 'hand';

/** Размер SKU по названию в кабинете (getProducts skuTitle): «БЕЛЫЙ-Банный», «СЕРЫЙ-70 x140», «КРЕМОВ-лицево», «РОЗОВ-Микс»,
 * «БЕЖЕВ-Havana» (набор HAVANA), «ГОЛУБ-салфетк» (30×50 ×4 Сердечек), плед «beach» / «hand». null — размера в названии нет:
 * у карточки сауны 2263224 у цвета один SKU «БЕЛЫЙ». */
export function skuSizeKind(title: string): LadderSizeKind | null {
  const t = title.toLowerCase();
  if (/(микс|mix|комплек|набор|havana)/.test(t)) return 'set';
  if (/(саун|100 ?[xх]? ?150|beach)/.test(t)) return 'big';
  if (/(банн|70 ?[xх] ?1[34])/.test(t)) return 'bath';
  if (/(лицев|50 ?[xх] ?(90|85))/.test(t)) return 'face';
  if (/(салфет|hand|30 ?[xх] ?50)/.test(t)) return 'hand';
  return null;
}

/** Какой размер нужен покупателю запроса — первое совпадение; запрос без размера («полотенце», «sochiq») — ничего. */
const SIZE_NEEDS: Array<{ match: RegExp; kinds: LadderSizeKind[]; label: string }> = [
  { match: /(набор|комплект|to ?plam|nabor|komplekt)/, kinds: ['set'], label: 'наборов' },
  { match: BIG_SIZE_QUERY, kinds: ['big'], label: '100×150' },
  { match: /(банн|тел[ао]|hammom|banyo|banni|badan|ванн|vanna|dush|душ)/, kinds: ['bath'], label: 'банного' },
  { match: /(для рук|qo ?l|салфет)/, kinds: ['hand', 'face'], label: 'для рук' },
  { match: /(лиц|yuz)/, kinds: ['face'], label: 'лицевого' },
];

/**
 * Почему цвет нельзя держать в топ-10 по остатку (null — можно). 03.11.2026: у белого J403 кончились 70×140 (28.10) и наборы
 * (31.10), а лестница держала его в топ-10 «полотенце банное» до 60 000 — 02.11 кампания потратила 27 484 без продаж, покупатель
 * открывал белый и видел только лицевое. Нет остатка цвета вовсе — блок на любом запросе; нет размера запроса — блок на его
 * запросах. Если размера у цвета не было никогда (у HAVANA нет 100×150), фраза выбрана сознательно — не блокируем.
 * minStock — с 09.11.2026 блокируем и когда штук меньше порога (AD_LADDER_DEFAULTS.minStock): последние 1–4 штуки реклама
 * не продаёт дороже, а только раньше выводит в ноль.
 */
export function colourStockBlock(query: string, skus: Array<{ title: string; quantity: number }> | null | undefined, minStock = 1): string | null {
  if (!skus?.length) return null;
  const min = Math.max(1, minStock);
  const stock = (rows: Array<{ quantity: number }>) => rows.reduce((sum, row) => sum + Math.max(0, row.quantity), 0);
  const total = stock(skus);
  if (total <= 0) return 'у цвета нет остатка';
  if (total < min) return `у цвета осталось ${total} шт`;
  const q = normalizeQuery(query);
  const need = SIZE_NEEDS.find((row) => row.match.test(q));
  if (!need) return null;
  const relevant = skus.filter((row) => { const kind = skuSizeKind(row.title); return kind === null || need.kinds.includes(kind); });
  if (!relevant.length) return null;
  const left = stock(relevant);
  if (left <= 0) return `у цвета нет ${need.label} в наличии`;
  return left < min ? `у цвета ${need.label} осталось ${left} шт` : null;
}

/** skus — SKU цвета с остатком (AdBotService.colourSkus); нет — остаток не проверяется. */
export type LadderKeyword = AdBotKeyword & { ladder: BidLadderStep[] | null; stats7?: AdBotStats | null; skus?: Array<{ title: string; quantity: number }> | null };
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
  /** Нет нужного размера цвета в наличии (colourStockBlock) — ставка на минимум. */
  noStock: string | null;
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

/** Статистика запроса целиком — сумма по цветам; null — ни у одного цвета данных нет. */
export function sumLadderStats(rows: Array<AdBotStats | null | undefined>): AdBotStats | null {
  const present = rows.filter((row): row is AdBotStats => Boolean(row));
  if (!present.length) return null;
  return present.reduce((total, row) => ({ impressions: total.impressions + row.impressions, clicks: total.clicks + row.clicks, sold: total.sold + row.sold, revenue: total.revenue + row.revenue, spend: total.spend + row.spend, position: null }), { impressions: 0, clicks: 0, sold: 0, revenue: 0, spend: 0, position: null } as AdBotStats);
}

/** Цвет сам доказал окупаемость: есть продажи с рекламы и его ДРР не выше потолка. */
const provenColour = (stats: AdBotStats | null | undefined, maxDrr: number) => Boolean(stats && stats.sold > 0 && stats.revenue > 0 && (stats.spend / stats.revenue) * 100 <= maxDrr);

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
 * launch — кампании на льготе запуска (ДРР не проверяется); tests — действующие тесты потолка (activeCapTests).
 *
 * ДРР судим и по цвету, и по запросу целиком: 19–25.10.2026 HAVANA «банное полотенце» потратила 65 600 при ДРР 10 %,
 * но расход разошёлся на четыре цвета, ни один не набрал порога данных (30 000), и проверка цвета молчала. Если запрос
 * в целом выше потолка, в топ-10 остаются только цвета, которые сами окупаются (есть продажи и их ДРР в пределах);
 * при ДРР запроса выше вдвое или расходе без продаж остальным — минимальная ставка. */
export function planLadderBids(keywords: LadderKeyword[], cfg: AdLadderConfig = AD_LADDER_DEFAULTS, recent: Set<string> = new Set(), launch: Set<string> = new Set(), hold: Record<string, number> = AD_LADDER_HOLD_TOP, tests: LadderCapTest[] = [], narrow: Record<string, LadderNarrow> = AD_LADDER_NARROW, focus: LadderFocus[] = []): LadderDecision[] {
  const decisions: LadderDecision[] = [];
  const byQuery = new Map<string, LadderKeyword[]>();
  for (const keyword of keywords) {
    const key = `${keyword.campaignId}|${normalizeQuery(keyword.query)}`;
    byQuery.set(key, [...(byQuery.get(key) ?? []), keyword]);
  }
  const none = { drr: null, blocked: null, severe: false };
  for (const rows of byQuery.values()) {
    const base = narrowClass(rows[0].campaignId, rows[0].query, narrow) ?? ladderQueryClass(rows[0].query, cfg);
    const held = hold[rows[0].campaignId];
    const cls = held ? { ...base, name: `${base.name}, держим в топ-10`, cap: cfg.maxBid, colors: held } : base;
    const exempt = launch.has(rows[0].campaignId);
    // Акцент (activeFocus) поднимает потолок ДРР фраз до своего, но не опускает, если у класса он и так выше.
    const focused = focusDrr(rows[0].campaignId, rows[0].query, focus);
    const classDrr = Math.max(cls.maxDrr ?? cfg.maxDrrPercent, focused ?? 0);
    const judge = cls.noSaleSpend ? { ...cfg, noSaleSpend: cls.noSaleSpend } : cfg;
    const queryVerdict = exempt || rows.length < 2 ? none : ladderDrrVerdict(sumLadderStats(rows.map((row) => row.stats7)), classDrr, judge);
    const priced = rows
      .map((keyword) => {
        const steps = keyword.ladder ?? [];
        const top10 = steps.length ? bidForPosition(steps, cfg.topPosition) : null;
        const target = top10 ? Math.min(cfg.maxBid, Math.max(cfg.minBid, roundUp(top10.cpm * (1 + cfg.marginPercent / 100), cfg.rounding))) : null;
        const test = tests.find((row) => row.campaignId === keyword.campaignId && row.skuGroupId === keyword.skuGroupId && normalizeQuery(row.query) === normalizeQuery(keyword.query));
        const maxDrr = test?.maxDrr ?? classDrr;
        let verdict: { drr: number | null; blocked: string | null; severe: boolean } = exempt ? none : ladderDrrVerdict(keyword.stats7, maxDrr, judge);
        if (!verdict.blocked && queryVerdict.blocked && !provenColour(keyword.stats7, maxDrr)) {
          verdict = { drr: verdict.drr, blocked: `по запросу (все цвета) ${queryVerdict.blocked}`, severe: queryVerdict.severe };
        }
        return { keyword, steps, top10, full: steps.length ? bidForReach(steps, 100) : null, target, verdict, test, noStock: colourStockBlock(keyword.query, keyword.skus, cfg.minStock) };
      })
      .sort((a, b) => (a.top10?.cpm ?? Infinity) - (b.top10?.cpm ?? Infinity));
    let chosen = 0;
    for (const row of priced) {
      const { keyword, steps, top10, full, target, verdict, test, noStock } = row;
      const base = { keyword, top10, full, positionBefore: steps.length ? positionForBid(steps, keyword.cpm) : null, drr: verdict.drr, blocked: verdict.blocked, noStock };
      if (!top10 || target === null) {
        decisions.push({ ...base, role: 'no-ladder', target: null, positionAfter: base.positionBefore, action: null });
        continue;
      }
      // Цвет на тесте потолка держим в топ-10 до своего потолка, не считаясь с числом цветов класса.
      // Боевой — только если сама цена топ-10 не дороже потолка: иначе ставка упиралась бы в потолок и покупала 13–27 место
      // (Сердечки 31.10–02.11: 70 000 за «полотенце для рук» при топ-10 от 131 000). Запас 3 % потолком обрезать можно.
      const isTop = !noStock && !verdict.blocked && (test ? top10.cpm <= test.cap : top10.cpm <= cls.cap && (chosen < cls.colors || top10.cpm <= cfg.cheapTop));
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
          reason = `лестница: топ-10 (${test ? `тест потолка ${fmt(test.cap)} до ${test.until}, стоп при ДРР > ${test.maxDrr} %` : cls.name}) стоит ${fmt(top10.cpm)}, позиция ${top10.position}; ${outOfTop ? 'ставка была ниже топ-10' : 'была переплата'}`;
        }
      } else if (noStock || verdict.severe) {
        // ДРР выше потолка вдвое или расход без продаж — слово не окупается: ставка на минимум (выключает только владелец).
        // Нет размера в наличии — клики пустые, снижаем и в паузу после правки: на минимуме объявление больше не дёргается.
        if (keyword.cpm > cfg.minBid && (noStock || !cooling)) {
          next = cfg.minBid;
          reason = `лестница: ${noStock ?? verdict.blocked} — ставка на минимум`;
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

/** Короткие имена кампаний для отчёта: в кабинете HAVANA называется «Обучение буст топ микс», сауна — «Банное 100×150: …». */
export const LADDER_CAMPAIGN_LABELS: Record<string, string> = { '286528': 'HAVANA', '305122': 'J471', '305324': 'J403', '332097': 'Сауна 100×150', '337334': 'Сердечки', '305326': 'Плед' };
export const campaignLabel = (id: string, name?: string | null) => LADDER_CAMPAIGN_LABELS[id] ?? name ?? id;

/** Цвет по SKU кабинета: «БЕЛЫЙ-Банный» → «белый», «НГОЛУБ-сауна» → «нголуб»; у сауны SKU без размера — «БЕЛЫЙ» → «белый». */
export function colourTitle(skus: Array<{ title: string }> | null | undefined): string | null {
  const title = skus?.find((row) => row.title)?.title?.trim();
  if (!title) return null;
  return (title.includes('-') ? title.replace(/-[^-]*$/, '') : title).toLowerCase() || null;
}

/** Сводка кампании для отчёта: расход и выручка с рекламы за 7 дней, расход с понедельника и недельный бюджет.
 * daysPassed — полных дней недели с данными: Cube публикует расход дня утром следующего, в понедельник их 0. */
export type LadderCampaignSummary = { name: string; spend7: number; revenue7: number; sold7: number; weekSpend: number; weeklyBudget: number | null; daysPassed: number };

const money = (value: number) => (value >= 1_000 ? `${Math.round(value / 1_000).toLocaleString('ru-RU')} тыс.` : `${Math.round(value).toLocaleString('ru-RU')} сум`);
const pct = (value: number) => `${value.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

export function formatCampaignSummary(row: LadderCampaignSummary): string {
  const drr = row.revenue7 > 0 ? `, ДРР ${pct((row.spend7 / row.revenue7) * 100)}` : row.spend7 > 0 ? ', продаж с рекламы нет' : '';
  let line = `${row.name} — ${money(row.spend7)}, ${row.sold7} прод.${drr}`;
  if (row.weeklyBudget) {
    if (row.weekSpend >= row.weeklyBudget) line += ' · ⚠ недельный бюджет кончился, показов до понедельника нет';
    else if (row.daysPassed > 0 && (row.weekSpend / row.daysPassed) * 7 > row.weeklyBudget) line += ` · ⚠ бюджет ${money(row.weeklyBudget)} кончится до воскресенья`;
  }
  return line;
}

const STOCK_SHORT: Record<string, string> = { наборов: 'наборы', '100×150': '100×150', банного: 'банное', 'для рук': 'для рук', лицевого: 'лицевое' };
const stockShort = (reason: string) => {
  const none = /нет (.+) в наличии$/.exec(reason);
  if (none) return STOCK_SHORT[none[1]] ?? none[1];
  const few = /у цвета (.+) осталось (\d+) шт$/.exec(reason);
  if (few) return `${STOCK_SHORT[few[1]] ?? few[1]} ${few[2]} шт`;
  const total = /у цвета осталось (\d+) шт$/.exec(reason);
  return total ? `всего ${total[1]} шт` : 'весь цвет';
};

/**
 * Отчёт владельцу в Telegram — раз в день и коротко (09.11.2026 владелец: «рекомендации пиздец длинные, я их не читаю»):
 * деньги по кампаниям, одна строка о работе лестницы и только то, что требует его действий — нет товара, бюджет, сбои.
 * Подробности (каждая правка, слова не в топе по ДРР, топ-10 дороже потолка) — formatLadderDetails, для ручного запуска.
 */
export function formatLadderReport(decisions: LadderDecision[], opts: { apply: boolean; failed?: number; titles?: Map<string, string>; notes?: string[]; campaigns?: LadderCampaignSummary[]; edits?: { count: number; hours: number }; minStock?: number }): string {
  const title = (id: string) => opts.titles?.get(id) ?? id;
  const campaigns = opts.campaigns ?? [];
  const spend = campaigns.reduce((sum, row) => sum + row.spend7, 0);
  const revenue = campaigns.reduce((sum, row) => sum + row.revenue7, 0);
  const sold = campaigns.reduce((sum, row) => sum + row.sold7, 0);
  const lines = [campaigns.length
    ? `📶 Реклама «Буст в ТОП» за 7 дней: ${money(spend)}, продаж ${sold}${revenue > 0 ? `, ДРР ${pct((spend / revenue) * 100)}` : ''}`
    : '📶 Реклама «Буст в ТОП»'];
  if (!opts.apply) lines.push('Режим предложений — ставки не менялись.');
  lines.push(...[...campaigns].sort((a, b) => b.spend7 - a.spend7).map(formatCampaignSummary));
  const tops = decisions.filter((row) => row.role === 'top');
  const inTop = tops.filter((row) => row.positionAfter !== null && row.positionAfter <= 10).length;
  const blocked = decisions.filter((row) => row.blocked).length;
  const edits = opts.edits ? `правок за ${opts.edits.hours === 24 ? 'сутки' : `${opts.edits.hours} ч`}: ${opts.edits.count}` : `правок сейчас: ${decisions.filter((row) => row.action).length}`;
  lines.push('', `Лестница: в топ-10 ${inTop} из ${tops.length} пар «цвет + запрос»${blocked ? `, по ДРР из топа сняты ${blocked}` : ''}; ${edits}.`);
  const empty = decisions.filter((row) => row.noStock);
  if (empty.length) {
    const byCampaign = new Map<string, Map<string, Set<string>>>();
    for (const row of empty) {
      const name = campaignLabel(row.keyword.campaignId, row.keyword.campaignName);
      const colours = byCampaign.get(name) ?? new Map<string, Set<string>>();
      colours.set(title(row.keyword.skuGroupId), (colours.get(title(row.keyword.skuGroupId)) ?? new Set<string>()).add(stockShort(String(row.noStock))));
      byCampaign.set(name, colours);
    }
    const parts = [...byCampaign].map(([name, colours]) => `${name}: ${[...colours].map(([colour, needs]) => `${colour} (${needs.has('весь цвет') ? 'весь цвет' : [...needs].join(', ')})`).join(', ')}`);
    lines.push(`⚠ Нет или меньше ${opts.minStock ?? AD_LADDER_DEFAULTS.minStock} шт, реклама на минимуме: ${parts.join('; ')}`);
  }
  if (opts.failed) lines.push(`⚠ Не прошло правок: ${opts.failed}`);
  for (const note of opts.notes ?? []) lines.push(`⚠ ${note}`);
  return lines.join('\n');
}

/** Подробный разбор прогона (ручной запуск scripts/ad-ladder.ts --details): каждая правка, слова не в топе по ДРР,
 * нет размера по фразам, запросы, где топ-10 дороже потолка, и служебные заметки (тесты потолка, льготы). */
export function formatLadderDetails(decisions: LadderDecision[], opts: { titles?: Map<string, string>; info?: string[] } = {}): string {
  const title = (id: string) => opts.titles?.get(id) ?? id;
  const lines: string[] = [];
  const blocked = decisions.filter((row) => row.blocked).sort((a, b) => (b.keyword.stats7?.spend ?? 0) - (a.keyword.stats7?.spend ?? 0));
  if (blocked.length) lines.push(`Не окупаются, из топ-10 убраны (${blocked.length}):`, ...blocked.map((row) => `  ${campaignLabel(row.keyword.campaignId, row.keyword.campaignName)} ${title(row.keyword.skuGroupId)} «${row.keyword.query}» — ${row.blocked}`));
  const empty = decisions.filter((row) => row.noStock);
  if (empty.length) {
    const byColour = new Map<string, string[]>();
    for (const row of empty) {
      const head = `${campaignLabel(row.keyword.campaignId, row.keyword.campaignName)}: ${title(row.keyword.skuGroupId)} — ${row.noStock}`;
      byColour.set(head, [...(byColour.get(head) ?? []), row.keyword.query]);
    }
    lines.push('', `Нет размера в наличии, ставка на минимум (${empty.length}):`, ...[...byColour].map(([head, queries]) => `  ${head}: ${queries.map((q) => `«${q}»`).join(', ')}`));
  }
  const byCampaign = new Map<string, LadderDecision[]>();
  for (const row of decisions.filter((item) => item.action)) {
    const name = campaignLabel(row.keyword.campaignId, row.keyword.campaignName);
    byCampaign.set(name, [...(byCampaign.get(name) ?? []), row]);
  }
  for (const [name, rows] of byCampaign) {
    lines.push('', `Правки «${name}»:`);
    for (const row of rows) {
      const a = row.action as AdBotAction;
      lines.push(`  ${a.kind === 'RAISE' ? '⬆️' : '⬇️'} ${title(a.skuGroupId)} «${a.query}» ${fmt(a.oldCpm ?? 0)} → ${fmt(a.newCpm)} (позиция ${row.positionBefore ?? '—'} → ${row.positionAfter ?? '—'})`);
    }
  }
  // Запрос, где ни один цвет не в топ-10 потому, что топ-10 дороже потолка (не по ДРР и не из-за остатка).
  const missing = decisions.filter((row) => row.role === 'other' && row.top10 && !row.noStock && !row.blocked)
    .filter((row) => !decisions.some((other) => other.role === 'top' && other.keyword.campaignId === row.keyword.campaignId && normalizeQuery(other.keyword.query) === normalizeQuery(row.keyword.query)));
  const queries = [...new Set(missing.map((row) => `«${row.keyword.query}» (топ-10 от ${fmt(Math.min(...missing.filter((m) => m.keyword.query === row.keyword.query).map((m) => m.top10?.cpm ?? Infinity)))})`))];
  if (queries.length) lines.push('', `Топ-10 дороже потолка, ни один цвет не в топе: ${queries.join(', ')}`);
  for (const note of opts.info ?? []) lines.push(`· ${note}`);
  return lines.join('\n');
}
