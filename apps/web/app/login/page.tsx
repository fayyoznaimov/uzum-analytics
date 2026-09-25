"use client";

import { FormEvent, useState } from 'react';
import { BarChart3, LockKeyhole, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import '../globals.css';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await api<any>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      localStorage.setItem('ua_token', result.token);
      location.href = '/dashboard';
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  }

  return <main className="login-page">
    <section className="login-hero"><div className="brand large"><div className="brand-mark"><BarChart3/></div><div><b>Uzum Analytics</b><span>кабинет продавца</span></div></div><h1>Все цифры магазина<br/><em>в одном месте</em></h1><p>Продажи, прибыль, склад, себестоимость, цели и Telegram-уведомления.</p><div className="feature-row"><Sparkles size={18}/> Умные подсказки и контроль целей</div></section>
    <form className="login-card" onSubmit={submit}><div className="login-icon"><LockKeyhole/></div><h2>Вход в кабинет</h2><p>Используйте данные администратора из .env</p><label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email"/></label><label>Пароль<input value={password} onChange={(event) => setPassword(event.target.value)} type="password"/></label>{error && <div className="error-box">{error}</div>}<button className="primary full" disabled={loading}>{loading ? 'Входим…' : 'Войти'}</button><small>Пароль задаётся в .env при первом запуске и не перезаписывается при рестарте.</small></form>
  </main>;
}
