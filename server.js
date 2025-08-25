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
const BUILD_TAG    = 'hotfix11-uefa-qual-variants';

// Try multiple ESPN segments for UCL (group + qualifying/playoffs) — ESPN changes these names.
const UEFA_VARIANTS = [
  'soccer/uefa.champions',
  'soccer/uefa.champions.qualifying',
  'soccer/uefa.champions.qual',
  'soccer/uefa.champions.playoff',
  'soccer/uefa.champions.play-offs',
  'soccer/uefa.champions.league'
];

// Big-5 domestic + Europa + Conference remain
const EU_LEAGUES = (process.env.EU_LEAGUES || [
  'soccer/uefa.europa','soccer/uefa.europa.conf',
  'soccer/eng.1','soccer/esp.1','soccer/ger.1','soccer/ita.1','soccer/fra.1',
  'soccer/por.1','soccer/ned.1','soccer/tur.1','soccer/bel.1','soccer/sco.1'
]).toString().split(',').map(s=>s.trim()).filter(Boolean);

// ====== HELPERS ======
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari';
async function httpGet(url, extra={}){
  try{
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' }, ...extra });
    return r;
  }catch(e){
    return { ok:false, status:0, json:async()=>({ error:String(e) }), text:async()=>String(e) };
  }
}
const yyyymmdd = d => d.replace(/-/g,'');
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
const dayOf = iso => {
  const t = new Date(iso);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth()+1).padStart(2,'0');
  const d = String(t.getUTCDate()).toString().padStart(2,'0');
  return `${y}-${m}-${d}`;
};
const fixLogo = u => u ? u.replace(/^http:/,'https:') : null;
const teamLogo = t => fixLogo(t?.logo || t?.logos?.[0]?.href || null);
function statusFromEspn(ev){
  const s = (ev?.status?.type?.name || ev?.status?.type?.description || '').toUpperCase();
  if (/FINAL|STATUS_FINAL|POSTGAME|FULLTIME|FT/.test(s)) return 'FINISHED';
  if (/IN_PROGRESS|LIVE|STATUS_IN_PROGRESS|STATUS_HALFTIME/.test(s)) return 'LIVE';
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
  const url = `https://site.api.espn.com/apis/site/v2/sports/${segment}/scoreboard?dates=${yyyymmdd(d)}`;
  const r = await httpGet(url);
  const j = r.ok ? await r.json() : { error: await r.text() };
  return { ok: r.ok, status: r.status, url, json: j };
}
function mapBoard(board, d, sport, fallbackLeague){
  const out = [];
  const j = board?.json || {};
  for (const ev of (j?.events || [])){
    const iso = ev?.date;
    if (!iso) continue;
    if (dayOf(iso) !== d) continue;
    const comp = ev?.competitions?.[0] || {};
    const H = (comp?.competitors || []).find(x => x.homeAway === 'home') || {};
    const A = (comp?.competitors || []).find(x => x.homeAway === 'away') || {};
    const leagueName = comp?.league?.name || ev?.league?.name || j?.leagues?.[0]?.name || fallbackLeague;
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
async function espnSoccerAll(d){
  const b = await espnBoard('soccer', d);
  return { mapped: mapBoard(b, d, 'Soccer', 'Football'), board: b };
}
async function espnSoccerEU(d){
  const segments = [...UEFA_VARIANTS, ...EU_LEAGUES];
  const boards = await Promise.all(segments.map(seg => espnBoard(seg, d)));
  const mapped = boards.flatMap(b => mapBoard(b, d, 'Soccer', 'Football'));
  return { mapped, boards };
}
async function espnNBA(d){ const b = await espnBoard('basketball/nba', d); return { mapped: mapBoard(b,d,'NBA','NBA'), board:b }; }
async function espnNFL(d){ const b = await espnBoard('football/nfl', d); return { mapped: mapBoard(b,d,'NFL','NFL'), board:b }; }

// ====== SportsDB fallback (Soccer) ======
function buildIsoFromSportsDB(e){
  const ts = e?.strTimestamp;
  if (ts && !isNaN(Date.parse(ts))) return ts;
  const dateOnly = e?.dateEvent || null;
  if (!dateOnly) return null;
  const time = (e?.strTime || '').toUpperCase();
  const hasValidTime = /^\d{2}:\d{2}(:\d{2})?$/.test(time);
  if (hasValidTime) return `${dateOnly}T${time.length===5? time+':00' : time}Z`;
  return `${dateOnly}T12:00:00Z`;
}
async function sportsdbDay(d){
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${d}&s=Soccer`;
  const r = await httpGet(url);
  const j = r.ok ? await r.json() : { error: await r.text() };
  const evs = j?.events || [];
  const out = [];
  for (const e of evs){
    const leagueName = e?.strLeague || 'Football';
    const iso = buildIsoFromSportsDB(e);
    if (!iso) continue;
    out.push(fx({
      sport: 'Soccer',
      league: leagueName,
      startISO: iso,
      status: 'SCHEDULED',
      home: { name: e?.strHomeTeam || '', logo: null },
      away: { name: e?.strAwayTeam || '', logo: null }
    }));
  }
  return { mapped: out, url };
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
    let ttl = 24*60*60*1000;
    if (d >= today) ttl = (d === today) ? 2*60*1000 : 10*60*1000;
    if (age > ttl) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }catch{ return null; }
}
function writeCache(d, payload){
  try{
    const arr = (payload && payload.fixtures) || [];
    if (!arr || arr.length === 0) return;
    fs.writeFileSync(cpath(d), JSON.stringify(payload));
  }catch{}
}

// ====== assemble & dedupe ======
function keyFor(f){
  return `${(f.sport||'').toLowerCase()}|${(f.league?.name||'').toLowerCase()}|${(f.home?.name||'').toLowerCase()}|${(f.away?.name||'').toLowerCase()}`;
}
function dedupePreferEarliest(fixtures){
  const groups = new Map();
  for (const f of fixtures){
    const k = keyFor(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const out = [];
  for (const arr of groups.values()){
    arr.sort((a,b) => (a.start_utc||'').localeCompare(b.start_utc||''));
    let best = arr[0];
    for (const cur of arr){
      const hasLogos = (cur.home?.logo || cur.away?.logo);
      const bestHasLogos = (best.home?.logo || best.away?.logo);
      if (hasLogos && !bestHasLogos) best = cur;
    }
    out.push(best);
  }
  out.sort((a,b) => (a.start_utc||'').localeCompare(b.start_utc||''));
  return out;
}

async function assembleFor(d, debug=false){
  const [eu, allSoc, nba, nfl] = await Promise.all([
    espnSoccerEU(d).catch(()=>({ mapped:[], boards:[] })),
    espnSoccerAll(d).catch(()=>({ mapped:[], board:null })),
    espnNBA(d).catch(()=>({ mapped:[], board:null })),
    espnNFL(d).catch(()=>({ mapped:[], board:null }))
  ]);
  let soccer = [...(eu.mapped||[]), ...(allSoc.mapped||[])];
  let sdb = { mapped: [] };
  if (soccer.length === 0){
    sdb = await sportsdbDay(d).catch(()=>({ mapped:[] }));
    soccer = [...(sdb.mapped||[])];
  }
  const merged = dedupePreferEarliest([ ...soccer, ...(nba.mapped||[]), ...(nfl.mapped||[]) ]);
  const meta = {
    date: d,
    sourceCounts: {
      espn_soccer_eu: eu.mapped?.length || 0,
      espn_soccer_all: allSoc.mapped?.length || 0,
      sportsdb_soccer: sdb.mapped?.length || 0,
      espn_nba: nba.mapped?.length || 0,
      espn_nfl: nfl.mapped?.length || 0
    }
  };
  if (debug){
    meta.debug = {
      urls: [
        ...(eu.boards||[]).map(b=>({ url:b.url, ok:b.ok, status:b.status })),
        allSoc.board ? { url: allSoc.board.url, ok: allSoc.board.ok, status: allSoc.board.status } : null,
        sdb.url ? { url: sdb.url, ok: true } : null
      ].filter(Boolean)
    };
  }
  return { meta, fixtures: merged };
}

// ====== ROUTES ======
app.get('/__/version', (req,res)=> res.json({ build: BUILD_TAG, ts: new Date().toISOString() }));
app.get('/__/probe', async (req, res) => {
  const d = normalizeDateParam(req.query.date || new Date().toISOString().slice(0,10)) || new Date().toISOString().slice(0,10);
  const debug = (req.query.debug === '1' || req.query.debug === 'true');
  const r = await assembleFor(d, debug);
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
  if (req.query.all === 'true' || req.query.all === '1'){
    let removed = 0;
    const dir = path.join(__dirname, 'data', 'cache');
    if (fs.existsSync(dir)){
      for (const f of fs.readdirSync(dir)){ fs.unlinkSync(path.join(dir,f)); removed++; }
    }
    return res.type('text/plain').send(`ok cleared\n-- -------\nTrue all`);
  }
  let removed = 0;
  const file = path.join(__dirname, 'data', 'cache', `${d}.json`);
  if (d && fs.existsSync(file)){ fs.unlinkSync(file); removed = 1; }
  return res.json({ ok:true, removed, date: d || null });
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
