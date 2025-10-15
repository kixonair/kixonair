# Deploying Magazine Pro on Render / GitHub

## Render (recommended: full site)
1. Push this build to your repo.
2. In Render Web Service:
   - **Build Command**: `npm ci`
   - **Start Command**: `node server.js`
3. Point `kixonair.com` to this service. The homepage is **public/index.html** and protected assets are under **/assets**.

## GitHub Pages (static) + Render (assets)
- If you keep GitHub Pages for static pages, change the logo path in `public/index.html` to your Render host, e.g.:
  `<img src="https://YOUR-RENDER-DOMAIN/assets/logo.4e020dc4.svg" ...>`

## Notes
- Security headers & anti-hotlink middleware are in `server.js`.
- ESPN data is fetched client-side by `public/magazine.js` (no keys needed).
- Watch links point to `/watch.html?m=...` (you can hook these to your stream route).
