import { BoostStateMap, boostStateMap } from './advertising';

/**
 * Статус «Буста заказов» по товарам из таблицы товаров (обновляет AdAgentService.refreshBoostStatus).
 * Ошибка чтения или устаревший статус → undefined/пусто: оценки рекламы считаются по-старому.
 */
export async function loadBoostState(prisma: any, shopId?: string | null): Promise<BoostStateMap | undefined> {
  try {
    const rows = await prisma.product.findMany({
      where: shopId ? { shopId } : {},
      select: { externalId: true, orderBoostStatus: true, orderBoostCheckedAt: true },
    });
    return Array.isArray(rows) ? boostStateMap(rows) : undefined;
  } catch {
    return undefined;
  }
}
