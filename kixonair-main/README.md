# Kixonair — hotfix5
- Accepts dates as query **or** path: `/api/fixtures?date=2025-08-22` **or** `/api/fixtures/2025-08-22`
- Normalizes formats: `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY.MM.DD`, `DD-MM-YYYY`, `today`, `tomorrow`, `yesterday`
- Adds `/__/echo` to show what the server received
- Keeps `/__/probe` with UA header to avoid upstream blocks

ENV:
SPORTSDB_KEY=3
ADMIN_TOKEN=mysecret123
MANUAL_MODE=fallback
EU_LEAGUES=soccer/uefa.champions,soccer/uefa.europa,soccer/uefa.europa.conf,soccer/eng.1,soccer/esp.1,soccer/ger.1,soccer/ita.1,soccer/fra.1,soccer/por.1,soccer/ned.1,soccer/tur.1,soccer/bel.1,soccer/sco.1

Build: npm install
Start: node server.js
