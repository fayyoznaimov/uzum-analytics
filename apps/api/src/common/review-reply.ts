/**
 * Ответы на отзывы: язык, пустые отзывы, проверка результата модели. Чистый модуль, без сети и БД.
 *
 * Почему это здесь (владелец 09.11.2026: «покупатель оставил 5 звёзд и ничего не написал, а бот пишет какую-то
 * хуйню, ещё и на узбекском»): модель сама выбирала язык по имени («Александр, рахмат!», «Дамир, рахмат! Хурсандмиз,
 * ёқди»), мешала кириллицу с латиницей («buғдan тер-тириқ олинг») и выдумывала подробности к пустому отзыву
 * («sauna uchun sochiqlarning qalin va yumshoq chiqqani…»). Теперь:
 *   1. язык решает код: узбекский — только если сам текст отзыва узбекский; пустой отзыв — русский;
 *   2. на пустой отзыв модель не зовём вовсе: короткая благодарность из банка формулировок, без выдумок;
 *   3. ответ модели на русском проверяется: узбекские слова или буквы — ответ отклоняется, уходит шаблон.
 */

export type ReviewReplyLanguage = 'ru' | 'uz';

export type ReviewForReply = {
  customerName?: string | null;
  anonymous?: boolean | null;
  content?: string | null;
  pros?: string | null;
  cons?: string | null;
  productTitle?: string | null;
  skuTitle?: string | null;
};

/** Текст отзыва целиком (отзыв, плюсы, минусы). */
export function reviewText(review: ReviewForReply): string {
  return [review.content, review.pros, review.cons].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ');
}

export const isEmptyReview = (review: ReviewForReply) => reviewText(review).replace(/[\s.,!…\-–—]+/g, '').length === 0;

/** Узбекские буквы кириллицей и частые узбекские слова (латиницей и кириллицей). */
const UZ_CYRILLIC = /[ўқғҳЎҚҒҲ]/;
// \b в JS не видит границ кириллических слов, поэтому границы заданы через \p{L}.
const UZ_WORDS = /(?<!\p{L})(rahmat|raxmat|sochiq|sochiqlar|sochiqni|yaxshi|yoqdi|zo'?r|juda|chiroyli|sifat|sifatli|ajoyib|hammom|yumshoq|qalin|katta|kichik|keldi|oldim|buyurtma|tavsiya|maqul|ma'?qul|ekan|bo'?ldi|uchun|bilan|xursandmiz|рахмат|раҳмат|яхши|ёқди|зўр|жуда|сифат|чиройли|келди|олдим|тавсия|сочиқ|ҳаммом|ранглари|хурсандмиз)(?!\p{L})/iu;

/** Язык ответа. Узбекский — только когда отзыв сам написан по-узбекски; без текста — русский. */
export function replyLanguage(review: ReviewForReply): ReviewReplyLanguage {
  const text = reviewText(review);
  if (!text) return 'ru';
  if (UZ_CYRILLIC.test(text) || UZ_WORDS.test(text)) return 'uz';
  // Латиница без русских букв — узбекский (английских отзывов на Uzum практически нет).
  if (/[a-z]/i.test(text) && !/[а-яё]/i.test(text)) return 'uz';
  return 'ru';
}

/** Имя для обращения: настоящее, кириллицей или латиницей, не «Безымянный»/«***». */
export function addressName(review: ReviewForReply): string | null {
  if (review.anonymous) return null;
  const raw = String(review.customerName ?? '').trim();
  const first = raw.split(/\s+/)[0] ?? '';
  if (!/^[A-Za-zА-Яа-яЁёЎўҚқҒғҲҳ'ʼ-]{2,20}$/.test(first)) return null;
  if (/^(безымянн|покупател|аноним|user|guest|клиент)/i.test(first)) return null;
  return first[0].toUpperCase() + first.slice(1);
}

/** Банк коротких русских благодарностей на отзыв без текста. Без оценки, звёзд и выдумок о товаре. */
export const EMPTY_REVIEW_REPLIES: string[] = [
  'Спасибо за отзыв! Нам важно знать, что заказ вас порадовал 💚',
  'Благодарим за покупку и за отзыв — это очень поддерживает небольшой магазин 💚',
  'Спасибо, что нашли минуту оставить отзыв! Будем рады видеть вас снова 💚',
  'Спасибо вам! Если захотите дополнить отзыв впечатлениями о товаре — будем признательны 💚',
  'Благодарим за доверие и за отзыв! Приятного пользования 💚',
  'Спасибо за отзыв и за выбор нашего магазина 💚',
  'Рады, что покупка состоялась удачно. Спасибо за отзыв! 💚',
  'Спасибо! Ваш отзыв помогает другим покупателям определиться с выбором 💚',
  'Благодарим за покупку! Надеемся, товар вам пригодится и будет радовать 💚',
  'Спасибо за отзыв! Всегда рады вам в Parisa Home 💚',
];

/** Благодарность на пустой отзыв: первая формулировка банка, которой нет среди недавних ответов; имя — впереди. */
export function emptyReviewReply(review: ReviewForReply, recent: string[] = [], bank: string[] = EMPTY_REVIEW_REPLIES): string {
  const fresh = bank.find((row) => !recent.some((used) => sameTemplate(used, row)));
  const base = fresh ?? bank[oldestIndex(recent, bank)];
  const name = addressName(review);
  return name ? `${name}, ${base[0].toLowerCase()}${base.slice(1)}` : base;
}

/** Ответ построен на этом шаблоне: совпадает целиком или после обращения «Имя, …». */
function sameTemplate(reply: string, template: string): boolean {
  const text = reply.trim();
  return text === template || text.endsWith(`, ${template[0].toLowerCase()}${template.slice(1)}`);
}

/** Все формулировки уже использованы — берём ту, что уходила раньше всех (recent отсортирован от новых к старым). */
function oldestIndex(recent: string[], bank: string[]): number {
  let best = 0; let bestPos = -1;
  bank.forEach((row, index) => {
    const pos = recent.findIndex((used) => sameTemplate(used, row));
    const rank = pos === -1 ? Number.MAX_SAFE_INTEGER : pos;
    if (rank > bestPos) { bestPos = rank; best = index; }
  });
  return best;
}

/**
 * Ответ модели не годится: не на том языке, с оценкой/звёздами или не той длины.
 * Возвращает причину или null.
 */
export function replyRejectReason(reply: string, language: ReviewReplyLanguage): string | null {
  const text = reply.trim();
  if (text.length < 10) return 'слишком короткий';
  if (text.length > 350) return 'длиннее 350 символов';
  if (/(★|оценк|пятёрк|пятерк|звезд|звёзд|балл|baho|yulduz)/i.test(text)) return 'упоминает оценку';
  const brands = (value: string) => value.replace(/parisa ?home|uzum|havana|j471|j403|j538/gi, '');
  if (language === 'ru') {
    if (UZ_CYRILLIC.test(text)) return 'узбекские буквы в русском ответе';
    if (UZ_WORDS.test(text)) return 'узбекские слова в русском ответе';
    if (/\b[a-z]{3,}\b/i.test(brands(text))) return 'латиница в русском ответе';
  } else if (UZ_CYRILLIC.test(text) || /[а-яё]{3,}/i.test(brands(text))) {
    return 'кириллица в узбекском ответе';
  }
  return null;
}
