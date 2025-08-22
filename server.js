
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

// ENV
const SPORTSDB_KEY = process.env.SPORTSDB_KEY || '3';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MANUAL_URL = process.env.MANUAL_URL || '';
const MANUAL_MODE = (process.env.MANUAL_MODE || 'fallback').toLowerCase();
const EU_LEAGUES = (process.env.EU_LEAGUES || [
  'soccer/uefa.champions','soccer/uefa.europa','soccer/uefa.europa.conf',
  'soccer/eng.1','soccer/esp.1','soccer/ger.1','soccer/ita.1','soccer/fra.1',
  'soccer/por.1','soccer/ned.1','soccer/tur.1','soccer/bel.1','soccer/sco.1'
]).toString().split(',').map(s => s.trim()).filter(Boolean);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 KixonairBot/1.0';
async function httpGet(url, extra={}){
  try{
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' }, timeout: 20000, ...extra });
    return r;
  }catch{ return { ok:false, status:0, json: async ()=>({}), arrayBuffer: async()=>new ArrayBuffer(0) }; }
}

app.use(cors());
app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));
app.get('/health', (_, res) => res.type('text/plain').send('ok'));
app.get('/__/version', (_, res) => res.json({ build: 'hotfix5-date-normalize+paths', ts: new Date().toISOString() }));

// ---- Date parsing helpers ----
function normalizeDateParam(raw){
  if (!raw) return null;
  let s = decodeURIComponent(String(raw)).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'today') return new Date().toISOString().slice(0,10);
  if (lower === 'tomorrow'){ const d = new Date(Date.now()+86400000); return d.toISOString().slice(0,10); }
  if (lower === 'yesterday'){ const d = new Date(Date.now()-86400000); return d.toISOString().slice(0,10); }
  // Replace dots/slashes with dashes
  s = s.replace(/[\.\/]/g, '-').replace(/\s+/g, '-');
  // If matches YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // If DD-MM-YYYY -> convert
  const m1 = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  // If YYYY-M-D -> pad
  const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m2){ const y=m2[1], mo=m2[2].padStart(2,'0'), d=m2[3].padStart(2,'0'); return `${y}-${mo}-${d}`; }
  return null;
}

// ---- Other helpers ----
function fixLogo(u){ return u ? u.replace(/^http:/,'https:') : null; }
const logoCache = new Map();
const yyyymmdd = d => d.replace(/-/g, '');
const dayOf = iso => { const t = new Date(iso); const y=t.getUTCFullYear(); const m=(t.getUTCMonth()+1).toString().padStart(2,'0'); const dd=t.getUTCDate().toString().padStart(2,'0'); return `${y}-${m}-${dd}`; };
const statusFromEspn = ev => {
  const s = ev?.competitions?.[0]?.status?.type?.state || '';
  if (s === 'in') return 'LIVE';
  if (s === 'post') return 'FINISHED';
  return 'SCHEDULED';
};
const takeLogo = t => fixLogo(t?.logo || t?.logos?.[0]?.href || null);
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g,'');
function fx({ sport, league, startISO, status, home, away }){
  return { sport, league: { name: league||'', code: null }, start_utc: startISO, status: status||'SCHEDULED',
           home: { name: home?.name||'', logo: home?.logo||null }, away: { name: away?.name||'', logo: away?.logo||null } };
}
function key(f){ const t = f.start_utc?new Date(f.start_utc):new Date(); const h=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth(),t.getUTCDate(),t.getUTCHours())).toISOString(); return `${f.sport}:${norm(f.home.name)}-${norm(f.away.name)}@${h}`; }

async function badgeFromSportsDB(name){
  if (!name) return null;
  const k = name.toLowerCase();
  if (logoCache.has(k)) return logoCache.get(k);
  try{
    const r = await httpGet(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchteams.php?t=${encodeURIComponent(name)}`);
    const j = await r.json();
    const t = j?.teams?.[0];
    const url = t?.strTeamBadge || t?.strTeamLogo || null;
    logoCache.set(k, url || null);
    return url || null;
  }catch{ logoCache.set(k, null); return null; }
}
async function enrich(list){
  const names = [...new Set(list.flatMap(f => [f.home?.name, f.away?.name].filter(Boolean)))];
  for (let i=0;i<names.length;i+=10){ await Promise.all(names.slice(i,i+10).map(n => badgeFromSportsDB(n))); }
  for (const f of list){
    if (!f.home.logo) f.home.logo = fixLogo(logoCache.get((f.home.name||'').toLowerCase()) || null);
    if (!f.away.logo) f.away.logo = fixLogo(logoCache.get((f.away.name||'').toLowerCase()) || null);
  }
  return list;
}

// ESPN
async function espnBoard(seg, d){
  const url = `https://site.api.espn.com/apis/v2/sports/${seg}/scoreboard?dates=${yyyymmdd(d)}`;
  const r = await httpGet(url);
  if (!r.ok) return { ok:false, status:r.status, events: [] };
  const j = await r.json(); j.ok = true; j.status = r.status; return j;
}
function mapSoccerEvents(j, d){
  const out=[];
  for (const ev of (j?.events||[])){
    const iso = ev?.date; if (!iso || dayOf(iso)!==d) continue;
    const c=ev?.competitions?.[0]||{};
    const H=(c?.competitors||[]).find(x=>x.homeAway==='home')||{};
    const A=(c?.competitors||[]).find(x=>x.homeAway==='away')||{};
    out.push(fx({ sport:'Soccer', league: ev?.league?.name||ev?.name||'Football', startISO: iso, status: statusFromEspn(ev),
      home:{name:H?.team?.displayName||H?.team?.name, logo: takeLogo(H?.team)},
      away:{name:A?.team?.displayName||A?.team?.name, logo: takeLogo(A?.team)} }));
  }
  return out;
}
async function espnSoccer(d){ const j = await espnBoard('soccer', d); return mapSoccerEvents(j,d); }
async function espnSoccerEU(d){
  const boards = await Promise.all(EU_LEAGUES.map(slug => espnBoard(slug, d)));
  const lists = boards.map(j => mapSoccerEvents(j,d));
  return lists.flat();
}
async function espnNBA(d){
  const j = await espnBoard('basketball/nba', d);
  const out=[];
  for (const ev of (j?.events||[])){
    const iso = ev?.date; if (!iso || dayOf(iso)!==d) continue;
    const c=ev?.competitions||[]; const c0=(c[0]||{});
    const H=(c0?.competitors||[]).find(x=>x.homeAway==='home')||{};
    const A=(c0?.competitors||[]).find(x=>x.homeAway==='away')||{};
    out.push(fx({ sport:'NBA', league:'NBA', startISO: iso, status: statusFromEspn(ev),
      home:{name:H?.team?.displayName||H?.team?.name, logo: takeLogo(H?.team)},
      away:{name:A?.team?.displayName||A?.team?.name, logo: takeLogo(A?.team)} }));
  }
  return out;
}
async function espnNFL(d){
  const j = await espnBoard('football/nfl', d);
  const out=[];
  for (const ev of (j?.events||[])){
    const iso = ev?.date; if (!iso || dayOf(iso)!==d) continue;
    const c=ev?.competitions||[]; const c0=(c[0]||{});
    const H=(c0?.competitors||[]).find(x=>x.homeAway==='home')||{};
    const A=(c0?.competitors||[]).find(x=>x.homeAway==='away')||{};
    out.push(fx({ sport:'NFL', league:'NFL', startISO: iso, status: statusFromEspn(ev),
      home:{name:H?.team?.displayName||H?.team?.name, logo: takeLogo(H?.team)},
      away:{name:A?.team?.displayName||A?.team?.name, logo: takeLogo(A?.team)} }));
  }
  return out;
}

// SportsDB day
async function sdbDay(d, sportQuery, tag){
  try{
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${d}&s=${encodeURIComponent(sportQuery)}`;
    const r = await httpGet(url);
    const j = await r.json();
    const out=[];
    for (const e of (j?.events||[])){
      const iso = e?.strTimestamp ? new Date(parseInt(e.strTimestamp,10)*1000).toISOString() : `${e?.dateEvent}T${(e?.strTime||'00:00')}:00Z`;
      if (!iso || dayOf(iso)!==d) continue;
      out.push(fx({ sport: tag, league: e?.strLeague || '', startISO: iso,
        status: (e?.strStatus||'').match(/(FT|Finish|Final)/i) ? 'FINISHED' : 'SCHEDULED',
        home:{ name: e?.strHomeTeam||'' }, away:{ name: e?.strAwayTeam||'' } }));
    }
    return out;
  }catch{ return []; }
}

// Manual fixtures
const MANUAL_PATH = path.join(__dirname, 'data', 'manual-fixtures.json');
let MANUAL = {};
try{ if (fs.existsSync(MANUAL_PATH)) MANUAL = JSON.parse(fs.readFileSync(MANUAL_PATH,'utf-8')); }catch{}
let manualRemote = { last:0, json:{} };
async function manualFor(dateStr){
  const list=[];
  if (MANUAL_URL){
    const now = Date.now();
    if (now - manualRemote.last > 60*60*1000){
      try{ const r = await httpGet(MANUAL_URL); if (r.ok) manualRemote = { last: now, json: await r.json() }; }catch{}
    }
    const rr = manualRemote.json?.[dateStr]; if (Array.isArray(rr)) list.push(...rr);
  }
  const ll = MANUAL?.[dateStr]; if (Array.isArray(ll)) list.push(...ll);
  return list.map(it => fx({
    sport: it.sport || 'Soccer',
    league: (it.league && (it.league.name || it.league)) || '',
    startISO: it.start_utc || `${dateStr}T00:00:00Z`,
    status: it.status || 'SCHEDULED',
    home: { name: it.home?.name || it.home || '' },
    away: { name: it.away?.name || it.away || '' }
  }));
}

// Cache
const CACHE_DIR = path.join(__dirname, 'data', 'cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
function cpath(d){ return path.join(CACHE_DIR, `${d}.json`); }
function readCache(d){ try{ if (fs.existsSync(cpath(d))) return JSON.parse(fs.readFileSync(cpath(d),'utf-8')); }catch{} return null; }
function writeCache(d, payload){ try{ fs.writeFileSync(cpath(d), JSON.stringify(payload)); }catch{} }

// Merge/Dedup
function dedup(list){
  const m = new Map();
  for (const f of list){
    const k = key(f);
    if (!m.has(k)) m.set(k, f);
  }
  return [...m.values()];
}

// Core fetch+merge for a given date
async function assembleFor(d){
  const [eu, all, nba, nfl, sdbS, sdbN, sdbF] = await Promise.all([
    espnSoccerEU(d), espnSoccer(d), espnNBA(d), espnNFL(d),
    sdbDay(d,'Soccer','Soccer'), sdbDay(d,'Basketball','NBA'), sdbDay(d,'American Football','NFL')
  ]);
  let mergedPrimary = dedup([...eu, ...all, ...sdbS, ...nba, ...nfl, ...sdbN, ...sdbF]);
  let manual = [];
  if (MANUAL_MODE === 'merge') manual = await manualFor(d);
  else if (mergedPrimary.length === 0) manual = await manualFor(d);
  let merged = dedup([...mergedPrimary, ...manual]);
  merged = await enrich(merged);
  return {
    meta: { date: d, sourceCounts: {
      espn_soccer_eu: eu.length, espn_soccer_all: all.length, espn_nba: nba.length, espn_nfl: nfl.length,
      sportsdb_soccer: sdbS.length, sportsdb_nba: sdbN.length, sportsdb_nfl: sdbF.length, manual: manual.length
    } },
    fixtures: merged
  };
}

// API (query param + path param)
app.get(['/api/fixtures', '/api/fixtures/:date'], async (req, res) => {
  const raw = req.params.date || req.query.date;
  const d = normalizeDateParam(raw);
  if (!d) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });

  const cached = readCache(d); if (cached) return res.json(cached);
  const payload = await assembleFor(d);
  writeCache(d, payload);
  res.json(payload);
});

// Admin + flush + probe + echo
function auth(req,res){ const t = req.query.token || req.headers['x-admin-token']; if (!ADMIN_TOKEN || t !== ADMIN_TOKEN){ res.status(401).json({error:'unauthorized'}); return false;} return true; }
app.get(['/admin/precache','/admin/precache/:date'], async (req,res)=>{
  if(!auth(req,res))return; const raw = req.params.date || req.query.date; const d = normalizeDateParam(raw);
  if(!d) return res.status(400).json({error:'invalid date'});
  const r = await (await httpGet(`${req.protocol}://${req.get('host')}/api/fixtures/${d}`)).json().catch(()=>null);
  res.json(r||{meta:{date:d},fixtures:[]});
});
app.post(['/admin/precache','/admin/precache/:date'], async (req,res)=>{
  if(!auth(req,res))return; const raw = req.params.date || req.query.date; const d = normalizeDateParam(raw);
  if(!d) return res.status(400).json({error:'invalid date'});
  const r = await (await httpGet(`${req.protocol}://${req.get('host')}/api/fixtures/${d}`)).json().catch(()=>null);
  res.json(r||{meta:{date:d},fixtures:[]});
});
app.post('/admin/flush-cache', (req,res)=>{
  if(!auth(req,res))return; const raw = req.query.date; const d = normalizeDateParam(raw); const all=req.query.all==='true';
  try{
    const CACHE_DIR = path.join(__dirname, 'data', 'cache');
    if (all){ fs.rmSync(CACHE_DIR,{recursive:true,force:true}); fs.mkdirSync(CACHE_DIR,{recursive:true}); return res.json({ok:true,cleared:'all'}); }
    if (d){ const p=path.join(CACHE_DIR, `${d}.json`); if(fs.existsSync(p)) fs.unlinkSync(p); return res.json({ok:true,cleared:d}); }
    return res.status(400).json({error:'provide date=YYYY-MM-DD or all=true'});
  }catch(e){ return res.status(500).json({error:'flush failed'}); }
});
app.get(['/__/probe','/__/probe/:date'], async (req, res) => {
  const raw = req.params.date || req.query.date; const d = normalizeDateParam(raw);
  if (!d) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
  const mk = (ok, status, note='') => ({ ok, status, note });
  const resp = {};
  try { const r = await httpGet(`https://site.api.espn.com/apis/v2/sports/soccer/scoreboard?dates=${yyyymmdd(d)}`); resp.espn_soccer = mk(r.ok, r.status); const j = r.ok ? await r.json() : {events:[]}; resp.espn_soccer_events=(j.events||[]).length; } catch(e){ resp.espn_soccer = mk(false,0,'fetch failed'); }
  try { const r = await httpGet(`https://site.api.espn.com/apis/v2/sports/basketball/nba/scoreboard?dates=${yyyymmdd(d)}`); resp.espn_nba = mk(r.ok, r.status); const j = r.ok ? await r.json() : {events:[]}; resp.espn_nba_events=(j.events||[]).length; } catch(e){ resp.espn_nba = mk(false,0,'fetch failed'); }
  try { const r = await httpGet(`https://site.api.espn.com/apis/v2/sports/football/nfl/scoreboard?dates=${yyyymmdd(d)}`); resp.espn_nfl = mk(r.ok, r.status); const j = r.ok ? await r.json() : {events:[]}; resp.espn_nfl_events=(j.events||[]).length; } catch(e){ resp.espn_nfl = mk(false,0,'fetch failed'); }
  try { const r = await httpGet(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${d}&s=Soccer`); resp.sdb_soccer = mk(r.ok, r.status); const j = r.ok ? await r.json() : {events:[]}; resp.sdb_soccer_events=(j.events||[]).length; } catch(e){ resp.sdb_soccer = mk(false,0,'fetch failed'); }
  res.json({ date: d, probe: resp });
});
app.get('/__/echo', (req, res) => res.json({ originalUrl: req.originalUrl, query: req.query }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('kixonair hotfix5 listening on :' + PORT));
