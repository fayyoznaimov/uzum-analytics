import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FinancialStatementIncomeRow,
  parseFinancialStatementWorkbook,
} from '../../common/financial-statement';
import { PrismaService } from '../../common/prisma.service';

type StoredOrder = Prisma.OrderGetPayload<{
  include: { items: { include: { sku: true } } };
}>;

type MatchedLine = {
  row: FinancialStatementIncomeRow;
  order: StoredOrder;
  item: StoredOrder['items'][number];
  method: 'product-id' | 'title' | 'single-order-line';
};

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function normalizeTitle(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/лицевой/gu, 'лицево')
    .replace(/банный/gu, 'банны')
    .replace(/[×х]/gu, 'x')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function rawIdentifiers(value: Prisma.JsonValue | null): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const raw = value as Record<string, Prisma.JsonValue>;
  return ['skuId', 'productId', 'offerId', 'skuExternalId', 'productExternalId']
    .map((key) => raw[key])
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map(String);
}

function reasonLabel(code: string | null): string | null {
  if (!code) return null;
  const labels: Record<string, string> = {
    CANCELED: 'Отменён до получения',
    REGULAR: 'Обычный возврат',
    CONTENT: 'Не соответствует описанию',
    WRONG_SIZE: 'Не подошёл размер',
    PHOTO_MISMATCH: 'Не соответствует фото',
    MISSING: 'Не хватает товара или комплектации',
    WRONG_ITEM: 'Пришёл другой товар',
    BAD_QUALITY: 'Низкое качество или брак',
  };
  return labels[code.toUpperCase()] ?? code;
}

@Injectable()
export class FinancialStatementsService {
  constructor(private readonly prisma: PrismaService) {}

  private async activeShop() {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new BadRequestException('Активный магазин не найден');
    return shop;
  }

  private candidateIds(order: StoredOrder, item: StoredOrder['items'][number]): Set<string> {
    return new Set([
      item.marketplaceProductId,
      item.sku?.externalId,
      item.externalId,
      ...rawIdentifiers(item.raw),
      ...rawIdentifiers(order.raw),
    ].filter((value): value is string => Boolean(value)).map(String));
  }

  private matchRows(rows: FinancialStatementIncomeRow[], orders: StoredOrder[]) {
    const byOrder = new Map<string, StoredOrder[]>();
    for (const order of orders) {
      for (const key of [order.marketplaceOrderId, order.externalId].filter(Boolean) as string[]) {
        const list = byOrder.get(key) ?? [];
        if (!list.some((candidate) => candidate.id === order.id)) list.push(order);
        byOrder.set(key, list);
      }
    }

    const used = new Set<string>();
    const matched: MatchedLine[] = [];
    const unmatched: FinancialStatementIncomeRow[] = [];
    for (const row of rows) {
      const candidates = (byOrder.get(row.orderId) ?? [])
        .filter((order) => !used.has(order.id))
        .flatMap((order) => order.items.map((item) => ({ order, item })));
      const productId = String(row.productId ?? '');
      const byProduct = productId
        ? candidates.filter(({ order, item }) => this.candidateIds(order, item).has(productId))
        : [];
      const normalized = normalizeTitle(row.productTitle);
      const byTitle = candidates.filter(({ item }) => normalizeTitle(item.title) === normalized);

      let selected: { order: StoredOrder; item: StoredOrder['items'][number] } | undefined;
      let method: MatchedLine['method'] = 'single-order-line';
      if (byProduct.length === 1) {
        selected = byProduct[0];
        method = 'product-id';
      } else if (byProduct.length > 1) {
        selected = byProduct.find(({ item }) => normalizeTitle(item.title) === normalized) ?? byProduct[0];
        method = 'product-id';
      } else if (byTitle.length === 1) {
        selected = byTitle[0];
        method = 'title';
      } else if (candidates.length === 1) {
        selected = candidates[0];
      }

      if (!selected) {
        unmatched.push(row);
        continue;
      }
      used.add(selected.order.id);
      matched.push({ row, ...selected, method });
    }
    return { matched, unmatched, used };
  }

  private discrepancy(line: MatchedLine) {
    const { row, order } = line;
    const fullReturn = row.returnedQuantity >= Math.max(1, row.quantity);
    const expectedGross = row.purchasePrice * Math.max(1, row.quantity) - row.sellerDiscount;
    const expectedNetPayout = fullReturn ? 0 : row.payout - row.logisticsFee;
    const delta = {
      gross: Math.round(number(order.grossRevenue) - expectedGross),
      payoutAfterLogistics: Math.round(number(order.payout) - expectedNetPayout),
      platformFee: Math.round(number(order.commission) - row.platformFee),
      logistics: Math.round(number(order.logistics) - row.logisticsFee),
      quantity: order.quantity - row.quantity,
      returnedQuantity: order.returnedUnits - row.returnedQuantity,
    };
    return Object.values(delta).some((value) => value !== 0) ? delta : null;
  }

  async import(file?: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException('Выберите финансовый отчёт Uzum в формате .xlsx');

    let parsed;
    try {
      parsed = await parseFinancialStatementWorkbook(file.buffer);
    } catch (error: any) {
      throw new BadRequestException(error?.message || 'Не удалось прочитать финансовый отчёт Uzum');
    }
    if (!parsed.incomeRows.length) throw new BadRequestException('В отчёте не найдены строки заказов');

    const shop = await this.activeShop();
    const duplicate = await this.prisma.financialStatementImport.findUnique({
      where: { shopId_sourceHash: { shopId: shop.id, sourceHash: parsed.sourceHash } },
    });
    if (duplicate) return { ...(await this.latest()), duplicate: true };

    const [orders, databaseExpenses] = await Promise.all([
      this.prisma.order.findMany({
        where: { shopId: shop.id },
        include: { items: { include: { sku: true } } },
      }),
      this.prisma.marketplaceExpense.findMany({
        where: {
          shopId: shop.id,
          ...(parsed.expensesAsOf ? { serviceAt: { lte: parsed.expensesAsOf } } : {}),
        },
        select: { amount: true },
      }),
    ]);
    const reconciliation = this.matchRows(parsed.incomeRows, orders);
    const importedAt = parsed.reportAsOf ?? new Date();

    const discrepancies = reconciliation.matched.flatMap((line) => {
      const delta = this.discrepancy(line);
      return delta ? [{
        orderId: line.row.orderId,
        productId: line.row.productId,
        productTitle: line.row.productTitle,
        delta,
      }] : [];
    });

    for (let offset = 0; offset < reconciliation.matched.length; offset += 75) {
      const operations: Prisma.PrismaPromise<unknown>[] = [];
      for (const line of reconciliation.matched.slice(offset, offset + 75)) {
        const { row, order, item } = line;
        const orderUpdate: Prisma.OrderUpdateInput = {
          platformFee: row.platformFee,
          statementPayout: row.payout,
          withdrawnAmount: row.withdrawn,
          statementSalePrice: row.salePrice,
          statementPurchasePrice: row.purchasePrice,
          sellerDiscount: row.sellerDiscount,
          vatType: row.vatType,
          returnReasonCode: row.returnReason,
          statementStatus: row.statusRaw,
          statementImportedAt: importedAt,
          returnedUnits: Math.max(order.returnedUnits, row.returnedQuantity),
          ...(!order.orderedAt && row.purchasedAt ? { orderedAt: row.purchasedAt } : {}),
          ...(!order.issuedAt && row.issuedAt ? { issuedAt: row.issuedAt } : {}),
          ...(row.returnComment ? { returnComment: row.returnComment } : {}),
        };
        operations.push(this.prisma.order.update({ where: { id: order.id }, data: orderUpdate }));
        operations.push(this.prisma.orderItem.update({
          where: { id: item.id },
          data: {
            marketplaceProductId: row.productId,
            returns: Math.max(item.returns, row.returnedQuantity),
            returnReasonCode: row.returnReason,
            statementStatus: row.statusRaw,
            statementImportedAt: importedAt,
            ...(row.returnComment ? { returnComment: row.returnComment } : {}),
          },
        }));
      }
      await this.prisma.$transaction(operations);
    }

    for (let offset = 0; offset < parsed.withdrawalRows.length; offset += 100) {
      await this.prisma.$transaction(parsed.withdrawalRows.slice(offset, offset + 100).map((row) =>
        this.prisma.withdrawal.upsert({
          where: { shopId_externalId: { shopId: shop.id, externalId: row.withdrawalId } },
          update: {
            mode: row.mode,
            amount: row.amount,
            feePercent: row.feePercent,
            netAmount: row.netAmount,
            requestedAt: row.createdAt,
            payoutPeriod: row.period,
            status: row.statusRaw,
            rejectionReason: row.rejectionReason,
            raw: {
              rowNumber: row.rowNumber,
              modeRaw: row.modeRaw,
              status: row.status,
              statusRaw: row.statusRaw,
            },
          },
          create: {
            shopId: shop.id,
            externalId: row.withdrawalId,
            mode: row.mode,
            amount: row.amount,
            feePercent: row.feePercent,
            netAmount: row.netAmount,
            requestedAt: row.createdAt,
            payoutPeriod: row.period,
            status: row.statusRaw,
            rejectionReason: row.rejectionReason,
            raw: {
              rowNumber: row.rowNumber,
              modeRaw: row.modeRaw,
              status: row.status,
              statusRaw: row.statusRaw,
            },
          },
        }),
      ));
    }

    const reportOrderIds = new Set(parsed.incomeRows.map((row) => row.orderId));
    const postReportOrders = orders.filter((order) => {
      if (reportOrderIds.has(order.marketplaceOrderId || order.externalId)) return false;
      const date = order.orderedAt ?? order.createdAt;
      return !parsed.reportAsOf || date > parsed.reportAsOf;
    });
    const databaseExpenseNet = databaseExpenses.reduce((total, row) => total + number(row.amount), 0);
    const expenseDelta = Math.round(databaseExpenseNet - parsed.summary.netExpenses);
    const reconciliationIssues = reconciliation.unmatched.length + (expenseDelta === 0 ? 0 : 1);
    const methodCounts = reconciliation.matched.reduce((acc, line) => {
      acc[line.method] = (acc[line.method] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const summary = {
      ...parsed.summary,
      reportRows: parsed.incomeRows.length,
      dbRows: reconciliation.matched.length + postReportOrders.length,
      matchedOrders: reconciliation.matched.length,
      unmatchedOrders: reconciliation.unmatched.length,
      postReportOrders: postReportOrders.length,
      matchMethods: methodCounts,
      discrepancies: reconciliationIssues,
      liveStateDifferences: discrepancies.length,
      liveStateDifferenceSamples: discrepancies.slice(0, 100),
      unmatchedSamples: reconciliation.unmatched.slice(0, 100).map((row) => ({
        rowNumber: row.rowNumber,
        orderId: row.orderId,
        productId: row.productId,
        productTitle: row.productTitle,
      })),
      reportAsOf: iso(parsed.reportAsOf),
      incomeAsOf: iso(parsed.incomeAsOf),
      expensesAsOf: iso(parsed.expensesAsOf),
      sourceTimeZone: parsed.reportedTimeZone,
      normalizedTimeZone: 'Asia/Tashkent',
      databaseExpenseRows: databaseExpenses.length,
      databaseExpenseNet,
      expenseDelta,
      formulaWarning: 'Сводные формулы Excel не используются: итоги пересчитаны по детальным строкам.',
      workbookFormulaIssue: 'На листе «Баланс» проверочная формула D17 вычитает уже отрицательный возврат услуг. Правильный net рассчитан как списания + возвраты.',
    };

    await this.prisma.financialStatementImport.create({
      data: {
        shopId: shop.id,
        fileName: file.originalname,
        sourceHash: parsed.sourceHash,
        reportAsOf: parsed.reportAsOf,
        incomeRows: parsed.incomeRows.length,
        expenseRows: parsed.expenseRows.length,
        withdrawalRows: parsed.withdrawalRows.length,
        matchedOrders: reconciliation.matched.length,
        unmatchedOrders: reconciliation.unmatched.length,
        updatedOrders: reconciliation.matched.length,
        summary: summary as Prisma.InputJsonValue,
      },
    });

    return { ...(await this.latest()), duplicate: false };
  }

  async latest(returnLimit = 50) {
    const shop = await this.activeShop();
    const limit = Math.min(250, Math.max(1, Number.isFinite(returnLimit) ? Math.round(returnLimit) : 50));
    const latest = await this.prisma.financialStatementImport.findFirst({
      where: { shopId: shop.id },
      orderBy: { importedAt: 'desc' },
    });
    if (!latest) return { empty: true, message: 'Загрузите финансовый отчёт Uzum для точной сверки' };

    const [returnOrders, withdrawals] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          shopId: shop.id,
          statementImportedAt: { not: null },
          OR: [
            { returnedUnits: { gt: 0 } },
            { returnReasonCode: { not: null } },
            { returnComment: { not: null } },
          ],
        },
        include: { items: { include: { sku: true } } },
        orderBy: [{ orderedAt: 'desc' }, { updatedAt: 'desc' }],
        take: limit,
      }),
      this.prisma.withdrawal.findMany({
        where: { shopId: shop.id },
        orderBy: [{ requestedAt: 'desc' }, { createdAt: 'desc' }],
        take: 20,
      }),
    ]);

    return {
      empty: false,
      latest: {
        id: latest.id,
        fileName: latest.fileName,
        reportAsOf: latest.reportAsOf,
        importedAt: latest.importedAt,
        incomeRows: latest.incomeRows,
        expenseRows: latest.expenseRows,
        withdrawalRows: latest.withdrawalRows,
        matchedOrders: latest.matchedOrders,
        unmatchedOrders: latest.unmatchedOrders,
        summary: latest.summary,
      },
      returns: returnOrders.map((order) => {
        const item = order.items.find((candidate) => candidate.returns > 0 || candidate.returnReasonCode || candidate.returnComment) ?? order.items[0];
        const reasonCode = item?.returnReasonCode || order.returnReasonCode;
        return {
          id: order.id,
          orderId: order.marketplaceOrderId || order.externalId,
          externalId: order.externalId,
          state: order.state,
          quantity: item?.quantity ?? order.quantity,
          returnedQuantity: item?.returns ?? order.returnedUnits,
          purchasedAt: order.orderedAt,
          issuedAt: order.issuedAt,
          reasonCode,
          reason: reasonLabel(reasonCode) || order.returnReason,
          reasonFromApi: order.returnReason,
          comment: item?.returnComment || order.returnComment,
          statementStatus: item?.statementStatus || order.statementStatus,
          productId: item?.marketplaceProductId,
          sku: item?.sku?.sellerSku,
          title: item?.title,
          payout: number(order.payout),
          statementPayout: number(order.statementPayout),
          withdrawnAmount: number(order.withdrawnAmount),
        };
      }),
      withdrawals: withdrawals.map((row) => ({
        id: row.externalId,
        mode: row.mode,
        amount: number(row.amount),
        feePercent: row.feePercent === null ? null : number(row.feePercent),
        netAmount: row.netAmount === null ? null : number(row.netAmount),
        requestedAt: row.requestedAt,
        payoutPeriod: row.payoutPeriod,
        status: row.status,
        rejectionReason: row.rejectionReason,
      })),
    };
  }
}
