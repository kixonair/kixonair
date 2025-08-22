# Kixonair — hotfix2
- Strict date filtering (no spillover to tomorrow)
- Manual fixtures are **fallback-only** unless MANUAL_MODE=merge
- Add /admin/flush-cache to clear a day or all cache

## Env
SPORTSDB_KEY=3
ADMIN_TOKEN=mysecret123
MANUAL_MODE=fallback
EU_LEAGUES=soccer/uefa.champions,soccer/uefa.europa,soccer/uefa.europa.conf,soccer/eng.1,soccer/esp.1,soccer/ger.1,soccer/ita.1,soccer/fra.1,soccer/por.1,soccer/ned.1,soccer/tur.1,soccer/bel.1,soccer/sco.1

Build: npm install
Start: node server.js

Flush bad cache:
POST /admin/flush-cache?all=true&token=YOUR_TOKEN
or
POST /admin/flush-cache?date=YYYY-MM-DD&token=YOUR_TOKEN
