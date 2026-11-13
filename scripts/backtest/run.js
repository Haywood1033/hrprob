#!/usr/bin/env node
// Scores the backfilled seasons with the app's own hrProb() and reports
// how well the numbers hold up. Reads data/backtest/cache (see fetch.js).
//
//   node scripts/backtest/run.js            # report only
//   node scripts/backtest/run.js --apply    # also write the fitted
//                                           # calibration knots into app.html
//
// What is and is not replayed: batter Statcast profile, park, game-time
// weather, opposing starter, batting order and the hot/cold streak
// multiplier are rebuilt as they stood before each game. Platoon splits,
// pitcher splits, career head-to-head and bullpen are NOT backfilled, so
// the model runs with its built-in fallbacks for those.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildRows } = require('./features.js');
const M = require('./metrics.js');
const { loadApp } = require('../../tests/lib/loadApp.js');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'data', 'backtest');
const CACHE = path.join(DIR, 'cache');

function loadSeason(season) {
  const days = fs.readdirSync(path.join(CACHE, 'days')).filter(f => f.startsWith(season + '-'))
    .map(f => JSON.parse(fs.readFileSync(path.join(CACHE, 'days', f), 'utf8')));
  const wf = path.join(CACHE, `weather-${season}.json`);
  const wx = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {};
  const pf = path.join(CACHE, 'people.json');
  const people = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : {};
  return buildRows(days, pk => wx[pk], id => people[id]);
}

// Runs inside the app's sandbox so hrProb sees its own globals.
const SCORER = `(function(json){
  const rows = JSON.parse(json), out = [];
  const clean = o => { const r = {}; for (const k in o) if (o[k] !== null) r[k] = o[k]; return r; };
  for (const r of rows) {
    const park = getPark(r.home) || { f: 1.0 };
    const b = clean(r.b); b._name = 'bt' + r.batter;
    const pit = clean(r.p);
    delete STREAK[b._name];
    const core = hrProb(b, park, {}, pit, r.order);
    const wx   = hrProb(b, park, r.wx || {}, pit, r.order);
    if (r.streak) STREAK[b._name] = r.streak;
    const raw  = hrProbUncalibrated(b, park, r.wx || {}, pit, r.order);
    delete STREAK[b._name];
    out.push([core, wx, raw]);
  }
  return JSON.stringify(out);
})`;

function scoreRows(rows) {
  const fn = loadApp().run(SCORER);
  for (let i = 0; i < rows.length; i += 5000) {
    const chunk = rows.slice(i, i + 5000);
    JSON.parse(fn(JSON.stringify(chunk))).forEach(([core, wx, raw], j) => {
      Object.assign(chunk[j], { pCore: core, pWx: wx, pRaw: raw, pCliff: raw >= 20 ? raw * 0.74 : raw });
    });
  }
}

const pcts = (rows, k) => rows.map(r => r[k] / 100);
const ys = rows => rows.map(r => r.hr);
const r4 = o => JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(5) : v));

function report(rows, extra = {}) {
  const variants = { core: 'pCore', weather: 'pWx', streak: 'pRaw', cliff: 'pCliff', ...extra };
  const out = {};
  for (const [name, key] of Object.entries(variants)) {
    out[name] = { ...M.score(pcts(rows, key), ys(rows)), top5: M.topN(rows, key, 5), top10: M.topN(rows, key, 10),
      bins: M.bins(pcts(rows, key), ys(rows)) };
  }
  return out;
}

(function main() {
  const seasons = [...new Set(fs.readdirSync(path.join(CACHE, 'days')).map(f => f.slice(0, 4)))].sort();
  if (!seasons.length) throw new Error('No cached days -- run fetch.js first');
  const bySeason = {};
  for (const s of seasons) { bySeason[s] = loadSeason(s); scoreRows(bySeason[s]); console.log(`${s}: ${bySeason[s].length} batter-games`); }
  const all = seasons.flatMap(s => bySeason[s]);

  // Out-of-sample check: fit the curve on every season but the last, grade on the last.
  const last = seasons[seasons.length - 1];
  const train = seasons.length > 1 ? seasons.slice(0, -1).flatMap(s => bySeason[s]) : null;
  let oos = null;
  if (train) {
    const k = M.isotonicKnots(pcts(train, 'pRaw'), ys(train));
    for (const r of bySeason[last]) r.pFitOOS = 100 * M.applyKnots(k, r.pRaw / 100);
    oos = { trainedOn: seasons.slice(0, -1), gradedOn: last, knots: k, ...report(bySeason[last], { fitted: 'pFitOOS' }) };
  }
  // Shipping curve: fit on everything.
  const knots = M.isotonicKnots(pcts(all, 'pRaw'), ys(all));
  for (const r of all) r.pCal = 100 * M.applyKnots(knots, r.pRaw / 100);
  const appKnots = knots.map(k => [+(k[0] * 100).toFixed(2), +(k[1] * 100).toFixed(2)]);

  const flame = {};
  for (const r of all) {
    const f = r.streak?.flame || 'none';
    const o = flame[f] ||= { n: 0, hr: 0, noStreak: 0, withStreak: 0 };
    o.n++; o.hr += r.hr; o.noStreak += r.pWx; o.withStreak += r.pRaw;
  }
  for (const o of Object.values(flame)) { o.actual = o.hr / o.n; o.predNoStreak = o.noStreak / o.n / 100; o.predWithStreak = o.withStreak / o.n / 100; delete o.noStreak; delete o.withStreak; }

  const results = r4({
    generated: new Date().toISOString().slice(0, 10), seasons,
    rows: all.length, days: new Set(all.map(r => r.date)).size,
    notReplayed: ['platoon splits', 'pitcher splits', 'career head-to-head', 'bullpen'],
    xeraNote: 'xERA is a linear proxy from xwOBA allowed (4.20 + (xwOBA - .315) x 30), not Savant xERA',
    all: report(all, { calibrated: 'pCal' }),
    bySeason: Object.fromEntries(seasons.map(s => [s, report(bySeason[s], { calibrated: 'pCal' })])),
    afterDay30: report(all.filter(r => +r.date.slice(5, 7) >= 5), { calibrated: 'pCal' }),
    outOfSample: oos, streakCheck: flame, calibrationKnots: appKnots, knotSamples: knots.map(k => k[2]),
  });
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(results, null, 1));

  const cols = ['date', 'pk', 'home', 'away', 'team', 'batter', 'pitcher', 'order', 'pa', 'hr', 'pCore', 'pWx', 'pRaw', 'pCal'];
  const lines = all.map(r => JSON.stringify({ ...Object.fromEntries(cols.map(c => [c, typeof r[c] === 'number' ? +r[c].toFixed(2) : r[c]])), b: r.b, p: r.p, streak: r.streak?.flame || '', wx: r.wx }));
  fs.writeFileSync(path.join(DIR, 'rows.jsonl.gz'), zlib.gzipSync(lines.join('\n') + '\n'));

  const line = (n, v) => console.log(`  ${n.padEnd(11)} brier ${v.brier.toFixed(5)}  skill ${(100 * v.brierSkill).toFixed(2)}%  logloss-skill ${(100 * v.logLossSkill).toFixed(2)}%  auc ${v.auc.toFixed(3)}  mean ${(100 * v.meanPred).toFixed(1)}% vs ${(100 * v.baseRate).toFixed(1)}%  top5 ${(100 * v.top5.hitRate).toFixed(1)}%  top10 ${(100 * v.top10.hitRate).toFixed(1)}%`);
  console.log(`\nAll seasons (${all.length} batter-games)`);
  for (const [n, v] of Object.entries(results.all)) line(n, v);
  if (oos) { console.log(`\nOut of sample: curve fitted on ${oos.trainedOn.join('+')}, graded on ${last}`); for (const n of ['streak', 'cliff', 'fitted']) line(n, oos[n]); }
  console.log('\nKnots [model %, calibrated %]:', JSON.stringify(appKnots));

  if (process.argv.includes('--apply')) {
    const f = path.join(ROOT, 'app.html');
    const html = fs.readFileSync(f, 'utf8');
    const next = html.replace(/const HR_CALIB_KNOTS = \[.*\];/, `const HR_CALIB_KNOTS = ${JSON.stringify(appKnots)};`);
    if (next === html) throw new Error('HR_CALIB_KNOTS line not found in app.html');
    fs.writeFileSync(f, next);
    console.log('Wrote knots to app.html');
  }
})();
