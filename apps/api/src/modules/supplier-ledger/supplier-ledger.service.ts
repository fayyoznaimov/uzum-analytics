import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { DEFAULT_SUPPLIER_RATE, parseSupplierWorkbook, paymentUsd, receiptUsd, roundUsd, summarizeSupplierLedger, SupplierEntryLike, SupplierEntryType } from '../../common/supplier-ledger';

export type SupplierEntryInput = { day: string; type: SupplierEntryType; code?: number; quantity?: number; amountUzs?: number; rate?: number; amountUsd?: number; comment?: string };
export type SupplierItemInput = { code: number; title: string; priceUzs: number; priceUsd?: number | null };

const n = (value: unknown) => (value === null || value === undefined ? null : Number(value));

@Injectable()
export class SupplierLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  private async activeShop() {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) throw new BadRequestException('Активный магазин не найден');
    return shop;
  }

  async overview() {
    const shop = await this.activeShop();
    const [items, entries] = await Promise.all([
      this.prisma.supplierItem.findMany({ where: { shopId: shop.id }, orderBy: { code: 'asc' } }),
      this.prisma.supplierEntry.findMany({ where: { shopId: shop.id } }),
    ]);
    const itemLikes = items.map((item: any) => ({ id: item.id, code: item.code, title: item.title, priceUzs: Number(item.priceUzs), priceUsd: n(item.priceUsd) }));
    const byId = new Map(itemLikes.map((item: any) => [item.id, item]));
    const entryLikes: SupplierEntryLike[] = entries.map((entry: any) => ({
      id: entry.id, day: entry.day, type: entry.type, itemId: entry.itemId, quantity: entry.quantity,
      priceUzs: n(entry.priceUzs), priceUsd: n(entry.priceUsd), amountUzs: n(entry.amountUzs), rate: n(entry.rate),
      amountUsd: Number(entry.amountUsd), comment: entry.comment, source: entry.source, sourceRow: entry.sourceRow, createdAt: entry.createdAt,
    }));
    const ledger = summarizeSupplierLedger(itemLikes, entryLikes);
    const withItem = <T extends { itemId: string | null }>(row: T) => ({ ...row, item: row.itemId ? byId.get(row.itemId) ?? null : null });
    return {
      ...ledger,
      rows: ledger.rows.map(withItem),
      days: ledger.days.map((day) => ({ ...day, entries: day.entries.map(withItem) })),
      items: itemLikes,
      defaultRate: ledger.summary.lastRate ?? DEFAULT_SUPPLIER_RATE,
    };
  }

  async saveItem(input: SupplierItemInput) {
    const shop = await this.activeShop();
    const data = { title: input.title.trim(), priceUzs: input.priceUzs, priceUsd: input.priceUsd ?? null };
    await this.prisma.supplierItem.upsert({ where: { shopId_code: { shopId: shop.id, code: input.code } }, create: { shopId: shop.id, code: input.code, ...data }, update: data });
    return this.overview();
  }

  /** Создаёт записи журнала одной транзакцией (приход — сразу несколько строк одной партии). */
  async addEntries(inputs: SupplierEntryInput[]) {
    const shop = await this.activeShop();
    if (!inputs.length) throw new BadRequestException('Нет строк для записи');
    const items = await this.prisma.supplierItem.findMany({ where: { shopId: shop.id } });
    const byCode = new Map(items.map((item: any) => [item.code, item]));
    const rows = inputs.map((input) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new BadRequestException('Дата должна быть в формате ГГГГ-ММ-ДД');
      const base = { shopId: shop.id, day: input.day, type: input.type, comment: input.comment?.trim() || null, source: 'manual' };
      if (input.type === 'RECEIPT' || input.type === 'WRITE_OFF') {
        const item: any = byCode.get(Number(input.code));
        if (!item) throw new BadRequestException(`Код ${input.code} нет в номенклатуре`);
        const quantity = Math.round(Number(input.quantity));
        if (!(quantity > 0)) throw new BadRequestException('Количество должно быть больше нуля');
        const priceUsd = n(item.priceUsd);
        return { ...base, itemId: item.id, quantity, priceUzs: item.priceUzs, priceUsd, amountUsd: input.type === 'RECEIPT' ? receiptUsd(quantity, priceUsd) : 0 };
      }
      if (input.type === 'PAYMENT') {
        const amountUzs = Number(input.amountUzs), rate = Number(input.rate);
        if (!(amountUzs > 0)) throw new BadRequestException('Сумма оплаты должна быть больше нуля');
        if (!(rate > 0)) throw new BadRequestException('Укажите курс $');
        return { ...base, amountUzs, rate, amountUsd: paymentUsd(amountUzs, rate) };
      }
      if (input.type === 'ADJUSTMENT') {
        const amountUsd = roundUsd(Number(input.amountUsd));
        if (!amountUsd) throw new BadRequestException('Корректировка должна быть ненулевой');
        if (!base.comment) throw new BadRequestException('Для корректировки укажите причину');
        return { ...base, amountUsd };
      }
      throw new BadRequestException('Неизвестный тип записи');
    });
    await this.prisma.$transaction(rows.map((data) => this.prisma.supplierEntry.create({ data })));
    return this.overview();
  }

  async deleteEntry(id: string) {
    const shop = await this.activeShop();
    const entry = await this.prisma.supplierEntry.findFirst({ where: { id, shopId: shop.id } });
    if (!entry) throw new NotFoundException('Запись не найдена');
    await this.prisma.supplierEntry.delete({ where: { id } });
    return this.overview();
  }

  /** Загружает таблицу целиком: номенклатура обновляется по коду, ранее импортированные из Excel строки заменяются; ручные записи остаются. */
  async import(file?: Express.Multer.File, rateInput?: string) {
    if (!file?.buffer?.length) throw new BadRequestException('Выберите файл .xlsx');
    const rate = rateInput ? Number(String(rateInput).replace(/\s/g, '').replace(',', '.')) : DEFAULT_SUPPLIER_RATE;
    if (!(rate > 0)) throw new BadRequestException('Курс должен быть больше нуля');
    let parsed;
    try { parsed = await parseSupplierWorkbook(file.buffer, rate); } catch (error: any) { throw new BadRequestException(error?.message || 'Не удалось прочитать таблицу'); }
    if (!parsed.entries.length) throw new BadRequestException('В таблице не найдено ни прихода, ни оплат');
    const shop = await this.activeShop();
    await this.prisma.$transaction(async (tx: any) => {
      for (const item of parsed.items) {
        const data = { title: item.title, priceUzs: item.priceUzs, priceUsd: item.priceUsd };
        await tx.supplierItem.upsert({ where: { shopId_code: { shopId: shop.id, code: item.code } }, create: { shopId: shop.id, code: item.code, ...data }, update: data });
      }
      const items = await tx.supplierItem.findMany({ where: { shopId: shop.id } });
      const idByCode = new Map(items.map((item: any) => [item.code, item.id]));
      await tx.supplierEntry.deleteMany({ where: { shopId: shop.id, source: 'excel' } });
      await tx.supplierEntry.createMany({ data: parsed.entries.map(({ code, ...entry }) => ({ ...entry, shopId: shop.id, itemId: code === null ? null : idByCode.get(code) ?? null, source: 'excel' })) });
    });
    return {
      ...(await this.overview()),
      imported: { sheet: parsed.ledgerSheet, items: parsed.items.length, receipts: parsed.entries.filter((entry) => entry.type === 'RECEIPT').length, payments: parsed.entries.filter((entry) => entry.type === 'PAYMENT').length, rate, warnings: parsed.warnings },
    };
  }
}
