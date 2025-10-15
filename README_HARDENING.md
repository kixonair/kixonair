
# Kixonair — Hardening Changes (2025-10-15)

This build adds:
- **CSP & security headers** (Content-Security-Policy, Referrer-Policy, X-Content-Type-Options)
- **Protected assets** served at `/assets` with referer allow‑list (`kixonair.com`, `www.kixonair.com`)
- **Fingerprinting** of logo as `logo.4e020dc4.svg`
- Updated HTML to use `/assets/logo.4e020dc4.svg`
- Ensured canonical tags where missing

## Deploy on Render
1) Set `Build Command` to install deps: `npm ci`
2) Set `Start Command`: `node server.js` (or `npm start` if your package.json runs server.js)
3) Add env vars:
   - `API_KEY` (must match the value used by `public/secure-fetch.js`)
   - `ADMIN_TOKEN` (optional, if you use admin endpoints)
4) Point `kixonair.com` and `www.kixonair.com` to this Render service (or keep GitHub Pages for static, but assets will come from the Render service since they live under `/assets`).

## If you keep GitHub Pages for the static site
- Leave the static HTML on GH Pages but ensure all image/logo references now point to `/assets/logo.4e020dc4.svg` **on the Render host**.
- If GH Pages is a separate host, change the HTML to absolute: `https://YOUR-RENDER-DOMAIN/assets/logo.4e020dc4.svg`.

## Cloudflare (optional but recommended)
- Put Cloudflare in front of `kixonair.com` and create a Firewall rule to block requests to `/assets/` when Referer host is not `kixonair.com`.
- Enable Hotlink Protection.

## Notes
- Any old hotlinks to `/public/logo.svg` will no longer be used by the pages. You may delete the old file after verifying production.
- The referer check is a deterrent; motivated scrapers can spoof headers, but combined with DMCA + Cloudflare WAF it stops most copycats quickly.
