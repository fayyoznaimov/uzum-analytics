"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useAnalyticsPeriod } from './period';

// Все экраны аналитики читают один и тот же /dashboard/overview, поэтому ответы
// держим в общем клиентском кэше по ключу периода: при переходе между экранами
// данные показываются мгновенно, а свежая версия тихо подтягивается фоном
// (stale-while-revalidate). AbortController отменяет устаревший запрос при
// быстрой смене периода, чтобы ответ старого периода не перезаписал новый.
const cache = new Map<string, any>();

export function invalidateOverview() { cache.clear(); }

export function useOverview() {
  const { query, days, label } = useAnalyticsPeriod();
  const [data, setData] = useState<any>(() => cache.get(query) ?? null);
  const [loading, setLoading] = useState(() => !cache.has(query));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const cached = cache.get(query) ?? null;
    setData(cached);
    setLoading(!cached);
    setRefreshing(Boolean(cached));
    setError('');
    try {
      const fresh = await api(`/dashboard/overview?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      cache.set(query, fresh);
      setData(fresh);
    } catch (cause: any) {
      if (controller.signal.aborted || cause?.name === 'AbortError') return;
      // Если в кэше уже есть данные этого периода — продолжаем показывать их,
      // ошибку фонового обновления не выпячиваем.
      if (!cache.has(query)) setError(cause?.message || 'Не удалось загрузить данные');
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); }
    }
  }, [query]);

  useEffect(() => { void reload(); return () => controllerRef.current?.abort(); }, [reload]);
  return { data, loading, refreshing, error, reload, query, days, label };
}
