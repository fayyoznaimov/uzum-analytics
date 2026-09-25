import { createHash } from 'crypto';
import ExcelJS from 'exceljs';

export type ParsedInventoryRow = {
  shopName: string;
  productTitle: string;
  productExternalId: string | null;
  sellerSku: string;
  barcode: string | null;
  endingSoon: boolean;
  coverageIndicator: string | null;
  stockoutAt: Date | null;
  coverageDays: number;
  recommendedSupply: number;
  sellerFbsStock: number;
  marketplaceTotal: number;
  inSupply: number;
  availableForSale: number;
  toCustomer: number;
  fromCustomer: number;
  longTermStorage: number;
  photoStudio: number;
  defective: number;
  potentialPayoutUnit: number;
  potentialPayoutTotal: number;
};

export type ParsedInventoryReport = {
  reportAsOf: Date | null;
  rows: ParsedInventoryRow[];
  sourceHash: string;
};

const H = {
  shop: 'магазин',
  title: 'название товара',
  productId: 'id товара',
  sku: 'sku',
  barcode: 'штрихкод',
  ending: 'заканчивается',
  indicator: 'индикатор обеспеченности',
  stockout: 'плановая дата, когда закончатся текущие остатки',
  coverage: 'обеспеченность (на сколько дней хватит текущих остатков), дней',
  recommended: 'рекомендованное количество на поставку, шт',
  sellerFbs: 'на вашей стороне (на складе fbs), шт',
  marketplaceTotal: 'на стороне маркетплейса (всего в продаже, в пути, на складах и фотостудии), шт',
  inSupply: 'в поставке (создана накладная), шт',
  available: 'в продаже, шт',
  toCustomer: 'в пути до клиента (в логистике), шт',
  fromCustomer: 'в пути от клиента (возвраты и отказы), шт',
  longTerm: 'на складе длительного хранения (сдх), шт',
  photo: 'на фотостудии, шт',
  defective: 'брак на складе, шт',
  payoutUnit: 'потенциальная сумма к получению за 1 шт, сум',
  payoutTotal: 'потенциальная сумма к получению за все остатки, сум',
} as const;

function normalizeHeader(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function number(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = String(value ?? '').replace(/\s/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value: unknown): number {
  return Math.max(0, Math.round(number(value)));
}

function date(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const parsed = new Date(excelEpoch.getTime() + value * 86400000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const raw = text(value);
  const ru = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const parsed = ru ? new Date(`${ru[3]}-${ru[2]}-${ru[1]}T00:00:00+05:00`) : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function cellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value as any;
  if (value && typeof value === 'object') {
    if ('result' in value) return value.result;
    if ('text' in value) return value.text;
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((x: any) => x.text).join('');
  }
  return value;
}

function parseReportAsOf(value: unknown): Date | null {
  const raw = text(value);
  const match = raw.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?\s+(\d{1,2}):(\d{2})/i);
  if (!match) return null;
  const months: Record<string, number> = { января:0, февраля:1, марта:2, апреля:3, мая:4, июня:5, июля:6, августа:7, сентября:8, октября:9, ноября:10, декабря:11 };
  const month = months[match[2].toLowerCase()];
  if (month === undefined) return null;
  const year = Number(match[3] || new Date().getFullYear());
  return new Date(Date.UTC(year, month, Number(match[1]), Number(match[4]) - 5, Number(match[5])));
}

export function parseInventoryMatrix(matrix: unknown[][], sourceHash = ''): ParsedInventoryReport {
  const headerIndex = matrix.findIndex((row) => row.some((value) => normalizeHeader(value) === H.sku));
  if (headerIndex < 0) throw new Error('В отчёте не найдена строка заголовков со столбцом SKU');
  const headers = matrix[headerIndex].map(normalizeHeader);
  const index = (name: string) => headers.indexOf(name);
  const required = [H.title, H.sku, H.marketplaceTotal, H.recommended, H.payoutTotal];
  const missing = required.filter((name) => index(name) < 0);
  if (missing.length) throw new Error(`В отчёте отсутствуют обязательные столбцы: ${missing.join(', ')}`);

  const get = (row: unknown[], name: string) => {
    const i = index(name);
    return i >= 0 ? row[i] : null;
  };

  const rows: ParsedInventoryRow[] = [];
  for (const row of matrix.slice(headerIndex + 1)) {
    const sellerSku = text(get(row, H.sku));
    if (!sellerSku) continue;
    rows.push({
      shopName: text(get(row, H.shop)),
      productTitle: text(get(row, H.title)) || 'Без названия',
      productExternalId: text(get(row, H.productId)) || null,
      sellerSku,
      barcode: text(get(row, H.barcode)) || null,
      endingSoon: text(get(row, H.ending)).toLowerCase() === 'да',
      coverageIndicator: text(get(row, H.indicator)) || null,
      stockoutAt: date(get(row, H.stockout)),
      coverageDays: integer(get(row, H.coverage)),
      recommendedSupply: integer(get(row, H.recommended)),
      sellerFbsStock: integer(get(row, H.sellerFbs)),
      marketplaceTotal: integer(get(row, H.marketplaceTotal)),
      inSupply: integer(get(row, H.inSupply)),
      availableForSale: integer(get(row, H.available)),
      toCustomer: integer(get(row, H.toCustomer)),
      fromCustomer: integer(get(row, H.fromCustomer)),
      longTermStorage: integer(get(row, H.longTerm)),
      photoStudio: integer(get(row, H.photo)),
      defective: integer(get(row, H.defective)),
      potentialPayoutUnit: number(get(row, H.payoutUnit)),
      potentialPayoutTotal: number(get(row, H.payoutTotal)),
    });
  }
  if (!rows.length) throw new Error('В отчёте не найдено ни одной строки SKU');
  const reportAsOf = headerIndex > 0 ? parseReportAsOf(matrix[0]?.[0]) : null;
  return { reportAsOf, rows, sourceHash };
}

export async function parseInventoryWorkbook(buffer: Buffer): Promise<ParsedInventoryReport> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('Excel-файл не содержит листов');
  const matrix: unknown[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values: unknown[] = [];
    for (let col = 1; col <= worksheet.columnCount; col++) values.push(cellValue(row.getCell(col)));
    matrix.push(values);
  });
  const sourceHash = createHash('sha256').update(buffer).digest('hex');
  return parseInventoryMatrix(matrix, sourceHash);
}
