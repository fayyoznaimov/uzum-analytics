"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BarChart3, Boxes, ChartNoAxesCombined, ClipboardList, HandCoins, LayoutDashboard, LogOut, Megaphone, MessageSquareText, PackageSearch, RefreshCw, Settings, WalletCards } from 'lucide-react';
import { api, getToken, logout, syncAndWait } from '@/lib/api';
import { refreshOverviewEverywhere } from '@/lib/overview';
import PeriodPicker from './PeriodPicker';

// Пункт меню: [href, название, иконка, доп. пути, при которых он подсвечен].
// Владелец 09.11.2026 (после демо Sellium): «70 % не используется» — в меню 10 пунктов вместо 19.
// Парные экраны открываются вкладками внутри пункта (см. subtabs). «Цели», «Конкуренты»,
// «Авто-ставка» и «Качество карточек» из меню убраны, но открываются по прямой ссылке.
const nav: Array<[string, string, any, string[]?]> = [
  ['/dashboard', 'Главная', LayoutDashboard, ['/goals']], ['/wallet', 'Кошелёк', WalletCards],
  ['/profit', 'Профит', ChartNoAxesCombined, ['/monthly']], ['/ordered', 'Заказы', ClipboardList, ['/hourly']],
  ['/products', 'Товары', PackageSearch, ['/costs', '/competitors']], ['/warehouse', 'Склад и поставки', Boxes, ['/supplies', '/losses']],
  ['/ads', 'Реклама', Megaphone, ['/auto-bidder']], ['/reviews', 'Отзывы', MessageSquareText, ['/quality']],
  ['/supplier', 'Долг поставщику', HandCoins], ['/settings', 'Настройки', Settings],
];

// Вкладки внутри объединённых пунктов меню.
const tabs = { profit: [['/profit', 'За период'], ['/monthly', 'По месяцам']], ordered: [['/ordered', 'Заказы'], ['/hourly', 'По часам']], products: [['/products', 'Товары и цены'], ['/costs', 'Себестоимость']], warehouse: [['/warehouse', 'Склад'], ['/supplies', 'Поставки'], ['/losses', 'Потери']] } as Record<string, Array<[string, string]>>;
const subtabs: Record<string, Array<[string, string]>> = {
  '/profit': tabs.profit, '/monthly': tabs.profit, '/ordered': tabs.ordered, '/hourly': tabs.ordered,
  '/products': tabs.products, '/costs': tabs.products, '/warehouse': tabs.warehouse, '/supplies': tabs.warehouse, '/losses': tabs.warehouse,
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
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><BarChart3/></div><div><b>Uzum Analytics</b><span>{shop.name}</span></div></div><nav>{nav.map(([href, labelText, Icon, also]) => <Link key={href} href={href} title={labelText} className={path === href || (also || []).includes(path || '') ? 'active' : ''}><Icon size={18}/><span>{labelText}</span></Link>)}</nav><div className="side-foot"><button onClick={logout}><LogOut size={17}/>Выйти</button></div></aside>
    <main className="main"><section className="page-head"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="head-actions">{syncMessage && <span className={syncMessage.startsWith('Ошибка') ? 'top-sync-error' : 'top-sync-ok'}>{syncMessage}</span>}<button className="ghost" onClick={refreshData} disabled={syncing}><RefreshCw size={16} className={syncing ? 'spin' : ''}/>{syncing ? 'Обновление…' : 'Обновить данные'}</button>{periodEnabled && <PeriodPicker/>}{actions}</div></section>{subtabs[path || ''] && <div className="subtabs">{subtabs[path || ''].map(([href, labelText]) => <Link key={href} href={href} className={path === href ? 'active' : ''}>{labelText}</Link>)}</div>}{children}</main>
  </div>;
}
