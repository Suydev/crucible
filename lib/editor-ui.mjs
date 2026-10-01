#!/usr/bin/env node
// editor-ui.mjs
// The dashboard's editor: a split pane with a file list, a code editor, and a
// live preview.
//
// Kept separate from dashboard.mjs because it is a self-contained concern with
// its own sizeable stylesheet and script. renderEditorPanel() returns the HTML
// and initEditor() the behaviour; the dashboard mounts both.

import { escapeHtml, jsonForScript } from './html.mjs';

export const EDITOR_STYLES = `
/* ---- editor shell ---- */
.ed {
  display: none;
  border: 1px solid var(--border);  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
  margin-bottom: 22px;
}
.ed.is-open { display: block; }
/* The dashboard toggles visibility with the hidden attribute. Without this the
   .ed display rule above wins and the panel never hides. */
.ed[hidden] { display: none !important; }

.ed-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--border-soft);
  background: var(--surface-2); flex-wrap: wrap;
}
.ed-file {
  display: flex; align-items: center; gap: 6px;
  font: 12px/1 var(--mono); padding: 5px 9px; border-radius: 6px;
  background: var(--surface-3); color: var(--text);
}
.ed-file .dirty { width: 6px; height: 6px; border-radius: 50%; background: var(--warn); display: none; }
.ed-file.is-dirty .dirty { display: block; }
.ed-title { color: var(--muted); font-size: 12px; }
.ed-spacer { flex: 1 1 auto; }

.ed-grid { display: grid; grid-template-columns: 1fr; min-height: 420px; }
.ed-grid.is-split { grid-template-columns: 1fr 1fr; }
.ed-grid.is-preview { grid-template-columns: 1fr; }

.ed-side {
  border-right: 1px solid var(--border-soft);
  display: flex; flex-direction: column; min-width: 0;
}
.ed-side:last-child { border-right: none; }

.ed-head {
  padding: 6px 10px; font: 600 10px/1 var(--sans); letter-spacing: .1em;
  text-transform: uppercase; color: var(--faint);
  border-bottom: 1px solid var(--border-soft); background: var(--surface);
  display: flex; align-items: center; gap: 6px;
}

.ed-files {
  list-style: none; margin: 0; padding: 4px; overflow-y: auto; max-height: 340px;
}
.ed-files button {
  display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
  padding: 5px 8px; border-radius: 6px; border: 1px solid transparent;
  background: none; color: var(--muted); font: 12px/1.4 var(--mono);
}
.ed-files button:hover { background: var(--surface-3); color: var(--text); }
.ed-files button.is-active { background: var(--surface-3); color: var(--accent); border-color: var(--border); }
.ed-files .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ed-files .sz { color: var(--faint); font-size: 10px; flex: none; }
.ed-files .tagx { color: var(--warn); opacity: 0; flex: none; }
.ed-files button.is-dirty .tagx { opacity: 1; }

.ed-editor {
  flex: 1 1 auto; width: 100%; min-height: 380px; resize: vertical;
  border: none; outline: none; padding: 12px 14px;
  background: #0b0d11; color: #d7dce6;
  font: 13px/1.6 var(--mono); tab-size: 2;
}
.ed-editor:focus { box-shadow: inset 0 0 0 1px var(--accent); }

.ed-status {
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  padding: 6px 10px; border-top: 1px solid var(--border-soft);
  background: var(--surface-2); color: var(--faint); font: 11px/1 var(--mono);
}
.ed-status .is-unsaved { color: var(--warn); }
.ed-status span:empty { display: none; }

.ed-preview { display: none; background: #0f1115; }
.ed-grid.is-preview .ed-preview { display: block; }
.ed-grid.is-split .ed-preview { display: block; border-left: 1px solid var(--border-soft); }
.ed-preview iframe { width: 100%; height: 100%; min-height: 380px; border: none; background: #0f1115; }
.ed-preview .ed-empty { padding: 30px; color: var(--faint); text-align: center; font-size: 12px; }

/* new-file dialog */
.ed-modal {
  position: fixed; inset: 0; z-index: 80; display: none;
  align-items: center; justify-content: center; padding: 20px;
  background: rgba(4,5,7,.72); backdrop-filter: blur(3px);
}
.ed-modal.is-open { display: flex; }
.ed-dialog {
  width: min(440px, 100%); background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 20px 60px rgba(0,0,0,.6); overflow: hidden;
}
.ed-dialog h3 { margin: 0; padding: 14px 16px; font-size: 14px; border-bottom: 1px solid var(--border-soft); }
.ed-dialog .body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.ed-dialog label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); display: block; margin-bottom: 5px; }
.ed-dialog input[type=text], .ed-dialog select {
  width: 100%; padding: 8px 10px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--surface-2);
  color: var(--text); font: 13px/1.4 var(--mono);
}
.ed-dialog input:focus, .ed-dialog select:focus { outline: 2px solid var(--accent-2); outline-offset: 1px; }
.ed-dialog .tpl-row { display: flex; gap: 8px; flex-wrap: wrap; }
.ed-dialog .tpl {
  flex: 1 1 auto; padding: 8px; border-radius: 7px; text-align: left;
  border: 1px solid var(--border); background: var(--surface-2);
  color: var(--muted); font-size: 12px;
}
.ed-dialog .tpl:hover, .ed-dialog .tpl.is-on { border-color: var(--accent); color: var(--text); }
.ed-dialog .foot {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 16px; border-top: 1px solid var(--border-soft); background: var(--surface-2);
}
.ed-err { color: var(--err); font-size: 12px; min-height: 1em; }

@media (max-width: 900px) {
  .ed-grid.is-split { grid-template-columns: 1fr; }
}
`;

export const EDITOR_SCRIPT = String.raw`
(function () {
  'use strict';

  var api = function (endpoint, body, method) {
    return fetch('/__simhost/api/' + endpoint, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = {};
        try { data = JSON.parse(t); } catch { /* non-json */ }
        if (!r.ok) throw new Error(data.error || ('request failed (' + r.status + ')'));
        return data;
      });
    });
  };

  function el(id) { return document.getElementById(id); }

  function initEditor(root) {
    if (!root) return null;

    var filesEl = el('edFiles');
    var textarea = el('edEditor');
    var statusEl = el('edStatus');
    var fileEl = el('edFile');
    var gridEl = el('edGrid');
    var frameEl = el('edFrame');
    var previewPlaceholder = el('edPreviewEmpty');
    var openBtn = el('edOpen');
    var newBtn = el('edNew');
    var saveBtn = el('edSave');
    var delBtn = el('edDelete');
    var renameBtn = el('edRename');
    var splitBtn = el('edSplit');
    var previewBtn = el('edPreview');
    var modal = el('edModal');
    var modalName = el('edModalName');
    var modalErr = el('edModalErr');
    var modalCreate = el('edModalCreate');
    var modalCancel = el('edModalCancel');
    var modalTpls = [].slice.call(document.querySelectorAll('#edModalTpls .tpl'));

    var editor = {
      dir: null,
      name: null,
      original: '',
      saved: true,
      mode: 'edit',   // edit | split | preview
      timer: null,
      host: null,
      saving: false,
    };

    function notify(message, kind) {
      if (typeof window.simHostToast === 'function') { window.simHostToast(message, kind); return; }
      if (typeof window.simHost !== 'undefined' && window.simHost && typeof window.simHost.toast === 'function') {
        window.simHost.toast(message);
      }
    }

    // ------------------------------------------------------------ files

    function isDirty() { return editor.name && textarea.value !== editor.original; }

    function markDirty() {
      editor.saved = !isDirty();
      if (fileEl) fileEl.classList.toggle('is-dirty', !editor.saved);
      var btn = filesEl && filesEl.querySelector('[data-ed-file="' + cssEscape(editor.name) + '"]');
      if (btn) btn.classList.toggle('is-dirty', !editor.saved);
      updateStatus();
    }

    function cssEscape(value) {
      return String(value || '').replace(/["\\]/g, '\\$&');
    }

    function renderFiles(files) {
      if (!filesEl) return;
      if (!files.length) {
        filesEl.innerHTML = '<li style="padding:10px;color:var(--faint);font-size:12px">no files yet</li>';
        return;
      }
      filesEl.innerHTML = files.map(function (f) {
        var active = f.name === editor.name;
        var kb = f.size > 1024 ? (f.size / 1024).toFixed(1) + 'k' : f.size + 'b';
        return '<li><button type="button" data-ed-file="' + escapeAttr(f.name) + '"'
          + ' class="' + (active ? 'is-active' : '') + (active && !editor.saved ? ' is-dirty' : '') + '">'
          + '<span class="nm">' + escapeHtml(f.name) + '</span>'
          + '<span class="tagx">&#9679;</span>'
          + '<span class="sz">' + kb + '</span>'
          + '</button></li>';
      }).join('');
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function escapeAttr(s) { return escapeHtml(s); }

    async function refreshFiles() {
      if (!editor.dir) return [];
      var data = await api('file/list?dir=' + encodeURIComponent(editor.dir));
      renderFiles(data.files || []);
      return data.files || [];
    }

    // ------------------------------------------------------------ loading

    // Resets the editor pane to its empty state without touching the file list.
    function clearOpen() {
      editor.name = null;
      editor.original = '';
      editor.saved = true;
      textarea.value = '';
      if (fileEl) {
        fileEl.querySelector('.nm').textContent = 'no file open';
        fileEl.classList.remove('is-dirty');
      }
      updateStatus();
    }

    /** True when the editor is currently attached to a different directory. */
    function isBoundTo(dir) { return editor.dir === dir; }

    async function openFile(name) {
      if (name === editor.name && !isDirty()) return;
      if (isDirty() && !window.confirm('Discard unsaved changes in ' + editor.name + '?')) return;

      // Claim the name before awaiting the fetch. A rescan broadcast can
      // arrive mid-flight, and sync() decides whether to keep the buffer based
      // on editor.name; leaving it null until the response lands made the
      // editor drop the file it had just opened.
      var previous = { name: editor.name, original: editor.original, saved: editor.saved };
      editor.name = name;
      editor.saved = true;

      try {
        var file = await api('file/read?dir=' + encodeURIComponent(editor.dir) + '&name=' + encodeURIComponent(name));
        if (editor.name !== name) return; // superseded by a newer selection
        editor.original = file.content;
        textarea.value = file.content;
        textarea.disabled = false;
        if (fileEl) {
          fileEl.querySelector('.nm').textContent = file.name;
          fileEl.classList.remove('is-dirty');
        }
        markDirty();
        await refreshFiles();
        refreshPreview();
      } catch (err) {
        // Roll back so a failed open does not leave a phantom selection.
        editor.name = previous.name;
        editor.original = previous.original;
        editor.saved = previous.saved;
        notify(err.message, 'err');
      }
    }

    async function openProject(dir) {
      editor.dir = dir;
      clearOpen();
      if (textarea) textarea.disabled = true;
      root.classList.add('is-open');
      await refreshFiles();
      updateStatus();
    }

    /**
     * Called when the dashboard selection moves to a different project while a
     * file is open. Previously the buffer was wiped with no prompt: typing
     * reset the autosave debounce every keystroke, so clicking another folder
     * inside the 1.2s window destroyed the edit silently and permanently.
     *
     * Returns false to tell the caller the selection was refused.
     */
    function confirmLeave() {
      if (!isDirty()) return true;
      if (!window.confirm('Unsaved changes in ' + editor.name + '. Save before leaving?')) {
        return false;
      }
      // Flush the pending autosave before the buffer is torn down, so
      // accepting the prompt actually preserves the work.
      clearTimeout(editor.timer);
      save();
      return true;
    }

    function closeProject() {
      editor.dir = null;
      editor.name = null;
      root.classList.remove('is-open');
    }

    // ------------------------------------------------------------ saving

    async function save() {
      if (!editor.dir || !editor.name) { notify('open a file first', 'err'); return; }
      if (editor.saving) return;
      editor.saving = true;
      updateStatus();
      try {
        var res = await api('file/save', { dir: editor.dir, name: editor.name, content: textarea.value });
        editor.original = textarea.value;
        editor.saved = true;
        markDirty();
        await refreshFiles();
        notify('saved ' + res.name, 'ok');
        // Re-render the preview so the user sees the saved result.
        if (editor.mode !== 'edit') refreshPreview();
      } catch (err) {
        notify(err.message, 'err');
      } finally {
        editor.saving = false;
        updateStatus();
      }
    }

    async function createFile(name, template, content) {
      try {
        var res = await api('file/create', { dir: editor.dir, name: name, template: template, content: content });
        notify('created ' + res.name, 'ok');
        await refreshFiles();
        await openFile(res.name);
      } catch (err) {
        notify(err.message, 'err');
      }
    }

    async function deleteCurrent() {
      if (!editor.name) return;
      if (!window.confirm('Delete ' + editor.name + '? This cannot be undone.')) return;
      try {
        await api('file/delete', { dir: editor.dir, name: editor.name });
        editor.name = null;
        textarea.value = '';
        editor.saved = true;
        if (fileEl) { fileEl.querySelector('.nm').textContent = 'no file open'; fileEl.classList.remove('is-dirty'); }
        notify('deleted', 'ok');
        await refreshFiles();
      } catch (err) {
        notify(err.message, 'err');
      }
    }

    async function renameCurrent() {
      if (!editor.name) return;
      var next = window.prompt('New name', editor.name);
      if (!next || next === editor.name) return;
      try {
        var res = await api('file/rename', { dir: editor.dir, from: editor.name, to: next });
        editor.name = res.name;
        if (fileEl) fileEl.querySelector('.nm').textContent = res.name;
        notify('renamed to ' + res.name, 'ok');
        await refreshFiles();
      } catch (err) {
        notify(err.message, 'err');
      }
    }

    // ------------------------------------------------------------ preview

    function hostUrl() {
      if (!editor.dir || !editor.name) return null;
      // Resolve the port from the dashboard state at call time rather than a
      // cached host object. The cached copy went stale whenever a host was
      // started or stopped without a full re-render, which silently disabled
      // the preview.
      var port = editor.host && editor.host.port;
      try {
        var dash = window.__SIM_HOST_DASH__;
        if (dash && dash.instances && dash.instances[editor.dir]) {
          var inst = dash.instances[editor.dir];
          if (inst && inst.alive) port = inst.port;
        }
      } catch (err) {
        // state unavailable; fall back to the cached value
      }
      if (!port) return null;
      return 'http://localhost:' + port + '/' + encodeURIComponent(editor.name);
    }

    function refreshPreview() {
      if (!frameEl || editor.mode === 'edit') return;
      var url = hostUrl();
      if (!url) {
        // Show the placeholder without destroying the iframe; removing it from
        // the DOM here meant it could never be shown again.
        if (previewPlaceholder) previewPlaceholder.hidden = false;
        frameEl.hidden = true;
        return;
      }
      if (previewPlaceholder) previewPlaceholder.hidden = true;
      frameEl.hidden = false;
      var cacheBust = url + '?_p=' + Date.now();
      if (frameEl.getAttribute('src') !== cacheBust) {
        frameEl.setAttribute('src', cacheBust);
      }
    }

    function setMode(mode) {
      editor.mode = mode;
      if (!gridEl) return;
      gridEl.classList.toggle('is-split', mode === 'split');
      gridEl.classList.toggle('is-preview', mode === 'preview');
      if (splitBtn) splitBtn.classList.toggle('btn-primary', mode === 'split');
      if (previewBtn) previewBtn.classList.toggle('btn-primary', mode === 'preview');
      refreshPreview();
    }

    // ------------------------------------------------------------ status

    // Autosave writes to disk about a second after typing stops. Doing that
    // with no visible feedback meant a save could land unnoticed, so the state
    // is surfaced in the status bar and on the Save button.
    function updateStatus() {
      if (!statusEl) return;
      var text = textarea ? textarea.value : '';
      var lines = text ? text.split('\n').length : 0;
      var state = !editor.name
        ? ''
        : (editor.saving ? 'saving...' : (isDirty() ? 'unsaved' : 'saved'));
      statusEl.innerHTML = '<span>' + escapeHtml(editor.dir || 'no folder') + '</span>'
        + '<span>' + lines + (lines === 1 ? ' line' : ' lines') + '</span>'
        + '<span>' + text.length + ' chars</span>'
        + '<span class="' + (state === 'unsaved' ? 'is-unsaved' : '') + '">' + state + '</span>';
      if (saveBtn) {
        saveBtn.disabled = !editor.name || !isDirty();
        saveBtn.textContent = editor.saving ? 'Saving' : 'Save';
        var hint = document.createElement('span');
        hint.className = 'k';
        hint.textContent = 'ctrl+s';
        saveBtn.appendChild(hint);
      }
    }

    // ------------------------------------------------------------ dialog

    var lastFocus = null;

    function openModal() {
      if (!modal) return;
      lastFocus = document.activeElement;
      modal.classList.add('is-open');
      if (modalName) { modalName.value = ''; modalName.focus(); }
      if (modalErr) modalErr.textContent = '';
    }

    function closeModal() {
      if (!modal) return;
      modal.classList.remove('is-open');
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      lastFocus = null;
    }

    // ------------------------------------------------------------ wiring

    if (filesEl) {
      filesEl.addEventListener('click', function (event) {
        var btn = event.target.closest('[data-ed-file]');
        if (btn) openFile(btn.getAttribute('data-ed-file'));
      });
    }

    if (textarea) {
      textarea.addEventListener('input', function () {
        markDirty();
        // Debounced autosave keeps a simulation from losing work, but only when
        // the file already exists; creating still requires an explicit save.
        clearTimeout(editor.timer);
        if (editor.name && editor.saved === false) {
          editor.timer = setTimeout(function () {
            if (isDirty()) save();
          }, 1200);
        }
      });

      // Tab inserts two spaces rather than moving focus, and keeps the caret in
      // the text. Escape then Tab moves focus for keyboard users.
      textarea.addEventListener('keydown', function (event) {
        if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          var start = textarea.selectionStart;
          var end = textarea.selectionEnd;
          textarea.value = textarea.value.slice(0, start) + '  ' + textarea.value.slice(end);
          textarea.selectionStart = textarea.selectionEnd = start + 2;
          markDirty();
        }
        if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          save();
        }
        if (event.key === 's' && !event.ctrlKey && !event.metaKey && event.altKey) {
          event.preventDefault();
          setMode(editor.mode === 'split' ? 'edit' : 'split');
        }
      });
    }

    if (saveBtn) saveBtn.addEventListener('click', save);
    if (delBtn) delBtn.addEventListener('click', deleteCurrent);
    if (renameBtn) renameBtn.addEventListener('click', renameCurrent);
    if (newBtn) newBtn.addEventListener('click', openModal);
    if (splitBtn) splitBtn.addEventListener('click', function () { setMode(editor.mode === 'split' ? 'edit' : 'split'); });
    if (previewBtn) previewBtn.addEventListener('click', function () { setMode(editor.mode === 'preview' ? 'edit' : 'preview'); });
    if (openBtn) openBtn.addEventListener('click', function () {
      var url = hostUrl();
      if (url) window.open(url, '_blank', 'noopener');
      else notify('host this folder first', 'err');
    });
    if (modalCancel) modalCancel.addEventListener('click', closeModal);
    if (modalCreate) {
      modalCreate.addEventListener('click', function () {
        var name = (modalName && modalName.value || '').trim();
        if (!name) { if (modalErr) modalErr.textContent = 'name required'; return; }
        var tpl = 'html';
        modalTpls.forEach(function (b) { if (b.classList.contains('is-on')) tpl = b.getAttribute('data-tpl'); });
        closeModal();
        createFile(name, tpl);
      });
    }
    modalTpls.forEach(function (btn) {
      btn.addEventListener('click', function () {
        modalTpls.forEach(function (b) { b.classList.remove('is-on'); });
        btn.classList.add('is-on');
        if (modalName && !modalName.value) {
          modalName.value = btn.getAttribute('data-name') || '';
        }
      });
    });
    if (modalName) {
      modalName.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && modalCreate) modalCreate.click();
      });
    }
    if (modal) {
      modal.addEventListener('click', function (event) { if (event.target === modal) closeModal(); });

      // Escape closes, and Tab cycles inside the dialog. aria-modal told
      // assistive tech the background was inert while focus could still walk
      // straight out into the sidebar behind it.
      modal.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeModal();
          if (lastFocus && lastFocus.focus) lastFocus.focus();
          return;
        }
        if (event.key !== 'Tab') return;

        var focusables = [].slice.call(modal.querySelectorAll(
          'button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )).filter(function (el) { return el.offsetParent !== null; });
        if (!focusables.length) return;

        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    }

    // Expose a tiny surface the dashboard calls when the selection changes.
    return {
      openProject: openProject,
      closeProject: closeProject,
      setHost: function (host) { editor.host = host; refreshPreview(); },

      // Called by the dashboard after every render. Binds the editor to the
      // selected project and keeps the open file if it still exists there.
      sync: function (project, port) {
        var dir = project ? project.dir : null;
        var host = port ? { port: port } : null;

        if (!dir) {
          if (editor.dir) closeProject();
          return;
        }
        if (dir !== editor.dir) {
          if (isDirty() && !confirmLeave()) {
            // Refused: stay put. The dashboard has already moved on, so put the
            // selection back to match what the editor is still showing.
            return;
          }
          openProject(dir);
        }
        editor.host = host;

        // Do not clear the open file based on the project list alone. A
        // rescan triggered by our own create/rename can arrive with a stale
        // snapshot that does not yet list the file we just opened, and
        // trusting it silently discarded the buffer.
        if (editor.name && project) {
          var stillThere = (project.files || []).some(function (f) { return f.name === editor.name; });
          if (!stillThere && !editor.saved) {
            // Unsaved work: keep it on screen rather than destroy it.
            updateStatus();
            return;
          }
          if (!stillThere) {
            clearOpen();
            refreshFiles();
          }
        } else if (editor.name) {
          refreshFiles();
        }
        refreshPreview();
      },

      isDirty: isDirty,
      confirmLeave: confirmLeave,
      currentDir: function () { return editor.dir; },
      save: save,
      openFile: openFile,
      openModal: openModal,
      root: root,
    };
  }

  window.simHostInitEditor = initEditor;
})();
`;

/** Returns the editor markup, mounted inside the dashboard main panel. */
export function renderEditorPanel() {
  return `
<section class="ed" id="edRoot" aria-label="Editor">
  <div class="ed-bar">
    <span class="ed-file" id="edFile"><span class="dirty"></span><span class="nm">no file open</span></span>
    <span class="ed-title" id="edTitle"></span>
    <span class="ed-spacer"></span>
    <button class="btn" type="button" id="edNew">New<span class="k">n</span></button>
    <button class="btn" type="button" id="edRename">Rename</button>
    <button class="btn" type="button" id="edDelete">Delete</button>
    <button class="btn" type="button" id="edSplit">Split<span class="k">alt+s</span></button>
    <button class="btn" type="button" id="edPreview">Preview</button>
    <button class="btn" type="button" id="edOpen">Open</button>
    <button class="btn btn-primary" type="button" id="edSave">Save<span class="k">ctrl+s</span></button>
  </div>

  <div class="ed-grid" id="edGrid">
    <div class="ed-side">
      <div class="ed-head">Files</div>
      <ul class="ed-files" id="edFiles"></ul>
      <div class="ed-head">Source</div>
      <textarea class="ed-editor" id="edEditor" spellcheck="false" autocomplete="off"
        autocapitalize="off" wrap="off" aria-label="Source code"
        placeholder="Create a file with New, or pick one from the list."></textarea>
    </div>
    <div class="ed-side ed-preview" id="edPreviewWrap">
      <div class="ed-head">Preview</div>
      <div id="edPreviewEmpty" class="ed-empty">Host this folder to preview changes here.</div>
      <iframe id="edFrame" title="Preview" src="about:blank"></iframe>
    </div>
  </div>

  <div class="ed-status" id="edStatus"></div>
</section>

<div class="ed-modal" id="edModal" role="dialog" aria-modal="true" aria-label="New file">
  <div class="ed-dialog">
    <h3>New file</h3>
    <div class="body">
      <div>
        <label for="edModalName">File name</label>
        <input type="text" id="edModalName" placeholder="my-sim.html" spellcheck="false" autocomplete="off">
      </div>
      <div>
        <label>Start from</label>
        <div class="tpl-row" id="edModalTpls">
          <button class="tpl is-on" type="button" data-tpl="html" data-name="simulation.html">Canvas 2D</button>
          <button class="tpl" type="button" data-tpl="canvas3d" data-name="scene.html">Three.js</button>
          <button class="tpl" type="button" data-tpl="blank" data-name="untitled.html">Empty</button>
        </div>
      </div>
      <div class="ed-err" id="edModalErr"></div>
    </div>
    <div class="foot">
      <button class="btn" type="button" id="edModalCancel">Cancel</button>
      <button class="btn btn-primary" type="button" id="edModalCreate">Create</button>
    </div>
  </div>
</div>`;
}

