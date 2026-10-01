// Uzum Analytics — монитор конкурентов. Service worker (Manifest V3).
// Раз в N минут (intervalMinutes из targets, по умолчанию 180) снимает публичные
// данные карточек конкурентов uzum.uz и позиции своих товаров в поиске,
// затем отправляет снапшот на локальный сервер аналитики.

const DEFAULT_BASE = 'http://172.0.30.4:3200/api';
const DEFAULT_INTERVAL_MINUTES = 180;
const ALARM_NAME = 'uzum-monitor-run';
const MAX_PRODUCTS_PER_RUN = 50;
const SEARCH_TOP_LIMIT = 100;

let runInProgress = false;

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
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  runCollection('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runCollection('alarm');
});

// ---------- сообщения из popup ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

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

  if (message.type === 'status') {
    (async () => {
      const data = await getStorage(['serverBase', 'watchToken', 'lastRun']);
      sendResponse({
        ok: true,
        connected: Boolean(data.watchToken),
        serverBase: data.serverBase || DEFAULT_BASE,
        lastRun: data.lastRun || null,
        running: runInProgress,
      });
    })();
    return true;
  }

  return false;
});
