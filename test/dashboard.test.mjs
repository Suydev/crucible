// test/dashboard.test.mjs
// Guards the dashboard's client-side path helpers against regressions.
//
// Each case below corresponds to a bug that shipped once: a missing `files`
// array crashing the tree renderer, the virtual root showing nothing, and
// findProject resolving a container to its deepest descendant.

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderDashboard } from '../lib/dashboard.mjs';

// The client helpers are embedded as a string, so exercise them through the
// same code path the browser runs by extracting and evaluating them.
function extractHelper(name) {
  const html = renderDashboard({ tree: { children: [] }, projects: [], instances: {} });
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should be present in the dashboard script`);
  const bodyStart = html.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }
  throw new Error(`could not extract ${name}`);
}

// The client helpers close over a module-scope `state` variable, so build an
// evaluator that supplies it, exactly as the browser does.
function makeEvaluator(names) {
  const bodies = names.map(extractHelper).join('\n');
  return (state, prefix) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function('state', `${bodies}\nreturn ${names[0]}(arguments[1]);`);
    return fn(state, prefix);
  };
}

function makeState(projects, tree) {
  return { projects, instances: {}, tree, selected: '/root' };
}

const PROJECTS = [
  { dir: '/root/isotope-code', label: 'isotope-code', fileCount: 1, files: [{ name: 'index.html' }] },
  { dir: '/root/isotope-code/docs', label: 'docs', fileCount: 22, files: [{ name: 'a.html' }, { name: 'b.html' }] },
  { dir: '/root/vendor-test', label: 'vendor-test', fileCount: 1, files: [{ name: 'x.html' }] },
];

const TREE = {
  name: 'storage',
  path: '/',
  children: [
    {
      name: 'root',
      path: '/root',
      children: [
        { name: 'vendor-test', path: '/root/vendor-test', children: [], project: { label: 'vendor-test', fileCount: 1 } },
        {
          name: 'isotope-code',
          path: '/root/isotope-code',
          children: [
            { name: 'docs', path: '/root/isotope-code/docs', children: [], project: { label: 'docs', fileCount: 22 } },
          ],
          project: { label: 'isotope-code', fileCount: 1 },
        },
      ],
    },
  ],
};

test('findProject matches only the exact directory', () => {
  const find = makeEvaluator(['findProject']);
  // A container folder is not itself a project.
  assert.equal(find(makeState(PROJECTS, TREE), '/root'), null);
  // An exact project resolves.
  assert.equal(find(makeState(PROJECTS, TREE), '/root/isotope-code/docs').label, 'docs');
});

test('childProjects lists direct children only', () => {
  const children = makeEvaluator(['childProjects'])(makeState(PROJECTS, TREE), '/root');
  assert.deepEqual(children.map((p) => p.label).sort(), ['isotope-code', 'vendor-test']);
});

test('childProjects excludes nested projects from the parent listing', () => {
  const children = makeEvaluator(['childProjects'])(makeState(PROJECTS, TREE), '/root');
  assert.ok(!children.some((p) => p.dir === '/root/isotope-code/docs'), 'must not list nested projects');
});

test('childProjects returns nothing for the virtual root', () => {
  assert.deepEqual(makeEvaluator(['childProjects'])(makeState(PROJECTS, TREE), '/'), []);
});

test('livePort reports a port only for a live instance', () => {
  const port = makeEvaluator(['livePort']);

  const live = makeState(PROJECTS, TREE);
  live.instances = { '/root/isotope-code/docs': { port: 5127, alive: true } };
  assert.equal(port(live, '/root/isotope-code/docs'), 5127);

  const dead = makeState(PROJECTS, TREE);
  dead.instances = { '/root/isotope-code/docs': { port: 5127, alive: false } };
  assert.equal(port(dead, '/root/isotope-code/docs'), null);

  assert.equal(port(makeState(PROJECTS, TREE), '/root/vendor-test'), null);
});

test('dashboard embeds the state payload and escapes it safely', () => {
  const html = renderDashboard({
    tree: TREE,
    projects: PROJECTS,
    instances: { '/root/x': { port: 5000, alive: true } },
    liveReload: true,
    port: 5050,
  });
  assert.ok(html.includes('__SIM_HOST_DASH__'), 'state must be embedded');
  assert.ok(html.includes('vendor-test'));
  // A </script> inside data must not break out of the script block.
  const nasty = renderDashboard({
    tree: { name: '</script><script>alert(1)</script>', path: '/', children: [] },
    projects: [], instances: {},
  });
  const payload = nasty.match(/__SIM_HOST_DASH__ = (.*?);<\/script>/s);
  assert.ok(payload, 'payload should still parse out');
  assert.ok(!payload[1].includes('</script>'), 'payload must not contain a closing script tag');
});

test('dashboard renders the live reload badge state', () => {
  const on = renderDashboard({ tree: TREE, projects: PROJECTS, instances: {}, liveReload: true, port: 5050 });
  assert.ok(on.includes('live reload on'));
  const off = renderDashboard({ tree: TREE, projects: PROJECTS, instances: {}, liveReload: false, port: 5050 });
  assert.ok(off.includes('live reload off'));
});
