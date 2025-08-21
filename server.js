import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- Config ---
const SPORTSDB_KEY = process.env.SPORTSDB_KEY || '3';
const FD_KEY = process.env.FD_KEY || ''; // optional; not required with ESPN-first
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || 'https://kixonair.com,https://www.kixonair.com')
  .split(',').map(s=>s.trim()).filter(Boolean);
const NODE_ENV = process.env.NODE_ENV || 'production';

// CORS
app.use(cors({
  origin(origin, cb){
    if (!origin) return cb(null, true);
    const allowLocal = NODE_ENV !== 'production' && /^http:\/\/localhost(?::\d+)?$/.test(origin);
    if (ALLOW_ORIGINS.includes(origin) || allowLocal) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  }
}));

app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));

app.get('/health', (_, res) => res.type('text/plain').send('ok'));

// ---------- Helpers ----------
const logoCache = new Map();
const yyyymmdd = (d) => d.replace(/-/g, '');
const statusFromEspn = (ev) => {
  const s = ev?.competitions?.[0]?.status?.type?.state || '';
  if (s === 'in') return 'LIVE';
  if (s === 'post') return 'FINISHED';
  return 'SCHEDULED';
};
const takeLogo = (team) => team?.logo || team?.logos?.[0]?.href || null;

function fixtureOf({ sport, leagueName, leagueCode, startISO, status, home, away }){
  return {
    sport,
    league: { name: leagueName || '', code: leagueCode || null },
    start_utc: startISO,
    status: status || 'SCHEDULED',
    home: { name: home?.name || '', logo: home?.logo || null },
    away: { name: away?.name || '', logo: away?.logo || null }
  };
}
function norm(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
function keyForFixture(fx){
  const t = fx.start_utc ? new Date(fx.start_utc) : new Date();
  const hourBucket = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours())).toISOString();
  return `${fx.sport}:${norm(fx.home.name)}-vs-${norm(fx.away.name)}@${hourBucket}`;
}
function choosePreferred(a, b){
  const aScore = (a.league?.code ? 2 : 0) + (a.league?.name ? 1 : 0);
  const bScore = (b.league?.code ? 2 : 0) + (b.league?.name ? 1 : 0);
  return aScore >= bScore ? a : b;
}
async function badgeFromSportsDB(name){
  if (!name) return null;
  const key = name.toLowerCase();
  if (logoCache.has(key)) return logoCache.get(key);
  try{
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchteams.php?t=${encodeURIComponent(name)}`);
    const j = await r.json();
    const t = j?.teams?.[0];
    const url = t?.strTeamBadge || t?.strTeamLogo || null;
    logoCache.set(key, url || null);
    return url || null;
  }catch{ logoCache.set(key, null); return null; }
}
async function enrich(fixtures){
  const names = [...new Set(fixtures.flatMap(fx => [fx.home?.name, fx.away?.name].filter(Boolean)))];
  for (let i=0;i<names.length;i+=10){
    await Promise.all(names.slice(i,i+10).map(n => badgeFromSportsDB(n)));
  }
  for (const fx of fixtures){
    if (!fx.home.logo) fx.home.logo = logoCache.get((fx.home.name||'').toLowerCase()) || null;
    if (!fx.away.logo) fx.away.logo = logoCache.get((fx.away.name||'').toLowerCase()) || null;
  }
  return fixtures;
}


// ---------- TheSportsDB UEFA helpers ----------
const sdbLeagueIdCache = new Map(); // name -> idLeague
async function sdbFindLeagueIdByName(name){
  if (!name) return null;
  if (sdbLeagueIdCache.has(name)) return sdbLeagueIdCache.get(name);
  try{
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchleagues.php?l=${encodeURIComponent(name)}`;
    const r = await fetch(url, { timeout: 15000 });
    const j = await r.json();
    const id = j?.countries?.[0]?.idLeague || j?.leagues?.[0]?.idLeague || null;
    sdbLeagueIdCache.set(name, id || null);
    return id || null;
  }catch{ sdbLeagueIdCache.set(name, null); return null; }
}
function sdbSeasonFor(dateStr){
  const d = new Date(dateStr + 'T00:00:00Z');
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (m >= 7) return `${y}-${y+1}`;
  return `${y-1}-${y}`;
}
async function fetchSportsDbUefa(dateStr){
  const leagues = [
    'UEFA Champions League',
    'UEFA Europa League',
    'UEFA Europa Conference League'
  ];
  const season = sdbSeasonFor(dateStr);
  const out = [];
  for (const name of leagues){
    const id = await sdbFindLeagueIdByName(name);
    if (!id) continue;
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(season)}`;
    try{
      const r = await fetch(url, { timeout: 20000 });
      const j = await r.json();
      const evs = j?.events || j?.event || [];
      for (const ev of evs){
        if ((ev?.dateEvent || '').trim() !== dateStr) continue;
        const ts = ev?.strTimestamp ? new Date(parseInt(ev.strTimestamp, 10) * 1000).toISOString()
                                    : new Date(`${ev?.dateEvent}T${(ev?.strTime||'00:00')}:00Z`).toISOString();
        out.push({
          sport: 'Soccer',
          league: { name, code: null },
          start_utc: ts,
          status: (ev?.strStatus||'').includes('FT') ? 'FINISHED' : 'SCHEDULED',
          home: { name: ev?.strHomeTeam || '' },
          away: { name: ev?.strAwayTeam || '' }
        });
      }
      // polite delay
      await new Promise(r => setTimeout(r, 120));
    }catch{ /* ignore per league */ }
  }
  return out;
}

// ---------- ESPN providers (no key) ----------
// League slugs for ESPN soccer (UCL/UEL/UECL + Top 5)
const ESPN_SOCCER_LEAGUES = [
  'soccer/uefa.champions',      // UEFA Champions League
  'soccer/uefa.europa',         // UEFA Europa League
  'soccer/uefa.europa.conf',    // UEFA Europa Conference League
  'soccer/eng.1',               // Premier League
  'soccer/esp.1',               // LaLiga
  'soccer/ger.1',               // Bundesliga
  'soccer/ita.1',               // Serie A
  'soccer/fra.1'                // Ligue 1
];

async function espnLeagueScoreboard(leagueSlug, dateStr){
  const url = `https://site.api.espn.com/apis/v2/sports/${leagueSlug}/scoreboard?dates=${yyyymmdd(dateStr)}`;
  const r = await fetch(url, { timeout: 15000 });
  if (!r.ok) return { events: [], _status: r.status, _url: url };
  const j = await r.json();
  j._status = r.status;
  j._url = url;
  return j;
}

async function espnScoreboard(path, dateStr){
  const url = `https://site.api.espn.com/apis/v2/sports/${path}/scoreboard?dates=${yyyymmdd(dateStr)}`;
  const r = await fetch(url, { timeout: 15000 });
  if (!r.ok) return { events: [] };
  return await r.json();
}

async function fetchEspnNBA(dateStr){
  try{
    const j = await espnScoreboard('basketball/nba', dateStr);
    const leagueName = 'NBA';
    const events = j?.events || [];
    return events.map(ev => {
      const comp = ev?.competitions?.[0];
      const home = (comp?.competitors || []).find(c => c?.homeAway === 'home') || {};
      const away = (comp?.competitors || []).find(c => c?.homeAway === 'away') || {};
      return fixtureOf({
        sport: 'NBA',
        leagueName,
        leagueCode: 'NBA',
        startISO: ev?.date || new Date().toISOString(),
        status: statusFromEspn(ev),
        home: { name: home?.team?.displayName || home?.team?.name, logo: takeLogo(home?.team) },
        away: { name: away?.team?.displayName || away?.team?.name, logo: takeLogo(away?.team) }
      });
    });
  }catch{ return []; }
}

async function fetchEspnNFL(dateStr){
  try{
    const j = await espnScoreboard('football/nfl', dateStr);
    const leagueName = 'NFL';
    const events = j?.events || [];
    return events.map(ev => {
      const comp = ev?.competitions?.[0];
      const home = (comp?.competitors || []).find(c => c?.homeAway === 'home') || {};
      const away = (comp?.competitors || []).find(c => c?.homeAway === 'away') || {};
      return fixtureOf({
        sport: 'NFL',
        leagueName,
        leagueCode: 'NFL',
        startISO: ev?.date || new Date().toISOString(),
        status: statusFromEspn(ev),
        home: { name: home?.team?.displayName || home?.team?.name, logo: takeLogo(home?.team) },
        away: { name: away?.team?.displayName || away?.team?.name, logo: takeLogo(away?.team) }
      });
    });
  }catch{ return []; }
}


async function fetchEspnSoccer(dateStr){
  const out = [];
  const debug = { base: null, perLeague: [] };
  try{
    // Base "all soccer" board
    const base = await espnScoreboard('soccer', dateStr);
    const baseEvents = base?.events || [];
    debug.base = { count: baseEvents.length };
    for (const ev of baseEvents){
      const comp = ev?.competitions?.[0];
      const home = (comp?.competitors || []).find(c => c?.homeAway === 'home') || {};
      const away = (comp?.competitors || []).find(c => c?.homeAway === 'away') || {};
      const leagueName = ev?.league?.name || ev?.name || 'Football';
      out.push(fixtureOf({
        sport: 'Soccer',
        leagueName,
        leagueCode: null,
        startISO: ev?.date || new Date().toISOString(),
        status: statusFromEspn(ev),
        home: { name: home?.team?.displayName || home?.team?.name, logo: takeLogo(home?.team) },
        away: { name: away?.team?.displayName || away?.team?.name, logo: takeLogo(away?.team) }
      }));
    }
    // Per-league boards for UCL/UEL/UECL + Top 5
    const boards = await Promise.all(ESPN_SOCCER_LEAGUES.map(slug => espnLeagueScoreboard(slug, dateStr)));
    for (let i=0;i<boards.length;i++){
      const b = boards[i];
      const events = b?.events || [];
      debug.perLeague.push({ slug: ESPN_SOCCER_LEAGUES[i], count: events.length, status: b?._status || 0 });
      for (const ev of events){
        const comp = ev?.competitions?.[0];
        const home = (comp?.competitors || []).find(c => c?.homeAway === 'home') || {};
        const away = (comp?.competitors || []).find(c => c?.homeAway === 'away') || {};
        const leagueName = ev?.league?.name || ev?.name || 'Football';
        out.push(fixtureOf({
          sport: 'Soccer',
          leagueName,
          leagueCode: null,
          startISO: ev?.date || new Date().toISOString(),
          status: statusFromEspn(ev),
          home: { name: home?.team?.displayName || home?.team?.name, logo: takeLogo(home?.team) },
          away: { name: away?.team?.displayName || away?.team?.name, logo: takeLogo(away?.team) }
        }));
      }
    }
  }catch{ /* ignore */ }
  // Attach debug for /api?debug=1 via global sidecar
  globalThis.__ESPN_SOCCER_DEBUG__ = debug;
  return out;
}
      });
    });
  }catch{ return []; }
}

// ---------- Fallbacks (TheSportsDB, Football-Data) ----------
async function sdbDay(dateStr, sportQuery, tag){
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${dateStr}&s=${encodeURIComponent(sportQuery)}`;
  try{
    const r = await fetch(url, { timeout: 15000 });
    const j = await r.json();
    const events = j?.events || [];
    return events.map(ev => ({
      sport: tag,
      league: { name: ev?.strLeague || '', code: null },
      start_utc: ev?.strTimestamp ? new Date(parseInt(ev.strTimestamp,10)*1000).toISOString() : new Date(`${ev?.dateEvent}T${(ev?.strTime||'00:00')}:00Z`).toISOString(),
      status: (ev?.strStatus||'').includes('FT') ? 'FINISHED' : 'SCHEDULED',
      home: { name: ev?.strHomeTeam || '' },
      away: { name: ev?.strAwayTeam || '' }
    }));
  }catch{ return []; }
}

async function fdDay(dateStr){
  if (!FD_KEY) return [];
  const url = `https://api.football-data.org/v4/matches?dateFrom=${dateStr}&dateTo=${dateStr}`;
  try{
    const r = await fetch(url, { headers: { 'X-Auth-Token': FD_KEY } , timeout: 15000 });
    if (!r.ok) return [];
    const j = await r.json();
    const matches = j?.matches || [];
    return matches.map(m => ({
      sport: 'Soccer',
      league: { name: m?.competition?.name || '', code: m?.competition?.code || null },
      start_utc: m?.utcDate || new Date().toISOString(),
      status: m?.status || 'SCHEDULED',
      home: { name: m?.homeTeam?.name || '' },
      away: { name: m?.awayTeam?.name || '' }
    }));
  }catch{ return []; }
}

// ---------- Merge ----------
function mergeDedup(list){
  const map = new Map();
  for (const fx of list){
    const key = keyForFixture(fx);
    if (!map.has(key)) map.set(key, fx);
    else map.set(key, choosePreferred(map.get(key), fx));
  }
  return Array.from(map.values());
}

// ---------- API ----------
app.get('/api/fixtures', async (req, res) => {
  const dateStr = (req.query.date || '').toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
  }

  // ESPN-first (no keys), then fallbacks
  const [espnSoccer, espnNba, espnNfl] = await Promise.all([
    fetchEspnSoccer(dateStr),
    fetchEspnNBA(dateStr),
    fetchEspnNFL(dateStr)
  ]);

  // Fallbacks
  const [sdbSoccer, fdSoccer, sdbNba, sdbNfl] = await Promise.all([
    sdbDay(dateStr, 'Soccer', 'Soccer'),
    fdDay(dateStr),
    sdbDay(dateStr, 'Basketball', 'NBA'), // may include non-NBA; UI can filter
    sdbDay(dateStr, 'American Football', 'NFL')
  ]);

  const sourceCounts = {
    espn_soccer: espnSoccer.length,
    espn_nba: espnNba.length,
    espn_nfl: espnNfl.length,
    sportsdb_soccer: sdbSoccer.length,
    football_data: fdSoccer.length,
    sportsdb_nba: sdbNba.length,
    sportsdb_nfl: sdbNfl.length
  };

  let merged = mergeDedup([
    ...espnSoccer, ...espnNba, ...espnNfl,
    ...fdSoccer, ...sdbSoccer, ...sdbNba, ...sdbNfl
  ]);
  merged = await enrich(merged);

  const debugFlag = String(req.query.debug||'0')==='1';
  const extra = debugFlag ? { espn_soccer_debug: globalThis.__ESPN_SOCCER_DEBUG__ || null } : {};
  res.json({ meta: { date: dateStr, sourceCounts, ...extra }, fixtures: merged });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('kixonair listening on :' + PORT));
