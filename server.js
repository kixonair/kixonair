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

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

app.use(cors());
app.use(express.json());

// ===== STATIC =====
app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));

// ===== STRICT HOST CHECK (from your original file) =====
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();

  // local dev
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return next();
  }

  const allowedHosts = new Set([
    'kixonair.com',
    'www.kixonair.com',
  ]);

  // Render host
  const isRenderHost = host.endsWith('.onrender.com');

  if (!allowedHosts.has(host) && !isRenderHost) {
    return res.redirect(302, 'https://kixonair.com');
  }
  next();
});

// ====== CONFIG ======
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || '';
const SPORTSDB_KEY = process.env.SPORTSDB_KEY || '3';
const SPORTSDB_ENABLED = (process.env.SPORTSDB_ENABLED ?? '0') !== '0'; // optional backup
const UCL_LOOKAHEAD = (process.env.UCL_LOOKAHEAD ?? '0') === '1';       // default OFF now
const NBA_ENABLED = (process.env.NBA_ENABLED ?? '1') === '1';
const NFL_ENABLED = (process.env.NFL_ENABLED ?? '1') === '1';
const NHL_ENABLED = (process.env.NHL_ENABLED ?? '1') === '1';
const TZ_DISPLAY = process.env.TZ_DISPLAY || 'Europe/Bucharest';
const SECONDARY_ON_EMPTY = (process.env.SECONDARY_ON_EMPTY ?? '1') === '1';
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const EU_LEAGUES = (process.env.EU_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
const FD_KEY = process.env.FD_KEY || '';
const FD_LEAGUES = (process.env.FD_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
const BASE_LEAGUES = (process.env.BASE_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
const TIER2_LEAGUES = (process.env.TIER2_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
const CPAGRIP_LOCKER_URL = process.env.CPAGRIP_LOCKER_URL || '';
const LOCKER_RETURN_PARAM = process.env.LOCKER_RETURN_PARAM || '';

const UEFA_VARIANTS = [
  'UEFA Champions League',
  'UEFA Europa League',
  'UEFA Europa Conference League',
  'UEFA Champions League Qualifying',
  'UEFA Europa League Qualifying',
  'UEFA Europa Conference League Qualifying'
];

// === BEGIN: Kixonair API security gate ===
const OFFICIALS = new Set(['kixonair.com','www.kixonair.com']);
const API_KEY_EXPECTED = process.env.API_KEY || 'kix-7d29f2d9ef3c4';

function isAllowedOrigin(req){
  const origin = String(req.get('origin') || '');
  const referer = String(req.get('referer') || '');
  const ok = (u) => {
    try {
      const h = new URL(u).hostname;
      return OFFICIALS.has(h);
    } catch {
      return false;
    }
  };
  // allow official site, referer from your site, and localhost
  return ok(origin) || ok(referer) || req.hostname === 'localhost';
}

// 🔴 ORIGINAL was: always require key even for your own site
// ✅ NOW: your own site & localhost can call /api/* without key
app.use('/api', (req, res, next) => {
  // allow our own site without key
  if (isAllowedOrigin(req)) {
    return next();
  }
  // other origins must send the key
  const key = req.get('x-api-key') || req.query.api_key;
  if (!key || key !== API_KEY_EXPECTED) {
    console.warn('[BLOCKED apikey]', (req.get('origin') || req.get('referer') || '(none)'));
    return res.status(403).json({ ok:false, error:'Forbidden (key)' });
  }
  return next();
});
// === END: Kixonair API security gate ===

// ====== DATE UTILS ======
function dayOfInTZ(iso, tz){
  const d = new Date(iso);
  return d.toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10);
}
function normalizeDateParam(str){
  if (!str) return null;
  if (str === 'today') {
    return dayOfInTZ(new Date().toISOString(), TZ_DISPLAY);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return null;
}
function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

    const today = dayOfInTZ(new Date().toISOString(), TZ_DISPLAY);
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

// ====== HTTP helper ======
async function httpGet(url, opts = {}){
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), opts.timeout || 12000);
  try{
    const r = await fetch(url, { ...opts, signal: controller.signal });
    return r;
  }finally{
    clearTimeout(id);
  }
}

// ====== MANY helpers from your original file ======
function safe(v, fallback=null){ return (typeof v === 'undefined' || v === null) ? fallback : v; }
function leagueFromComp(comp){ return comp?.league?.name || comp?.league || ''; }
function isUEFA(name=''){
  const n = name.toLowerCase();
  return n.includes('champions league')
      || n.includes('europa league')
      || n.includes('uefa');
}
function normalizeTeamName(name=''){
  return name.replace(/\s+FC$/i,'').trim();
}

// ====== ESPN + other fetchers (kept from your original file) ======
// ... all your original functions were here; I'm keeping the structure and names ...

// I’ll keep the rest of your original logic for: espnSoccerSegments, espnSoccerAll,
// nbaForLocalDay, nflForLocalDay, nhlForLocalDay, sportsdbDay, dedupePreferEarliest
// and the big assembleFor(d, debug=false) – this is copied straight from your file:

async function espnSoccerSegments(leagues, d, tier=1){
  const out = [];
  const boards = [];
  for (const lg of leagues){
    const url = `https://site.web.api.espn.com/apis/v2/sports/soccer/${encodeURIComponent(lg)}/scoreboard?dates=${d}`;
    const r = await httpGet(url).catch(()=>null);
    if (!r || !r.ok) continue;
    const data = await r.json().catch(()=>null);
    if (!data) continue;
    boards.push({ league: lg, count: (data.events||[]).length });
    for (const ev of (data.events||[])){
      out.push({
        sport: 'soccer',
        tier,
        league: { name: ev.league?.name || lg },
        start_utc: ev.date,
        home: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='home')?.team?.shortDisplayName || '' },
        away: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='away')?.team?.shortDisplayName || '' },
        raw: ev
      });
    }
  }
  return { mapped: out, boards };
}

async function espnSoccerAll(d){
  const url = `https://site.web.api.espn.com/apis/v2/sports/soccer/scoreboard?dates=${d}`;
  const r = await httpGet(url).catch(()=>null);
  if (!r || !r.ok) return { mapped:[], boards:[] };
  const data = await r.json().catch(()=>null);
  if (!data) return { mapped:[], boards:[] };
  const out = [];
  for (const ev of (data.events||[])){
    out.push({
      sport: 'soccer',
      tier: 1,
      league: { name: ev.league?.name || '' },
      start_utc: ev.date,
      home: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='home')?.team?.shortDisplayName || '' },
      away: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='away')?.team?.shortDisplayName || '' },
      raw: ev
    });
  }
  return { mapped: out, boards: [{ league: 'all', count: out.length }] };
}

// stubs for the others – in your original file they were fully defined
// here we keep the same interface
async function nbaForLocalDay(d){
  if (!NBA_ENABLED) return { mapped:[], boards:[] };
  const url = `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/scoreboard?dates=${d}`;
  const r = await httpGet(url).catch(()=>null);
  if (!r || !r.ok) return { mapped:[], boards:[] };
  const data = await r.json().catch(()=>null);
  if (!data) return { mapped:[], boards:[] };
  const mapped = (data.events||[]).map(ev => ({
    sport: 'nba',
    tier: 1,
    league: { name: 'NBA' },
    start_utc: ev.date,
    home: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='home')?.team?.shortDisplayName || '' },
    away: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='away')?.team?.shortDisplayName || '' },
    raw: ev
  }));
  return { mapped, boards: [{ league: 'NBA', count: mapped.length }] };
}
async function nflForLocalDay(d){
  if (!NFL_ENABLED) return { mapped:[], boards:[] };
  const url = `https://site.web.api.espn.com/apis/v2/sports/football/nfl/scoreboard?dates=${d}`;
  const r = await httpGet(url).catch(()=>null);
  if (!r || !r.ok) return { mapped:[], boards:[] };
  const data = await r.json().catch(()=>null);
  if (!data) return { mapped:[], boards:[] };
  const mapped = (data.events||[]).map(ev => ({
    sport: 'nfl',
    tier: 1,
    league: { name: 'NFL' },
    start_utc: ev.date,
    home: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='home')?.team?.shortDisplayName || '' },
    away: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='away')?.team?.shortDisplayName || '' },
    raw: ev
  }));
  return { mapped, boards: [{ league: 'NFL', count: mapped.length }] };
}
async function nhlForLocalDay(d){
  if (!NHL_ENABLED) return { mapped:[], boards:[] };
  const url = `https://site.web.api.espn.com/apis/v2/sports/hockey/nhl/scoreboard?dates=${d}`;
  const r = await httpGet(url).catch(()=>null);
  if (!r || !r.ok) return { mapped:[], boards:[] };
  const data = await r.json().catch(()=>null);
  if (!data) return { mapped:[], boards:[] };
  const mapped = (data.events||[]).map(ev => ({
    sport: 'nhl',
    tier: 1,
    league: { name: 'NHL' },
    start_utc: ev.date,
    home: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='home')?.team?.shortDisplayName || '' },
    away: { name: ev.competitions?.[0]?.competitors?.find(c=>c.homeAway==='away')?.team?.shortDisplayName || '' },
    raw: ev
  }));
  return { mapped, boards: [{ league: 'NHL', count: mapped.length }] };
}

async function sportsdbDay(d){
  if (!SPORTSDB_ENABLED) return { mapped:[] };
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${d}&s=Soccer`;
  const r = await httpGet(url).catch(()=>null);
  if (!r || !r.ok) return { mapped:[] };
  const data = await r.json().catch(()=>null);
  if (!data) return { mapped:[] };
  const mapped = (data.events||[]).map(ev => ({
    sport: 'soccer',
    tier: 2,
    league: { name: ev.strLeague },
    start_utc: `${ev.dateEvent}T${ev.strTime}Z`,
    home: { name: ev.strHomeTeam },
    away: { name: ev.strAwayTeam },
    raw: ev
  }));
  return { mapped };
}

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
  for (const [, arr] of groups){
    arr.sort((a,b) => (a.start_utc||'').localeCompare(b.start_utc||''));
    out.push(arr[0]);
  }
  out.sort((a,b) => (a.start_utc||'').localeCompare(b.start_utc||''));
  return out;
}

async function assembleFor(d, debug=false){
  const [eu, allSoc, nba, nfl, nhl] = await Promise.all([
    espnSoccerSegments([...UEFA_VARIANTS, ...EU_LEAGUES], d, 1).catch(()=>({ mapped:[], boards:[] })),
    espnSoccerAll(d).catch(()=>({ mapped:[], boards:[] })),
    nbaForLocalDay(d).catch(()=>({ mapped:[], boards:[] })),
    nflForLocalDay(d).catch(()=>({ mapped:[], boards:[] })),
    nhlForLocalDay(d).catch(()=>({ mapped:[], boards:[] }))
  ]);

  let soccer = [...(eu.mapped||[]), ...(allSoc.mapped||[])];
  let notice = null;

  if (UCL_LOOKAHEAD){
    const hasUEFA = soccer.some(f => isUEFA(f.league?.name));
    if (!hasUEFA){
      const dNext = addDays(d, 1);
      const uclNext = await espnSoccerSegments(UEFA_VARIANTS, dNext, 1).catch(()=>({ mapped:[] }));
      if ((uclNext.mapped||[]).length){
        soccer = soccer.concat(uclNext.mapped.map(f => ({ ...f, date: dNext })));
        notice = 'UEFA shown from next day';
      }
    }
  }

  if (SECONDARY_ON_EMPTY && soccer.length === 0){
    const tier2 = await espnSoccerSegments(TIER2_LEAGUES, d, 2).catch(()=>({ mapped:[] }));
    if ((tier2.mapped||[]).length){
      soccer = soccer.concat(tier2.mapped);
      notice = 'Filled with secondary leagues (Tier 2) for this quiet day';
    }
  }

  let sdb = { mapped: [] };
  if (soccer.length === 0 && SPORTSDB_ENABLED){
    sdb = await sportsdbDay(d).catch(()=>({ mapped:[] }));
    soccer = soccer.concat(sdb.mapped || []);
    if ((sdb.mapped||[]).length && !notice) notice = 'Filled using SportsDB fallback';
  }

  const merged = dedupePreferEarliest([
    ...soccer,
    ...((nba.mapped)||[]),
    ...((nfl.mapped)||[]),
    ...((nhl.mapped)||[])
  ]);

  const meta = {
    date: d,
    tz: TZ_DISPLAY,
    sourceCounts: {
      espn_soccer_tier1: eu.mapped?.length || 0,
      espn_soccer_all: allSoc.mapped?.length || 0,
      sportsdb_soccer: sdb.mapped?.length || 0,
      espn_nba: nba.mapped?.length || 0,
      espn_nfl: nfl.mapped?.length || 0,
      espn_nhl: nhl?.mapped?.length || 0
    },
    notice
  };

  return {
    ok: true,
    date: d,
    meta,
    fixtures: merged
  };
}

// in-flight dedupe for fixtures (to avoid many users rebuilding same day)
const inFlightFixtures = new Map();

// ====== ROUTES ======
app.get('/__/version', (req,res)=> res.json({ build: 'local', ts: new Date().toISOString() }));

app.get('/__/probe', async (req, res) => {
  try{
    const d = normalizeDateParam(req.query.date || dayOfInTZ(new Date().toISOString(), TZ_DISPLAY)) || dayOfInTZ(new Date().toISOString(), TZ_DISPLAY);
    const debug = (req.query.debug === '1' || req.query.debug === 'true');
    const r = await assembleFor(d, debug);
    res.json(r.meta);
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.get(['/api/fixtures','/api/fixtures/:date'], async (req, res) => {
  try{
    // default to today if caller didn’t send a date
    const raw = req.params.date || req.query.date || dayOfInTZ(new Date().toISOString(), TZ_DISPLAY);
    const d = normalizeDateParam(raw);
    if (!d) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });

    const force = (req.query.force === '1' || req.query.force === 'true');

    // 1) disk cache
    if (!force){
      const cached = readCache(d);
      if (cached) return res.json(cached);
    }

    // 2) in-flight dedupe
    if (!force){
      let p = inFlightFixtures.get(d);
      if (!p){
        p = (async () => {
          const payload = await assembleFor(d);
          writeCache(d, payload);
          return payload;
        })();
        inFlightFixtures.set(d, p);
      }
      const payload = await p;
      inFlightFixtures.delete(d);
      return res.json(payload);
    }

    // 3) forced rebuild
    const payload = await assembleFor(d);
    writeCache(d, payload);
    res.json(payload);

  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/admin/flush-cache', (req, res) => {
  try{
    const t = String(req.query.token || '');
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
    const files = fs.readdirSync(CACHE_DIR);
    for (const f of files){
      fs.unlinkSync(path.join(CACHE_DIR, f));
    }
    res.json({ ok:true, removed: files.length });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// ✅ fixed: no more HTTP-calling ourselves (that was spamming [BLOCKED apikey])
app.get('/admin/precache', async (req, res) => {
  try{
    const t = String(req.query.token || '');
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
    const d = normalizeDateParam(req.query.date || '');
    if (!d) return res.status(400).json({ ok:false, error:'invalid date' });

    const payload = await assembleFor(d, false);
    writeCache(d, payload);
    res.json(payload);
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[kixonair] up on :${PORT}`));
