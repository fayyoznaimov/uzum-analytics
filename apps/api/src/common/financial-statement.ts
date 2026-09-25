import { createHash } from 'crypto';
import ExcelJS from 'exceljs';
import { parseAdvertisingPercent } from './advertising';

export const FINANCIAL_STATEMENT_SHEETS = {
  income: 'Доходы - Daromad',
  expenses: 'Расходы - Xarajatlar',
  withdrawals: 'Выводы - Yechib olish',
  monthly: 'Помесячно - Oylar bo\'yicha',
  balance: 'Баланс - Balans',
} as const;

export type FinancialStatementSheetName =
  (typeof FINANCIAL_STATEMENT_SHEETS)[keyof typeof FINANCIAL_STATEMENT_SHEETS];

export type FinancialStatementIncomeStatus =
  | 'processing'
  | 'available'
  | 'withdrawn'
  | 'return'
  | 'unknown';

export type FinancialStatementExpenseType = 'charge' | 'refund' | 'unknown';

export type FinancialStatementWithdrawalStatus =
  | 'created'
  | 'approved'
  | 'completed'
  | 'rejected'
  | 'unknown';

export type FinancialStatementIncomeRow = {
  rowNumber: number;
  orderId: string;
  shopId: string | null;
  productId: string | null;
  productTitle: string;
  status: FinancialStatementIncomeStatus;
  statusRaw: string;
  purchasedAt: Date | null;
  issuedAt: Date | null;
  quantity: number;
  returnedQuantity: number;
  salePrice: number;
  purchasePrice: number;
  sellerDiscount: number;
  platformFee: number;
  logisticsFee: number;
  payout: number;
  withdrawn: number;
  vatType: string | null;
  returnReason: string | null;
  returnComment: string | null;
};

export type FinancialStatementExpenseRow = {
  rowNumber: number;
  serviceAt: Date | null;
  paymentType: FinancialStatementExpenseType;
  paymentTypeRaw: string;
  serviceName: string;
  source: string | null;
  unitPrice: number;
  quantity: number;
  total: number;
  status: string | null;
  statusRaw: string;
  orderId: string | null;
  productId: string | null;
  promotionPercent: number | null;
};

export type FinancialStatementWithdrawalRow = {
  rowNumber: number;
  withdrawalId: string;
  mode: string | null;
  modeRaw: string;
  amount: number;
  feePercent: number | null;
  netAmount: number | null;
  createdAt: Date | null;
  period: string | null;
  status: FinancialStatementWithdrawalStatus;
  statusRaw: string;
  rejectionReason: string | null;
};

export type FinancialStatementMonthlyRow = {
  rowNumber: number;
  month: string;
  orderCount: number;
  orderIncome: number;
  orderReturns: number;
  withdrawn: number;
  serviceFees: number;
  endingBalance: number;
};

export type FinancialStatementBalanceRow = {
  rowNumber: number;
  section: string | null;
  metric: string;
  value: number | null;
  formula: string | null;
  checkValue: number | null;
  checkFormula: string | null;
};

export type FinancialStatementStatusTotal = {
  rows: number;
  quantity: number;
  returnedQuantity: number;
  payout: number;
  withdrawn: number;
};

export type FinancialStatementSummary = {
  incomeRowCount: number;
  uniqueOrderCount: number;
  quantity: number;
  returnedQuantity: number;
  grossSales: number;
  purchaseTotal: number;
  sellerDiscount: number;
  platformFees: number;
  logisticsFees: number;
  totalPayout: number;
  returnPayout: number;
  incomeExcludingReturns: number;
  processingPayout: number;
  availablePayout: number;
  withdrawnPayout: number;
  totalWithdrawn: number;
  expenseRowCount: number;
  expenseCharges: number;
  /** Signed value as it appears in the statement (normally negative). */
  expenseRefunds: number;
  netExpenses: number;
  withdrawalRowCount: number;
  withdrawalAmount: number;
  withdrawalNetAmount: number;
  completedWithdrawalAmount: number;
  completedWithdrawalNetAmount: number;
  returnRowCount: number;
  returnsWithReason: number;
  returnsWithComment: number;
  returnReasons: Record<string, number>;
  statusTotals: Record<FinancialStatementIncomeStatus, FinancialStatementStatusTotal>;
  /** Income excluding returns, less withdrawn income and net service expenses. */
  overallBalance: number;
  /** Balance that can be withdrawn now, after also excluding processing income. */
  availableEarly: number;
  reportedEndingBalance: number | null;
};

export type ParsedFinancialStatement = {
  reportAsOf: Date | null;
  incomeAsOf: Date | null;
  expensesAsOf: Date | null;
  reportedTimeZone: string | null;
  incomeRows: FinancialStatementIncomeRow[];
  expenseRows: FinancialStatementExpenseRow[];
  withdrawalRows: FinancialStatementWithdrawalRow[];
  monthlyRows: FinancialStatementMonthlyRow[];
  balanceRows: FinancialStatementBalanceRow[];
  summary: FinancialStatementSummary;
  sourceHash: string;
};

export type FinancialStatementMatrices = Record<FinancialStatementSheetName, unknown[][]>;

const INCOME_HEADERS = {
  orderId: 'ID заказа',
  shopId: 'ID магазина',
  productId: 'ID товара',
  productTitle: 'Название товара',
  status: 'Статус',
  purchasedAt: 'Дата покупки',
  issuedAt: 'Дата выдачи',
  quantity: 'Количество',
  returnedQuantity: 'Возвращено',
  salePrice: 'Цена продажи',
  purchasePrice: 'Закупочная цена',
  sellerDiscount: 'Скидка продавца',
  platformFee: 'Плата за услуги платформы',
  logisticsFee: 'Плата за логистику',
  payout: 'Сумма к выводу',
  withdrawn: 'Выведено',
  vatType: 'Тип НДС',
  returnReason: 'Причина возврата',
  returnComment: 'Комментарий к возврату',
} as const;

const EXPENSE_HEADERS = {
  serviceAt: 'Дата услуги',
  paymentType: 'Тип платежа',
  serviceName: 'Название услуги',
  source: 'Источник',
  unitPrice: 'Цена за единицу',
  quantity: 'Количество',
  total: 'Итого',
  status: 'Статус',
} as const;

const WITHDRAWAL_HEADERS = {
  withdrawalId: 'ID вывода',
  mode: 'Режим вывода',
  amount: 'Сумма вывода',
  feePercent: 'Плата за вывод, %',
  netAmount: 'К зачислению на счёт',
  createdAt: 'Дата создания',
  period: 'Период вывода',
  status: 'Статус',
  rejectionReason: 'Причина отказа',
} as const;

const MONTHLY_HEADERS = {
  month: 'Месяц',
  orderCount: 'Заказов',
  orderIncome: 'Доход по заказам',
  orderReturns: 'Возвраты заказов',
  withdrawn: 'Выведено',
  serviceFees: 'Плата за услуги',
  endingBalance: 'Баланс на конец месяца',
} as const;

const BALANCE_HEADERS = {
  section: 'Раздел',
  metric: 'Метрика',
  value: 'Значение',
  check: 'Сверка и комментарий',
} as const;

const REQUIRED_INCOME_HEADERS = [
  INCOME_HEADERS.orderId,
  INCOME_HEADERS.status,
  INCOME_HEADERS.quantity,
  INCOME_HEADERS.returnedQuantity,
  INCOME_HEADERS.payout,
  INCOME_HEADERS.withdrawn,
];

const REQUIRED_EXPENSE_HEADERS = [
  EXPENSE_HEADERS.serviceAt,
  EXPENSE_HEADERS.paymentType,
  EXPENSE_HEADERS.total,
];

const REQUIRED_WITHDRAWAL_HEADERS = [
  WITHDRAWAL_HEADERS.withdrawalId,
  WITHDRAWAL_HEADERS.amount,
  WITHDRAWAL_HEADERS.status,
];

const REQUIRED_MONTHLY_HEADERS = [MONTHLY_HEADERS.month, MONTHLY_HEADERS.endingBalance];
const REQUIRED_BALANCE_HEADERS = [BALANCE_HEADERS.metric, BALANCE_HEADERS.value];

function scalar(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const cell = value as Record<string, unknown>;
    if ('result' in cell) return scalar(cell.result);
    if (typeof cell.text === 'string') return cell.text;
    if (Array.isArray(cell.richText)) {
      return cell.richText
        .map((part) =>
          part && typeof part === 'object' && 'text' in part
            ? String((part as { text: unknown }).text ?? '')
            : '',
        )
        .join('');
    }
  }
  return value;
}

function text(value: unknown): string {
  const parsed = scalar(value);
  if (parsed === null || parsed === undefined) return '';
  return String(parsed).trim();
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

function number(value: unknown): number {
  const parsed = scalar(value);
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
  const normalized = String(parsed ?? '')
    .replace(/\u2212/g, '-')
    .replace(/[\s\u00a0]/g, '')
    .replace(',', '.');
  const result = Number(normalized);
  return Number.isFinite(result) ? result : 0;
}

function nullableNumber(value: unknown): number | null {
  const parsed = scalar(value);
  if (parsed === null || parsed === undefined || String(parsed).trim() === '') return null;
  if (typeof parsed === 'object') return null;
  const result = number(parsed);
  return Number.isFinite(result) ? result : null;
}

function integer(value: unknown): number {
  return Math.max(0, Math.round(number(value)));
}

function normalize(value: unknown): string {
  return text(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function primaryLabel(value: unknown): string {
  return text(value).split(/\s+\/\s+/u)[0].trim();
}

function headerKey(value: unknown): string {
  return normalize(primaryLabel(value));
}

function date(value: unknown): Date | null {
  const parsed = scalar(value);
  if (!parsed) return null;
  if (parsed instanceof Date) {
    return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getTime());
  }
  if (typeof parsed === 'number' && Number.isFinite(parsed)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const result = new Date(excelEpoch + parsed * 86_400_000);
    return Number.isNaN(result.getTime()) ? null : result;
  }

  const raw = text(parsed);
  const ymd = raw.match(
    /^(\d{4})[-.](\d{2})[-.](\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  const dmy = raw.match(
    /^(\d{2})[-.](\d{2})[-.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  const match = ymd ?? dmy;
  if (match) {
    const year = Number(ymd ? match[1] : match[3]);
    const month = Number(match[2]);
    const day = Number(ymd ? match[3] : match[1]);
    const hour = Number(match[4] ?? 0);
    const minute = Number(match[5] ?? 0);
    const second = Number(match[6] ?? 0);
    const result = new Date(Date.UTC(year, month - 1, day, hour - 5, minute, second));
    return Number.isNaN(result.getTime()) ? null : result;
  }

  const result = new Date(raw);
  return Number.isNaN(result.getTime()) ? null : result;
}

function formula(value: unknown): string | null {
  if (!value || typeof value !== 'object' || value instanceof Date) return null;
  const cell = value as Record<string, unknown>;
  if (typeof cell.formula === 'string') return cell.formula;
  if (typeof cell.sharedFormula === 'string') return cell.sharedFormula;
  return null;
}

type HeaderLookup = {
  headerIndex: number;
  indexes: Map<string, number>;
};

function findHeaders(
  matrix: unknown[][],
  requiredHeaders: readonly string[],
  sheetName: string,
): HeaderLookup {
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
    const indexes = new Map<string, number>();
    matrix[rowIndex].forEach((value, columnIndex) => {
      const key = headerKey(value);
      if (key) indexes.set(key, columnIndex);
    });
    if (requiredHeaders.every((header) => indexes.has(normalize(header)))) {
      return { headerIndex: rowIndex, indexes };
    }
  }
  throw new Error(
    `На листе «${sheetName}» не найдена строка заголовков: ${requiredHeaders.join(', ')}`,
  );
}

function get(row: unknown[], lookup: HeaderLookup, header: string): unknown {
  const index = lookup.indexes.get(normalize(header));
  return index === undefined ? null : row[index];
}

function incomeStatus(value: unknown): FinancialStatementIncomeStatus {
  const status = normalize(primaryLabel(value));
  if (status === 'в обработке' || status === 'qayta ishlanmoqda') return 'processing';
  if (status === 'доступен к выводу' || status === 'yechishga tayyor') return 'available';
  if (status === 'выведен' || status === 'yechib olingan') return 'withdrawn';
  if (status === 'возврат' || status === 'qaytarish') return 'return';
  return 'unknown';
}

function expenseType(value: unknown): FinancialStatementExpenseType {
  const type = normalize(primaryLabel(value));
  if (type === 'расход' || type === 'xarajat') return 'charge';
  if (type === 'возврат' || type === 'qaytarish') return 'refund';
  return 'unknown';
}

function withdrawalStatus(value: unknown): FinancialStatementWithdrawalStatus {
  const status = normalize(value);
  if (status.startsWith('created')) return 'created';
  if (status.startsWith('approved')) return 'approved';
  if (status.startsWith('completed')) return 'completed';
  if (status.startsWith('rejected')) return 'rejected';
  return 'unknown';
}

function extractExpenseAttributes(serviceName: string): {
  orderId: string | null;
  productId: string | null;
  promotionPercent: number | null;
} {
  const orderId =
    serviceName.match(/(?:заказ(?:у|а)?|buyurtma)\s*(?:№|#)?\s*(\d+)/iu)?.[1] ?? null;
  const productId =
    serviceName.match(/(?:ID\s+товара|Tovar\s+ID)\s*(?:—|–|-|:|№)?\s*(\d+)/iu)?.[1] ?? null;
  return {
    orderId,
    productId,
    promotionPercent: parseAdvertisingPercent(serviceName),
  };
}

function parseIncomeRows(matrix: unknown[][]): FinancialStatementIncomeRow[] {
  const lookup = findHeaders(
    matrix,
    REQUIRED_INCOME_HEADERS,
    FINANCIAL_STATEMENT_SHEETS.income,
  );
  const rows: FinancialStatementIncomeRow[] = [];
  for (let index = lookup.headerIndex + 1; index < matrix.length; index++) {
    const source = matrix[index];
    const orderId = text(get(source, lookup, INCOME_HEADERS.orderId));
    if (!orderId) continue;
    const statusRaw = text(get(source, lookup, INCOME_HEADERS.status));
    rows.push({
      rowNumber: index + 1,
      orderId,
      shopId: nullableText(get(source, lookup, INCOME_HEADERS.shopId)),
      productId: nullableText(get(source, lookup, INCOME_HEADERS.productId)),
      productTitle: text(get(source, lookup, INCOME_HEADERS.productTitle)),
      status: incomeStatus(statusRaw),
      statusRaw,
      purchasedAt: date(get(source, lookup, INCOME_HEADERS.purchasedAt)),
      issuedAt: date(get(source, lookup, INCOME_HEADERS.issuedAt)),
      quantity: integer(get(source, lookup, INCOME_HEADERS.quantity)),
      returnedQuantity: integer(get(source, lookup, INCOME_HEADERS.returnedQuantity)),
      salePrice: number(get(source, lookup, INCOME_HEADERS.salePrice)),
      purchasePrice: number(get(source, lookup, INCOME_HEADERS.purchasePrice)),
      sellerDiscount: number(get(source, lookup, INCOME_HEADERS.sellerDiscount)),
      platformFee: number(get(source, lookup, INCOME_HEADERS.platformFee)),
      logisticsFee: number(get(source, lookup, INCOME_HEADERS.logisticsFee)),
      payout: number(get(source, lookup, INCOME_HEADERS.payout)),
      withdrawn: number(get(source, lookup, INCOME_HEADERS.withdrawn)),
      vatType: nullableText(get(source, lookup, INCOME_HEADERS.vatType)),
      returnReason: nullableText(get(source, lookup, INCOME_HEADERS.returnReason)),
      returnComment: nullableText(get(source, lookup, INCOME_HEADERS.returnComment)),
    });
  }
  return rows;
}

function parseExpenseRows(matrix: unknown[][]): FinancialStatementExpenseRow[] {
  const lookup = findHeaders(
    matrix,
    REQUIRED_EXPENSE_HEADERS,
    FINANCIAL_STATEMENT_SHEETS.expenses,
  );
  const rows: FinancialStatementExpenseRow[] = [];
  for (let index = lookup.headerIndex + 1; index < matrix.length; index++) {
    const source = matrix[index];
    const serviceAtValue = get(source, lookup, EXPENSE_HEADERS.serviceAt);
    const serviceName = text(get(source, lookup, EXPENSE_HEADERS.serviceName));
    if (!text(serviceAtValue) && !serviceName) continue;
    const paymentTypeRaw = text(get(source, lookup, EXPENSE_HEADERS.paymentType));
    const statusRaw = text(get(source, lookup, EXPENSE_HEADERS.status));
    rows.push({
      rowNumber: index + 1,
      serviceAt: date(serviceAtValue),
      paymentType: expenseType(paymentTypeRaw),
      paymentTypeRaw,
      serviceName,
      source: nullableText(get(source, lookup, EXPENSE_HEADERS.source)),
      unitPrice: number(get(source, lookup, EXPENSE_HEADERS.unitPrice)),
      quantity: number(get(source, lookup, EXPENSE_HEADERS.quantity)),
      total: number(get(source, lookup, EXPENSE_HEADERS.total)),
      status: nullableText(primaryLabel(statusRaw)),
      statusRaw,
      ...extractExpenseAttributes(serviceName),
    });
  }
  return rows;
}

function parseWithdrawalRows(matrix: unknown[][]): FinancialStatementWithdrawalRow[] {
  const lookup = findHeaders(
    matrix,
    REQUIRED_WITHDRAWAL_HEADERS,
    FINANCIAL_STATEMENT_SHEETS.withdrawals,
  );
  const rows: FinancialStatementWithdrawalRow[] = [];
  for (let index = lookup.headerIndex + 1; index < matrix.length; index++) {
    const source = matrix[index];
    const withdrawalId = text(get(source, lookup, WITHDRAWAL_HEADERS.withdrawalId));
    if (!withdrawalId) continue;
    const statusRaw = text(get(source, lookup, WITHDRAWAL_HEADERS.status));
    const modeRaw = text(get(source, lookup, WITHDRAWAL_HEADERS.mode));
    rows.push({
      rowNumber: index + 1,
      withdrawalId,
      mode: nullableText(primaryLabel(modeRaw)),
      modeRaw,
      amount: number(get(source, lookup, WITHDRAWAL_HEADERS.amount)),
      feePercent: nullableNumber(get(source, lookup, WITHDRAWAL_HEADERS.feePercent)),
      netAmount: nullableNumber(get(source, lookup, WITHDRAWAL_HEADERS.netAmount)),
      createdAt: date(get(source, lookup, WITHDRAWAL_HEADERS.createdAt)),
      period: nullableText(get(source, lookup, WITHDRAWAL_HEADERS.period)),
      status: withdrawalStatus(statusRaw),
      statusRaw,
      rejectionReason: nullableText(get(source, lookup, WITHDRAWAL_HEADERS.rejectionReason)),
    });
  }
  return rows;
}

function parseMonthlyRows(matrix: unknown[][]): FinancialStatementMonthlyRow[] {
  const lookup = findHeaders(
    matrix,
    REQUIRED_MONTHLY_HEADERS,
    FINANCIAL_STATEMENT_SHEETS.monthly,
  );
  const rows: FinancialStatementMonthlyRow[] = [];
  for (let index = lookup.headerIndex + 1; index < matrix.length; index++) {
    const source = matrix[index];
    const month = text(get(source, lookup, MONTHLY_HEADERS.month));
    if (!month) continue;
    rows.push({
      rowNumber: index + 1,
      month,
      orderCount: integer(get(source, lookup, MONTHLY_HEADERS.orderCount)),
      orderIncome: number(get(source, lookup, MONTHLY_HEADERS.orderIncome)),
      orderReturns: number(get(source, lookup, MONTHLY_HEADERS.orderReturns)),
      withdrawn: number(get(source, lookup, MONTHLY_HEADERS.withdrawn)),
      serviceFees: number(get(source, lookup, MONTHLY_HEADERS.serviceFees)),
      endingBalance: number(get(source, lookup, MONTHLY_HEADERS.endingBalance)),
    });
  }
  return rows;
}

function parseBalanceRows(matrix: unknown[][]): FinancialStatementBalanceRow[] {
  const lookup = findHeaders(
    matrix,
    REQUIRED_BALANCE_HEADERS,
    FINANCIAL_STATEMENT_SHEETS.balance,
  );
  const rows: FinancialStatementBalanceRow[] = [];
  let section: string | null = null;
  for (let index = lookup.headerIndex + 1; index < matrix.length; index++) {
    const source = matrix[index];
    section = nullableText(primaryLabel(get(source, lookup, BALANCE_HEADERS.section))) ?? section;
    const metric = primaryLabel(get(source, lookup, BALANCE_HEADERS.metric));
    if (!metric) continue;
    const value = get(source, lookup, BALANCE_HEADERS.value);
    const check = get(source, lookup, BALANCE_HEADERS.check);
    rows.push({
      rowNumber: index + 1,
      section,
      metric,
      value: nullableNumber(value),
      formula: formula(value),
      checkValue: nullableNumber(check),
      checkFormula: formula(check),
    });
  }
  return rows;
}

function emptyStatusTotal(): FinancialStatementStatusTotal {
  return { rows: 0, quantity: 0, returnedQuantity: 0, payout: 0, withdrawn: 0 };
}

function buildSummary(
  incomeRows: FinancialStatementIncomeRow[],
  expenseRows: FinancialStatementExpenseRow[],
  withdrawalRows: FinancialStatementWithdrawalRow[],
  monthlyRows: FinancialStatementMonthlyRow[],
): FinancialStatementSummary {
  const statusTotals: Record<FinancialStatementIncomeStatus, FinancialStatementStatusTotal> = {
    processing: emptyStatusTotal(),
    available: emptyStatusTotal(),
    withdrawn: emptyStatusTotal(),
    return: emptyStatusTotal(),
    unknown: emptyStatusTotal(),
  };
  for (const row of incomeRows) {
    const status = statusTotals[row.status];
    status.rows += 1;
    status.quantity += row.quantity;
    status.returnedQuantity += row.returnedQuantity;
    status.payout += row.payout;
    status.withdrawn += row.withdrawn;
  }

  const sumIncome = (selector: (row: FinancialStatementIncomeRow) => number) =>
    incomeRows.reduce((total, row) => total + selector(row), 0);
  const sumExpenses = (selector: (row: FinancialStatementExpenseRow) => number) =>
    expenseRows.reduce((total, row) => total + selector(row), 0);
  const sumWithdrawals = (selector: (row: FinancialStatementWithdrawalRow) => number) =>
    withdrawalRows.reduce((total, row) => total + selector(row), 0);

  const totalPayout = sumIncome((row) => row.payout);
  const returnPayout = statusTotals.return.payout;
  const incomeExcludingReturns = totalPayout - returnPayout;
  const totalWithdrawn = sumIncome((row) => row.withdrawn);
  const expenseCharges = sumExpenses((row) => (row.paymentType === 'charge' ? row.total : 0));
  const expenseRefunds = sumExpenses((row) => (row.paymentType === 'refund' ? row.total : 0));
  const netExpenses = sumExpenses((row) => row.total);
  const overallBalance = incomeExcludingReturns - totalWithdrawn - netExpenses;
  const availableEarly = Math.max(
    0,
    overallBalance - statusTotals.processing.payout,
  );
  // A partial return can remain in another payout lifecycle status (for example
  // «в обработке»), so return details must not be filtered by status alone.
  const returnRows = incomeRows.filter((row) => row.status === 'return' || row.returnedQuantity > 0);
  const returnReasons: Record<string, number> = {};
  for (const row of returnRows) {
    if (!row.returnReason) continue;
    returnReasons[row.returnReason] = (returnReasons[row.returnReason] ?? 0) + 1;
  }
  const completed = withdrawalRows.filter((row) => row.status === 'completed');

  return {
    incomeRowCount: incomeRows.length,
    uniqueOrderCount: new Set(incomeRows.map((row) => row.orderId)).size,
    quantity: sumIncome((row) => row.quantity),
    returnedQuantity: sumIncome((row) => row.returnedQuantity),
    grossSales: sumIncome((row) => row.salePrice * row.quantity),
    purchaseTotal: sumIncome((row) => row.purchasePrice * row.quantity),
    sellerDiscount: sumIncome((row) => row.sellerDiscount),
    platformFees: sumIncome((row) => row.platformFee),
    logisticsFees: sumIncome((row) => row.logisticsFee),
    totalPayout,
    returnPayout,
    incomeExcludingReturns,
    processingPayout: statusTotals.processing.payout,
    availablePayout: statusTotals.available.payout,
    withdrawnPayout: statusTotals.withdrawn.payout,
    totalWithdrawn,
    expenseRowCount: expenseRows.length,
    expenseCharges,
    expenseRefunds,
    netExpenses,
    withdrawalRowCount: withdrawalRows.length,
    withdrawalAmount: sumWithdrawals((row) => row.amount),
    withdrawalNetAmount: sumWithdrawals((row) => row.netAmount ?? 0),
    completedWithdrawalAmount: completed.reduce((total, row) => total + row.amount, 0),
    completedWithdrawalNetAmount: completed.reduce((total, row) => total + (row.netAmount ?? 0), 0),
    returnRowCount: returnRows.length,
    returnsWithReason: returnRows.filter((row) => row.returnReason).length,
    returnsWithComment: returnRows.filter((row) => row.returnComment).length,
    returnReasons,
    statusTotals,
    overallBalance,
    availableEarly,
    reportedEndingBalance: monthlyRows.at(-1)?.endingBalance ?? null,
  };
}

function requireMatrix(
  matrices: Partial<FinancialStatementMatrices>,
  sheetName: FinancialStatementSheetName,
): unknown[][] {
  const matrix = matrices[sheetName];
  if (!matrix) throw new Error(`Excel-файл не содержит обязательный лист «${sheetName}»`);
  return matrix;
}

export function parseFinancialStatementMatrices(
  matrices: Partial<FinancialStatementMatrices>,
  sourceHash = '',
): ParsedFinancialStatement {
  const incomeMatrix = requireMatrix(matrices, FINANCIAL_STATEMENT_SHEETS.income);
  const expenseMatrix = requireMatrix(matrices, FINANCIAL_STATEMENT_SHEETS.expenses);
  const withdrawalMatrix = requireMatrix(matrices, FINANCIAL_STATEMENT_SHEETS.withdrawals);
  const monthlyMatrix = requireMatrix(matrices, FINANCIAL_STATEMENT_SHEETS.monthly);
  const balanceMatrix = requireMatrix(matrices, FINANCIAL_STATEMENT_SHEETS.balance);

  const incomeRows = parseIncomeRows(incomeMatrix);
  const expenseRows = parseExpenseRows(expenseMatrix);
  const withdrawalRows = parseWithdrawalRows(withdrawalMatrix);
  const monthlyRows = parseMonthlyRows(monthlyMatrix);
  const balanceRows = parseBalanceRows(balanceMatrix);
  const incomeAsOf = date(balanceMatrix[0]?.[1]);
  const expensesAsOf = date(balanceMatrix[1]?.[1]);
  const reportAsOf = [incomeAsOf, expensesAsOf]
    .filter((value): value is Date => value !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

  return {
    reportAsOf,
    incomeAsOf,
    expensesAsOf,
    reportedTimeZone: nullableText(balanceMatrix[0]?.[2] ?? balanceMatrix[1]?.[2]),
    incomeRows,
    expenseRows,
    withdrawalRows,
    monthlyRows,
    balanceRows,
    summary: buildSummary(incomeRows, expenseRows, withdrawalRows, monthlyRows),
    sourceHash,
  };
}

function worksheetMatrix(worksheet: ExcelJS.Worksheet): unknown[][] {
  const matrix: unknown[][] = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row: unknown[] = [];
    for (let column = 1; column <= worksheet.columnCount; column++) {
      const value = worksheet.getRow(rowNumber).getCell(column).value as unknown;
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        const cell = value as Record<string, unknown>;
        if (Array.isArray(cell.richText)) {
          row.push(
            cell.richText
              .map((part) =>
                part && typeof part === 'object' && 'text' in part
                  ? String((part as { text: unknown }).text ?? '')
                  : '',
              )
              .join(''),
          );
          continue;
        }
        if (typeof cell.text === 'string' && !('formula' in cell) && !('sharedFormula' in cell)) {
          row.push(cell.text);
          continue;
        }
      }
      row.push(value ?? null);
    }
    matrix.push(row);
  }
  return matrix;
}

export async function parseFinancialStatementWorkbook(
  buffer: Buffer,
): Promise<ParsedFinancialStatement> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const matrices: Partial<FinancialStatementMatrices> = {};
  for (const sheetName of Object.values(FINANCIAL_STATEMENT_SHEETS)) {
    const worksheet = workbook.worksheets.find(
      (candidate) => normalize(candidate.name) === normalize(sheetName),
    );
    if (worksheet) matrices[sheetName] = worksheetMatrix(worksheet);
  }
  const sourceHash = createHash('sha256').update(buffer).digest('hex');
  return parseFinancialStatementMatrices(matrices, sourceHash);
}
