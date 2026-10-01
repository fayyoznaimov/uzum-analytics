"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BarChart3, Boxes, CalendarRange, ChartNoAxesCombined, CircleDollarSign, ClipboardList, Clock3, Goal, LayoutDashboard, LogOut, Megaphone, MessageSquareText, PackageSearch, RefreshCw, Settings, WalletCards } from 'lucide-react';
import { api, getToken, logout, syncAndWait } from '@/lib/api';
import { refreshOverviewEverywhere } from '@/lib/overview';
import PeriodPicker from './PeriodPicker';

// Пункт меню: [href, название, иконка, доп. пути, при которых он подсвечен].
// Склад+Поставки и Отзывы+Качество объединены — внутри экранов переключение вкладками.
const nav: Array<[string] | [string, string, any, string[]?]> = [
  ['ДЕНЬГИ'],
  ['/dashboard', 'Главная', LayoutDashboard], ['/wallet', 'Кошелёк', WalletCards],
  ['/profit', 'Профит', ChartNoAxesCombined], ['/monthly', 'Отчёты по месяцам', CalendarRange],
  ['ПРОДАЖИ'],
  ['/ordered', 'Заказы', ClipboardList], ['/hourly', 'По часам', Clock3], ['/goals', 'Цели', Goal],
  ['РЕКЛАМА'],
  ['/ads', 'Кампании', Megaphone],
  ['ТОВАРЫ'],
  ['/products', 'Товары и цены', PackageSearch], ['/warehouse', 'Склад и поставки', Boxes, ['/supplies']],
  ['/costs', 'Себестоимость', CircleDollarSign], ['/reviews', 'Отзывы и качество', MessageSquareText, ['/quality']],
  ['СЕРВИС'],
  ['/settings', 'Настройки', Settings],
];

// Вкладки внутри объединённых пунктов меню.
const subtabs: Record<string, Array<[string, string]>> = {
  '/warehouse': [['/warehouse', 'Склад'], ['/supplies', 'Поставки']],
  '/supplies': [['/warehouse', 'Склад'], ['/supplies', 'Поставки']],
  '/reviews': [['/reviews', 'Отзывы'], ['/quality', 'Качество карточек']],
  '/quality': [['/reviews', 'Отзывы'], ['/quality', 'Качество карточек']],
};

export default function AppShell({ children, title, subtitle, actions, periodEnabled = true }: { children: React.ReactNode; title: string; subtitle?: string; actions?: React.ReactNode; periodEnabled?: boolean }) {
  const path = usePathname();
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [shop, setShop] = useState({ name: 'Магазин Uzum', id: '' });

  useEffect(() => {
    if (!getToken()) { location.href = '/login'; return; }
    api<any[]>('/integrations').then((rows) => {
      const uzum = rows.find((row) => row.type === 'UZUM');
      if (uzum?.metadata) setShop({ name: uzum.metadata.shopName || 'Магазин Uzum', id: uzum.metadata.shopId || '' });
    }).catch(() => undefined);
  }, []);

  async function refreshData() {
    setSyncing(true);
    setSyncMessage('Синхронизация с Uzum запущена — обычно 3–4 минуты…');
    try {
      const result: any = await syncAndWait();
      setSyncMessage(result.message || 'Данные обновлены');
      refreshOverviewEverywhere();
    } catch (error: any) {
      setSyncMessage(`Ошибка обновления: ${error.message}`);
    } finally {
      setSyncing(false);
    }
  }

  return <div className="app">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><BarChart3/></div><div><b>Uzum Analytics</b><span>{shop.name}</span></div></div><nav>{nav.map((entry) => entry.length === 1 ? <span key={entry[0]} className="nav-group">{entry[0]}</span> : (([href, labelText, Icon, also]) => <Link key={href} href={href} className={path === href || (also || []).includes(path || '') ? 'active' : ''}><Icon size={18}/><span>{labelText}</span></Link>)(entry as [string, string, any, string[]?]))}</nav><div className="side-foot"><button onClick={logout}><LogOut size={17}/>Выйти</button></div></aside>
    <main className="main"><section className="page-head"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="head-actions">{syncMessage && <span className={syncMessage.startsWith('Ошибка') ? 'top-sync-error' : 'top-sync-ok'}>{syncMessage}</span>}<button className="ghost" onClick={refreshData} disabled={syncing}><RefreshCw size={16} className={syncing ? 'spin' : ''}/>{syncing ? 'Обновление…' : 'Обновить данные'}</button>{periodEnabled && <PeriodPicker/>}{actions}</div></section>{subtabs[path || ''] && <div className="subtabs">{subtabs[path || ''].map(([href, labelText]) => <Link key={href} href={href} className={path === href ? 'active' : ''}>{labelText}</Link>)}</div>}{children}</main>
  </div>;
}
