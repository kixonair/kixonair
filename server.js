import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---- ENV
const SPORTSDB_KEY = process.env.SPORTSDB_KEY || '3';
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || 'https://kixonair.com,https://www.kixonair.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const NODE_ENV = process.env.NODE_ENV || 'production';

// ---- CORS
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const allowLocal = NODE_ENV !== 'production' && /^http:\/\/localhost(?::\d+)?$/.test(origin);
    if (ALLOW_ORIGINS.includes(origin) || allowLocal) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  }
}));

// ---- STATIC + HEALTH + VERSION
app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));
app.get('/health', (_, res) => res.type('text/plain').send('ok'));
app.get('/__/version', (_, res) => res.json({ build: 'espn+sdb+manual', ts: new Date().toISOString() }));

// ---- Helpers
const logoCache = new Map();
const yyyymmdd = d => d.replace(/-/g, '');
const statusFromEspn = ev => {
  const s = ev?.competitions?.[0]?.status?.type?.state || '';
  if (s === 'in') return 'LIVE';
  if (s === 'post') return 'FINISHED';
  return 'SCHEDULED';
};
const takeLogo = t => t?.logo || t?.logos?.[0]?.href || null;
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function fixtureOf({ sport, leagueName, leagueCode, startISO, status, home, away }) {
  return {
    sport,
    league: { name: leagueName || '', code: leagueCode || null },
    start_utc: startISO,
    status: status || 'SCHEDULED',
    home: { name: home?.name || '', logo: home?.logo || null },
    away: { name: away?.name || '', logo: away?.logo || null }
  };
}
function keyForFixture(fx) {
  const t = fx.start_utc ? new Date(fx.start_utc) : new Date();
  const hourBucket = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours())).toISOString();
  return `${fx.sport}:${norm(fx.home.name)}-vs-${norm(fx.away.name)}@${hourBucket}`;
}
function choosePreferred(a, b) {
  const aScore = (a.league?.code ? 2 : 0) + (a.league?.name ? 1 : 0);
  const bScore = (b.league?.code ? 2 : 0) + (b.league?.name ? 1 : 0);
  return aScore >= bScore ? a : b;
}

async function badgeFromSportsDB(name) {
  if (!name) return null;
  const k = name.toLowerCase();
  if (logoCache.has(k)) return logoCache.get(k);
  try {
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchteams.php?t=${encodeURIComponent(name)}`);
    const j = await r.json();
    const t = j?.teams?.[0];
    const url = t?.strTeamBadge || t?.strTeamLogo || null;
    logoCache.set(k, url || null);
    return url || null;
  } catch { logoCache.set(k, null); return null; }
}
async function enrich(fixtures) {
  const names = [...new Set(fixtures.flatMap(f => [f.home?.name, f.away?.name].filter(Boolean)))];
  for (let i=0; i<names.length; i+=10) await Promise.all(names.slice(i,i+10).map(n => badgeFromSportsDB(n)));
  for (const f of fixtures) {
    if (!f.home.logo) f.home.logo = logoCache.get((f.home.name||'').toLowerCase()) || null;
    if (!f.away.logo) f.away.logo = logoCache.get((f.away.name||'').toLowerCase()) || null;
  }
  return fixtures;
}

// ---- ESPN (no key)
async function espnScoreboard(pathSeg, dateStr) {
  const url = `https://site.api.espn.com/apis/v2/sports/${pathSeg}/scoreboard?dates=${yyyymmdd(dateStr)}`;
  const r = await fetch(url, { timeout: 15000 }); if (!r.ok) return { events: [] };
  return r.json();
}
async function fetchEspnNBA(d){ try {
  const j = await espnScoreboard('basketball/nba', d);
  return (j?.events||[]).map(ev => {
    const c = ev?.competitions?.[0];
    const home = (c?.competitors||[]).find(x => x.homeAway==='home')||{};
    const away = (c?.competitors||[]).find(x => x.homeAway==='away')||{};
    return fixtureOf({ sport:'NBA', leagueName:'NBA', leagueCode:'NBA', startISO: ev?.date,
      status: statusFromEspn(ev),
      home:{ name: home?.team?.displayName||home?.team?.name, logo: takeLogo(home?.team) },
      away:{ name: away?.team?.displayName||away?.team?.name, logo: takeLogo(away?.team) }
    });
  });
} catch { return []; } }
async function fetchEspnNFL(d){ try {
  const j = await espnScoreboard('football/nfl', d);
  return (j?.events||[]).map(ev => {
    const c = ev?.competitions?.[0];
    const home = (c?.competitors||[]).find(x => x.homeAway==='home')||{};
    const away = (c?.competitors||[]).find(x => x.homeAway==='away')||{};
    return fixtureOf({ sport:'NFL', leagueName:'NFL', leagueCode:'NFL', startISO: ev?.date,
      status: statusFromEspn(ev),
      home:{ name: home?.team?.displayName||home?.team?.name, logo: takeLogo(home?.team) },
      away:{ name: away?.team?.displayName||away?.team?.name, logo: takeLogo(away?.team) }
    });
  });
} catch { return []; } }
async function fetchEspnSoccer(d){ try {
  const j = await espnScoreboard('soccer', d);
  return (j?.events||[]).map(ev => {
    const c = ev?.competitions?.[0];
    const home = (c?.competitors||[]).find(x => x.homeAway==='home')||{};
    const away = (c?.competitors||[]).find(x => x.homeAway==='away')||{};
    const leagueName = ev?.league?.name || ev?.name || 'Football';
    return fixtureOf({ sport:'Soccer', leagueName, leagueCode:null, startISO: ev?.date,
      status: statusFromEspn(ev),
      home:{ name: home?.team?.displayName||home?.team?.name, logo: takeLogo(home?.team) },
      away:{ name: away?.team?.displayName||away?.team?.name, logo: takeLogo(away?.team) }
    });
  });
} catch { return []; } }

// ---- TheSportsDB daily fallbacks
async function sdbDay(d, sport, tag) {
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${d}&s=${encodeURIComponent(sport)}`;
  try {
    const r = await fetch(url, { timeout: 15000 });
    const j = await r.json();
    const evs = j?.events || [];
    return evs.map(ev => ({
      sport: tag,
      league: { name: ev?.strLeague || '', code: null },
      start_utc: ev?.strTimestamp ? new Date(parseInt(ev.strTimestamp,10)*1000).toISOString()
                                  : new Date(`${ev?.dateEvent}T${(ev?.strTime||'00:00')}:00Z`).toISOString(),
      status: (ev?.strStatus||'').match(/(FT|Finish|Final)/i) ? 'FINISHED' : 'SCHEDULED',
      home: { name: ev?.strHomeTeam || '' },
      away: { name: ev?.strAwayTeam || '' }
    }));
  } catch { return []; }
}

// ---- UEFA season fetch (UCL/UEL/UECL + qualifiers)
const SDB_UEFA_IDS = { CL:'4480', EL:'4481', ECL:'5071' };
const sdbLeagueIdCache = new Map();
async function sdbFindLeagueIdByName(name){
  if (!name) return null;
  if (sdbLeagueIdCache.has(name)) return sdbLeagueIdCache.get(name);
  try {
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchleagues.php?l=${encodeURIComponent(name)}`);
    const j = await r.json();
    const id = (j?.countries?.[0]?.idLeague || j?.countrys?.[0]?.idLeague || j?.leagues?.[0]?.idLeague) || null;
    sdbLeagueIdCache.set(name, id); return id;
  } catch { sdbLeagueIdCache.set(name, null); return null; }
}
function sdbSeasonFor(d){
  const dt = new Date(d + 'T00:00:00Z'); const y = dt.getUTCFullYear(); const m = dt.getUTCMonth()+1;
  return (m>=7) ? `${y}-${y+1}` : `${y-1}-${y}`;
}
async function fetchSdbUefa(dateStr){
  const season = sdbSeasonFor(dateStr);
  const names = [
    { name: 'UEFA Champions League', id: SDB_UEFA_IDS.CL },
    { name: 'UEFA Europa League', id: SDB_UEFA_IDS.EL },
    { name: 'UEFA Europa Conference League', id: SDB_UEFA_IDS.ECL }
  ];
  const out = [];
  for (const L of names){
    const id = L.id || await sdbFindLeagueIdByName(L.name);
    if (!id) continue;
    try {
      const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(season)}`);
      const j = await r.json();
      const evs = j?.events || j?.event || [];
      for (const ev of evs){
        if ((ev?.dateEvent||'').trim() !== dateStr) continue;
        out.push({
          sport: 'Soccer',
          league: { name: L.name, code: null },
          start_utc: ev?.strTimestamp ? new Date(parseInt(ev.strTimestamp,10)*1000).toISOString()
                                      : new Date(`${ev?.dateEvent}T${(ev?.strTime||'00:00')}:00Z`).toISOString(),
          status: (ev?.strStatus||'').match(/(FT|Finish|Final)/i) ? 'FINISHED' : 'SCHEDULED',
          home: { name: ev?.strHomeTeam || '' },
          away: { name: ev?.strAwayTeam || '' }
        });
      }
    } catch {}
  }
  return out;
}
async function fetchSdbUefaQual(dateStr){
  const season = sdbSeasonFor(dateStr);
  const names = [
    'UEFA Champions League Qualifying','UEFA Champions League Qualification','UEFA Champions League Play-offs',
    'UEFA Europa League Qualifying','UEFA Europa League Qualification','UEFA Europa League Play-offs',
    'UEFA Europa Conference League Qualifying','UEFA Europa Conference League Qualification','UEFA Europa Conference League Play-offs'
  ];
  const out = [];
  for (const name of names){
    const id = await sdbFindLeagueIdByName(name);
    if (!id) continue;
    try {
      const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(season)}`);
      const j = await r.json();
      const evs = j?.events || j?.event || [];
      for (const ev of evs){
        if ((ev?.dateEvent||'').trim() !== dateStr) continue;
        out.push({
          sport: 'Soccer',
          league: { name, code: null },
          start_utc: ev?.strTimestamp ? new Date(parseInt(ev.strTimestamp,10)*1000).toISOString()
                                      : new Date(`${ev?.dateEvent}T${(ev?.strTime||'00:00')}:00Z`).toISOString(),
          status: (ev?.strStatus||'').match(/(FT|Finish|Final)/i) ? 'FINISHED' : 'SCHEDULED',
          home: { name: ev?.strHomeTeam || '' },
          away: { name: ev?.strAwayTeam || '' }
        });
      }
    } catch {}
  }
  return out;
}

// ---- Manual fixtures
const MANUAL_PATH = path.join(__dirname, 'data', 'manual-fixtures.json');
let MANUAL = {};
try { if (fs.existsSync(MANUAL_PATH)) MANUAL = JSON.parse(fs.readFileSync(MANUAL_PATH, 'utf-8')); } catch {}
async function fetchManual(dateStr){
  const items = Array.isArray(MANUAL?.[dateStr]) ? MANUAL[dateStr] : [];
  return items.map(it => ({
    sport: it.sport || 'Soccer',
    league: { name: (it.league && (it.league.name || it.league)) || '', code: it.league?.code || null },
    start_utc: it.start_utc || `${dateStr}T00:00:00Z`,
    status: it.status || 'SCHEDULED',
    home: { name: it.home?.name || it.home || '' },
    away: { name: it.away?.name || it.away || '' }
  }));
}

// ---- Merge
function mergeDedup(list) {
  const m = new Map();
  for (const fx of list) {
    const k = keyForFixture(fx);
    if (!m.has(k)) m.set(k, fx);
    else m.set(k, choosePreferred(m.get(k), fx));
  }
  return [...m.values()];
}

// ---- API
app.get('/api/fixtures', async (req, res) => {
  const dateStr = (req.query.date || '').toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });

  const [espnSoccer, espnNba, espnNfl] = await Promise.all([
    fetchEspnSoccer(dateStr),
    fetchEspnNBA(dateStr),
    fetchEspnNFL(dateStr)
  ]);

  const [sdbSoccer, sdbNba, sdbNfl, sdbUefa, sdbUefaQual, manualFx] = await Promise.all([
    sdbDay(dateStr, 'Soccer', 'Soccer'),
    sdbDay(dateStr, 'Basketball', 'NBA'),
    sdbDay(dateStr, 'American Football', 'NFL'),
    fetchSdbUefa(dateStr),
    fetchSdbUefaQual(dateStr),
    fetchManual(dateStr)
  ]);

  const sourceCounts = {
    espn_soccer: espnSoccer.length, espn_nba: espnNba.length, espn_nfl: espnNfl.length,
    sportsdb_soccer: sdbSoccer.length, sportsdb_nba: sdbNba.length, sportsdb_nfl: sdbNfl.length,
    sportsdb_uefa: sdbUefa.length, sportsdb_uefa_qual: sdbUefaQual.length, manual: manualFx.length
  };

  let merged = mergeDedup([...espnSoccer, ...espnNba, ...espnNfl, ...sdbSoccer, ...sdbNba, ...sdbNfl, ...sdbUefa, ...sdbUefaQual, ...manualFx]);
  merged = await enrich(merged);

  res.json({ meta: { date: dateStr, sourceCounts }, fixtures: merged });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('kixonair listening on :' + PORT));
