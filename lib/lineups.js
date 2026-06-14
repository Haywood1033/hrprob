// lib/lineups.js — CommonJS
// Fetches lineups from MLB Stats API boxscore (completed/in-progress games)
// and from the schedule hydrate for upcoming games

const TEAM_MAP = {
  108:'Angels',109:'Diamondbacks',110:'Orioles',111:'Red Sox',112:'Cubs',
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
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${dateStr}&endDate=${dateStr}&hydrate=probablePitcher,team,venue`,
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
      venue: (() => {
        const venueId   = g.venue?.id;
        const venueInfo = VENUE_COORDS[venueId] || {};
        return {
          id:     venueId,
          name:   g.venue?.name,
          lat:    venueInfo.lat,
          lon:    venueInfo.lon,
          city:   venueInfo.city,
          roof:   venueInfo.roof || null,
          f:      venueInfo.f    || null,
          elev:   venueInfo.elev != null ? venueInfo.elev : null,
          orient: venueInfo.orient != null ? venueInfo.orient : null,
        };
      })(),
    })).filter(g => g.awayTeam && g.homeTeam);
  } catch (err) {
    console.warn('Probable pitchers failed:', err.message);
    return null;
  }
}

// MLB Venue ID → coordinates + park factor + elevation
// IDs verified from live MLB Stats API — includes f (park factor) and elev for accurate modeling
const VENUE_COORDS = {
  31:   { lat:40.447, lon:-80.006,  city:'Pittsburgh',      roof:'open',        f:0.97, elev:730,  orient:110 }, // PNC Park
  2:    { lat:39.284, lon:-76.621,  city:'Baltimore',       roof:'open',        f:1.04, elev:20,   orient:115 }, // Camden Yards
  3309: { lat:38.873, lon:-77.007,  city:'Washington',      roof:'open',        f:1.01, elev:0,    orient:130 }, // Nationals Park
  14:   { lat:43.641, lon:-79.389,  city:'Toronto',         roof:'retractable', f:0.97, elev:173,  orient:10  }, // Rogers Centre
  2602: { lat:39.097, lon:-84.507,  city:'Cincinnati',      roof:'open',        f:1.07, elev:490,  orient:150 }, // Great American Ball Park
  3289: { lat:40.757, lon:-73.845,  city:'Queens',          roof:'open',        f:0.92, elev:20,   orient:175 }, // Citi Field
  7:    { lat:39.051, lon:-94.481,  city:'Kansas City',     roof:'open',        f:0.99, elev:750,  orient:5   }, // Kauffman Stadium
  3312: { lat:44.982, lon:-93.278,  city:'Minneapolis',     roof:'open',        f:0.97, elev:830,  orient:30  }, // Target Field
  4:    { lat:41.830, lon:-87.634,  city:'Chicago',         roof:'open',        f:1.04, elev:595,  orient:135 }, // Rate Field (White Sox)
  32:   { lat:43.028, lon:-87.971,  city:'Milwaukee',       roof:'retractable', f:1.02, elev:635,  orient:200 }, // American Family Field
  5355: { lat:36.193, lon:-115.138, city:'Las Vegas',       roof:'open',        f:1.12, elev:2001, orient:170 }, // Las Vegas Ballpark ⚡
  10:   { lat:38.580, lon:-121.503, city:'West Sacramento', roof:'open',        f:1.02, elev:25,   orient:50  }, // Sutter Health Park
  2395: { lat:37.779, lon:-122.389, city:'San Francisco',   roof:'open',        f:0.93, elev:10,   orient:100 }, // Oracle Park
  1:    { lat:33.800, lon:-117.883, city:'Anaheim',         roof:'open',        f:1.00, elev:160,  orient:230 }, // Angel Stadium
  3:    { lat:42.347, lon:-71.097,  city:'Boston',          roof:'open',        f:0.96, elev:20,   orient:70  }, // Fenway Park
  5:    { lat:41.496, lon:-81.685,  city:'Cleveland',       roof:'open',        f:0.97, elev:653,  orient:70  }, // Progressive Field
  15:   { lat:39.756, lon:-104.994, city:'Denver',          roof:'open',        f:1.38, elev:5280, orient:185 }, // Coors Field
  19:   { lat:39.756, lon:-104.994, city:'Denver',          roof:'open',        f:1.38, elev:5280, orient:185 }, // Coors alt
  17:   { lat:41.948, lon:-87.655,  city:'Chicago',         roof:'open',        f:1.05, elev:595,  orient:10  }, // Wrigley Field
  22:   { lat:34.074, lon:-118.240, city:'Los Angeles',     roof:'open',        f:0.95, elev:515,  orient:45  }, // Dodger Stadium
  2394: { lat:39.097, lon:-84.507,  city:'Cincinnati',      roof:'open',        f:1.07, elev:490,  orient:150 }, // GABP alt
  2392: { lat:29.757, lon:-95.355,  city:'Houston',         roof:'retractable', f:0.97, elev:22,   orient:0   }, // Minute Maid Park
  2680: { lat:32.707, lon:-117.157, city:'San Diego',       roof:'open',        f:0.94, elev:20,   orient:270 }, // Petco Park
  2681: { lat:39.906, lon:-75.167,  city:'Philadelphia',    roof:'open',        f:1.06, elev:20,   orient:215 }, // Citizens Bank Park
  2889: { lat:38.623, lon:-90.193,  city:'St. Louis',       roof:'open',        f:0.99, elev:465,  orient:210 }, // Busch Stadium
  3313: { lat:40.829, lon:-73.926,  city:'Bronx',           roof:'open',        f:1.08, elev:55,   orient:200 }, // Yankee Stadium
  4169: { lat:25.778, lon:-80.220,  city:'Miami',           roof:'retractable', f:0.92, elev:6,    orient:0   }, // loanDepot Park
  4321: { lat:41.830, lon:-87.634,  city:'Chicago',         roof:'open',        f:1.04, elev:595,  orient:135 }, // Rate Field alt
  4705: { lat:33.735, lon:-84.389,  city:'Cumberland',      roof:'open',        f:1.03, elev:1050, orient:30  }, // Truist Park
  680:  { lat:47.591, lon:-122.332, city:'Seattle',         roof:'retractable', f:0.96, elev:0,    orient:0   }, // T-Mobile Park
  2500: { lat:32.751, lon:-97.082,  city:'Arlington',       roof:'retractable', f:1.05, elev:551,  orient:0   }, // Globe Life Field
  12:   { lat:27.768, lon:-82.653,  city:'St. Petersburg',  roof:'dome',        f:0.95, elev:15,   orient:0   }, // Tropicana Field
};


// Deprecated stub
async function fetchRotoWireLineups() { return null; }

module.exports = { fetchMLBLineups, fetchRotoWireLineups, fetchProbablePitchers };
