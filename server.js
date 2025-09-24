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
const SPORTSDB_ENABLED = (process.env.SPORTSDB_ENABLED ?? '0') !== '0'; // optional backup
const UCL_LOOKAHEAD = (process.env.UCL_LOOKAHEAD ?? '0') === '1'; // default OFF now
const SECONDARY_ON_EMPTY = (process.env.SECONDARY_ON_EMPTY ?? '1') === '1'; // fill quiet days with tier-2
const TZ_DISPLAY = process.env.TZ_DISPLAY || 'Europe/Bucharest';
const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || '180'); // fallback if Intl tz fails
const BUILD_TAG    = 'hotfix19-nfl+nba-localday';

// ====== LEAGUE SEGMENTS ======
const UEFA_VARIANTS = [
  'soccer/uefa.champions',
  'soccer/uefa.champions_qual',
  'soccer/uefa.champions.qualifying',
  'soccer/uefa.champions.qual',
  'soccer/uefa.champions.playoff',
  'soccer/uefa.champions.play-offs',
  'soccer/uefa.champions.league'
];

function parseListEnv(val, fallbackList){
  const raw = (val ?? '').toString();
  const parts = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const list = (parts.length ? parts : fallbackList).map(s => s.trim()).filter(Boolean);
  return Array.from(new Set(list)); // unique
}

const EU_LEAGUES = parseListEnv(process.env.EU_LEAGUES, [
  'soccer/uefa.europa','soccer/uefa.europa_qual','soccer/uefa.europa.qualifying','soccer/uefa.europa.playoff','soccer/uefa.europa.play-offs',
  'soccer/uefa.europa.conf','soccer/uefa.europa.conf_qual','soccer/uefa.europa.conf.qualifying',
  'soccer/eng.1','soccer/esp.1','soccer/ger.1','soccer/ita.1','soccer/fra.1',
  'soccer/por.1','soccer/ned.1','soccer/tur.1','soccer/bel.1','soccer/sco.1'
]);

// Secondary-tier leagues for quiet days (robust parsing: commas or spaces)
const TIER2_LEAGUES = parseListEnv(process.env.TIER2_LEAGUES, [
  'soccer/eng.2','soccer/esp.2','soccer/ger.2','soccer/ita.2','soccer/fra.2',
  'soccer/usa.1','soccer/mex.1','soccer/bra.1','soccer/arg.1',
  'soccer/nor.1','soccer/swe.1','soccer/den.1','soccer/pol.1','soccer/jpn.1'
]);

function prettyLeagueName(segment){
  const map = {
    'soccer/uefa.champions': 'UEFA Champions League',
    'soccer/uefa.champions_qual': 'UEFA Champions League Qualifying',
    'soccer/uefa.champions.qualifying': 'UEFA Champions League',
    'soccer/uefa.champions.qual': 'UEFA Champions League',
    'soccer/uefa.champions.playoff': 'UEFA Champions League',
    'soccer/uefa.champions.play-offs': 'UEFA Champions League',
    'soccer/uefa.champions.league': 'UEFA Champions League',
    'soccer/uefa.europa': 'UEFA Europa League',
    'soccer/uefa.europa_qual': 'UEFA Europa League Qualifying',
    'soccer/uefa.europa.qualifying': 'UEFA Europa League',
    'soccer/uefa.europa.playoff': 'UEFA Europa League',
    'soccer/uefa.europa.play-offs': 'UEFA Europa League',
    'soccer/uefa.europa.conf': 'UEFA Europa Conference League',
    'soccer/uefa.europa.conf_qual': 'UEFA Europa Conference League Qualifying',
    'soccer/uefa.europa.conf.qualifying': 'UEFA Europa Conference League',
    'soccer/eng.1': 'Premier League',
    'soccer/esp.1': 'LaLiga',
    'soccer/ger.1': 'Bundesliga',
    'soccer/ita.1': 'Serie A',
    'soccer/fra.1': 'Ligue 1',
    'soccer/por.1': 'Primeira Liga',
    'soccer/ned.1': 'Eredivisie',
    'soccer/tur.1': 'Süper Lig',
    'soccer/bel.1': 'Jupiler Pro League',
    'soccer/sco.1': 'Scottish Premiership',
    'soccer/eng.2': 'EFL Championship',
    'soccer/esp.2': 'LaLiga 2',
    'soccer/ger.2': '2. Bundesliga',
    'soccer/ita.2': 'Serie B',
    'soccer/fra.2': 'Ligue 2',
    'soccer/usa.1': 'MLS',
    'soccer/mex.1': 'Liga MX',
    'soccer/bra.1': 'Brasileirão',
    'soccer/arg.1': 'Liga Profesional',
    'soccer/nor.1': 'Eliteserien',
    'soccer/swe.1': 'Allsvenskan',
    'soccer/den.1': 'Superliga',
    'soccer/pol.1': 'Ekstraklasa',
    'soccer/jpn.1': 'J1 League'
  };
  return map[segment] || 'Football';
}

// ====== HELPERS ======
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
const yyyymmdd = d => d.replace(/-/g,'');

function dayOfInTZ(iso, tz){
  try{
    const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
    const parts = dtf.formatToParts(new Date(iso));
    const y = parts.find(p=>p.type==='year')?.value;
    const m = parts.find(p=>p.type==='month')?.value;
    const d = parts.find(p=>p.type==='day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  }catch{}
  const t = new Date(iso);
  const ms = t.getTime() + TZ_OFFSET_MINUTES*60*1000;
  const k = new Date(ms);
  const y = k.getUTCFullYear();
  const m = String(k.getUTCMonth()+1).padStart(2,'0');
  const d = String(k.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
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

const fixLogo = u => u ? u.replace(/^http:/,'https:') : null;
const pickName = (t) => t?.shortDisplayName || t?.displayName || t?.name || t?.abbreviation || '';
const teamLogo = t => fixLogo(t?.logo || t?.logos?.[0]?.href || null);

function parseEventNameTeams(name){
  if (!name) return [null,null];
  const n = name.replace(/\s+/g,' ').trim();
  const vs = n.split(/\s+vs\.?\s+/i);
  if (vs.length === 2) return [vs[0], vs[1]];
  const at = n.split(/\s+at\s+/i);
  if (at.length === 2) return [at[1], at[0]];
  return [null,null];
}

function statusFromEspn(ev){
  const sRaw = ev?.status?.type?.name || ev?.status?.type?.description || '';
  const s = String(sRaw).toUpperCase();
  // Finished states: final, postgame, full time
  if (/FINAL|STATUS_FINAL|POSTGAME|FULLTIME|FT/.test(s)) return 'FINISHED';
  // Half‑time: ESPN uses STATUS_HALFTIME for the interval break.  Do
  // not treat this as live so that the client can display a dedicated
  // label.
  if (/STATUS_HALFTIME|HALF\s?TIME/.test(s)) return 'HALF';
  // Live play in either period
  if (/IN_PROGRESS|LIVE|STATUS_IN_PROGRESS/.test(s)) return 'LIVE';
  return 'SCHEDULED';
}
function fx({ sport, league, tier, startISO, status, home, away }){
  return {
    sport,
    tier,
    league: { name: league || 'Football', code: null },
    start_utc: startISO,
    status: status || 'SCHEDULED',
    home: { name: home?.name || '', logo: home?.logo || null },
    away: { name: away?.name || '', logo: away?.logo || null } // fixed: proper away logo
  };
}

// ====== ESPN fetch/mappers ======
async function espnBoard(segment, d){
  const url = `https://site.api.espn.com/apis/site/v2/sports/${segment}/scoreboard?dates=${yyyymmdd(d)}`;
  const r = await httpGet(url);
  const j = r.ok ? await r.json() : { error: await r.text() };
  return { ok: r.ok, status: r.status, url, json: j, segment };
}
function mapBoard(board, d, sport, fallbackLeague, tier=1){
  const out = [];
  const j = board?.json || {};
  for (const ev of (j?.events || [])){
    const iso = ev?.date;
    if (!iso) continue;
    if (dayOfInTZ(iso, TZ_DISPLAY) !== d) continue;
    const comp = ev?.competitions?.[0] || {};
    const competitors = comp?.competitors || [];
    const H = competitors.find(x => x.homeAway === 'home') || competitors[0] || {};
    const A = competitors.find(x => x.homeAway === 'away') || competitors[1] || {};
    let homeName = pickName(H?.team);
    let awayName = pickName(A?.team);
    if (!homeName || !awayName){
      const [pHome, pAway] = parseEventNameTeams(ev?.name);
      homeName = homeName || pHome || '';
      awayName = awayName || pAway || '';
    }
    const leagueName = comp?.league?.name || j?.leagues?.[0]?.name || fallbackLeague;
    out.push(fx({
      sport,
      tier,
      league: leagueName,
      startISO: iso,
      status: statusFromEspn(ev),
      home: { name: homeName, logo: teamLogo(H?.team) },
      away: { name: awayName, logo: teamLogo(A?.team) }
    }));
  }
  return out;
}
async function espnSoccerSegments(segments, d, tier){
  const results = await Promise.all(segments.map(async seg => {
    const b = await espnBoard(seg, d);
    return { board: b, mapped: mapBoard(b, d, 'Soccer', prettyLeagueName(seg), tier) };
  }));
  const mapped = results.flatMap(x => x.mapped);
  const boards = results.map(x => x.board);
  return { mapped, boards };
}
async function espnSoccerAll(d){
  const b = await espnBoard('soccer', d);
  return { mapped: mapBoard(b, d, 'Soccer', 'Football', 1), boards: [b] };
}
async function espnNBA(d){ const b = await espnBoard('basketball/nba', d); return { mapped: mapBoard(b,d,'NBA','NBA',1), boards:[b] }; }
async function espnNFL(d){ const b = await espnBoard('football/nfl', d); return { mapped: mapBoard(b,d,'NFL','NFL',1), boards:[b] }; }

// === Cross-midnight wrappers (Europe/Bucharest local day) ===
async function nbaForLocalDay(d){
  const [b0, bPrev, bNext] = await Promise.all([
    espnBoard('basketball/nba', d),
    espnBoard('basketball/nba', addDays(d, -1)),
    espnBoard('basketball/nba', addDays(d, +1)),
  ]).catch(() => [null, null, null]);
  const boards = [b0, bPrev, bNext].filter(Boolean);
  const mapped = boards.flatMap(b => mapBoard(b, d, 'NBA', 'NBA', 1));
  return { mapped, boards };
}
async function nflForLocalDay(d){
  const [b0, bPrev, bNext] = await Promise.all([
    espnBoard('football/nfl', d),
    espnBoard('football/nfl', addDays(d, -1)),
    espnBoard('football/nfl', addDays(d, +1)),
  ]).catch(() => [null, null, null]);
  const boards = [b0, bPrev, bNext].filter(Boolean);
  const mapped = boards.flatMap(b => mapBoard(b, d, 'NFL', 'NFL', 1));
  return { mapped, boards };


}


async function nhlForLocalDay(d){
  const [b0, bPrev, bNext] = await Promise.all([
    espnBoard('hockey/nhl', d),
    espnBoard('hockey/nhl', addDays(d, -1)),
    espnBoard('hockey/nhl', addDays(d, +1)),
  ]).catch(() => [null, null, null]);
  const boards = [b0, bPrev, bNext].filter(Boolean);
  const mapped = boards.flatMap(b => mapBoard(b, d, 'NHL', 'NHL', 1));
  return { mapped, boards };
}

// ====== SportsDB fallback (Soccer)
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
  if (!SPORTSDB_ENABLED || !SPORTSDB_KEY || SPORTSDB_KEY === '0') return { mapped: [], url: null };
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${d}&s=Soccer`;
  const r = await httpGet(url);
  const j = r.ok ? await r.json() : { error: await r.text() };
  const evs = j?.events || [];
  const out = [];
  for (const e of evs){
    const iso = buildIsoFromSportsDB(e);
    if (!iso) continue;
    if (dayOfInTZ(iso, TZ_DISPLAY) !== d) continue;
    const leagueName = e?.strLeague || 'Football';
    out.push(fx({
      sport: 'Soccer',
      tier: 2,
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

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
}

function isUEFA(name=''){
  const s = (name || '').toLowerCase();
  return s.includes('uefa') || s.includes('champions') || s.includes('europa');
}

async function assembleFor(d, debug=false){
  const [eu, allSoc, nba, nfl, nhl] = await Promise.all([
    espnSoccerSegments([...UEFA_VARIANTS, ...EU_LEAGUES], d, 1).catch(()=>({ mapped:[], boards:[] })),
    espnSoccerAll(d).catch(()=>({ mapped:[], boards:[] })),
    nbaForLocalDay(d).catch(()=>({ mapped:[], boards:[] })),  // NBA cross-midnight
    nflForLocalDay(d).catch(()=>({ mapped:[], boards:[] })),   // NFL cross-midnight
    nhlForLocalDay(d).catch(()=>({ mapped:[], boards:[] }))    // NHL cross-midnight
  ]);

  let soccer = [...(eu.mapped||[]), ...(allSoc.mapped||[])];
  let notice = null;

  if (UCL_LOOKAHEAD){
    const hasUEFA = soccer.some(f => isUEFA(f.league?.name));
    if (!hasUEFA){
      const dNext = addDays(d, 1);
      const euNext = await espnSoccerSegments(UEFA_VARIANTS, dNext, 1).catch(()=>({ mapped:[] }));
      const uefaOnly = (euNext.mapped||[]).filter(f => isUEFA(f.league?.name));
      if (uefaOnly.length){
        soccer = soccer.concat(uefaOnly);
        notice = `Including next-day UEFA fixtures (${dNext})`;
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

  const merged = dedupePreferEarliest([ ...soccer, ...((nba.mapped)||[]), ...((nfl.mapped)||[]), ...((nhl.mapped)||[]) ]);
  const meta = {
    date: d,
    tz: TZ_DISPLAY,
    sourceCounts: {
      espn_soccer_tier1: eu.mapped?.length || 0,
      espn_soccer_all: allSoc.mapped?.length || 0,
      espn_soccer_tier2: merged.filter(f => f.tier === 2).length,
      sportsdb_soccer: sdb.mapped?.length || 0,
      espn_nba: nba.mapped?.length || 0,
      espn_nfl: nfl.mapped?.length || 0,
      espn_nhl: nhl?.mapped?.length || 0
    }
  };
  if (notice) meta.notice = notice;

  if (debug){
    meta.debug = {
      tz: TZ_DISPLAY,
      secondary_on_empty: SECONDARY_ON_EMPTY,
      ucl_lookahead: UCL_LOOKAHEAD,
      tier2_segments: TIER2_LEAGUES
    };
  }
  return { meta, fixtures: merged };
}

// ====== ROUTES ======
app.get('/__/version', (req,res)=> res.json({ build: BUILD_TAG, ts: new Date().toISOString() }));
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
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});
app.post('/admin/flush-cache', (req, res) => {
  try{
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
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});
app.get('/admin/precache', async (req, res) => {
  try{
    const t = String(req.query.token || '');
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
    const d = normalizeDateParam(req.query.date || '');
    if (!d) return res.status(400).json({ ok:false, error:'invalid date' });
    const r = await (await httpGet(`${req.protocol}://${req.get('host')}/api/fixtures/${d}?force=1`)).json().catch(()=>null);
    res.json(r || { ok:false });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[kixonair] up on :${PORT}`));
