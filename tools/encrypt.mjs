#!/usr/bin/env node
// CINELIST offline encryptor. No third-party packages and no network requests.
import { webcrypto } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline';

const source = resolve(process.argv[2] || 'private/movies.json');
const target = resolve(process.argv[3] || 'docs/movies.enc.json');
const { subtle } = webcrypto;
const encoder = new TextEncoder();
const b64 = bytes => Buffer.from(bytes).toString('base64');

async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY) throw new Error('Heslo zadávej v interaktivním terminálu (ne přes pipe).');
  const { execFileSync } = await import('node:child_process');
  // Linux: disable the terminal's echo while keeping a visible prompt and newline.
  let previous;
  try { previous = execFileSync('stty',['-g'],{stdio:['inherit','pipe','ignore'],encoding:'utf8'}).trim(); }
  catch { throw new Error('Nelze nastavit bezpečné čtení hesla z terminálu.'); }
  const restore=()=>{ try{execFileSync('stty',[previous],{stdio:['inherit','ignore','ignore']});}catch{} };
  const interrupted=()=>{ restore(); process.stdout.write('\nPřerušeno.\n'); process.exit(130); };
  const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:false});
  process.stdout.write(`\n${prompt} (při psaní se nezobrazí žádné znaky): `);
  try {
    execFileSync('stty',['-echo'],{stdio:['inherit','ignore','ignore']});
    process.once('SIGINT',interrupted);
    process.once('SIGTERM',interrupted);
    const value=await new Promise((resolve,reject)=>{
      rl.once('close',()=>reject(new Error('Vstup hesla byl přerušen.')));
      rl.once('line',resolve);
    });
    return value;
  } finally {
    process.off('SIGINT',interrupted);
    process.off('SIGTERM',interrupted);
    restore();
    rl.close();
    process.stdout.write('\n');
  }
}
async function main() {
  const plaintext = await readFile(source, 'utf8');
  const value = JSON.parse(plaintext);
  if (value?.format !== 'cinelist-library' || value.version !== 1 || !Array.isArray(value.media)) {
    throw new Error('Očekávám JSON s format="cinelist-library", version=1 a polem media.');
  }
  const ids = new Set();
  for (const item of value.media) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !['movie','series'].includes(item.type) || typeof item.title !== 'string' || !item.title) throw new Error('Chybný záznam nebo duplicitní ID.');
    ids.add(item.id);
  }
  // For repeatable automated tests, the optional environment variable is supported.
  // For real data use the interactive prompt, not a password in shell history.
  let password = process.env.CINELIST_PASSWORD;
  if (password === undefined) {
    console.log('CINELIST: šifrování knihovny. Heslo se zadává v konzoli.');
    password = await hiddenQuestion('Heslo pro odemčení knihovny');
    const confirmation = await hiddenQuestion('Zopakuj heslo');
    if (password !== confirmation) throw new Error('Hesla se neshodují.');
  }
  if ([...password].length < 16) throw new Error('Pro soukromou knihovnu zvol heslo alespoň o 16 znacích.');
  if (source === target) throw new Error('Zdrojový JSON a šifrovaný výstup nesmí být stejný soubor.');
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const iterations = 600000;
  const base = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},base,{name:'AES-GCM',length:256},false,['encrypt']);
  const ciphertext = await subtle.encrypt({name:'AES-GCM',iv,tagLength:128},key,encoder.encode(plaintext));
  const result = {
    format:'cinelist-encrypted',version:1,alg:'AES-256-GCM',
    kdf:{name:'PBKDF2',hash:'SHA-256',iterations,salt:b64(salt)},
    iv:b64(iv),ciphertext:b64(new Uint8Array(ciphertext)),encryptedAt:new Date().toISOString()
  };
  await mkdir(dirname(target),{recursive:true});
  const temp = target + '.tmp';
  await writeFile(temp,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  await rename(temp,target);
  await chmod(target,0o644);
  console.log(`Šifrovaná knihovna obsahující ${value.media.length} titulů byla uložena do ${target}.`);
  console.log('Do Gitu přidej jen šifrovaný výstup. Soubor private/movies.json nikdy necommituj.');
}
main().catch(e => { console.error('Chyba:',e.message); process.exitCode=1; });
