import { createHash } from 'crypto';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  FINANCIAL_STATEMENT_SHEETS,
  FinancialStatementMatrices,
  parseFinancialStatementMatrices,
  parseFinancialStatementWorkbook,
} from '../financial-statement';

const incomeHeaders = [
  'ID заказа / Buyurtma ID',
  'ID магазина / Do\'kon ID',
  'ID товара / Tovar ID',
  'Название товара / Tovar nomi',
  'Статус / Status',
  'Дата покупки / Sotib olingan sana',
  'Дата выдачи / Berilgan sana',
  'Количество / Soni',
  'Возвращено / Qaytarilgan',
  'Цена продажи / Sotuv narxi',
  'Закупочная цена / Xarid narxi',
  'Скидка продавца / Sotuvchi chegirmasi',
  'Плата за услуги платформы / Platforma xizmatlari uchun to\'lov',
  'Плата за логистику / Logistika uchun to\'lov',
  'Сумма к выводу / Yechib olish summasi',
  'Выведено / Yechib olingan',
  'Тип НДС / QQS turi',
  'Причина возврата / Qaytarish sababi',
  'Комментарий к возврату / Qaytarish izohi',
];

const expenseHeaders = [
  'Дата услуги / Xizmat sanasi',
  'Тип платежа / To\'lov turi',
  'Название услуги / Xizmat nomi',
  'Источник / Manba',
  'Цена за единицу / Birlik narxi',
  'Количество / Soni',
  'Итого / Jami',
  'Статус / Status',
];

const withdrawalHeaders = [
  'ID вывода / Yechib olish ID',
  'Режим вывода / Yechib olish rejimi',
  'Сумма вывода / Yechib olish summasi',
  'Плата за вывод, % / Yechib olish uchun to\'lov, %',
  'К зачислению на счёт / Hisobga o\'tkaziladi',
  'Дата создания / Yaratilgan sana',
  'Период вывода / Yechib olish davri',
  'Статус / Status',
  'Причина отказа / Rad etish sababi',
];

const monthlyHeaders = [
  'Месяц / Oy',
  'Заказов / Buyurtmalar',
  'Доход по заказам / Buyurtmalar daromadi',
  'Возвраты заказов / Buyurtma qaytarishlari',
  'Выведено / Yechib olingan',
  'Плата за услуги / Xizmatlar uchun to\'lov',
  'Баланс на конец месяца / Oy oxiriga balans',
];

const balanceHeaders = [
  'Раздел / Bo\'lim',
  'Метрика / Ko\'rsatkich',
  'Значение / Qiymat',
  'Сверка и комментарий / Tekshiruv va izoh',
];

function fixture(): FinancialStatementMatrices {
  return {
    [FINANCIAL_STATEMENT_SHEETS.income]: [
      ['Конфиденциальный отчёт'],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      incomeHeaders,
      ['1', 'shop', 'p1', 'Товар 1', 'в обработке / qayta ishlanmoqda', '2026-08-01 10:00:00', null, 1, 0, 1000, 500, 0, 200, 50, 750, 0, 'VAT0', null, null],
      ['2', 'shop', 'p2', 'Товар 2', 'доступен к выводу / yechishga tayyor', '2026-07-20 10:00:00', '2026-07-22 10:00:00', 1, 0, 1100, 550, 0, 250, 50, 800, 0, 'VAT0', null, null],
      ['3', 'shop', 'p3', 'Товар 3', 'выведен / yechib olingan', '2026-07-10 10:00:00', '2026-07-12 10:00:00', 1, 0, 1200, 600, 0, 250, 50, 900, 900, 'VAT0', null, null],
      ['4', 'shop', 'p4', 'Товар 4', 'возврат / qaytarish', '2026-07-01 10:00:00', null, 1, 1, 900, 450, 0, 150, 50, 700, 0, 'VAT0', 'CANCELED', 'Заказал не по тому адресу'],
    ],
    [FINANCIAL_STATEMENT_SHEETS.expenses]: [
      [],
      [],
      [],
      [],
      [],
      expenseHeaders,
      ['2026-07-31 19:21:41', 'расход / xarajat', 'Оплата Буста заказов, ID товара — 2197711. Процент за продажу — 3%.', 'Маркетинг', 100, 1, 100, 'оплачено / to\'langan'],
      ['2026-07-31 19:21:42', 'возврат / qaytarish', 'Возврат услуги логистики по заказу № 2.', 'Логистика', -20, 1, -20, 'оплачено / to\'langan'],
    ],
    [FINANCIAL_STATEMENT_SHEETS.withdrawals]: [
      [],
      [],
      [],
      withdrawalHeaders,
      ['w1', 'срочный / shoshilinch', 900, '0.00', 900, '31-07-2026 23:17:42', null, 'COMPLETED (завершена)', null],
      ['w2', 'срочный / shoshilinch', 100, '0.00', 100, '01-08-2026 09:00:00', null, 'CREATED (создана)', null],
    ],
    [FINANCIAL_STATEMENT_SHEETS.monthly]: [
      monthlyHeaders,
      ['2026-07', 4, 2450, -700, 900, 80, 1470],
    ],
    [FINANCIAL_STATEMENT_SHEETS.balance]: [
      ['Данные по доходам на', '2026-08-01 10:54:36', 'Europe/Moscow'],
      ['Данные по расходам на', '2026-08-01 10:54:35', 'Europe/Moscow'],
      [],
      balanceHeaders,
      ['1. Доходы / Daromadlar', 'По заказам / Buyurtmalar bo\'yicha', null, null],
      [null, 'Всего заказов / Jami buyurtmalar', { formula: "'Доходы - Daromad'!B8" }, null],
      ['3. Баланс / Balans', 'ДОСТУПНО в «вывести раньше»', { formula: 'MAX(0,C22-C17)' }, null],
    ],
  };
}

describe('Uzum financial statement parser', () => {
  it('parses all statement sheets, return details and reconciled totals', () => {
    const report = parseFinancialStatementMatrices(fixture(), 'source-hash');

    expect(report.sourceHash).toBe('source-hash');
    expect(report.reportAsOf?.toISOString()).toBe('2026-08-01T05:54:36.000Z');
    expect(report.incomeRows).toHaveLength(4);
    expect(report.incomeRows[3]).toMatchObject({
      orderId: '4',
      status: 'return',
      returnedQuantity: 1,
      returnReason: 'CANCELED',
      returnComment: 'Заказал не по тому адресу',
    });
    expect(report.expenseRows[0]).toMatchObject({ productId: '2197711', promotionPercent: 3 });
    expect(report.expenseRows[1]).toMatchObject({ orderId: '2', paymentType: 'refund' });
    expect(report.withdrawalRows[0]).toMatchObject({ status: 'completed', netAmount: 900 });
    expect(report.balanceRows[1].formula).toBe("'Доходы - Daromad'!B8");

    expect(report.summary).toMatchObject({
      incomeRowCount: 4,
      uniqueOrderCount: 4,
      returnedQuantity: 1,
      totalPayout: 3150,
      returnPayout: 700,
      incomeExcludingReturns: 2450,
      processingPayout: 750,
      totalWithdrawn: 900,
      expenseCharges: 100,
      expenseRefunds: -20,
      netExpenses: 80,
      overallBalance: 1470,
      availableEarly: 720,
      reportedEndingBalance: 1470,
      returnRowCount: 1,
      returnsWithReason: 1,
      returnsWithComment: 1,
      returnReasons: { CANCELED: 1 },
    });
  });

  it('loads XLSX bytes and calculates a stable SHA-256 source hash', async () => {
    const workbook = new ExcelJS.Workbook();
    for (const [sheetName, rows] of Object.entries(fixture())) {
      workbook.addWorksheet(sheetName).addRows(rows as any[][]);
    }
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const report = await parseFinancialStatementWorkbook(buffer);

    expect(report.sourceHash).toBe(createHash('sha256').update(buffer).digest('hex'));
    expect(report.incomeRows[3].returnComment).toBe('Заказал не по тому адресу');
    expect(report.monthlyRows[0].month).toBe('2026-07');
  });

  it('rejects a workbook without every required sheet', () => {
    const matrices = fixture();
    delete (matrices as Partial<FinancialStatementMatrices>)[FINANCIAL_STATEMENT_SHEETS.balance];
    expect(() => parseFinancialStatementMatrices(matrices)).toThrow(/Баланс - Balans/);
  });
});
