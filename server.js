import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import nf from 'node-fetch';
if (typeof globalThis.fetch !== 'function') { globalThis.fetch = nf; }

const {
  PUBLIC_HOST = 'http://localhost:3000',
  CPAGRIP_LOCKER_URL = 'https://rileymarker.com/sportlo',
  LOCKER_RETURN_PARAM = 'r',
  FD_KEY = '',
  BDL_KEY = '',
  TSD_KEY = '3',
  APISPORTS_KEY = '',
  APISPORTS_HOST = 'v3.football.api-sports.io',
  TZ_PARAM = 'Europe/Bucharest'
} = process.env;

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

/* tiny cache */
const cache = new Map();
const put = (k, v, ttl = 60_000) => cache.set(k, { v, exp: Date.now() + ttl });
const get = (k) => { const h = cache.get(k); return h && h.exp > Date.now() ? h.v : null; };

/* helpers for de-dupe across providers */
function norm(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function fxKey(fx){
  const h = norm(fx.home?.name), a = norm(fx.away?.name);
  const t = new Date(fx.start_utc).toISOString().slice(0,16); // minute precision
  return `${h}|${a}|${t}`;
}
function dedupe(fixtures){
  const map = new Map();
  for (const f of fixtures){
    const k = fxKey(f);
    if (!map.has(k)) map.set(k, f);
  }
  return [...map.values()];
}

/* -------- Providers ---------- */
async function getSoccerApiSports(date){
  if (!APISPORTS_KEY) return [];
  const key = `apisoc:${date}`; const hit = get(key); if (hit) return hit;
  const url = `https://${APISPORTS_HOST}/fixtures?date=${date}&timezone=${encodeURIComponent(TZ_PARAM)}`;
  const r = await fetch(url, { headers: { 'x-apisports-key': APISPORTS_KEY } });
  if (!r.ok) throw new Error(`apisports ${r.status}`);
  const j = await r.json();
  const items = (j.response || []).map(g => ({
    provider: 'apisports', id: `api_${g.fixture?.id}`,
    sport:'Soccer',
    start_utc: g.fixture?.date,
    status: g.fixture?.status?.long || g.fixture?.status?.short || 'SCHEDULED',
    league: { name: g.league?.name },
    home: { name: g.teams?.home?.name },
    away: { name: g.teams?.away?.name },
    score: { home: g.goals?.home ?? null, away: g.goals?.away ?? null }
  }));
  put(key, items, 90_000); return items;
}

async function getSoccer(date) {
  const key = `soccer:${date}`; const hit = get(key); if (hit) return hit;
  const out = [];
  // 1) API-FOOTBALL (broad coverage incl. UCL)
  try { out.push(...await getSoccerApiSports(date)); } catch(e){ /* ignore */ }
  // 2) Football-Data (top European comps incl. CL code 'CL')
  try {
    const url = `https://api.football-data.org/v4/matches?dateFrom=${date}&dateTo=${date}`;
    const r = await fetch(url, { headers: { 'X-Auth-Token': FD_KEY } });
    if (r.ok) {
      const j = await r.json();
      out.push(...(j.matches || []).map(m => ({
        provider: 'fd', id: `fd_${m.id}`, sport: 'Soccer',
        start_utc: m.utcDate, status: m.status,
        league: { name: m.competition?.name, code: m.competition?.code },
        home: { name: m.homeTeam?.name }, away: { name: m.awayTeam?.name },
        score: m.score?.fullTime || { home: null, away: null }
      })));
    }
  } catch(e){ /* ignore */ }
  // 3) TheSportsDB fallback
  try {
    const url2 = `https://www.thesportsdb.com/api/v1/json/${TSD_KEY}/eventsday.php?d=${date}&s=Soccer`;
    const r2 = await fetch(url2);
    if (r2.ok) {
      const j2 = await r2.json();
      out.push(...(j2.events || []).map(e => ({
        provider: 'tsd_soc', id: `tsdsoc_${e.idEvent}`, sport: 'Soccer',
        start_utc: new Date(`${e.dateEvent}T${(e.strTime || '00:00:00')}Z`).toISOString(),
        status: 'SCHEDULED',
        league: { name: e.strLeague },
        home: { name: e.strHomeTeam }, away: { name: e.strAwayTeam },
        score: { home: null, away: null }
      })));
    }
  } catch(e){ /* ignore */ }
  const deduped = dedupe(out).sort((a,b) => new Date(a.start_utc) - new Date(b.start_utc));
  put(key, deduped, 90_000); return deduped;
}

async function getNBA(date) {
  const key = `nba:${date}`; const hit = get(key); if (hit) return hit;
  try {
    const url = `https://api.balldontlie.io/v1/games?dates[]=${date}&per_page=100`;
    const headers = BDL_KEY ? { Authorization: BDL_KEY } : {};
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`balldontlie ${r.status}`);
    const j = await r.json();
    const items = (j.data || []).map(g => ({
      provider: 'bdl_nba', id: `nba_${g.id}`, sport: 'NBA',
      start_utc: g.date, status: g.status || 'SCHEDULED',
      league: { name: 'NBA' },
      home: { name: g.home_team?.full_name || g.home_team?.name },
      away: { name: g.visitor_team?.full_name || g.visitor_team?.name },
      score: { home: g.home_team_score, away: g.visitor_team_score }
    }));
    if (items.length) { put(key, items, 90_000); return items; }
  } catch {}
  const url2 = `https://www.thesportsdb.com/api/v1/json/${TSD_KEY}/eventsday.php?d=${date}&s=Basketball`;
  const r2 = await fetch(url2);
  if (!r2.ok) throw new Error(`thesportsdb-basketball ${r2.status}`);
  const j2 = await r2.json();
  const items2 = (j2.events || [])
    .filter(e => (e.strLeague || '').toUpperCase() === 'NBA')
    .map(e => ({
      provider: 'tsd_nba', id: `tsdnba_${e.idEvent}`, sport: 'NBA',
      start_utc: new Date(`${e.dateEvent}T${(e.strTime || '00:00:00')}Z`).toISOString(),
      status: 'SCHEDULED',
      league: { name: e.strLeague },
      home: { name: e.strHomeTeam }, away: { name: e.strAwayTeam },
      score: { home: null, away: null }
    }));
  put(key, items2, 90_000); return items2;
}

async function getNFL(date) {
  const key = `nfl:${date}`; const hit = get(key); if (hit) return hit;
  const url = `https://www.thesportsdb.com/api/v1/json/${TSD_KEY}/eventsday.php?d=${date}&s=American%20Football`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`thesportsdb ${r.status}`);
  const j = await r.json();
  const items = (j.events || [])
    .filter(e => (e.strLeague || '').toUpperCase().includes('NFL'))
    .map(e => ({
      provider: 'tsd_nfl', id: `nfl_${e.idEvent}`, sport: 'NFL',
      start_utc: new Date(`${e.dateEvent}T${(e.strTime || '00:00:00')}Z`).toISOString(),
      status: 'SCHEDULED',
      league: { name: e.strLeague },
      home: { name: e.strHomeTeam }, away: { name: e.strAwayTeam },
      score: { home: null, away: null }
    }));
  put(key, items, 90_000); return items;
}

/* ---- API ---- */
app.get('/api/fixtures', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const errors = {};
  let soccer=[], nba=[], nfl=[];
  try { soccer = await getSoccer(date); } catch(e){ errors.soccer = String(e.message||e); }
  try { nba = await getNBA(date); } catch(e){ errors.nba = String(e.message||e); }
  try { nfl = await getNFL(date); } catch(e){ errors.nfl = String(e.message||e); }
  const fixtures = [...soccer, ...nba, ...nfl].sort((a,b)=> new Date(a.start_utc) - new Date(b.start_utc));
  res.json({ date, fixtures, counts: { soccer: soccer.length, nba: nba.length, nfl: nfl.length }, errors });
});

app.get('/api/fixture/:id', async (req, res) => {
  const [type, raw] = String(req.params.id).split('_');
  try {
    if (type === 'fd') {
      const r = await fetch(`https://api.football-data.org/v4/matches/${raw}`, { headers: { 'X-Auth-Token': FD_KEY } });
      const m = await r.json(); const mm = m.match || m;
      return res.json({ fixture: mm ? {
        provider:'fd', id:`fd_${mm.id}`, sport:'Soccer',
        start_utc:mm.utcDate, status:mm.status,
        league:{ name:mm.competition?.name },
        home:{ name:mm.homeTeam?.name }, away:{ name:mm.awayTeam?.name },
        score:mm.score?.fullTime || {home:null,away:null}
      } : null});
    }
    if (type === 'tsdsoc') {
      const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${TSD_KEY}/lookupevent.php?id=${raw}`);
      const e = (await r.json())?.events?.[0];
      return res.json({ fixture: e ? {
        provider:'tsd_soc', id:`tsdsoc_${e.idEvent}`, sport:'Soccer',
        start_utc:new Date(`${e.dateEvent}T${(e.strTime||'00:00:00')}Z`).toISOString(),
        status:'SCHEDULED', league:{ name:e.strLeague },
        home:{ name:e.strHomeTeam }, away:{ name:e.strAwayTeam },
        score:{ home:null, away:null }
      } : null});
    }
    if (type === 'api') {
      const r = await fetch(`https://${APISPORTS_HOST}/fixtures?id=${raw}`, { headers: { 'x-apisports-key': APISPORTS_KEY } });
      const e = (await r.json())?.response?.[0];
      return res.json({ fixture: e ? {
        provider:'apisports', id:`api_${e.fixture?.id}`, sport:'Soccer',
        start_utc:e.fixture?.date, status:e.fixture?.status?.long || 'SCHEDULED',
        league:{ name:e.league?.name },
        home:{ name:e.teams?.home?.name }, away:{ name:e.teams?.away?.name },
        score:{ home:e.goals?.home ?? null, away:e.goals?.away ?? null }
      } : null});
    }
    if (type === 'nba' || type === 'tsdnba') {
      if (type === 'nba') {
        const r = await fetch(`https://api.balldontlie.io/v1/games/${raw}`, { headers: BDL_KEY ? { Authorization: BDL_KEY } : {} });
        const g = (await r.json())?.data;
        return res.json({ fixture: g ? {
          provider:'bdl_nba', id:`nba_${g.id}`, sport:'NBA',
          start_utc:g.date, status:g.status || 'SCHEDULED',
          league:{ name:'NBA' },
          home:{ name:g.home_team?.full_name }, away:{ name:g.visitor_team?.full_name },
          score:{ home:g.home_team_score, away:g.visitor_team_score }
        } : null});
      } else {
        const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${TSD_KEY}/lookupevent.php?id=${raw}`);
        const e = (await r.json())?.events?.[0];
        return res.json({ fixture: e ? {
          provider:'tsd_nba', id:`tsdnba_${e.idEvent}`, sport:'NBA',
          start_utc:new Date(`${e.dateEvent}T${(e.strTime||'00:00:00')}Z`).toISOString(),
          status:'SCHEDULED', league:{ name:e.strLeague },
          home:{ name:e.strHomeTeam }, away:{ name:e.strAwayTeam },
          score:{ home:null, away:null }
        } : null});
      }
    }
    if (type === 'nfl') {
      const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${TSD_KEY}/lookupevent.php?id=${raw}`);
      const e = (await r.json())?.events?.[0];
      return res.json({ fixture: e ? {
        provider:'tsd_nfl', id:`nfl_${e.idEvent}`, sport:'NFL',
        start_utc:new Date(`${e.dateEvent}T${(e.strTime||'00:00:00')}Z`).toISOString(),
        status:'SCHEDULED', league:{ name:e.strLeague },
        home:{ name:e.strHomeTeam }, away:{ name:e.strAwayTeam },
        score:{ home:null, away:null }
      } : null});
    }
    res.status(404).json({ error:'Unknown id' });
  } catch (e) { res.status(500).json({ error:String(e.message||e) }); }
});

/* Locker redirect */
app.get('/go/:id', (req, res) => {
  const id = req.params.id;
  const slug = (req.query.slug || 'match').toString();
  const returnUrl = `${PUBLIC_HOST}/watch/${encodeURIComponent(slug)}?id=${encodeURIComponent(id)}`;
  const sep = CPAGRIP_LOCKER_URL.includes('?') ? '&' : '?';
  const lockerUrl = `${CPAGRIP_LOCKER_URL}${sep}${LOCKER_RETURN_PARAM}=${encodeURIComponent(returnUrl)}`;
  res.redirect(lockerUrl);
});

/* Health */
app.get('/health', (req, res) => res.json({ ok:true, node:process.version }));

app.get('/watch/:slug', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'watch.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ Kixonair v10 (with API-FOOTBALL) on :' + PORT));
