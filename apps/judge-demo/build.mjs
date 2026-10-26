import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
const here=fileURLToPath(new URL('.',import.meta.url)), root=resolve(here,'../..'), out=join(here,'dist');
mkdirSync(join(out,'shared/vendor'),{recursive:true});
for(const name of ['index.html','app.css','theme.css','app.mjs','engine.mjs','_headers'])copyFileSync(join(here,name),join(out,name));
for(const name of ['local-vault.mjs','ticket-backup.mjs','secrets.js','claim-commitment.js','money.js'])copyFileSync(join(root,'apps/web/dist/vault',name),join(out,'shared',name));
for(const name of ['blake2.js','_blake.js','_md.js','_u64.js','utils.js','LICENSE'])copyFileSync(join(root,'apps/web/dist/vault/vendor',name),join(out,'shared/vendor',name));
for(const name of ['settlement','ledger-commitment']){const code=stripTypeScriptTypes(readFileSync(join(root,`packages/protocol/phase10/${name}.ts`),'utf8'),{mode:'strip'}).replaceAll('../src/money.ts','./money.js').replaceAll('@noble/hashes/','./vendor/');writeFileSync(join(out,'shared',name+'.mjs'),code);}
copyFileSync(join(root,'LICENSE'),join(out,'LICENSE'));
writeFileSync(join(out,'NOTICE.txt'),'VEIL original application code: MIT, copyright 2026 Jimoh Abdulsamad.\nBrowser cryptography: @noble/hashes 2.4.0, MIT, copyright 2022 Paul Miller; license included in shared/vendor/LICENSE.\n');
console.log('Built synthetic browser rehearsal. No wallet, database or network authority.');
