// server.js – simplified / fast version for kixonair
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
// BASIC MIDDLEWARE
// --------------------------------------------------
app.use(cors());
app.use(express.json());

// serve frontend if present
app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));

// --------------------------------------------------
// CONFIG
// --------------------------------------------------
const PORT = process.env.PORT || 10000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TZ_DISPLAY = process.env.TZ_DISPLAY || 'Europe/Bucharest';
const SPORTSDB_ENABLED = (process.env.SPORTSDB_ENABLED || '0') !== '0';

// we’ll hit fewer leagues so it’s faster
const MAIN_SOCCER_SEGMENTS = [
  'soccer',          // all soccer
  'soccer/eng.1',    // EPL
  'soccer/esp.1',    // LaLiga
  'soccer/ita.1',    // Serie A
  'soccer/ger.1',    // Bundesliga
  'soccer/fra.1',    // Ligue 1
  'soccer/uefa.champions', // UCL
];

const CACHE_DIR = path.join(__dirname, 'data', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// in-memory cache: { key: { expires, data } }
const memCache = new Map();
const MEM_TTL_MS = 60 * 1000; // 1 minute

// --------------------------------------------------
// SMALL UTILS
// --------------------------------------------------
function todayTZ(tz = TZ_DISPLAY) {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10); // YYYY-MM-DD
}

function normalizeDateParam(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'today') return todayTZ();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function cachePath(dateStr) {
  return path.join(CACHE_DIR, `${dateStr}.json`);
}

function readDiskCache(dateStr) {
  const fp = cachePath(dateStr);
  if (!fs.existsSync(fp)) return null;
  try {
    const txt = fs.readFileSync(fp, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function writeDiskCache(dateStr, payload) {
  try {
    fs.writeFileSync(cachePath(dateStr), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

async function httpGet(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'kixonair/1.0' },
      signal: controller.signal,
    });
    return r;
  } catch (e) {
    return { ok: false, status: 0, json: async () => ({ error: String(e) }) };
  } finally {
    clearTimeout(id);
  }
}

// --------------------------------------------------
// ESPN FETCHERS (trimmed to be light)
// --------------------------------------------------
async function fetchEspnBoard(segment, dateStr) {
  // ESPN wants yyyymmdd
  const yyyymmdd = dateStr.replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/${segment}/scoreboard?dates=${yyyymmdd}`;
  const r = await httpGet(url);
  if (!r.ok) return { events: [] };
  const data = await r.json().catch(() => ({}));
  return data;
}

function mapEspnEventsToFixtures(data, dateStr, sportLabel, leagueFallback) {
  const events = data?.events || [];
  const out = [];
  for (const ev of events) {
    const iso = ev.date;
    if (!iso) continue;
    // keep only events for that local day
    const evDay = new Date(iso).toISOString().slice(0, 10);
    if (evDay !== dateStr) continue;

    const comp = ev.competitions?.[0] || {};
    const participants = comp.competitors || [];
    const home =
      participants.find((t) => t.homeAway === 'home') ||
      participants[0] ||
      {};
    const away =
      participants.find((t) => t.homeAway === 'away') ||
      participants[1] ||
      {};

    out.push({
      sport: sportLabel,
      league: { name: comp.league?.name || leagueFallback },
      start_utc: iso,
      status: ev.status?.type?.name || 'SCHEDULED',
      home: {
        name: home.team?.shortDisplayName || home.team?.displayName || '',
        logo: home.team?.logo || home.team?.logos?.[0]?.href || null,
      },
      away: {
        name: away.team?.shortDisplayName || away.team?.displayName || '',
        logo: away.team?.logo || away.team?.logos?.[0]?.href || null,
      },
    });
  }
  return out;
}

async function getSoccerFixtures(dateStr) {
  // fetch a handful of segments in parallel (not 20)
  const promises = MAIN_SOCCER_SEGMENTS.map((seg) =>
    fetchEspnBoard(seg, dateStr).then((data) =>
      mapEspnEventsToFixtures(
        data,
        dateStr,
        'Soccer',
        seg.startsWith('soccer/uefa') ? 'UEFA' : 'Football'
      )
    )
  );
  const all = await Promise.all(promises);
  return all.flat();
}

async function getNBAFixtures(dateStr) {
  const data = await fetchEspnBoard('basketball/nba', dateStr);
  return mapEspnEventsToFixtures(data, dateStr, 'NBA', 'NBA');
}

async function getNFLFixtures(dateStr) {
  const data = await fetchEspnBoard('football/nfl', dateStr);
  return mapEspnEventsToFixtures(data, dateStr, 'NFL', 'NFL');
}

async function getNHLFixtures(dateStr) {
  const data = await fetchEspnBoard('hockey/nhl', dateStr);
  return mapEspnEventsToFixtures(data, dateStr, 'NHL', 'NHL');
}

// optional fallback
async function getSportsDbFixtures(dateStr) {
  if (!SPORTSDB_ENABLED) return [];
  const url = `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${dateStr}&s=Soccer`;
  const r = await httpGet(url);
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  const evs = data.events || [];
  return evs.map((e) => ({
    sport: 'Soccer',
    league: { name: e.strLeague || 'Football' },
    start_utc: e.strTimestamp || `${e.dateEvent}T${e.strTime || '12:00:00'}Z`,
    status: 'SCHEDULED',
    home: { name: e.strHomeTeam || '' },
    away: { name: e.strAwayTeam || '' },
  }));
}

// --------------------------------------------------
// MAIN ASSEMBLE
// --------------------------------------------------
async function buildFixturesFor(dateStr) {
  // small parallel batch → much faster than your old file
  const [soccer, nba, nfl, nhl] = await Promise.all([
    getSoccerFixtures(dateStr).catch(() => []),
    getNBAFixtures(dateStr).catch(() => []),
    getNFLFixtures(dateStr).catch(() => []),
    getNHLFixtures(dateStr).catch(() => []),
  ]);

  let fixtures = [...soccer, ...nba, ...nfl, ...nhl];

  if (fixtures.length === 0) {
    const fallback = await getSportsDbFixtures(dateStr).catch(() => []);
    fixtures = fixtures.concat(fallback);
  }

  // de-dupe simple
  const seen = new Set();
  const deduped = [];
  for (const f of fixtures) {
    const key = `${f.sport}|${f.league?.name}|${f.home?.name}|${f.away?.name}|${f.start_utc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  // sort by time
  deduped.sort((a, b) => (a.start_utc || '').localeCompare(b.start_utc || ''));

  return {
    ok: true,
    date: dateStr,
    count: deduped.length,
    fixtures: deduped,
  };
}

// --------------------------------------------------
// GET OR BUILD WITH CACHING
// --------------------------------------------------
async function getFixtures(dateStr, force = false) {
  const memKey = `fixtures:${dateStr}`;
  const now = Date.now();

  if (!force) {
    // 1) in-memory
    const cached = memCache.get(memKey);
    if (cached && cached.expires > now) {
      return cached.data;
    }
    // 2) disk
    const disk = readDiskCache(dateStr);
    if (disk) {
      // also refresh memory
      memCache.set(memKey, { expires: now + MEM_TTL_MS, data: disk });
      return disk;
    }
  }

  // 3) build fresh
  const fresh = await buildFixturesFor(dateStr);

  // save
  memCache.set(memKey, { expires: now + MEM_TTL_MS, data: fresh });
  writeDiskCache(dateStr, fresh);

  return fresh;
}

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

// main API – date is optional now
app.get(['/api/fixtures', '/api/fixtures/:date'], async (req, res) => {
  try {
    const raw = req.params.date || req.query.date || 'today';
    const d = normalizeDateParam(raw);
    if (!d) return res.status(400).json({ ok: false, error: 'Invalid date' });

    const force = req.query.force === '1' || req.query.force === 'true';

    const payload = await getFixtures(d, force);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// admin precache – no HTTP self-call
app.get('/admin/precache', async (req, res) => {
  try {
    const tok = String(req.query.token || '');
    if (!ADMIN_TOKEN || tok !== ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const d = normalizeDateParam(req.query.date || 'today');
    if (!d) return res.status(400).json({ ok: false, error: 'bad date' });

    const payload = await getFixtures(d, true);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// simple root
app.get('/', (req, res) => {
  res.send('kixonair API up');
});

// --------------------------------------------------
// START
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(`[kixonair] up on :${PORT}`);
});
