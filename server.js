// server.js
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

// --------------------------------------------------
// BASIC HEALTH (Render checks this)
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// --------------------------------------------------
// STATIC
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// --------------------------------------------------
// ENV
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const API_KEY = process.env.API_KEY || '';
const SECONDARY_ON_EMPTY = (process.env.SECONDARY_ON_EMPTY || '0') === '1';
const SPORTSDB_ENABLED = (process.env.SPORTSDB_ENABLED || '0') !== '0';

// --------------------------------------------------
// SAME-HOST PROTECTION (keep it, but it’s not the problem)
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();

  // local dev
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return next();
  }

  const allowedHosts = new Set([
    'kixonair.com',
    'www.kixonair.com'
  ]);

  const isRenderHost = host.endsWith('.onrender.com');

  if (!allowedHosts.has(host) && !isRenderHost) {
    return res.redirect(302, 'https://kixonair.com');
  }
  next();
});

app.use(cors());
app.use(express.json());

// --------------------------------------------------
// FILE CACHE
const fixturesCacheDir = path.join(__dirname, 'data', 'cache');
if (!fs.existsSync(fixturesCacheDir)) {
  fs.mkdirSync(fixturesCacheDir, { recursive: true });
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function normalizeDateParam(str) {
  if (!str) return null;
  if (str === 'today') return todayISO();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return null;
}

function readCache(dateStr) {
  const file = path.join(fixturesCacheDir, `${dateStr}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeCache(dateStr, payload) {
  const file = path.join(fixturesCacheDir, `${dateStr}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

async function httpGet(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), opts.timeout || 12000);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: controller.signal
    });
    return r;
  } finally {
    clearTimeout(id);
  }
}

// --------------------------------------------------
// UPSTREAMS (simple versions)
async function fetchEspn(dateStr) {
  // this is a placeholder — same as before
  const url = `https://site.web.api.espn.com/apis/v2/sports/soccer/scoreboard?dates=${dateStr}`;
  const r = await httpGet(url).catch(() => null);
  if (!r || !r.ok) return [];
  const data = await r.json().catch(() => null);
  if (!data) return [];
  return (data.events || []).map(ev => ({
    source: 'espn',
    id: ev.id,
    name: ev.name,
    date: ev.date,
    competitions: ev.competitions || []
  }));
}

async function fetchSportsDb(dateStr) {
  if (!SPORTSDB_ENABLED) return [];
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
    league: ev.strLeague
  }));
}

// build fixtures ONCE here
async function assembleFor(dateStr) {
  const primary = await fetchEspn(dateStr);
  const secondary = SPORTSDB_ENABLED ? await fetchSportsDb(dateStr) : [];

  const fixtures = [...primary];
  if (SECONDARY_ON_EMPTY && fixtures.length === 0) {
    fixtures.push(...secondary);
  }

  return {
    ok: true,
    date: dateStr,
    count: fixtures.length,
    fixtures
  };
}

// --------------------------------------------------
// IN-FLIGHT DEDUPE
const inFlightFixtures = new Map();

// --------------------------------------------------
// API ROUTES

// main fixtures
app.get(['/api/fixtures', '/api/fixtures/:date'], async (req, res) => {
  try {
    // ✅ default to today if no date was sent
    const raw = req.params.date || req.query.date || 'today';
    const d = normalizeDateParam(raw);
    if (!d) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });

    const force = req.query.force === '1' || req.query.force === 'true';

    // try disk first
    if (!force) {
      const cached = readCache(d);
      if (cached) return res.json(cached);
    }

    if (!force) {
      // dedupe concurrent
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

    // forced build
    const payload = await assembleFor(d);
    writeCache(d, payload);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// clear cache
app.get('/admin/uncache', (req, res) => {
  try {
    const t = String(req.query.token || '');
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const d = normalizeDateParam(req.query.date || '');
    if (!d) {
      // wipe all
      for (const f of fs.readdirSync(fixturesCacheDir)) {
        fs.unlinkSync(path.join(fixturesCacheDir, f));
      }
      return res.json({ ok: true, removed: 'all' });
    }

    const file = path.join(fixturesCacheDir, `${d}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return res.json({ ok: true, removed: d });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ precache WITHOUT calling https://kixonair.com/ (this was the log spam)
app.get('/admin/precache', async (req, res) => {
  try {
    const t = String(req.query.token || '');
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const raw = req.query.date || 'today';
    const d = normalizeDateParam(raw);
    if (!d) {
      return res.status(400).json({ ok: false, error: 'invalid date' });
    }

    const payload = await assembleFor(d);
    writeCache(d, payload);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------------------------------------------
// START
const PORT = process.env.PORT || 10000; // Render often uses 10000
app.listen(PORT, () => {
  console.log(`[kixonair] up on :${PORT}`);
});
