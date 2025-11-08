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
const inFlightFixtures = new Map(); // <– new: prevent many parallel builds

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// ===== BASIC MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== STATIC =====
app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));

// ===== STRICT HOST CHECK (your original) =====
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


// === BEGIN: Kixonair API security gate (RELAXED) ===
const OFFICIALS = new Set(['kixonair.com','www.kixonair.com']);
const API_KEY_EXPECTED = process.env.API_KEY || 'kix-7d29f2d9ef3c4';

// allow our own site, localhost, and render host even if no header/key
function isFromOwnSite(req) {
  const origin = req.get('origin') || req.get('referer') || '';
  const host = (req.headers.host || '').toLowerCase().split(':')[0];
  if (OFFICIALS.has(host)) return true;
  if (origin.includes('kixonair.com')) return true;
  return host.endsWith('.onrender.com');
}

app.use('/api', (req, res, next) => {
  // if request looks like it came from our own domain, allow it
  if (isFromOwnSite(req)) {
    return next();
  }
  // otherwise, require key (so random sites can’t steal it)
  const key = req.get('x-api-key') || req.query.api_key;
  if (key && key === API_KEY_EXPECTED) {
    return next();
  }
  console.warn('[BLOCKED apikey]', (req.get('origin') || req.get('referer') || '(none)'));
  return res.status(403).json({ ok:false, error:'Forbidden' });
});
// === END: Kixonair API security gate ===


// ====== CONFIG ======
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || '';
const SPORTSDB_KEY = process.env.SPORTSDB_KEY || '3';
const SPORTSDB_ENABLED = (process.env.SPORTSDB_ENABLED ?? '0') !== '0';
const UCL_LOOKAHEAD = (process.env.UCL_LOOKAHEAD ?? '0') === '1';
const NBA_ENABLED = (process.env.NBA_ENABLED ?? '1') === '1';
const NFL_ENABLED = (process.env.NFL_ENABLED ?? '1') === '1';
const NHL_ENABLED = (process.env.NHL_ENABLED ?? '1') === '1';
const TZ_DISPLAY = process.env.TZ_DISPLAY || 'Europe/Bucharest';
const SECONDARY_ON_EMPTY = (process.env.SECONDARY_ON_EMPTY ?? '1') === '1';
const FD_KEY = process.env.FD_KEY || '';
const CPAGRIP_LOCKER_URL = process.env.CPAGRIP_LOCKER_URL || '';
const LOCKER_RETURN_PARAM = process.env.LOCKER_RETURN_PARAM || '';

// ====== LEAGUES (same as your file) ======
function parseListEnv(val, fallbackList){
  const raw = (val ?? '').toString();
  const parts = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const list = (parts.length ? parts : fallbackList).map(s => s.trim()).filter(Boolean);
  return Array.from(new Set(list));
}

const UEFA_VARIANTS = [
  'soccer/uefa.champions',
  'soccer/uefa.champions_qual',
  'soccer/uefa.champions.qualifying',
  'soccer/uefa.champions.qual',
  'soccer/uefa.champions.playoff',
  'soccer/uefa.champions.play-offs',
  'soccer/uefa.champions.league'
];

const EU_LEAGUES = parseListEnv(process.env.EU_LEAGUES, [
  'soccer/eng.1','soccer/esp.1','soccer/ger.1','soccer/ita.1','soccer/fra.1',
  'soccer/por.1','soccer/ned.1','soccer/tur.1','soccer/bel.1','soccer/sco.1'
]);

const TIER2_LEAGUES = parseListEnv(process.env.TIER2_LEAGUES, [
  'soccer/eng.2','soccer/esp.2','soccer/ger.2','soccer/ita.2','soccer/fra.2'
]);

// ====== UTILS (all from your file, unchanged) ======
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari';

async function httpGet(url, extra={}){
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try{
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' }, signal: controller.signal, ...extra });
    return r;
  }catch(e){
    return { ok:false, status:0, json:async()=>({ error:String(e) }), text:async()=>String(e) };
  }finally{
    clearTimeout(timeout);
  }
}

function dayOfInTZ(iso, tz){
  try{
    const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
    const parts = dtf.formatToParts(new Date(iso));
    const y = parts.find(p=>p.type==='year')?.value;
    const m = parts.find(p=>p.type==='month')?.value;
    const d = parts.find(p=>p.type==='day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  }catch{}
  return new Date(iso).toISOString().slice(0,10);
}

function normalizeDateParam(raw){
  if (!raw) return null;
  let s = String(raw).trim();
  const lower = s.toLowerCase();
  if (lower === 'today') return dayOfInTZ(new Date().toISOString(), TZ_DISPLAY);
  if (lower === 'tomorrow'){
    const now = new Date();
    now.setUTCDate(now.getUTCDate()+1);
    return dayOfInTZ(now.toISOString(), TZ_DISPLAY);
  }
  if (lower === 'yesterday'){
    const now = new Date();
    now.setUTCDate(now.getUTCDate()-1);
    return dayOfInTZ(now.toISOString(), TZ_DISPLAY);
  }
  s = s.replace(/[.\/]/g,'-').replace(/\s+/g,'-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// ====== DISK CACHE (your original) ======
const CACHE_DIR = path.join(__dirname, 'data', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function cpath(d){ return path.join(CACHE_DIR, `${d}.json`); }

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

// ====== ESPN + SPORTSDB fetchers ======
// (I’m keeping your original ones here — I didn’t delete them)
// ... your original long fetch/mapping code stays the same ...

// ====== assembleFor (your original) ======
// ... unchanged — calls espnSoccerSegments, espnSoccerAll, nbaForLocalDay, etc ...

// (I’m not re-pasting the 200+ lines of your original assemble code here in this explanation,
// but in your actual file, keep that whole block exactly as it was.)

// ====== ROUTES ======

// /__/version etc. stay the same if you had them

// ✅ /api/fixtures — now date is OPTIONAL + deduped
app.get(['/api/fixtures','/api/fixtures/:date'], async (req, res) => {
  try {
    const raw = req.params.date || req.query.date || 'today';
    const d = normalizeDateParam(raw);
    if (!d) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
    const force = (req.query.force === '1' || req.query.force === 'true');

    // disk cache first
    if (!force) {
      const cached = readCache(d);
      if (cached) return res.json(cached);
    }

    // anti “thundering herd”
    if (!force) {
      let p = inFlightFixtures.get(d);
      if (!p) {
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

    // forced rebuild
    const payload = await assembleFor(d);
    writeCache(d, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// ✅ admin precache — NO self-HTTP call anymore
app.get('/admin/precache', async (req, res) => {
  try {
    const t = String(req.query.token || '');
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
    const d = normalizeDateParam(req.query.date || 'today');
    if (!d) return res.status(400).json({ ok:false, error:'invalid date' });

    const payload = await assembleFor(d);
    writeCache(d, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// ====== START ======
app.listen(PORT, () => console.log(`[kixonair] up on :${PORT}`));
