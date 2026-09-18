// Loads app.html's inline <script> into an isolated vm context so pure
// calculation functions (hrProb, getSignals, ...) can be unit tested
// without a browser. init() — the function that kicks off real network
// fetches and DOM wiring — is stripped before the script runs; everything
// else (function declarations, top-level const/let state like PARKS,
// SPLITS, BULLPEN) loads exactly as it does in the browser.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_HTML_PATH = path.join(__dirname, '..', '..', 'app.html');

function extractScript() {
  const html = fs.readFileSync(APP_HTML_PATH, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find <script> block in app.html');
  let script = match[1];

  // Strip the trailing init() call — we only want top-level declarations
  // (functions, PARKS, etc.), not the real init sequence (fetches, DOM
  // wiring, timers). Fail loudly if the file no longer has exactly this
  // shape, so a future refactor of the init call doesn't silently make
  // these tests load a half-initialized app.
  const initCallPattern = /\ninit\(\);\s*$/;
  if (!initCallPattern.test(script)) {
    throw new Error(
      "Expected app.html's script to end with a trailing 'init();' call — " +
      'the test harness strips it so tests do not trigger real network ' +
      'fetches. Update tests/lib/loadApp.js if init() was moved/renamed.'
    );
  }
  script = script.replace(initCallPattern, '\n');
  return script;
}

// Minimal, permissive stand-ins for the DOM/browser APIs the app's
// top-level code touches (window._debug = {...}). Individual tests that
// call functions touching the DOM more heavily should extend these via
// app.run(...) rather than growing this file.
function makeFakeElement() {
  const el = {
    style: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    dataset: {},
    children: [],
    appendChild(){},
    addEventListener(){},
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    setAttribute(){},
    getAttribute(){ return null; },
  };
  Object.defineProperty(el, 'textContent', { value: '', writable: true });
  Object.defineProperty(el, 'innerHTML', { value: '', writable: true });
  Object.defineProperty(el, 'value', { value: '', writable: true });
  return el;
}

function buildSandbox() {
  const sandbox = {};
  sandbox.window = sandbox; // classic-script global === window, like a browser
  sandbox.globalThis = sandbox;
  sandbox.document = {
    getElementById(){ return makeFakeElement(); },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(){ return makeFakeElement(); },
    body: makeFakeElement(),
    addEventListener(){},
  };
  sandbox.localStorage = {
    _data: {},
    getItem(k){ return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
    setItem(k,v){ this._data[k] = String(v); },
    removeItem(k){ delete this._data[k]; },
  };
  // Never actually invoked (init() is stripped), but present in case a
  // function under test calls it — resolves to a harmless empty failure
  // rather than throwing "fetch is not defined".
  sandbox.fetch = () => Promise.reject(new Error('fetch is disabled in the test sandbox'));
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.AbortController = AbortController;
  sandbox.navigator = { userAgent: 'node-test-harness' };
  vm.createContext(sandbox);
  return sandbox;
}

let cached = null;

/**
 * Loads app.html's script once (cached across calls in a single test
 * process) and returns a handle with:
 *   - all top-level functions/consts accessible as properties (e.g. .hrProb)
 *   - .run(code) to execute further code sharing the same top-level scope,
 *     which is how you reach into const objects like SPLITS/BULLPEN to set
 *     up fixtures (they're not exposed as sandbox properties directly —
 *     see the vm module's scoping rules for top-level const/let).
 */
function loadApp() {
  if (cached) return cached;
  const script = extractScript();
  const sandbox = buildSandbox();
  const vmScript = new vm.Script(script, { filename: 'app.html-inline-script' });
  vmScript.runInContext(sandbox);

  cached = {
    sandbox,
    run(code) {
      return vm.runInContext(code, sandbox);
    },
  };
  return cached;
}

module.exports = { loadApp };
