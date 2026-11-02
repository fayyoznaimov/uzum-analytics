import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseSupplierSheets, parseSupplierWorkbook, paymentUsd, receiptUsd, summarizeSupplierLedger, supplierDay, SupplierEntryLike } from '../supplier-ledger';

const nomenclature = {
  name: 'Номенклатура',
  rows: [
    ['Код', 'Наименование', 'Цена закупки', '$'],
    [1, 'Сауна d272', 75000, 6.21],
    [3, 'лицевой d272', 23000, 1.86],
    [5, 'Самовыкуп', 30000, null],
  ],
};
const header = ['Дата', 'Код', 'Кол-во', 'Цена продажи', 'Выручка', 'Цена закупки', 'Себестоимость'];
const d = (day: string) => new Date(`${day}T00:00:00.000Z`);

describe('supplierDay', () => {
  it('понимает дату Excel, текст ДД.ММ.ГГ и серийный номер', () => {
    expect(supplierDay(d('2026-10-15'))).toBe('2026-10-15');
    expect(supplierDay('07.10.26')).toBe('2026-10-07');
    expect(supplierDay('1.2.2026')).toBe('2026-02-01');
    expect(supplierDay(46310)).toBe('2026-10-15');
    expect(supplierDay('ё')).toBeNull();
  });
});

describe('parseSupplierSheets', () => {
  it('приход — долг в $ по номенклатуре, оплата в сумах — по курсу, подытоги и заметки пропускаются', () => {
    const ledger = {
      name: 'Продажи',
      rows: [
        header,
        [d('2026-09-10'), 1, 5, null, { formula: 'IF(...)' }, { formula: 'VLOOKUP', result: 75000 }, { formula: 'C*F', result: 375000 }, { formula: 'VLOOKUP', result: 6.21 }, { formula: 'C*H', result: 31.05 }],
        [d('2026-09-10'), 3, 75],
        [null, null, null, null, null, null, null, null, 170.55],
        [null, null, null, 'цена за кг 6.9'],
        [d('2026-10-07'), null, null, null, 21800000],
        [null, null, null, null, 17000000, null, null, null, 1949, null, 4066.96, 'Перечислено на момент 7 июля'],
        [d('2026-10-15'), 5, 2],
        [d('2026-10-15'), 99, 1],
        [null, null, null, null, 'ё'],
      ],
    };
    const parsed = parseSupplierSheets([nomenclature, { name: 'Приход', rows: [['Дата', 'Код', 'Кол-во', 'Комментарий'], [d('2026-01-13'), 1, 1]] }, ledger]);
    expect(parsed.ledgerSheet).toBe('Продажи');
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items.find((item) => item.code === 5)?.priceUsd).toBeNull();
    expect(parsed.entries.map((entry) => [entry.sourceRow, entry.type, entry.day, entry.amountUsd])).toEqual([
      [2, 'RECEIPT', '2026-09-10', 31.05],
      [3, 'RECEIPT', '2026-09-10', 139.5],
      [6, 'PAYMENT', '2026-10-07', -1801.6529],
      [7, 'PAYMENT', '2026-10-07', -1404.9587],
      [8, 'RECEIPT', '2026-10-15', 0],
    ]);
    expect(parsed.entries[3].comment).toBe('Перечислено на момент 7 июля');
    expect(parsed.entries[3].rate).toBe(12100);
    expect(parsed.warnings.join('\n')).toMatch(/Строка 7: дата не указана/);
    expect(parsed.warnings.join('\n')).toMatch(/Строка 8: у кода 5 «Самовыкуп» нет цены в \$/);
    expect(parsed.warnings.join('\n')).toMatch(/Строка 9: код 99 нет в номенклатуре/);
  });

  it('без листа номенклатуры — понятная ошибка', () => {
    expect(() => parseSupplierSheets([{ name: 'Лист1', rows: [header] }])).toThrow(/Номенклатура/);
  });

  it('читает настоящий .xlsx через ExcelJS', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Номенклатура').addRows(nomenclature.rows);
    const ledger = workbook.addWorksheet('Продажи');
    ledger.addRow(header);
    ledger.addRow([d('2026-10-01'), 3, 80]);
    ledger.getCell('F2').value = { formula: 'VLOOKUP(B2,Номенклатура!$A$2:$C$100,3,FALSE)', result: 23000 } as any;
    ledger.addRow([d('2026-10-07'), null, null, null, 2420000]);
    const parsed = await parseSupplierWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), 12100);
    expect(parsed.entries.map((entry) => [entry.day, entry.type, entry.amountUsd])).toEqual([['2026-10-01', 'RECEIPT', 148.8], ['2026-10-07', 'PAYMENT', -200]]);
  });
});

describe('summarizeSupplierLedger', () => {
  const items = [
    { id: 'a', code: 1, title: 'Сауна d272', priceUzs: 75000, priceUsd: 6.21 },
    { id: 'b', code: 3, title: 'лицевой d272', priceUzs: 23000, priceUsd: 1.86 },
  ];
  let n = 0;
  const entry = (partial: Partial<SupplierEntryLike>): SupplierEntryLike => ({ id: `e${++n}`, day: '2026-10-01', type: 'RECEIPT', itemId: null, quantity: null, priceUzs: null, priceUsd: null, amountUzs: null, rate: null, amountUsd: 0, comment: null, source: 'manual', sourceRow: null, createdAt: new Date(n * 1000), ...partial });

  it('долг = приход − оплаты ± корректировки, расход меняет только остаток', () => {
    const result = summarizeSupplierLedger(items, [
      entry({ day: '2026-10-15', type: 'PAYMENT', amountUzs: 1_210_000, rate: 12100, amountUsd: paymentUsd(1_210_000, 12100) }),
      entry({ day: '2026-10-01', type: 'RECEIPT', itemId: 'a', quantity: 10, priceUzs: 75000, priceUsd: 6.21, amountUsd: receiptUsd(10, 6.21) }),
      entry({ day: '2026-10-01', type: 'RECEIPT', itemId: 'b', quantity: 100, priceUzs: 23000, priceUsd: 1.86, amountUsd: receiptUsd(100, 1.86) }),
      entry({ day: '2026-10-20', type: 'ADJUSTMENT', amountUsd: -10 }),
      entry({ day: '2026-10-21', type: 'WRITE_OFF', itemId: 'b', quantity: 40 }),
    ]);
    expect(result.summary.receivedUsd).toBe(248.1);
    expect(result.summary.receivedUzs).toBe(3_050_000);
    expect(result.summary.paidUsd).toBe(100);
    expect(result.summary.debtUsd).toBe(138.1);
    expect(result.summary.debtUzsAtLastRate).toBe(1_671_010);
    expect(result.summary.stockUnits).toBe(70);
    expect(result.rows[0].balanceUsd).toBe(138.1);
    expect(result.rows.at(-1)!.balanceUsd).toBe(62.1);
    expect(result.stock.find((line) => line.code === 3)).toMatchObject({ receivedUnits: 100, writtenOffUnits: 40, balanceUnits: 60, balanceUsd: 111.6, balanceUzs: 1_380_000 });
    expect(result.deliveries).toEqual([{ day: '2026-10-01', units: 110, usd: 248.1, uzs: 3_050_000, lines: 2 }]);
  });
});
