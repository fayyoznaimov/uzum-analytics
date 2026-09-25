"use client";
import { type ChangeEvent, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CalendarClock, CalendarDays, CheckCircle2, Clock3, FileSpreadsheet, Landmark, MessageSquareText, RotateCcw, Upload, WalletCards } from 'lucide-react';
import AppShell from './AppShell';
import { Status } from './UI';
import { api, apiForm, money } from '@/lib/api';
import { useAnalyticsPeriod } from '@/lib/period';

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

function label(value?: string | null, withYear = false) {
  if (!value) return '—';
  return new Date(`${value}T12:00:00+05:00`).toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    ...(withYear ? { year: 'numeric' as const } : {}),
  });
}

function shortDate(value?: string | null) {
  if (!value) return '—';
  return new Date(`${value}T12:00:00+05:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

function basketTone(status: string) {
  if (status === 'HOLD') return 'blue';
  if (status === 'DUE_TODAY') return 'green';
  if (status === 'NEEDS_RECONCILE') return 'amber';
  return 'violet';
}

function basketStatus(row: any) {
  if (row.status === 'HOLD') return row.daysUntilBasket === 1 ? 'Завтра в корзину' : row.daysUntilBasket > 1 ? `Через ${row.daysUntilBasket} дн.` : 'В удержании';
  if (row.status === 'AVAILABLE') return 'В корзине';
  if (row.status === 'DUE_TODAY') return 'Выплата сегодня';
  if (row.status === 'NEEDS_RECONCILE') return 'Сверить';
  return 'По графику';
}

function payoutStatus(row: any) {
  if (row.status === 'DUE_TODAY') return 'Сегодня';
  if (row.status === 'NEEDS_RECONCILE') return 'Сверить';
  return 'Будет по графику';
}

function statementDate(value?: string | null, withTime = false) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('ru-RU', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function statementMoney(value: number | null) {
  return value === null ? '—' : money(value);
}

function statementCount(value: number | null) {
  return value === null ? '—' : new Intl.NumberFormat('ru-RU').format(value);
}

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
  const statuses: Record<string, string> = {
    CANCELED: 'Отменён',
    RETURNED: 'Возврат',
    PAID: 'Оплачен',
    WAITING: 'В обработке',
    'возврат': 'Возврат',
  };
  return value ? statuses[value] || value : 'Возврат';
}

export default function WalletClient() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [statement, setStatement] = useState<StatementPayload | null>(null);
  const [statementLoading, setStatementLoading] = useState(true);
  const [statementImporting, setStatementImporting] = useState(false);
  const [statementMessage, setStatementMessage] = useState('');
  const [statementError, setStatementError] = useState('');
  const { query } = useAnalyticsPeriod();

  useEffect(() => {
    setLoading(true);
    api(`/dashboard/overview?${query}`).then(setData).finally(() => setLoading(false));
  }, [query]);

  useEffect(() => {
    setStatementLoading(true);
    api<StatementPayload>('/financial-statements/latest?returns=100')
      .then((result) => {
        setStatement(result);
        setStatementError('');
      })
      .catch((error: Error) => setStatementError(error.message))
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
      const overview = await api(`/dashboard/overview?${query}`);
      setData(overview);
    } catch (error) {
      setStatementError(error instanceof Error ? error.message : 'Не удалось загрузить отчёт');
    } finally {
      setStatementImporting(false);
      event.target.value = '';
    }
  }

  const pf = data?.payoutForecast;
  const basketRows = pf?.basketDailyRows || pf?.rows || [];
  const payoutRows = pf?.payoutDailyRows || [];
  const nextBasketRows = useMemo(() => basketRows.filter((r: any) => r.daysUntilBasket >= 0).slice(0, 12), [basketRows]);
  const readyRows = useMemo(() => basketRows.filter((r: any) => r.daysUntilBasket <= 0).slice(-8).reverse(), [basketRows]);
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

  return <AppShell title="Кошелёк" subtitle="Главный экран денег: по дням, когда сумма попадает в корзину вывода, и отдельно когда Uzum отправит выплату по графику">
    {loading || !pf ? <div className="loading">Загружаем кошелёк…</div> : <>
      <section className="wallet-hero" style={{ display: 'none' }}>
        <div className="wallet-hero-main">
          <span>ГЛАВНАЯ ЛОГИКА</span>
          <h1>Сначала деньги попадают в корзину вывода, потом уходят по графику выплат</h1>
          <p>Основа расчёта — <b>dateIssued</b>, то есть фактическая выдача товара покупателю. После {pf.holdDays} полных дней удержания сумма появляется в корзине. Возвраты уменьшают прогноз сразу.</p>
        </div>
        <div className="wallet-formula">
          <div><small>1</small><b>Выдано покупателю</b><span>dateIssued</span></div>
          <ArrowRight />
          <div><small>2</small><b>{pf.holdDays} дней удержания</b><span>риск возврата</span></div>
          <ArrowRight />
          <div><small>3</small><b>Корзина вывода</b><span>можно ждать / выводить</span></div>
          <ArrowRight />
          <div><small>4</small><b>График Uzum</b><span>{pf.schedule}</span></div>
        </div>
      </section>

      <section className="panel wallet-section statement-panel">
        <div className="panel-head statement-head">
          <div className="statement-title">
            <FileSpreadsheet />
            <div>
              <h2>Сверка с финансовым отчётом Uzum</h2>
              <p>{statement?.latest ? `${statement.latest.fileName} • данные на ${statementDate(statement.latest.reportAsOf, true)} • загружен ${statementDate(statement.latest.importedAt, true)}` : 'Загрузите официальный .xlsx: он содержит точные выплаты, расходы, возвраты и комментарии покупателей.'}</p>
            </div>
          </div>
          <label className={`primary statement-upload${statementImporting ? ' disabled' : ''}`}>
            <Upload size={15} />
            {statementImporting ? 'Сверяем…' : statement?.latest ? 'Обновить отчёт' : 'Загрузить .xlsx'}
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={uploadStatement} disabled={statementImporting} />
          </label>
        </div>

        {statementLoading ? <div className="statement-empty">Загружаем последнюю сверку…</div> : statement?.latest ? <>
          <div className="statement-kpis">
            <div className="balance"><span>ОБЩИЙ БАЛАНС ПО ОТЧЁТУ</span><b>{statementMoney(reportedEndingBalance)}</b><small>официальный остаток Uzum на дату отчёта</small></div>
            <div><span>МОЖНО ВЫВЕСТИ РАНЬШЕ</span><b>{statementMoney(availableEarly)}</b><small>без сумм, которые ещё в обработке</small></div>
            <div><span>СТРОКИ ОТЧЁТА / БАЗЫ</span><b>{statementCount(reportRows)} / {statementCount(dbRows)}</b><small>позиции заказов в двух источниках</small></div>
            <div className={hasMismatch ? 'warning' : 'ok'}><span>СОПОСТАВЛЕНО / НЕ НАЙДЕНО</span><b>{statementCount(matchedRows)} / {statementCount(unmatchedRows)}</b><small>{hasMismatch ? 'есть строки для ручной проверки' : 'заказы успешно сопоставлены'}</small></div>
            <div><span>РАСХОДЫ ПО ОТЧЁТУ</span><b>{statementMoney(netExpenses)}</b><small>списания минус возвраты услуг</small></div>
            <div><span>УЖЕ ВЫВЕДЕНО</span><b>{statementMoney(totalWithdrawn)}</b><small>фактические выводы в отчёте</small></div>
          </div>

          <div className={`statement-reconcile ${hasMismatch ? 'warning' : 'ok'}`}>
            {hasMismatch ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
            <div>
              <b>{hasMismatch ? 'Есть расхождения между отчётом и базой' : 'Отчёт и база сверены'}</b>
              <span>{hasMismatch ? `Не сопоставлено: ${statementCount(unmatchedRows)}. Разница расходов: ${statementMoney(expenseDelta)}.` : `Суммы расходов и все строки отчёта проверены. После снимка появилось новых заказов: ${statementCount(postReportOrders)} — это не ошибка сверки.`}</span>
            </div>
          </div>

          <div className="statement-returns-head">
            <div>
              <h3>Возвраты и отмены с причиной покупателя</h3>
              <p>Причина и комментарий берутся из финансового отчёта, а не угадываются по статусу заказа.</p>
            </div>
            <Status tone="red">показано {statementReturns.length} из {statementCount(returnRowsTotal)}</Status>
          </div>
          {statementReturns.length ? <div className="statement-returns-table">
            <div className="statement-return-row head"><span>Заказ / дата</span><span>Товар</span><span>Кол-во / статус</span><span>Причина</span><span>Комментарий покупателя</span><span>Суммы</span></div>
            {statementReturns.map((row) => <div className="statement-return-row" key={row.id}>
              <div><b>№ {row.orderId || row.externalId || '—'}</b><small>{statementDate(row.issuedAt || row.purchasedAt)}</small></div>
              <div><b>{row.sku || row.productId || 'SKU не указан'}</b><small title={row.title || ''}>{row.title || 'Название не передано'}</small></div>
              <div><b>{row.returnedQuantity ?? row.quantity ?? 0} шт.</b><Status tone="red">{returnStatus(row.state || row.statementStatus)}</Status></div>
              <div className="statement-reason"><b>{returnReason(row.reasonCode || row.reason)}</b><small>{row.reasonCode || ''}</small></div>
              <div className={`statement-comment${row.comment ? '' : ' missing'}`}><MessageSquareText size={15} /><span>{row.comment || 'Комментарий покупателя не передан'}</span></div>
              <div><b>{statementMoney(firstNumber(row.statementPayout, row.payout))}</b><small>выведено: {statementMoney(firstNumber(row.withdrawnAmount))}</small></div>
            </div>)}
          </div> : <div className="statement-empty">В последнем отчёте нет возвратов.</div>}
        </> : <div className="statement-empty">
          <FileSpreadsheet size={28} />
          <b>Финансовый отчёт ещё не загружен</b>
          <span>Скачайте файл в кабинете Uzum и загрузите сюда. Исходный файл не изменяется.</span>
        </div>}

        {statementMessage ? <div className="statement-message ok"><CheckCircle2 size={15} />{statementMessage}</div> : null}
        {statementError ? <div className="statement-message error"><AlertTriangle size={15} />Ошибка отчёта: {statementError}</div> : null}
      </section>

      <div className="wallet-kpi-grid">
        <div className="wallet-kpi ready"><WalletCards/><span>ОБЩИЙ БАЛАНС</span><b>{money(pf.summary.overallBalance ?? pf.summary.availableToWithdraw)}</b><small>полученные товары − расходы − выведенные деньги</small></div>
        <div className="wallet-kpi today"><CalendarClock/><span>ПОПАДЁТ В КОРЗИНУ СЕГОДНЯ</span><b>{money(pf.summary.basketToday || 0)}</b><small>по dateIssued + {pf.holdDays + 1} день</small></div>
        <div className="wallet-kpi hold"><Clock3/><span>В УДЕРЖАНИИ</span><b>{money(pf.summary.inReturnHold)}</b><small>ещё не в корзине</small></div>
        <div className="wallet-kpi future"><CalendarDays/><span>В КОРЗИНУ ЗА 7 ДНЕЙ</span><b>{money(pf.summary.basketNext7 || 0)}</b><small>по дням ниже</small></div>
        <div className="wallet-kpi payout"><Landmark/><span>ВЫПЛАТА ЗА 7 ДНЕЙ</span><b>{money(pf.summary.next7Days)}</b><small>после платы {pf.serviceFeePercent}%</small></div>
        <div className="wallet-kpi return"><RotateCcw/><span>РЕЗЕРВ ВОЗВРАТОВ</span><b>{money(pf.summary.returnReserve)}</b><small>уже уменьшил прогноз</small></div>
      </div>

      <section className="panel wallet-section basket-focus">
        <div className="panel-head">
          <div><h2>По дням: когда деньги попадут в корзину вывода</h2><p>Это главный календарь. Здесь не дата банковской выплаты, а дата появления суммы в кабинете «можно вывести».</p></div>
          <Status tone="green">Корзина вывода</Status>
        </div>
        {basketRows.length ? <div className="wallet-basket-list">
          {basketRows.map((row: any) => <div key={`${row.date}-${row.scheduledPayoutDate}`} className={`wallet-basket-day ${row.status === 'HOLD' ? 'hold' : row.status === 'NEEDS_RECONCILE' ? 'past' : 'ready'}`}>
            <div className="wallet-day-date"><b>{label(row.date, true)}</b><small>{row.daysUntilBasket > 0 ? `через ${row.daysUntilBasket} дн.` : row.daysUntilBasket === 0 ? 'сегодня' : `${Math.abs(row.daysUntilBasket)} дн. назад`}</small></div>
            <div className="wallet-day-main"><span>В корзину</span><strong>{money(row.amount)}</strong><small>{row.orders} заказов • {row.units} шт.{row.returnedUnits ? ` • возврат ${row.returnedUnits} шт.` : ''}</small></div>
            <div className="wallet-day-side"><span>График выплаты</span><b>{label(row.scheduledPayoutDate)}</b><small>к поступлению: {money(row.bankAmount)}</small></div>
            <div className="wallet-day-side"><span>Резерв возврата</span><b>{money(row.returnReserve)}</b><small>уменьшен прогноз</small></div>
            <Status tone={basketTone(row.status) as any}>{basketStatus(row)}</Status>
          </div>)}
        </div> : <div className="payout-empty">Пока нет выданных заказов с dateIssued.</div>}
      </section>

      <div className="wallet-two-col">
        <section className="panel wallet-section">
          <div className="panel-head"><div><h2>Ближайшие поступления в корзину</h2><p>Короткий список на ближайшие дни</p></div><Status tone="blue">next</Status></div>
          <div className="wallet-mini-list">
            {nextBasketRows.length ? nextBasketRows.map((row: any) => <div key={`next-${row.date}`}><span>{shortDate(row.date)}</span><b>{money(row.amount)}</b><small>{row.orders} заказов • {basketStatus(row)}</small></div>) : <div className="payout-empty">Нет будущих сумм в корзину.</div>}
          </div>
        </section>
        <section className="panel wallet-section">
          <div className="panel-head"><div><h2>Уже лежит в корзине</h2><p>Прошлые дни, которые можно сверять с кабинетом</p></div><Status tone="violet">ready</Status></div>
          <div className="wallet-mini-list">
            {readyRows.length ? readyRows.map((row: any) => <div key={`ready-${row.date}`}><span>{shortDate(row.date)}</span><b>{money(row.amount)}</b><small>{row.orders} заказов • выплата {shortDate(row.scheduledPayoutDate)}</small></div>) : <div className="payout-empty">Нет готовых сумм в корзине.</div>}
          </div>
        </section>
      </div>

      <section className="panel wallet-section">
        <div className="panel-head"><div><h2>Отдельно: график выплат Uzum в банк</h2><p>Эта таблица уже не про корзину, а про дату отправки денег по выбранному расписанию.</p></div><Status tone="amber">{pf.schedule}</Status></div>
        {payoutRows.length ? <div className="wallet-payout-table">
          <div className="wallet-payout-head"><span>Дата выплаты</span><span>Какие дни корзины</span><span>Заказы / шт.</span><span>Сумма</span><span>Плата</span><span>К поступлению</span><span>Статус</span></div>
          {payoutRows.map((row: any) => <div className="wallet-payout-row" key={`payout-${row.date}`}>
            <b>{label(row.date, true)}</b>
            <span>{shortDate(row.basketFrom)} — {shortDate(row.basketTo)}</span>
            <span>{row.orders} / {row.units}</span>
            <strong>{money(row.amount)}</strong>
            <span>{money(row.serviceFee)}</span>
            <strong>{money(row.bankAmount)}</strong>
            <Status tone={row.status === 'DUE_TODAY' ? 'green' : row.status === 'NEEDS_RECONCILE' ? 'amber' : 'blue'}>{payoutStatus(row)}</Status>
          </div>)}
        </div> : <div className="payout-empty">Нет сумм для графика выплат.</div>}
      </section>

      <section className="panel wallet-section wallet-details">
        <div className="panel-head"><div><h2>Остальные части кошелька</h2><p>Чтобы видеть не только корзину, но и все деньги вокруг неё</p></div><Status tone="gray">контроль</Status></div>
        <div className="wallet-detail-grid">
          <div><Clock3/><span>Ещё не выдано покупателям</span><b>{money(pf.summary.notIssuedAmount)}</b><small>{pf.summary.notIssuedOrders} заказов — пока не должны попадать в корзину</small></div>
          <div><AlertTriangle/><span>Прошлые выплаты сверить</span><b>{money(pf.summary.needsReconcile)}</b><small>дата графика прошла, нужна сверка с Uzum/банком</small></div>
          <div><CheckCircle2/><span>Выбранный период</span><b>{money(pf.selectedPeriod.amount)}</b><small>корзина: {shortDate(pf.selectedPeriod.basketFrom)} — {shortDate(pf.selectedPeriod.basketTo)}</small></div>
          <div><Landmark/><span>Фактическое поступление</span><b>не подтверждаем автоматически</b><small>подтверждать по истории выплат или банковской выписке</small></div>
        </div>
        <div className="payout-disclaimer"><AlertTriangle size={15}/><span>{pf.note}</span></div>
      </section>
    </>}
  </AppShell>;
}
