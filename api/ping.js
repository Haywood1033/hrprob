// api/ping.js - zero dependency test endpoint
module.exports = function handler(req, res) {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const today = new Date(etStr).toLocaleDateString('en-CA');
  res.status(200).json({ 
    ok: true, 
    date: today,
    utc: new Date().toISOString(),
    message: 'Vercel API is working'
  });
};
