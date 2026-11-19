'use strict';
const token = document.querySelector('meta[name="admin-token"]').content;
const get = id=>document.getElementById(id);
let mode='txt';
let busy=false;
let lastLogLength=-1;
const commands='node tools/encrypt.mjs\ngit add docs/movies.enc.json\ngit commit -m "Update media library"\ngit push';
function setTheme(theme){document.documentElement.dataset.theme=theme;get('theme').textContent=theme==='dark'?'☼':'☾';try{localStorage.setItem('cinelist-admin-theme',theme)}catch{}}
try{setTheme(localStorage.getItem('cinelist-admin-theme')==='light'?'light':'dark')}catch{setTheme('dark')}
get('theme').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
function switchMode(value){mode=value;for(const t of ['txt','csv']){const selected=t===mode;get(t+'Tab').classList.toggle('selected',selected);get(t+'Tab').setAttribute('aria-selected',String(selected));get(t+'Panel').hidden=!selected;}get('error').hidden=true;countInputs()}
get('txtTab').addEventListener('click',()=>switchMode('txt'));
get('csvTab').addEventListener('click',()=>switchMode('csv'));
function validUrl(v){try{const u=new URL(v.trim());return ['https:','http:'].includes(u.protocol) && ['www.csfd.cz','csfd.cz'].includes(u.hostname) && /^\/film\/\d+(?:-[a-z0-9-]+)?\/(?:prehled\/?)?$/i.test(u.pathname)}catch{return false}}
function countInputs(){const lines=get('urls').value.split(/\r?\n/).filter(v=>v.trim());const valid=lines.filter(validUrl).length;get('inputHint').textContent=mode==='txt'?`${valid} platných URL z ${lines.length} řádků`:get('file').files[0]?.name||'Není vybraný soubor'}
get('urls').addEventListener('input',countInputs);
get('file').addEventListener('change',()=>{get('fileName').textContent=get('file').files[0]?.name||'Klikni pro výběr CSV';countInputs()});
const drop=get('drop');drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover')});drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragover');const f=e.dataTransfer.files[0];if(f&&f.name.toLowerCase().endsWith('.csv')){get('file').files=e.dataTransfer.files;get('fileName').textContent=f.name;countInputs()}else showError('Povoleny jsou pouze .csv soubory.')});
function showError(text){get('error').hidden=false;get('error').textContent=text}
async function api(path,options={}){const r=await fetch(path,{cache:'no-store',...options,headers:{'X-CINELIST-LOCAL-KEY':token,...(options.headers||{})}});const data=await r.json();if(!r.ok)throw new Error(data.message||data.error||`HTTP ${r.status}`);return data}
get('submit').addEventListener('click',async()=>{if(busy)return;get('error').hidden=true;let content='';try{if(mode==='txt'){content=get('urls').value;if(!content.trim())throw new Error('Nejdřív vlož alespoň jednu URL ČSFD.')}else{const f=get('file').files[0];if(!f)throw new Error('Nejdřív vyber CSV soubor.');if(!f.name.toLowerCase().endsWith('.csv'))throw new Error('Povolen je pouze CSV soubor.');if(f.size>1_500_000)throw new Error('CSV soubor je příliš velký.');content=await f.text();}busy=true;get('submit').disabled=true;await api('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,content,refresh:get('refresh').checked})});lastLogLength=-1;await refreshStatus()}catch(e){busy=false;get('submit').disabled=false;showError(e.message)}});
async function refreshStatus(){try{const s=await api('/api/status');busy=s.status==='running';get('submit').disabled=busy;get('phase').textContent={idle:'Připraveno k importu',running:'Stahuji a ukládám metadata…',finished:'Import dokončen',error:'Import přerušen'}[s.status]||s.status;get('count').textContent=`${s.progress||0} / ${s.total||0}`;get('fill').style.width=s.total?`${Math.min(100,Math.round(s.progress/s.total*100))}%`:'0%';if(s.events.length!==lastLogLength){lastLogLength=s.events.length;const el=get('events');el.replaceChildren();for(const line of s.events){const div=document.createElement('div');div.textContent=line;el.appendChild(div)}if(!s.events.length){const span=document.createElement('div');span.className='placeholder';span.textContent='Zatím žádné záznamy.';el.append(span)}el.scrollTop=el.scrollHeight;}get('result').hidden=!s.summary;if(s.summary){const r=s.summary;get('result').textContent=`Přidáno: ${r.added} · Aktualizováno: ${r.updated} · Přeskočeno: ${r.skipped} · Chyby: ${r.failed.length}. Neúspěšné odkazy najdeš v private/last-import.json.`;}}catch(e){if(!get('error').hidden)return;showError('Nelze se spojit s lokálním importérem: '+e.message)}}
get('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(commands);get('copy').textContent='Zkopírováno ✓'}catch{get('copy').textContent='Kopírování není dostupné'}});
setInterval(refreshStatus,1200);refreshStatus();
