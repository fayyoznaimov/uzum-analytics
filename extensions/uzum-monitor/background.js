// Uzum Analytics — монитор конкурентов. Service worker (Manifest V3).
// Раз в N минут (intervalMinutes из targets, по умолчанию 180) снимает публичные
// данные карточек конкурентов uzum.uz и позиции своих товаров в поиске,
// затем отправляет снапшот на локальный сервер аналитики.
// Каждые 2 минуты проверяет и бронирует тайм-слоты FBO-поставок (задания даёт сервер) — см. раздел «тайм-слоты».

importScripts('slot-logic.js');

const DEFAULT_BASE = 'http://172.0.30.4:3200/api';
const DEFAULT_INTERVAL_MINUTES = 180;
const ALARM_NAME = 'uzum-monitor-run';
const MAX_PRODUCTS_PER_RUN = 50;
const SEARCH_TOP_LIMIT = 100;
const SLOT_ALARM = 'uzum-slot-watch';
const DEFAULT_SLOT_INTERVAL_MINUTES = 2;
const SLOT_TASKS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CABINET_API = 'https://api-seller.uzum.uz/api/seller';

let runInProgress = false;
let slotRunInProgress = false;

// ---------- утилиты ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Пауза между карточками: 1500–3000 мс с джиттером.
function productPause() {
  return sleep(1500 + Math.floor(Math.random() * 1500));
}

async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(obj) {
  return chrome.storage.local.set(obj);
}

function normalizeBase(raw) {
  let base = String(raw || '').trim();
  if (!base) return DEFAULT_BASE;
  base = base.replace(/\/+$/, '');
  if (!/\/api$/.test(base)) base += '/api';
  return base;
}

// Число из number или строки; всё остальное -> null.
function toNum(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/\s+/g, '').replace(',', '.');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Первое непустое поле из списка snake/camel-вариантов.
function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null) return obj[name];
  }
  return undefined;
}

// ---------- парсер карточки товара (защитный) ----------

// Ответ api.uzum.uz, вероятно { payload: { data: {...} } }, но пишем защитно:
// ищем объект товара на нескольких уровнях, имена полей — snake/camel.
function extractProductData(json) {
  const candidates = [
    json && json.payload && json.payload.data,
    json && json.payload,
    json && json.data && json.data.payload,
    json && json.data,
    json,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const hasSignal =
        pick(c, ['title', 'name']) !== undefined ||
        pick(c, ['skus', 'skuList', 'sku_list']) !== undefined ||
        pick(c, ['orders_amount', 'ordersAmount', 'orders_quantity', 'ordersQuantity']) !== undefined;
      if (hasSignal) return c;
    }
  }
  return null;
}

function parseProduct(productId, json) {
  const data = extractProductData(json);
  if (!data) throw new Error('не найден объект товара в ответе');

  const title = pick(data, ['title', 'name']);
  const rating = toNum(pick(data, ['rating', 'reviews_rating', 'reviewsRating', 'rate']));
  const reviewsCount = toNum(
    pick(data, ['reviews_amount', 'reviewsAmount', 'reviews_count', 'reviewsCount', 'feedback_quantity', 'feedbackQuantity'])
  );
  const ordersAmount = toNum(
    pick(data, ['orders_amount', 'ordersAmount', 'orders_quantity', 'ordersQuantity', 'r_orders_amount', 'rOrdersAmount'])
  );

  let skus = pick(data, ['skus', 'skuList', 'sku_list']);
  if (!Array.isArray(skus)) skus = [];

  let price = null;
  let fullPrice = null;
  let available = null;

  for (const sku of skus) {
    if (!sku || typeof sku !== 'object') continue;
    const skuAvailable = toNum(
      pick(sku, ['available_amount', 'availableAmount', 'available', 'rest_amount', 'restAmount'])
    );
    const skuPrice = toNum(
      pick(sku, ['purchase_price', 'purchasePrice', 'sell_price', 'sellPrice', 'price'])
    );
    const skuFull = toNum(pick(sku, ['full_price', 'fullPrice', 'old_price', 'oldPrice']));

    if (skuAvailable !== null) available = (available ?? 0) + skuAvailable;

    // Цена — минимальная цена доступного SKU (если доступность неизвестна, SKU тоже учитываем).
    const isAvailable = skuAvailable === null || skuAvailable > 0;
    if (skuPrice !== null && isAvailable && (price === null || skuPrice < price)) {
      price = skuPrice;
      fullPrice = skuFull;
    }
  }

  // Фолбэк: цена на уровне товара, если по SKU не нашлось.
  if (price === null) {
    price = toNum(pick(data, ['purchase_price', 'purchasePrice', 'min_sell_price', 'minSellPrice', 'price']));
  }
  if (fullPrice === null) {
    fullPrice = toNum(pick(data, ['full_price', 'fullPrice', 'min_full_price', 'minFullPrice']));
  }

  if (title === undefined && price === null && ordersAmount === null) {
    throw new Error('ответ не содержит ни названия, ни цены, ни заказов');
  }

  return {
    productId: String(productId),
    title: title !== undefined ? String(title) : null,
    price,
    fullPrice,
    available,
    ordersAmount,
    rating,
    reviewsCount,
  };
}

async function fetchProduct(productId) {
  const res = await fetch(`https://api.uzum.uz/api/v2/product/${encodeURIComponent(productId)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return parseProduct(productId, json);
}

// ---------- позиции в поиске ----------

// Ищем в HTML ссылки вида /product/...-<id> по порядку появления,
// затем позиции собственных ownProductIds в первой ~сотне результатов.
function parseSearchHtml(html, ownProductIds) {
  const seen = new Set();
  const ordered = [];
  const linkRe = /\/product\/[^"'\s<>]*?-(\d+)(?=["'?#\s<>/])/g;
  let m;
  while ((m = linkRe.exec(html)) !== null && ordered.length < SEARCH_TOP_LIMIT) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }

  // totalResults — если найдётся во встроенном JSON.
  let totalResults = null;
  const totalRe = /"(?:total|totalResults|total_results|totalProducts|total_products|totalItems|total_items)"\s*:\s*"?(\d+)"?/;
  const t = html.match(totalRe);
  if (t) totalResults = toNum(t[1]);

  const positions = [];
  for (const ownId of ownProductIds) {
    const idx = ordered.indexOf(String(ownId));
    if (idx !== -1) {
      positions.push({ productExternalId: String(ownId), position: idx + 1, totalResults });
    }
  }
  return { positions, totalResults };
}

async function collectPositions(positionQueries, ownProductIds, errors) {
  const result = [];
  for (const query of positionQueries) {
    try {
      const res = await fetch(`https://uzum.uz/ru/search?query=${encodeURIComponent(query)}`, {
        headers: { Accept: 'text/html' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const parsed = parseSearchHtml(html, ownProductIds);
      for (const p of parsed.positions) {
        result.push({
          query,
          productExternalId: p.productExternalId,
          position: p.position,
          page: 1,
          totalResults: p.totalResults,
        });
      }
    } catch (e) {
      errors.push(`поиск «${query}»: ${e && e.message ? e.message : e}`);
    }
    await productPause();
  }
  return result;
}

// ---------- прогон ----------

async function apiFetch(base, path, options) {
  const res = await fetch(base + path, options);
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* не JSON — оставим null */
  }
  if (!res.ok) {
    const msg = body && (body.message || body.error) ? `${res.status}: ${JSON.stringify(body.message || body.error)}` : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

async function runCollection(trigger) {
  if (runInProgress) return { skipped: true };
  runInProgress = true;
  const startedAt = new Date().toISOString();
  const errors = [];
  let snapshots = 0;
  let positionsCount = 0;

  try {
    const { serverBase, watchToken } = await getStorage(['serverBase', 'watchToken']);
    const base = normalizeBase(serverBase);
    if (!watchToken) {
      throw new Error('расширение не подключено: введите код подключения в окне расширения');
    }
    const headers = { 'x-watch-token': watchToken };

    // 1. targets
    const targets = await apiFetch(base, '/competitor-watch/targets', { headers });
    const products = Array.isArray(targets && targets.products) ? targets.products : [];
    const ownProductIds = Array.isArray(targets && targets.ownProductIds) ? targets.ownProductIds : [];
    const positionQueries = Array.isArray(targets && targets.positionQueries) ? targets.positionQueries : [];
    const intervalMinutes = toNum(targets && targets.intervalMinutes) || DEFAULT_INTERVAL_MINUTES;
    await rescheduleAlarm(intervalMinutes);

    // 2. карточки конкурентов (<= 50 за прогон)
    const productSnapshots = [];
    const slice = products.slice(0, MAX_PRODUCTS_PER_RUN);
    if (products.length > MAX_PRODUCTS_PER_RUN) {
      errors.push(`товаров больше ${MAX_PRODUCTS_PER_RUN} (${products.length}), лишние пропущены`);
    }
    for (const productId of slice) {
      try {
        productSnapshots.push(await fetchProduct(productId));
      } catch (e) {
        errors.push(`карточка ${productId}: ${e && e.message ? e.message : e}`);
      }
      await productPause();
    }
    snapshots = productSnapshots.length;

    // 3. позиции в поиске (необязательный блок)
    let positions = [];
    try {
      if (positionQueries.length && ownProductIds.length) {
        positions = await collectPositions(positionQueries, ownProductIds, errors);
      }
    } catch (e) {
      errors.push(`позиции: ${e && e.message ? e.message : e}`);
      positions = [];
    }
    positionsCount = positions.length;

    // 4. ingest
    if (productSnapshots.length || positions.length) {
      const body = { products: productSnapshots };
      if (positions.length) body.positions = positions;
      await apiFetch(base, '/competitor-watch/ingest', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      errors.push('нечего отправлять: ни одного снапшота не собрано');
    }
  } catch (e) {
    errors.push(String(e && e.message ? e.message : e));
  } finally {
    runInProgress = false;
  }

  const lastRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger,
    snapshots,
    positions: positionsCount,
    errors,
  };
  await setStorage({ lastRun });
  if (errors.length) {
    console.warn('[uzum-monitor] прогон завершён с ошибками:', errors);
  } else {
    console.info(`[uzum-monitor] прогон ок: снапшотов ${snapshots}, позиций ${positionsCount}`);
  }
  return lastRun;
}

// ---------- тайм-слоты поставок FBO ----------
// Сервер даёт группы накладных (общий привоз), расширение спрашивает свободные слоты у кабинета входом владельца,
// само бронирует самый ранний подходящий (правило — slot-logic.js, как на сервере) и присылает отчёт. С сервера
// кабинет часто закрыт Cloudflare, из браузера владельца — нет. Вход в кабинет на сервер не отправляется.

function errorText(e) {
  return String(e && e.message ? e.message : e);
}

function cabinetErrorText(status, text) {
  if (status === 401) return 'кабинет не принял вход (401) — откройте seller.uzum.uz в этом Chrome, расширение возьмёт свежий вход';
  if (status === 403 && /cloudflare|just a moment|cf-chl/i.test(text || '')) return 'Cloudflare не пускает браузер в кабинет (403)';
  let detail = '';
  try {
    const json = JSON.parse(text);
    const first = json && Array.isArray(json.errors) ? json.errors[0] : null;
    detail = (json && (json.message || json.error)) || (first && (first.message || first.code)) || '';
  } catch (_) {
    detail = '';
  }
  return `кабинет ответил HTTP ${status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`;
}

async function cabinetFetchDirect(method, path, body, token) {
  const res = await fetch(CABINET_API + path, {
    method,
    credentials: 'include',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

// Тот же запрос из открытой вкладки кабинета — так, как его делает сам кабинет (его входом и cookie).
async function cabinetFetchInTab(method, path, body) {
  const tabs = await chrome.tabs.query({ url: 'https://seller.uzum.uz/*' });
  if (!tabs.length) return null;
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    world: 'MAIN',
    func: async (url, method, body) => {
      let token = null;
      try {
        const state = JSON.parse(localStorage.getItem('state') || '{}');
        token = state && state.user && state.user.tokens && state.user.tokens.access;
      } catch (_) {
        token = null;
      }
      if (!token) return null;
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, text: await res.text() };
    },
    args: [CABINET_API + path, method, body || null],
  });
  return injection && injection.result ? injection.result : null;
}

// readOnly — запрос ничего не меняет, его можно повторить через вкладку даже после сетевой ошибки. Бронь повторяется
// только после 401/403 (такой запрос кабинет не выполнял): лишняя смена слота съедает одну из трёх попыток.
async function cabinetFetch(method, path, body, readOnly) {
  const { cabinetToken } = await getStorage(['cabinetToken']);
  let answer = null;
  let networkError = null;
  if (cabinetToken) {
    try {
      answer = await cabinetFetchDirect(method, path, body, cabinetToken);
    } catch (e) {
      networkError = e;
    }
  }
  const retry = answer ? answer.status === 401 || answer.status === 403 : !cabinetToken || readOnly;
  if (retry) {
    const viaTab = await cabinetFetchInTab(method, path, body).catch(() => null);
    if (viaTab) answer = viaTab;
  }
  if (!answer) {
    if (!cabinetToken) throw new Error('нет входа в кабинет — откройте seller.uzum.uz в этом Chrome, расширение запомнит вход');
    throw new Error(`кабинет недоступен: ${errorText(networkError)}`);
  }
  if (answer.status < 200 || answer.status >= 300) throw new Error(cabinetErrorText(answer.status, answer.text));
  try {
    return answer.text ? JSON.parse(answer.text) : null;
  } catch (_) {
    throw new Error('кабинет ответил не JSON');
  }
}

// Одна группа накладных: слоты → выбор → свежие данные накладных → бронь или перенос на день раньше → проверка.
async function checkSlotGroup(group, tasks) {
  const leadHours = tasks.leadHours;
  const invoiceIds = (Array.isArray(group.invoiceIds) ? group.invoiceIds : []).map(String);
  const shop = encodeURIComponent(String(group.shopId));
  const base = { invoiceIds, checkedAt: Date.now() };
  try {
    const body = await cabinetFetch('POST', `/shop/${shop}/v2/invoice/time-slot/get`, {
      invoiceIds: invoiceIds.map(Number),
      poolSource: group.poolSource,
      timeFrom: Date.now() + 60 * 60 * 1000,
    }, true);
    const slots = SlotLogic.parseSlots(body);
    const pick = SlotLogic.pickSlot(slots, { leadHours, windowFrom: group.windowFrom, windowTo: group.windowTo }, Date.now());
    if (!group.autoBook) return pick ? { ...base, slots: slots.length, matched: { timeFrom: pick.timeFrom, timeTo: pick.timeTo } } : { ...base, slots: slots.length };
    // Слот уже есть (по данным сервера), а найденный не раньше днём — накладные лишний раз не спрашиваем.
    if (!pick || (group.reservedFrom && !SlotLogic.earlierDay(pick.timeFrom, group.reservedFrom))) return { ...base, slots: slots.length };
    const matched = { timeFrom: pick.timeFrom, timeTo: pick.timeTo };
    // Перед бронью — свежие данные: слот мог выбрать владелец, а каждая смена слота съедает одну из трёх.
    const states = [];
    for (const id of invoiceIds) {
      states.push(SlotLogic.invoiceState(id, await cabinetFetch('GET', `/shop/${shop}/invoice/${encodeURIComponent(id)}`, null, true)));
    }
    const reservations = states.filter((s) => s.reservation).map((s) => ({ invoiceId: s.invoiceId, timeFrom: s.reservation.timeFrom, timeTo: s.reservation.timeTo }));
    const decision = SlotLogic.decide(states, pick, Date.now(), tasks);
    if (decision.action === 'stop') return { ...base, slots: slots.length, reservations, stop: decision.reason };
    if (decision.action === 'wait') return { ...base, slots: slots.length, reservations };
    try {
      await cabinetFetch('POST', `/shop/${shop}/v2/invoice/time-slot/set`, {
        timeFrom: pick.timeFrom,
        invoiceIds: invoiceIds.map(Number),
        stockId: group.stockId,
        poolSource: group.poolSource,
      }, false);
    } catch (e) {
      return { ...base, slots: slots.length, reservations, matched, bookError: errorText(e) };
    }
    let booked = matched;
    try {
      const invoice = await cabinetFetch('GET', `/shop/${shop}/invoice/${encodeURIComponent(invoiceIds[0])}`, null, true);
      booked = SlotLogic.reservationOf(invoice) || matched;
    } catch (_) {
      booked = matched;
    }
    const moved = decision.action === 'move';
    console.info(`[uzum-monitor] ${moved ? 'перенесён' : 'забронирован'} слот ${SlotLogic.formatSlot(booked)} для накладных ${invoiceIds.join(', ')}`);
    return { ...base, checkedAt: Date.now(), slots: slots.length, matched: booked, booked: true, moved, previous: moved ? decision.current : null };
  } catch (e) {
    return { ...base, error: errorText(e) };
  }
}

// Неотправленные отчёты: брони и найденные слоты храним все (до 20), обычные проверки — только последнюю на группу.
function compactReports(list) {
  const important = [];
  const latest = new Map();
  for (const row of list) {
    if (row.booked || row.reserved || row.matched || row.stop) important.push(row);
    else latest.set(row.invoiceIds.join(','), row);
  }
  return [...important.slice(-20), ...latest.values()];
}

async function runSlotWatch(trigger) {
  if (slotRunInProgress) return null;
  slotRunInProgress = true;
  const summary = { at: Date.now(), trigger, groups: 0, slots: 0, booked: [], errors: [], server: 'ok' };
  try {
    const data = await getStorage(['serverBase', 'watchToken', 'slotTasks', 'slotReports']);
    if (!data.watchToken) {
      summary.errors.push('расширение не подключено к серверу');
      return summary;
    }
    const base = normalizeBase(data.serverBase);
    const headers = { 'x-watch-token': data.watchToken };
    let tasks = null;
    try {
      tasks = await apiFetch(base, '/competitor-watch/slot-tasks', { headers });
      await setStorage({ slotTasks: { ...tasks, fetchedAt: Date.now() } });
      await rescheduleSlotAlarm(tasks && tasks.intervalMinutes);
    } catch (e) {
      summary.server = `сервер недоступен: ${errorText(e)}`;
      // Сервер не отвечает (другая сеть) — работаем по последнему заданию, отчёт отправим позже.
      if (data.slotTasks && Date.now() - Number(data.slotTasks.fetchedAt || 0) < SLOT_TASKS_MAX_AGE_MS) tasks = data.slotTasks;
    }
    let reports = Array.isArray(data.slotReports) ? data.slotReports : [];
    const groups = tasks && Array.isArray(tasks.groups) ? tasks.groups : [];
    summary.groups = groups.length;
    for (const group of groups) {
      const result = await checkSlotGroup(group, tasks);
      reports.push(result);
      if (typeof result.slots === 'number') summary.slots += result.slots;
      if (result.booked) summary.booked.push(`${group.labels || result.invoiceIds.join(', ')}: ${SlotLogic.formatSlot(result.matched)}${result.moved ? ' (перенос раньше)' : ''}`);
      if (result.stop) summary.errors.push(result.stop);
      if (result.error) summary.errors.push(result.error);
      if (result.bookError) summary.errors.push(`бронь не прошла: ${result.bookError}`);
    }
    reports = compactReports(reports);
    if (reports.length) {
      try {
        await apiFetch(base, '/competitor-watch/slot-report', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ results: reports }),
        });
        reports = [];
      } catch (e) {
        if (summary.server === 'ok') summary.server = `отчёт не отправлен: ${errorText(e)}`;
      }
    }
    await setStorage({ slotReports: reports });
  } catch (e) {
    summary.errors.push(errorText(e));
  } finally {
    slotRunInProgress = false;
    await setStorage({ lastSlotRun: summary });
  }
  if (summary.errors.length) console.warn('[uzum-monitor] слоты:', summary.errors);
  return summary;
}

async function rescheduleSlotAlarm(intervalMinutes) {
  const minutes = Math.max(1, toNum(intervalMinutes) || DEFAULT_SLOT_INTERVAL_MINUTES);
  const { slotAlarmInterval } = await getStorage(['slotAlarmInterval']);
  const existing = await chrome.alarms.get(SLOT_ALARM);
  if (!existing || slotAlarmInterval !== minutes) {
    await chrome.alarms.create(SLOT_ALARM, { periodInMinutes: minutes, delayInMinutes: minutes });
    await setStorage({ slotAlarmInterval: minutes });
  }
}

async function ensureSlotAlarm() {
  const { slotAlarmInterval } = await getStorage(['slotAlarmInterval']);
  await rescheduleSlotAlarm(slotAlarmInterval || DEFAULT_SLOT_INTERVAL_MINUTES);
}

// ---------- расписание ----------

async function rescheduleAlarm(intervalMinutes) {
  const minutes = Math.max(1, toNum(intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
  const { alarmInterval } = await getStorage(['alarmInterval']);
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || alarmInterval !== minutes) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes, delayInMinutes: minutes });
    await setStorage({ alarmInterval: minutes });
  }
}

async function ensureAlarm() {
  const { alarmInterval } = await getStorage(['alarmInterval']);
  await rescheduleAlarm(alarmInterval || DEFAULT_INTERVAL_MINUTES);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  ensureSlotAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  ensureSlotAlarm();
  runSlotWatch('startup');
  runCollection('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runCollection('alarm');
  if (alarm.name === SLOT_ALARM) runSlotWatch('alarm');
});

// ---------- сообщения из popup ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  // Вход в кабинет от content script вкладки seller.uzum.uz (cabinet-token.js); хранится только здесь.
  if (message.type === 'cabinetToken') {
    if (sender.id !== chrome.runtime.id || !sender.url || !sender.url.startsWith('https://seller.uzum.uz/')) return false;
    const token = typeof message.token === 'string' ? message.token.trim() : '';
    if (!token || token.length > 4096) return false;
    (async () => {
      const { cabinetToken } = await getStorage(['cabinetToken']);
      if (cabinetToken !== token) await setStorage({ cabinetToken: token, cabinetTokenAt: Date.now() });
      await setStorage({ cabinetTokenSeenAt: Date.now() });
    })();
    return false;
  }

  if (message.type === 'pair') {
    (async () => {
      try {
        const base = normalizeBase(message.serverBase);
        const result = await apiFetch(base, '/competitor-watch/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: String(message.code || '').trim() }),
        });
        if (!result || !result.token) throw new Error('сервер не вернул токен');
        await setStorage({ serverBase: base, watchToken: result.token });
        await ensureAlarm();
        await ensureSlotAlarm();
        runSlotWatch('pair');
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (message.type === 'runNow') {
    (async () => {
      const lastRun = await runCollection('manual');
      sendResponse({ ok: true, lastRun });
    })();
    return true;
  }

  if (message.type === 'slotNow') {
    (async () => {
      const lastSlotRun = await runSlotWatch('manual');
      sendResponse({ ok: true, lastSlotRun });
    })();
    return true;
  }

  if (message.type === 'status') {
    (async () => {
      const data = await getStorage(['serverBase', 'watchToken', 'lastRun', 'lastSlotRun', 'cabinetToken', 'cabinetTokenSeenAt']);
      sendResponse({
        ok: true,
        connected: Boolean(data.watchToken),
        serverBase: data.serverBase || DEFAULT_BASE,
        lastRun: data.lastRun || null,
        running: runInProgress,
        lastSlotRun: data.lastSlotRun || null,
        slotRunning: slotRunInProgress,
        cabinetLogin: Boolean(data.cabinetToken),
        cabinetLoginSeenAt: data.cabinetTokenSeenAt || null,
      });
    })();
    return true;
  }

  return false;
});
