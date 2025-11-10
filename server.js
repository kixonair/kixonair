// kixonair server.js - server-side like before, but ESPN is fetched through AllOrigins proxy
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const PORT = process.env.PORT || 3000;
const SPORTSDB_ENABLED = (process.env.SPORTSDB_ENABLED || "0") !== "0";
const SPORTSDB_KEY = process.env.SPORTSDB_KEY || "3";
const ESPN_PROXY = process.env.ESPN_PROXY_BASE || "https://api.allorigins.win/raw?url=";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// health for Render
app.get("/health", (req, res) => res.json({ ok: true }));

// helper to fetch via proxy
async function fetchEspnViaProxy(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proxied = ESPN_PROXY + encodeURIComponent(url);
    const r = await fetch(proxied, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/127.0",
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
    return r;
  } catch (e) {
    return { ok: false, status: 0, json: async () => ({ error: String(e) }) };
  } finally {
    clearTimeout(timer);
  }
}

// ESPN segments
const SOCCER_SEGMENTS = [
  "soccer/eng.1",
  "soccer/esp.1",
  "soccer/ita.1",
  "soccer/ger.1",
  "soccer/fra.1",
  "soccer/uefa.champions",
  "soccer",
];
const SOCCER_META = {
  "soccer/eng.1": { name: "Premier League", code: "PL" },
  "soccer/esp.1": { name: "La Liga", code: "LL" },
  "soccer/ita.1": { name: "Serie A", code: "SA" },
  "soccer/ger.1": { name: "Bundesliga", code: "BL1" },
  "soccer/fra.1": { name: "Ligue 1", code: "L1" },
  "soccer/uefa.champions": { name: "UEFA Champions League", code: "UCL" },
};

async function fetchEspnBoard(segment, dateStr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${segment}/scoreboard?dates=${dateStr}`;
  const r = await fetchEspnViaProxy(url);
  if (!r.ok) return { events: [] };
  return r.json();
}

function mapEspn(data, sportLabel, leagueFallback, leagueCode) {
  const out = [];
  for (const ev of data.events || []) {
    const iso = ev.date;
    if (!iso) continue;
    const comp = ev.competitions?.[0] || {};
    const teams = comp.competitors || [];
    const home = teams.find(t => t.homeAway === "home") || teams[0] || {};
    const away = teams.find(t => t.homeAway === "away") || teams[1] || {};
    out.push({
      sport: sportLabel,
      league: {
        name: comp.league?.name || leagueFallback,
        code: comp.league?.abbreviation || leagueCode || "",
      },
      start_utc: iso,
      status: comp.status?.type?.name || "STATUS_SCHEDULED",
      home: {
        name: home.team?.shortDisplayName || home.team?.displayName || home.team?.name || "",
        logo: home.team?.logo || (home.team?.logos && home.team?.logos[0]?.href) || "",
      },
      away: {
        name: away.team?.shortDisplayName || away.team?.displayName || away.team?.name || "",
        logo: away.team?.logo || (away.team?.logos && away.team?.logos[0]?.href) || "",
      },
    });
  }
  return out;
}

async function getSoccer(dateStr) {
  const jobs = SOCCER_SEGMENTS.map(seg =>
    fetchEspnBoard(seg, dateStr).then(data => {
      const meta = SOCCER_META[seg];
      return mapEspn(
        data,
        "Soccer",
        meta ? meta.name : (seg.startsWith("soccer/uefa") ? "UEFA" : "Football"),
        meta ? meta.code : ""
      );
    })
  );
  const arr = await Promise.all(jobs);
  return arr.flat();
}

async function getNBA(dateStr) {
  const d = await fetchEspnBoard("basketball/nba", dateStr);
  return mapEspn(d, "NBA", "NBA", "NBA");
}

async function getNFL(dateStr) {
  const d = await fetchEspnBoard("football/nfl", dateStr);
  return mapEspn(d, "NFL", "NFL", "NFL");
}

async function getNHL(dateStr) {
  const d = await fetchEspnBoard("hockey/nhl", dateStr);
  return mapEspn(d, "NHL", "NHL", "NHL");
}

async function getSportsDB(dateStr) {
  if (!SPORTSDB_ENABLED) return [];
  const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${dateStr}&s=Soccer`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  const evs = data.events || [];
  return evs.map(e => ({
    sport: "Soccer",
    league: { name: e.strLeague || "Football" },
    start_utc: e.strTimestamp || (e.dateEvent ? `${e.dateEvent}T${e.strTime || "12:00:00"}Z` : ""),
    status: "STATUS_SCHEDULED",
    home: { name: e.strHomeTeam || "" },
    away: { name: e.strAwayTeam || "" },
  }));
}

// date helpers
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(d, days) {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
}

// API endpoint like before
app.get("/api/fixtures", async (req, res) => {
  try {
    const today = req.query.date ? new Date(req.query.date) : new Date();
    const todayStr = ymd(today);
    const yesterdayStr = ymd(addDays(today, -1));
    const all = [];

    for (const dStr of [yesterdayStr, todayStr]) {
      const [soccer, nba, nfl, nhl, sdb] = await Promise.all([
        getSoccer(dStr),
        getNBA(dStr),
        getNFL(dStr),
        getNHL(dStr),
        getSportsDB(dStr),
      ]);
      all.push(...soccer, ...nba, ...nfl, ...nhl, ...sdb);
    }

    all.sort((a, b) => {
      if (!a.start_utc) return 1;
      if (!b.start_utc) return -1;
      return a.start_utc.localeCompare(b.start_utc);
    });

    res.json({ ok: true, date: todayStr, count: all.length, fixtures: all });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log("kixonair server (proxied) running on", PORT);
});
