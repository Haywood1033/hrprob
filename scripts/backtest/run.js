#!/usr/bin/env node
// Scores the locally cached seasons (see fetch.js) and writes
// data/backtest/results.json and rows.jsonl.gz.
//
//   node scripts/backtest/run.js            # report only
//   node scripts/backtest/run.js --apply    # also write the fitted
//                                           # calibration knots into app.html
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { scoreSeasons } = require('../../lib/backtest/score.js');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'data', 'backtest');
const CACHE = path.join(DIR, 'cache');
const readJSON = (f, fallback) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback;

(function main() {
  const seasons = [...new Set(fs.readdirSync(path.join(CACHE, 'days')).map(f => f.slice(0, 4)))].sort();
  if (!seasons.length) throw new Error('No cached days -- run fetch.js first');
  const people = readJSON(path.join(CACHE, 'people.json'), {});
  const input = {};
  for (const s of seasons) input[s] = {
    days: fs.readdirSync(path.join(CACHE, 'days')).filter(f => f.startsWith(s + '-')).map(f => readJSON(path.join(CACHE, 'days', f))),
    wx: readJSON(path.join(CACHE, `weather-${s}.json`), {}), people };
  const { results, rows: all, appKnots, bySeason } = scoreSeasons(input);
  for (const s of seasons) console.log(`${s}: ${bySeason[s].length} batter-games`);
  const oos = results.outOfSample, last = seasons[seasons.length - 1];
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
    if (appKnots.length < 3) throw new Error('Too few knots to trust -- not writing them to app.html');
    const f = path.join(ROOT, 'app.html');
    const html = fs.readFileSync(f, 'utf8');
    const next = html.replace(/const HR_CALIB_KNOTS = \[.*\];/, `const HR_CALIB_KNOTS = ${JSON.stringify(appKnots)};`);
    if (next === html) throw new Error('HR_CALIB_KNOTS line not found in app.html');
    fs.writeFileSync(f, next);
    console.log('Wrote knots to app.html');
  }
})();
