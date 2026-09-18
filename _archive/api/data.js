// api/data.js — legacy compatibility endpoint
// Calls both slate and statcast, combines for backwards compatibility
const slateHandler   = require('./slate.js');
const statcastHandler = require('./statcast.js');

module.exports = async function handler(req, res) {
  // Run both in parallel
  const [slateRes, statcastRes] = await Promise.allSettled([
    new Promise(resolve => {
      const mock = { status: () => mock, json: d => resolve(d), setHeader: () => {} };
      slateHandler({ ...req, method: 'GET' }, mock);
    }),
    new Promise(resolve => {
      const mock = { status: () => mock, json: d => resolve(d), setHeader: () => {} };
      statcastHandler({ ...req, method: 'GET' }, mock);
    }),
  ]);

  const slate    = slateRes.value    || {};
  const statcast = statcastRes.value || {};

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  return res.status(200).json({
    date:         slate.date,
    pitchers:     slate.pitchers     || [],
    lineups:      slate.lineups      || {},
    lineupSource: slate.lineupSource || 'none',
    weather:      slate.weather      || {},
    statcast:     statcast.batters   ? statcast : null,
    timestamp:    Date.now(),
    elapsed:      Math.max(slate.elapsed||0, statcast.elapsed||0),
  });
};
