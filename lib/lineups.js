// lib/lineups.js — CommonJS
// Fetches lineups from MLB Stats API boxscore (completed/in-progress games)
// and from the schedule hydrate for upcoming games

const TEAM_MAP = {
  108:'Angels',109:'Athletics',110:'Orioles',111:'Red Sox',112:'Cubs',
  113:'Reds',114:'Guardians',115:'Rockies',116:'Tigers',117:'Astros',
  118:'Royals',119:'Dodgers',120:'Nationals',121:'Mets',133:'Athletics',
  134:'Pirates',135:'Padres',136:'Mariners',137:'Giants',138:'Cardinals',
  139:'Rays',140:'Rangers',141:'Blue Jays',142:'Twins',143:'Phillies',
  144:'Braves',145:'White Sox',146:'Marlins',147:'Yankees',158:'Brewers',
};

const HAND_MAP = { R:'R', L:'L', S:'S', '':'R' };

// Fetch lineups for all games on a given date using MLB Stats API
// Works for: completed games (box score), in-progress games (live feed), upcoming (schedule)
async function fetchMLBLineups(dateStr) {
  try {
    // Step 1: get all games for the date
    const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${dateStr}&endDate=${dateStr}&hydrate=lineups,team`;
    const r = await fetch(schedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`Schedule HTTP ${r.status}`);
    const data = await r.json();
    const games = data?.dates?.[0]?.games || [];
    if (!games.length) return null;

    const lineups = {};

    // Step 2: for each game try to get lineup from hydrated schedule
    // then fall back to boxscore for completed games
    await Promise.allSettled(games.map(async g => {
      const gamePk = g.gamePk;
      const awayId = g.teams?.away?.team?.id;
      const homeId = g.teams?.home?.team?.id;
      const awayName = TEAM_MAP[awayId] || g.teams?.away?.team?.name;
      const homeName = TEAM_MAP[homeId] || g.teams?.home?.team?.name;
      const status = g.status?.abstractGameState; // 'Preview', 'Live', 'Final'

      // Try lineups from hydrated schedule first
      if (g.lineups?.homePlayers?.length >= 8) {
        lineups[homeName] = g.lineups.homePlayers.map((p, i) => ({
          name:         p.fullName,
          battingOrder: p.battingOrder || (i + 1),
          position:     p.primaryPosition?.abbreviation || '?',
          batSide:      HAND_MAP[p.batSide?.code] || 'R',
          source:       'live',
        }));
      }
      if (g.lineups?.awayPlayers?.length >= 8) {
        lineups[awayName] = g.lineups.awayPlayers.map((p, i) => ({
          name:         p.fullName,
          battingOrder: p.battingOrder || (i + 1),
          position:     p.primaryPosition?.abbreviation || '?',
          batSide:      HAND_MAP[p.batSide?.code] || 'R',
          source:       'live',
        }));
      }

      // For completed/live games, get from boxscore (has batting order)
      if ((status === 'Final' || status === 'Live') &&
          (!lineups[homeName] || !lineups[awayName])) {
        try {
          const br = await fetch(
            `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' }
          );
          if (br.ok) {
            const box = await br.json();
            for (const [side, teamName] of [['away', awayName], ['home', homeName]]) {
              if (lineups[teamName]) continue; // already have it
              const players = box.teams?.[side]?.players || {};
              const batters = Object.values(players)
                .filter(p => p.battingOrder && p.battingOrder > 0 && p.battingOrder < 1000)
                .sort((a, b) => a.battingOrder - b.battingOrder)
                .filter((p, i, arr) => i === 0 || Math.floor(p.battingOrder/100) !== Math.floor(arr[i-1].battingOrder/100))
                .map(p => ({
                  name:         p.person?.fullName || '',
                  battingOrder: Math.ceil(p.battingOrder / 100),
                  position:     p.position?.abbreviation || '?',
                  batSide:      HAND_MAP[p.person?.batSide?.code] || 'R',
                  source:       'live',
                }))
                .filter(p => p.name);
              if (batters.length >= 8) lineups[teamName] = batters;
            }
          }
        } catch(e) {
          console.warn(`Boxscore ${gamePk}:`, e.message);
        }
      }
    }));

    const found = Object.keys(lineups).length;
    console.log(`MLB lineups: ${found} teams from ${games.length} games`);
    return found > 0 ? lineups : null;
  } catch (err) {
    console.warn('MLB lineup fetch failed:', err.message);
    return null;
  }
}

async function fetchProbablePitchers(dateStr) {
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${dateStr}&endDate=${dateStr}&hydrate=probablePitcher,team`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
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

// Keep for backwards compat but deprecated
async function fetchRotoWireLineups() { return null; }

module.exports = { fetchMLBLineups, fetchRotoWireLineups, fetchProbablePitchers };
