// Scores backfilled seasons with the app's own hrProb() and measures how
// the numbers hold up. Storage-agnostic: callers hand in each season's
// days, weather and roster bat sides.
//
// What is and is not replayed: batter Statcast profile, park, game-time
// weather, opposing starter, batting order and the hot/cold streak
// multiplier are rebuilt as they stood before each game. Platoon splits,
// pitcher splits, career head-to-head and bullpen are NOT backfilled, so
// the model runs with its built-in fallbacks for those.
'use strict';
const { buildRows } = require('./features.js');
const M = require('./metrics.js');
const { loadApp } = require('../appSandbox.js');

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


/**
 * input: { [season]: { days: [{date, games}], wx: {pk: wx}, people: {id: side} } }
 * Returns { results, rows, appKnots }.
 */
function scoreSeasons(input) {
  const seasons = Object.keys(input).sort();
  const bySeason = {};
  for (const s of seasons) {
    const { days, wx = {}, people = {} } = input[s];
    bySeason[s] = buildRows(days, pk => wx[pk], id => people[id]);
    scoreRows(bySeason[s]);
  }
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
  return { results, rows: all, appKnots, bySeason };
}

module.exports = { scoreSeasons };
