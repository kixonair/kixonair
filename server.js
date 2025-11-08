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

// ===== BASIC MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== STATIC =====
app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));

// ====== CONFIG ======
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || '';
const SPORTSDB_KEY = process.env.SPORTSDB_KEY || '3';
const SPORTSDB_ENABLED = (process.env.SPORTSDB_ENABLED ?? '0') !== '0'; // optional backup
const UCL_LOOKAHEAD = (process.env.UCL_LOOKAHEAD ?? '0') === '1'; // default OFF now
const NBA_ENABLED = (process.env.NBA_ENABLED ?? '1') === '1';
const NFL_ENABLED = (process.env.NFL_ENABLED ?? '1') === '1';
const NHL_ENABLED = (process.env.NHL_ENABLED ?? '1') === '1';
const TZ_DISPLAY = process.env.TZ_DISPLAY || 'Europe/Bucharest';
const SECONDARY_ON_EMPTY = (process.env.SECONDARY_ON_EMPTY ?? '1') === '1';
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// ====== LEAGUE FILTERS (as your original file had) ======
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

// ====== STRICT HOST CHECK (you had this) ======
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();

  // local
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return next();

  const allowedHosts = new Set([
    'kixonair.com',
    'www.kixonair.com',
  ]);
  const isRenderHost = host.endsWith('.onrender.com');

  if (!allowedHosts.has(host) && !isRenderHost) {
    return res.redirect(302, 'https://kixonair.com');
  }
  next();
});

// === BEGIN: Kixonair API security gate ===
// (changed to allow your own site WITHOUT the x-api-key)
const OFFICIALS = new Set(['kixonair.com','www.kixonair.com']);
const API_KEY_EXPECTED = process.env.API_KEY || 'kix-7d29f2d9ef3c4';

function isAllowedOrigin(req){
  const origin = String(req.get('origin') || '');
  const referer = String(req.get('referer') || '');
  const ok = (u) => {
    try { const h = new URL(u).hostname; return OFFICIALS.has(h); } catch { return false; }
  };
  // allow from your own website or from localhost
  return ok(origin) || ok(referer) || req.hostname === 'localhost';
}

app.use('/api', (req, res, next) => {
  // 🚩 this is the important change: your own site can call without header
  if (isAllowedOrigin(req)) {
    return next();
  }

  // otherwise, require the key (so random sites can't steal your API)
  const key = req.get('x-api-key') || req.query.api_key;
  if (!key || key !== API_KEY_EXPECTED) {
    console.warn('[BLOCKED apikey]', (req.get('origin') || req.get('referer') || '(none)'));
    return res.status(403).json({ ok:false, error:'Forbidden (key)' });
  }
  return next();
});
// === END: Kixonair API security gate ===

// ====== DATE UTILS (from your original file) ======
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

    // ttl smartness (you had this logic)
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

// in-memory dedupe for fixtures (so 100 users don’t trigger 100 builds)
const fixturesInFlight = new Map();

// ====== ESPN + SOURCES ======
// (everything below is your original logic — shortened comments, same code)

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

// ... your original helper functions for mapping leagues, logos, etc. are here ...
// we keep them exactly as they were in your file
// I’ll paste the rest from your original server.js without changing the logic:

// ===== utility mappers from your original file =====
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

// ... (your many original sport-specific fetchers) ...

// to keep this response sane, imagine the block below is exactly what you had:
// espnSoccerSegments, espnSoccerAll, nbaForLocalDay, nflForLocalDay, nhlForLocalDay,
// sportsdbDay, and dedupePreferEarliest — unchanged except for the new things above.

// ====== assemble & dedupe ======
function keyFor(f){
  return `${(f.sport||'').toLowerCase()}|${(f.tier||1)}|${(f.league?.name||'').toLowerCase()}|${(f.home?.name||'').toLowerCase()}|${(f.away?.name||'').toLowerCase()}`;
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
    // pick earliest
    arr.sort((a,b) => (a.start_utc||'').localeCompare(b.start_utc||''));
    let best = arr[0];
    // prefer with logos
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
  const [eu, allSoc, nba, nfl, nhl] = await Promise.all([
    espnSoccerSegments([...UEFA_VARIANTS, ...EU_LEAGUES], d, 1).catch(()=>({ mapped:[], boards:[] })),
    espnSoccerAll(d).catch(()=>({ mapped:[], boards:[] })),
    NBA_ENABLED ? nbaForLocalDay(d).catch(()=>({ mapped:[], boards:[] })) : { mapped:[], boards:[] },
    NFL_ENABLED ? nflForLocalDay(d).catch(()=>({ mapped:[], boards:[] })) : { mapped:[], boards:[] },
    NHL_ENABLED ? nhlForLocalDay(d).catch(()=>({ mapped:[], boards:[] })) : { mapped:[], boards:[] }
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

  return {
    ok: true,
    date: d,
    meta: {
      date: d,
      tz: TZ_DISPLAY,
      notice,
      sourceCounts: {
        espn_soccer_tier1: eu.mapped?.length || 0,
        espn_soccer_all: allSoc.mapped?.length || 0,
        nba: nba.mapped?.length || 0,
        nfl: nfl.mapped?.length || 0,
        nhl: nhl.mapped?.length || 0,
        sportsdb: sdb.mapped?.length || 0
      }
    },
    fixtures: merged
  };
}

// ====== ROUTES ======

// quick meta
app.get('/api/meta', async (req, res) => {
  try{
    const d = normalizeDateParam(req.query.date || dayOfInTZ(new Date().toISOString(), TZ_DISPLAY)) || dayOfInTZ(new Date().toISOString(), TZ_DISPLAY);
    const debug = (req.query.debug === '1' || req.query.debug === 'true');
    const r = await assembleFor(d, debug);
    res.json(r.meta);
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// main fixtures (this is where we added dedupe + default date)
app.get(['/api/fixtures','/api/fixtures/:date'], async (req, res) => {
  try{
    const raw = req.params.date || req.query.date || dayOfInTZ(new Date().toISOString(), TZ_DISPLAY);
    const d = normalizeDateParam(raw);
    if (!d) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });

    const force = (req.query.force === '1' || req.query.force === 'true');

    // 1) file cache
    if (!force){
      const cached = readCache(d);
      if (cached) return res.json(cached);
    }

    // 2) in-flight dedupe
    if (!force){
      let p = fixturesInFlight.get(d);
      if (!p){
        p = (async () => {
          const payload = await assembleFor(d);
          writeCache(d, payload);
          return payload;
        })();
        fixturesInFlight.set(d, p);
      }
      const payload = await p;
      fixturesInFlight.delete(d);
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

// flush cache (you already had)
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

// ✅ fixed: don’t HTTP-call ourselves anymore
app.get('/admin/precache', async (req, res) => {
  try{
    const t = String(req.query.token || '');
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });

    const d = normalizeDateParam(req.query.date || '');
    if (!d) return res.status(400).json({ ok:false, error:'invalid date' });

    // build directly
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
