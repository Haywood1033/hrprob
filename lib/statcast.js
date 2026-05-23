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
  return parseCSV(await r.text());
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g,'').toLowerCase());
  return lines.slice(1).map(line => {
    const vals = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h,i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  }).filter(r => r['last_name, first_name'] || r['player_name'] || r['last_name']);
}

function getName(row) {
  if (row['last_name, first_name']) {
    const p = row['last_name, first_name'].split(',').map(s => s.trim());
    if (p.length === 2) return `${p[1]} ${p[0]}`;
  }
  if (row['player_name']) return row['player_name'];
  if (row['last_name'] && row['first_name']) return `${row['first_name']} ${row['last_name']}`;
  return null;
}

function getNum(row, ...keys) {
  for (const k of keys) { const v = parseFloat(row[k]); if (!isNaN(v)) return v; }
  return null;
}

async function fetchBatterStatcast(year) {
  return fetchCSV(`https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=batter&filter=&sort=4&sortDir=desc&min=20&selections=xba,xslg,xwoba,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,hr,pa&csv=true`);
}

async function fetchBatterExpected(year) {
  return fetchCSV(`https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&min=20&csv=true`);
}

async function fetchPitcherStatcast(year) {
  return fetchCSV(`https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&filter=&sort=4&sortDir=asc&min=20&selections=xera,whiff_percent,p_hr_per9,barrel_batted_rate,hard_hit_percent,exit_velocity_avg,pa&csv=true`);
}

async function fetchPitcherArsenal(year) {
  return fetchCSV(`https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&pitchType=&year=${year}&team=&min=50&csv=true`);
}

function buildBatterStats(batterRows, expectedRows) {
  const stats = {};
  const expById = {};
  for (const row of expectedRows) {
    const pid = row['player_id'] || row['mlbam_id'];
    if (pid) expById[pid] = { xba: getNum(row,'xba','est_ba'), xslg: getNum(row,'xslg','est_slg'), xwoba: getNum(row,'xwoba','est_woba') };
  }
  for (const row of batterRows) {
    const name = getName(row); if (!name) continue;
    const pid = row['player_id'] || row['mlbam_id'];
    const exp = expById[pid] || {};
    const xwoba = getNum(row,'xwoba','est_woba') || exp.xwoba || 0.310;
    const xba   = getNum(row,'xba','est_ba')     || exp.xba   || 0.240;
    const xslg  = getNum(row,'xslg','est_slg')   || exp.xslg  || 0.390;
    const iso   = xslg - xba;
    stats[name] = {
      ev: getNum(row,'exit_velocity_avg','avg_hit_speed') || 88,
      ba: getNum(row,'barrel_batted_rate','brl_percent')  || 8,
      hh: getNum(row,'hard_hit_percent','hard_hit%')      || 38,
      xw: +xwoba.toFixed(3), iso: +iso.toFixed(3),
      hr: parseInt(row['hr']||0), pa: parseInt(row['pa']||0),
    };
  }
  return stats;
}

function buildPitcherStats(pitcherRows, arsenalRows) {
  const arsenalByPlayer = {};
  for (const row of arsenalRows) {
    const pid = row['player_id'] || row['mlbam_id']; if (!pid) continue;
    if (!arsenalByPlayer[pid]) arsenalByPlayer[pid] = [];
    arsenalByPlayer[pid].push({
      type:  row['pitch_name'] || row['pitch_type'] || 'FB',
      usage: getNum(row,'pitch_percent','usage_pct') || 0,
      whiff: getNum(row,'whiff_percent','whiff_pct') || 0,
      velo:  getNum(row,'velocity','release_speed')  || 0,
    });
  }
  const stats = {};
  for (const row of pitcherRows) {
    const name = getName(row); if (!name) continue;
    const pid = row['player_id'] || row['mlbam_id'];
    const hr9 = getNum(row,'p_hr_per9','hr_per9','hr/9','hr9') || 1.2;
    const arsenal = (arsenalByPlayer[pid] || []).sort((a,b) => b.usage-a.usage).slice(0,5).filter(p => p.usage > 0 || p.whiff > 0);
    stats[name] = {
      xera:    getNum(row,'xera','x_era') || 4.50,
      whiff:   getNum(row,'whiff_percent','whiff%') || 22,
      hr9:     +hr9.toFixed(2),
      brl_pct: getNum(row,'barrel_batted_rate') || 8,
      hh_pct:  getNum(row,'hard_hit_percent')   || 38,
      era:     getNum(row,'era','ERA') || 4.50,
      arsenal,
    };
  }
  return stats;
}

async function fetchAllStatcast(year = 2026) {
  try {
    const [batterRows, expectedRows, pitcherRows, arsenalRows] = await Promise.all([
      fetchBatterStatcast(year), fetchBatterExpected(year),
      fetchPitcherStatcast(year), fetchPitcherArsenal(year),
    ]);
    const batters  = buildBatterStats(batterRows, expectedRows);
    const pitchers = buildPitcherStats(pitcherRows, arsenalRows);
    console.log(`Statcast: ${Object.keys(batters).length} batters, ${Object.keys(pitchers).length} pitchers`);
    return { batters, pitchers, timestamp: new Date().toISOString(), source: 'baseballsavant.mlb.com', year };
  } catch (err) {
    console.error('Statcast failed:', err.message);
    return null;
  }
}

module.exports = { fetchAllStatcast };
