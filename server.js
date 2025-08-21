// Kixonair server v16 — ALL MATCHES
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

const ORIGINS = (process.env.ALLOW_ORIGINS || 'https://kixonair.com,https://www.kixonair.com,https://kixonair.onrender.com')
  .split(',').map(s => s.trim());
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ORIGINS.includes(origin)), credentials: false }));
app.use(express.static('public'));
app.get('/health', (req,res) => res.type('text').send('ok'));

const APISPORTS_KEY = process.env.APISPORTS_KEY || '';
const SPORTSDB_KEY  = process.env.SPORTSDB_KEY  || '3';

const respCache = new Map();
const RESP_TTL_MS = 2 * 60 * 1000;
async function cachedJson(url, opt={}){
  const hit = respCache.get(url);
  if (hit && (Date.now()-hit.ts) < RESP_TTL_MS) return hit.json;
  const r = await fetch(url, opt);
  if (!r.ok) throw Object.assign(new Error('fetch '+r.status), { status:r.status });
  const j = await r.json();
  respCache.set(url, { json:j, ts:Date.now() });
  return j;
}

async function fetchSoccerApiSports(dateStr){
  if (!APISPORTS_KEY) return { list:[], issue:'apisports missing' };
  let all = [], page = 1, total = 1;
  try{
    do{
      const url = `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(dateStr)}&timezone=UTC&page=${page}`;
      const j = await cachedJson(url, { headers: { 'x-apisports-key': APISPORTS_KEY } });
      const arr = j?.response || [];
      total = j?.paging?.total || 1;
      page++;
      const mapped = arr.map(x => ({
        id: 'af:' + x.fixture?.id,
        sport: 'Soccer',
        start_utc: x.fixture?.date,
        status: x.fixture?.status?.long || x.fixture?.status?.short || 'SCHEDULED',
        league: { name: x.league?.name || '', code: String(x.league?.id || '') },
        home: { name: x.teams?.home?.name || '', logo: x.teams?.home?.logo || null },
        away: { name: x.teams?.away?.name || '', logo: x.teams?.away?.logo || null }
      }));
      all.push(...mapped);
      if (page > 6) break;
    } while (page <= total);
    return { list: all };
  }catch(e){ return { list: [], issue: 'apisports '+(e.status||'error') }; }
}

async function fetchSoccerSportsDB(dateStr){
  try{
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${encodeURIComponent(dateStr)}&s=Soccer`;
    const j = await cachedJson(url);
    const arr = j?.events || [];
    const list = arr.map(e => ({
      id: 'sdb:' + (e.idEvent || `${e.strEvent}:${e.dateEvent}:${e.strTime}`),
      sport: 'Soccer',
      start_utc: e.strTimestamp || (e.dateEvent ? `${e.dateEvent}T${(e.strTime||'00:00:00').slice(0,8)}Z` : null),
      status: (e.strStatus || e.strStatusShort || e.strResult || 'SCHEDULED').toUpperCase(),
      league: { name: e.strLeague || '', code: e.strLeagueShort || '' },
      home: { name: e.strHomeTeam || '' },
      away: { name: e.strAwayTeam || '' }
    }));
    return { list };
  }catch(e){ return { list: [], issue: 'sportsdb '+(e.status||'error') }; }
}

async function fetchSportsDBBySport(dateStr, sportName, leagueFilterRegex){
  try{
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${encodeURIComponent(dateStr)}&s=${encodeURIComponent(sportName)}`;
    const j = await cachedJson(url);
    const arr = (j?.events || []).filter(e => leagueFilterRegex.test(e.strLeague || ''));
    const mapped = arr.map(e => ({
      id: 'sdb:' + (e.idEvent || `${e.strEvent}:${e.dateEvent}:${e.strTime}`),
      sport: sportName === 'Basketball' ? 'NBA' : 'NFL',
      start_utc: e.strTimestamp || (e.dateEvent ? `${e.dateEvent}T${(e.strTime||'00:00:00').slice(0,8)}Z` : null),
      status: (e.strStatus || e.strStatusShort || e.strResult || 'SCHEDULED').toUpperCase(),
      league: { name: e.strLeague || '', code: e.strLeagueShort || '' },
      home: { name: e.strHomeTeam || '' },
      away: { name: e.strAwayTeam || '' }
    }));
    return { list: mapped };
  }catch(e){ return { list: [], issue: 'sportsdb-'+sportName+' '+(e.status||'error') }; }
}

const logoCache = new Map();
const LOGO_TTL_MS = 7*24*60*60*1000;
const keyOf = (sport, team) => (sport||'').toLowerCase()+'|'+(team||'').toLowerCase();
const sportLabel = sport => sport==='NBA' ? 'Basketball' : sport==='NFL' ? 'American Football' : 'Soccer';

async function fetchTeamLogoFromSportsDB(sport, team){
  if (!team) return null;
  const key = keyOf(sport, team);
  const hit = logoCache.get(key);
  if (hit && (Date.now()-hit.ts)<LOGO_TTL_MS) return hit.url;
  try{
    const sName = sportLabel(sport);
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchteams.php?t=${encodeURIComponent(team)}&s=${encodeURIComponent(sName)}`;
    const j = await cachedJson(url);
    const list = j?.teams || [];
    let teamObj = null;
    const want = (team||'').toLowerCase();
    for (const t of list){
      const nm=(t.strTeam||'').toLowerCase();
      const alt=(t.strAlternate||'').toLowerCase();
      const altArr = alt? alt.split(',').map(x=>x.trim().toLowerCase()):[];
      const sOK = !sName || (t.strSport||'').toLowerCase()===sName.toLowerCase();
      if (sOK && (nm===want || altArr.includes(want) || nm.includes(want))){ teamObj=t; break; }
    }
    if (!teamObj) teamObj = list[0];
    const badge = teamObj?.strTeamBadge || teamObj?.strTeamLogo || null;
    if (badge) logoCache.set(key, { url: badge, ts: Date.now() });
    return badge || null;
  }catch{ return null; }
}

async function enrichWithLogos(fixtures){
  const wants = new Map();
  for (const fx of fixtures){
    if (fx.home?.name && !fx.home?.logo) wants.set(keyOf(fx.sport, fx.home.name), { sport: fx.sport, name: fx.home.name });
    if (fx.away?.name && !fx.away?.logo) wants.set(keyOf(fx.sport, fx.away.name), { sport: fx.sport, name: fx.away.name });
  }
  const items = Array.from(wants.values());
  const CHUNK = 6;
  for (let i=0;i<items.length;i+=CHUNK){
    const slice = items.slice(i,i+CHUNK);
    await Promise.all(slice.map(it => fetchTeamLogoFromSportsDB(it.sport, it.name)));
  }
  for (const fx of fixtures){
    fx.home.logo = fx.home.logo || logoCache.get(keyOf(fx.sport, fx.home.name||''))?.url || null;
    fx.away.logo = fx.away.logo || logoCache.get(keyOf(fx.sport, fx.away.name||''))?.url || null;
  }
  return fixtures;
}

app.get('/api/fixtures', async (req, res) => {
  const dateStr = String(req.query.date || '').slice(0,10) || new Date().toISOString().slice(0,10);
  const issues = [];
  const sourceCounts = {};
  let soccer = [];
  const a = await fetchSoccerApiSports(dateStr);
  if (a.issue) issues.push(a.issue);
  if (a.list.length){ soccer = a.list; sourceCounts.apisports = a.list.length; }
  const b = await fetchSoccerSportsDB(dateStr);
  if (b.issue) issues.push(b.issue);
  if (b.list.length){ soccer = soccer.concat(b.list); sourceCounts.sportsdb_soccer = b.list.length; }

  const nbaRes = await fetchSportsDBBySport(dateStr, 'Basketball', /NBA/i);
  if (nbaRes.issue) issues.push(nbaRes.issue);
  const nflRes = await fetchSportsDBBySport(dateStr, 'American Football', /NFL/i);
  if (nflRes.issue) issues.push(nflRes.issue);

  const all = [...soccer, ...nbaRes.list, ...nflRes.list];
  const seen = new Set();
  const merged = [];
  for (const fx of all){
    const k = [fx.sport, fx.home?.name, fx.away?.name, fx.start_utc].join('|').toLowerCase();
    if (!seen.has(k)){ seen.add(k); merged.push(fx); }
  }
  await enrichWithLogos(merged);
  res.json({ date: dateStr, fixtures: merged, meta: { issues, sourceCounts } });
});

app.get('/api/fixture/:id', async (req,res) => {
  res.json({ fixture: null });
});

app.get('*', (req,res) => res.sendFile(process.cwd() + '/public/index.html'));
app.listen(PORT, () => console.log('Kixonair v16 running on :'+PORT));

async function fetchSportsDbUefaQualifiers(dateStr){
  const names = [
    'UEFA Champions League Qualifying',
    'UEFA Champions League Qualification',
    'UEFA Champions League Play-offs',
    'UEFA Europa League Qualifying',
    'UEFA Europa League Qualification',
    'UEFA Europa League Play-offs',
    'UEFA Europa Conference League Qualifying',
    'UEFA Europa Conference League Qualification',
    'UEFA Europa Conference League Play-offs'
  ];
  const season = sdbSeasonFor(dateStr);
  const out = [];
  for (const name of names){
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
          status: (ev?.strStatus||'').match(/(FT|Finish|Final)/i) ? 'FINISHED' : 'SCHEDULED',
          home: { name: ev?.strHomeTeam || '' },
          away: { name: ev?.strAwayTeam || '' }
        });
      }
      await new Promise(r => setTimeout(r, 80));
    }catch{ /* ignore */ }
  }
  return out;
}
