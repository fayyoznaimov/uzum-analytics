/**
 * Сверка цифр Главной (владелец 09.11.2026: «мы работаем с деньгами — дезинформация приведёт к
 * плачевным последствиям»). Только чтение: ничего не пишет ни в БД, ни в Uzum.
 *
 *   cd apps/api && npx tsx scripts/verify-home.ts [--from 2026-11-03 --to 2026-11-09] [--telegram] [--quiet]
 *   (именно из apps/api: из корня tsx не включает experimentalDecorators и DashboardService не собирается)
 *
 * Берёт цифры так же, как их получает экран (DashboardService.overview), и рядом пересчитывает
 * их прямо из таблиц Order / MarketplaceExpense / InventoryMetric простыми суммами. Расхождение —
 * повод разбираться в расчёте Главной. Совпадение не доказывает, что база совпадает с Uzum:
 * для этого в конце — 10 выкупов периода, их нужно найти в кабинете Uzum (Финансы → Заказы)
 * и сверить сумму и выплату вручную (SERVER_CHECKLIST.md).
 *
 * --telegram  отправить отчёт владельцу в Telegram (чат из настроек интеграции)
 * --quiet     в консоль только итоги ✅/⚠️ без сумм — для логов GitHub Actions (репозиторий публичный)
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { resolvePeriod } from '../src/common/period';
import { PrismaService } from '../src/common/prisma.service';
import { TelegramClient } from '../src/common/telegram.client';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { WarehouseService } from '../src/modules/warehouse/warehouse.service';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (name: string) => process.argv.includes(name);
const sum = (n: any) => `${Math.round(Number(n || 0)).toLocaleString('ru-RU')} сум`;
const day = (d: Date | null | undefined) => d ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit' }).format(d) : '—';

async function main() {
  const prisma = new PrismaService();
  const quiet = flag('--quiet');
  const period = resolvePeriod({ from: arg('--from'), to: arg('--to'), days: arg('--from') ? undefined : 7 });
  // Тот же магазин, что берёт DashboardService.overview: в базе их несколько, первый попавшийся —
  // не тот (10.11.2026 сверка без isActive показала «из базы 0» по всем строкам).
  const shop = await prisma.shop.findFirst({ where: { isActive: true }, select: { id: true, name: true } });
  if (!shop) throw new Error('В базе нет активного магазина');
  const overview: any = await new DashboardService(prisma as any).overview({ from: period.fromDate, to: period.toDate, compare: 'false' });
  const m = overview.metrics;
  const lines: string[] = [`Сверка Главной за ${period.fromDate} — ${period.toDate}`];
  const verdicts: string[] = [];
  // Деньги сверяются с точностью до 1 сум (округления), штуки и заказы — точно.
  const check = (name: string, screenValue: unknown, direct: number, kind: 'money' | 'count' = 'money') => {
    const screen = Number(screenValue ?? NaN);
    const ok = Number.isFinite(screen) && Math.abs(screen - direct) <= (kind === 'money' ? 1 : 0);
    const show = (n: number) => kind === 'money' ? sum(n) : String(n);
    verdicts.push(`${ok ? '✅' : '⚠️'} ${name}`);
    lines.push(`${ok ? '✅' : '⚠️'} ${name}: на экране ${show(screen)}${ok ? '' : `, напрямую из базы ${show(direct)} — разница ${show(screen - direct)}`}`);
  };
  const uniqueOrders = (rows: Array<{ marketplaceOrderId: string | null; externalId: string }>) => new Set(rows.map((o) => o.marketplaceOrderId || o.externalId)).size;

  // 1. Заказано: заказы, созданные в периоде, кроме отменённых и полностью возвращённых.
  const ordered = await prisma.order.findMany({
    where: { shopId: shop.id, orderedAt: { gte: period.from, lte: period.to } },
    select: { marketplaceOrderId: true, externalId: true, state: true, grossRevenue: true, payout: true, payoutReported: true, items: { select: { quantity: true } } },
  });
  const active = ordered.filter((o) => !['CANCELED', 'RETURNED'].includes(String(o.state || '').toUpperCase()));
  check('Заказано, сумма', m.orderedRevenue, active.reduce((a, o) => a + Number(o.grossRevenue), 0));
  check('Заказано, штук', m.orderedUnits, active.reduce((a, o) => a + o.items.reduce((s, i) => s + i.quantity, 0), 0), 'count');
  check('Заказано, заказов', m.orders, uniqueOrders(active), 'count');
  const withPayout = active.filter((o) => o.payoutReported);
  check('Выплата Uzum по этим заказам', m.orderedPayout, withPayout.reduce((a, o) => a + Number(o.payout), 0));
  check('Заказов без выплаты от Uzum', m.orderedPayoutPendingOrders, Math.max(0, uniqueOrders(active) - uniqueOrders(withPayout)), 'count');
  const states = new Map<string, number>();
  for (const o of ordered) states.set(String(o.state), (states.get(String(o.state)) || 0) + 1);
  lines.push(`   строк заказов по статусам: ${[...states].map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // 2. Выкуплено: выданные в периоде (issuedAt) и оплаченные; частичный возврат уменьшает сумму пропорционально штукам.
  const issued = await prisma.order.findMany({
    where: { shopId: shop.id, issuedAt: { gte: period.from, lte: period.to } },
    select: { marketplaceOrderId: true, externalId: true, state: true, status: true, issuedAt: true, grossRevenue: true, payout: true, payoutReported: true, returnedUnits: true, items: { select: { quantity: true, title: true } } },
    orderBy: { issuedAt: 'asc' },
  });
  const paidRows = issued.filter((o) => String(o.state || '').toUpperCase() === 'PAID');
  const units = (o: typeof paidRows[number]) => o.items.reduce((s, i) => s + i.quantity, 0);
  const directRevenue = paidRows.reduce((a, o) => { const u = Math.max(1, units(o)); const r = Math.min(u, Math.max(0, o.returnedUnits || 0)); return a + Number(o.grossRevenue) * (u - r) / u; }, 0);
  check('Выкуплено, сумма', m.revenue, directRevenue);
  check('Выкуплено, штук', m.paidUnits, paidRows.reduce((a, o) => a + Math.max(0, units(o) - Math.max(0, o.returnedUnits || 0)), 0), 'count');
  check('График выкупов = итог «Выкуплено»', (overview.chart || []).reduce((a: number, x: any) => a + Number(x.revenue || 0), 0), Number(m.revenue));
  check('Выданных заказов без выплаты от Uzum', m.realizedPayoutPendingOrders, paidRows.filter((o) => !o.payoutReported).length, 'count');

  // 3. Возвраты: строки возвратной логистики Uzum в периоде.
  const returnRows = await prisma.marketplaceExpense.findMany({
    where: { shopId: shop.id, serviceAt: { gte: period.from, lte: period.to }, code: { startsWith: 'return-logistics-' }, type: 'INCOME' },
    select: { amount: true, raw: true },
  });
  check('Возвраты, строк', m.returnedTodayOrders, returnRows.length, 'count');
  lines.push(`   сумма этих строк ${sum(returnRows.reduce((a, r) => a + Math.abs(Number(r.amount)), 0))} — это деньги строк логистики, не стоимость товара`);

  // 4. Остатки: сколько SKU под риском по последнему отчёту остатков.
  const inventory = await prisma.inventoryReportImport.findFirst({ where: { shopId: shop.id }, orderBy: { importedAt: 'desc' }, select: { reportAsOf: true, importedAt: true, metrics: { select: { endingSoon: true, recommendedSupply: true, coverageDays: true } } } });
  if (inventory) {
    check('Остатки: SKU под риском', overview.risksTotal ?? overview.risks?.length, inventory.metrics.filter((x) => x.endingSoon || x.recommendedSupply > 0 || x.coverageDays <= 10).length, 'count');
    const ageDays = Math.floor((Date.now() - inventory.importedAt.getTime()) / 86_400_000);
    lines.push(`   отчёт остатков Uzum от ${day(inventory.reportAsOf)}, загружен ${day(inventory.importedAt)}${ageDays > 3 ? ` — ⚠️ ему ${ageDays} дн., остатки могли сильно измениться` : ''}`);
    if (ageDays > 3) verdicts.push(`⚠️ Отчёт остатков старый (${ageDays} дн.)`);
  } else lines.push('   отчёт остатков Uzum не загружен — риски по текущим остаткам SKU');

  // 5. Кошелёк и прибыль — показать как есть, это сверяется с кабинетом Uzum, а не с базой.
  const s = overview.payoutForecast?.summary || {};
  const next = (overview.payoutForecast?.payoutDailyRows || []).find((r: any) => r.date >= overview.payoutForecast?.today);
  lines.push('', 'Сверить руками с кабинетом Uzum:');
  lines.push(`• Можно вывести: ${sum(s.availableToWithdraw)} (${s.overallBalanceSource === 'financial-statement' ? `по финотчёту Uzum от ${s.statementAsOf ? day(new Date(s.statementAsOf)) : '—'}` : 'расчёт по API'})`);
  const statements = await prisma.financialStatementImport.findMany({ where: { shopId: shop.id }, orderBy: { importedAt: 'desc' }, take: 3, select: { fileName: true, reportAsOf: true, importedAt: true } });
  lines.push(`   финотчёты (последние ${statements.length}): ${statements.map((x) => `«${x.fileName.slice(0, 40)}» данные по ${x.reportAsOf ? x.reportAsOf.toISOString().slice(0, 10) : '—'}, загружен ${x.importedAt.toISOString().slice(0, 10)}`).join('; ') || 'нет'}`);
  lines.push(`   расчёт по API без финотчёта: остаток ${sum(s.calculatedOverallBalance)}`);
  lines.push(`• Следующая выплата ${next ? `${next.date}: ${sum(next.netAmount ?? next.bankAmount)}${Number(next.expensesEstimate || 0) > 0 ? ' (часть расходов — оценка)' : ''}` : '— нет'}`);
  lines.push(`• В удержании: ${sum(s.inReturnHold)}`);
  lines.push(`• Прибыль: ${m.profitKnown ? sum(m.sellerProfitAfterAdsAndProductCost) : `не рассчитана (нет себестоимости у ${m.realizedMissingCostItems} позиций, без выплаты ${m.realizedPayoutPendingOrders} заказов)`}`);

  // 6. Склад → Потери так, как его видит экран: итог и три SKU, которые надо проверить первыми.
  const losses: any = await new WarehouseService(prisma as any, null as any).losses();
  const ls = losses.summary;
  lines.push('', `Склад → Потери: не найдено ${ls.notFound} шт. ≈ ${sum(ls.notFoundCost)} по себестоимости; проверить ${ls.checkSkus} SKU; без истории поставок ${ls.noHistorySkus} SKU; накладных FBO ${losses.coverage.fboSupplies} с ${day(losses.coverage.firstSupplyAt ? new Date(losses.coverage.firstSupplyAt) : null)}; принято ${ls.accepted}, продано ${ls.sold}, в заказах ${ls.inOrders}, на складе ${ls.stock}, брак ${ls.defective}, могут ехать обратно ${ls.maybeReturning}`);
  for (const r of losses.rows.filter((row: any) => row.status === 'check').slice(0, 3)) lines.push(`• ${r.sellerSku}: принято ${r.accepted}, продано ${r.sold}, в заказах ${r.inOrders}, на складе ${r.stock}, брак ${r.defective ?? '—'}, едут ${r.maybeReturning} → не найдено ${r.notFound}`);

  // 7. Десять выкупов периода для ручной сверки с кабинетом Uzum.
  const step = Math.max(1, Math.floor(paidRows.length / 10));
  const sample = paidRows.filter((_, i) => i % step === 0).slice(0, 10);
  lines.push('', `Найти в кабинете Uzum (Финансы → Заказы) и сверить — ${sample.length} из ${paidRows.length} выкупов:`);
  for (const o of sample) lines.push(`• №${o.marketplaceOrderId || o.externalId} • выдан ${day(o.issuedAt)} • ${units(o)} шт. • сумма ${sum(o.grossRevenue)} • выплата ${o.payoutReported ? sum(o.payout) : 'нет'}${o.returnedUnits ? ` • возврат ${o.returnedUnits} шт.` : ''}`);

  const bad = verdicts.filter((v) => v.startsWith('⚠️')).length;
  lines.splice(1, 0, bad ? `⚠️ Расхождений: ${bad}` : '✅ Все цифры Главной совпали с прямым пересчётом из базы', '');
  console.log(quiet ? [lines[0], lines[1], ...verdicts].join('\n') : lines.join('\n'));

  if (flag('--telegram')) {
    await sendTelegram(prisma, lines.join('\n'), `sverka_glavnoy_${period.fromDate}_${period.toDate}.txt`, lines.slice(0, 2).join('\n'));
    console.log('Отчёт отправлен в Telegram');
  }
  await prisma.$disconnect();
  if (bad) process.exitCode = 1;
}

async function sendTelegram(prisma: PrismaService, text: string, fileName: string, caption: string) {
  const row = await prisma.integrationCredential.findUnique({ where: { type: IntegrationType.TELEGRAM } });
  const token = row?.enabled ? new CryptoService().decrypt(row) : null;
  const chatId = String((row?.metadata as any)?.chatId || '');
  if (!token || !chatId) throw new Error('Telegram не настроен: нет токена бота или chatId в настройках');
  const telegram = new TelegramClient();
  if (text.length <= 4000) await telegram.sendMessage(token, chatId, text);
  else await telegram.sendDocument(token, chatId, Buffer.from(text, 'utf8'), fileName, caption);
}

// Ошибку тоже отправляем в Telegram: лог Actions владелец не читает, и без этого сбой выглядит как тишина.
main().catch(async (error) => {
  const message = String(error?.message || error).slice(0, 1500);
  console.error(message);
  if (flag('--telegram')) await sendTelegram(new PrismaService(), `⚠️ Сверка Главной не выполнилась: ${message}`, 'sverka_oshibka.txt', '⚠️ Сверка Главной не выполнилась').catch(() => undefined);
  process.exit(1);
});
