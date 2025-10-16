// Magazine Pro logic

// Note: This script fetches fixtures from ESPN's public APIs and renders
// them in a magazine-style layout. It reuses many of the helper functions
// from the original Kixonair build (favourites, slug generation, etc.) but
// arranges the data into a featured hero, an “up next” list, a favourites
// list and a grid of the remaining games.

class SportsFetcher {
  constructor(){
    this.corsProxy = 'https://cors-anywhere.herokuapp.com/';
    this.espnEndpoints = {
      soccer_uefa: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard',
      soccer_eng: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
      soccer_esp: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
      soccer_ger: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard',
      soccer_ita: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard',
      soccer_fra: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard',
      soccer_europa_league: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard',
      soccer_europa_conference: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa.conference/scoreboard',
      nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
      nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
      nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard'
    };
    this.cache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
  }
  async fetchWithCache(url){
    const cached = this.cache.get(url);
    if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry){
      return cached.data;
    }
    try{
      let response;
      try{
        response = await fetch(url, {
          method:'GET',
          headers:{ 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept':'application/json' }
        });
      }catch(corsError){
        // Fallback to a CORS proxy if direct fetch fails
        response = await fetch(this.corsProxy + url, {
          method:'GET',
          headers:{ 'X-Requested-With':'XMLHttpRequest' }
        });
      }
      if (!response.ok) throw new Error('HTTP error! status: '+response.status);
      const data = await response.json();
      this.cache.set(url, { data, timestamp: Date.now() });
      return data;
    }catch(err){
      console.error('Fetch error', url, err);
      return null;
    }
  }
  parseEspnFixtures(data, sport, leagueName='', leagueCode=''){
    const fixtures = [];
    if (!data || !data.events) return fixtures;
    for (const event of data.events){
      try{
        let startTime = event.date || '';
        if (startTime){ startTime = new Date(startTime).toISOString(); }
        let status = 'SCHEDULED';
        if (event.status?.type?.name){
          const statusName = event.status.type.name.toUpperCase();
          if (statusName.includes('IN_PROGRESS') || statusName.includes('LIVE')) status = 'LIVE';
          else if (statusName.includes('FINAL') || statusName.includes('FINISHED')) status = 'FINISHED';
          else if (statusName.includes('HALFTIME')) status = 'HALF';
        }
        let homeTeam = { name:'', logo:'' };
        let awayTeam = { name:'', logo:'' };
        if (event.competitions?.[0]?.competitors){
          for (const competitor of event.competitions[0].competitors){
            const team = {
              name: competitor.team?.displayName || '',
              logo: competitor.team?.logo || ''
            };
            if (competitor.homeAway === 'home') homeTeam = team; else awayTeam = team;
          }
        }
        const tier = ['CL','EL','ECL','PL','PD','BL1','SA','FL1','NBA','NFL','NHL'].includes(leagueCode) ? 1 : 2;
        const fixture = {
          sport,
          tier,
          league: { name: leagueName, code: leagueCode },
          start_utc: startTime,
          status,
          home: homeTeam,
          away: awayTeam
        };
        fixtures.push(fixture);
      }catch(err){
        console.error('Error parsing fixture', err);
        continue;
      }
    }
    return fixtures;
  }
  async getFixtures(date){
    const allFixtures = [];
    const promises = Object.entries(this.espnEndpoints).map(async ([key, url]) => {
      const dateUrl = `${url}?dates=${date.replace(/-/g,'')}`;
      const data = await this.fetchWithCache(dateUrl);
      if (data){
        let sport = 'Soccer';
        let leagueName = '';
        let leagueCode = '';
        if (key.includes('nba')){ sport = 'NBA'; leagueName='NBA'; leagueCode='NBA'; }
        else if (key.includes('nfl')){ sport = 'NFL'; leagueName='NFL'; leagueCode='NFL'; }
        else if (key.includes('nhl')){ sport = 'NHL'; leagueName='NHL'; leagueCode='NHL'; }
        else {
          if (key.includes('uefa') && !key.includes('europa')){ leagueName='UEFA Champions League'; leagueCode='CL'; }
          else if (key.includes('europa_league')){ leagueName='UEFA Europa League'; leagueCode='EL'; }
          else if (key.includes('europa_conference')){ leagueName='UEFA Europa Conference League'; leagueCode='ECL'; }
          else if (key.includes('eng')){ leagueName='Premier League'; leagueCode='PL'; }
          else if (key.includes('esp')){ leagueName='La Liga'; leagueCode='PD'; }
          else if (key.includes('ger')){ leagueName='Bundesliga'; leagueCode='BL1'; }
          else if (key.includes('ita')){ leagueName='Serie A'; leagueCode='SA'; }
          else if (key.includes('fra')){ leagueName='Ligue 1'; leagueCode='FL1'; }
        }
        const fixtures = this.parseEspnFixtures(data, sport, leagueName, leagueCode);
        allFixtures.push(...fixtures);
      }
    });
    await Promise.allSettled(promises);
    allFixtures.sort((a,b) => new Date(a.start_utc) - new Date(b.start_utc));
    return allFixtures;
  }
}

// Utility functions
function fmtTime(d){
  try{ return new Date(d).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', hour12:false }); }catch{ return ''; }
}
function slug(s){
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}
function statusLabel(fx){
  const st = (fx.status||'').toUpperCase();
  if (/\bHT\b/.test(st) || /HALF/.test(st)) return 'HALF';
  if (/LIVE|IN_PLAY|1ST|2ND/.test(st)) return 'LIVE';
  if (/STATUS_FINAL|STATUS_POSTGAME|POSTGAME|FINAL|FULL\s?TIME|FULLTIME|ENDED|FINISH(?:ED)?|\bFT\b/.test(st)) return 'FINISHED';
  return 'SCHEDULED';
}
function fixLogo(u){ return u ? u.replace(/^http:/,'https:') : ''; }

// Favourites management
function getFavs(){
  try{ const raw = localStorage.getItem('favourites'); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function saveFavs(arr){
  try{ localStorage.setItem('favourites', JSON.stringify(arr)); } catch {}
}
function isFav(sl){
  if (!sl) return false;
  const favs = getFavs();
  return favs.includes(sl);
}
function toggleFav(sl){
  if (!sl) return;
  let favs = getFavs();
  const idx = favs.indexOf(sl);
  if (idx >= 0) favs.splice(idx,1); else favs.push(sl);
  saveFavs(favs);
  render();
}

// Globals for filter state
let activeSport = 'all';
let leagueKey = 'all';
let ALL = [];

// Highlight images per sport.  These URLs point to royalty-free photos on
// Wikimedia Commons and serve as placeholders for match highlights.  Each
// sport key corresponds to the fixture.sport value.  Feel free to replace
// these links with your own hosted images.
const HIGHLIGHT_IMAGES = {
  'Soccer': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Falmer_Stadium_Panorama.jpg/1280px-Falmer_Stadium_Panorama.jpg',
  'NBA': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f3/Little_Caesars_Arena_panorama.jpg/1280px-Little_Caesars_Arena_panorama.jpg',
  'NFL': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/FirstEnergy_Stadium_50_yardline_panorama.png/1280px-FirstEnergy_Stadium_50_yardline_panorama.png',
  'NHL': 'https://upload.wikimedia.org/wikipedia/commons/4/4a/O2_Arena_Panorama.jpg'
};

// League definitions for filtering
const LEAGUES = [
  { key:'all', label:'All Leagues', test: function(){ return true; } },
  { key:'ucl', label:'UEFA Champions League', test: fx => fx.league && ((fx.league.code||'').toUpperCase()==='CL' || /champions league/i.test(fx.league.name||'')) },
  { key:'uel', label:'UEFA Europa League', test: fx => fx.league && ((fx.league.code||'').toUpperCase()==='EL' || /europa league/i.test(fx.league.name||'')) },
  { key:'uecl', label:'UEFA Europa Conference League', test: fx => fx.league && ((fx.league.code||'').toUpperCase()==='ECL' || /conference league/i.test(fx.league.name||'')) },
  { key:'pl', label:'Premier League (England)', test: fx => fx.league && ((fx.league.code||'').toUpperCase()==='PL' || /premier league/i.test(fx.league.name||'')) },
  { key:'laliga', label:'La Liga (Spain)', test: fx => fx.league && ((fx.league.code||'').toUpperCase()==='PD' || /la\s*liga|primera division/i.test(fx.league.name||'')) },
  { key:'bundes', label:'Bundesliga (Germany)', test: fx => fx.league && ((fx.league.code||'').toUpperCase()==='BL1' || /bundesliga/i.test(fx.league.name||'')) },
  { key:'seriea', label:'Serie A (Italy)', test: fx => fx.league && ((fx.league.code||'').toUpperCase()==='SA' || /serie\s*a/i.test(fx.league.name||'')) },
  { key:'ligue1', label:'Ligue 1 (France)', test: fx => fx.league && ((fx.league.code||'').toUpperCase()==='FL1' || /ligue\s*1/i.test(fx.league.name||'')) }
];

// Setup filters and controls
function initControls(){
  const leagueWrap = document.getElementById('leagueWrap');
  const leagueMenu = document.getElementById('leagueMenu');
  const leagueToggle = document.getElementById('leagueToggle');
  const leagueChosen = document.getElementById('leagueChosen');
  leagueMenu.innerHTML = LEAGUES.map(L => '<button class="menuitem" role="menuitem" data-league="'+L.key+'">'+L.label+'</button>').join('');
  leagueChosen.textContent = 'All Leagues';
  leagueToggle.addEventListener('click', function(){
    const open = leagueToggle.getAttribute('aria-expanded') === 'true';
    leagueToggle.setAttribute('aria-expanded', String(!open));
    leagueMenu.classList.toggle('hidden', open);
  });
  document.addEventListener('click', function(e){
    if (!leagueWrap.contains(e.target)){
      leagueToggle.setAttribute('aria-expanded','false');
      leagueMenu.classList.add('hidden');
    }
  });
  leagueMenu.addEventListener('click', function(e){
    const b = e.target.closest('button[data-league]'); if (!b) return;
    leagueKey = b.dataset.league;
    const found = LEAGUES.find(x => x.key === leagueKey);
    leagueChosen.textContent = (found && found.label) ? found.label : '';
    leagueToggle.setAttribute('aria-expanded','false');
    leagueMenu.classList.add('hidden');
    render();
  });
  // Sport pills
  const pills = [].slice.call(document.querySelectorAll('.pill[data-sport]'));
  pills.forEach(p => {
    p.addEventListener('click', function(){
      pills.forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      activeSport = p.dataset.sport;
      render();
    });
  });
  // Major only toggle
  const majorOnlyEl = document.getElementById('majorOnly');
  const savedMajor = localStorage.getItem('majorOnly');
  if (savedMajor !== null) majorOnlyEl.checked = savedMajor === '1';
  majorOnlyEl.addEventListener('change', function(){
    localStorage.setItem('majorOnly', majorOnlyEl.checked ? '1' : '0');
    render();
  });
  // Search input
  const q = document.getElementById('q');
  q.addEventListener('input', function(){ render(); });
  // Mobile menu toggling
  const menuBtn = document.getElementById('menuBtn');
  const controlsEl = document.querySelector('.controls');
  const menuOverlay = document.getElementById('menuOverlay');
  if (menuBtn && controlsEl && menuOverlay){
    menuBtn.addEventListener('click', function(){
      const open = controlsEl.classList.toggle('open');
      menuOverlay.classList.toggle('active', open);
    });
    menuOverlay.addEventListener('click', function(){
      controlsEl.classList.remove('open');
      menuOverlay.classList.remove('active');
    });
  }
}

// Render the fixtures into the magazine layout
function render(){
  const heroDiv = document.getElementById('mag-hero');
  const upnextDiv = document.getElementById('mag-upnext');
  const favesDiv = document.getElementById('mag-faves');
  const gridDiv = document.getElementById('mag-grid');
  if (!ALL || !ALL.length){
    heroDiv.innerHTML = '';
    upnextDiv.innerHTML = '';
    favesDiv.innerHTML = '';
    gridDiv.innerHTML = '';
    return;
  }
  // Filter by sport
  let list = ALL.filter(fx => activeSport === 'all' || fx.sport === activeSport);
  // Filter by league
  const L = LEAGUES.find(x => x.key === leagueKey) || LEAGUES[0];
  list = list.filter(fx => L.test(fx));
  // Filter by major only toggle (hide minors)
  const majorOnlyEl = document.getElementById('majorOnly');
  if (majorOnlyEl && majorOnlyEl.checked){
    // Heuristic: treat tier 2 as minor
    list = list.filter(fx => fx.tier === 1);
  }
  // Filter by search term
  const searchTerm = document.getElementById('q').value.trim().toLowerCase();
  if (searchTerm){
    list = list.filter(fx => (fx.home.name + ' ' + fx.away.name).toLowerCase().includes(searchTerm));
  }
  if (!list.length){
    heroDiv.innerHTML = '';
    upnextDiv.innerHTML = '';
    favesDiv.innerHTML = '';
    gridDiv.innerHTML = '<div class="empty">No games found.</div>';
    return;
  }
  // Sort by favourites first, then by time
  list.sort((a,b) => {
    const favA = isFav(slug(a.home.name + '-vs-' + a.away.name)) ? 1 : 0;
    const favB = isFav(slug(b.home.name + '-vs-' + b.away.name)) ? 1 : 0;
    if (favA !== favB) return favB - favA;
    return new Date(a.start_utc) - new Date(b.start_utc);
  });
  // Choose hero: live match or first one
  let hero = list.find(fx => fx.status === 'LIVE') || list[0];
  const others = list.filter(fx => fx !== hero);
  // Render hero
  if (hero){
    const slugVal = slug(`${hero.home.name}-vs-${hero.away.name}`);
    // Build the watch page URL using the legacy `id` parameter so it works with watch.html
    // Append the match start time to the slug (slug@ISO) so the watch page can resolve the correct fixture
    const watchHref = '/watch.html?id=' + encodeURIComponent(slugVal + '@' + hero.start_utc);
    heroDiv.innerHTML = '';
    const favClass = isFav(slugVal) ? 'active' : '';
    // Render hero without photo or video — only logos, info and favourite star
    heroDiv.innerHTML = `
      <div class="logo-wrap">
        <img src="${fixLogo(hero.home.logo)}" alt="${hero.home.name}" />
        <img src="${fixLogo(hero.away.logo)}" alt="${hero.away.name}" />
      </div>
      <div class="hero-info">
        <h3>${hero.home.name} vs ${hero.away.name}</h3>
        <div class="league">${hero.league.name || hero.league.code || ''}</div>
        <div class="time">${fmtTime(hero.start_utc)}</div>
        <a class="btn-watch" href="${watchHref}" target="_blank">Watch Now</a>
      </div>
      <span class="fav ${favClass}">★</span>
    `;
    const favEl = heroDiv.querySelector('.fav');
    favEl.addEventListener('click', function(ev){ ev.stopPropagation(); toggleFav(slugVal); });
    heroDiv.addEventListener('click', function(){ window.open(watchHref, '_blank'); });
  }
  // Render up next (next 3 matches)
  upnextDiv.innerHTML = '';
  const upList = others.slice(0,3);
  if (upList.length){
    let h = document.createElement('h4');
    h.textContent = 'Up Next';
    upnextDiv.appendChild(h);
    upList.forEach(fx => {
      const slugVal = slug(`${fx.home.name}-vs-${fx.away.name}`);
      // Include the fixture start time for precise identification
      const watchHref = '/watch.html?id=' + encodeURIComponent(slugVal + '@' + fx.start_utc);
      const item = document.createElement('div');
      item.className = 'up-item';
      item.innerHTML = `
        <img src="${fixLogo(fx.home.logo)}" alt="${fx.home.name}" />
        <img src="${fixLogo(fx.away.logo)}" alt="${fx.away.name}" />
        <div class="match-name">${fx.home.name} vs ${fx.away.name}</div>
        <div class="match-time">${fmtTime(fx.start_utc)}</div>
      `;
      item.addEventListener('click', () => { window.open(watchHref, '_blank'); });
      upnextDiv.appendChild(item);
    });
  }
  // Render favourites list
  favesDiv.innerHTML = '';
  const favFixtures = others.filter(fx => isFav(slug(`${fx.home.name}-vs-${fx.away.name}`)));
  if (favFixtures.length){
    let h = document.createElement('h4');
    h.textContent = 'Favourites';
    favesDiv.appendChild(h);
    favFixtures.forEach(fx => {
      const slugVal = slug(`${fx.home.name}-vs-${fx.away.name}`);
      // Include the fixture start time for precise identification
      const watchHref = '/watch.html?id=' + encodeURIComponent(slugVal + '@' + fx.start_utc);
      const item = document.createElement('div');
      item.className = 'up-item';
      item.innerHTML = `
        <img src="${fixLogo(fx.home.logo)}" alt="${fx.home.name}" />
        <img src="${fixLogo(fx.away.logo)}" alt="${fx.away.name}" />
        <div class="match-name">${fx.home.name} vs ${fx.away.name}</div>
        <div class="match-time">${fmtTime(fx.start_utc)}</div>
      `;
      item.addEventListener('click', () => { window.open(watchHref, '_blank'); });
      favesDiv.appendChild(item);
    });
  }
  // Render grid of remaining matches (skip up next and favourites duplicates)
  gridDiv.innerHTML = '';
  const skip = new Set();
  if (hero) skip.add(hero);
  upList.forEach(fx => skip.add(fx));
  favFixtures.forEach(fx => skip.add(fx));
  const rest = others.filter(fx => !skip.has(fx));
  rest.forEach(fx => {
    const slugVal = slug(`${fx.home.name}-vs-${fx.away.name}`);
    // Include the fixture start time for precise identification
    const watchHref = '/watch.html?id=' + encodeURIComponent(slugVal + '@' + fx.start_utc);
    const card = document.createElement('div');
    card.className = 'mag-card';
    const favClass = isFav(slugVal) ? 'active' : '';
    card.innerHTML = `
      <span class="fav ${favClass}" title="Favourite">★</span>
      <div class="match-info">
        <div class="league">${fx.league.name || fx.league.code || ''}</div>
        <div class="status">${statusLabel(fx)}</div>
      </div>
      <div class="teams">
        <div class="team"><img src="${fixLogo(fx.home.logo)}" alt="${fx.home.name}" /><span class="name">${fx.home.name}</span></div>
        <div class="team"><span class="name">${fx.away.name}</span><img src="${fixLogo(fx.away.logo)}" alt="${fx.away.name}" /></div>
      </div>
      <div class="watch-wrap"><a class="watch-btn" href="${watchHref}" target="_blank">Watch</a></div>
    `;
    // Favourite star toggle
    const favEl = card.querySelector('.fav');
    favEl.addEventListener('click', function(ev){ ev.stopPropagation(); toggleFav(slugVal); });
    card.addEventListener('click', function(){ window.open(watchHref, '_blank'); });
    gridDiv.appendChild(card);
  });
}

// Fetch fixtures for today and tomorrow and populate ALL
async function loadUpcoming(){
  const sportsFetcher = new SportsFetcher();
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0,10);
  const tomorrow = new Date(now + 86400000).toISOString().slice(0,10);
  const days = [today, tomorrow];
  let combined = [];
  for (const d of days){
    const fx = await sportsFetcher.getFixtures(d);
    combined = combined.concat(fx);
  }
  // Filter to within ±6h from now to avoid stale matches
  const past = 6 * 60 * 60 * 1000;
  const future = 48 * 60 * 60 * 1000;
  const nowMs = Date.now();
  combined = combined.filter(fx => {
    const ts = Date.parse(fx.start_utc);
    if (!isFinite(ts)) return false;
    const diff = ts - nowMs;
    return diff < future && diff > -past;
  });
  ALL = combined;
  render();
}

// Initialize controls and kick off loading when DOM is ready
document.addEventListener('DOMContentLoaded', function(){
  initControls();
  loadUpcoming();
  // Refresh fixtures every 15 minutes
  setInterval(loadUpcoming, 15 * 60 * 1000);
});