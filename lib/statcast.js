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
    `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=batter&filter=&sort=4&sortDir=desc&min=20&selections=xba,xslg,xwoba,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,hr,pa&csv=true`
  );
  return parseCSV(text);
}

async function fetchBatterExpected(year) {
  const text = await fetchCSV(
    `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&min=20&csv=true`
  );
  return parseCSV(text);
}

async function fetchPitcherStatcast(year) {
  const text = await fetchCSV(
    `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&filter=&sort=4&sortDir=asc&min=20&selections=xera,whiff_percent,p_hr_per9,barrel_batted_rate,hard_hit_percent,exit_velocity_avg,p_home_run,pa&csv=true`
  );
  return parseCSV(text);
}

function buildBatterStats(batterRows, expectedRows) {
  const stats = {};
  // Build expected stats lookup by player_id
  const expById = {};
  for (const row of expectedRows) {
    const pid = row['player_id'] || row['mlbam_id'];
    if (pid) expById[pid] = {
      xba:   getNum(row,'xba','est_ba'),
      xslg:  getNum(row,'xslg','est_slg'),
      xwoba: getNum(row,'xwoba','est_woba'),
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
      ev:  getNum(row,'exit_velocity_avg','avg_hit_speed') ?? 88,
      ba:  getNum(row,'barrel_batted_rate','brl_percent')  ?? 8,
      hh:  getNum(row,'hard_hit_percent')                  ?? 38,
      xw:  +xwoba.toFixed(3),
      iso: +(xslg - xba).toFixed(3),
      hr:  parseInt(row['hr'] || '0'),
      pa:  parseInt(row['pa'] || '0'),
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
    const hr9Raw    = getNum(row,'p_hr_per9','hr_per9','home_run','hr/9','hr9','home_runs_per_9');
    
    // Sanity check — if xERA looks like a whiff% value, they're swapped
    const xera  = (xeraRaw  !== null && xeraRaw  > 0  && xeraRaw  < 12)  ? xeraRaw  : 4.50;
    const whiff = (whiffRaw !== null && whiffRaw > 0  && whiffRaw < 60)  ? whiffRaw : 22;
    const hr9   = (hr9Raw   !== null && hr9Raw   > 0  && hr9Raw   < 5)   ? hr9Raw   : 1.2;
    
    stats[name] = {
      xera:    +xera.toFixed(2),
      whiff:   +whiff.toFixed(1),
      hr9:     +hr9.toFixed(2),
      hh_pct:  getNum(row,'hard_hit_percent') ?? 38,
      brl_pct: getNum(row,'barrel_batted_rate') ?? 8,
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
    const [batterRows, expectedRows, pitcherRows] = await Promise.all([
      fetchBatterStatcast(year),
      fetchBatterExpected(year),
      fetchPitcherStatcast(year),
    ]);
    
    console.log(`Raw rows: ${batterRows.length} batters, ${pitcherRows.length} pitchers`);
  if (pitcherRows.length > 0) {
    console.log('ALL pitcher columns:', Object.keys(pitcherRows[0]).join(', '));
    console.log('First pitcher data:', JSON.stringify(pitcherRows[0]));
  }
    
    // Log first row headers to debug column mapping
    if (pitcherRows.length > 0) {
      console.log('Pitcher row keys:', Object.keys(pitcherRows[0]).slice(0,10));
      console.log('Pitcher row sample:', JSON.stringify(pitcherRows[0]).substring(0,200));
    }
    
    const batters  = buildBatterStats(batterRows, expectedRows);
    const pitchers = buildPitcherStats(pitcherRows);
    
    return { batters, pitchers, timestamp: new Date().toISOString(), source: 'baseballsavant.mlb.com', year };
  } catch (err) {
    console.error('Statcast failed:', err.message);
    return null;
  }
}

module.exports = { fetchAllStatcast };
