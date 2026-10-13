/* 本地门禁只处理网络/外部导航，不修改游戏仿真或本地存储。 */
(() => {
  const devStyle = document.createElement('style');
  devStyle.textContent = '.dev-presets,.dev-strip{display:none!important;pointer-events:none!important}';
  document.head.appendChild(devStyle);
  const blocked = (value) => {
    const url = new URL(typeof value === 'string' || value instanceof URL ? value : value.url, location.href);
    return url.origin !== location.origin || /^\/api(?:\/|$)/.test(url.pathname);
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      if (blocked(input)) return Promise.reject(new Error('本地版不提供在线服务或反馈'));
      return nativeFetch(input, init);
    } catch (error) { return Promise.reject(error); }
  };
  if (typeof navigator.sendBeacon === 'function') {
    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      try { return blocked(url) ? false : nativeBeacon(url, data); }
      catch { return false; }
    };
  }
  const nativeOpen = window.open.bind(window);
  window.open = (url, ...args) => {
    if (!url) return null;
    try { return blocked(url) ? null : nativeOpen(url, ...args); }
    catch { return null; }
  };
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    try {
      if (blocked(anchor.href)) {
        event.preventDefault();
        anchor.title = '本地版不打开外部链接';
      }
    } catch { event.preventDefault(); }
  }, true);
  window.__ASHFALL_OFFLINE__ = true;
})();
