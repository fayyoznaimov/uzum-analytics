// Content script кабинета seller.uzum.uz: передаёт фоновому скрипту расширения текущий вход владельца в кабинет,
// чтобы проверять тайм-слоты поставок, когда вкладка кабинета закрыта. Вход хранится только в этом Chrome
// (chrome.storage.local расширения) и на сервер аналитики не отправляется.

(function () {
  function send() {
    let token = null;
    try {
      const state = JSON.parse(localStorage.getItem('state') || '{}');
      token = state && state.user && state.user.tokens && state.user.tokens.access;
    } catch (_) {
      token = null;
    }
    if (typeof token !== 'string' || !token) return;
    try {
      chrome.runtime.sendMessage({ type: 'cabinetToken', token });
    } catch (_) {
      // расширение перезагружено — эта копия скрипта больше не нужна
      clearInterval(timer);
    }
  }
  const timer = setInterval(send, 5 * 60 * 1000);
  send();
})();
