#!/usr/bin/env node
// index-page.mjs
// Renders the generated index page. Regenerated on demand whenever the
// simulation directory changes; also served fresh for every request.

import { escapeHtml, jsonForScript } from './html.mjs';

function renderTags(tags) {
  if (!tags?.length) return '';
  return tags
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join('');
}

function renderCard(sim) {
  const meta = [
    `<span class="meta-size">${(sim.size / 1024).toFixed(1)} kB</span>`,
    `<span class="meta-updated" title="${escapeHtml(new Date(sim.mtime).toISOString())}">${escapeHtml(sim.updated)}</span>`,
  ].join('<span class="meta-dot">·</span>');

  return `
    <a class="card" href="${escapeHtml(sim.url)}" data-sim-id="${escapeHtml(sim.id)}">
      <h3 class="card-title">${escapeHtml(sim.title)}</h3>
      ${sim.description ? `<p class="card-desc">${escapeHtml(sim.description)}</p>` : ''}
      ${renderTags(sim.tags)}
      <div class="card-meta">${meta}</div>
    </a>`;
}

/**
 * Builds the full index HTML.
 * @param {object[]} sims descriptors from scanSimulations
 * @param {object} info extra page info: { port, liveReload }
 */
export function renderIndex(sims, info = {}) {
  const cards = sims.map(renderCard).join('');
  const empty = `
    <div class="empty">
      <h2>No simulations found</h2>
      <p>Drop an <code>.html</code> file into <code>simulations/</code> and this page updates automatically.</p>
      <pre>simulations/
  my-sim.html        &larr; that's it</pre>
    </div>`;

  const liveTag = info.liveReload
    ? `<span class="pill pill-live" title="SSE live reload is active">live reload on</span>`
    : `<span class="pill pill-off" title="Live reload is disabled">live reload off</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crucible</title>
<link rel="stylesheet" href="/__simhost/runtime.css" data-sim-host-runtime>
<script>window.__SIM_HOST__ = ${jsonForScript({ index: true, liveReload: Boolean(info.liveReload) })};</script>
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --panel-2: #1e222b;
    --border: #262b36;
    --text: #e6e9ef;
    --muted: #8b93a7;
    --accent: #4fc3f7;
    --accent-2: #7c9cff;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 72px; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 6px; }
  h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; }
  .sub { color: var(--muted); font-size: 14px; }
  .pill {
    font-size: 12px; padding: 3px 10px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
  }
  .pill-live { color: #7ee787; border-color: #234d2c; background: #10231a; }
  .pill-off { color: var(--muted); }
  .toolbar { display: flex; gap: 10px; align-items: center; margin: 22px 0 18px; flex-wrap: wrap; }
  input[type=search] {
    flex: 1 1 240px; min-width: 200px; padding: 9px 12px; border-radius: 9px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text); font: inherit;
  }
  input[type=search]:focus { outline: 2px solid var(--accent-2); outline-offset: 1px; }
  .count { color: var(--muted); font-size: 13px; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
  .card {
    display: block; text-decoration: none; color: inherit;
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px; transition: border-color .15s, transform .15s, background .15s;
  }
  .card:hover { border-color: var(--accent); transform: translateY(-2px); background: var(--panel-2); }
  .card-title { margin: 0 0 6px; font-size: 16px; letter-spacing: -0.01em; }
  .card-desc { margin: 0 0 10px; color: var(--muted); font-size: 13.5px; }
  .card-meta { margin-top: 12px; color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
  .meta-dot { opacity: .5; }
  .tag {
    display: inline-block; font-size: 11.5px; padding: 2px 8px; margin: 0 6px 6px 0;
    border-radius: 6px; background: rgba(79,195,247,.12); color: var(--accent);
  }
  .empty { border: 1px dashed var(--border); border-radius: var(--radius); padding: 28px; color: var(--muted); }
  .empty code, .empty pre { background: var(--panel-2); color: var(--text); border-radius: 6px; }
  .empty pre { padding: 12px 14px; overflow-x: auto; }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>crucible</h1>
      <span class="sub">${sims.length} simulation${sims.length === 1 ? '' : 's'}</span>
      ${liveTag}
    </header>
    <div class="toolbar">
      <input type="search" id="filter" placeholder="Filter simulations&hellip;" autocomplete="off" spellcheck="false">
      <span class="count" id="count"></span>
    </div>
    <div class="grid" id="grid">${sims.length ? cards : empty}</div>
  </div>
<script type="module" src="/__simhost/runtime.js" data-sim-host-runtime></script>
<script>
  const filter = document.getElementById('filter');
  const count = document.getElementById('count');
  if (filter && count) {
    const cards = () => Array.from(document.querySelectorAll('.card'));
    const apply = () => {
      const q = filter.value.trim().toLowerCase();
      let shown = 0;
      for (const card of cards()) {
        const hit = !q || card.textContent.toLowerCase().includes(q);
        card.classList.toggle('hidden', !hit);
        if (hit) shown += 1;
      }
      count.textContent = q ? shown + ' / ' + cards().length : '';
    };
    filter.addEventListener('input', apply);
  }
</script>
</body>
</html>`;
}