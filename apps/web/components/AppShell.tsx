"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BarChart3, Boxes, CalendarRange, ChartNoAxesCombined, CircleDollarSign, ClipboardList, Clock3, Goal, LayoutDashboard, LogOut, Megaphone, MessageSquareText, PackageSearch, RefreshCw, Settings, ShieldCheck, Star, Truck, WalletCards } from 'lucide-react';
import { api, getToken, logout, syncAndWait } from '@/lib/api';
import PeriodPicker from './PeriodPicker';
import { useAnalyticsPeriod } from '@/lib/period';

const nav = [
  ['/profit', 'Профит', ChartNoAxesCombined], ['/dashboard', 'Главная', LayoutDashboard],
  ['/ordered', 'Заказано', ClipboardList],
  ['/wallet', 'Кошелёк', WalletCards], ['/products', 'Товары', PackageSearch],
  ['/hourly', 'Часовые продажи', Clock3], ['/monthly', 'Ежемесячные отчёты', CalendarRange],
  ['/ads', 'Реклама', Megaphone], ['/warehouse', 'Склад', Boxes], ['/supplies', 'Поставки', Truck],
  ['/costs', 'Себестоимость', CircleDollarSign], ['/reviews', 'Отзывы', MessageSquareText],
  ['/quality', 'Качество карточек', Star], ['/goals', 'Цели', Goal], ['/settings', 'Настройки', Settings],
] as const;

export default function AppShell({ children, title, subtitle, actions, periodEnabled = true }: { children: React.ReactNode; title: string; subtitle?: string; actions?: React.ReactNode; periodEnabled?: boolean }) {
  const path = usePathname();
  const { label } = useAnalyticsPeriod();
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
    setSyncMessage('');
    try {
      const result: any = await syncAndWait();
      setSyncMessage(result.message || 'Данные обновлены');
      setTimeout(() => location.reload(), 700);
    } catch (error: any) {
      setSyncMessage(`Ошибка обновления: ${error.message}`);
    } finally {
      setSyncing(false);
    }
  }

  const initials = shop.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'UZ';
  return <div className="app">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><BarChart3/></div><div><b>Uzum Analytics</b><span>{shop.name}</span></div></div><nav>{nav.map(([href, labelText, Icon]) => <Link key={href} href={href} className={path === href ? 'active' : ''}><Icon size={18}/><span>{labelText}</span></Link>)}</nav><div className="side-foot"><div className="secure"><ShieldCheck size={17}/><div><b>Секреты защищены</b><span>AES-256-GCM</span></div></div><button onClick={logout}><LogOut size={17}/>Выйти</button></div></aside>
    <main className="main"><header className="topbar"><div className="shop-switch"><span className="shop-avatar">{initials}</span><span><small>МАГАЗИН</small><b>{shop.name}{shop.id ? ` ${shop.id}` : ''}</b></span></div><div className="top-actions">{syncMessage && <span className={syncMessage.startsWith('Ошибка') ? 'top-sync-error' : 'top-sync-ok'}>{syncMessage}</span>}<button className="ghost" onClick={refreshData} disabled={syncing}><RefreshCw size={16} className={syncing ? 'spin' : ''}/>{syncing ? 'Обновление…' : 'Обновить данные'}</button><div className="avatar">UA</div></div></header><section className="page-head"><div><span className="eyebrow">МОЙ МАГАЗИН{periodEnabled ? ` • ${label.toUpperCase()}` : ''}</span><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="head-actions">{periodEnabled && <PeriodPicker/>}{actions}</div></section>{children}<footer><span>Uzum Analytics v1.0</span><span>Часовой пояс: Asia/Tashkent</span></footer></main>
  </div>;
}
