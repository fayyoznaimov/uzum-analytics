const { PrismaClient, GoalMetric, GoalPeriod, SupplyType } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function seedDemo(shopId) {
  const demoProducts = [
    { externalId: 'demo-1', title: 'Демо: Havana', sku: 'DEMO-HAVANA', price: 139900, stock: 10, cost: 38000 },
    { externalId: 'demo-2', title: 'Демо: J403', sku: 'DEMO-J403', price: 197900, stock: 12, cost: 48300 },
  ];

  for (const item of demoProducts) {
    const product = await prisma.product.upsert({
      where: { shopId_externalId: { shopId, externalId: item.externalId } },
      update: {},
      create: { shopId, externalId: item.externalId, title: item.title, status: 'DEMO' },
    });

    const sku = await prisma.sku.upsert({
      where: { productId_externalId: { productId: product.id, externalId: item.sku } },
      update: {},
      create: { productId: product.id, externalId: item.sku, sellerSku: item.sku, price: item.price, stock: item.stock },
    });

    const existingCost = await prisma.skuCost.findFirst({ where: { skuId: sku.id, validTo: null } });
    if (!existingCost) {
      await prisma.skuCost.create({
        data: { skuId: sku.id, amount: item.cost, warehouseLogisticsCost: 1500, createdBy: 'demo-seed' },
      });
    }
  }

  const supplyCount = await prisma.supply.count({ where: { shopId } });
  if (!supplyCount) {
    const supply = await prisma.supply.create({
      data: { shopId, externalId: 'FBS-DEMO', type: SupplyType.FBS, status: 'CREATED', statusLabel: 'Демо-поставка', itemCount: 2, units: 22 },
    });
    await prisma.supplySlotWatch.create({ data: { supplyId: supply.id, enabled: false } });
  }

  const goalCount = await prisma.goal.count({ where: { shopId } });
  if (!goalCount) {
    const startAt = new Date();
    startAt.setHours(0, 0, 0, 0);
    startAt.setDate(startAt.getDate() - ((startAt.getDay() + 6) % 7));
    const endAt = new Date(startAt);
    endAt.setDate(endAt.getDate() + 6);
    endAt.setHours(23, 59, 59, 999);
    await prisma.goal.createMany({
      data: [{ shopId, metric: GoalMetric.REVENUE, period: GoalPeriod.WEEKLY, targetValue: 25000000, startAt, endAt, note: 'Демо-цель' }],
    });
  }
}

async function main() {
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';

  if (!email || !password) throw new Error('ADMIN_EMAIL и ADMIN_PASSWORD обязательны для первого запуска');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD должен содержать минимум 12 символов');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 12) } });
  } else if (process.env.RESET_ADMIN_PASSWORD === 'true') {
    await prisma.user.update({ where: { email }, data: { passwordHash: await bcrypt.hash(password, 12) } });
  }

  const configuredShopId = (process.env.DEFAULT_SHOP_ID || '').trim();
  const existingShop = configuredShopId ? null : await prisma.shop.findFirst({
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
  });
  if (!configuredShopId && !existingShop) {
    throw new Error('DEFAULT_SHOP_ID is required when the database has no shop');
  }
  const externalId = configuredShopId || existingShop.externalId;
  const shopName = (process.env.DEFAULT_SHOP_NAME || existingShop?.name || `Uzum shop ${externalId}`).trim();
  const shop = configuredShopId ? await prisma.shop.upsert({
    where: { externalId },
    update: {},
    create: { externalId, name: shopName },
  }) : existingShop;

  // The old global advertising reserve is no longer a calculation input.
  // Clear legacy values for every existing shop so restarts cannot resurrect 3%.
  await prisma.financialSettings.updateMany({ data: { advertisingPercent: 0 } });

  await prisma.financialSettings.upsert({
    where: { shopId: shop.id },
    update: { advertisingPercent: 0 },
    create: { shopId: shop.id, taxPercent: 1, advertisingPercent: 0, marketplaceCommissionFallbackPercent: 0 },
  });

  if (process.env.SEED_DEMO_DATA === 'true') await seedDemo(shop.id);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
