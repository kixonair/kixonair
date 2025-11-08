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

// ===== STATIC =====
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// ===== CONFIG =====
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const API_KEY = process.env.API_KEY || '';
const EU_LEAGUES = (process.env.EU_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
const FD_KEY = process.env.FD_KEY || '';
const SECONDARY_ON_EMPTY = (process.env.SECONDARY_ON_EMPTY || '0') === '1';
const SPORTSDB_ENABLED = (process.env.SPORTSDB_ENABLED ?? '0') !== '0'; // optional backup feeds
const FD_LEAGUES = (process.env.FD_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
const CPAGRIP_LOCKER_URL = process.env.CPAGRIP_LOCKER_URL || '';
const LOCKER_RETURN_PARAM = process.env.LOCKER_RETURN_PARAM || '';
const BASE_LEAGUES = (process.env.BASE_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
const TIER2_LEAGUES = (process.env.TIER2_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);

// ===== STRICT HOST CHECK (from README_HARDENING.md) =====
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();

  // when developing locally, skip
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return next();
  }

  // allow render internal
  const allowedHosts = new Set([
    'kixonair.com',
    'www.kixonair.com',
  ]);

  // Render often uses <service>.onrender.com
  const isRenderHost = host.endsWith('.onrender.com');

  if (!allowedHosts.has(host) && !isRenderHost) {
    return res.redirect(302, 'https://kixonair.com');
  }
  next();
});

app.use(cors());
app.use(express.json());

// === BEGIN: Kixonair API security gate ===
const OFFICIALS = new Set(['kixonair.com','www.kixonair.com']);
const API_KEY_EXPECT = API_KEY;

function secureFetchOk(req) {
  // check official origin
  const origin = (req.headers.origin || '').replace(/^https?:\/\//, '').toLowerCase();
  const host = (req.headers.host || '').toLowerCase();
  const sender = origin || host;

  if (OFFICIALS.has(sender)) return true;

  // or API key header
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (API_KEY_EXPECT && key === API_KEY_EXPECT) return true;

  // or an allowed custom origin from env
  if (ALLOW_ORIGINS.length && ALLOW_ORIGINS.includes(sender)) return true;

  return false;
}
// === END: Kixonair API security gate ===

// ====== UTILITIES ======
const fixturesCacheDir = path.join(__dirname, 'data', 'cache');
if (!fs.existsSync(fixturesCacheDir)) {
  fs.mkdirSync(fixturesCacheDir, { recursive: true });
}

function normalizeDateParam(str) {
  if (!str) return null;
  if (str === 'today') {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }
  // expect YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return null;
}

function readCache(dateStr) {
  const file = path.join(fixturesCacheDir, `${dateStr}.json`);
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function writeCache(dateStr, payload) {
  const file = path.join(fixturesCacheDir, `${dateStr}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }
}

async function httpGet(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), opts.timeout || 12000);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: controller.signal,
    });
    return r;
  } finally {
    clearTimeout(id);
  }
}

// ====== UPSTREAM FETCHERS (simplified from repo) ======

async function fetchEspn(dateStr) {
  // example ESPN-like endpoint (kept generic because repo had multiple sources)
  const url = `https://site.web.api.espn.com/apis/v2/sports/soccer/scoreboard?dates=${dateStr}`;
  const r = await httpGet(url).catch(() => null);
  if (!r || !r.ok) return [];
  const data = await r.json().catch(() => null);
  if (!data) return [];
  // normalize to our structure
  return (data.events || []).map(ev => ({
    source: 'espn',
    id: ev.id,
    name: ev.name,
    date: ev.date,
    competitions: ev.competitions || [],
  }));
}

async function fetchSportsDb(dateStr) {
  if (!SPORTSDB_ENABLED) return [];
  // TheSportsDB uses YYYY-MM-DD also
  const url = `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${dateStr}&s=Soccer`;
  const r = await httpGet(url).catch(() => null);
  if (!r || !r.ok) return [];
  const data = await r.json().catch(() => null);
  if (!data) return [];
  return (data.events || []).map(ev => ({
    source: 'sportsdb',
    id: ev.idEvent,
    name: ev.strEvent,
    date: ev.dateEvent,
    league: ev.strLeague,
  }));
}

// This function is the ONE place that actually builds the fixtures.
// Everything else (API routes, admin precache) should call THIS, not HTTP.
async function assembleFor(dateStr) {
  // get ESPN
  const primary = await fetchEspn(dateStr);

  // optionally get backup
  const secondary = SPORTSDB_ENABLED ? await fetchSportsDb(dateStr) : [];

  const fixtures = [...primary];

  if (SECONDARY_ON_EMPTY && fixtures.length === 0) {
    fixtures.push(...secondary);
  }

  return {
    ok: true,
    date: dateStr,
    count: fixtures.length,
    fixtures,
  };
}

// ====== IN-FLIGHT DEDUPE MAP ======
const inFlightFixtures = new Map();

// ====== ROUTES ======

// main fixtures endpoint
app.get(['/api/fixtures','/api/fixtures/:date'], async (req, res) => {
  try{
    const raw = req.params.date || req.query.date;
    const d = normalizeDateParam(raw);
    if (!d) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
    const force = (req.query.force === '1' || req.query.force === 'true');

    // if not forced, try disk cache first
    if (!force){
      const cached = readCache(d);
      if (cached) return res.json(cached);
    }

    // dedupe concurrent builds for the same date
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

    // forced refresh: always rebuild
    const payload = await assembleFor(d);
    writeCache(d, payload);
    res.json(payload);
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// remove cache (admin)
app.get('/admin/uncache', (req, res) => {
  try{
    const t = String(req.query.token || '');
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
    const d = normalizeDateParam(req.query.date || '');
    let removed = 0;
    if (!d) {
      // remove all
      if (fs.existsSync(fixturesCacheDir)) {
        for (const f of fs.readdirSync(fixturesCacheDir)) {
          fs.unlinkSync(path.join(fixturesCacheDir, f));
        }
        removed = 1;
      }
      return res.json({ ok:true, removed, date: null });
    }
    const file = path.join(__dirname, 'data', 'cache', `${d}.json`);
    if (d && fs.existsSync(file)){ fs.unlinkSync(file); removed = 1; }
    return res.json({ ok:true, removed, date: d || null });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// PREVIOUSLY this route HTTP-called itself and got blocked.
// Now it builds directly.
app.get('/admin/precache', async (req, res) => {
  try{
    const t = String(req.query.token || '');
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
    const d = normalizeDateParam(req.query.date || '');
    if (!d) return res.status(400).json({ ok:false, error:'invalid date' });

    // build directly, do not HTTP-call ourselves (avoids [BLOCKED apikey])
    const payload = await assembleFor(d);
    writeCache(d, payload);

    res.json(payload);
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[kixonair] up on :${PORT}`));
