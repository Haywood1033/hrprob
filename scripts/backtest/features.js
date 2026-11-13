// Leak-free feature builder. For every game it emits one row per starting
// batter using ONLY what was known before that date: season-to-date
// Statcast totals through the previous day, the same shape the live app
// reads from Baseball Savant each morning. The day's own results are added
// to the running totals only after every game on that date has been emitted.
'use strict';
const { blank } = require('./savant.js');

const SUM_KEYS = Object.keys(blank());
const pct = (a, b) => b > 0 ? +(100 * a / b).toFixed(2) : null;

function batterFeatures(t, stand) {
  if (!t || t.pa < 1) return { pa: 0, bats: stand || 'R' };
  return {
    pa: t.pa, bats: stand || 'R',
    ba:  t.bbe ? pct(t.brl, t.bbe) : null,
    ev:  t.evN ? +(t.evSum / t.evN).toFixed(2) : null,
    hh:  t.evN ? pct(t.hh, t.evN) : null,
    xw:  t.xwDen ? +(t.xwNum / t.xwDen).toFixed(3) : null,
    iso: t.ab ? +((t.tb - t.h) / t.ab).toFixed(3) : null,
    la:  t.laN >= 10 ? +(t.laSum / t.laN).toFixed(1) : null,
    pull_pct: t.sprayN >= 20 ? pct(t.pull, t.sprayN) : null,
    fb_pct:   t.bbe >= 20 ? pct(t.fb, t.bbe) : null,
    gb_pct:   t.bbe >= 20 ? pct(t.gb, t.bbe) : null,
    sweet_spot_pct: t.laN >= 20 ? pct(t.ss, t.laN) : null,
    bb_pct:    pct(t.bb, t.pa),
    whiff_pct: t.sw >= 30 ? pct(t.wh, t.sw) : null,
  };
}

// xERA is Savant's own xwOBA-to-ERA translation and is not published at
// pitch level. This linear stand-in (league .315 xwOBA ~ 4.20 ERA) is a
// PROXY, named as such in the results.
const xeraProxy = xw => +(4.20 + (xw - 0.315) * 30).toFixed(2);

function pitcherFeatures(t, hand) {
  if (!t || t.pa < 10) return { hand: hand || 'R' };   // live app: Savant min=10 PA, else defaults
  return {
    hand: hand || 'R', bf: t.pa,
    xera:  t.xwDen ? Math.max(1.5, Math.min(9, xeraProxy(t.xwNum / t.xwDen))) : null,
    hr9:   t.outs >= 27 ? Math.min(4, +(t.hr * 27 / t.outs).toFixed(2)) : null,
    hh:    t.evN >= 20 ? pct(t.hh, t.evN) : null,
    whiff: t.sw >= 50 ? pct(t.wh, t.sw) : null,
    gb_pct: t.bbe >= 20 ? pct(t.gb, t.bbe) : null,
  };
}

// Mirrors api/streaks.js: last 20 PA window, most recent game first.
function streakFeatures(log) {
  let hr = 0, ab = 0, tb = 0, pa = 0;
  for (let i = log.length - 1; i >= 0 && pa < 20; i--) {
    const g = log[i];
    const f = pa + g.pa > 20 ? (20 - pa) / g.pa : 1;
    hr += Math.round(g.hr * f); ab += Math.round(g.ab * f); tb += Math.round(g.tb * f);
    pa = Math.min(20, pa + g.pa);
  }
  if (!pa) return null;
  const slg = ab > 0 ? +(tb / ab).toFixed(3) : 0;
  const flame = hr >= 4 ? '🔥🔥' : hr >= 2 ? '🔥' : (pa >= 18 && slg < 0.250) ? '❄️' : '';
  return { flame, slg, ab, hr, pa };
}

function add(tot, line) { for (const k of SUM_KEYS) tot[k] += line[k] || 0; }

/**
 * days: [{ date, games:[aggregateDay() output] }] for ONE season, any order.
 * weather: optional (pk) => wx object or null.
 * Returns rows sorted by date.
 */
function buildRows(days, weather = () => null) {
  const bat = new Map(), pit = new Map(), logs = new Map(), rows = [];
  const sorted = [...days].sort((a, b) => a.date < b.date ? -1 : 1);
  for (const day of sorted) {
    for (const g of day.games) {
      for (const side of ['away', 'home']) {
        const oppSide = side === 'away' ? 'home' : 'away';
        const spId = g.starter[oppSide];
        const sp = g.pitchers[spId];
        g.lineup[side].forEach((id, i) => {
          const b = g.batters[id];
          rows.push({
            date: day.date, pk: g.pk, home: g.home, away: g.away, team: g[side], side,
            batter: id, pitcher: spId, order: i + 1,
            b: batterFeatures(bat.get(id), b.stand),
            p: pitcherFeatures(pit.get(spId), sp && sp.hand),
            streak: streakFeatures(logs.get(id) || []),
            wx: weather(g.pk) || null,
            // outcome
            hr: b.hr > 0 ? 1 : 0, pa: b.pa,
          });
        });
      }
    }
    // Only now does this date's data become "known".
    for (const g of day.games) {
      for (const b of Object.values(g.batters)) {
        if (!bat.has(b.id)) bat.set(b.id, blank());
        add(bat.get(b.id), b);
        if (b.pa > 0) { if (!logs.has(b.id)) logs.set(b.id, []); logs.get(b.id).push({ pa:b.pa, ab:b.ab, tb:b.tb, hr:b.hr }); }
      }
      for (const p of Object.values(g.pitchers)) {
        if (!pit.has(p.id)) pit.set(p.id, blank());
        add(pit.get(p.id), p);
      }
    }
  }
  return rows;
}

module.exports = { buildRows, batterFeatures, pitcherFeatures, streakFeatures, xeraProxy };
