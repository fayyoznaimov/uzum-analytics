"use client";
import { type ChangeEvent, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, FileSpreadsheet, Info, MessageSquareText, Upload } from 'lucide-react';
import AppShell from './AppShell';
import { Status } from './UI';
import { api, apiForm, money } from '@/lib/api';
import { invalidateOverview, useOverview } from '@/lib/overview';

type StatementReturn = {
  id: string;
  orderId?: string | null;
  externalId?: string | null;
  state?: string | null;
  quantity?: number | null;
  returnedQuantity?: number | null;
  purchasedAt?: string | null;
  issuedAt?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  comment?: string | null;
  statementStatus?: string | null;
  productId?: string | null;
  sku?: string | null;
  title?: string | null;
  payout?: number | null;
  statementPayout?: number | null;
  withdrawnAmount?: number | null;
};

type StatementPayload = {
  empty?: boolean;
  duplicate?: boolean;
  latest?: {
    id: string;
    fileName: string;
    reportAsOf?: string | null;
    importedAt: string;
    summary?: Record<string, unknown> | null;
  } | null;
  returns?: StatementReturn[];
  withdrawals?: unknown[];
};

const DAY_MS = 86_400_000;
const num = (value: unknown) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(Number(value) || 0));

function dayLabel(value?: string | null, withYear = false) {
  if (!value) return '—';
  return new Date(`${value}T12:00:00+05:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' as const } : {}) });
}

function shortDate(value?: string | null) {
  if (!value) return '—';
  return new Date(`${value}T12:00:00+05:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function shiftDay(value: string, days: number) {
  return new Date(new Date(`${value}T12:00:00+05:00`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function relativeDay(value: string, today: string) {
  const delta = Math.round((new Date(`${value}T12:00:00+05:00`).getTime() - new Date(`${today}T12:00:00+05:00`).getTime()) / DAY_MS);
  if (delta === 0) return 'сегодня';
  if (delta === 1) return 'завтра';
  if (delta === -1) return 'вчера';
  return delta > 0 ? `через ${delta} дн.` : `${-delta} дн. назад`;
}

function scheduleLabel(schedule?: string) {
  if (schedule === 'DAILY') return 'каждый рабочий день';
  if (schedule === 'WEEKLY') return '7, 14, 21 и 28 числа';
  if (schedule === 'MONTHLY') return '7 числа';
  return '7 и 21 числа';
}

function basketState(row: any): { tone: string; text: string } {
  if (row.status === 'HOLD') return { tone: 'amber', text: 'Удержание' };
  if (row.status === 'NEEDS_RECONCILE') return { tone: 'red', text: 'Сверить' };
  if (row.status === 'DUE_TODAY') return { tone: 'violet', text: 'Выплата сегодня' };
  return { tone: 'green', text: 'В корзине' };
}

function payoutState(row: any): { tone: string; text: string } {
  if (row.status === 'DUE_TODAY') return { tone: 'violet', text: 'Сегодня' };
  if (row.status === 'NEEDS_RECONCILE') return { tone: 'amber', text: 'Сверить' };
  return { tone: 'blue', text: 'По графику' };
}

function statementDate(value?: string | null, withTime = false) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const statementMoney = (value: number | null) => value === null ? '—' : money(value);
const statementCount = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('ru-RU').format(value);

function returnReason(value?: string | null) {
  if (!value) return 'Причина не передана';
  const reasons: Record<string, string> = {
    CANCELED: 'Отменён до получения',
    REGULAR: 'Возврат после получения',
    CONTENT: 'Проблема с содержимым',
    WRONG_SIZE: 'Не подошёл размер',
    PHOTO_MISMATCH: 'Не соответствует фото',
    MISSING: 'Товар отсутствовал',
    WRONG_ITEM: 'Получен другой товар',
    BAD_QUALITY: 'Проблема с качеством',
  };
  return reasons[value.toUpperCase()] || value;
}

function returnStatus(value?: string | null) {
  const statuses: Record<string, string> = { CANCELED: 'Отменён', RETURNED: 'Возврат', PAID: 'Оплачен', WAITING: 'В обработке', 'возврат': 'Возврат' };
  return value ? statuses[value] || value : 'Возврат';
}

export default function WalletClient() {
  const { data, loading, error, reload } = useOverview();
  const [statement, setStatement] = useState<StatementPayload | null>(null);
  const [statementLoading, setStatementLoading] = useState(true);
  const [statementImporting, setStatementImporting] = useState(false);
  const [statementMessage, setStatementMessage] = useState('');
  const [statementError, setStatementError] = useState('');
  const [showAllDays, setShowAllDays] = useState(false);
  useEffect(() => {
    setStatementLoading(true);
    api<StatementPayload>('/financial-statements/latest?returns=100')
      .then((result) => { setStatement(result); setStatementError(''); })
      .catch((cause: Error) => setStatementError(cause.message))
      .finally(() => setStatementLoading(false));
  }, []);

  async function uploadStatement(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatementImporting(true);
    setStatementMessage('');
    setStatementError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await apiForm<StatementPayload>('/financial-statements/import', form);
      setStatement(result);
      setStatementMessage(result.duplicate ? 'Этот отчёт уже был загружен — показываем сохранённую сверку.' : 'Отчёт загружен: заказы, расходы, выплаты и возвраты сверены.');
      invalidateOverview();
      await reload();
    } catch (cause) {
      setStatementError(cause instanceof Error ? cause.message : 'Не удалось загрузить отчёт');
    } finally {
      setStatementImporting(false);
      event.target.value = '';
    }
  }

  const pf = data?.payoutForecast;
  const today: string = pf?.today || new Date().toISOString().slice(0, 10);
  const holdDays = Number(pf?.holdDays || 10);
  const basketRows: any[] = pf?.basketDailyRows || pf?.rows || [];
  const payoutRows: any[] = pf?.payoutDailyRows || [];
  const nextPayout = useMemo(() => payoutRows.find((row) => row.date >= today) || null, [payoutRows, today]);
  const holdRows = useMemo(() => basketRows.filter((row) => row.status === 'HOLD'), [basketRows]);
  const holdOrders = holdRows.reduce((sum, row) => sum + Number(row.orders || 0), 0);
  const tomorrowRow = basketRows.find((row) => row.date === shiftDay(today, 1));
  // Календарь корзины: по умолчанию неделя назад и всё будущее; прошлые дни — по кнопке.
  const calendarRows = useMemo(() => showAllDays ? basketRows : basketRows.filter((row) => row.date >= shiftDay(today, -7)), [basketRows, showAllDays, today]);
  const hiddenDays = basketRows.length - calendarRows.length;

  const statementSummary = statement?.latest?.summary || {};
  const reportedEndingBalance = firstNumber(statementSummary.reportedEndingBalance, statementSummary.overallBalance);
  const availableEarly = firstNumber(statementSummary.availableEarly, statementSummary.availableToWithdrawEarly);
  const reportRows = firstNumber(statementSummary.reportRows, statementSummary.incomeRows);
  const dbRows = firstNumber(statementSummary.dbRows, statementSummary.databaseRows, statementSummary.dbOrderRows);
  const matchedRows = firstNumber(statementSummary.matchedOrders, statementSummary.matchedRows);
  const unmatchedRows = firstNumber(statementSummary.unmatchedOrders, statementSummary.unmatchedRows);
  const netExpenses = firstNumber(statementSummary.netExpenses, statementSummary.expenseNet);
  const totalWithdrawn = firstNumber(statementSummary.totalWithdrawn, statementSummary.withdrawnTotal);
  const postReportOrders = firstNumber(statementSummary.postReportOrders) || 0;
  const expenseDelta = firstNumber(statementSummary.expenseDelta) || 0;
  const returnRowsTotal = firstNumber(statementSummary.returnRowCount);
  const statementReturns = statement?.returns || [];
  const hasMismatch = (unmatchedRows || 0) > 0 || expenseDelta !== 0;

  return <AppShell title="Кошелёк" subtitle="Когда деньги за выданные заказы попадут в корзину вывода и сколько придёт в выплату Uzum">
    {loading ? <div className="loading">Загружаем кошелёк…</div> : error ? <div className="error-box settings-notice"><span>{error}</span><button className="ghost" onClick={() => void reload()}>Повторить</button></div> : !pf ? <div className="loading">Нет данных кошелька за период.</div> : <div className="wl">
      <section className="wl-hero">
        <div className="wl-hero-main">
          <span>Можно вывести сейчас</span>
          <b>{money(Number(pf.summary?.availableToWithdraw || 0))}</b>
          <small>уже в корзине вывода Uzum{Number(pf.serviceFeePercent) > 0 ? `, плата за вывод ${pf.serviceFeePercent}%` : ''}</small>
        </div>
        <div className="wl-hero-cell">
          <span>Следующая выплата{nextPayout ? `, ${dayLabel(nextPayout.date)}` : ''}</span>
          <b>{nextPayout ? money(Number(nextPayout.netAmount ?? nextPayout.bankAmount)) : '—'}</b>
          <small>{nextPayout ? `заказы ${num(nextPayout.amount)} − расходы Uzum ${num(Number(nextPayout.expensesKnown || 0) + Number(nextPayout.expensesEstimate || 0))}${Number(nextPayout.expensesEstimate || 0) > 0 ? ' (часть — оценка)' : ''}` : 'по графику выплат пока нет сумм'}</small>
        </div>
        <div className="wl-hero-cell">
          <span>В удержании {holdDays} дней</span>
          <b>{money(Number(pf.summary?.inReturnHold || 0))}</b>
          <small>{holdOrders ? `${num(holdOrders)} заказов ждут конца удержания` : 'нет заказов в удержании'}{tomorrowRow ? `; завтра в корзину ${num(tomorrowRow.amount)}` : ''}</small>
        </div>
      </section>

      <ol className="wl-steps" aria-label="Путь денег">
        <li><i>1</i><div><b>Выдача покупателю</b><span>дата фактической выдачи</span></div></li>
        <li><i>2</i><div><b>{holdDays} дней удержания</b><span>календарных, резерв на возврат</span></div></li>
        <li><i>3</i><div><b>Корзина вывода</b><span>на {holdDays + 1}-й день после выдачи</span></div></li>
        <li><i>4</i><div><b>Выплата Uzum</b><span>{scheduleLabel(pf.schedule)}, минус расходы</span></div></li>
      </ol>

      <section className="wl-card">
        <header className="wl-card-head">
          <h2>Выплаты Uzum по графику</h2>
          <p>{scheduleLabel(pf.schedule)}: из заказов вычитаются все расходы Uzum с прошлой выплаты</p>
        </header>
        {payoutRows.length ? <div className="wl-scroll"><table className="wl-table wl-payouts">
          <thead><tr><th>Дата выплаты</th><th>Заказы из корзины</th><th className="num">На сумму</th><th className="num">Расходы Uzum</th><th className="num">Придёт</th><th className="end">Статус</th></tr></thead>
          <tbody>{payoutRows.map((row) => {
            const state = payoutState(row);
            const expenses = Number(row.expensesKnown || 0) + Number(row.expensesEstimate || 0);
            return <tr key={`payout-${row.date}`} className={row === nextPayout ? 'next' : ''}>
              <td><b>{dayLabel(row.date)}</b><small>{relativeDay(row.date, today)}</small></td>
              <td>{row.basketFrom ? `${shortDate(row.basketFrom)} — ${shortDate(row.basketTo)}` : '—'}<small>{num(row.orders)} заказов, {num(row.units)} шт.</small></td>
              <td className="num" data-label="Заказы на сумму">{num(row.amount)}</td>
              <td className="num" data-label="Расходы Uzum">{expenses > 0 ? `−${num(expenses)}` : '0'}{Number(row.expensesEstimate || 0) > 0 ? <small>оценка {num(row.expensesEstimate)}</small> : row.expensesFrom ? <small>с {shortDate(row.expensesFrom)}</small> : null}</td>
              <td className="num wl-net" data-label="Придёт"><b>{num(row.netAmount ?? row.bankAmount)}</b></td>
              <td className="end"><Status tone={state.tone}>{state.text}</Status></td>
            </tr>;
          })}</tbody>
        </table></div> : <div className="wl-empty">Нет сумм для графика выплат.</div>}
        <p className="wl-note"><Info size={15} /><span>Расходы — реклама, логистика, хранение и штрафы из журнала Uzum. Ещё не списанная часть до дня выплаты — оценка по среднему расходу за последнюю неделю; в день выплаты она заменится фактом.</span></p>
      </section>

      <section className="wl-card">
        <header className="wl-card-head">
          <h2>Календарь поступлений в корзину</h2>
          <p>сумма появляется на {holdDays + 1}-й день после выдачи</p>
          <div className="wl-legend"><span><i className="green" />в корзине</span><span><i className="amber" />удержание</span><span><i className="red" />сверить</span></div>
        </header>
        {calendarRows.length ? <div className="wl-scroll"><table className="wl-table wl-basket">
          <thead><tr><th>Попадёт в корзину</th><th>Заказы</th><th className="num">Штук</th><th className="num">Сумма</th><th className="pay">Выплата</th><th className="end">Статус</th></tr></thead>
          <tbody>{calendarRows.map((row) => {
            const state = basketState(row);
            return <tr key={`${row.date}-${row.scheduledPayoutDate}`} className={`${row.date === today ? 'today' : ''} ${state.tone === 'red' ? 'alert' : ''}`}>
              <td><b>{row.date === today ? `сегодня, ${dayLabel(row.date)}` : dayLabel(row.date)}</b></td>
              <td><span className="wl-muted">{num(row.orders)} заказов, выданы {shortDate(shiftDay(row.date, -(holdDays + 1)))}{row.returnedUnits ? `, возврат ${num(row.returnedUnits)} шт.` : ''}</span></td>
              <td className="num wl-units">{num(row.units)}</td>
              <td className="num" data-label="Сумма"><b>{num(row.amount)}</b></td>
              <td className="pay" data-label="Выплата">{shortDate(row.scheduledPayoutDate)}</td>
              <td className="end"><Status tone={state.tone}>{state.text}</Status></td>
            </tr>;
          })}</tbody>
        </table></div> : <div className="wl-empty">Пока нет выданных заказов с датой выдачи.</div>}
        {hiddenDays > 0 || showAllDays ? <button className="wl-more" onClick={() => setShowAllDays(!showAllDays)}>{showAllDays ? 'Скрыть прошлые дни' : `Показать прошлые дни (${hiddenDays})`}<ChevronDown size={15} className={showAllDays ? 'up' : ''} /></button> : null}
        <p className="wl-note"><Info size={15} /><span>Суммы считаются только от фактической выдачи товара. Возврат после выдачи уменьшает поступление того же дня. Заказ без данных о выдаче в расчёт не попадает.</span></p>
      </section>

      <section className="wl-facts">
        <div><span>Общий баланс</span><b>{money(pf.summary.overallBalance ?? pf.summary.availableToWithdraw)}</b><small>{pf.summary.overallBalanceSource === 'financial-statement' ? 'по финансовому отчёту Uzum' : 'полученные товары − расходы − выведено'}</small></div>
        <div><span>Ещё не выдано покупателям</span><b>{money(Number(pf.summary.notIssuedAmount || 0))}</b><small>{num(pf.summary.notIssuedOrders)} заказов, в корзину пока не идут</small></div>
        <div><span>Резерв возвратов</span><b>{money(Number(pf.summary.returnReserve || 0))}</b><small>уже вычтен из прогноза</small></div>
        <div className={Number(pf.summary.needsReconcile || 0) > 0 ? 'warn' : ''}><span>Прошлые выплаты сверить</span><b>{money(Number(pf.summary.needsReconcile || 0))}</b><small>дата прошла — сверить с историей выплат</small></div>
      </section>

      <details className="wl-card wl-statement">
        <summary className="wl-card-head">
          <FileSpreadsheet size={20} className="wl-statement-icon" />
          <div>
            <h2>Сверка с финансовым отчётом Uzum</h2>
            <p>{statementLoading ? 'Загружаем последнюю сверку…' : statement?.latest ? `${hasMismatch ? 'Есть расхождения' : 'Отчёт и база сверены'}: данные на ${statementDate(statement.latest.reportAsOf, true)}` : 'Отчёт ещё не загружен'}</p>
          </div>
          {statement?.latest ? <Status tone={hasMismatch ? 'amber' : 'green'}>{hasMismatch ? 'Проверить' : 'Сверено'}</Status> : null}
          <ChevronDown size={18} className="wl-chevron" />
        </summary>
        <div className="wl-statement-body">
          <div className="wl-statement-bar">
            <span>{statement?.latest ? `${statement.latest.fileName}, загружен ${statementDate(statement.latest.importedAt, true)}` : 'Скачайте .xlsx в кабинете Uzum и загрузите сюда: в нём точные выплаты, расходы, возвраты и комментарии покупателей. Исходный файл не меняется.'}</span>
            <label className={`primary statement-upload${statementImporting ? ' disabled' : ''}`}>
              <Upload size={15} />
              {statementImporting ? 'Сверяем…' : statement?.latest ? 'Загрузить новый отчёт' : 'Загрузить .xlsx'}
              <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={uploadStatement} disabled={statementImporting} />
            </label>
          </div>
          {statementMessage ? <div className="wl-message ok"><CheckCircle2 size={15} />{statementMessage}</div> : null}
          {statementError ? <div className="wl-message error"><AlertTriangle size={15} />Ошибка отчёта: {statementError}</div> : null}
          {statement?.latest ? <>
            <div className="wl-statement-kpis">
              <div><span>Общий баланс по отчёту</span><b>{statementMoney(reportedEndingBalance)}</b></div>
              <div><span>Можно вывести раньше</span><b>{statementMoney(availableEarly)}</b></div>
              <div><span>Расходы по отчёту</span><b>{statementMoney(netExpenses)}</b></div>
              <div><span>Уже выведено</span><b>{statementMoney(totalWithdrawn)}</b></div>
              <div><span>Строки отчёта / базы</span><b>{statementCount(reportRows)} / {statementCount(dbRows)}</b></div>
              <div className={hasMismatch ? 'warn' : ''}><span>Сопоставлено / не найдено</span><b>{statementCount(matchedRows)} / {statementCount(unmatchedRows)}</b></div>
            </div>
            <div className={`wl-message ${hasMismatch ? 'warn' : 'ok'}`}>
              {hasMismatch ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
              <span>{hasMismatch ? `Не сопоставлено строк: ${statementCount(unmatchedRows)}. Разница расходов: ${statementMoney(expenseDelta)}.` : `Все строки и суммы расходов совпали. Новых заказов после отчёта: ${statementCount(postReportOrders)} — это не ошибка сверки.`}</span>
            </div>
            <h3 className="wl-sub">Возвраты и отмены с причиной покупателя <small>показано {statementReturns.length} из {statementCount(returnRowsTotal)}</small></h3>
            {statementReturns.length ? <div className="wl-scroll wl-returns"><table className="wl-table">
              <thead><tr><th>Заказ</th><th>Товар</th><th>Кол-во</th><th>Причина</th><th>Комментарий покупателя</th><th className="num">Сумма</th></tr></thead>
              <tbody>{statementReturns.map((row) => <tr key={row.id}>
                <td><b>№ {row.orderId || row.externalId || '—'}</b><small>{statementDate(row.issuedAt || row.purchasedAt)}</small></td>
                <td className="wl-product"><b>{row.sku || row.productId || 'SKU не указан'}</b><small title={row.title || ''}>{row.title || 'Название не передано'}</small></td>
                <td>{row.returnedQuantity ?? row.quantity ?? 0} шт.<small>{returnStatus(row.state || row.statementStatus)}</small></td>
                <td>{returnReason(row.reasonCode || row.reason)}</td>
                <td className={`wl-comment${row.comment ? '' : ' missing'}`}>{row.comment ? <><MessageSquareText size={14} />{row.comment}</> : 'не передан'}</td>
                <td className="num">{statementMoney(firstNumber(row.statementPayout, row.payout))}<small>выведено {statementMoney(firstNumber(row.withdrawnAmount))}</small></td>
              </tr>)}</tbody>
            </table></div> : <div className="wl-empty">В последнем отчёте нет возвратов.</div>}
          </> : null}
        </div>
      </details>
    </div>}
  </AppShell>;
}
