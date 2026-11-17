'use strict';

// CINELIST: the public application contains neither the password nor plaintext media data.
// The encrypted archive is downloaded before unlocking and decrypted in browser memory.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const entity = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const providerNames = {csfd:'ČSFD',tmdb:'TMDB',imdb:'IMDb',tvmaze:'TVmaze',trakt:'Trakt',metacritic:'Metacritic',rt:'Rotten Tomatoes'};
const allowedArts = new Set(['art-a','art-b','art-c','art-d','art-e','art-f']);
const state = {type:'all',genre:'all',status:'all',sort:'csfd',query:'',layout:'grid'};
let media = [];
let envelope = null;
let toastTimer = null;
let heroQueue = [];
let heroPosition = 0;
let detailRequest = null;
let detailCounter = 0;
let databaseLastModified = null;
// Online artwork is never merged into the decrypted library or published to Git.
const artworkById=new Map();
const artworkPending=new Set();
let artworkJobs=[], artworkBusy=0, artworkSession=0, artworkController=null;
let cardObserver=null;
const SLIDE_DURATION=4000;
let heroRaf=0,heroElapsed=0,heroTimestamp=0,heroHover=false;
const reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;


function safeUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; }
  catch { return null; }
}
function formatMinutes(value) {
  return Number.isFinite(value) && value > 0 ? `${Math.floor(value/60)} h ${String(value%60).padStart(2,'0')} min` : '—';
}
function ratingFor(item, provider) {
  const r = item.ratings?.[provider];
  return r && Number.isFinite(r.value) ? r : null;
}
function ratingLabel(provider, rating) {
  if (!rating) return '—';
  if (rating.max === 100 || provider === 'csfd' || provider === 'metacritic' || provider === 'rt') return `${rating.value} %`;
  return Number(rating.value).toFixed(1).replace(/\.0$/, '.0');
}
// Legacy ČSFD imports sometimes included the HTML "více" expand link.
// Clean the in-memory value immediately, even before users re-encrypt their database.
function cleanOriginal(value) {
  return String(value ?? '').trim().replace(/\s+(?:více|vice)\s*$/i, '').trim();
}
function statusLabel(status) {
  return {watchlist:'Chci vidět',download:'Ke stažení',watching:'Rozkoukáno',watched:'Viděno'}[status] || 'V seznamu';
}
function poster(item) {
  const art = allowedArts.has(item.art) ? item.art : 'generic';
  let shape = '';
  if (art === 'art-a') shape = '<div class="shape"></div><div class="poster-deco-num" aria-hidden="true">7</div>';
  if (art === 'art-b') shape = '<div class="shape one"></div><div class="shape two"></div><div class="shape three"></div>';
  if (['art-c','art-d','art-e','art-f'].includes(art)) shape = '<div class="shape one"></div><div class="shape two"></div>';
  const headline = entity(item.posterTitle || item.title);
  const top = entity(item.posterHeader || (item.type === 'series' ? 'TV SERIES' : 'FEATURE FILM'));
  const live=artworkById.get(item.id)?.poster;
  return `<div class="poster ${art}" data-poster-id="${entity(item.id)}" role="img" aria-label="Plakát: ${entity(item.title)}"><div class="poster-head">${top}</div>${shape}<div class="poster-title">${headline}</div>${live?`<img class="poster-live" loading="lazy" decoding="async" alt="" src="${entity(live)}">`:''}</div>`;
}
function itemCard(item) {
  const typeLabel = item.type === 'movie' ? 'Film' : 'Seriál';
  const meta = item.type === 'movie' ? formatMinutes(item.duration) : `${item.seasons ?? '—'} sérií · ${item.episodes ?? '—'} epizod`;
  const ratings = ['csfd','tmdb','imdb'].filter(p => ratingFor(item,p)).map((p) => {
    const r = ratingFor(item,p);
    const title = r.sample ? 'Demonstrační hodnocení, není ověřeno' : `Hodnocení ${providerNames[p]}`;
    return `<span class="rating ${p === 'csfd' ? 'csfd' : ''}" title="${entity(title)}"><span class="rating-name">${providerNames[p]}</span><span class="rating-score">${ratingLabel(p,r)}${r.sample ? '<span class="rating-demo">*</span>' : ''}</span></span>`;
  }).join('');
  return `<article class="media-card" data-id="${entity(item.id)}" role="button" tabindex="0" aria-label="Otevřít detail: ${entity(item.title)}">
    <div class="card-main">${poster(item)}<div class="card-info"><div class="card-topline"><span class="media-type">${typeLabel}</span><span class="status">${statusLabel(item.status)}</span></div><h3>${entity(item.title)}</h3><div class="card-original">${entity(item.original)}</div><div class="card-meta"><span>${item.year ?? '—'}</span><span class="sep"></span><span>${entity(meta)}</span></div><div class="card-genres">${item.genres.map(g => `<span>${entity(g)}</span>`).join('')}</div></div></div>
    <div class="card-bottom"><div class="ratings">${ratings || '<span class="rating-name">Hodnocení není k dispozici</span>'}</div><span class="card-arrow">${icon('arrow')}</span></div>
  </article>`;
}
function normalize(text) { return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
function filtered() {
  const q = normalize(state.query.trim());
  const list = media.filter(m =>
    (state.type === 'all' || m.type === state.type) &&
    (state.status === 'all' || m.status === state.status) &&
    (state.genre === 'all' || (state.genre === '90plus' ? (ratingFor(m,'csfd')?.value ?? -1) >= 90 : m.genres.includes(state.genre))) &&
    (!q || normalize(`${m.title} ${m.original} ${m.genres.join(' ')} ${m.year}`).includes(q))
  );
  const byName = (a,b) => a.title.localeCompare(b.title, 'cs');
  const numeric = (item,key) => ratingFor(item,key)?.value ?? -1;
  list.sort((a,b) => {
    switch (state.sort) {
      case 'name': return byName(a,b);
      case 'year-desc': return (b.year??0)-(a.year??0) || byName(a,b);
      case 'year-asc': return (a.year??Infinity)-(b.year??Infinity) || byName(a,b);
      case 'tmdb': return numeric(b,'tmdb')-numeric(a,'tmdb') || byName(a,b);
      case 'imdb': return numeric(b,'imdb')-numeric(a,'imdb') || byName(a,b);
      case 'duration': return (a.duration??Infinity)-(b.duration??Infinity) || byName(a,b);
      default: return numeric(b,'csfd')-numeric(a,'csfd') || byName(a,b);
    }
  });
  return list;
}
function shuffleIds(items) {
  const ids = items.map(item => item.id);
  for (let i=ids.length-1;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    [ids[i],ids[j]] = [ids[j],ids[i]];
  }
  return ids;
}
function renderHero() {
  if (!heroQueue.length) {
    $('#heroTitle').textContent = 'Knihovna je zatím prázdná';
    $('#heroFeaturePoster').replaceChildren();
    $('#heroMeta').replaceChildren();
    $('#heroGenres').replaceChildren();
    $('#heroOpen').hidden=true;
    $('#heroPagination').replaceChildren();
    return;
  }
  const item=media.find(m=>m.id===heroQueue[heroPosition]);
  if(!item) return;
  $('#heroOpen').hidden=false;
  $('#heroTitle').textContent=item.title;
  $('#heroFeaturePoster').innerHTML=poster(item);
  const stat = item.type==='series'
    ? `${item.seasons??'—'} sérií · ${item.episodes??'—'} epizod`
    : formatMinutes(item.duration);
  $('#heroMeta').textContent=`${item.type==='movie'?'Film':'Seriál'} · ${item.year??'—'} · ${stat}`;
  $('#heroGenres').innerHTML=(item.genres||[]).slice(0,3).map(g=>`<span>${entity(g)}</span>`).join('')
    +(ratingFor(item,'csfd')?`<span class="hero-csfd">ČSFD ${entity(ratingLabel('csfd',ratingFor(item,'csfd')))}</span>`:'');
  $('#heroFeature').dataset.id=item.id;
  $('#heroFeature').setAttribute('aria-label',`Otevřít detail: ${item.title}`);
  $('#heroPagination').innerHTML=heroQueue.map((_,i)=>`<span class="hero-page-dot${i===heroPosition?' active':i<heroPosition?' completed':''}" aria-hidden="true"><span class="hero-dot-fill"></span></span>`).join('');
  showHeroProgress();
  $('#heroPrev').disabled=heroQueue.length<2;
  $('#heroNext').disabled=heroQueue.length<2;
}
function showHeroProgress() {
  const active=$('.hero-page-dot.active .hero-dot-fill');
  if(active)active.style.transform=`scaleX(${Math.min(1,heroElapsed/SLIDE_DURATION)})`;
}
function pauseHero() { heroTimestamp=0; if(heroRaf){cancelAnimationFrame(heroRaf);heroRaf=0;} }
function heroTick(now) {
  heroRaf=0;
  if(document.body.classList.contains('locked')||document.hidden||heroHover||$('#detailDialog').open||reducedMotion){heroTimestamp=0;return;}
  if(heroTimestamp)heroElapsed+=Math.min(now-heroTimestamp,150);
  heroTimestamp=now;
  if(heroElapsed>=SLIDE_DURATION){moveHero(1);return;}
  showHeroProgress();
  heroRaf=requestAnimationFrame(heroTick);
}
function resumeHero(){if(heroRaf || heroQueue.length<2 || reducedMotion || document.hidden || heroHover || $('#detailDialog').open || document.body.classList.contains('locked'))return;heroTimestamp=0;heroRaf=requestAnimationFrame(heroTick);}
function moveHero(step) {
  if(heroQueue.length<2)return;
  heroPosition=(heroPosition+step+heroQueue.length)%heroQueue.length;
  heroElapsed=0;heroTimestamp=0;
  renderHero();
  resumeHero();
}
function initHero() {
  pauseHero();
  // One random run of up to ten titles, replayed in a loop until locking.
  heroQueue=shuffleIds(media).slice(0,10);
  heroPosition=0;heroElapsed=0;
  renderHero();
  prefetchHeroArt();
  resumeHero();
}
function patchPoster(id,url) {
  const targets=$$('[data-poster-id]').filter(el=>el.dataset.posterId===id);
  for(const el of targets){
    if(el.querySelector('img.poster-live'))continue;
    const image=document.createElement('img');
    image.className='poster-live';image.loading='lazy';image.decoding='async';
    image.alt='';image.src=url;
    el.append(image);
  }
}
async function resolveQueuedArtwork(job,session,signal) {
  try {
    const module=await import('./online-details.mjs?v=3.2.0');
    if(signal.aborted || session!==artworkSession)return;
    const art=await module.resolveArtwork(job.item,signal);
    if(signal.aborted || session!==artworkSession || document.body.classList.contains('locked'))return;
    if(art?.poster){
      artworkById.set(job.item.id,art);
      patchPoster(job.item.id,art.poster);
      // Image requests are cached by the service worker when available.
      const preload=new Image();preload.decoding='async';preload.src=art.poster;
    }
  } catch(error) {
    if(!signal.aborted)console.debug('Artwork unavailable:',job.item.id,error?.message||error);
  } finally {
    if(session===artworkSession) {
      artworkPending.delete(job.item.id);
      artworkBusy=Math.max(0,artworkBusy-1);
      drainArtworkQueue();
    }
  }
}
function drainArtworkQueue(){
  while(artworkBusy<3 && artworkJobs.length && artworkController && !artworkController.signal.aborted){
    const job=artworkJobs.shift();artworkBusy++;
    void resolveQueuedArtwork(job,artworkSession,artworkController.signal);
  }
}
function queueArtwork(item,priority=false) {
  if(!item || artworkById.has(item.id) || artworkPending.has(item.id) || !artworkController || artworkController.signal.aborted)return;
  artworkPending.add(item.id);
  if(priority)artworkJobs.unshift({item});else artworkJobs.push({item});
  drainArtworkQueue();
}
function prefetchHeroArt() {
  for(const id of heroQueue)queueArtwork(media.find(m=>m.id===id),true);
}
function observeCardArt() {
  cardObserver?.disconnect();
  if(!artworkController || artworkController.signal.aborted)return;
  if(!('IntersectionObserver' in window)){
    for(const el of $$('.media-card'))queueArtwork(media.find(m=>m.id===el.dataset.id));
    return;
  }
  cardObserver=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting)continue;
      const item=media.find(m=>m.id===entry.target.dataset.id);
      queueArtwork(item);
      cardObserver?.unobserve(entry.target);
    }
  },{rootMargin:'220px 0px',threshold:0});
  $$('.media-card').forEach(el=>cardObserver.observe(el));
}
function resetArtwork() {
  artworkController?.abort();
  artworkController=null;artworkSession++;
  cardObserver?.disconnect();cardObserver=null;
  artworkJobs=[];artworkBusy=0;artworkById.clear();artworkPending.clear();
  // Previous async operations release their workers in their own finally block.
}
function startArtwork() {
  resetArtwork();
  artworkController=new AbortController();
}
function setHeaderNav() {
  if(document.body.classList.contains('locked'))return;
  const library=$('#knihovna');
  const inLibrary=library.getBoundingClientRect().top <= Math.min(270, window.innerHeight * .33);
  const active=inLibrary?state.type:'overview';
  $$('.desktop-nav a').forEach(link=>{
    const selected=active==='overview'?link.getAttribute('href')==='#top':link.dataset.navType===active;
    link.classList.toggle('active',selected);
    if(selected)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  });
}
function setUpdatedStamp(content) {
  const d=content.updatedAt||content.modifiedAt||envelope?.encryptedAt||databaseLastModified;
  const date=typeof d==='string'?new Date(d):null;
  if(!date||Number.isNaN(date.getTime())) {
    $('#dbUpdated').textContent='Poslední aktualizace databáze: neuvedena';return;
  }
  const label=(content.updatedAt||content.modifiedAt)?'Databáze aktualizována':envelope?.encryptedAt?'Naposledy zašifrováno':'Naposledy zveřejněno';
  $('#dbUpdated').textContent=`${label}: ${new Intl.DateTimeFormat('cs-CZ',{dateStyle:'medium',timeStyle:'short'}).format(date)}`;
}
function render() {
  if (document.body.classList.contains('locked')) return;
  const items = filtered();
  const catalogue = $('#catalogue');
  catalogue.classList.toggle('list-mode',state.layout === 'list');
  catalogue.innerHTML = items.length ? items.map(itemCard).join('') : `<div class="empty-state">${icon('search')}<h3>Nic jsme nenašli</h3><p>Zkus změnit hledání nebo vypnout některý z filtrů.</p><button class="btn btn-outline" id="clearFilters">Vymazat filtry</button></div>`;
  $('#resultCount').innerHTML = `Zobrazeno <strong>${items.length}</strong> z ${media.length} titulů`;
  $$('.tab').forEach(b=>{const on=b.dataset.type===state.type;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
  $$('.chip').forEach(b=>{const on=b.dataset.chip===state.genre;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
  $$('[data-mobile-type]').forEach(b=>b.classList.toggle('active',b.dataset.mobileType===state.type));
  $$('.media-card').forEach(node=>{
    const open=()=>showDetails(node.dataset.id);
    node.addEventListener('click',open);
    node.addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
  });
  if ($('#clearFilters')) $('#clearFilters').addEventListener('click',resetFilters);
  observeCardArt();
  setHeaderNav();
}
function resetFilters() {
  Object.assign(state,{type:'all',genre:'all',status:'all',sort:'csfd',query:''});
  $('#globalSearch').value=''; $('#mobileSearch').value=''; $('#statusFilter').value='all'; $('#sortSelect').value='csfd'; $('#genreSelect').value='all';render();
}
function setType(type) { state.type=type;render();setHeaderNav(); }
function updateMetrics() {
  const movies=media.filter(m=>m.type==='movie');
  const series=media.filter(m=>m.type==='series');
  const formatTotal=minutes=>minutes>0?`${Math.floor(minutes/60).toLocaleString('cs-CZ')} h ${String(minutes%60).padStart(2,'0')} min`:'—';
  const average=items=>{
    const scores=items.map(item=>ratingFor(item,'csfd')?.value).filter(Number.isFinite);
    return scores.length?`${Math.round(scores.reduce((a,b)=>a+b,0)/scores.length)} %`:'—';
  };
  const years=new Map();
  movies.filter(m=>Number.isSafeInteger(m.year)).forEach(m=>years.set(m.year,(years.get(m.year)||0)+1));
  const popularYear=[...years].sort((a,b)=>b[1]-a[1]||b[0]-a[0])[0];
  const filmTime=movies.reduce((sum,m)=>sum+(m.duration||0),0);
  const episodeCount=series.reduce((sum,m)=>sum+(m.episodes||0),0);
  // Series duration represents minutes per episode ONLY when supplied; otherwise unknown.
  const knownRuntime=series.filter(m=>Number.isFinite(m.episodes) && m.episodes>0 &&
    Number.isFinite(m.episodeRuntime ?? m.duration) && (m.episodeRuntime ?? m.duration)>0);
  const seriesTime=knownRuntime.reduce((sum,m)=>sum+(m.episodeRuntime??m.duration)*m.episodes,0);
  $('#statMovies').textContent=movies.length.toLocaleString('cs-CZ');
  $('#statMovieTime').textContent=formatTotal(filmTime);
  $('#statMovieYear').textContent=popularYear?String(popularYear[0]):'—';
  $('#statMovieYear').title=popularYear?`Zastoupení: ${popularYear[1]} filmů`:'Chybí údaje o roce';
  $('#statMovieRating').textContent=average(movies);
  $('#statSeries').textContent=series.length.toLocaleString('cs-CZ');
  $('#statEpisodes').textContent=episodeCount?episodeCount.toLocaleString('cs-CZ'):'—';
  $('#statSeriesTime').textContent=formatTotal(seriesTime);
  $('#statSeriesTime').title=knownRuntime.length<series.length?'Délka epizod není dostupná u všech seriálů. Zobrazen je jen známý čas.':'';
  $('#statSeriesRating').textContent=average(series);
  $('#tabAll').textContent=media.length;
  $('#tabMovies').textContent=media.filter(m=>m.type==='movie').length;
  $('#tabSeries').textContent=media.filter(m=>m.type==='series').length;
  const count = new Map();
  media.forEach(m => m.genres.forEach(g => count.set(g, (count.get(g) || 0) + 1)));
  const genres = [...count.keys()].sort((a,b) => count.get(b)-count.get(a) || a.localeCompare(b,'cs'));
  const choices = genres.slice(0, 5);
  $('#genreChips').innerHTML = `<button class="chip active" data-chip="all" aria-pressed="true">Všechny žánry</button>`
      + choices.map(g => `<button class="chip" data-chip="${entity(g)}" aria-pressed="false">${entity(g)}</button>`).join('')
      + `<button class="chip" data-chip="90plus" aria-pressed="false">ČSFD 90 % a více</button>`;
  const genreSelect = $('#genreSelect');
  genreSelect.innerHTML = '<option value="all">Všechny žánry</option>' + genres.map(g=>`<option value="${entity(g)}">${entity(g)}</option>`).join('');

}
async function showDetails(id) {
  const item=media.find(m=>m.id===id); if (!item) return;
  pauseHero();
  if(detailRequest) detailRequest.abort();
  detailRequest=new AbortController();
  const requestId=++detailCounter;
  const movie=item.type==='movie';
  const ratings=Object.entries(item.ratings||{}).filter(([,r])=>r && Number.isFinite(r.value)).map(([p,r])=>`<div class="modal-rating ${p==='csfd'?'csfd':''}"><span>${entity(providerNames[p] || p)}</span><strong>${entity(ratingLabel(p,r))}</strong>${r.sample?'<div class="rating-sample">Demo, neověřeno</div>':''}</div>`).join('');
  const links=Object.entries(item.links || {}).map(([p,url]) => ({provider:p,url:safeUrl(url)})).filter(l=>l.url).map(l=>`<a class="btn ${l.provider==='csfd'?'btn-red':'btn-ghost'}" href="${entity(l.url)}" target="_blank" rel="noopener noreferrer">Otevřít ${entity(providerNames[l.provider]||l.provider)} ${icon('external')}</a>`).join('');
  $('#detailContent').innerHTML=`<button class="modal-close" id="detailClose" aria-label="Zavřít detail">${icon('close')}</button>
  <div class="modal-visual" id="detailVisual">${poster(item)}<div class="modal-headline"><div class="eyebrow"><span class="dot"></span> ${movie?'Film':'Seriál'} · ${item.year ?? '—'}</div><h2>${entity(item.title)}</h2><p>${entity(item.original)}</p></div></div>
  <div class="modal-content"><div class="modal-rating-row">${ratings || '<p>Hodnocení není dostupné.</p>'}</div><div class="modal-genres">${item.genres.map(g=>`<span>${entity(g)}</span>`).join('')}</div>
  <div class="online-details" id="onlineDetails"><div class="online-loading"><span class="spinner" aria-hidden="true"></span><div><strong>Načítám online informace…</strong><small>Obsazení, galerie, doporučení a další údaje se zjišťují až teď.</small></div></div></div>
  <div class="subdetails"><div><span>Rok</span><strong>${item.year ?? '—'}</strong></div><div><span>${movie?'Délka':'Série'}</span><strong>${movie?formatMinutes(item.duration):(item.seasons??'—')}</strong></div>${movie?'':`<div><span>Epizody</span><strong>${item.episodes??'—'}</strong></div>`}<div><span>Stav</span><strong>${statusLabel(item.status)}</strong></div></div>
  <div class="modal-actions">${links || '<span class="modal-note">Žádný externí odkaz.</span>'}</div>
  ${ratingFor(item,'tmdb')?'<details class="source-details"><summary>Informace o zdrojích hodnocení</summary><p>Hodnocení TMDB pochází z The Movie Database. This product uses the TMDB API but is not endorsed or certified by TMDB. <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">TMDB</a>.</p></details>':''}
  </div>`;
  if(!$('#detailDialog').open)$('#detailDialog').showModal();
  $('#detailClose').addEventListener('click',()=>$('#detailDialog').close());
  try {
    const module = await import('./online-details.mjs?v=3.2.0');
    if(requestId!==detailCounter || detailRequest.signal.aborted)return;
    await module.renderOnlineDetails(item, $('#onlineDetails'), {
      signal:detailRequest.signal,
      isCurrent:()=>requestId===detailCounter && $('#detailDialog').open && !document.body.classList.contains('locked'),
      onLocalTitle: (name,year) => media.find(m => m.title.localeCompare(name,'cs',{sensitivity:'base'})===0 && (year==null || m.year===year))
    });
  } catch(error) {
    if(requestId===detailCounter && !detailRequest.signal.aborted) {
      console.warn('Online details unavailable:',error);
      $('#onlineDetails').innerHTML='<p class="online-unavailable">Online informace se nepodařilo načíst. Uložená hodnocení a odkazy jsou stále dostupné.</p>';
    }
  }
}
function toast(message) {
  const el=$('#toast'); el.textContent=message;el.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3200);
}
function setTheme(theme) {
  document.documentElement.dataset.theme=theme;
  $('#themeIcon').setAttribute('href',theme==='dark'?'#i-sun':'#i-moon');
  $('#lockThemeIcon').setAttribute('href',theme==='dark'?'#i-sun':'#i-moon');
  $('#themeToggle').title=theme==='dark'?'Přepnout na světlý režim':'Přepnout na tmavý režim';
  document.querySelector('meta[name="theme-color"]').setAttribute('content',theme==='dark'?'#0b0c0f':'#f6f6f8');
  try{localStorage.setItem('cinelist-ui-theme',theme);}catch{}
}
function setLayout(layout) {
  state.layout=layout;
  $$('.layout-switch button').forEach(b=>{const on=b.id===(layout==='grid'?'gridBtn':'listBtn');b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
  try{localStorage.setItem('cinelist-ui-layout',layout);}catch{}
  render();
}
function parseMediaPayload(data) {
  if (!data || data.format!=='cinelist-library' || data.version!==1 || !Array.isArray(data.media)) throw new Error('Neznámý formát databáze.');
  const ids=new Set();
  return data.media.map((record,index)=>{
    if (!record || typeof record!=='object' || typeof record.title!=='string' || !['movie','series'].includes(record.type)) throw new Error(`Neplatný titul č. ${index+1}`);
    const id=String(record.id??`${index}`);
    if (ids.has(id)) throw new Error('Duplicitní ID v databázi.');
    ids.add(id);
    const ratings={};
    for(const [key,r] of Object.entries(record.ratings || {})) {
      if (/^[a-z0-9_-]{1,30}$/.test(key) && r && Number.isFinite(r.value) && r.value>=0 && Number.isFinite(r.max) && r.max>0 && r.value<=r.max) {
        ratings[key]={value:r.value,max:r.max,sample:r.sample===true};
      }
    }
    const links={};
    for(const [key,url] of Object.entries(record.links || {})) {
      if (/^[a-z0-9_-]{1,30}$/.test(key) && safeUrl(url)) links[key]=safeUrl(url);
    }
    const intOrNull=(v)=>Number.isSafeInteger(v)&&v>=0?v:null;
    const externalIds={};
    if(/^tt\d{7,10}$/.test(record.externalIds?.imdb || ''))externalIds.imdb=record.externalIds.imdb;
    return {id,type:record.type,title:record.title,original:cleanOriginal(record.original),year:intOrNull(record.year),duration:intOrNull(record.duration),episodeRuntime:intOrNull(record.episodeRuntime),seasons:intOrNull(record.seasons),episodes:intOrNull(record.episodes),externalIds,status:['watchlist','download','watching','watched'].includes(record.status)?record.status:'watchlist',genres:Array.isArray(record.genres)?record.genres.slice(0,8).filter(v=>typeof v==='string'):[],art:allowedArts.has(record.art)?record.art:'generic',posterTitle:String(record.posterTitle||''),posterHeader:String(record.posterHeader||''),overview:String(record.overview||''),ratings,links};
  });
}

function decodeBase64(input) {
  if(typeof input!=='string'||!/^([a-zA-Z0-9+/]{4})*([a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(input)) throw new Error('Neplatná data šifrování.');
  return Uint8Array.from(atob(input),c=>c.charCodeAt(0));
}
function validateEnvelope(data) {
  if(!data||data.format!=='cinelist-encrypted'||data.version!==1||data.alg!=='AES-256-GCM'||data.kdf?.name!=='PBKDF2'||data.kdf?.hash!=='SHA-256'||!Number.isInteger(data.kdf?.iterations)||data.kdf.iterations<100000||data.kdf.iterations>2000000) throw new Error('Nepodporovaný formát šifrování.');
  if(decodeBase64(data.kdf.salt).length!==16||decodeBase64(data.iv).length!==12||decodeBase64(data.ciphertext).length<17) throw new Error('Neplatná délka šifrovaných dat.');
  return data;
}
async function loadEnvelope() {
  const input=$('#unlockPassword'), button=$('#unlockButton'), status=$('#unlockStatus');
  input.disabled=true;button.disabled=true;button.textContent='Načítání databáze…';
  $('#retryWrap').hidden=true;status.classList.remove('error');status.textContent='Načítám zašifrovanou databázi…';
  try {
    const response=await fetch('./movies.enc.json',{cache:'no-store'});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const buf=await response.arrayBuffer();
    if(buf.byteLength>20*1024*1024) throw new Error('Soubor je příliš velký.');
    envelope=validateEnvelope(JSON.parse(new TextDecoder().decode(buf)));
    databaseLastModified=response.headers.get('Last-Modified');
    input.disabled=false;button.disabled=false;button.textContent='Odemknout knihovnu';
    status.textContent='Šifrovaná databáze je připravená.';
    input.focus();
  } catch(error) {
    console.error('Unable to load encrypted archive:',error);
    envelope=null;databaseLastModified=null;status.textContent='Soubor movies.enc.json není dostupný. Spusť web přes HTTP server nebo GitHub Pages.';status.classList.add('error');
    $('#retryWrap').hidden=false;
  }
}
async function unlock(event) {
  event.preventDefault();
  if(!envelope || !crypto?.subtle) return;
  const input=$('#unlockPassword');
  const password=input.value;
  input.value='';
  const status=$('#unlockStatus');
  const button=$('#unlockButton');
  if(!password) {status.textContent='Zadej heslo.';status.classList.add('error');return;}
  button.disabled=true;input.disabled=true;button.textContent='Dešifruji…';
  status.classList.remove('error');status.textContent='Ověřuji heslo přímo v prohlížeči…';
  try {
    const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:decodeBase64(envelope.kdf.salt),iterations:envelope.kdf.iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:decodeBase64(envelope.iv),tagLength:128},key,decodeBase64(envelope.ciphertext));
    const content=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
    const parsed=parseMediaPayload(content);
    media=parsed;
    document.body.classList.remove('locked');
    $('#lockScreen').hidden=true;
    $('#detailContent').replaceChildren();
    updateMetrics();
    startArtwork();
    initHero();
    setUpdatedStamp(content);
    render();
    setHeaderNav();
    $('#globalSearch').focus({preventScroll:true});
    button.textContent='Odemknout knihovnu';input.disabled=false;button.disabled=false;
  } catch(error) {
    console.error('Decryption or data format error:',error.name);
    status.textContent='Nesprávné heslo, poškozený soubor nebo neplatný formát dat.';
    status.classList.add('error');
    input.disabled=false;button.disabled=false;button.textContent='Odemknout knihovnu';input.focus();
  }
}
function lockLibrary() {
  pauseHero();
  resetArtwork();
  if($('#galleryDialog')?.open)$('#galleryDialog').close();
  if(detailRequest)detailRequest.abort();
  detailRequest=null;detailCounter++;
  if($('#detailDialog').open) $('#detailDialog').close();
  document.body.classList.add('locked');
  media=[];
  $('#catalogue').replaceChildren();
  $('#detailContent').replaceChildren();
  heroQueue=[];heroPosition=0;heroElapsed=0;
  $('#heroFeaturePoster').replaceChildren();
  $('#dbUpdated').textContent='Aktualizace databáze: —';
  resetFilters();
  $('#lockScreen').hidden=false;
  $('#unlockPassword').value='';$('#unlockPassword').type='password';
  $('#unlockStatus').textContent='Šifrovaná databáze je připravená.';
  $('#unlockStatus').classList.remove('error');
  $('#unlockPassword').focus();
}
function applyQuery(value,source) { state.query=value;if(source!=='desktop')$('#globalSearch').value=value;if(source!=='mobile')$('#mobileSearch').value=value;render(); }
function bindEvents() {
  $('#globalSearch').addEventListener('input',e=>applyQuery(e.target.value,'desktop'));
  $('#mobileSearch').addEventListener('input',e=>applyQuery(e.target.value,'mobile'));
  $('#themeToggle').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
  $('#lockThemeToggle').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
  $$('.tab').forEach(b=>b.addEventListener('click',()=>setType(b.dataset.type)));
  $('#genreChips').addEventListener('click', e => {const b=e.target.closest('button[data-chip]'); if(!b)return;state.genre=b.dataset.chip;$('#genreSelect').value=state.genre==='90plus'?'all':state.genre;render();});
  $('#genreSelect').addEventListener('change', e => {state.genre=e.target.value;render();});
  $('#sortSelect').addEventListener('change',e=>{state.sort=e.target.value;render();});
  $('#statusFilter').addEventListener('change',e=>{state.status=e.target.value;render();});
  $('#gridBtn').addEventListener('click',()=>setLayout('grid'));
  $('#listBtn').addEventListener('click',()=>setLayout('list'));
  $$('[data-nav-type]').forEach(l=>l.addEventListener('click',()=>{setType(l.dataset.navType);setHeaderNav();}));
  $('.desktop-nav a[href="#top"]').addEventListener('click',()=>{requestAnimationFrame(setHeaderNav);});
  let scrolling=false;window.addEventListener('scroll',()=>{if(!scrolling){scrolling=true;requestAnimationFrame(()=>{scrolling=false;setHeaderNav();});}},{passive:true});
  $$('[data-mobile-type]').forEach(b=>b.addEventListener('click',()=>{setType(b.dataset.mobileType);$('#knihovna').scrollIntoView({behavior:'smooth'});}));
  $('#mobileFind').addEventListener('click',()=>{$('#knihovna').scrollIntoView({behavior:'smooth'});$('#mobileSearch').focus({preventScroll:true});});
  $('#heroPrev').addEventListener('click',()=>moveHero(-1));
  $('#heroNext').addEventListener('click',()=>moveHero(1));
  $('.hero-carousel').addEventListener('mouseenter',()=>{heroHover=true;pauseHero();});
  $('.hero-carousel').addEventListener('mouseleave',()=>{heroHover=false;resumeHero();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseHero();else resumeHero();});
  $('#heroFeature').addEventListener('click',()=>{$('#heroFeature').dataset.id&&showDetails($('#heroFeature').dataset.id);});
  $('#heroFeature').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('#heroFeature').click();}});
  $('#lockLibraryBtn').addEventListener('click',lockLibrary);
  $('#unlockForm').addEventListener('submit',unlock);
  $('#retryLoad').addEventListener('click',loadEnvelope);
  $('#passwordReveal').addEventListener('click',()=>{const input=$('#unlockPassword');input.type=input.type==='password'?'text':'password';$('#passwordReveal').setAttribute('aria-label',input.type==='password'?'Zobrazit heslo':'Skrýt heslo');});
  $('#detailDialog').addEventListener('click',e=>{if(e.target===$('#detailDialog'))$('#detailDialog').close();});
  $('#detailDialog').addEventListener('close',()=>{if(detailRequest) detailRequest.abort();detailRequest=null;detailCounter++;if($('#galleryDialog').open)$('#galleryDialog').close();resumeHero();});
  // Let CSS illustrated posters remain visible until online artwork is loaded.
  document.addEventListener('load',e=>{if(e.target.matches?.('img.poster-live'))e.target.classList.add('ready');},true);
  document.addEventListener('error',e=>{if(e.target.matches?.('img.poster-live'))e.target.remove();},true);
  window.addEventListener('pagehide',()=>{if(!document.body.classList.contains('locked'))lockLibrary();});
}

bindEvents();
try{setTheme(localStorage.getItem('cinelist-ui-theme')==='light'?'light':'dark');}catch{setTheme('dark');}
try{setLayout(localStorage.getItem('cinelist-ui-layout')==='list'?'list':'grid');}catch{setLayout('grid');}
if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
  $('#unlockStatus').textContent='Pro šifrování je potřeba HTTPS nebo localhost a podporovaný prohlížeč.';
  $('#unlockStatus').classList.add('error');
} else {
  loadEnvelope();
}

if ('serviceWorker' in navigator && globalThis.isSecureContext) {
  navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(e=>console.debug('Image cache unavailable:',e?.message));
}
