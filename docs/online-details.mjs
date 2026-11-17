import { cachedJSON } from './api-cache.mjs';
/**
 * CINELIST online-only detail enhancement.
 * Loaded dynamically only after the user opens a title. No API key or server.
 * StreamX is an independent, keyless community service. Its availability and
 * third-party metadata are not guaranteed, so local data always remains usable.
 */
const ENDPOINTS = ['https://api.streamx.qzz.io', 'https://streamx-api.pages.dev'];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const imdbPattern = /^tt\d{7,10}$/;
const text = value => typeof value === 'string' ? value.trim() : '';
const normalize = value => text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const asList = value => Array.isArray(value) ? value : value ? [value] : [];
const firstText = (...values) => values.map(text).find(Boolean) || '';
const ratingNumber = value => {
  if(typeof value==='number' && Number.isFinite(value))return value;
  if(typeof value==='string' && /^\d+(?:\.\d+)?$/.test(value.trim()))return Number(value);
  return null;
};
const imgOrNull = value => {
  if(typeof value !== 'string')return null;
  try {
    const url=new URL(value);
    const host=url.hostname.toLowerCase();
    if(url.protocol!=='https:' || !(
      host==='api.streamx.qzz.io' || host==='streamx-api.pages.dev' ||
      host==='images.metahub.space' || host==='image.tmdb.org' ||
      host==='static.tvmaze.com' || host==='upload.wikimedia.org' ||
      host==='commons.wikimedia.org' || host==='v3-cinemeta.strem.io' ||
      host.endsWith('.strem.io') || host.endsWith('.metahub.space') ||
      host.endsWith('.media-amazon.com') || host.endsWith('.wikimedia.org')
    )) return null;
    return url.href;
  } catch { return null; }
};
const yearOf = value => {
  const match = String(value ?? '').match(/(?:18|19|20)\d{2}/);
  return match ? Number(match[0]) : null;
};
const imageFrom = (field) => {
  if(typeof field === 'string')return imgOrNull(field);
  if(field && typeof field==='object')return imgOrNull(field.large || field.original || field.medium || field.small);
  return null;
};

async function fetchJSON(url,signal) { return cachedJSON(url,signal); }
async function streamx(path, signal) {
  let last;
  for(const base of ENDPOINTS) {
    if(signal?.aborted)throw new DOMException('Canceled','AbortError');
    try { return await fetchJSON(`${base}${path}`,signal); }
    catch(error){ last=error; if(signal?.aborted)throw error; }
  }
  throw last || new Error('Zdroj není dostupný');
}

function validateMatch(item,candidate) {
  if(!candidate || !imdbPattern.test(candidate.id || ''))return -1;
  const y=yearOf(candidate.year || candidate.releaseInfo || candidate.released);
  if(item.year && y && Math.abs(item.year-y)>1)return -1;
  const title=normalize(candidate.name || candidate.title);
  const aliases=[item.original,item.title].filter(Boolean).map(normalize);
  const nameScore=aliases.some(a=>a===title)?5:aliases.some(a=>a.length>=4 && title && (a.includes(title)||title.includes(a)))?3:0;
  if(!nameScore)return -1;
  return nameScore+(y && item.year && Math.abs(item.year-y)===0?3:0);
}
async function findImdb(item, signal) {
  const externalId=item.externalIds?.imdb;
  if(imdbPattern.test(externalId || ''))return externalId;
  const direct=(item.links?.imdb || '').match(/\/title\/(tt\d{7,10})/);
  if(direct)return direct[1];
  const queries=[...new Set([item.original,item.title].map(text).filter(Boolean))];
  for(const term of queries) {
    let results=await streamx(`/search?q=${encodeURIComponent(term)}&type=${item.type}`,signal).catch(()=>null);
    if(!Array.isArray(results?.metas)||!results.metas.length){
      // Independent keyless fallback: official Stremio Cinemeta metadata addon.
      results=await fetchJSON(`https://v3-cinemeta.strem.io/catalog/${item.type}/top/search=${encodeURIComponent(term)}.json`,signal).catch(()=>null);
    }
    const choices=Array.isArray(results?.metas)?results.metas:[];
    const ranked=choices.map(candidate=>({candidate,score:validateMatch(item,candidate)})).filter(v=>v.score>=5).sort((a,b)=>b.score-a.score);
    if(ranked.length && (ranked.length===1 || ranked[0].score>ranked[1].score))return ranked[0].candidate.id;
  }
  return null;
}

function fact(value) {
  if(value==null || value==='')return '—';
  if(Array.isArray(value))return value.map(x=>typeof x==='string'?x:x?.label || x?.name || '').filter(Boolean).join(', ') || '—';
  if(typeof value==='string')return value.trim() || '—';
  if(typeof value==='number')return String(value);
  if(typeof value==='object')return fact(value.name || value.label || value.value || value.rating);
  return '—';
}
function localTime(value) {
  const str = text(value);
  if(!str)return '—';
  const match=str.match(/^(\d{4}-\d{2}-\d{2})/);
  if(match) {
    const date=new Date(`${match[1]}T12:00:00Z`);
    return Number.isNaN(date.getTime())?str:new Intl.DateTimeFormat('cs-CZ',{dateStyle:'long',timeZone:'UTC'}).format(date);
  }
  return str;
}
function firstImage(...choices) { return choices.map(imageFrom).find(Boolean) || null; }
function sectionHeading(label) { return `<h3 class="online-heading">${escapeHtml(label)}</h3>`; }
function renderCardsPeople(people) {
  if(!people.length)return '<p class="online-empty">Z tohoto zdroje není obsazení dostupné.</p>';
  return `<div class="people-scroll">${people.slice(0,14).map(person=>{
    const name=text(person.name || person.person?.name || (typeof person==='string'?person:''));
    if(!name)return '';
    const pic=firstImage(person.image,person.person?.image?.medium,person.person?.image?.original);
    const role=text(person.character?.name || person.roleLabel || person.character || (person.role==='cast'?'':person.role));
    return `<div class="person-card">${pic?`<img loading="lazy" src="${escapeHtml(pic)}" alt="${escapeHtml(name)}">`:'<span class="person-placeholder" aria-hidden="true"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="36" r="19"/><path d="M11 95c0-25 15-40 39-40s39 15 39 40"/></svg></span>'}<strong>${escapeHtml(name)}</strong>${role?`<small>${escapeHtml(role)}</small>`:''}</div>`;
  }).join('')}</div>`;
}
function renderRecs(metas) {
  const entries=asList(metas).filter(m=>imdbPattern.test(m.id || '') && text(m.name || m.title)).slice(0,9);
  if(!entries.length)return '<p class="online-empty">Doporučení nejsou pro tento titul dostupná.</p>';
  return `<div class="recommendations-scroll">${entries.map(m=>{
    const poster=firstImage(m.poster,m.images?.poster);
    return `<a class="recommendation-card" href="https://www.imdb.com/title/${m.id}/" target="_blank" rel="noopener noreferrer" aria-label="Otevřít ${escapeHtml(m.name||m.title)} na IMDb">${poster?`<img loading="lazy" src="${escapeHtml(poster)}" alt="Plakát: ${escapeHtml(m.name||m.title)}">`:'<div class="recommendation-placeholder" aria-hidden="true">▶</div>'}<strong>${escapeHtml(m.name||m.title)}</strong><small>${escapeHtml(fact(m.releaseInfo || m.year))}</small></a>`;
  }).join('')}</div>`;
}
/** A single poster in multiple sizes is one image, not a multi-poster gallery. */
function collectPictures(meta,poster,backdrop) {
  const output=[];
  const seen=new Set();
  const add=(label,field)=>{
    const url=imageFrom(field);
    if(url && !seen.has(url)){seen.add(url);output.push({name:label,url});}
  };
  add('Plakát',poster);
  add('Pozadí',backdrop);
  add('Logo',meta.images?.logo || meta.logo);
  const alternatives=[
    ['Další plakát',meta.images?.posters || meta.posters],
    ['Další pozadí',meta.images?.backdrops || meta.images?.backgrounds || meta.backdrops],
    ['Galerie',meta.images?.gallery || meta.gallery]
  ];
  for(const [label,images] of alternatives) {
    if(Array.isArray(images)) for(const im of images.slice(0,30))add(label,im);
  }
  return output;
}
// Cinemeta exposes a raw, undocumented popularity index (e.g. 1.08).
// It is NOT a percentage or a calibrated score. Only display a metric
// when the upstream explicitly provides a percentage or a usable rank.
function popularityLabel(raw) {
  if (typeof raw === 'string') {
    const percent = raw.trim().match(/^(100|\d{1,2})(?:[.,](\d{1,2}))?\s*%$/);
    if(percent) return `${percent[1]}${percent[2] ? ',' + percent[2] : ''} %`;
  }
  if (raw && typeof raw === 'object') {
    const percent = ratingNumber(raw.percent ?? raw.percentage);
    if(percent!==null && percent>=0 && percent<=100)
      return `${new Intl.NumberFormat('cs-CZ',{maximumFractionDigits:1}).format(percent)} %`;
    const rank = ratingNumber(raw.rank);
    if(Number.isSafeInteger(rank) && rank>=1)
      return `${new Intl.NumberFormat('cs-CZ').format(rank)}. místo`;
  }
  return '—';
}

function runtimeLabel(...candidates) {
  for(const value of candidates) {
    if(value==null || value==='')continue;
    const source = typeof value==='string' ? value.trim() : value;
    let minutes = null;
    if(typeof source==='number' && Number.isFinite(source)) minutes=source;
    else if(typeof source==='string') {
      if(/^\d{1,4}$/.test(source)) minutes=Number(source);
      const simple=source.match(/^(\d{1,4})\s*(?:min\.?|minutes?|minut(?:a|y)?)$/i);
      if(simple)minutes=Number(simple[1]);
      const clock=source.match(/^(?:(\d{1,3})\s*h(?:od(?:in(?:y|a))?)?\s*)?(?:(\d{1,3})\s*m(?:in(?:ut)?)?\s*)?$/i);
      if(clock && (clock[1]||clock[2]))minutes=Number(clock[1]||0)*60+Number(clock[2]||0);
      const iso=source.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
      if(iso && (iso[1]||iso[2]))minutes=Number(iso[1]||0)*60+Number(iso[2]||0);
    }
    if(Number.isFinite(minutes) && minutes>0 && minutes<=3000) {
      minutes=Math.round(minutes);
      const hours=Math.floor(minutes/60), rest=minutes%60;
      return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
    }
  }
  return '—';
}

// Wikidata P1657 returns item URLs rather than human-readable labels.
const MPA_CODES = {
  Q18665330:'G', Q18665334:'PG', Q18665339:'PG-13',
  Q18665344:'R', Q18665349:'NC-17', Q47274658:'X',
  Q29841070:'M', Q29841078:'GP', Q50321114:'M/PG'
};
function certificationLabel(...candidates) {
  for(const value of candidates) {
    if(value==null)continue;
    const raw = typeof value==='string' ? value :
      typeof value==='object' ? (value.label || value.name || value.value || value.id || '') : '';
    if(!raw || typeof raw!=='string')continue;
    const s=raw.trim();
    const qid=s.match(/^(?:https?:\/\/(?:www\.)?wikidata\.org\/(?:wiki|entity)\/)?(Q\d+)$/i);
    if(qid){if(MPA_CODES[qid[1].toUpperCase()])return MPA_CODES[qid[1].toUpperCase()];continue;}
    // Do not accidentally show raw Wikidata URLs or unrelated URLs.
    if(/^https?:\/\//i.test(s))continue;
    if(/^(?:G|PG|PG-13|R|NC-17|X|M|GP|M\/PG|TV-G|TV-PG|TV-14|TV-MA|TV-Y|TV-Y7|U|12A?|15|18|13\+|16\+|18\+)$/i.test(s))return s.toUpperCase();
  }
  return '—';
}
/** Native pointer drag on horizontally scrolling rows; touch swipe stays native. */
function initDragScrolling(root) {
  root.querySelectorAll('.people-scroll,.recommendations-scroll,.online-gallery').forEach(el=>{
    let start=0,offset=0,pointer=null,dragged=false;
    el.addEventListener('pointerdown',e=>{
      if(e.pointerType!=='mouse'||e.button!==0)return;
      pointer=e.pointerId;start=e.clientX;offset=el.scrollLeft;dragged=false;
    });
    el.addEventListener('pointermove',e=>{
      if(pointer!==e.pointerId)return;
      const distance=e.clientX-start;
      if(!dragged && Math.abs(distance)>6){dragged=true;el.classList.add('dragging');el.setPointerCapture?.(pointer);}
      if(dragged)el.scrollLeft=offset-distance;
    });
    const finish=e=>{
      if(pointer!==e.pointerId)return;
      pointer=null;
      el.classList.remove('dragging');
      if(el.hasPointerCapture?.(e.pointerId))el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup',finish);
    el.addEventListener('pointercancel',finish);
    // Cancel a click following a drag but allow normal link and gallery clicks.
    el.addEventListener('click',e=>{
      if(dragged){e.preventDefault();e.stopImmediatePropagation();dragged=false;}
    },true);
  });
}
function initGallery(node, pictures) {
  const dialog=document.getElementById('galleryDialog');
  if(!dialog || !pictures.length)return;
  let current=0;
  const display=()=>{
    const picture=pictures[current];
    dialog.querySelector('#galleryImage').src=picture.url;
    dialog.querySelector('#galleryImage').alt=picture.name;
    dialog.querySelector('#galleryCaption').textContent=`${picture.name} · ${current+1} / ${pictures.length}`;
    dialog.querySelector('#galleryPrev').disabled=pictures.length<2;
    dialog.querySelector('#galleryNext').disabled=pictures.length<2;
  };
  node.querySelectorAll('button[data-gallery-index]').forEach(button=>button.addEventListener('click',()=>{
    current=Number(button.dataset.galleryIndex)||0;
    display();
    if(!dialog.open)dialog.showModal();
  }));
  dialog.querySelector('#galleryClose').onclick=()=>dialog.close();
  dialog.querySelector('#galleryPrev').onclick=()=>{current=(current-1+pictures.length)%pictures.length;display();};
  dialog.querySelector('#galleryNext').onclick=()=>{current=(current+1)%pictures.length;display();};
  dialog.onclick=e=>{if(e.target===dialog)dialog.close();};
  dialog.onkeydown=e=>{if(e.key==='ArrowLeft'){e.preventDefault();dialog.querySelector('#galleryPrev').click();}if(e.key==='ArrowRight'){e.preventDefault();dialog.querySelector('#galleryNext').click();}};
}

/** Light-weight image lookup for the hero and lazy-loading card posters. */
export async function resolveArtwork(item, signal) {
  const imdb=await findImdb(item,signal);
  if(!imdb)return {poster:null,backdrop:null};
  let raw=await streamx(`/images/${item.type}/${imdb}`,signal).catch(()=>null);
  let images=raw?.images || raw?.artwork || raw?.data?.images || raw;
  let poster=firstImage(images?.poster,raw?.poster);
  let backdrop=firstImage(images?.background,images?.backdrop,raw?.background);
  if(!poster){
    raw=await streamx(`/meta/${item.type}/${imdb}`,signal).catch(()=>null);
    poster=firstImage(raw?.meta?.images?.poster,raw?.meta?.poster);
    backdrop ||= firstImage(raw?.meta?.images?.background,raw?.meta?.background);
  }
  return {poster,backdrop};
}

function buildLive(item,meta,credits,similar,scores,source='streamx') {
  const facts=meta.facts || {};
  const overview=firstText(meta.description,meta.wiki?.extract,item.overview) || 'Popis není dostupný.';
  const cast=asList(credits?.cast).length?credits.cast:asList(meta.cast).map(entry=>typeof entry==='object'?entry:{name:entry});
  const crew=asList(credits?.crew).length?credits.crew:asList(meta.director).map(entry=>typeof entry==='object'?entry:{name:entry,role:'Režie'});
  const poster=firstImage(meta.images?.poster,meta.poster);
  const backdrop=firstImage(meta.images?.background,meta.background);
  const pictures=collectPictures(meta,poster,backdrop);
  const awards=[];
  const onlineImdb=ratingNumber(scores?.imdb?.rating) ?? ratingNumber(meta.imdbRating);
  const rt=ratingNumber(scores?.rottenTomatoes?.critics?.score);
  const rtAudience=ratingNumber(scores?.rottenTomatoes?.audience?.score);
  const metacritic=ratingNumber(scores?.metacritic?.critics?.score);
  if(onlineImdb!==null)awards.push(['IMDb',`${onlineImdb.toFixed(1)} / 10`]);
  if(rt!==null)awards.push(['Rotten Tomatoes',`${rt} %`]);
  if(rtAudience!==null)awards.push(['RT diváci',`${rtAudience} %`]);
  if(metacritic!==null)awards.push(['Metacritic',`${metacritic} / 100`]);
  const epCount=Array.isArray(meta.videos)?meta.videos.filter(v=>v && Number(v.season)>0).length:null;
  const details=[
    ['Datum premiéry',localTime(meta.released || meta.releaseDate || meta.premiered || facts.releaseDate || meta.releaseInfo)],
    ['Délka',runtimeLabel(meta.runtime, facts.runtimeMinutes, item.duration)],
    ['Věková přístupnost',certificationLabel(meta.certification, facts.certification, scores?.metacritic?.contentRating)],
    ['Jazyk',fact(meta.language || facts.languages)],
    ['Popularita',popularityLabel(meta.popularity)],
    ['Země',fact(facts.countries || meta.country)]
  ];
  if(item.type==='series'){
    details.push(['Počet sérií',fact(Array.isArray(meta.seasons)?meta.seasons.length:item.seasons)]);
    details.push(['Počet epizod',fact(epCount || item.episodes)]);
  }
  return {markup:`
    ${sectionHeading('Přehled')}
    <p class="online-overview">${escapeHtml(overview)}</p>
    ${awards.length?`${sectionHeading('Online hodnocení')}<div class="online-score-list">${awards.map(([key,val])=>`<div><span>${escapeHtml(key)}</span><strong>${escapeHtml(val)}</strong></div>`).join('')}</div>`:''}
    ${sectionHeading('Další informace')}
    <div class="online-facts">${details.map(([label,val])=>`<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(val)}</strong></div>`).join('')}</div>
    ${sectionHeading('Obsazení')}${renderCardsPeople(cast)}
    ${sectionHeading('Tvůrci / štáb')}${renderCardsPeople(crew)}
    ${sectionHeading('Plakáty a pozadí')}
    ${pictures.length?`<div class="online-gallery">${pictures.map((pic,i)=>`<button class="gallery-thumb" type="button" data-gallery-index="${i}" aria-label="Otevřít obrázek: ${escapeHtml(pic.name)}"><img loading="lazy" alt="${escapeHtml(pic.name)}" src="${escapeHtml(pic.url)}"><span>${escapeHtml(pic.name)}</span></button>`).join('')}</div>`:'<p class="online-empty">Obrázky nejsou dostupné.</p>'}
    ${sectionHeading('Podobné a doporučené tituly')}${renderRecs(similar?.metas)}
    ${source==='tvmaze'?'<p class="online-credit">Seriálová data: <a href="https://www.tvmaze.com/api" target="_blank" rel="noopener noreferrer">TVmaze</a> (CC BY-SA)</p>':''}
  `,backdrop,poster,pictures};
}
async function getTVMaze(item,signal) {
  const name=item.original || item.title;
  const url=`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(name)}&embed=cast`;
  const raw=await fetchJSON(url,signal);
  const first=normalize(raw.name);
  if(first!==normalize(name) && first!==normalize(item.title))throw new Error('TVmaze není jednoznačná shoda');
  const year=yearOf(raw.premiered);
  if(item.year && year && Math.abs(item.year-year)>1)throw new Error('TVmaze vrací jiný seriál');
  const parsed=new DOMParser().parseFromString(String(raw.summary || ''),'text/html');
  const synopsis=parsed.body.textContent || item.overview || 'Popis není dostupný.';
  const meta={description:synopsis,releaseDate:raw.premiered,runtime:raw.averageRuntime?`${raw.averageRuntime} min`:'',language:raw.language,
    country:raw.network?.country?.name || raw.webChannel?.country?.name,
    poster:raw.image?.original,background:null,popularity:null,
    cast:raw._embedded?.cast?.map(c=>({name:c.person?.name,image:c.person?.image?.medium,character:c.character?.name})) || []};
  return buildLive(item,meta,{cast:meta.cast,crew:[]},null,{imdb:null},'tvmaze');
}
export async function renderOnlineDetails(item,node,{signal,isCurrent}) {
  if(!node || signal?.aborted)return;
  let rendered = null;
  try {
    const imdb=await findImdb(item,signal);
    if(!imdb)throw new Error('Pro tento titul nebylo nalezeno jednoznačné IMDb ID');
    const type=item.type;
    const [metaResult,creditsResult,similarResult,scoresResult]=await Promise.allSettled([
      streamx(`/meta/${type}/${imdb}`,signal),
      streamx(`/credits/${type}/${imdb}`,signal),
      streamx(`/similar/${type}/${imdb}`,signal),
      streamx(`/scores/${type}/${imdb}`,signal)
    ]);
    let metadata=metaResult.status==='fulfilled'?metaResult.value?.meta:null;
    let source='streamx';
    if(!metadata){
      const fallback=await fetchJSON(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`,signal).catch(()=>null);
      metadata=fallback?.meta;
      source='cinemeta';
    }
    if(!metadata)throw new Error('Není dostupný detail metadata');
    rendered=buildLive(item,metadata,
      creditsResult.status==='fulfilled'?creditsResult.value:null,
      similarResult.status==='fulfilled'?similarResult.value:null,
      scoresResult.status==='fulfilled'?scoresResult.value:null,source);
  } catch(error) {
    if(signal?.aborted)return;
    if(item.type==='series')rendered=await getTVMaze(item,signal).catch(()=>null);
    if(!rendered) {
      if(isCurrent())node.innerHTML=`<p class="online-unavailable">Rozšířené informace se nepodařilo načíst${error?.message?` (${escapeHtml(error.message)})`:''}. Uložené údaje a hodnocení zůstávají dostupné.</p>`;
      return;
    }
  }
  if(!isCurrent() || signal?.aborted)return;
  node.innerHTML=rendered.markup;
  initDragScrolling(node);
  initGallery(node,rendered.pictures || []);
  // The online image is DOM-only and is never persisted to the encrypted library.
  const visual=document.querySelector('#detailVisual');
  if(visual && rendered.backdrop)visual.insertAdjacentHTML('afterbegin',`<img class="detail-backdrop" src="${escapeHtml(rendered.backdrop)}" alt="" aria-hidden="true">`);
  if(visual && rendered.poster){
    const original=visual.querySelector('.poster');
    if(original)original.outerHTML=`<img class="detail-poster" src="${escapeHtml(rendered.poster)}" alt="Plakát: ${escapeHtml(item.title)}">`;
  }
  // Broken assets must disappear rather than display broken-image icons.
  document.querySelectorAll('#detailDialog img').forEach(img=>img.addEventListener('error',()=>img.classList.add('image-failed'),{once:true}));
}

