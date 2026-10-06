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
      /* Clear the home indicator on notched phones. */
      bottom: calc(10px + env(safe-area-inset-bottom, 0px));
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
    /* Touch devices have no hover, so the pill stayed half-transparent and,
       being fixed, sat on top of the code editor swallowing taps. */
    @media (hover: none) and (pointer: coarse) {
      #${HUD_ID} { display: none; }
    }
    #${HUD_ID} .dot { width: 8px; height: 8px; border-radius: 50%; background: #f0a03c; flex: none; }
    #${HUD_ID}.live .dot { background: #4ade80; }
    #${HUD_ID}.down .dot { background: #f87171; }
    #${HUD_ID} .meta { color: #8b93a7; }
    #${HUD_ID} .keys { color: #6f7688; letter-spacing: .02em; }
    #${TOAST_ID} {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%) translateY(-16px);
      z-index: 2147483647; padding: 8px 16px; border-radius: 999px;
      max-width: calc(100vw - 24px);
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

// ---------------------------------------------------------------- Errors

const ERROR_OVERLAY_ID = '__simhost_error';
let errorCount = 0;

/**
 * Renders uncaught errors on the page itself.
 *
 * Without this a throw inside a requestAnimationFrame loop is invisible unless
 * DevTools is open, and while watching a canvas you are not looking at DevTools.
 * The console is still the source of truth; this just puts the message where
 * the work is happening.
 */
function showError(message, detail, kind) {
  errorCount += 1;

  let overlay = document.getElementById(ERROR_OVERLAY_ID);
  if (!overlay) {
    ensureStyles();
    overlay = document.createElement('div');
    overlay.id = ERROR_OVERLAY_ID;
    // Shadow DOM keeps simulation styles from restyling the overlay and the
    // overlay from leaking into the simulation. The mode must be 'open':
    // showError() re-reads overlay.shadowRoot on every call, and a closed root
    // returns null, so the second error - and every overlay after it - would
    // fail to render.
    const shadow = overlay.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .box {
          position: fixed; z-index: 2147483647; left: 12px; right: 12px; bottom: 12px;
          max-height: 42vh; overflow: auto;
          background: #2a0e12; color: #ffe4e6;
          border: 1px solid #7f1d2d; border-radius: 10px;
          font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
          box-shadow: 0 12px 40px rgba(0,0,0,.55);
        }
        .warn { background: #2a230c; border-color: #78350f; color: #fef3c7; }
        .head {
          display: flex; align-items: center; gap: 10px; padding: 8px 12px;
          border-bottom: 1px solid rgba(255,255,255,.12); position: sticky; top: 0;
          background: inherit;
        }
        .title { font-weight: 700; letter-spacing: .02em; }
        .count { color: rgba(255,255,255,.6); }
        .spacer { flex: 1; }
        button {
          font: inherit; color: inherit; cursor: pointer;
          background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.2);
          border-radius: 6px; padding: 3px 9px;
        }
        button:hover { background: rgba(255,255,255,.16); }
        pre { margin: 0; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; }
      </style>
      <div class="box" part="box">
        <div class="head">
          <span class="title"></span>
          <span class="count"></span>
          <span class="spacer"></span>
          <button data-act="clear">Clear</button>
          <button data-act="close">Hide</button>
        </div>
        <pre></pre>
      </div>`;

    shadow.querySelector('[data-act="close"]').addEventListener('click', () => {
      overlay.style.display = 'none';
    });
    shadow.querySelector('[data-act="clear"]').addEventListener('click', () => {
      errorCount = 0;
      shadow.querySelector('pre').textContent = '';
      shadow.querySelector('.count').textContent = '';
    });

    document.body.appendChild(overlay);
  }

  const shadow = overlay.shadowRoot;
  if (!shadow) return;
  overlay.style.display = '';
  shadow.querySelector('.box').classList.toggle('warn', kind === 'warn');
  shadow.querySelector('.title').textContent = kind === 'warn' ? 'sim-host' : 'Uncaught error';
  shadow.querySelector('.count').textContent = errorCount > 1 ? `(${errorCount})` : '';
  shadow.querySelector('pre').textContent = detail
    ? `${message}\n${String(detail).split('\n').slice(0, 6).join('\n')}`
    : message;
}

function clearErrors() {
  errorCount = 0;
  const overlay = document.getElementById(ERROR_OVERLAY_ID);
  if (overlay) overlay.style.display = 'none';
}

/** Surfaces a message without treating it as a crash. */
function warn(message, detail) {
  showError(message, detail, 'warn');
}

function installErrorTrap() {
  window.addEventListener('error', (event) => {
    showError(event.message || 'Script error', event.error ? event.error.stack : (event.filename || ''));
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    showError(
      'Unhandled promise rejection',
      reason && reason.stack ? reason.stack : String(reason),
    );
  });

  // A module that fails to parse fires an error on window with no message;
  // this catches the common CDN/module 404 case so it is visible on the page.
  window.addEventListener('unhandledrejection', () => {}, true);
}

// ---------------------------------------------------------------- Reload

let reloadCount = 0;

function doReload(reason) {
  reloadCount += 1;
  if (typeof CONFIG.onBeforeReload === 'function') {
    try { CONFIG.onBeforeReload(reason); } catch { /* never block a reload */ }
  }
  // Preserve scroll and simulation state across the reload. Losing the camera
  // position you had tuned to reproduce a bug is the worst part of reloading.
  saveState();
  // Cache-bust so the browser cannot serve a stale document from memory cache.
  const url = new URL(location.href);
  url.searchParams.set('_r', String(Date.now()));
  location.replace(url.toString());
}

// ---------------------------------------------------------------- State

const STATE_KEY = '__simhost_state';

/**
 * Stores scroll position plus whatever the simulation registered via
 * simHost.state(). Restored on the next load.
 */
function saveState() {
  try {
    const payload = {
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      saved: Date.now(),
    };
    if (typeof CONFIG.state === 'object' && CONFIG.state !== null) {
      payload.user = CONFIG.state;
    }
    // Form controls are restored automatically by the browser for same-url
    // navigations, but not across location.replace with a new query string.
    const controls = {};
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!el.name && !el.id) continue;
      controls[el.name || el.id] = el.type === 'checkbox' || el.type === 'radio'
        ? el.checked
        : el.value;
    }
    if (Object.keys(controls).length) payload.controls = controls;
    sessionStorage.setItem(STATE_KEY, JSON.stringify(payload));
  } catch {
    // sessionStorage can be unavailable (private mode, file://). Not fatal.
  }
}

function restoreState() {
  let payload = null;
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    if (raw) payload = JSON.parse(raw);
    sessionStorage.removeItem(STATE_KEY);
  } catch {
    return;
  }
  if (!payload) return;

  // Ignore a restore that would fight the user: only apply if the save is recent.
  if (payload.saved && Date.now() - payload.saved > 10 * 60 * 1000) return;

  if (payload.user && typeof CONFIG.state === 'object') {
    try { Object.assign(CONFIG.state, payload.user); } catch { /* frozen */ }
  }

  try {
    if (payload.controls) {
      for (const [key, value] of Object.entries(payload.controls)) {
        const el = document.querySelector(`[name="${CSS.escape(key)}"], #${CSS.escape(key)}`);
        if (!el) continue;
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!value;
        else el.value = value;
      }
    }
    if (typeof payload.scrollY === 'number') {
      window.scrollTo(payload.scrollX || 0, payload.scrollY);
    }
  } catch {
    // A missing element or a locked scroll is not worth surfacing.
  }
}

// ---------------------------------------------------------------- CSS swap

/**
 * Reloads a stylesheet in place instead of navigating.
 *
 * A full reload for a one-line colour change resets every animation and throws
 * away accumulated state, which is the main reason people avoid editing CSS.
 */
function swapCss(href) {
  const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"]'));
  const target = links.find((l) => new URL(l.href, location.href).pathname === href)
    ?? links[links.length - 1];
  if (!target) return false;

  const clone = target.cloneNode();
  clone.href = href.split('?')[0] + '?_css=' + Date.now();
  clone.addEventListener('load', () => target.remove());
  clone.addEventListener('error', () => target.remove());
  target.parentNode.insertBefore(clone, target.nextSibling);
  return true;
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

    source.addEventListener('css', (event) => {
      let href = null;
      try { href = JSON.parse(event.data).href; } catch { /* ignore */ }
      if (href) swapCss(href);
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

    /**
     * Simulation-owned state, preserved across reloads. Assign to it freely:
     *   simHost.state.camera = { x: 3, y: 1.5 };
     * Read it back after the page reloads to pick up where you left off.
     */
    state: (typeof CONFIG.state === 'object' && CONFIG.state !== null) ? CONFIG.state : (CONFIG.state = {}),

    /** Surfaces a non-fatal message on the error overlay. */
    warn(message, detail) {
      warn(message, detail);
    },

    /** Dismisses the error overlay. */
    clearErrors,

    /** True when anything has been logged to the overlay this session. */
    get errorCount() { return errorCount; },
    get reloadCount() { return reloadCount; },
  };
  window.simHost = api;
}

function start() {
  const boot = () => {
    buildHud();
    installApi();
    installShortcuts();
    installErrorTrap();
    connect();
    restoreState();
    // Only label the HUD if it is not already reporting a live connection.
    // connect() can win the race on a fast local link, and overwriting 'live'
    // with 'static' made a working reload look disabled.
    if (CONFIG.name && !hud?.classList.contains('live')) setHudState('static', CONFIG.name);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

start();