
(function(){
  const ESPN = {
    soccer_uefa: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard',
    soccer_eng: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
    soccer_esp: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
    soccer_ger: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard',
    soccer_ita: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard',
    soccer_fra: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard',
    nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
    nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
    nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard'
  };

  const q = document.getElementById('q');
  const majorOnlyEl = document.getElementById('majorOnly');
  const feed = document.getElementById('feed');
  const upnext = document.getElementById('upnext');
  const favsEl = document.getElementById('favs');

  const hero = {
    title: document.getElementById('heroTitle'),
    sub: document.getElementById('heroSub'),
    dot: document.getElementById('heroDot'),
    eyebrow: document.getElementById('heroEyebrow'),
    watch: document.getElementById('heroWatch'),
    fav: document.getElementById('heroFav'),
  };

  const ymd = (ts)=> new Date(ts).toISOString().split('T')[0];
  const fmtTime = d => new Date(d).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12:false});
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g,'');

  function isMinor(leagueName='', home='', away=''){
    const L = (leagueName||'').toLowerCase();
    const h = (home||'').toLowerCase();
    const a = (away||'').toLowerCase();
    const minorLeague = /(u\\d{2}|youth|academy|reserves?|friendly|pre[- ]?season|premier league 2|development)/i;
    const minorTeam = /(u\\d{2}|reserves?|\\bii\\b|\\bb\\b|academy)/i;
    return minorLeague.test(L) || minorTeam.test(h) || minorTeam.test(a);
  }

  function getFavs(){
    try{ return JSON.parse(localStorage.getItem('favourites') || '[]'); }catch{return [];}
  }
  function saveFavs(arr){ localStorage.setItem('favourites', JSON.stringify(arr)); }
  function isFav(s){ return getFavs().includes(s); }
  function toggleFav(s){
    const arr = getFavs();
    const i = arr.indexOf(s);
    if(i>=0) arr.splice(i,1); else arr.push(s);
    saveFavs(arr); render();
  }

  function statusLabel(st){
    st = (st||'').toUpperCase();
    if(/LIVE|IN_PROGRESS/.test(st)) return 'LIVE';
    if(/FINAL|POSTGAME|FINISH/.test(st)) return 'FINAL';
    if(/HALF/.test(st)) return 'HALF';
    return 'SCHEDULED';
  }

  function parseEspn(data, sport, leagueName='', leagueCode=''){
    const out = [];
    if(!data || !data.events) return out;
    for(const ev of data.events){
      try{
        let home = { name:'', logo:'' }, away = { name:'', logo:'' };
        (ev?.competitions?.[0]?.competitors||[]).forEach(c => {
          const t = { name: c?.team?.displayName||'', logo: c?.team?.logo||'' };
          if(c.homeAway === 'home') home = t; else away = t;
        });
        out.push({
          sport,
          league: { name: leagueName, code: leagueCode },
          start_utc: ev.date,
          status: statusLabel(ev?.status?.type?.name),
          home, away,
        });
      }catch(e){}
    }
    return out;
  }

  function mapInfo(key){
    if(key.includes('nba')) return ['NBA','NBA','NBA'];
    if(key.includes('nfl')) return ['NFL','NFL','NFL'];
    if(key.includes('nhl')) return ['NHL','NHL','NHL'];
    if(key.includes('uefa') && !key.includes('europa')) return ['Soccer','UEFA Champions League','CL'];
    if(key.includes('eng')) return ['Soccer','Premier League','PL'];
    if(key.includes('esp')) return ['Soccer','La Liga','PD'];
    if(key.includes('ger')) return ['Soccer','Bundesliga','BL1'];
    if(key.includes('ita')) return ['Soccer','Serie A','SA'];
    if(key.includes('fra')) return ['Soccer','Ligue 1','FL1'];
    return ['Soccer','Football','FOOT'];
  }

  const ALL = [];
  async function load(){
    const now = Date.now();
    const dates = [ymd(now), ymd(now+24*3600*1000)];
    const promises = [];
    for(const [key,url] of Object.entries(ESPN)){
      for(const d of dates){
        promises.push(fetch(`${url}?dates=${d.replace(/-/g,'')}`).then(r=>r.json()).then(data=>{
          const [sport, name, code]= mapInfo(key);
          ALL.push(...parseEspn(data, sport, name, code));
        }).catch(()=>{}));
      }
    }
    await Promise.allSettled(promises);
    ALL.sort((a,b)=> new Date(a.start_utc) - new Date(b.start_utc));
    render();
  }

  let activeSport='all';
  const pillsEls = Array.from(document.querySelectorAll('.pill[data-sport]'));
  pillsEls.forEach(b=>{
    b.addEventListener('click',()=>{
      pillsEls.forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      activeSport = b.dataset.sport;
      render();
    });
  });
  // Default active
  pillsEls[0].classList.add('active');

  const majorOnlyElDom = majorOnlyEl;
  const savedMajor = localStorage.getItem('majorOnly');
  if(savedMajor!==null) majorOnlyElDom.checked = savedMajor==='1';
  majorOnlyElDom.addEventListener('change',()=>{
    localStorage.setItem('majorOnly', majorOnlyElDom.checked?'1':'0');
    render();
  });

  q.addEventListener('input', render);

  function cardHTML(f){
    const s = slug(`${f.home.name}-vs-${f.away.name}`);
    const fav = isFav(s);
    return `<div class="game" data-slug="${s}">
      <div class="head">
        <div class="muted"><span class="dot ${f.status==='LIVE'?'live':''}"></span> ${f.league.name||f.league.code||''}</div>
        <div class="muted" style="text-transform:uppercase;font-size:12px">${f.sport==='Soccer'?'Football':f.sport}</div>
      </div>
      <div class="grid-row" style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center">
        <div class="team"><img class="badge" src="${f.home.logo||''}" onerror="this.style.display='none'"/><span class="name">${f.home.name||''}</span></div>
        <div class="score"><div class="vs">VS</div><div class="when">${fmtTime(f.start_utc)}</div></div>
        <div class="team right"><span class="name">${f.away.name||''}</span><img class="badge" src="${f.away.logo||''}" onerror="this.style.display='none'"/></div>
      </div>
      <a class="btn" style="margin-top:10px;display:inline-flex" href="/watch.html?m=${encodeURIComponent(s)}">▶ Watch</a>
      <span class="fav ${fav?'active':''}" title="Favourite">★</span>
    </div>`;
  }

  function setHero(f){
    if(!f){ 
      hero.title.textContent = 'No matches found';
      hero.sub.textContent = 'Try a different filter.';
      hero.watch.href = '#';
      return;
    }
    hero.title.textContent = `${f.home.name} vs ${f.away.name}`;
    hero.sub.textContent = `${f.league.name||f.league.code||''} • Kickoff ${fmtTime(f.start_utc)}`;
    hero.dot.classList.toggle('live', f.status==='LIVE');
    hero.eyebrow.textContent = f.status==='LIVE' ? 'Featured Live' : 'Featured Match';
    const s = slug(`${f.home.name}-vs-${f.away.name}`);
    hero.watch.href = `/watch.html?m=${encodeURIComponent(s)}`;
    hero.fav.textContent = (isFav(s)?'★ Favourited':'☆ Favourite');
    hero.fav.onclick = () => toggleFav(s);
  }

  function render(){
    const term = (q.value||'').trim().toLowerCase();
    let arr = ALL.slice();
    if(activeSport!=='all') arr = arr.filter(f => f.sport===activeSport);
    if(majorOnlyEl.checked) arr = arr.filter(f => !isMinor(f.league?.name, f.home?.name, f.away?.name));
    if(term) arr = arr.filter(f => (`${f.home.name} ${f.away.name} ${f.league?.name||''}`).toLowerCase().includes(term));

    // Featured: live first, else next within 6h
    let featured = arr.find(f => f.status==='LIVE');
    if(!featured){
      const now = Date.now();
      featured = arr.find(f => {
        const t = Date.parse(f.start_utc||0);
        const d = t-now;
        return d < 6*3600*1000 && d > -3600*1000;
      }) || arr[0];
    }
    setHero(featured);

    // Up next rail
    upnext.innerHTML = '';
    (arr.slice(0,6)).forEach(f => {
      const el = document.createElement('div');
      el.className = 'row';
      el.innerHTML = `<div class="truncate"><strong>${f.home.name}</strong> <span class="muted">vs</span> <strong>${f.away.name}</strong></div><div class="muted" style="font-size:12px">${fmtTime(f.start_utc)}</div>`;
      el.style.display = 'flex'; el.style.alignItems='center'; el.style.justifyContent='space-between'; el.style.gap='8px';
      upnext.appendChild(el);
    });

    // Favourites rail
    const favs = getFavs();
    favsEl.innerHTML = '';
    if(favs.length===0){
      const none = document.createElement('div'); none.className='muted'; none.textContent='No favourites yet.'; favsEl.appendChild(none);
    }else{
      favs.forEach(s => {
        const row = document.createElement('div');
        row.style.display='flex'; row.style.alignItems='center'; row.style.justifyContent='space-between'; row.style.gap='8px';
        row.innerHTML = `<div class="truncate">${s.replace(/-/g,' ')}</div><button class="btn ghost" style="padding:6px 8px;font-size:12px">Remove</button>`;
        row.querySelector('button').onclick = ()=> toggleFav(s);
        favsEl.appendChild(row);
      });
    }

    // Feed
    feed.innerHTML = '';
    if(arr.length===0){
      const empty = document.createElement('div');
      empty.className = 'card muted';
      empty.textContent = 'No matches found for current filters.';
      empty.style.gridColumn = '1 / -1';
      feed.appendChild(empty);
      return;
    }
    arr.forEach(f => {
      const wrap = document.createElement('div');
      wrap.innerHTML = cardHTML(f);
      const node = wrap.firstElementChild;
      node.querySelector('.fav').onclick = () => toggleFav(node.getAttribute('data-slug'));
      feed.appendChild(node);
    });
  }

  load().catch(()=>{
    feed.innerHTML = '<div class="card muted" style="grid-column:1/-1">Could not load fixtures right now.</div>';
  });
})(); 
