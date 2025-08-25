import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));

// ====== CONFIG ======
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || '';
const SPORTSDB_KEY = process.env.SPORTSDB_KEY || '3';
const BUILD_TAG    = 'hotfix7-minimal';

// Big 5 + UEFA scoreboards on ESPN (can be overridden by EU_LEAGUES env)
const EU_LEAGUES = (process.env.EU_LEAGUES || [
  'soccer/uefa.champions',
  'soccer/uefa.europa',
  'soccer/uefa.europa.conf',
  'soccer/eng.1', 'soccer/esp.1', 'soccer/ger.1', 'soccer/ita.1', 'soccer/fra.1',
  'soccer/por.1', 'soccer/ned.1', 'soccer/tur.1', 'soccer/bel.1', 'soccer/sco.1'
]).toString().split(',').map(s => s.trim()).filter(Boolean);

// ====== HELPERS ======
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari';
async function httpGet(url, extra={}){
  try{
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' }, ...extra });
    return r;
  }catch{
    return { ok:false, status:0, json:async()=>({}), text:async()=>'',
             arrayBuffer: async()=>new ArrayBuffer(0) };
  }
}

function normalizeDateParam(raw){
  if (!raw) return null;
  let s = String(raw).trim();
  const lower = s.toLowerCase();
  if (lower === 'today') return new Date().toISOString().slice(0,10);
  if (lower === 'tomorrow'){ const d = new Date(Date.now()+86400000); return d.toISOString().slice(0,10); }
  if (lower === 'yesterday'){ const d = new Date(Date.now()-86400000); return d.toISOString().slice(0,10); }
  s = s.replace(/[.\/]/g,'-').replace(/\s+/g,'-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
const YYYYMMDD = d => d.replace(/-/g,'');
const dayOf = iso => {
  const t = new Date(iso);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth()+1).padStart(2,'0');
  const d = String(t.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
};

function fixLogo(u){ return u ? u.replace(/^http:/,'https:') : null; }
function teamLogo(team){ return fixLogo(team?.logo || team?.logos?.[0]?.href || null); }
function statusFromEspn(ev){
  const s = (ev?.status?.type?.name || ev?.status?.type?.description || '').toUpperCase();
  if (/FINAL|STATUS_FINAL|POSTGAME|FULLTIME|FT/.test(s)) return 'FINISHED';
  if (/IN_PROGRESS|LIVE|STATUS_IN_PROGRESS/.test(s)) return 'LIVE';
  return 'SCHEDULED';
}
function fx({ sport, league, startISO, status, home, away }){
  return {
    sport,
    league: { name: league || 'Football', code: null },
    start_utc: startISO,
    status: status || 'SCHEDULED',
    home: { name: home?.name || '', logo: home?.logo || null },
    away: { name: away?.name || '', logo: away?.logo || null }
  };
}

// ====== ESPN fetch/mappers ======
async function espnBoard(segment, d){
  const url = `https://site.api.espn.com/apis/site/v2/sports/${segment}/scoreboard?dates=${YYYYMMDD(d)}`;
  const r = await httpGet(url);
  if (!r.ok) return { ok:false, status:r.status, events:[], leagues:[] };
  const j = await r.json(); j.ok = true; return j;
}
function mapSoccer(board, d){
  const out = [];
  for (const ev of (board?.events || [])){
    const iso = ev?.date; if (!iso || dayOf(iso) !== d) continue;
    const comp = ev?.competitions?.[0] || {};
    const H = (comp?.competitors || []).find(x => x.homeAway === 'home') || {};
    const A = (comp?.competitors || []).find(x => x.homeAway === 'away') || {};
    const leagueName = comp?.league?.name || board?.leagues?.[0]?.name || ev?.league?.name || 'Football';
    out.push(fx({
      sport: 'Soccer',
      league: leagueName,
      startISO: iso,
      status: statusFromEspn(ev),
      home: { name: H?.team?.displayName || H?.team?.name, logo: teamLogo(H?.team) },
      away: { name: A?.team?.displayName || A?.team?.name, logo: teamLogo(A?.team) }
    }));
  }
  return out;
}
function mapGeneric(board, d, sport, fallbackLeague){
  const out = [];
  for (const ev of (board?.events || [])){
    const iso = ev?.date; if (!iso || dayOf(iso) !== d) continue;
    const comp = ev?.competitions?.[0] || {};
    const H = (comp?.competitors || []).find(x => x.homeAway === 'home') || {};
    const A = (comp?.competitors || []).find(x => x.homeAway === 'away') || {};
    const leagueName = comp?.league?.name || ev?.league?.name || board?.leagues?.[0]?.name || fallbackLeague;
    out.push(fx({
      sport,
      league: leagueName,
      startISO: iso,
      status: statusFromEspn(ev),
      home: { name: H?.team?.displayName || H?.team?.name, logo: teamLogo(H?.team) },
      away: { name: A?.team?.displayName || A?.team?.name, logo: teamLogo(A?.team) }
    }));
  }
  return out;
}
async function espnSoccerEU(d){
  const boards = await Promise.all(EU_LEAGUES.map(seg => espnBoard(seg, d)));
  return boards.flatMap(b => mapSoccer(b, d));
}
async function espnNBA(d){
  const b = await espnBoard('basketball/nba', d);
  return mapGeneric(b, d, 'NBA', 'NBA');
}
async function espnNFL(d){
  const b = await espnBoard('football/nfl', d);
  return mapGeneric(b, d, 'NFL', 'NFL');
}

// ====== CACHE ======
const CACHE_DIR = path.join(__dirname, 'data', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cpath = (d) => path.join(CACHE_DIR, `${d}.json`);
function readCache(d){
  try{
    const file = cpath(d);
    if (!fs.existsSync(file)) return null;
    const now = Date.now();
    const stat = fs.statSync(file);
    const age = now - stat.mtimeMs;
    const today = new Date().toISOString().slice(0,10);
    let ttl = 24*60*60*1000; // past 24h
    if (d >= today) ttl = (d === today) ? 2*60*1000 : 10*60*1000; // today 2m, future 10m
    if (age > ttl) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }catch{ return null; }
}
function writeCache(d, payload){
  try{
    const arr = (payload && payload.fixtures) || [];
    if (!arr || arr.length === 0) return;  // skip empty-day poisoning
    fs.writeFileSync(cpath(d), JSON.stringify(payload));
  }catch{}
}

// ====== ASSEMBLE ======
async function assembleFor(d){
  const [soccer, nba, nfl] = await Promise.all([
    espnSoccerEU(d).catch(()=>[]),
    espnNBA(d).catch(()=>[]),
    espnNFL(d).catch(()=>[])
  ]);
  const fixtures = [...soccer, ...nba, ...nfl].sort((a,b) => (a.start_utc||'').localeCompare(b.start_utc||''));
  const meta = {
    date: d,
    sourceCounts: {
      espn_soccer_eu: soccer.length,
      espn_nba: nba.length,
      espn_nfl: nfl.length
    }
  };
  return { meta, fixtures };
}

// ====== ROUTES ======
app.get('/__/version', (req,res)=> res.json({ build: BUILD_TAG, ts: new Date().toISOString() }));

app.get('/__/probe', async (req, res) => {
  const d = normalizeDateParam(req.query.date || new Date().toISOString().slice(0,10)) || new Date().toISOString().slice(0,10);
  const r = await assembleFor(d);
  res.json(r.meta);
});

app.get(['/api/fixtures','/api/fixtures/:date'], async (req, res) => {
  const raw = req.params.date || req.query.date;
  const d = normalizeDateParam(raw);
  if (!d) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
  const force = (req.query.force === '1' || req.query.force === 'true');
  if (!force){
    const cached = readCache(d);
    if (cached) return res.json(cached);
  }
  const payload = await assembleFor(d);
  writeCache(d, payload);
  res.json(payload);
});

app.post('/admin/flush-cache', (req, res) => {
  const t = String(req.query.token || '');
  if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
  const d = normalizeDateParam(req.query.date || '');
  let count = 0;
  if (req.query.all === 'true' || req.query.all === '1'){
    for (const f of fs.readdirSync(CACHE_DIR)){
      fs.unlinkSync(path.join(CACHE_DIR, f)); count++;
    }
    return res.type('text/plain').send(`ok cleared\n-- -------\nTrue all`);
  }
  if (d && fs.existsSync(cpath(d))){ fs.unlinkSync(cpath(d)); count=1; }
  return res.json({ ok:true, removed: count, date: d || null });
});

app.get('/admin/precache', async (req, res) => {
  const t = String(req.query.token || '');
  if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
  const d = normalizeDateParam(req.query.date || '');
  if (!d) return res.status(400).json({ ok:false, error:'invalid date' });
  const r = await (await httpGet(`${req.protocol}://${req.get('host')}/api/fixtures/${d}?force=1`)).json().catch(()=>null);
  res.json(r || { ok:false });
});

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[kixonair] up on :${PORT}`));
