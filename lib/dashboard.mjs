#!/usr/bin/env node
// dashboard.mjs
// Renders the control dashboard: browse storage paths, see discovered projects,
// start or stop a host per directory, and jump straight to the port.

import { escapeHtml, jsonForScript } from './html.mjs';
import { EDITOR_STYLES, EDITOR_SCRIPT, renderEditorPanel } from './editor-ui.mjs';

const STYLES = `
:root {
  --bg: #08090b;
  --surface: #101216;
  --surface-2: #16191f;
  --surface-3: #1d212a;
  --border: #262b36;
  --border-soft: #1e222b;
  --text: #e8eaf0;
  --muted: #8b93a7;
  --faint: #5f6779;
  --accent: #4fc3f7;
  --accent-2: #7c9cff;
  --ok: #4ade80;
  --warn: #fbbf24;
  --err: #f87171;
  --radius: 12px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
button { font: inherit; cursor: pointer; }
code, kbd { font-family: var(--mono); }

/* ambient */
.liquid-bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.liquid-bg span {
  position: absolute; border-radius: 50%; filter: blur(90px); opacity: .13;
}
.liquid-bg span:nth-child(1) { width: 46vw; height: 46vw; background: #4fc3f7; top: -12vw; left: -8vw; }
.liquid-bg span:nth-child(2) { width: 38vw; height: 38vw; background: #7c9cff; top: 40vh; right: -10vw; }
.liquid-bg span:nth-child(3) { width: 32vw; height: 32vw; background: #f78fb3; bottom: -12vw; left: 28vw; }

/* shell */
.shell { position: relative; z-index: 1; display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
.topbar {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 14px 22px; border-bottom: 1px solid var(--border-soft);
  background: rgba(8,9,11,.72); backdrop-filter: blur(12px);
  position: sticky; top: 0; z-index: 20;
}
.brand { display: flex; align-items: center; gap: 9px; font-weight: 650; letter-spacing: -.02em; font-size: 15px; }
.brand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px var(--accent); }
.brand small { color: var(--faint); font-weight: 400; letter-spacing: 0; font-size: 12px; }
.spacer { flex: 1 1 auto; }
.badge {
  font: 11px/1 var(--mono); padding: 5px 9px; border-radius: 6px;
  border: 1px solid var(--border); color: var(--muted); background: var(--surface-2);
  white-space: nowrap;
}
.badge.live { color: var(--ok); border-color: #1d3f2a; background: #0d1a12; }
.badge.off { color: var(--faint); }

/* layout */
.layout { display: grid; grid-template-columns: minmax(240px, 300px) 1fr; min-height: 0; }
.sidebar {
  border-right: 1px solid var(--border-soft); overflow-y: auto; padding: 16px 12px 40px;
  background: rgba(16,18,22,.5);
}
/* The right-hand column scrolls as one unit so the editor stays put while the
   project list above it re-renders. */
.content { overflow-y: auto; min-width: 0; padding: 22px 26px 40px; }
.main { min-width: 0; }

.panel-title {
  font: 600 11px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase;
  color: var(--faint); margin: 6px 8px 10px;
}
.tree { list-style: none; margin: 0; padding: 0; }
.tree ul { list-style: none; margin: 0; padding-left: 12px; border-left: 1px solid var(--border-soft); }
.tree li { margin: 1px 0; }
.node {
  display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
  padding: 6px 8px; border-radius: 7px; border: 1px solid transparent;
  background: none; color: var(--muted); font-size: 13px;
}
.node:hover { background: var(--surface-2); color: var(--text); }
.node.is-selected { background: var(--surface-3); color: var(--text); border-color: var(--border); }
.node.is-open > .node-label { color: var(--accent); }
.node-caret { width: 12px; color: var(--faint); flex: none; transition: transform .15s; }
.node.is-open > .node .node-caret { transform: rotate(90deg); }
.node-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-count { font: 10px/1 var(--mono); color: var(--faint); }
.node.is-live .node-label { color: var(--ok); }
.node.is-live .node-caret { color: var(--ok); }
.node-children[hidden] { display: none; }

/* main */
.hero { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 4px; }
.hero h1 { margin: 0; font-size: 22px; letter-spacing: -.02em; font-family: var(--mono); font-weight: 600; word-break: break-all; }
.hero .sub { color: var(--muted); font-size: 13px; }
.crumbs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--faint); font: 12px/1 var(--mono); margin-bottom: 16px; }
.crumbs button { background: none; border: none; color: var(--muted); padding: 2px 4px; border-radius: 5px; }
.crumbs button:hover { color: var(--accent); background: var(--surface-2); }

.actions { display: flex; gap: 9px; flex-wrap: wrap; margin-bottom: 20px; }
.btn {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface-2); color: var(--text); text-decoration: none; font-size: 13px;
  transition: border-color .14s, background .14s, transform .1s;
}
.btn:hover { border-color: var(--accent); background: var(--surface-3); }
.btn:active { transform: translateY(1px); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #06202b; font-weight: 600; }
.btn-primary:hover { background: #6fd2fa; border-color: #6fd2fa; }
.btn-danger { color: var(--err); border-color: #43242a; }
.btn-danger:hover { border-color: var(--err); background: #1c1216; }
.btn[disabled] { opacity: .45; pointer-events: none; }
.btn .k { font: 10px/1 var(--mono); opacity: .6; }

.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.card {
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  padding: 14px 15px; display: flex; flex-direction: column; gap: 9px;
}
.card:hover { border-color: var(--border); }
.card-head { display: flex; align-items: baseline; gap: 8px; }
.card h3 { margin: 0; font-size: 14.5px; letter-spacing: -.01em; }
.card .port { font: 11px/1 var(--mono); color: var(--accent); margin-left: auto; }
.card .path { font: 11.5px/1.4 var(--mono); color: var(--faint); word-break: break-all; }
.card .meta { display: flex; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
.card .meta .sep { color: var(--faint); }
.card .file-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.card .file-row .name { font-family: var(--mono); font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .file-row a.name:hover { color: var(--accent); text-decoration: none; }
.state { font: 10px/1 var(--mono); padding: 3px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.state.running { color: var(--ok); border-color: #1d3f2a; background: #0d1a12; }
.state.stopped { color: var(--faint); }
.empty { border: 1px dashed var(--border); border-radius: var(--radius); padding: 34px; text-align: center; color: var(--muted); }
.empty code { color: var(--text); background: var(--surface-2); padding: 2px 6px; border-radius: 5px; }

.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
input[type=search] {
  flex: 1 1 220px; min-width: 180px; padding: 9px 12px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit;
}
input[type=search]:focus { outline: 2px solid var(--accent-2); outline-offset: 1px; }
.count { color: var(--faint); font: 12px/1 var(--mono); }

.toast {
  position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%) translateY(14px);
  padding: 10px 16px; border-radius: 10px; background: var(--surface-3); color: var(--text);
  border: 1px solid var(--border); box-shadow: 0 10px 30px rgba(0,0,0,.5);
  opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s; z-index: 60;
  font-size: 13px; max-width: 90vw;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.err { border-color: #43242a; color: #fecaca; }
.toast.ok { border-color: #1d3f2a; color: #bbf7d0; }

.kbd-hint { color: var(--faint); font-size: 12px; margin-top: 18px; }
kbd {
  font-size: 11px; padding: 2px 6px; border-radius: 5px;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--muted);
}

@media (max-width: 820px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { border-right: none; border-bottom: 1px solid var(--border-soft); max-height: 42vh; }
  .content { padding: 16px 14px 40px; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;

const SCRIPT = String.raw`
(function () {
  'use strict';

  // The server supplies tree/projects/instances but not a selection. The tree
  // root is a virtual '/' node whose children are the real roots, so start on
  // the first real root rather than the empty virtual node.
  var state = window.__SIM_HOST_DASH__ || {};
  state.tree = state.tree || { children: [] };
  state.projects = state.projects || [];
  state.instances = state.instances || {};
  if (state.selected == null) {
    var firstRoot = state.tree.children && state.tree.children[0];
    state.selected = firstRoot ? firstRoot.path : '/';
  }
  var treeEl = document.getElementById('tree');
  var mainEl = document.getElementById('main');
  var filterEl = document.getElementById('filter');
  var countEl = document.getElementById('count');
  var editorPanel = document.getElementById('edRoot');
  var toastEl = null;
  var toastTimer = null;

  function toast(msg, kind) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    // Errors interrupt; everything else waits its turn. Without this a failure
    // was visible but silent to a screen reader.
    toastEl.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    toastEl.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
    toastEl.textContent = msg;
    toastEl.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast ' + (kind || ''); }, 2600);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function livePort(dir) {
    var inst = state.instances[dir];
    return inst && inst.alive ? inst.port : null;
  }

  // ------------------------------------------------------------ tree

  function renderTree() {
    if (!treeEl) return;
    function nodeHtml(node, depth) {
      var hasKids = node.children && node.children.length;
      var isProject = !!node.project;
      var port = livePort(node.path);

      // File rows are rendered by the main panel for the selected folder.
      // Repeating them here would show every sibling's files inline and
      // duplicate the entries, so the tree stays a pure navigation list.
      var childHtml = '';
      if (hasKids) {
        childHtml = '<ul class="node-children" hidden>' + node.children.map(function (c) {
          return nodeHtml(c, depth + 1);
        }).join('') + '</ul>';
      }

      var selected = node.path === state.selected ? ' is-selected' : '';
      // Auto-expand the first two levels plus whatever leads to the selection.
      var onSelectionPath = !!state.selected && node.path !== '/'
        && state.selected.indexOf(node.path + '/') === 0;
      var open = (depth < 2 || onSelectionPath) ? ' is-open' : '';
      var liveCls = port ? ' is-live' : '';
      var caret = hasKids ? '<span class="node-caret">›</span>' : '<span class="node-caret"></span>';

      var attrs = ' class="node' + selected + open + liveCls + '" data-path="' + esc(node.path) + '" data-depth="' + depth + '"';
      attrs += ' role="treeitem"';
      attrs += ' aria-selected="' + (node.path === state.selected ? 'true' : 'false') + '"';
      if (hasKids) attrs += ' data-has-kids="1" aria-expanded="' + (!open ? 'false' : 'true') + '"';
      if (isProject) attrs += ' data-project="1"';

      return '<li><button type="button"' + attrs + '>' + caret
        + '<span class="node-label">' + esc(node.name) + '</span>'
        + (isProject && node.project.fileCount ? '<span class="node-count">' + node.project.fileCount + '</span>' : '')
        + (port ? '<span class="node-count">:' + port + '</span>' : '')
        + '</button>' + childHtml + '</li>';
    }

    treeEl.innerHTML = '<ul>' + state.tree.children.map(function (c) { return nodeHtml(c, 0); }).join('') + '</ul>';

    // Reveal every branch marked is-open. Delegated listeners below mean this
    // can safely re-render on every state change without piling up handlers.
    Array.prototype.forEach.call(treeEl.querySelectorAll('.node.is-open'), function (btn) {
      var ul = btn.parentNode.querySelector('.node-children');
      if (ul) ul.hidden = false;
    });
  }

  // ------------------------------------------------------------ main

  function findProject(prefix) {
    var best = null;
    for (var i = 0; i < state.projects.length; i += 1) {
      var p = state.projects[i];
      // Exact match only. A folder that merely contains projects (a container)
      // is not itself a project; matching descendants here made /root resolve
      // to the deepest nested project instead of listing its own children.
      if (p.dir === prefix) { best = p; break; }
    }
    return best;
  }

  function childProjects(prefix) {
    return state.projects.filter(function (p) {
      // For the virtual '/' node there is nothing to descend into; the real
      // roots are its tree children, which renderTree already shows.
      if (prefix === '/') return false;
      var rest = p.dir.indexOf(prefix + '/') === 0 ? p.dir.slice(prefix.length + 1) : '';
      return rest && rest.indexOf('/') === -1;
    }).sort(function (a, b) { return a.label.localeCompare(b.label); });
  }

  function crumbsHtml(prefix) {
    var parts = (prefix === '/' ? [] : prefix.split('/').filter(Boolean));
    // The virtual '/' node has no projects of its own; jump to the first real
    // root so clicking "~" always lands somewhere useful.
    var crumbRoot = '/';
    if (prefix === '/' && state.tree.children && state.tree.children[0]) {
      crumbRoot = state.tree.children[0].path;
    }
    var out = ['<button type="button" data-crumb="' + esc(crumbRoot) + '">~</button>'];
    var acc = '';
    parts.forEach(function (p) {
      acc += '/' + p;
      out.push('<span>/</span><button type="button" data-crumb="' + esc(acc) + '">' + esc(p) + '</button>');
    });
    return out.join('');
  }

  function cardHtml(project) {
    var port = livePort(project.dir);
    var running = !!port;
    var inst = state.instances[project.dir];
    var entry = project.entryUrl
      ? (running ? 'http://localhost:' + port + '/' + encodeURIComponent(project.entryUrl) : null)
      : null;

    var files = (project.files || []).slice(0, 6).map(function (f) {
      var href = running ? 'http://localhost:' + port + '/' + encodeURIComponent(f.name) : null;
      return '<div class="file-row"><span class="name">'
        + (href ? '<a class="name" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(f.name) + '</a>' : esc(f.name))
        + '</span></div>';
    }).join('');

    return '<div class="card">'
      + '<div class="card-head">'
        + '<h3>' + esc(project.label) + '</h3>'
        + '<span class="port">:' + (running ? port : project.preferredPort) + '</span>'
      + '</div>'
      + '<div class="path">' + esc(project.dir) + '</div>'
      + '<div class="meta">'
        + '<span class="state ' + (running ? 'running' : 'stopped') + '">' + (running ? 'running' : 'stopped') + '</span>'
        + '<span>' + project.fileCount + ' file' + (project.fileCount === 1 ? '' : 's') + '</span>'
        + '<span class="sep">·</span><span>' + esc(project.updated) + '</span>'
        + (inst && running && inst.derived !== inst.port ? '<span class="sep">·</span><span>port ' + inst.derived + ' taken</span>' : '')
      + '</div>'
      + (files ? '<div style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' + files + '</div>' : '')
      + '<div class="actions" style="margin:4px 0 0">'
        + (running
          ? '<a class="btn btn-primary" href="http://localhost:' + port + '/">Open<span class="k">↵</span></a>'
            + '<button class="btn btn-danger" data-stop="' + esc(project.dir) + '">Stop</button>'
          : '<button class="btn btn-primary" data-host="' + esc(project.dir) + '">Host<span class="k">h</span></button>')
      + '</div>'
      + '</div>';
  }

  function renderMain() {
    if (!mainEl) return;
    var prefix = state.selected || '/';
    var project = findProject(prefix);
    var q = (filterEl && filterEl.value || '').trim().toLowerCase();

    var head = '<div class="crumbs">' + crumbsHtml(prefix) + '</div>';
    var hero = project
      ? '<div class="hero"><h1>' + esc(project.label) + '</h1><span class="sub">' + project.fileCount + ' html file' + (project.fileCount === 1 ? '' : 's') + '</span></div>'
      : '<div class="hero"><h1>' + esc(prefix === '/' ? 'storage' : prefix.split('/').pop()) + '</h1><span class="sub">choose a folder to host</span></div>';

    var cards = '';
    if (q) {
      var matches = state.projects.filter(function (p) {
        var names = (p.files || []).map(function (f) { return f.name; }).join(' ');
        return (p.label + ' ' + p.dir + ' ' + names).toLowerCase().indexOf(q) !== -1;
      });
      cards = matches.length
        ? '<div class="grid">' + matches.map(cardHtml).join('') + '</div>'
        : '<div class="empty">no matches</div>';
    } else if (project) {
      cards = '<div class="grid">' + cardHtml(project) + '</div>';
    } else {
      var kids = childProjects(prefix);
      cards = kids.length
        ? '<div class="grid">' + kids.map(cardHtml).join('') + '</div>'
        : '<div class="empty">nothing here yet<br><br>add an <code>.html</code> file to a folder and rescan</div>';
    }

    mainEl.innerHTML = head + hero + cards
      + '<p class="kbd-hint"><kbd>h</kbd> host selected &nbsp; <kbd>Enter</kbd> open &nbsp; <kbd>r</kbd> rescan &nbsp; <kbd>n</kbd> new file</p>';

    // renderMain() replaces mainEl.innerHTML on every state change, so the
    // editor must never live inside #main or it would be destroyed along with
    // the open file and unsaved buffer. It stays a sibling and is only shown or
    // hidden here.
    if (editorPanel) editorPanel.hidden = !project;

    if (window.simHostEditor && window.simHostEditor.sync) {
      window.simHostEditor.sync(project || null, livePort(prefix));

      // The editor refuses to leave a project with unsaved work. When that
      // happens the tree still shows the folder the user just clicked, so
      // re-select whatever the editor is actually holding.
      var held = window.simHostEditor.currentDir && window.simHostEditor.currentDir();
      if (held && held !== prefix) {
        state.selected = held;
        Array.prototype.forEach.call(document.querySelectorAll('#tree .node'), function (n) {
          n.classList.toggle('is-selected', n.getAttribute('data-path') === held);
        });
      }
    } else {
      window.simHostPendingSync = { project: project || null, port: livePort(prefix) };
    }

    if (countEl) countEl.textContent = state.projects.length + ' project' + (state.projects.length === 1 ? '' : 's');
  }

  function el(id) { return document.getElementById(id); }

  // ------------------------------------------------------------ actions

  function api(path, body) {
    return fetch('/__simhost/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data && data.error ? data.error : 'request failed');
        return data;
      });
    });
  }

  function refresh() {
    return api('state').then(function (data) {
      state.tree = data.tree;
      state.projects = data.projects;
      state.instances = data.instances;
      // Keep the global in step with the live state. The editor reads the
      // instance map from here to resolve preview URLs, and a stale copy
      // silently disabled previews after a host was started or stopped.
      window.__SIM_HOST_DASH__ = state;
      renderTree();
      renderMain();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function host(dir) {
    toast('starting host for ' + dir, '');
    api('host', { dir: dir }).then(function (data) {
      if (data.derived !== data.port) toast('started on :' + data.port + ' (:' + data.derived + ' was taken)', '');
      else toast('hosted on :' + data.port, 'ok');
      return refresh();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function stop(dir) {
    api('stop', { dir: dir }).then(function () {
      toast('stopped', 'ok');
      return refresh();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  document.addEventListener('click', function (event) {
    var treeBtn = event.target.closest('#tree .node');
    if (treeBtn) {
      var path = treeBtn.getAttribute('data-path');
      var ul = treeBtn.parentNode.querySelector('.node-children');
      if (ul && treeBtn.hasAttribute('data-has-kids')) {
        ul.hidden = !ul.hidden;
        treeBtn.classList.toggle('is-open', !ul.hidden);
      }
      // Selecting the virtual '/' root is not useful; descend to the first
      // real root instead.
      if (path === '/' && state.tree.children && state.tree.children[0]) {
        path = state.tree.children[0].path;
      }
      state.selected = path;
      renderTree();
      renderMain();
      return;
    }

    var hostBtn = event.target.closest('[data-host]');
    if (hostBtn) return host(hostBtn.getAttribute('data-host'));
    var stopBtn = event.target.closest('[data-stop]');
    if (stopBtn) return stop(stopBtn.getAttribute('data-stop'));
    var crumb = event.target.closest('[data-crumb]');
    if (crumb) {
      state.selected = crumb.getAttribute('data-crumb');
      renderTree();
      renderMain();
    }
  });

  document.addEventListener('keydown', function (event) {
    // Never steal keys from a text field. This previously guarded INPUT only,
    // so typing in the editor's textarea fired the global shortcuts: n
    // swallowed the character and opened the new-file dialog, r rescanned
    // storage, and h started a web server for the project.
    var target = event.target;
    if (target) {
      var tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'r') {
      event.preventDefault();
      toast('rescanning...');
      api('rescan').then(refresh).catch(function (e) { toast(e.message, 'err'); });
      return;
    }
    if (event.key === 'n') {
      // New file, but only when a project with HTML is actually selected.
      var target = findProject(state.selected);
      if (target && window.simHostEditor) {
        event.preventDefault();
        window.simHostEditor.openModal();
      }
      return;
    }
    if (event.key === 'h') {
      event.preventDefault();
      var project = findProject(state.selected);
      if (project) {
        var port = livePort(project.dir);
        if (port) window.open('http://localhost:' + port + '/', '_blank', 'noopener');
        else host(project.dir);
      } else if (childProjects(state.selected).length === 1) {
        host(childProjects(state.selected)[0].dir);
      }
      return;
    }
    if (event.key === 'Enter') {
      var p = findProject(state.selected);
      var port2 = p && livePort(p.dir);
      if (port2) window.open('http://localhost:' + port2 + '/', '_blank', 'noopener');
    }
  });

  if (filterEl) filterEl.addEventListener('input', renderMain);

  // live refresh when hosts change elsewhere
  if (typeof EventSource !== 'undefined') {
    var es = new EventSource('/__simhost/live');
    es.addEventListener('instances', refresh);
  }

  // Share the dashboard's toast so the editor reports through one channel.
  window.simHostToast = toast;

  // Create the editor once. renderMain() then relocates the markup on each
  // render, which preserves the open file and unsaved buffer.
  window.simHostEditor = window.simHostInitEditor
    ? window.simHostInitEditor(document.getElementById('edRoot'))
    : null;

  renderTree();
  renderMain();

  if (window.simHostPendingSync && window.simHostEditor && window.simHostEditor.sync) {
    var pending = window.simHostPendingSync;
    window.simHostPendingSync = null;
    window.simHostEditor.sync(pending.project, pending.port);
  }
})();
`;

/**
 * Builds the dashboard HTML.
 * @param {object} data { tree, projects, instances, liveReload, port }
 */
export function renderDashboard(data) {
  const payload = {
    tree: data.tree ?? { children: [] },
    projects: data.projects ?? [],
    instances: data.instances ?? {},
  };

  const liveBadge = data.liveReload
    ? '<span class="badge live" data-live>live reload on</span>'
    : '<span class="badge off">live reload off</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crucible &middot; control</title>
<meta name="description" content="Browse local storage and host any folder with live reload.">
<meta name="color-scheme" content="dark">
<link rel="stylesheet" href="/__simhost/runtime.css" data-sim-host-runtime>
<script>window.__SIM_HOST__ = ${jsonForScript({ dashboard: true, liveReload: Boolean(data.liveReload) })};</script>
<script>window.__SIM_HOST_DASH__ = ${jsonForScript(payload)};</script>
<style>${STYLES}</style>
<style>${EDITOR_STYLES}</style>
</head>
<body>
<div class="liquid-bg" aria-hidden="true"><span></span><span></span><span></span></div>
<div class="shell">
  <header class="topbar">
    <div class="brand"><span class="dot"></span>crucible <small>control</small></div>
    <span class="badge">:${data.port ?? ''}</span>
    ${liveBadge}
    <div class="spacer"></div>
    <button class="btn" id="rescan" type="button">Rescan</button>
  </header>
  <div class="layout">
    <nav class="sidebar" aria-label="Storage">
      <div class="panel-title">Storage</div>
      <div class="tree" id="tree" role="tree" aria-label="Storage projects"></div>
    </nav>
    <div class="content" id="content">
      <main class="main" id="main"></main>
      ${renderEditorPanel()}
    </div>
  </div>
</div>
<script type="module" src="/__simhost/runtime.js" data-sim-host-runtime></script>
<script>${EDITOR_SCRIPT}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}
