// Popup расширения Uzum Analytics: монитор конкурентов и тайм-слоты поставок.

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: 'нет ответа от фонового скрипта' });
      }
    });
  });
}

function showMessage(text, isError) {
  const el = $('message');
  el.textContent = text || '';
  el.style.color = isError ? '#C23A3A' : '#1C8A4D';
}

function formatLastRun(lastRun, running) {
  if (running) return 'Идёт сбор данных…';
  if (!lastRun) return 'Прогонов ещё не было';
  const when = new Date(lastRun.finishedAt || lastRun.startedAt);
  const time = Number.isNaN(when.getTime())
    ? '—'
    : when.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const errs = Array.isArray(lastRun.errors) ? lastRun.errors.length : 0;
  let line = `Последний прогон: ${time}, снапшотов: ${lastRun.snapshots ?? 0}, позиций: ${lastRun.positions ?? 0}, ошибок: ${errs}`;
  if (errs) line += ` — ${lastRun.errors[0]}`;
  return line;
}

function formatSlotRun(run, running) {
  if (running) return 'Идёт проверка слотов…';
  if (!run) return 'Проверок ещё не было';
  const when = new Date(run.at);
  const time = Number.isNaN(when.getTime()) ? '—' : when.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (!run.groups && !(run.errors || []).length) return `Проверено ${time}: накладных в ожидании слота нет`;
  let line = `Проверено ${time}: групп накладных ${run.groups}, свободных слотов ${run.slots}`;
  if (run.booked && run.booked.length) line += `. Забронировано: ${run.booked.join('; ')}`;
  if (run.errors && run.errors.length) line += `. Ошибка: ${run.errors[0]}`;
  if (run.server && run.server !== 'ok') line += `. ${run.server}`;
  return line;
}

async function refreshStatus() {
  const status = await send({ type: 'status' });
  if (!status.ok) {
    showMessage(status.error || 'не удалось получить статус', true);
    return;
  }
  const conn = $('connState');
  if (status.connected) {
    conn.textContent = 'подключено';
    conn.className = 'ok';
  } else {
    conn.textContent = 'не подключено';
    conn.className = 'bad';
  }
  if (!$('serverBase').value) $('serverBase').value = status.serverBase || '';
  $('lastRun').textContent = formatLastRun(status.lastRun, status.running);
  $('runBtn').disabled = !status.connected || Boolean(status.running);
  const cabinet = $('cabinetState');
  cabinet.textContent = status.cabinetLogin ? 'есть' : 'нет — откройте seller.uzum.uz в этом Chrome';
  cabinet.className = status.cabinetLogin ? 'ok' : 'bad';
  $('lastSlotRun').textContent = formatSlotRun(status.lastSlotRun, status.slotRunning);
  $('slotBtn').disabled = !status.connected || Boolean(status.slotRunning);
}

$('pairBtn').addEventListener('click', async () => {
  const code = $('pairCode').value.trim();
  if (!/^\d{6}$/.test(code)) {
    showMessage('Введите 6-значный код: Склад и поставки → Поставки → «Код для расширения»', true);
    return;
  }
  $('pairBtn').disabled = true;
  showMessage('Подключение…', false);
  const result = await send({ type: 'pair', serverBase: $('serverBase').value, code });
  $('pairBtn').disabled = false;
  if (result.ok) {
    showMessage('Подключено. Сбор запустится по расписанию.', false);
    $('pairCode').value = '';
  } else {
    showMessage(`Ошибка подключения: ${result.error}`, true);
  }
  await refreshStatus();
});

$('runBtn').addEventListener('click', async () => {
  $('runBtn').disabled = true;
  showMessage('Сбор запущен, это может занять несколько минут…', false);
  const result = await send({ type: 'runNow' });
  if (result.ok && result.lastRun) {
    const errs = Array.isArray(result.lastRun.errors) ? result.lastRun.errors.length : 0;
    showMessage(errs ? `Готово, но есть ошибки (${errs}) — см. статус ниже` : 'Готово, данные отправлены', errs > 0);
  } else {
    showMessage(`Ошибка: ${result.error || 'неизвестная'}`, true);
  }
  await refreshStatus();
});

$('slotBtn').addEventListener('click', async () => {
  $('slotBtn').disabled = true;
  showMessage('Проверяем слоты…', false);
  const result = await send({ type: 'slotNow' });
  const run = result && result.lastSlotRun;
  if (result.ok && run) {
    const errs = (run.errors || []).length;
    showMessage(errs ? 'Проверка с ошибкой — см. ниже' : run.booked && run.booked.length ? 'Слот забронирован' : 'Проверено, отчёт отправлен на сервер', errs > 0);
  } else {
    showMessage(`Ошибка: ${(result && result.error) || 'проверка уже идёт'}`, true);
  }
  await refreshStatus();
});

refreshStatus();
