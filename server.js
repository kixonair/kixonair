// server.js – kixonair fast version with 2-minute refresh + aggressive halftime auto-upgrade
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
const PORT = process.env.PORT || 10000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TZ_DISPLAY = process.env.TZ_DISPLAY || 'Europe/Bucharest';
const SPORTSDB_ENABLED = (process.env.SPORTSDB_ENABLED || '0') !== '0';

app.use(express.static(path.join(__dirname, 'public'), { index: ['index.html'] }));
app.use(cors());
app.use(express.json());

// --------------------------------------------------
// helpers
// --------------------------------------------------
const CACHE_DIR = path.join(__dirname, 'data', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const memCache = new Map();
const MEM_TTL_MS = 60 * 1000; // 1 minute in-memory

function todayTZ(tz = TZ_DISPLAY) {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10);
}

function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'today') return todayTZ();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function cachePath(dateStr) {
  return path.join(CACHE_DIR, `${dateStr}.json`);
}

// only trust today’s disk cache for 2 minutes
function readDisk(dateStr) {
  const fp = cachePath(dateStr);
  if (!fs.existsSync(fp)) return null;
  try {
    const stat = fs.statSync(fp);
    const ageMs = Date.now() - stat.mtimeMs;
    const today = todayTZ();

    if (dateStr === today) {
      // live day → refresh often
      if (ageMs > 120 * 1000) {
        return null;
      }
    }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function writeDisk(dateStr, data) {
  try {
    fs.writeFileSync(cachePath(dateStr), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

async function httpGet(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'kixonair/1.0', 'Accept': 'application/json' },
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
// ESPN fetchers
// --------------------------------------------------
const SOCCER_SEGMENTS = [
  'soccer',
  'soccer/eng.1',
  'soccer/esp.1',
  'soccer/ita.1',
  'soccer/ger.1',
  'soccer/fra.1',
  'soccer/uefa.champions',
];

async function fetchEspnBoard(segment, dateStr) {
  const ymd = dateStr.replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/${segment}/scoreboard?dates=${ymd}`;
  const r = await httpGet(url);
  if (!r.ok) return { events: [] };
  return r.json().catch(() => ({ events: [] }));
}

function mapEspn(data, dateStr, sportLabel, leagueFallback) {
  const out = [];
  for (const ev of data.events || []) {
    const iso = ev.date;
    if (!iso) continue;
    if (iso.slice(0, 10) !== dateStr) continue;

    const comp = ev.competitions?.[0] || {};
    const teams = comp.competitors || [];
    const home = teams.find(t => t.homeAway === 'home') || teams[0] || {};
    const away = teams.find(t => t.homeAway === 'away') || teams[1] || {};

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

async function getSoccer(dateStr) {
  const jobs = SOCCER_SEGMENTS.map(seg =>
    fetchEspnBoard(seg, dateStr).then(d =>
      mapEspn(
        d,
        dateStr,
        'Soccer',
        seg.startsWith('soccer/uefa') ? 'UEFA' : 'Football'
      )
    )
  );
  const all = await Promise.all(jobs);
  return all.flat();
}

async function getNBA(dateStr) {
  const d = await fetchEspnBoard('basketball/nba', dateStr);
  return mapEspn(d, dateStr, 'NBA', 'NBA');
}

async function getNFL(dateStr) {
  const d = await fetchEspnBoard('football/nfl', dateStr);
  return mapEspn(d, dateStr, 'NFL', 'NFL');
}

async function getNHL(dateStr) {
  const d = await fetchEspnBoard('hockey/nhl', dateStr);
  return mapEspn(d, dateStr, 'NHL', 'NHL');
}

async function getSportsDB(dateStr) {
  if (!SPORTSDB_ENABLED) return [];
  const url = `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${dateStr}&s=Soccer`;
  const r = await httpGet(url);
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  const evs = data.events || [];
  return evs.map(e => ({
    sport: 'Soccer',
    league: { name: e.strLeague || 'Football' },
    start_utc: e.strTimestamp || `${e.dateEvent}T${e.strTime || '12:00:00'}Z`,
    status: 'SCHEDULED',
    home: { name: e.strHomeTeam || '' },
    away: { name: e.strAwayTeam || '' },
  }));
}

// --------------------------------------------------
// assemble
// --------------------------------------------------
function promoteHalftimeToLive(fixtures) {
  const now = new Date();
  const GRACE = 2 * 60 * 1000; // 2 minutes

  for (const f of fixtures) {
    if (!f.status) continue;
    const st = f.status.toUpperCase();

    // if ESPN says "in_progress" or similar, just show LIVE
    if (st.includes('IN_PROGRESS')) {
      f.status = 'LIVE';
      continue;
    }

    // ESPN sometimes leaves "HALFTIME" longer — upgrade after 2 minutes
    if (st.includes('HALF')) {
      const start = new Date(f.start_utc || f.date || now).getTime();
      if (!isNaN(start)) {
        const diff = now.getTime() - start;
        if (diff > GRACE) {
          f.status = 'LIVE';
        }
      } else {
        // no start time? treat as live
        f.status = 'LIVE';
      }
    }
  }
}

async function buildFixtures(dateStr) {
  const [soc, nba, nfl, nhl] = await Promise.all([
    getSoccer(dateStr).catch(() => []),
    getNBA(dateStr).catch(() => []),
    getNFL(dateStr).catch(() => []),
    getNHL(dateStr).catch(() => []),
  ]);

  let fixtures = [...soc, ...nba, ...nfl, ...nhl];

  if (fixtures.length === 0) {
    const fb = await getSportsDB(dateStr).catch(() => []);
    fixtures = fixtures.concat(fb);
  }

  // de-dupe
  const seen = new Set();
  const deduped = [];
  for (const f of fixtures) {
    const k = `${f.sport}|${f.league?.name}|${f.home?.name}|${f.away?.name}|${f.start_utc}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(f);
  }

  // ✅ fix statuses to look live sooner
  promoteHalftimeToLive(deduped);

  deduped.sort((a, b) => (a.start_utc || '').localeCompare(b.start_utc || ''));

  return {
    ok: true,
    date: dateStr,
    count: deduped.length,
    fixtures: deduped,
  };
}

async function getFixtures(dateStr, force = false) {
  const memKey = `fx:${dateStr}`;
  const now = Date.now();

  if (!force) {
    const hit = memCache.get(memKey);
    if (hit && hit.expires > now) {
      return hit.data;
    }
    const disk = readDisk(dateStr);
    if (disk) {
      memCache.set(memKey, { expires: now + MEM_TTL_MS, data: disk });
      return disk;
    }
  }

  const fresh = await buildFixtures(dateStr);
  memCache.set(memKey, { expires: now + MEM_TTL_MS, data: fresh });
  writeDisk(dateStr, fresh);
  return fresh;
}

// --------------------------------------------------
// routes
// --------------------------------------------------
app.get('/health', (req, res) => res.send('ok'));

app.get(['/api/fixtures', '/api/fixtures/:date'], async (req, res) => {
  try {
    const raw = req.params.date || req.query.date || 'today';
    const d = normalizeDate(raw);
    if (!d) return res.status(400).json({ ok: false, error: 'Invalid date' });

    const force = req.query.force === '1' || req.query.force === 'true';
    const payload = await getFixtures(d, force);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/admin/precache', async (req, res) => {
  try {
    const tok = String(req.query.token || '');
    if (!ADMIN_TOKEN || tok !== ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const d = normalizeDate(req.query.date || 'today');
    if (!d) return res.status(400).json({ ok: false, error: 'bad date' });

    const payload = await getFixtures(d, true);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/', (req, res) => {
  res.send('kixonair API up');
});

app.listen(PORT, () => {
  console.log(`[kixonair] up on :${PORT}`);
});
