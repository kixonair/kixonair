
// Kixonair hotfix server — ESPN UA + retry + SportsDB fallback
// Endpoints:
//   GET /api/fixtures[/(today|tomorrow)]?date=YYYY-MM-DD
//   GET /__/probe[/(today|tomorrow)]?date=YYYY-MM-DD
//   POST/GET /admin/flush-cache?all=true&token=...
//   POST/GET /admin/precache[/(today|tomorrow)]?token=...
//   GET /health

import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 10000;

// --- CORS (restrict to your domains) ---
const allow = (process.env.ALLOW_ORIGINS || 'https://kixonair.com,https://www.kixonair.com')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function(origin, cb){
    if(!origin) return cb(null, true);
    if (allow.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));

app.use(express.json());
app.use(express.static('public', { maxAge: '1h', etag: true }));

// --- In-memory caches ---
const cache = new Map(); // key: date -> { ts, data }
const logoCache = new Map(); // teamName -> {ts, url}
const TTL = 1000 * 60 * 10; // 10 min API cache

// --- Helpers ---
const fmtDate = (d) => {
  if (d === 'today') return new Date().toISOString().slice(0,10);
  if (d === 'tomorrow'){
    const t = new Date(); t.setUTCDate(t.getUTCDate()+1);
    return t.toISOString().slice(0,10);
  }
  return (d || new Date().toISOString().slice(0,10)).slice(0,10);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, {tries=3, timeout=12000, headers={}} = {}){
  let lastErr;
  for (let i=0;i<tries;i++){
    const ctl = new AbortController();
    const t = setTimeout(()=>ctl.abort(), timeout);
    try{
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://www.espn.com/',
          ...headers
        },
        signal: ctl.signal
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(e){
      lastErr = e;
      clearTimeout(t);
      await sleep(300 + i*400);
    }
  }
  throw lastErr;
}

function norm(s=''){ return s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function isoLocalToUTC(dateStr){
  // Ensure date-only is treated as UTC midnight for stable day grouping
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr+'T00:00:00Z';
  return dateStr;
}

// --- Sources ---
async function espnSoccer(date){
  const yyyymmdd = date.replace(/-/g,'');
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/scoreboard?dates=${yyyymmdd}`;
  const j = await fetchJSON(url);
  const events = j?.events || [];
  const major = new Set([
    'UEFA Champions League','UEFA Europa League','UEFA Europa Conference League',
    'English Premier League','Spanish LaLiga','German Bundesliga','Italian Serie A','French Ligue 1',
    'EFL Championship'
  ]);
  const out = [];
  for (const ev of events){
    const c = ev.competitions?.[0];
    if (!c) continue;
    const comps = c.competitors || [];
    const home = comps.find(x => x.homeAway==='home') || comps[0] || {};
    const away = comps.find(x => x.homeAway==='away') || comps[1] || {};
    const leagueName = (ev.leagues?.[0]?.name) || '';
    // If it's a UEFA/Top league OR if "All Leagues" later will include everything
    if (leagueName && !major.has(leagueName) && !/UEFA|Premier|LaLiga|Bundesliga|Serie A|Ligue 1|Champions/i.test(leagueName)) {
      // keep, but you may filter; we include all and let UI filter
    }
    const state = ev.status?.type?.state || c.status?.type?.state || 'pre';
    const status = state.toUpperCase(); // IN, PRE, POST
    out.push({
      sport: 'Soccer',
      league: { name: leagueName, code: ev.leagues?.[0]?.abbreviation || '' },
      start_utc: ev.date || c.date || isoLocalToUTC(date),
      status: (status==='IN'?'LIVE': status==='POST'?'Finished':'Scheduled'),
      home: { name: home.team?.shortDisplayName || home.team?.name || home.displayName || '', logo: home.team?.logo },
      away: { name: away.team?.shortDisplayName || away.team?.name || away.displayName || '', logo: away.team?.logo },
      _source: 'espn_soccer'
    });
  }
  return out;
}

async function sportsdbSoccer(date){
  const key = process.env.SPORTSDB_KEY || '3';
  const url = `https://www.thesportsdb.com/api/v1/json/${key}/eventsday.php?d=${date}&s=Soccer`;
  const j = await fetchJSON(url, { headers: { 'Origin':'https://kixonair.com' }, tries: 2 });
  const arr = j?.events || [];
  const out = [];
  for (const ev of arr){
    const comp = ev.strLeague || ev.strLeague2 || '';
    const start = ev.strTimestamp || (ev.dateEvent && ev.strTime ? `${ev.dateEvent}T${ev.strTime}:00Z` : isoLocalToUTC(date));
    out.push({
      sport: 'Soccer',
      league: { name: comp, code: '' },
      start_utc: start,
      status: 'Scheduled',
      home: { name: ev.strHomeTeam || '', logo: '' },
      away: { name: ev.strAwayTeam || '', logo: '' },
      _source: 'sportsdb_soccer'
    });
  }
  return out;
}

// Enrich team logos via TheSportsDB search
async function teamLogo(name){
  const k = norm(name);
  if (logoCache.has(k) && (Date.now() - logoCache.get(k).ts) < 12*60*60*1000) {
    return logoCache.get(k).url;
  }
  const key = process.env.SPORTSDB_KEY || '3';
  const url = `https://www.thesportsdb.com/api/v1/json/${key}/searchteams.php?t=${encodeURIComponent(name)}`;
  try{
    const j = await fetchJSON(url, { tries: 2 });
    const team = j?.teams?.[0];
    const urlBadge = team?.strTeamBadge || team?.strTeamLogo;
    if (urlBadge){
      logoCache.set(k, {ts: Date.now(), url: urlBadge});
      return urlBadge;
    }
  }catch{}
  return '';
}

// Merge & de-dupe
function mergeFixtures(list){
  const byKey = new Map();
  for (const fx of list){
    const key = `${norm(fx.home.name)}|${norm(fx.away.name)}|${fx.start_utc.slice(0,10)}`;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, fx);
    else {
      // Prefer ESPN over fallback for league/status/logos
      const prefer = fx._source === 'espn_soccer' ? fx : prev;
      const other  = fx._source === 'espn_soccer' ? prev : fx;
      prefer.league = prefer.league?.name ? prefer.league : other.league;
      prefer.status = (prefer.status && prefer.status!=='Scheduled') ? prefer.status : other.status;
      if (!prefer.home.logo) prefer.home.logo = other.home.logo;
      if (!prefer.away.logo) prefer.away.logo = other.away.logo;
      byKey.set(key, prefer);
    }
  }
  return Array.from(byKey.values());
}

// Build fixtures for a date
async function buildFixtures(date){
  const d = fmtDate(date);
  const cacheHit = cache.get(d);
  if (cacheHit && (Date.now() - cacheHit.ts) < TTL) return cacheHit.data;

  let fixtures = [], counts = { espn_soccer:0, sportsdb_soccer:0 };
  // ESPN first with UA+retry
  try{
    const e = await espnSoccer(d);
    fixtures = fixtures.concat(e);
    counts.espn_soccer = e.length;
  }catch(e){ /* ignore */ }

  // SportsDB fallback (soccer)
  try{
    const s = await sportsdbSoccer(d);
    fixtures = fixtures.concat(s);
    counts.sportsdb_soccer = s.length;
  }catch(e){ /* ignore */ }

  // Merge
  fixtures = mergeFixtures(fixtures);

  // Logo enrichment (best-effort, non-blocking)
  await Promise.all(fixtures.map(async fx => {
    if (!fx.home.logo) fx.home.logo = await teamLogo(fx.home.name);
    if (!fx.away.logo) fx.away.logo = await teamLogo(fx.away.name);
  }));

  const data = { meta: { date: d, sourceCounts: counts }, fixtures };
  cache.set(d, { ts: Date.now(), data });
  return data;
}

// --- Routes ---
app.get('/api/fixtures', async (req, res) => {
  try{
    const d = fmtDate(req.query.date || req.params.date);
    const data = await buildFixtures(d);
    res.set('Cache-Control','no-store');
    res.json(data);
  }catch(e){
    res.status(500).json({ error: String(e?.message || e) });
  }
});
app.get('/api/fixtures/today', (req,res)=> res.redirect(302, '/api/fixtures?date='+fmtDate('today')));
app.get('/api/fixtures/tomorrow', (req,res)=> res.redirect(302, '/api/fixtures?date='+fmtDate('tomorrow')));

// Probe (debug)
app.get('/__/probe', async (req,res)=>{
  const d = fmtDate(req.query.date || 'today');
  const out = { date:d };
  try{
    const e = await espnSoccer(d);
    out.espn_soccer = { ok:true, status:200 };
    out.espn_events = e.length;
  }catch(e){
    out.espn_soccer = { ok:false, note:String(e?.message||e) };
  }
  try{
    const s = await sportsdbSoccer(d);
    out.sdb_soccer = { ok:true, status:200 };
    out.sdb_events = s.length;
  }catch(e){
    out.sdb_soccer = { ok:false, note:String(e?.message||e) };
  }
  res.json(out);
});
app.get('/__/probe/today', (req,res)=> res.redirect(302, '/__/probe?date='+fmtDate('today')));

// Admin (token guard)
function isAuthed(req){
  const token = req.query.token || req.headers['x-admin-token'];
  return token && token === (process.env.ADMIN_TOKEN || 'mysecret123');
}
app.all('/admin/flush-cache', (req,res)=>{
  if (!isAuthed(req)) return res.status(403).json({ok:false});
  const all = req.query.all === 'true';
  if (all) cache.clear();
  res.json({ ok:true, cleared: all ? 'all' : 'none' });
});
app.all('/admin/precache', async (req,res)=>{
  if (!isAuthed(req)) return res.status(403).json({ok:false});
  const d = fmtDate(req.query.date || 'today');
  const data = await buildFixtures(d);
  res.json({ ok:true, date:d, counts: data.meta.sourceCounts, size: data.fixtures.length });
});
app.all('/admin/precache/today', (req,res)=>{
  if (!isAuthed(req)) return res.status(403).json({ok:false});
  res.redirect(302, '/admin/precache?date='+fmtDate('today')+'&token='+(req.query.token||''));
});
app.all('/admin/precache/tomorrow', (req,res)=>{
  if (!isAuthed(req)) return res.status(403).json({ok:false});
  res.redirect(302, '/admin/precache?date='+fmtDate('tomorrow')+'&token='+(req.query.token||''));
});

// Health
app.get('/health', (_req, res)=> res.type('text/plain').send('ok'));

app.listen(PORT, ()=>{
  console.log('Kixonair hotfix server running on :' + PORT);
});
