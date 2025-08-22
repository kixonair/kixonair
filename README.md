# Kixonair — hotfix3 (probe)
- Strict date filter
- Manual fixtures fallback (or MANUAL_MODE=merge)
- Cache flush endpoint
- New /__/probe?date=YYYY-MM-DD shows upstream status & counts

ENV:
SPORTSDB_KEY=3
ADMIN_TOKEN=mysecret123
MANUAL_MODE=fallback
EU_LEAGUES=soccer/uefa.champions,soccer/uefa.europa,soccer/uefa.europa.conf,soccer/eng.1,soccer/esp.1,soccer/ger.1,soccer/ita.1,soccer/fra.1,soccer/por.1,soccer/ned.1,soccer/tur.1,soccer/bel.1,soccer/sco.1

Build: npm install
Start: node server.js
