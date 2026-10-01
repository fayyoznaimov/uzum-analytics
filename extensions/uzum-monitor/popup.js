// Popup монитора конкурентов Uzum Analytics.

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
}

$('pairBtn').addEventListener('click', async () => {
  const code = $('pairCode').value.trim();
  if (!/^\d{6}$/.test(code)) {
    showMessage('Введите 6-значный код с экрана «Конкуренты»', true);
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

refreshStatus();
