# Kixonair — Premium Match List (v4)

This version adds:
- **Two-column** layout when a sport tab is selected (Soccer/NBA/NFL).
- Full-width single-section view + dense grid.

## Local run
1) Install Node 18+
2) Create `.env`:
```
PUBLIC_HOST=http://localhost:3000
CPAGRIP_LOCKER_URL=https://rileymarker.com/sportlo
LOCKER_RETURN_PARAM=r
FD_KEY=YOUR_FOOTBALLDATA_KEY
BDL_KEY=YOUR_BALLDONTLIE_KEY
TSD_KEY=123
```
3) `npm i` then `npm start`
4) Open http://localhost:3000

## Deploy
- Deploy to Render/Railway; after adding your domain (e.g., kixonair.com), set:
```
PUBLIC_HOST=https://kixonair.com
```
- Whitelist your domain in your CPA locker provider.
