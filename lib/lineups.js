// lib/lineups.js — CommonJS
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

const TEAM_ABBR = {
  'CLE':'Guardians','DET':'Tigers','PIT':'Pirates','STL':'Cardinals',
  'NYM':'Mets','WSH':'Nationals','ATL':'Braves','MIA':'Marlins',
  'TOR':'Blue Jays','NYY':'Yankees','ATH':'Athletics','OAK':'Athletics',
  'LAA':'Angels','COL':'Rockies','ARI':'Diamondbacks','SFG':'Giants',
  'SF':'Giants','LAD':'Dodgers','SD':'Padres','SEA':'Mariners',
  'HOU':'Astros','KC':'Royals','BOS':'Red Sox','MIN':'Twins',
  'TEX':'Rangers','TB':'Rays','BAL':'Orioles','CWS':'White Sox',
  'MIL':'Brewers','CHC':'Cubs','CIN':'Reds','PHI':'Phillies',
};

async function fetchMLBLineups(dateStr) {
  try {
    const r = await fetch(`https://www.mlb.com/starting-lineups/${dateStr}`, { headers: HEADERS, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseMLBLineupHTML(await r.text());
  } catch (err) {
    console.warn('MLB.com lineup fetch failed:', err.message);
    return null;
  }
}

function parseMLBLineupHTML(html) {
  const lineups = {};
  const FULL = {
    'Guardians':'Guardians','Tigers':'Tigers','Pirates':'Pirates','Cardinals':'Cardinals',
    'Mets':'Mets','Nationals':'Nationals','Braves':'Braves','Marlins':'Marlins',
    'Blue Jays':'Blue Jays','Yankees':'Yankees','Athletics':'Athletics','Angels':'Angels',
    'Rockies':'Rockies','Diamondbacks':'Diamondbacks','Giants':'Giants','Dodgers':'Dodgers',
    'Padres':'Padres','Mariners':'Mariners','Astros':'Astros','Royals':'Royals',
    'Red Sox':'Red Sox','Twins':'Twins','Rangers':'Rangers','Rays':'Rays',
    'Orioles':'Orioles','White Sox':'White Sox','Brewers':'Brewers','Cubs':'Cubs',
    'Reds':'Reds','Phillies':'Phillies',
  };
  let currentTeam = null;
  for (const line of html.split('\n')) {
    const abbr = line.match(/^([A-Z]{2,3})\s+Lineup/);
    const full = line.match(/^([A-Za-z ]+)\s+Lineup$/);
    if (abbr) { currentTeam = TEAM_ABBR[abbr[1]] || null; if (currentTeam && !lineups[currentTeam]) lineups[currentTeam] = []; }
    else if (full) { currentTeam = FULL[full[1].trim()] || null; if (currentTeam && !lineups[currentTeam]) lineups[currentTeam] = []; }
    if (!currentTeam) continue;
    const m = line.match(/^(\d+)\.\s+\[([^\]]+)\]\([^)]+\)\s+\(([RLS])\)\s+([A-Z0-9/]+)/);
    if (m) lineups[currentTeam].push({ name: m[2].trim(), battingOrder: parseInt(m[1]), position: m[4].trim(), batSide: m[3], source: 'live' });
  }
  const confirmed = {};
  for (const [team, players] of Object.entries(lineups)) {
    if (players.length >= 8) confirmed[team] = players.sort((a,b) => a.battingOrder - b.battingOrder);
  }
  return Object.keys(confirmed).length > 0 ? confirmed : null;
}

async function fetchRotoWireLineups() {
  try {
    const r = await fetch('https://www.rotowire.com/baseball/daily-lineups.php', { headers: HEADERS, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseRotoWireHTML(await r.text());
  } catch (err) {
    console.warn('RotoWire failed:', err.message);
    return null;
  }
}

function parseRotoWireHTML(html) {
  const lineups = {};
  const lines = html.split('\n');
  let currentTeam = null, orderNum = 0;
  for (const line of lines) {
    const teamMatch = line.match(/data-team="([A-Z]{2,3})"/);
    if (teamMatch) { currentTeam = TEAM_ABBR[teamMatch[1]]; orderNum = 0; if (currentTeam && !lineups[currentTeam]) lineups[currentTeam] = []; continue; }
    if (!currentTeam) continue;
    const playerMatch = line.match(/class="[^"]*lineup__player[^"]*">.*?<a[^>]*>([^<]+)<\/a>.*?<span[^>]*>([A-Z]+)<\/span>.*?\(([RLS])\)/);
    if (playerMatch) { orderNum++; lineups[currentTeam].push({ name: playerMatch[1].trim(), battingOrder: orderNum, position: playerMatch[2], batSide: playerMatch[3], source: 'live' }); }
  }
  const confirmed = {};
  for (const [team, players] of Object.entries(lineups)) { if (players.length >= 8) confirmed[team] = players; }
  return Object.keys(confirmed).length > 0 ? confirmed : null;
}

async function fetchProbablePitchers(dateStr) {
  const TEAM_MAP = {
    108:'Angels',109:'Athletics',110:'Orioles',111:'Red Sox',112:'Cubs',
    113:'Reds',114:'Guardians',115:'Rockies',116:'Tigers',117:'Astros',
    118:'Royals',119:'Dodgers',120:'Nationals',121:'Mets',133:'Athletics',
    134:'Pirates',135:'Padres',136:'Mariners',137:'Giants',138:'Cardinals',
    139:'Rays',140:'Rangers',141:'Blue Jays',142:'Twins',143:'Phillies',
    144:'Braves',145:'White Sox',146:'Marlins',147:'Yankees',158:'Brewers',
  };
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team`, {
      headers: { 'User-Agent': HEADERS['User-Agent'] }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const games = data?.dates?.[0]?.games || [];
    if (!games.length) return null;
    return games.map(g => ({
      gamePk:        g.gamePk,
      gameTime:      g.gameDate,
      awayTeam:      TEAM_MAP[g.teams?.away?.team?.id] || g.teams?.away?.team?.name,
      homeTeam:      TEAM_MAP[g.teams?.home?.team?.id] || g.teams?.home?.team?.name,
      awayPitcher:   g.teams?.away?.probablePitcher?.fullName || 'TBD',
      homePitcher:   g.teams?.home?.probablePitcher?.fullName || 'TBD',
      awayPitcherId: g.teams?.away?.probablePitcher?.id,
      homePitcherId: g.teams?.home?.probablePitcher?.id,
      status:        g.status?.detailedState,
    })).filter(g => g.awayTeam && g.homeTeam);
  } catch (err) {
    console.warn('Probable pitchers failed:', err.message);
    return null;
  }
}

module.exports = { fetchMLBLineups, fetchRotoWireLineups, fetchProbablePitchers };
