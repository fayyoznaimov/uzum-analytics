"use client";

import { useEffect, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import AppShell from './AppShell';
import { api, money } from '@/lib/api';
import { useAnalyticsPeriod } from '@/lib/period';

const expenseAmount = (value: number) => value === 0 ? '—' : value < 0
  ? `+ ${money(Math.abs(value))}`
  : `− ${money(value)}`;

export default function ProductsClient() {
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { query } = useAnalyticsPeriod();
  const rowsWithKnownInputs = rows.filter((row) => row.profitKnown !== false);
  const hasUnknownProfitInputs = rowsWithKnownInputs.length !== rows.length;

  useEffect(() => {
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        setRows(await api(`/products?search=${encodeURIComponent(q)}&${query}`));
      } catch (cause: any) {
        setRows([]);
        setError(cause.message || 'Не удалось загрузить товары');
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q, query]);

  return <AppShell title="Товары" subtitle="Заказы, выплаты, комиссия МП, логистика, себестоимость и чистая прибыль по карточкам">
    <div className="toolbar"><div className="search grow"><Search size={17}/><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Поиск по названию или ID…"/></div></div>
    {error && <div className="error-box settings-notice">{error}</div>}
    {loading ? <div className="loading">Загружаем товары…</div> : <>
      <div className="summary-strip">
        <div><span>ТОВАРОВ</span><b>{rows.length}</b></div>
        <div><span>СУММА ВЫКУПОВ</span><b>{money(rows.reduce((sum, row) => sum + row.revenue, 0))}</b></div>
        <div><span>ВЫДАНО ПРОДАВЦУ</span><b>{money(rows.reduce((sum, row) => sum + row.payout, 0))}</b></div>
        <div><span>{hasUnknownProfitInputs?'ПРИБЫЛЬ ПО ИЗВЕСТНЫМ ДАННЫМ':'ЧИСТАЯ ПРИБЫЛЬ'}</span><b>{money(rowsWithKnownInputs.reduce((sum, row) => sum + row.profit, 0))}{hasUnknownProfitInputs?' • неполно':''}</b></div>
      </div>
      <div className="product-list">{rows.map((row) => {
        const breakdown = row.advertisingBreakdown || {};
        const confirmed = String(row.advertisingSource || '').startsWith('UZUM_EXPENSE');
        return <article className="product-card" key={row.id}>
          <div className="product-title"><div className="product-image">{row.title.slice(0, 2)}</div><div><h3>{row.title}</h3><p>ID {row.externalId} • {row.skuCount} SKU • остаток {row.stock} шт.{row.missingCosts ? ` • без себестоимости ${row.missingCosts}` : ''}</p></div><button className="outline" onClick={() => setOpen((value) => ({ ...value, [row.id]: !value[row.id] }))}>{open[row.id] ? 'Скрыть' : 'Детали'} <ChevronRight size={15}/></button></div>
          <div className="product-stats"><div><span>ЗАКАЗАНО</span><b>{row.orderedUnits} шт.</b></div><div><span>КУПИЛИ</span><b className="positive">{row.paidUnits} шт.</b></div><div><span>ЖДУТ ОПЛАТУ</span><b className={row.waitingUnits ? 'warning-text' : ''}>{row.waitingUnits} шт.</b></div><div><span>ОПЛАЧЕННЫЕ ПРОДАЖИ</span><b>{money(row.revenue)}</b></div><div><span>ВЫДАНО ПРОДАВЦУ</span><b>{money(row.payout)}</b></div><div><span>ЧИСТАЯ ПРИБЫЛЬ</span><b className={row.profitKnown&&row.profit >= 0 ? 'positive' : 'negative'}>{row.profitKnown?money(row.profit):'—'} <small>{row.profitKnown?`${row.margin.toFixed(1)}%`:Number(row.missingSoldCostItems||0)||Number(row.payoutPendingOrders||0)?'нет исходных данных':'рекламный факт периода ещё не финален'}</small></b></div></div>
          {open[row.id] && <div className="product-money-flow">
            <div><span>Оплаченные продажи</span><b>{money(row.revenue)}</b></div><div><span>Комиссия МП</span><b>− {money(row.commission)} <small>{row.commissionPercent.toFixed(1)}%</small></b></div><div><span>Логистика Uzum</span><b>− {money(row.marketplaceLogistics)}</b></div><div><span>Прочие удержания Uzum</span><b>− {money(row.otherMarketplaceDeductions || 0)}</b></div><div className="subtotal"><span>Выдаётся продавцу</span><b>= {money(row.payout)}</b></div><div><span>Себестоимость</span><b>− {money(row.productCost)}</b></div><div><span>Логистика до склада</span><b>− {money(row.warehouseLogisticsCost)}</b></div><div><span>Упаковка + прочее</span><b>− {money(row.packagingCost + row.additionalCost)}</b></div>
            <div><span>Буст заказов • прямая привязка</span><b>{expenseAmount(Number(breakdown.linkedOrderBoost || 0))}</b></div><div><span>Буст без товарного ID • распределение по выручке</span><b>{expenseAmount(Number(breakdown.allocatedUnlinkedOrderBoost || 0))}</b></div><div><span>Буст в ТОП • распределение по выручке</span><b>{expenseAmount(Number(breakdown.allocatedTopPromotion || 0))}</b></div>{(row.isUnallocatedBucket||Number(breakdown.unallocatedAdvertisingResidual||0)!==0)&&<div><span>Нераспределённый остаток магазина • нет базы продаж</span><b>{expenseAmount(Number(breakdown.unallocatedAdvertisingResidual||0))}</b></div>}<div><span>Реклама итого • {confirmed ? 'факт магазина' : 'нет списаний'} • ДРР {Number(row.adRatio || 0).toFixed(1)}%</span><b>{expenseAmount(Number(row.advertising || 0))}</b></div>
            <div><span>Налог {row.taxPercent}%</span><b>− {money(row.tax)}</b></div><div className={row.profitKnown&&row.profit >= 0 ? 'profit' : 'loss'}><span>Чистая прибыль</span><b>= {row.profitKnown?money(row.profit):'не рассчитана'}</b></div>
          </div>}
          <div className="conversion">Прямой буст привязан к товару по ID из finance/expenses. Буст в ТОП и строки без товарного ID показаны отдельно и распределены по доле оплаченной выручки только для товарной детализации.</div>
        </article>;
      })}</div>
    </>}
  </AppShell>;
}
