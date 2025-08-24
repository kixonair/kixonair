
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 10000;

const allow = (process.env.ALLOW_ORIGINS || 'https://kixonair.com,https://www.kixonair.com')
  .split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb)=>{
    if(!origin) return cb(null,true);
    if(allow.includes(origin)) return cb(null,true);
    cb(null,false);
  }
}));
app.use(express.json());
app.use(express.static('public',{maxAge:'1h',etag:true}));

// ----------------- Cache -----------------
const cache = new Map();  // date -> {ts,data}
const TTL = 1000*60*10;   // 10 min

// ----------------- Helpers ----------------
const H = 3600*1000;
const fmtDate = d => {
  if (d==='today') return new Date().toISOString().slice(0,10);
  if (d==='tomorrow'){ const t=new Date(); t.setUTCDate(t.getUTCDate()+1); return t.toISOString().slice(0,10); }
  return (d||new Date().toISOString().slice(0,10)).slice(0,10);
};
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const norm = (s='') => s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

async function fetchJSON(url,{tries=3, timeout=12000, headers={}}={}){
  let last;
  for(let i=0;i<tries;i++){
    const ctl = new AbortController();
    const t = setTimeout(()=>ctl.abort(), timeout);
    try{
      const res = await fetch(url,{
        headers: {
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          'Accept':'application/json, text/plain, */*',
          'Referer':'https://www.espn.com/',
          ...headers
        },
        signal: ctl.signal
      });
      clearTimeout(t);
      if(!res.ok) throw new Error('HTTP '+res.status);
      return await res.json();
    }catch(e){
      last = e; clearTimeout(t); await sleep(300+i*400);
    }
  }
  throw last;
}

// ----------------- Sources ----------------
const ESPN_HOSTS = ['https://site.api.espn.com','https://site.web.api.espn.com'];
const ESPN_SOCCER_LEAGUES = [
  'eng.1','esp.1','ger.1','ita.1','fra.1',
  'uefa.champions','uefa.europa','uefa.europa.conf'
];

function mapEspnEvents(events){
  const out = [];
  for (const ev of events||[]){
    const c = ev.competitions?.[0]; if(!c) continue;
    const comps = c.competitors||[];
    const home = comps.find(x=>x.homeAway==='home') || comps[0] || {};
    const away = comps.find(x=>x.homeAway==='away') || comps[1] || {};
    const leagueName = ev.leagues?.[0]?.name || '';
    const state = ev.status?.type?.state || c.status?.type?.state || 'pre';
    const status = state==='in'?'LIVE': state==='post'?'Finished':'Scheduled';
    out.push({
      sport:'Soccer',
      league:{ name: leagueName, code: ev.leagues?.[0]?.abbreviation || '' },
      start_utc: ev.date || c.date || '',
      status,
      home:{ name: home.team?.shortDisplayName || home.team?.name || home.displayName || '', logo: home.team?.logo },
      away:{ name: away.team?.shortDisplayName || away.team?.name || away.displayName || '', logo: away.team?.logo },
      _source:'espn_soccer'
    });
  }
  return out;
}

async function espnSoccer(date){
  const yyyymmdd = date.replace(/-/g,'');
  // 1) Try global scoreboard across both hosts
  for (const host of ESPN_HOSTS){
    try{
      const j = await fetchJSON(`${host}/apis/site/v2/sports/soccer/scoreboard?dates=${yyyymmdd}`);
      const arr = mapEspnEvents(j?.events);
      if (arr.length) return { list: arr, path: 'global@'+host };
    }catch{ /* try next */ }
  }
  // 2) Try league-specific scoreboards (concat)
  let list = []; let hit = 0; let lastHost = ESPN_HOSTS[0];
  for (const lg of ESPN_SOCCER_LEAGUES){
    for (const host of ESPN_HOSTS){
      try{
        const j = await fetchJSON(`${host}/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${yyyymmdd}`);
        const part = mapEspnEvents(j?.events);
        if (part.length){ list = list.concat(part); hit++; lastHost = host; break; }
      }catch{/* keep trying others */}
    }
  }
  return { list, path: `leagues(${hit})@${lastHost}` };
}

async function sportsdbSoccer(date){
  const key = process.env.SPORTSDB_KEY || '3';
  const url = `https://www.thesportsdb.com/api/v1/json/${key}/eventsday.php?d=${date}&s=Soccer`;
  const j = await fetchJSON(url, { tries: 2 });
  const arr = j?.events || [];
  return arr.map(ev => ({
    sport:'Soccer',
    league:{ name: ev.strLeague || ev.strLeague2 || '', code:'' },
    start_utc: ev.strTimestamp || (ev.dateEvent && ev.strTime ? `${ev.dateEvent}T${ev.strTime}:00Z` : `${date}T00:00:00Z`),
    status:'Scheduled',
    home:{ name: ev.strHomeTeam || '', logo:'' },
    away:{ name: ev.strAwayTeam || '', logo:'' },
    _source:'sportsdb_soccer'
  }));
}

// Dedup/merge
function mergeFixtures(list){
  const m = new Map();
  for (const fx of list){
    const key = `${norm(fx.home.name)}|${norm(fx.away.name)}|${(fx.start_utc||'').slice(0,10)}`;
    const prev = m.get(key);
    if (!prev){ m.set(key, fx); continue; }
    const prefer = fx._source==='espn_soccer' ? fx : prev;
    const other  = fx._source==='espn_soccer' ? prev : fx;
    prefer.league = prefer.league?.name ? prefer.league : other.league;
    if (!prefer.home.logo) prefer.home.logo = other.home.logo;
    if (!prefer.away.logo) prefer.away.logo = other.away.logo;
    prefer.status = (prefer.status && prefer.status!=='Scheduled') ? prefer.status : other.status;
    m.set(key, prefer);
  }
  return Array.from(m.values());
}

// Minimal team logo enrichment (best-effort)
const logoCache = new Map();
async function teamLogo(name){
  const k = norm(name); const hit = logoCache.get(k);
  if (hit && Date.now()-hit.ts < 12*60*60*1000) return hit.url||'';
  const key = process.env.SPORTSDB_KEY || '3';
  const url = `https://www.thesportsdb.com/api/v1/json/${key}/searchteams.php?t=${encodeURIComponent(name)}`;
  try{
    const j = await fetchJSON(url,{tries:2});
    const team = j?.teams?.[0];
    const badge = team?.strTeamBadge || team?.strTeamLogo || '';
    logoCache.set(k,{ts:Date.now(),url:badge});
    return badge||'';
  }catch{ return ''; }
}

// Build fixtures for a date
async function buildFixtures(date){
  const d = fmtDate(date);
  const hit = cache.get(d);
  if (hit && Date.now()-hit.ts < TTL) return hit.data;

  let espnList = [], espnPath = 'none';
  try{
    const {list, path} = await espnSoccer(d);
    espnList = list; espnPath = path;
  }catch{}

  let sdbList = [];
  try{ sdbList = await sportsdbSoccer(d); }catch{}

  let fixtures = mergeFixtures(espnList.concat(sdbList));
  await Promise.all(fixtures.map(async fx=>{
    if (!fx.home.logo) fx.home.logo = await teamLogo(fx.home.name);
    if (!fx.away.logo) fx.away.logo = await teamLogo(fx.away.name);
  }));

  const data = { meta:{
    date:d,
    sourceCounts:{ espn_soccer: espnList.length, sportsdb_soccer: sdbList.length, espn_path: espnPath }
  }, fixtures };
  cache.set(d,{ts:Date.now(),data});
  return data;
}

// ----------------- Routes -----------------
app.get('/api/fixtures', async (req,res)=>{
  try{
    const d = fmtDate(req.query.date || req.params.date);
    const data = await buildFixtures(d);
    res.set('Cache-Control','no-store');
    res.json(data);
  }catch(e){ res.status(500).json({error:String(e?.message||e)}); }
});
app.get('/api/fixtures/today', (req,res)=> res.redirect(302, '/api/fixtures?date='+fmtDate('today')));
app.get('/api/fixtures/tomorrow', (req,res)=> res.redirect(302, '/api/fixtures?date='+fmtDate('tomorrow')));

// Probe
app.get('/__/probe', async (req,res)=>{
  const d = fmtDate(req.query.date || 'today');
  const out = { date:d };
  try{
    const {list, path} = await espnSoccer(d);
    out.espn_soccer = { ok:true, path, count:list.length };
  }catch(e){ out.espn_soccer = { ok:false, note:String(e?.message||e) }; }
  try{
    const s = await sportsdbSoccer(d);
    out.sdb_soccer = { ok:true, count: s.length };
  }catch(e){ out.sdb_soccer = { ok:false, note:String(e?.message||e) }; }
  res.json(out);
});
app.get('/__/probe/today', (req,res)=> res.redirect(302, '/__/probe?date='+fmtDate('today')));

// Admin
function isAuthed(req){
  const token = req.query.token || req.headers['x-admin-token'];
  return token && token === (process.env.ADMIN_TOKEN || 'mysecret123');
}
app.all('/admin/flush-cache', (req,res)=>{
  if(!isAuthed(req)) return res.status(403).json({ok:false});
  if (req.query.all==='true') cache.clear();
  res.json({ ok:true, cleared: req.query.all==='true'?'all':'none' });
});
app.all('/admin/precache', async (req,res)=>{
  if(!isAuthed(req)) return res.status(403).json({ok:false});
  const d = fmtDate(req.query.date || 'today');
  const data = await buildFixtures(d);
  res.json({ ok:true, date:d, counts: data.meta.sourceCounts, size: data.fixtures.length });
});
app.all('/admin/precache/today', (req,res)=>{
  if(!isAuthed(req)) return res.status(403).json({ok:false});
  res.redirect(302, '/admin/precache?date='+fmtDate('today')+'&token='+(req.query.token||''));
});
app.all('/admin/precache/tomorrow', (req,res)=>{
  if(!isAuthed(req)) return res.status(403).json({ok:false});
  res.redirect(302, '/admin/precache?date='+fmtDate('tomorrow')+'&token='+(req.query.token||''));
});

app.get('/health', (_req,res)=> res.type('text/plain').send('ok'));
app.listen(PORT, ()=> console.log('Kixonair hotfix2 on :'+PORT));
