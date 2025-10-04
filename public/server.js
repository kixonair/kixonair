// Kixonair server v16 — ALL MATCHES
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

const ORIGINS = (process.env.ALLOW_ORIGINS || 'https://kixonair.com,https://www.kixonair.com,https://kixonair.onrender.com')
  .split(',').map(s => s.trim());
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ORIGINS.includes(origin)), credentials: false }));
app.use(compression());
app.use(express.static('public', { maxAge: '1h', etag: true }));
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
  try{
    const raw = decodeURIComponent(String(req.params.id || ''));
    if (!raw) return res.status(400).json({ ok:false, error:'missing id', fixture:null });

    // Helpers
    const today = new Date().toISOString().slice(0,10);
    const day = d => new Date(Date.UTC(+d.slice(0,4), +d.slice(5,7)-1, +d.slice(8,10)));
    const fmt = dt => dt.toISOString().slice(0,10);
    const addDays = (dateStr, delta) => { const dt = day(dateStr); dt.setUTCDate(dt.getUTCDate()+delta); return fmt(dt); };

    function slug(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
    function teamSlug(s){
      const sl = slug(s);
      // also return a trimmed alias (first or last word) to match nicknames like "spurs", "leeds"
      const parts = sl.split('-').filter(Boolean);
      const first = parts[0] || sl;
      const last = parts[parts.length-1] || sl;
      return { full: sl, first, last };
    }
    function timeMs(x){
      if (!x) return NaN;
      const s = String(x);
      try { return Date.parse(s.length >= 20 ? s : s.endsWith('Z') ? s : s + 'Z'); } catch { return NaN; }
    }

    // Parse "slug@iso" or raw id forms
    const hasAt = raw.includes('@');
    const slugPart = slug(hasAt ? raw.split('@')[0] : raw);
    const isoPart  = hasAt ? raw.split('@')[1] : null;
    const isoMs = timeMs(isoPart);
    const dateHint = isNaN(isoMs) ? null : fmt(new Date(isoMs));

    async function fixturesFor(dateStr){
      const base = `${req.protocol}://${req.get('host')}/api/fixtures?date=${encodeURIComponent(dateStr)}`;
      const r = await fetch(base).catch(()=>null);
      const j = r ? await r.json().catch(()=>null) : null;
      return Array.isArray(j?.fixtures) ? j.fixtures : [];
    }

    // First try exact id over a small date window (derived from isoPart if present)
    const searchDays = dateHint ? [dateHint, addDays(dateHint,-1), addDays(dateHint,1)] : [today, addDays(today,-1), addDays(today,1)];
    for (const d of searchDays){
      const list = await fixturesFor(d);
      let found = list.find(fx => String(fx.id) === raw);
      if (found) return res.json({ ok:true, fixture: found, date: d });
    }

    // Fuzzy search by slug (supports nicknames like "leeds" / "spurs" and order-insensitive)
    function matchesSlug(fx){
      const nmHome = teamSlug(fx.home?.name || '');
      const nmAway = teamSlug(fx.away?.name || '');
      const pairA = `${nmHome.full}-vs-${nmAway.full}`;
      const pairB = `${nmAway.full}-vs-${nmHome.full}`;
      if (slugPart === slug(pairA) || slugPart === slug(pairB)) return true;

      // tokens from slugPart around "-vs-"
      const toks = slugPart.split('-vs-');
      if (toks.length === 2){
        const a = toks[0], b = toks[1];
        const homeHit = nmHome.full.includes(a) || nmHome.first === a || nmHome.last === a;
        const awayHit = nmAway.full.includes(b) || nmAway.first === b || nmAway.last === b;
        const revHomeHit = nmHome.full.includes(b) || nmHome.first === b || nmHome.last === b;
        const revAwayHit = nmAway.full.includes(a) || nmAway.first === a || nmAway.last === a;
        if ((homeHit && awayHit) || (revHomeHit && revAwayHit)) return true;
      }else{
        // Single token mode: allow either team to contain it
        const a = toks[0];
        if (nmHome.full.includes(a) || nmAway.full.includes(a)) return true;
      }
      return false;
    }

    // Build candidate set across a wider window in case of timezone offsets (+/- 3 days)
    const wideDays = dateHint
      ? [addDays(dateHint,-1), dateHint, addDays(dateHint,1), addDays(dateHint,2)]
      : [addDays(today,-2), addDays(today,-1), today, addDays(today,1), addDays(today,2)];
    let candidates = [];
    for (const d of wideDays){
      const list = await fixturesFor(d);
      candidates.push(...list.filter(matchesSlug));
    }

    if (candidates.length){
      // If we have an iso time, pick the closest by start time (±6 hours tolerance)
      if (!isNaN(isoMs)){
        candidates.sort((a,b) => Math.abs(timeMs(a.start_utc)-isoMs) - Math.abs(timeMs(b.start_utc)-isoMs));
        const best = candidates[0];
        if (Math.abs(timeMs(best.start_utc) - isoMs) <= 6*3600*1000){
          return res.json({ ok:true, fixture: best });
        }
      }
      // Else just pick the soonest upcoming or the first
      candidates.sort((a,b) => timeMs(a.start_utc) - timeMs(b.start_utc));
      return res.json({ ok:true, fixture: candidates[0] });
    }

    // Final fallback: scan exact id match over a broader 7-day window (if the id was some other form)
    const broader = [];
    for (let d=-3; d<=3; d++){
      const dateStr = addDays(today, d);
      const list = await fixturesFor(dateStr);
      const hit = list.find(fx => String(fx.id) === raw);
      if (hit){ return res.json({ ok:true, fixture: hit, date: dateStr }); }
      broader.push(...list);
    }

    res.status(404).json({ ok:false, error:'not found', fixture:null });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e), fixture:null });
  }
});
const today = new Date().toISOString().slice(0,10);
    const day = d => new Date(Date.UTC(+d.slice(0,4), +d.slice(5,7)-1, +d.slice(8,10)));
    const fmt = dt => dt.toISOString().slice(0,10);
    const addDays = (dateStr, delta) => { const dt = day(dateStr); dt.setUTCDate(dt.getUTCDate()+delta); return fmt(dt); };
    const windows = [today, addDays(today,-1), addDays(today,1)];

    function slug(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
    function sameTeams(a,b){
      return slug(a.home?.name)===slug(b.home?.name) && slug(a.away?.name)===slug(b.away?.name);
    }

    const [maybeSlug, maybeIso] = raw.includes('@') ? [raw.split('@')[0], raw.split('@')[1]] : [raw, null];
    const targetSlug = slug(maybeSlug).replace(/-vs-/, '-vs-'); // normalize

    async function fixturesFor(dateStr){
      const base = `${req.protocol}://${req.get('host')}/api/fixtures?date=${encodeURIComponent(dateStr)}`;
      const r = await fetch(base).catch(()=>null);
      const j = r ? await r.json().catch(()=>null) : null;
      return Array.isArray(j?.fixtures) ? j.fixtures : [];
    }

    for (const d of windows){
      const list = await fixturesFor(d);
      // 1) exact id
      let found = list.find(fx => String(fx.id) === raw);
      if (found) return res.json({ ok:true, fixture: found, date: d });

      // 2) slug@iso form
      if (maybeIso){
        found = list.find(fx => slug(`${fx.home?.name}-vs-${fx.away?.name}`) === targetSlug && String(fx.start_utc||'').startsWith(maybeIso.slice(0,16)));
        if (found) return res.json({ ok:true, fixture: found, date: d });
      }

      // 3) slug-only match (pick the closest by start_utc)
      const candidates = list.filter(fx => slug(`${fx.home?.name}-vs-${fx.away?.name}`) === targetSlug);
      if (candidates.length){
        candidates.sort((a,b) => Math.abs(new Date(a.start_utc) - new Date()) - Math.abs(new Date(b.start_utc) - new Date()));
        return res.json({ ok:true, fixture: candidates[0], date: d });
      }
    }

    res.status(404).json({ ok:false, error:'not found', fixture:null });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e), fixture:null });
  }
});
// helper to fetch fixtures for a given date using the existing /api/fixtures logic
    async function fixturesFor(dateStr){
      const url = `${req.protocol}://${req.get('host')}/api/fixtures?date=${encodeURIComponent(dateStr)}`;
      try{
        const r = await fetch(url);
        const j = await r.json();
        return Array.isArray(j?.fixtures) ? j.fixtures : [];
      }catch{return [];}
    }

    const today = new Date().toISOString().slice(0,10);
    const day = d => new Date(Date.UTC(+d.slice(0,4), +d.slice(5,7)-1, +d.slice(8,10)));
    function addDays(dateStr, delta){
      const dt = day(dateStr); dt.setUTCDate(dt.getUTCDate()+delta);
      return dt.toISOString().slice(0,10);
    }

    // search today, then -1, then +1
    const windows = [today, addDays(today,-1), addDays(today,1)];
    let found = null;
    for (const d of windows){
      const list = await fixturesFor(d);
      found = list.find(fx => String(fx.id) === id) || null;
      if (found){
        return res.json({ ok:true, fixture: found, date: d });
      }
    }

    // not found
    res.status(404).json({ ok:false, error:'not found', fixture:null });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e), fixture:null });
  }
});
});


// Lightweight embed proxy for Riley to bypass frame-ancestors/XFO when legally allowed.
// NOTE: Use only if you have rights to display the content within your site.
app.get('/embed/riley', async (req,res) => {
  try{
    const m = String(req.query.m || '').trim();
    if (!m) return res.status(400).type('text').send('missing m');
    const url = 'https://rileymarker.com/sportlo?m=' + encodeURIComponent(m);
    const r = await fetch(url);
    const text = await r.text();
    // Remove frame-blocking headers and set a permissive CSP for this response
    res.removeHeader('x-frame-options');
    res.set('Content-Security-Policy', '');
    res.type('html');
    // Ensure relative asset URLs resolve correctly on Riley
    const withBase = text.replace(/<head(\s*?)>/i, '<head$1><base href="https://rileymarker.com/">');
    res.send(withBase);
  }catch(e){
    res.status(500).type('text').send('proxy error');
  }
});

app.get('*', (req,res) => res.sendFile(process.cwd() + '/public/index.html'));
app.listen(PORT, () => console.log('Kixonair v16 running on :'+PORT));
