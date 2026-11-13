// Statcast pitch-level CSV -> compact per-game batter and pitcher lines.
// Pure functions only (no network) so the aggregation is unit-testable.
'use strict';

// Savant team abbreviation -> PARKS key in app.html.
const TEAM = { LAA:'Angels', AZ:'Diamondbacks', ARI:'Diamondbacks', BAL:'Orioles', BOS:'Red Sox',
  CHC:'Cubs', CIN:'Reds', CLE:'Guardians', COL:'Rockies', DET:'Tigers', HOU:'Astros', KC:'Royals',
  LAD:'Dodgers', MIA:'Marlins', MIL:'Brewers', MIN:'Twins', NYM:'Mets', NYY:'Yankees', ATH:'Athletics',
  OAK:'Athletics', PHI:'Phillies', PIT:'Pirates', SD:'Padres', SF:'Giants', SEA:'Mariners',
  STL:'Cardinals', TB:'Rays', TEX:'Rangers', TOR:'Blue Jays', WSH:'Nationals', CWS:'White Sox',
  CHW:'White Sox', ATL:'Braves' };

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length === head.length)
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// Plate-appearance-ending events. Anything else in `events` (pickoffs,
// caught stealing, truncated PAs) does not count as a PA.
const TB = { single:1, double:2, triple:3, home_run:4 };
const NON_AB = new Set(['walk','intent_walk','hit_by_pitch','sac_fly','sac_bunt','catcher_interf','sac_fly_double_play','sac_bunt_double_play']);
const OUTS = { strikeout:1, field_out:1, force_out:1, sac_fly:1, sac_bunt:1, fielders_choice_out:1,
  grounded_into_double_play:2, double_play:2, strikeout_double_play:2, sac_fly_double_play:2,
  sac_bunt_double_play:2, triple_play:3 };
const PA_EVENTS = new Set([...Object.keys(TB), ...NON_AB, ...Object.keys(OUTS), 'field_error','fielders_choice']);
const WHIFF = new Set(['swinging_strike','swinging_strike_blocked']);
const SWING = new Set([...WHIFF, 'foul','foul_tip','hit_into_play','foul_bunt','missed_bunt','bunt_foul_tip']);

const num = v => (v === '' || v == null || v === 'null') ? null : (Number.isFinite(+v) ? +v : null);
const blank = () => ({ pa:0, ab:0, h:0, tb:0, hr:0, bb:0, k:0, bbe:0, evSum:0, evN:0, laSum:0, laN:0,
  brl:0, hh:0, ss:0, fb:0, gb:0, pull:0, sprayN:0, xwNum:0, xwDen:0, sw:0, wh:0, outs:0 });

function addPitch(line, r) {
  if (SWING.has(r.description)) { line.sw++; if (WHIFF.has(r.description)) line.wh++; }
  const ev = r.events;
  if (!ev || !PA_EVENTS.has(ev)) return false;
  line.pa++;
  if (!NON_AB.has(ev)) line.ab++;
  if (TB[ev]) { line.h++; line.tb += TB[ev]; }
  if (ev === 'home_run') line.hr++;
  if (ev === 'walk' || ev === 'intent_walk') line.bb++;
  if (ev.startsWith('strikeout')) line.k++;
  line.outs += OUTS[ev] || 0;
  const ls = num(r.launch_speed), la = num(r.launch_angle);
  const inPlay = r.description === 'hit_into_play' || !!r.bb_type;
  if (inPlay) {
    line.bbe++;
    if (ls !== null) { line.evSum += ls; line.evN++; if (ls >= 95) line.hh++; }
    if (la !== null) { line.laSum += la; line.laN++; if (la >= 8 && la <= 32) line.ss++; }
    if (num(r.launch_speed_angle) === 6) line.brl++;
    if (r.bb_type === 'fly_ball') line.fb++;
    if (r.bb_type === 'ground_ball') line.gb++;
    const hx = num(r.hc_x), hy = num(r.hc_y);
    if (hx !== null && hy !== null) {
      // Spray angle: negative = left field. Pulled = RHB to left, LHB to right.
      // The raw hc_x/hc_y angle runs wider than the 90-degree field; the
      // standard 0.75 scale maps the foul lines to +/-45 so that thirds of
      // the field (cut at +/-15) reproduce Savant's pull/straight/oppo split
      // (~38/37/25 league-wide). Without it league pull% reads ~44%.
      const ang = Math.atan2(hx - 125.42, 198.27 - hy) * 180 / Math.PI * 0.75;
      line.sprayN++;
      if ((r.stand === 'R' && ang < -15) || (r.stand === 'L' && ang > 15)) line.pull++;
    }
  }
  const xw = inPlay ? (num(r.estimated_woba_using_speedangle) ?? num(r.woba_value)) : num(r.woba_value);
  const den = num(r.woba_denom);
  if (den) { line.xwDen += den; line.xwNum += xw || 0; }
  return true;
}

// rows: parsed pitch-level CSV rows for one date (any order).
function aggregateDay(rows) {
  const games = {};
  const sorted = rows.filter(r => r.game_pk && r.batter && r.pitcher).sort((a, b) =>
    (+a.game_pk - +b.game_pk) || (+a.at_bat_number - +b.at_bat_number) || (+a.pitch_number - +b.pitch_number));
  for (const r of sorted) {
    const g = games[r.game_pk] ||= { pk:+r.game_pk, date:r.game_date.slice(0,10), home:TEAM[r.home_team] || r.home_team,
      away:TEAM[r.away_team] || r.away_team, batters:{}, pitchers:{},
      lineup:{ home:[], away:[] }, starter:{ home:null, away:null } };
    const side = r.inning_topbot === 'Top' ? 'away' : 'home';      // batting side
    const fld  = side === 'away' ? 'home' : 'away';                // pitching side
    const b = g.batters[r.batter] ||= { id:+r.batter, side, stand:r.stand, ...blank() };
    const p = g.pitchers[r.pitcher] ||= { id:+r.pitcher, side:fld, hand:r.p_throws, ...blank() };
    if (g.starter[fld] === null) g.starter[fld] = +r.pitcher;
    // Starting nine = first nine distinct batters to come up for each side.
    if (g.lineup[side].length < 9 && !g.lineup[side].includes(+r.batter)) g.lineup[side].push(+r.batter);
    b.stand = b.stand === r.stand ? b.stand : 'S';
    addPitch(b, r);
    addPitch(p, r);
  }
  return Object.values(games);
}

module.exports = { parseCSV, aggregateDay, blank, TEAM };
