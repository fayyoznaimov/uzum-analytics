import ExcelJS from 'exceljs';

// Расчёты с компанией-поставщиком (таблица «GoogleSheets_Приход-Расход-Склад»).
// Долг ведётся в долларах: приход = кол-во × цена в $, оплата в сумах переводится в $ по курсу дня оплаты.
// Расход товара (продажа/списание) уменьшает только остаток — на долг он не влияет; позже его будет присылать 1С.

export type SupplierEntryType = 'RECEIPT' | 'PAYMENT' | 'ADJUSTMENT' | 'WRITE_OFF';
export const SUPPLIER_ENTRY_TYPES: SupplierEntryType[] = ['RECEIPT', 'PAYMENT', 'ADJUSTMENT', 'WRITE_OFF'];

/** Курс, по которому таблица переводила все оплаты в $ (=SUM(E)/12100). */
export const DEFAULT_SUPPLIER_RATE = 12_100;

export type SupplierItemLike = { id: string; code: number; title: string; priceUzs: number; priceUsd: number | null };

export type SupplierEntryLike = {
  id: string;
  day: string;
  type: SupplierEntryType;
  itemId: string | null;
  quantity: number | null;
  priceUzs: number | null;
  priceUsd: number | null;
  amountUzs: number | null;
  rate: number | null;
  amountUsd: number;
  comment: string | null;
  source: string;
  sourceRow: number | null;
  createdAt: Date;
};

export const roundUsd = (value: number) => Math.round(value * 10_000) / 10_000;

/** Приход увеличивает долг на кол-во × цену в $; без цены в $ долг не растёт. */
export function receiptUsd(quantity: number, priceUsd: number | null) {
  return priceUsd === null ? 0 : roundUsd(quantity * priceUsd);
}

/** Оплата в сумах гасит долг: −сумма / курс. */
export function paymentUsd(amountUzs: number, rate: number) {
  if (!(rate > 0)) throw new Error('Курс должен быть больше нуля');
  return -roundUsd(amountUzs / rate);
}

export function compareSupplierEntries(a: SupplierEntryLike, b: SupplierEntryLike) {
  return a.day.localeCompare(b.day)
    || (a.sourceRow ?? Number.MAX_SAFE_INTEGER) - (b.sourceRow ?? Number.MAX_SAFE_INTEGER)
    || a.createdAt.getTime() - b.createdAt.getTime();
}

export function summarizeSupplierLedger(items: SupplierItemLike[], entries: SupplierEntryLike[]) {
  const sorted = [...entries].sort(compareSupplierEntries);
  const stock = new Map(items.map((item) => [item.id, { ...item, receivedUnits: 0, writtenOffUnits: 0, receivedUsd: 0 }]));
  const deliveries = new Map<string, { day: string; units: number; usd: number; uzs: number; lines: number }>();
  const summary = { receivedUnits: 0, receivedUsd: 0, receivedUzs: 0, paidUzs: 0, paidUsd: 0, adjustmentsUsd: 0, writtenOffUnits: 0, debtUsd: 0, lastRate: null as number | null, lastPaymentDay: null as string | null, lastReceiptDay: null as string | null };
  let balance = 0;
  const rows = sorted.map((entry) => {
    balance = roundUsd(balance + entry.amountUsd);
    const line = stock.get(entry.itemId ?? '');
    if (entry.type === 'RECEIPT') {
      const units = entry.quantity ?? 0;
      summary.receivedUnits += units;
      summary.receivedUsd += entry.amountUsd;
      summary.receivedUzs += units * (entry.priceUzs ?? 0);
      summary.lastReceiptDay = entry.day;
      if (line) { line.receivedUnits += units; line.receivedUsd += entry.amountUsd; }
      const delivery = deliveries.get(entry.day) || { day: entry.day, units: 0, usd: 0, uzs: 0, lines: 0 };
      delivery.units += units; delivery.usd = roundUsd(delivery.usd + entry.amountUsd); delivery.uzs += units * (entry.priceUzs ?? 0); delivery.lines += 1;
      deliveries.set(entry.day, delivery);
    } else if (entry.type === 'PAYMENT') {
      summary.paidUzs += entry.amountUzs ?? 0;
      summary.paidUsd += -entry.amountUsd;
      summary.lastRate = entry.rate ?? summary.lastRate;
      summary.lastPaymentDay = entry.day;
    } else if (entry.type === 'ADJUSTMENT') {
      summary.adjustmentsUsd += entry.amountUsd;
    } else if (entry.type === 'WRITE_OFF') {
      summary.writtenOffUnits += entry.quantity ?? 0;
      if (line) line.writtenOffUnits += entry.quantity ?? 0;
    }
    return { ...entry, balanceUsd: balance };
  });
  summary.receivedUsd = roundUsd(summary.receivedUsd);
  summary.paidUsd = roundUsd(summary.paidUsd);
  summary.adjustmentsUsd = roundUsd(summary.adjustmentsUsd);
  summary.debtUsd = balance;
  const stockRows = [...stock.values()]
    .map((line) => {
      const balanceUnits = line.receivedUnits - line.writtenOffUnits;
      return { ...line, receivedUsd: roundUsd(line.receivedUsd), balanceUnits, balanceUsd: line.priceUsd === null ? null : roundUsd(balanceUnits * line.priceUsd), balanceUzs: balanceUnits * line.priceUzs };
    })
    .filter((line) => line.receivedUnits || line.writtenOffUnits)
    .sort((a, b) => a.code - b.code);
  return {
    summary: { ...summary, stockUnits: summary.receivedUnits - summary.writtenOffUnits, debtUzsAtLastRate: summary.lastRate ? Math.round(balance * summary.lastRate) : null },
    days: supplierDays(rows),
    rows: rows.reverse(),
    stock: stockRows,
    deliveries: [...deliveries.values()].sort((a, b) => b.day.localeCompare(a.day)),
  };
}

/** По дням: сколько взял товара и сколько заплатил в этот день и какой долг остался после. Строки — по возрастанию дат, результат — новые сверху. */
export function supplierDays(rows: Array<SupplierEntryLike & { balanceUsd: number }>) {
  const days = new Map<string, { day: string; receivedUnits: number; receivedUsd: number; receivedUzs: number; paidUzs: number; paidUsd: number; adjustmentsUsd: number; writtenOffUnits: number; balanceUsd: number; entries: Array<SupplierEntryLike & { balanceUsd: number }> }>();
  for (const row of rows) {
    const day = days.get(row.day) || { day: row.day, receivedUnits: 0, receivedUsd: 0, receivedUzs: 0, paidUzs: 0, paidUsd: 0, adjustmentsUsd: 0, writtenOffUnits: 0, balanceUsd: 0, entries: [] };
    if (row.type === 'RECEIPT') { day.receivedUnits += row.quantity ?? 0; day.receivedUsd = roundUsd(day.receivedUsd + row.amountUsd); day.receivedUzs += (row.quantity ?? 0) * (row.priceUzs ?? 0); }
    if (row.type === 'PAYMENT') { day.paidUzs += row.amountUzs ?? 0; day.paidUsd = roundUsd(day.paidUsd - row.amountUsd); }
    if (row.type === 'ADJUSTMENT') day.adjustmentsUsd = roundUsd(day.adjustmentsUsd + row.amountUsd);
    if (row.type === 'WRITE_OFF') day.writtenOffUnits += row.quantity ?? 0;
    day.balanceUsd = row.balanceUsd;
    day.entries.push(row);
    days.set(row.day, day);
  }
  return [...days.values()].reverse();
}

// ---------- Импорт таблицы Excel ----------

export type ParsedSupplierItem = { code: number; title: string; priceUzs: number; priceUsd: number | null };
export type ParsedSupplierEntry = {
  sourceRow: number;
  day: string;
  type: 'RECEIPT' | 'PAYMENT';
  code: number | null;
  quantity: number | null;
  priceUzs: number | null;
  priceUsd: number | null;
  amountUzs: number | null;
  rate: number | null;
  amountUsd: number;
  comment: string | null;
};
export type ParsedSupplierWorkbook = { items: ParsedSupplierItem[]; entries: ParsedSupplierEntry[]; warnings: string[]; ledgerSheet: string };

function scalar(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const cell = value as Record<string, unknown>;
    if ('result' in cell) return scalar(cell.result);
    if ('formula' in cell || 'sharedFormula' in cell) return null;
    if (typeof cell.text === 'string') return cell.text;
    if (Array.isArray(cell.richText)) return cell.richText.map((part: any) => String(part?.text ?? '')).join('');
    if ('error' in cell) return null;
  }
  return value;
}

function text(value: unknown) {
  const parsed = scalar(value);
  return parsed === null || parsed === undefined ? '' : String(parsed).trim();
}

function num(value: unknown): number | null {
  const parsed = scalar(value);
  if (typeof parsed === 'number') return Number.isFinite(parsed) ? parsed : null;
  if (typeof parsed !== 'string' || !parsed.trim()) return null;
  const result = Number(parsed.replace(/[\s ₽$]|сум/g, '').replace(',', '.'));
  return Number.isFinite(result) ? result : null;
}

/** День YYYY-MM-DD. ExcelJS отдаёт даты как UTC-полночь; текст понимается как ДД.ММ.ГГ(ГГ). */
export function supplierDay(value: unknown): string | null {
  const parsed = scalar(value);
  if (parsed instanceof Date) return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  if (typeof parsed === 'number' && parsed > 20_000 && parsed < 80_000) return new Date(Date.UTC(1899, 11, 30) + Math.round(parsed) * 86_400_000).toISOString().slice(0, 10);
  const raw = text(parsed);
  const dmy = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return `${year}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

const key = (value: unknown) => text(value).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

function headerIndex(row: unknown[] | undefined) {
  const map = new Map<string, number>();
  (row || []).forEach((cell, index) => { const name = key(cell); if (name && !map.has(name)) map.set(name, index); });
  return map;
}

const isNomenclature = (h: Map<string, number>) => h.has('код') && h.has('наименование') && h.has('цена закупки');
const isLedger = (h: Map<string, number>) => h.has('дата') && h.has('код') && h.has('кол-во') && h.has('выручка');

/** Разбирает листы таблицы: «Номенклатура» и журнал (лист с колонками Дата/Код/Кол-во/Выручка, в файле он называется «Продажи»). */
export function parseSupplierSheets(sheets: Array<{ name: string; rows: unknown[][] }>, rate = DEFAULT_SUPPLIER_RATE): ParsedSupplierWorkbook {
  if (!(rate > 0)) throw new Error('Курс должен быть больше нуля');
  const nomenclature = sheets.find((sheet) => isNomenclature(headerIndex(sheet.rows[0])));
  if (!nomenclature) throw new Error('Не найден лист «Номенклатура» (колонки Код, Наименование, Цена закупки)');
  const ledgers = sheets.filter((sheet) => isLedger(headerIndex(sheet.rows[0])));
  const ledger = ledgers.find((sheet) => sheet.name.trim().toLowerCase() === 'продажи') || ledgers[0];
  if (!ledger) throw new Error('Не найден лист журнала (колонки Дата, Код, Кол-во, Выручка)');

  const warnings: string[] = [];
  const nh = headerIndex(nomenclature.rows[0]);
  const usdColumn = nh.get('$') ?? nh.get('цена $') ?? nh.get('цена в $');
  const items = new Map<number, ParsedSupplierItem>();
  nomenclature.rows.slice(1).forEach((row) => {
    const code = num(row[nh.get('код')!]);
    const title = text(row[nh.get('наименование')!]);
    if (code === null || !Number.isInteger(code) || !title) return;
    const priceUsd = usdColumn === undefined ? null : num(row[usdColumn]);
    items.set(code, { code, title, priceUzs: num(row[nh.get('цена закупки')!]) ?? 0, priceUsd: priceUsd && priceUsd > 0 ? priceUsd : null });
  });

  const h = headerIndex(ledger.rows[0]);
  const known = new Set([...h.values()]);
  const entries: ParsedSupplierEntry[] = [];
  let lastDay: string | null = null;
  ledger.rows.forEach((row, index) => {
    if (index === 0) return;
    const sourceRow = index + 1;
    const rawDay = supplierDay(row[h.get('дата')!]);
    const code = num(row[h.get('код')!]);
    const quantity = num(row[h.get('кол-во')!]);
    const revenue = num(row[h.get('выручка')!]);
    const notes = row.map((cell, column) => (known.has(column) ? '' : scalar(cell))).filter((cell): cell is string => typeof cell === 'string' && /\p{L}/u.test(cell)).map((cell) => cell.trim());
    const isReceipt = code !== null && quantity !== null && quantity > 0;
    const isPayment = !isReceipt && code === null && revenue !== null && revenue > 0;
    if (!isReceipt && !isPayment) { if (rawDay) lastDay = rawDay; return; }
    let day = rawDay;
    if (!day) {
      if (!lastDay) { warnings.push(`Строка ${sourceRow}: нет даты и нет строки выше — пропущена`); return; }
      day = lastDay;
      warnings.push(`Строка ${sourceRow}: дата не указана, взята из строки выше (${day.split('-').reverse().join('.')})`);
    }
    lastDay = day;
    const comment = notes.join('; ') || null;
    if (isReceipt) {
      const item = items.get(code!);
      if (!item) { warnings.push(`Строка ${sourceRow}: код ${code} нет в номенклатуре — пропущена`); return; }
      if (!Number.isInteger(quantity)) warnings.push(`Строка ${sourceRow}: дробное количество ${quantity} округлено`);
      const units = Math.round(quantity!);
      if (item.priceUsd === null) warnings.push(`Строка ${sourceRow}: у кода ${code} «${item.title}» нет цены в $ — долг не начислен`);
      entries.push({ sourceRow, day, type: 'RECEIPT', code: code!, quantity: units, priceUzs: item.priceUzs, priceUsd: item.priceUsd, amountUzs: null, rate: null, amountUsd: receiptUsd(units, item.priceUsd), comment });
    } else {
      entries.push({ sourceRow, day, type: 'PAYMENT', code: null, quantity: null, priceUzs: null, priceUsd: null, amountUzs: revenue!, rate, amountUsd: paymentUsd(revenue!, rate), comment });
    }
  });
  return { items: [...items.values()], entries, warnings, ledgerSheet: ledger.name };
}

export async function parseSupplierWorkbook(buffer: Buffer | ArrayBuffer, rate = DEFAULT_SUPPLIER_RATE) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheets = workbook.worksheets.map((sheet) => {
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows[rowNumber - 1] = values;
    });
    for (let i = 0; i < rows.length; i++) rows[i] ||= [];
    return { name: sheet.name, rows };
  });
  return parseSupplierSheets(sheets, rate);
}
