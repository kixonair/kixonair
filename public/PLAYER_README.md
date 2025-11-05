
# Player page

New route: `/player.html`

Accepts query params:
- `title` - match title
- `date`  - YYYY-MM-DD
- `time`  - HH:mm (24h)
- `home`, `away` - team names
- `homeLogo`, `awayLogo` - image URLs
- `league` - league name (optional)
- `s1`..`s5` - iframe URLs for the 5 servers (the first non-empty loads by default)
- `others` - base64-encoded JSON array of other matches to list (optional)
  Example value (before base64): 
  `[{"league":"Premier League","home":"West Ham","away":"Brentford","date":"2025-10-20","time":"20:00","href":"/player.html?..."}]`

Example:
`/player.html?title=Al%20Shorta%20vs%20Al-Ittihad%20FC&date=2025-10-20&time=17:00&home=Al%20Shorta&away=Al-Ittihad&homeLogo=https://example.com/home.png&awayLogo=https://example.com/away.png&s1=https://server1.example/embed&s2=https://server2.example/embed`
