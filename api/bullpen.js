// api/bullpen.js — fetches team bullpen stats for current season
// Called once per day from slate, cached for 6 hours

const { query } = require('../lib/db.js');

const TEAM_IDS = {
  'Angels':108,'Diamondbacks':109,'Orioles':110,'Red Sox':111,'Cubs':112,
  'Reds':113,'Guardians':114,'Rockies':115,'Tigers':116,'Astros':117,
  'Royals':118,'Dodgers':119,'Nationals':120,'Mets':121,'Athletics':133,
  'Pirates':134,'Padres':135,'Mariners':136,'Giants':137,'Cardinals':138,
  'Rays':139,'Rangers':140,'Blue Jays':141,'Twins':142,'Phillies':143,
  'Braves':144,'White Sox':145,'Marlins':146,'Yankees':147,'Brewers':158,
};

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 6 * 3600 * 1000; // 6 hours

async function fetchBullpenStats() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  const season = new Date().getFullYear();
  const results = {};

  // Fetch all teams in parallel — bullpen stats from MLB Stats API
  await Promise.allSettled(
    Object.entries(TEAM_IDS).map(async ([teamName, teamId]) => {
      try {
        // Fetch relief pitcher stats for this team
        const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=pitching&season=${season}&playerPool=All`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return;
        const data = await r.json();

        // Filter to relievers only (pitchers with 0 GS or low GS ratio)
        const splits = data?.stats?.[0]?.splits || [];
        const relievers = splits.filter(s => {
          const g  = s.stat?.gamesPlayed || 0;
          const gs = s.stat?.gamesStarted || 0;
          return g > 0 && gs / g < 0.3; // <30% starts = reliever
        });

        if (!relievers.length) return;

        // Aggregate bullpen stats
        const totIP  = relievers.reduce((s,r) => s + parseFloat(r.stat?.inningsPitched||0), 0);
        const totER  = relievers.reduce((s,r) => s + (r.stat?.earnedRuns||0), 0);
        const totHR  = relievers.reduce((s,r) => s + (r.stat?.homeRuns||0), 0);
        const totBB  = relievers.reduce((s,r) => s + (r.stat?.baseOnBalls||0), 0);
        const totK   = relievers.reduce((s,r) => s + (r.stat?.strikeOuts||0), 0);
        const totH   = relievers.reduce((s,r) => s + (r.stat?.hits||0), 0);

        if (totIP < 10) return;

        const era  = +((totER / totIP) * 9).toFixed(2);
        const hr9  = +((totHR / totIP) * 9).toFixed(2);
        const whip = +(( totBB + totH) / totIP).toFixed(2);
        const k9   = +((totK / totIP) * 9).toFixed(1);

        results[teamName] = { era, hr9, whip, k9, ip: +totIP.toFixed(1), relievers: relievers.length };
      } catch(e) {
        // Skip on error
      }
    })
  );

  console.log(`Bullpen stats fetched: ${Object.keys(results).length} teams`);
  _cache = results;
  _cacheTime = Date.now();
  return results;
}

module.exports = async function handler(req, res) {
  try {
    const data = await fetchBullpenStats();
    res.setHeader('Cache-Control', 'public, s-maxage=21600');
    return res.status(200).json({ ok: true, bullpen: data, count: Object.keys(data).length });
  } catch(e) {
    console.error('Bullpen API error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
