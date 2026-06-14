// lib/statcast.js — CommonJS
const SAVANT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://baseballsavant.mlb.com/',
  'Cache-Control': 'no-cache',
};

async function fetchCSV(url) {
  const r = await fetch(url, { headers: SAVANT_HEADERS });
  if (!r.ok) throw new Error(`Savant ${r.status}`);
  return r.text();
}

// Parse CSV properly — handles quoted fields with commas inside
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  
  // Parse header — the tricky part is "last_name, first_name" is ONE column
  // but contains a comma, so it may or may not be quoted
  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine).map(h => h.toLowerCase().trim());
  
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  }).filter(r => Object.keys(r).length > 2);
}

function parseCSVLine(line) {
  const vals = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
    else cur += ch;
  }
  vals.push(cur);
  return vals;
}

function getName(row) {
  // Baseball Savant CSV: "last_name, first_name" is a SINGLE quoted column
  // After parsing it becomes the key 'last_name, first_name'
  const lnfn = row['last_name, first_name'];
  if (lnfn && lnfn.trim()) {
    const parts = lnfn.split(',').map(s => s.trim());
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[1]} ${parts[0]}`; // "First Last"
    }
  }
  // Fallback: separate last_name and first_name columns
  if (row['first_name'] && row['last_name']) {
    return `${row['first_name'].trim()} ${row['last_name'].trim()}`;
  }
  if (row['player_name']) return row['player_name'].trim();
  return null;
}

function getNum(row, ...keys) {
  for (const k of keys) {
    const v = parseFloat(row[k]);
    if (!isNaN(v) && isFinite(v)) return v;
  }
  return null;
}

async function fetchBatterStatcast(year) {
  const text = await fetchCSV(
    `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=batter&filter=&sort=4&sortDir=desc&min=20&selections=xba,xslg,xwoba,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,strikeout_percent,sweet_spot_percent,ev50,hr,pa&csv=true`
  );
  return parseCSV(text);
}

async function fetchBatterExpected(year) {
  const text = await fetchCSV(
    `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&min=20&csv=true`
  );
  return parseCSV(text);
}

async function fetchBatterBattedBall(year) {
  // Batted ball profile — pull%, fly ball%, ground ball%
  const text = await fetchCSV(
    `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=batter&filter=&sort=4&sortDir=desc&min=20&selections=pull_percent,straightaway_percent,opposite_percent,groundballs_percent,flyballs_percent,linedrive_percent,flap_percent,pa&csv=true`
  );
  return parseCSV(text);
}

async function fetchPitcherStatcast(year) {
  const text = await fetchCSV(
    `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&filter=&sort=4&sortDir=asc&min=10&selections=xera,whiff_percent,p_hr_per9,strikeout_percent,p_k_percent,barrel_batted_rate,hard_hit_percent,exit_velocity_avg,p_home_run,p_formatted_ip,pa&csv=true`
  );
  return parseCSV(text);
}

async function fetchPitcherBattedBall(year) {
  // Pitcher batted ball profile — ground ball%, fly ball%
  const text = await fetchCSV(
    `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&filter=&sort=4&sortDir=asc&min=10&selections=groundballs_percent,flyballs_percent,linedrive_percent,pa&csv=true`
  );
  return parseCSV(text);
}

function buildBatterStats(batterRows, expectedRows) {
  const stats = {};
  // Build expected stats lookup by player_id
  const expById = {};
  if (expectedRows.length > 0) {
    console.log('Expected stats columns:', Object.keys(expectedRows[0]).join(', '));
  }
  for (const row of expectedRows) {
    const pid = row['player_id'] || row['mlbam_id'];
    if (pid) expById[pid] = {
      xba:   getNum(row,'xba','est_ba'),
      xslg:  getNum(row,'xslg','est_slg'),
      xwoba: getNum(row,'xwoba','est_woba'),
      ev50:  getNum(row,'ev50','xev50') ?? null,
    };
  }
  for (const row of batterRows) {
    const name = getName(row);
    if (!name) continue;
    const pid = row['player_id'] || row['mlbam_id'];
    const exp = expById[pid] || {};
    const xwoba = getNum(row,'xwoba','est_woba') ?? exp.xwoba ?? 0.310;
    const xba   = getNum(row,'xba','est_ba')     ?? exp.xba   ?? 0.240;
    const xslg  = getNum(row,'xslg','est_slg')   ?? exp.xslg  ?? 0.390;
    stats[name] = {
      ev:      getNum(row,'exit_velocity_avg','avg_hit_speed') ?? 88,
      ba:      getNum(row,'barrel_batted_rate','brl_percent')  ?? 8,
      hh:      getNum(row,'hard_hit_percent')                  ?? 38,
      xw:      +xwoba.toFixed(3),
      iso:     +(xslg - xba).toFixed(3),
      hr:      parseInt(row['hr'] || '0'),
      pa:      parseInt(row['pa'] || '0'),
      k_pct:   getNum(row,'strikeout_percent','k_percent') ?? null,
      bb_pct:  getNum(row,'b_bb_percent','bb_percent','walk_percent') ?? null,
      pull_pct:      null, // populated from batted ball fetch
      fb_pct:        null,
      gb_pct:        null,
      sweet_spot_pct: getNum(row,'sweet_spot_percent','launch_angle_sweet_spot_percent') ?? null,
      ev50:           getNum(row,'ev50','adjusted_exit_velocity') ?? exp.ev50 ?? null,
    };
  }
  console.log(`buildBatterStats: ${Object.keys(stats).length} batters`);
  // Log sample to verify names are correct
  const sample = Object.keys(stats).slice(0,3);
  console.log('Batter sample:', sample);
  return stats;
}

function buildPitcherStats(pitcherRows) {
  const stats = {};
  for (const row of pitcherRows) {
    const name = getName(row);
    if (!name) continue;
    
    // Validate: xERA should be a reasonable ERA value (0.5 - 9.0)
    // whiff% should be a percentage (10 - 50)
    const xeraRaw   = getNum(row,'xera','x_era');
    const whiffRaw  = getNum(row,'whiff_percent','whiff%');
    // Try every known column name for HR/9
    let hr9Raw = getNum(row,'p_hr_per9','hr_per9','hr9','home_runs_per_9');
    
    // If not found, compute from home_run count and IP
    if (hr9Raw === null) {
      const hrs = getNum(row,'home_run','p_home_run','hr','home_runs');
      const ip  = getNum(row,'p_formatted_ip','ip','innings_pitched');
      if (hrs !== null && ip !== null && ip > 0) {
        hr9Raw = +(hrs * 9 / ip).toFixed(2);
      }
    }

    // Sanity check — if xERA looks like a whiff% value, they're swapped
    const xera  = (xeraRaw  !== null && xeraRaw  > 0  && xeraRaw  < 12)  ? xeraRaw  : 4.50;
    const whiff = (whiffRaw !== null && whiffRaw > 0  && whiffRaw < 60)  ? whiffRaw : 22;
    const hr9   = (hr9Raw   !== null && hr9Raw   > 0  && hr9Raw   < 5)   ? hr9Raw   : 1.2;
    
    // K% and K/9 for strikeout prop model
    const k_pctRaw = getNum(row,'strikeout_percent','p_k_percent','k_percent');
    const k_pct = (k_pctRaw !== null && k_pctRaw > 0 && k_pctRaw < 80) ? k_pctRaw : null;

    stats[name] = {
      xera:    +xera.toFixed(2),
      whiff:   +whiff.toFixed(1),
      hr9:     +hr9.toFixed(2),
      hh_pct:  getNum(row,'hard_hit_percent') ?? 38,
      brl_pct: getNum(row,'barrel_batted_rate') ?? 8,
      k_pct:   k_pct !== null ? +k_pct.toFixed(1) : null,
      gb_pct:  null, // populated from batted ball fetch
      fb_pct:  null,
    };
  }
  console.log(`buildPitcherStats: ${Object.keys(stats).length} pitchers`);
  // Log first pitcher row keys to verify column names
  if (pitcherRows.length > 0) {
    const keys = Object.keys(pitcherRows[0]);
    const hrKeys = keys.filter(k => k.includes('hr') || k.includes('home'));
    console.log('Pitcher HR-related columns:', hrKeys);
    console.log('First pitcher sample:', Object.entries(pitcherRows[0]).filter(([k])=>hrKeys.includes(k)));
  }
  const sample = Object.keys(stats).slice(0,3);
  console.log('Pitcher sample:', sample, '| xERA samples:', sample.map(n => stats[n].xera));
  return stats;
}

async function fetchAllStatcast(year = 2026) {
  try {
    const [batterRows, expectedRows, pitcherRows, batterBBRows, pitcherBBRows] = await Promise.all([
      fetchBatterStatcast(year).catch(e => { console.warn('Batter CSV failed:', e.message); return []; }),
      fetchBatterExpected(year).catch(e => { console.warn('Expected CSV failed:', e.message); return []; }),
      fetchPitcherStatcast(year).catch(e => { console.warn('Pitcher CSV failed:', e.message); return []; }),
      fetchBatterBattedBall(year).catch(e => { console.warn('Batter BB failed:', e.message); return []; }),
      fetchPitcherBattedBall(year).catch(e => { console.warn('Pitcher BB failed:', e.message); return []; }),
    ]);

    console.log(`Raw rows: ${batterRows.length} batters ev, ${expectedRows.length} batters exp, ${pitcherRows.length} pitchers, ${batterBBRows.length} batter BB, ${pitcherBBRows.length} pitcher BB`);

    const batters  = buildBatterStats(batterRows, expectedRows);
    const pitchers = buildPitcherStats(pitcherRows);

    // Merge batted ball data into batters
    for (const row of batterBBRows) {
      const name = getName(row);
      if (!name || !batters[name]) continue;
      batters[name].pull_pct      = getNum(row,'pull_percent','flap_percent') ?? null;
      batters[name].fb_pct        = getNum(row,'flyballs_percent','flyball_percent') ?? null;
      batters[name].gb_pct        = getNum(row,'groundballs_percent','groundball_percent') ?? null;
      // Also try picking up sweet spot from batted ball endpoint
      if (!batters[name].sweet_spot_pct)
        batters[name].sweet_spot_pct = getNum(row,'sweet_spot_percent') ?? null;
    }

    // Merge batted ball data into pitchers
    for (const row of pitcherBBRows) {
      const name = getName(row);
      if (!name || !pitchers[name]) continue;
      pitchers[name].gb_pct = getNum(row,'groundballs_percent','groundball_percent') ?? null;
      pitchers[name].fb_pct = getNum(row,'flyballs_percent','flyball_percent') ?? null;
    }

    const batterWithBB  = Object.values(batters).filter(b => b.pull_pct !== null).length;
    const pitcherWithBB = Object.values(pitchers).filter(p => p.gb_pct !== null).length;
    console.log(`Built: ${Object.keys(batters).length} batters (${batterWithBB} with pull%), ${Object.keys(pitchers).length} pitchers (${pitcherWithBB} with gb%)`);

    return { batters, pitchers, timestamp: new Date().toISOString(), source: 'baseballsavant.mlb.com', year };
  } catch (err) {
    console.error('Statcast failed:', err.message, err.stack);
    return { batters: {}, pitchers: {}, timestamp: new Date().toISOString(), error: err.message };
  }
}

module.exports = { fetchAllStatcast };
