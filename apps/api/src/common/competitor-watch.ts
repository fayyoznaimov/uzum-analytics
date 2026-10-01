import { createHash } from 'node:crypto';

/**
 * Мониторинг конкурентов. Публичный каталог uzum.uz с серверных IP закрыт
 * антиботом, поэтому данные снимает Chrome-расширение владельца и присылает
 * на POST /api/competitor-watch/ingest с парным токеном. Здесь — чистая логика:
 * разбор ссылок, нормализация снапшотов и правила алертов.
 */

export const hashWatchToken = (value: string) => createHash('sha256').update(value).digest('hex');

/** ID карточки из ссылки uzum.uz: …/product/nabor-polotenec-123456 или /product/123456. */
export function parseUzumProductUrl(value: string): string | null {
  const text = String(value || '').trim();
  if (/^\d{4,}$/.test(text)) return text;
  const match = text.match(/\/product\/(?:[^/?#]*-)?(\d{4,})(?:[/?#]|$)/);
  return match ? match[1] : null;
}

export type CompetitorSnapshotInput = {
  productId: string;
  title?: string;
  price: number;
  fullPrice?: number | null;
  available?: number | null;
  ordersAmount?: number | null;
  rating?: number | null;
  reviewsCount?: number | null;
};

export function normalizeSnapshot(row: any): CompetitorSnapshotInput | null {
  const productId = String(row?.productId ?? row?.id ?? '').trim();
  const price = Number(row?.price);
  if (!/^\d{4,}$/.test(productId) || !Number.isFinite(price) || price <= 0) return null;
  // null/undefined/'' — это «нет данных», а не 0: Number(null) даёт 0 и ложный
  // алерт «у конкурента закончился товар».
  const num = (value: any) => { if (value === null || value === undefined || value === '') return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
  return {
    productId,
    title: typeof row?.title === 'string' ? row.title.slice(0, 300) : undefined,
    price: Math.round(price),
    fullPrice: num(row?.fullPrice),
    available: num(row?.available),
    ordersAmount: num(row?.ordersAmount),
    rating: num(row?.rating),
    reviewsCount: num(row?.reviewsCount),
  };
}

export type CompetitorAlert = { type: 'PRICE_DROP' | 'PRICE_RISE' | 'OUT_OF_STOCK' | 'BACK_IN_STOCK'; text: string };

export type AlertConfig = { priceChangePercent: number };
export const WATCH_DEFAULTS: AlertConfig = { priceChangePercent: 3 };

/** Сравнение двух снапшотов конкурента; prev может отсутствовать (первый замер). */
export function competitorAlerts(
  title: string,
  prev: { price: number; available: number | null } | null,
  next: { price: number; available: number | null },
  cfg: AlertConfig = WATCH_DEFAULTS,
): CompetitorAlert[] {
  if (!prev) return [];
  const alerts: CompetitorAlert[] = [];
  const fmt = (value: number) => Math.round(value).toLocaleString('ru-RU').replace(/ /g, ' ');
  if (prev.price > 0 && next.price > 0 && next.price !== prev.price) {
    const deltaPercent = (next.price - prev.price) / prev.price * 100;
    if (deltaPercent <= -cfg.priceChangePercent) {
      alerts.push({ type: 'PRICE_DROP', text: `📉 Конкурент снизил цену: ${title} ${fmt(prev.price)} → ${fmt(next.price)} сум (${deltaPercent.toFixed(1)}%)` });
    } else if (deltaPercent >= cfg.priceChangePercent) {
      alerts.push({ type: 'PRICE_RISE', text: `📈 Конкурент поднял цену: ${title} ${fmt(prev.price)} → ${fmt(next.price)} сум (+${deltaPercent.toFixed(1)}%)` });
    }
  }
  const prevStock = prev.available;
  const nextStock = next.available;
  if (prevStock !== null && nextStock !== null) {
    if (prevStock > 0 && nextStock === 0) alerts.push({ type: 'OUT_OF_STOCK', text: `🕳 У конкурента закончился товар: ${title} — шанс забрать его спрос` });
    if (prevStock === 0 && nextStock > 0) alerts.push({ type: 'BACK_IN_STOCK', text: `📦 Конкурент снова в наличии: ${title} (${nextStock} шт.)` });
  }
  return alerts;
}
