import { BadRequestException, Injectable } from '@nestjs/common';
import { latestAdvertisingRates } from '../../common/advertising';
import { calculateInventoryAnalytics, median } from '../../common/inventory-analytics';
import { parseInventoryWorkbook } from '../../common/inventory-report';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';

@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService, private readonly integrations: IntegrationsService) {}

  private async activeShop() {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new BadRequestException('Активный магазин не найден');
    return shop;
  }

  async import(file?: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException('Выберите Excel-файл отчёта остатков');
    let parsed;
    try {
      parsed = await parseInventoryWorkbook(file.buffer);
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Не удалось прочитать Excel-файл');
    }
    if (!parsed.rows.length) throw new BadRequestException('В отчёте не найдены строки SKU');

    const shop = await this.activeShop();
    const duplicate = await this.prisma.inventoryReportImport.findUnique({
      where: { shopId_sourceHash: { shopId: shop.id, sourceHash: parsed.sourceHash } },
    });
    if (duplicate) return { ok: true, duplicate: true, reportId: duplicate.id, rows: duplicate.rowCount };

    const skus = await this.prisma.sku.findMany({
      where: { product: { shopId: shop.id } },
      select: { id: true, sellerSku: true, barcode: true },
    });
    const bySellerSku = new Map(skus.filter((sku) => sku.sellerSku).map((sku) => [String(sku.sellerSku).trim().toUpperCase(), sku.id]));
    const byBarcode = new Map(skus.filter((sku) => sku.barcode).map((sku) => [String(sku.barcode).trim(), sku.id]));

    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inventoryReportImport.create({
        data: { shopId: shop.id, fileName: file.originalname, sourceHash: parsed.sourceHash, reportAsOf: parsed.reportAsOf, rowCount: parsed.rows.length },
      });
      await tx.inventoryMetric.createMany({
        data: parsed.rows.map((row) => ({
          reportId: created.id,
          shopId: shop.id,
          skuId: bySellerSku.get(row.sellerSku.toUpperCase()) || (row.barcode ? byBarcode.get(row.barcode) : undefined) || null,
          productExternalId: row.productExternalId,
          productTitle: row.productTitle,
          sellerSku: row.sellerSku,
          barcode: row.barcode,
          endingSoon: row.endingSoon,
          coverageIndicator: row.coverageIndicator,
          stockoutAt: row.stockoutAt,
          coverageDays: row.coverageDays,
          recommendedSupply: row.recommendedSupply,
          sellerFbsStock: row.sellerFbsStock,
          marketplaceTotal: row.marketplaceTotal,
          inSupply: row.inSupply,
          availableForSale: row.availableForSale,
          toCustomer: row.toCustomer,
          fromCustomer: row.fromCustomer,
          longTermStorage: row.longTermStorage,
          photoStudio: row.photoStudio,
          defective: row.defective,
          potentialPayoutUnit: row.potentialPayoutUnit,
          potentialPayoutTotal: row.potentialPayoutTotal,
        })),
      });
      return created;
    });

    const endingSoon = parsed.rows.filter((row) => row.endingSoon).length;
    const supplySkus = parsed.rows.filter((row) => row.recommendedSupply > 0).length;
    const recommendedSupply = parsed.rows.reduce((sum, row) => sum + row.recommendedSupply, 0);
    const potentialPayout = parsed.rows.reduce((sum, row) => sum + row.potentialPayoutTotal, 0);
    if (endingSoon || recommendedSupply) {
      await this.integrations.notifyTelegram(
        `📦 Отчёт остатков Uzum загружен
SKU: ${parsed.rows.length}
Заканчиваются: ${endingSoon}
Нужно довезти: ${recommendedSupply} шт. по ${supplySkus} SKU
Потенциальная выплата: ${Math.round(potentialPayout).toLocaleString('ru-RU')} сум`,
        'notifyLowStock',
      ).catch(() => false);
    }

    return {
      ok: true,
      duplicate: false,
      reportId: report.id,
      rows: parsed.rows.length,
      reportAsOf: parsed.reportAsOf,
      matchedSkus: parsed.rows.filter((row) => bySellerSku.has(row.sellerSku.toUpperCase()) || (row.barcode && byBarcode.has(row.barcode))).length,
      endingSoon,
      supplySkus,
      recommendedSupply,
      potentialPayout,
    };
  }

  async imports() {
    const shop = await this.activeShop();
    return this.prisma.inventoryReportImport.findMany({
      where: { shopId: shop.id },
      orderBy: { importedAt: 'desc' },
      take: 20,
      select: { id: true, fileName: true, reportAsOf: true, rowCount: true, importedAt: true },
    });
  }

  async overview(search?: string, status?: string) {
    const shop = await this.activeShop();
    const latest = await this.prisma.inventoryReportImport.findFirst({ where: { shopId: shop.id }, orderBy: { importedAt: 'desc' } });
    if (!latest) return { empty: true, message: 'Загрузите Excel-отчёт «Остатки (новый)» из кабинета Uzum' };

    const [settings, allMetrics, recentAdvertisingExpenses] = await Promise.all([
      this.prisma.financialSettings.upsert({
        where: { shopId: shop.id }, update: {},
        create: { shopId: shop.id, taxPercent: 1, advertisingPercent: 0, marketplaceCommissionFallbackPercent: 0 },
      }),
      this.prisma.inventoryMetric.findMany({
        where: { reportId: latest.id },
        include: { sku: { include: { product: true, costs: { where: { validTo: null }, orderBy: { validFrom: 'desc' }, take: 1 } } } },
      }),
      this.prisma.marketplaceExpense.findMany({
        where: {
          shopId: shop.id,
          code: 'У000120',
          type: 'OUTCOME',
          productExternalId: { not: null },
          serviceAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        select: { id: true, productExternalId: true, serviceAt: true, createdAt: true, name: true, raw: true },
      }),
    ]);

    const taxPercent = Number(settings.taxPercent);
    const advertisingRates = latestAdvertisingRates(recentAdvertisingExpenses);
    const mapped = allMetrics.map((metric) => {
      const cost = metric.sku?.costs[0];
      const landedUnitCost = cost ? Number(cost.amount) + Number(cost.packagingCost) + Number(cost.warehouseLogisticsCost) + Number(cost.additionalCost) : 0;
      const price = Number(metric.sku?.price || 0);
      const hasCost = landedUnitCost > 0;
      const hasPrice = price > 0;
      const productExternalId = metric.productExternalId || metric.sku?.product.externalId || null;
      const advertisingRate = advertisingRates.get(String(productExternalId || ''));
      const advertisingPercent = advertisingRate?.percent ?? null;
      const calculated = calculateInventoryAnalytics({
        endingSoon: metric.endingSoon,
        coverageIndicator: metric.coverageIndicator,
        coverageDays: metric.coverageDays,
        recommendedSupply: metric.recommendedSupply,
        sellerFbsStock: metric.sellerFbsStock,
        marketplaceTotal: metric.marketplaceTotal,
        inSupply: metric.inSupply,
        availableForSale: metric.availableForSale,
        toCustomer: metric.toCustomer,
        fromCustomer: metric.fromCustomer,
        longTermStorage: metric.longTermStorage,
        photoStudio: metric.photoStudio,
        defective: metric.defective,
        potentialPayoutUnit: Number(metric.potentialPayoutUnit),
        potentialPayoutTotal: Number(metric.potentialPayoutTotal),
      }, { price, landedUnitCost, hasCost, hasPrice, taxPercent, advertisingPercent: advertisingPercent ?? 0 });
      return {
        id: metric.id,
        productTitle: metric.productTitle,
        productExternalId,
        sellerSku: metric.sellerSku,
        barcode: metric.barcode,
        skuMatched: Boolean(metric.skuId),
        hasCost,
        hasPrice,
        potentialNetProfitKnown: calculated.potentialNetProfitKnown && Boolean(advertisingRate),
        price,
        advertisingPercent,
        advertisingRateKnown: Boolean(advertisingRate),
        advertisingObservedAt: advertisingRate?.observedAt ?? null,
        advertisingSource: advertisingRate ? 'UZUM_EXPENSE' : 'NOT_OBSERVED',
        landedUnitCost,
        endingSoon: metric.endingSoon,
        overstock: calculated.overstock,
        coverageIndicator: metric.coverageIndicator,
        stockoutAt: metric.stockoutAt,
        coverageDays: metric.coverageDays,
        recommendedSupply: metric.recommendedSupply,
        targetMarketplaceStock: calculated.targetMarketplaceStock,
        targetStockInvestment: calculated.targetStockInvestment,
        sellerFbsStock: metric.sellerFbsStock,
        marketplaceTotal: metric.marketplaceTotal,
        inSupply: metric.inSupply,
        availableForSale: metric.availableForSale,
        toCustomer: metric.toCustomer,
        fromCustomer: metric.fromCustomer,
        returnShare: calculated.returnShare,
        longTermStorage: metric.longTermStorage,
        photoStudio: metric.photoStudio,
        defective: metric.defective,
        potentialPayoutUnit: Number(metric.potentialPayoutUnit),
        potentialPayoutTotal: Number(metric.potentialPayoutTotal),
        stockCost: calculated.stockCost,
        potentialNetProfit: calculated.potentialNetProfit,
        recommendedPotentialPayout: calculated.recommendedPotentialPayout,
        recommendedPotentialProfit: calculated.recommendedPotentialProfit,
        potentialStockRoi: calculated.potentialStockRoi,
        recommendedSupplyRoi: calculated.recommendedSupplyRoi,
        potentialMargin: calculated.potentialMargin,
        sellableShare: calculated.sellableShare,
        blockedUnits: calculated.blockedUnits,
        nonSellableCapital: calculated.nonSellableCapital,
      };
    });

    const needle = String(search || '').trim().toLowerCase();
    const rows = mapped.filter((row) => {
      const matchesText = !needle || [row.sellerSku, row.barcode, row.productTitle, row.productExternalId].some((value) => String(value || '').toLowerCase().includes(needle));
      const matchesStatus = !status
        || (status === 'SUPPLY' && row.recommendedSupply > 0)
        || (status === 'ENDING' && row.endingSoon)
        || (status === 'OVERSTOCK' && row.overstock)
        || (status === 'DEFECT' && row.defective > 0)
        || (status === 'NEGATIVE' && row.potentialPayoutUnit < 0);
      return matchesText && matchesStatus;
    }).sort((a, b) => Number(b.endingSoon) - Number(a.endingSoon) || a.coverageDays - b.coverageDays || b.recommendedSupply - a.recommendedSupply);

    const total = (key: keyof typeof mapped[number], source = mapped) => source.reduce((sum, row) => sum + Number(row[key] || 0), 0);
    const marketplaceTotal = total('marketplaceTotal');
    const knownProfitRows = mapped.filter((row) => row.potentialNetProfitKnown);
    const overstockRows = mapped.filter((row) => row.overstock);
    const endingRows = mapped.filter((row) => row.endingSoon);
    return {
      empty: false,
      report: { id: latest.id, fileName: latest.fileName, reportAsOf: latest.reportAsOf, importedAt: latest.importedAt, rowCount: latest.rowCount },
      financialSettings: { taxPercent, advertisingPercent: null, advertisingMode: 'UZUM_PRODUCT_FACT' },
      summary: {
        skuCount: mapped.length,
        endingSoonSkus: endingRows.length,
        supplySkus: mapped.filter((row) => row.recommendedSupply > 0).length,
        overstockSkus: overstockRows.length,
        recommendedSupply: total('recommendedSupply'),
        targetMarketplaceStock: total('targetMarketplaceStock'),
        marketplaceTotal,
        availableForSale: total('availableForSale'),
        toCustomer: total('toCustomer'),
        fromCustomer: total('fromCustomer'),
        defective: total('defective'),
        potentialPayout: total('potentialPayoutTotal'),
        advertisedSkus: mapped.filter((row) => (row.advertisingPercent ?? 0) > 0).length,
        advertisingRateCoverage: mapped.length ? mapped.filter((row) => row.advertisingRateKnown).length / mapped.length * 100 : 0,
        negativePayoutSkus: mapped.filter((row) => row.potentialPayoutUnit < 0).length,
        matchedRows: mapped.filter((row) => row.skuMatched).length,
        rowsWithoutCost: mapped.filter((row) => !row.hasCost).length,
        rowsWithoutPrice: mapped.filter((row) => !row.hasPrice).length,
        stockCost: total('stockCost'),
        supplyInvestment: total('targetStockInvestment'),
        potentialNetProfit: total('potentialNetProfit', knownProfitRows),
        recommendedPotentialProfit: total('recommendedPotentialProfit', knownProfitRows),
        potentialProfitCoverage: mapped.length ? knownProfitRows.length / mapped.length * 100 : 0,
        frozenOverstockCapital: total('stockCost', overstockRows),
        atRiskPayout: total('potentialPayoutTotal', endingRows),
        returnShare: marketplaceTotal > 0 ? total('fromCustomer') / marketplaceTotal * 100 : 0,
        defectShare: marketplaceTotal > 0 ? total('defective') / marketplaceTotal * 100 : 0,
        medianCoverageDays: median(mapped.map((row) => row.coverageDays).filter((value) => value > 0)),
        sellableShare: marketplaceTotal > 0 ? total('availableForSale') / marketplaceTotal * 100 : 0,
        blockedUnits: total('blockedUnits'),
        nonSellableCapital: total('nonSellableCapital'),
        potentialStockRoi: total('stockCost', knownProfitRows) > 0 ? total('potentialNetProfit', knownProfitRows) / total('stockCost', knownProfitRows) * 100 : 0,
        recommendedSupplyRoi: total('targetStockInvestment', knownProfitRows) > 0 ? total('recommendedPotentialProfit', knownProfitRows) / total('targetStockInvestment', knownProfitRows) * 100 : 0,
      },
      rows,
    };
  }
}
