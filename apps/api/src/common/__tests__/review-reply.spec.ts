import { describe, expect, it } from 'vitest';
import { addressName, EMPTY_REVIEW_REPLIES, emptyReviewReply, isEmptyReview, replyLanguage, replyRejectReason } from '../review-reply';

describe('ответы на отзывы', () => {
  it('язык: узбекский только по тексту отзыва, пустой отзыв — русский, имя не решает', () => {
    expect(replyLanguage({ content: '', customerName: 'Maqsudjon' })).toBe('ru');
    expect(replyLanguage({ content: null, pros: '  ', customerName: 'Aziza' })).toBe('ru');
    expect(replyLanguage({ content: 'полотенце понравилось, мягкое', customerName: 'Dilnoza' })).toBe('ru');
    expect(replyLanguage({ content: 'Juda yaxshi sochiq, rahmat' })).toBe('uz');
    expect(replyLanguage({ content: 'Сифати зўр, раҳмат' })).toBe('uz');
    expect(replyLanguage({ content: 'zor' })).toBe('uz'); // латиница без кириллицы
    expect(replyLanguage({ content: 'мне понравилось.' })).toBe('ru');
  });

  it('пустой отзыв — только пробелы и знаки', () => {
    expect(isEmptyReview({ content: '', pros: null, cons: undefined })).toBe(true);
    expect(isEmptyReview({ content: ' … ' })).toBe(true);
    expect(isEmptyReview({ content: 'ок' })).toBe(false);
  });

  it('обращение по имени: настоящее имя да, «Безымянный», «***», аноним — нет', () => {
    expect(addressName({ customerName: 'Наталья Р.' })).toBe('Наталья');
    expect(addressName({ customerName: 'maqsudjon' })).toBe('Maqsudjon');
    expect(addressName({ customerName: 'Безымянный' })).toBeNull();
    expect(addressName({ customerName: '***' })).toBeNull();
    expect(addressName({ customerName: 'Елена', anonymous: true })).toBeNull();
  });

  it('пустой отзыв: шаблон из банка, не повторяющий недавние, с именем впереди; банк исчерпан — самый давний', () => {
    const first = emptyReviewReply({ customerName: 'Наталья' }, []);
    expect(first).toBe('Наталья, спасибо за отзыв! Нам важно знать, что заказ вас порадовал 💚');
    const second = emptyReviewReply({ customerName: 'Безымянный' }, [first]);
    expect(second).toBe(EMPTY_REVIEW_REPLIES[1]);
    // Весь банк уже ушёл; recent — от новых к старым, значит самый давний шаблон — EMPTY_REVIEW_REPLIES[0].
    const recent = [...EMPTY_REVIEW_REPLIES].reverse().map((row, index) => (index % 2 ? `Имя, ${row[0].toLowerCase()}${row.slice(1)}` : row));
    expect(emptyReviewReply({}, recent)).toBe(EMPTY_REVIEW_REPLIES[0]);
    for (const row of EMPTY_REVIEW_REPLIES) expect(replyRejectReason(row, 'ru')).toBeNull();
  });

  it('проверка ответа модели: узбекские слова и буквы в русском, кириллица в узбекском, оценка, длина', () => {
    expect(replyRejectReason('Дамир, рахмат! Хурсандмиз, ёқди 💚', 'ru')).toBe('узбекские буквы в русском ответе');
    expect(replyRejectReason('Александр, рахмат! Havana ранглари понравились', 'ru')).toBe('узбекские слова в русском ответе');
    expect(replyRejectReason('Рахмат! Sauna sochiqni tanlaganingizdan xursandmiz', 'ru')).toBe('узбекские слова в русском ответе');
    expect(replyRejectReason('Спасибо, Елена! Пусть набор HAVANA служит долго 💚', 'ru')).toBeNull();
    expect(replyRejectReason('Спасибо за высокую оценку!', 'ru')).toBe('упоминает оценку');
    expect(replyRejectReason('Rahmat! Sochiq yoqqanidan xursandmiz 💚', 'uz')).toBeNull();
    expect(replyRejectReason('Рамат ака, раҳмат! Havana ранглари ёққани биз учун ҳам яхши янгилик 💚', 'uz')).toBe('кириллица в узбекском ответе');
    expect(replyRejectReason('Спасибо', 'ru')).toBe('слишком короткий');
  });
});
