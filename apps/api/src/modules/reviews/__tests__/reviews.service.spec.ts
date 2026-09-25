import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  IntegrationStatus: { CONNECTED: 'CONNECTED', ERROR: 'ERROR' },
  IntegrationType: { UZUM: 'UZUM', UZUM_INTERNAL: 'UZUM_INTERNAL', TELEGRAM: 'TELEGRAM' },
  Prisma: {},
}));

import { ReviewsService } from '../reviews.service';

function review(overrides: Record<string, any> = {}) {
  return {
    reviewId: 101,
    dateCreated: '2026-07-17T08:00:00.000Z',
    rating: 3,
    packagingQualityRating: 4,
    deliveryRating: 5,
    content: 'Текст отзыва',
    pros: 'Плюс',
    cons: 'Минус',
    photos: [{ url: 'https://example.test/review.jpg' }],
    customerName: 'Скрытое имя',
    anonymous: true,
    product: {
      productId: 200,
      productTitle: 'Полотенце',
      skuTitle: 'Белое',
      photos: [{
        photo: {
          't_product_80': { high: 'https://example.test/product-80-high.jpg' },
          't_product_540': {
            high: 'https://example.test/product-540-high.jpg',
            low: 'https://example.test/product-540-low.jpg',
          },
        },
      }],
    },
    replyStatus: 'NO_REPLY',
    dateBought: '2026-07-10T08:00:00.000Z',
    characteristics: [{ title: 'Цвет', value: 'Белый' }],
    shop: { id: 92776, title: 'PARISAHOME' },
    read: false,
    pinned: false,
    ...overrides,
  };
}

function createService() {
  const prisma: any = {
    shop: {
      findUnique: vi.fn().mockResolvedValue({ id: 'shop-db', externalId: '92776', name: 'PARISAHOME' }),
    },
    syncRun: {
      create: vi.fn().mockResolvedValue({ id: 'run-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    product: {
      findMany: vi.fn().mockResolvedValue([{ id: 'product-db', externalId: '200' }]),
    },
    review: {
      upsert: vi.fn().mockResolvedValue({ id: 'review-db' }),
    },
    integrationCredential: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const integrations: any = {
    getPlain: vi.fn().mockResolvedValue({ token: 'Bearer internal-secret', metadata: { shopId: '92776' } }),
  };
  const openclaw: any = { run: vi.fn(), version: vi.fn() };
  return { service: new ReviewsService(prisma, integrations, openclaw), prisma };
}

describe('review ingestion', () => {
  beforeEach(() => {
    process.env.REVIEW_SYNC_PAGE_SIZE = '1';
    process.env.REVIEW_SYNC_MAX_PAGES = '10';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.REVIEW_SYNC_PAGE_SIZE;
    delete process.env.REVIEW_SYNC_MAX_PAGES;
  });

  it('uses Bearer auth, paginates and upserts the same external review idempotently', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ payload: [review()] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ payload: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ payload: [review({ content: 'Обновлённый текст' })] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ payload: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    const { service, prisma } = createService();

    const first = await service.sync('ALL');
    const second = await service.sync('ALL');

    expect(first).toMatchObject({ accepted: true, pages: 2, received: 1, saved: 1 });
    expect(second).toMatchObject({ accepted: true, pages: 2, received: 1, saved: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(firstUrl).toContain('page=0');
    expect(secondUrl).toContain('page=1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer internal-secret');
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ filter: 'ALL' }));
    expect(prisma.review.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.review.upsert.mock.calls[0][0]).toMatchObject({
      where: { shopId_externalId: { shopId: 'shop-db', externalId: '101' } },
      create: {
        shopId: 'shop-db',
        externalId: '101',
        productId: 'product-db',
        productPhotoUrl: 'https://example.test/product-540-high.jpg',
        customerName: null,
        needsReply: true,
      },
    });
  });

  it('stops if the upstream repeats a page and does not upsert it twice', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ payload: [review()] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ payload: [review()] }) });
    vi.stubGlobal('fetch', fetchMock);
    const { service, prisma } = createService();

    const result = await service.sync('NO_REPLY');

    expect(result).toMatchObject({ pages: 2, received: 1, saved: 1 });
    expect(prisma.review.upsert).toHaveBeenCalledOnce();
  });
});
