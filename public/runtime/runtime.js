// runtime.js
// Browser-side dev runtime injected into every served HTML document.
//
// Responsibilities:
//   - open the SSE live-reload stream
//   - reload the page on file change (or soft-refresh on the index page)
//   - expose a small HUD: connection state, reload count, keyboard shortcuts
//   - offer a tiny console API for simulations (window.simHost.*)

const CONFIG = window.__SIM_HOST__ ?? {};

const HUD_ID = '__simhost_hud';
const TOAST_ID = '__simhost_toast';

// ---------------------------------------------------------------- HUD

function ensureStyles() {
  if (document.getElementById('__simhost_hud_style')) return;
  const style = document.createElement('style');
  style.id = '__simhost_hud_style';
  style.textContent = `
    #${HUD_ID} {
      position: fixed; bottom: 10px; right: 10px; z-index: 2147483647;
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; border-radius: 999px;
      background: rgba(18,20,26,.88); color: #cfd4e0;
      border: 1px solid rgba(255,255,255,.12);
      backdrop-filter: blur(8px);
      font: 12px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
      user-select: none; opacity: .5; transition: opacity .2s ease;
    }
    #${HUD_ID}:hover { opacity: 1; }
    #${HUD_ID} .dot { width: 8px; height: 8px; border-radius: 50%; background: #f0a03c; flex: none; }
    #${HUD_ID}.live .dot { background: #4ade80; }
    #${HUD_ID}.down .dot { background: #f87171; }
    #${HUD_ID} .meta { color: #8b93a7; }
    #${HUD_ID} .keys { color: #6f7688; letter-spacing: .02em; }
    #${TOAST_ID} {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%) translateY(-16px);
      z-index: 2147483647; padding: 8px 16px; border-radius: 999px;
      background: rgba(18,20,26,.94); color: #e6e9ef;
      border: 1px solid rgba(255,255,255,.14); font: 13px/1 ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,.4);
      opacity: 0; pointer-events: none; transition: opacity .18s ease, transform .18s ease;
    }
    #${TOAST_ID}.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  `;
  document.head.appendChild(style);
}

let hud = null;
let hudMeta = null;

function buildHud() {
  if (hud || CONFIG.hud === false) return;
  ensureStyles();

  hud = document.createElement('div');
  hud.id = HUD_ID;
  hud.innerHTML = '<span class="dot"></span><span class="state">connecting</span>'
    + '<span class="meta"></span><span class="keys">r reload · i index</span>';
  document.body.appendChild(hud);
  hudMeta = hud.querySelector('.meta');
}

function setHudState(state, detail = '') {
  if (!hud) return;
  hud.classList.remove('live', 'down');
  if (state === 'live') hud.classList.add('live');
  if (state === 'down') hud.classList.add('down');
  hud.querySelector('.state').textContent = state;
  if (hudMeta) hudMeta.textContent = detail;
}

// ---------------------------------------------------------------- Toast

let toastTimer = null;

function toast(message, ms = 1800) {
  let el = document.getElementById(TOAST_ID);
  if (!el) {
    ensureStyles();
    el = document.createElement('div');
    el.id = TOAST_ID;
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- Reload

let reloadCount = 0;

function doReload(reason) {
  reloadCount += 1;
  if (typeof CONFIG.onBeforeReload === 'function') {
    try { CONFIG.onBeforeReload(reason); } catch { /* never block a reload */ }
  }
  // Cache-bust so the browser cannot serve a stale document from memory cache.
  const url = new URL(location.href);
  url.searchParams.set('_r', String(Date.now()));
  location.replace(url.toString());
}

function refreshIndex(reason) {
  if (CONFIG.index && typeof window.location.reload === 'function') {
    window.location.reload();
    return;
  }
  doReload(reason);
}

// ---------------------------------------------------------------- SSE

function connect() {
  if (CONFIG.liveReload === false || CONFIG.reload === false) {
    setHudState('static', 'reload off');
    return;
  }
  if (typeof EventSource === 'undefined') {
    setHudState('na', 'no EventSource');
    return;
  }

  let source;
  let retry = 0;

  const open = () => {
    source = new EventSource('/__simhost/live');

    source.addEventListener('hello', (event) => {
      retry = 0;
      let data = {};
      try { data = JSON.parse(event.data); } catch { /* ignore */ }
      setHudState('live', data.clients > 1 ? `${data.clients} tabs` : '');
    });

    source.addEventListener('reload', (event) => {
      let reason = 'change';
      try { reason = JSON.parse(event.data).reason ?? reason; } catch { /* ignore */ }
      toast(`reloading · ${reason}`);
      setTimeout(() => doReload(reason), 120);
    });

    source.addEventListener('index', () => {
      toast('index updated');
      refreshIndex('index updated');
    });

    source.addEventListener('clients', (event) => {
      let count = 1;
      try { count = JSON.parse(event.data).count ?? 1; } catch { /* ignore */ }
      if (hudMeta) hudMeta.textContent = count > 1 ? `${count} tabs` : '';
    });

    source.onerror = () => {
      setHudState('down', 'reconnecting');
      source.close();
      retry += 1;
      const delay = Math.min(500 * 2 ** (retry - 1), 8000);
      setTimeout(open, delay);
    };
  };

  open();
}

// ---------------------------------------------------------------- Keys

function installShortcuts() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target && (
      target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.isContentEditable
    );
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case 'r':
        event.preventDefault();
        doReload('manual');
        break;
      case 'i':
        event.preventDefault();
        location.href = '/';
        break;
      default:
        break;
    }
  });
}

// ---------------------------------------------------------------- API

function installApi() {
  const api = {
    version: 1,
    config: CONFIG,
    reload: () => doReload('api'),
    toast,
    /** Registers a teardown hook that runs just before an automatic reload. */
    onBeforeReload(fn) {
      if (typeof fn === 'function') CONFIG.onBeforeReload = fn;
    },
    /** Reports a sim status string shown in the HUD. */
    status(text) {
      if (hudMeta) hudMeta.textContent = String(text ?? '');
    },
    get reloadCount() { return reloadCount; },
  };
  window.simHost = api;
}

function start() {
  const boot = () => {
    buildHud();
    installApi();
    installShortcuts();
    connect();
    if (CONFIG.name) setHudState('static', CONFIG.name);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

start();