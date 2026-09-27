/**
 * Разбор падения продаж по данным БД (заказы из Seller OpenAPI, остатки, реклама, журнал цен):
 *
 *   npx tsx apps/api/scripts/sales-report.ts
 *
 * Что показывает:
 *   1) заказы по дням за 5 недель (создано, отменено, сумма, средняя цена);
 *   2) последние выходные против средних за 4 предыдущих выходных — по товарам и SKU,
 *      с ценой в заказах, остатком сейчас и минимальным остатком за выходные;
 *   3) расход на рекламу по дням (У000120 «Буст заказов», У000119 «Буст в ТОП») и по товарам;
 *   4) изменения цен из журнала PriceChange.
 * Только чтение. Даты — Asia/Tashkent, заказы — по дате создания.
 */
import { ADVERTISING_EXPENSE_CODES, baseAdvertisingCode, ORDER_BOOST_CODE } from '../src/common/advertising';
import { shiftDay, tashkentDay } from '../src/common/auto-pricing';
import { PrismaService } from '../src/common/prisma.service';

const DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const dow = (day: string) => DOW[new Date(`${day}T12:00:00Z`).getUTCDay()];
const fmt = (value: number) => Math.round(value).toLocaleString('ru-RU');
const pct = (now: number, before: number) => (before > 0 ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}%` : now > 0 ? 'новое' : '—');

type Line = { day: string; skuId: string | null; units: number; revenue: number; price: number; canceled: boolean };

async function main() {
  const prisma = new PrismaService();
  try {
    const shop = await prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new Error('нет активного магазина');
    const now = new Date();
    const today = tashkentDay(now);
    const since = new Date(now.getTime() - 42 * 86_400_000);

    // Последние полные выходные (суббота и воскресенье до сегодня) и 4 предыдущих.
    let saturday = shiftDay(today, -1);
    while (dow(saturday) !== 'Сб' || shiftDay(saturday, 1) >= today) saturday = shiftDay(saturday, -1);
    const weekends = [0, 1, 2, 3, 4].map((week) => [shiftDay(saturday, -7 * week), shiftDay(saturday, -7 * week + 1)]);
    const lastWeekend = new Set(weekends[0]);
    const prevWeekends = new Set(weekends.slice(1).flat());

    const [orders, skus, snapshots, expenses, changes] = await Promise.all([
      prisma.order.findMany({
        where: { shopId: shop.id, OR: [{ orderedAt: { gte: since } }, { orderedAt: null, dateIssued: { gte: since } }] },
        select: { orderedAt: true, dateIssued: true, state: true, items: { select: { skuId: true, quantity: true, sellPrice: true, amount: true } } },
      }),
      prisma.sku.findMany({
        where: { product: { shopId: shop.id } },
        select: { id: true, externalId: true, sellerSku: true, stock: true, price: true, product: { select: { externalId: true, title: true } } },
      }),
      prisma.stockSnapshot.findMany({
        where: { capturedAt: { gte: new Date(now.getTime() - 16 * 86_400_000) }, sku: { product: { shopId: shop.id } } },
        select: { skuId: true, amount: true, capturedAt: true },
      }),
      prisma.marketplaceExpense.findMany({
        where: { shopId: shop.id, code: { in: [...ADVERTISING_EXPENSE_CODES] }, serviceAt: { gte: new Date(now.getTime() - 35 * 86_400_000) } },
        select: { code: true, amount: true, serviceAt: true, productExternalId: true },
      }),
      prisma.priceChange.findMany({
        where: { shopExternalId: shop.externalId, createdAt: { gte: new Date(now.getTime() - 28 * 86_400_000) } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const skuById = new Map(skus.map((sku: any) => [sku.id, sku]));
    const lines: Line[] = [];
    for (const order of orders as any[]) {
      const day = tashkentDay(order.orderedAt ?? order.dateIssued);
      for (const item of order.items) {
        const units = Math.max(0, Number(item.quantity) || 0);
        const revenue = Number(item.amount) || 0;
        const price = Number(item.sellPrice) || (units ? revenue / units : 0);
        lines.push({ day, skuId: item.skuId, units, revenue, price, canceled: order.state === 'CANCELED' });
      }
    }

    // 1. По дням.
    console.log(`=== Заказы по дням (по дате создания), магазин ${shop.name} ===`);
    console.log('день | заказано шт | отменено шт | сумма без отмен | ср. цена');
    for (let day = shiftDay(today, -35); day < today; day = shiftDay(day, 1)) {
      const rows = lines.filter((row) => row.day === day);
      const active = rows.filter((row) => !row.canceled);
      const units = active.reduce((sum, row) => sum + row.units, 0);
      const revenue = active.reduce((sum, row) => sum + row.revenue, 0);
      const canceled = rows.filter((row) => row.canceled).reduce((sum, row) => sum + row.units, 0);
      const mark = lastWeekend.has(day) ? '  ← последние выходные' : dow(day) === 'Сб' || dow(day) === 'Вс' ? '  (выходной)' : '';
      console.log(`${day} ${dow(day)} | ${units} | ${canceled} | ${fmt(revenue)} | ${units ? fmt(revenue / units) : '—'}${mark}`);
    }

    // 2. Выходные.
    console.log('\n=== Выходные (Сб+Вс, без отмен) ===');
    for (const [sat, sun] of weekends) {
      const rows = lines.filter((row) => (row.day === sat || row.day === sun) && !row.canceled);
      console.log(`${sat}–${sun.slice(8)}: ${rows.reduce((s, r) => s + r.units, 0)} шт, ${fmt(rows.reduce((s, r) => s + r.revenue, 0))} сум`);
    }

    // По SKU: последние выходные против среднего за 4 предыдущих.
    const minStockOnWeekend = new Map<string, number>();
    for (const snap of snapshots as any[]) {
      if (!lastWeekend.has(tashkentDay(snap.capturedAt))) continue;
      minStockOnWeekend.set(snap.skuId, Math.min(minStockOnWeekend.get(snap.skuId) ?? Infinity, snap.amount));
    }
    type Agg = { units: number; revenue: number; priceSum: number; priceUnits: number };
    const empty = (): Agg => ({ units: 0, revenue: 0, priceSum: 0, priceUnits: 0 });
    const bySku = new Map<string, { last: Agg; prev: Agg }>();
    for (const row of lines) {
      if (row.canceled || !row.skuId) continue;
      const bucket = lastWeekend.has(row.day) ? 'last' : prevWeekends.has(row.day) ? 'prev' : null;
      if (!bucket) continue;
      const entry = bySku.get(row.skuId) ?? { last: empty(), prev: empty() };
      const agg = entry[bucket];
      agg.units += row.units; agg.revenue += row.revenue; agg.priceSum += row.price * row.units; agg.priceUnits += row.units;
      bySku.set(row.skuId, entry);
    }
    const avgPrice = (agg: Agg) => (agg.priceUnits ? agg.priceSum / agg.priceUnits : null);

    const byProduct = new Map<string, { title: string; last: number; prev: number; lastRevenue: number; prevRevenue: number }>();
    for (const [skuId, entry] of bySku) {
      const sku: any = skuById.get(skuId);
      const key = sku?.product.externalId ?? '?';
      const row = byProduct.get(key) ?? { title: sku?.product.title ?? '?', last: 0, prev: 0, lastRevenue: 0, prevRevenue: 0 };
      row.last += entry.last.units; row.prev += entry.prev.units / 4; row.lastRevenue += entry.last.revenue; row.prevRevenue += entry.prev.revenue / 4;
      byProduct.set(key, row);
    }
    console.log('\n=== Товары: последние выходные против среднего за 4 предыдущих выходных ===');
    console.log('товар | было шт (ср.) | стало шт | изменение | было сум (ср.) | стало сум');
    for (const [id, row] of [...byProduct].sort((a, b) => (b[1].prev - b[1].last) - (a[1].prev - a[1].last))) {
      console.log(`${row.title.slice(0, 60)} [${id}] | ${row.prev.toFixed(1)} | ${row.last} | ${pct(row.last, row.prev)} | ${fmt(row.prevRevenue)} | ${fmt(row.lastRevenue)}`);
    }

    console.log('\n=== SKU с наибольшим падением (выходные) — цена в заказах, остаток ===');
    console.log('SKU | было шт (ср.) | стало шт | цена было → стало | цена сейчас | остаток сейчас | мин. остаток в выходные');
    const skuRows = skus.map((sku: any) => {
      const entry = bySku.get(sku.id) ?? { last: empty(), prev: empty() };
      return { sku, prev: entry.prev.units / 4, last: entry.last.units, pricePrev: avgPrice(entry.prev), priceLast: avgPrice(entry.last) };
    }).filter((row: any) => row.prev >= 0.5 || row.last > 0).sort((a: any, b: any) => (b.prev - b.last) - (a.prev - a.last));
    for (const row of skuRows.slice(0, 40) as any[]) {
      const min = minStockOnWeekend.get(row.sku.id);
      console.log(`${row.sku.sellerSku || row.sku.externalId} | ${row.prev.toFixed(1)} | ${row.last} | ${row.pricePrev ? fmt(row.pricePrev) : '—'} → ${row.priceLast ? fmt(row.priceLast) : '—'} | ${row.sku.price ? fmt(Number(row.sku.price)) : '—'} | ${row.sku.stock} | ${min === undefined ? 'нет снимков' : min}${row.sku.stock <= 0 || min === 0 ? '  ⚠️ НЕТ В НАЛИЧИИ' : ''}`);
    }
    const outOfStock = skus.filter((sku: any) => sku.stock <= 0);
    console.log(`\nSKU с нулевым остатком сейчас: ${outOfStock.length} из ${skus.length}`);
    const soldBefore = new Set(skuRows.filter((row: any) => row.prev >= 0.5).map((row: any) => row.sku.id));
    const lostSellers = outOfStock.filter((sku: any) => soldBefore.has(sku.id));
    if (lostSellers.length) console.log(`Из них раньше продавались на выходных: ${lostSellers.map((sku: any) => sku.sellerSku || sku.externalId).join(', ')}`);

    // 3. Реклама.
    console.log('\n=== Реклама по дням (факт из финансового отчёта Uzum; свежие дни могут быть неполными) ===');
    console.log('день | Буст заказов (У000120) | Буст в ТОП (У000119)');
    for (let day = shiftDay(today, -21); day < today; day = shiftDay(day, 1)) {
      const rows = (expenses as any[]).filter((row) => tashkentDay(row.serviceAt) === day);
      const boost = rows.filter((row) => baseAdvertisingCode(row.code) === ORDER_BOOST_CODE).reduce((s, r) => s + Number(r.amount), 0);
      const top = rows.filter((row) => baseAdvertisingCode(row.code) !== ORDER_BOOST_CODE).reduce((s, r) => s + Number(r.amount), 0);
      console.log(`${day} ${dow(day)} | ${fmt(boost)} | ${fmt(top)}`);
    }
    const titleByProduct = new Map(skus.map((sku: any) => [sku.product.externalId, sku.product.title]));
    const adByProduct = new Map<string, { week: number; prev: number }>();
    for (const row of expenses as any[]) {
      const day = tashkentDay(row.serviceAt);
      const key = String(row.productExternalId ?? 'без товара');
      const entry = adByProduct.get(key) ?? { week: 0, prev: 0 };
      if (day >= shiftDay(today, -7)) entry.week += Number(row.amount);
      else if (day >= shiftDay(today, -28)) entry.prev += Number(row.amount) / 3;
      adByProduct.set(key, entry);
    }
    console.log('\nРеклама по товарам: последние 7 дней против среднего за 3 предыдущие недели');
    for (const [id, row] of [...adByProduct].sort((a, b) => b[1].prev - a[1].prev)) {
      console.log(`${String(titleByProduct.get(id) ?? id).slice(0, 60)} [${id}] | ${fmt(row.prev)} → ${fmt(row.week)} (${pct(row.week, row.prev)})`);
    }

    // 4. Изменения цен.
    console.log('\n=== Журнал изменений цен за 28 дней (PriceChange) ===');
    if (!changes.length) console.log('записей нет — через приложение цены не менялись');
    for (const row of changes as any[]) {
      console.log(`${row.createdAt.toISOString().slice(0, 16)} | ${row.kind} | SKU ${row.skuExternalId} | ${row.oldPrice ?? '?'} → ${row.newPrice} | ${row.status}${row.dryRun ? ' (dry-run)' : ''} | ${row.source}${row.rule ? ` ${row.rule}` : ''}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
