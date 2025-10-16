// secure-fetch.js
// Adds your API key automatically to all /api requests
(function () {
  const API_KEY = 'kix-7d29f2d9ef3c4'; // your key
  const ALLOWED_HOSTS = new Set(['kixonair.com', 'www.kixonair.com', location.hostname]);
  const origFetch = window.fetch;

  function shouldAttach(u) {
    try {
      const url = new URL(u, location.origin);
      if (!ALLOWED_HOSTS.has(url.hostname)) return false;
      return url.pathname.startsWith('/api') ||
             url.pathname.startsWith('api') ||
             url.href.includes('/api/fixtures');
    } catch {
      return String(u || '').startsWith('/api') || String(u || '').includes('/api/fixtures');
    }
  }

  window.fetch = function (input, init) {
    const req = input && input.url ? input.url : input;
    let newInit = init || {};
    if (shouldAttach(req)) {
      const headers = new Headers(newInit.headers || {});
      if (!headers.has('x-api-key')) headers.set('x-api-key', API_KEY);
      newInit = Object.assign({}, newInit, { headers });
    }
    return origFetch.call(this, input, newInit);
  };
})();
