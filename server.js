
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
const EU_LEAGUES = (process.env.EU_LEAGUES || [
  'soccer/uefa.champions','soccer/uefa.europa','soccer/uefa.europa.conf',
  'soccer/eng.1','soccer/esp.1','soccer/ger.1','soccer/ita.1','soccer/fra.1',
  'soccer/por.1','soccer/ned.1','soccer/tur.1','soccer/bel.1','soccer/sco.1'
]).toString().split(',').map(s => s.trim()).filter(Boolean);

// CORS (safe + permissive for now; static serves same-origin anyway)
app.use(cors());

// Static + health/version
app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));
app.get('/health', (_, res) => res.type('text/plain').send('ok'));
app.get('/__/version', (_, res) => res.json({ build: 'hotfix-eu+sdb+manual+cache+logo', ts: new Date().toISOString() }));

// Helpers
function fixLogo(u){ return u ? u.replace(/^http:/,'https:') : null; }
const logoCache = new Map();
const yyyymmdd = d => d.replace(/-/g, '');
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
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchteams.php?t=${encodeURIComponent(name)}`);
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
  try{
    const url = `https://site.api.espn.com/apis/v2/sports/${seg}/scoreboard?dates=${yyyymmdd(d)}`;
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) return { events: [] };
    return await r.json();
  }catch{ return { events: [] }; }
}
async function espnSoccer(d){
  const j = await espnBoard('soccer', d);
  return (j?.events||[]).map(ev => {
    const c=ev?.competitions?.[0]||{};
    const H=(c?.competitors||[]).find(x=>x.homeAway==='home')||{};
    const A=(c?.competitors||[]).find(x=>x.homeAway==='away')||{};
    return fx({ sport:'Soccer', league: ev?.league?.name||ev?.name||'Football', startISO: ev?.date, status: statusFromEspn(ev),
                home:{name:H?.team?.displayName||H?.team?.name, logo: takeLogo(H?.team)}, away:{name:A?.team?.displayName||A?.team?.name, logo: takeLogo(A?.team)} });
  });
}
async function espnSoccerEU(d){
  const boards = await Promise.all(EU_LEAGUES.map(slug => espnBoard(slug, d)));
  const out=[];
  for (const j of boards){
    for (const ev of (j?.events||[])){
      const c=ev?.competitions?.[0]||{};
      const H=(c?.competitors||[]).find(x=>x.homeAway==='home')||{};
      const A=(c?.competitors||[]).find(x=>x.homeAway==='away')||{};
      out.push(fx({ sport:'Soccer', league: ev?.league?.name||ev?.name||'Football', startISO: ev?.date, status: statusFromEspn(ev),
                    home:{name:H?.team?.displayName||H?.team?.name, logo: takeLogo(H?.team)}, away:{name:A?.team?.displayName||A?.team?.name, logo: takeLogo(A?.team)} }));
    }
  }
  return out;
}
async function espnNBA(d){
  const j = await espnBoard('basketball/nba', d);
  return (j?.events||[]).map(ev => {
    const c=ev?.competitions?.[0]||{};
    const H=(c?.competitors||[]).find(x=>x.homeAway==='home')||{};
    const A=(c?.competitors||[]).find(x=>x.homeAway==='away')||{};
    return fx({ sport:'NBA', league:'NBA', startISO: ev?.date, status: statusFromEspn(ev),
                home:{name:H?.team?.displayName||H?.team?.name, logo: takeLogo(H?.team)}, away:{name:A?.team?.displayName||A?.team?.name, logo: takeLogo(A?.team)} });
  });
}
async function espnNFL(d){
  const j = await espnBoard('football/nfl', d);
  return (j?.events||[]).map(ev => {
    const c=ev?.competitions?.[0]||{};
    const H=(c?.competitors||[]).find(x=>x.homeAway==='home')||{};
    const A=(c?.competitors||[]).find(x=>x.homeAway==='away')||{};
    return fx({ sport:'NFL', league:'NFL', startISO: ev?.date, status: statusFromEspn(ev),
                home:{name:H?.team?.displayName||H?.team?.name, logo: takeLogo(H?.team)}, away:{name:A?.team?.displayName||A?.team?.name, logo: takeLogo(A?.team)} });
  });
}

// SportsDB day fallback
async function sdbDay(d, sportQuery, tag){
  try{
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${d}&s=${encodeURIComponent(sportQuery)}`;
    const r = await fetch(url, { timeout: 15000 });
    const j = await r.json();
    return (j?.events||[]).map(e => fx({
      sport: tag, league: e?.strLeague || '', startISO: e?.strTimestamp ? new Date(parseInt(e.strTimestamp,10)*1000).toISOString() : `${e?.dateEvent}T${(e?.strTime||'00:00')}:00Z`,
      status: (e?.strStatus||'').match(/(FT|Finish|Final)/i) ? 'FINISHED' : 'SCHEDULED',
      home:{ name: e?.strHomeTeam||'' }, away:{ name: e?.strAwayTeam||'' }
    }));
  }catch{ return []; }
}

// Manual fixtures (local + optional remote hourly)
const MANUAL_PATH = path.join(__dirname, 'data', 'manual-fixtures.json');
let MANUAL = {};
try{ if (fs.existsSync(MANUAL_PATH)) MANUAL = JSON.parse(fs.readFileSync(MANUAL_PATH,'utf-8')); }catch{}
let manualRemote = { last:0, json:{} };
async function manualFor(dateStr){
  if (MANUAL_URL){
    const now = Date.now();
    if (now - manualRemote.last > 60*60*1000){
      try{ const r = await fetch(MANUAL_URL, { timeout: 15000 }); if (r.ok) manualRemote = { last: now, json: await r.json() }; }catch{}
    }
  }
  const a = Array.isArray(MANUAL?.[dateStr]) ? MANUAL[dateStr] : [];
  const b = Array.isArray(manualRemote.json?.[dateStr]) ? manualRemote.json[dateStr] : [];
  return [...b, ...a].map(it => fx({
    sport: it.sport || 'Soccer',
    league: (it.league && (it.league.name || it.league)) || '',
    startISO: it.start_utc || `${dateStr}T00:00:00Z`,
    status: it.status || 'SCHEDULED',
    home: { name: it.home?.name || it.home || '' },
    away: { name: it.away?.name || it.away || '' }
  }));
}

// Image proxy
app.get('/img', async (req, res) => {
  try{
    const u = req.query.u; if (!u) return res.status(400).send('missing');
    const url = decodeURIComponent(u);
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) return res.status(404).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buf = await r.arrayBuffer();
    return res.end(Buffer.from(buf));
  }catch{ return res.status(502).end(); }
});

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

// API
app.get('/api/fixtures', async (req, res) => {
  const d = (req.query.date || '').toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
  const cached = readCache(d); if (cached) return res.json(cached);

  const [eu, all, nba, nfl, sdbS, sdbN, sdbF, man] = await Promise.all([
    espnSoccerEU(d), espnSoccer(d), espnNBA(d), espnNFL(d),
    sdbDay(d,'Soccer','Soccer'), sdbDay(d,'Basketball','NBA'), sdbDay(d,'American Football','NFL'),
    manualFor(d)
  ]);
  let merged = dedup([...eu, ...all, ...nba, ...nfl, ...sdbS, ...sdbN, ...sdbF, ...man]);
  merged = await enrich(merged);
  const payload = { meta: { date: d, sourceCounts: {
    espn_soccer_eu: eu.length, espn_soccer_all: all.length, espn_nba: nba.length, espn_nfl: nfl.length,
    sportsdb_soccer: sdbS.length, sportsdb_nba: sdbN.length, sportsdb_nfl: sdbF.length, manual: man.length
  } }, fixtures: merged };
  writeCache(d, payload);
  res.json(payload);
});

// Admin precache (GET/POST)
function auth(req,res){ const t = req.query.token || req.headers['x-admin-token']; if (!ADMIN_TOKEN || t !== ADMIN_TOKEN){ res.status(401).json({error:'unauthorized'}); return false;} return true; }
async function precache(d){ const payload = await (await fetch(`http://localhost:${process.env.PORT||3000}/api/fixtures?date=${d}`)).json().catch(()=>null); return payload || { meta:{ date:d }, fixtures:[] }; }
app.get('/admin/precache', async (req,res)=>{ if(!auth(req,res))return; const d=(req.query.date||'').toString(); if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({error:'invalid date'}); res.json(await precache(d)); });
app.post('/admin/precache', async (req,res)=>{ if(!auth(req,res))return; const d=(req.query.date||'').toString(); if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({error:'invalid date'}); res.json(await precache(d)); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('kixonair hotfix listening on :' + PORT));
