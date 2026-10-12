// Regression: our file names must survive another extension hooking chrome.downloads.onDeterminingFilename
// (some download-manager extensions do this). Run: CHROME_BIN=... node scripts/name-check.mjs   [ORDER=none|hook-first|hook-last]
// Real VidGrab save path vs a download-manager-style extension that answers onDeterminingFilename with suggest().
// ORDER=hook-first → VidGrab loaded after the hook; ORDER=hook-last → the other way round.
import { spawn } from "node:child_process"; import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, resolve } from "node:path"; import http from "node:http";
const dist=resolve("dist"); const hook=resolve("tests/ext-hook"); /* fake download-manager extension */ const profile=mkdtempSync(join(tmpdir(),"vg-")); const port=9340; const dl=join(profile,"dl");
mkdirSync(join(profile,"Default"),{recursive:true}); mkdirSync(dl,{recursive:true});
writeFileSync(join(profile,"Default","Preferences"),JSON.stringify({download:{default_directory:dl,prompt_for_download:false,directory_upgrade:true}}));
const exts = process.env.ORDER==="hook-last" ? `${dist},${hook}` : process.env.ORDER==="none" ? dist : `${hook},${dist}`;
const chrome=spawn(process.env.CHROME_BIN,[`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,`--load-extension=${exts}`,"--enable-unsafe-extension-debugging","--disable-features=DisableLoadExtensionCommandLineSwitch","--no-first-run","--no-sandbox","about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const req=(m,p)=>new Promise((res,rej)=>{const r=http.request({host:"127.0.0.1",port,path:p,method:m},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{try{res(JSON.parse(b))}catch{rej(new Error(b))}})});r.on("error",rej);r.end()});
async function cdp(u){const ws=new WebSocket(u);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let id=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}};return{call:(method,params={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}))}),close:()=>ws.close()}}
try{
 let sw,targets=[];const findOurs=async()=>{for(const t of targets.filter(t=>t.type==="service_worker"&&t.url.endsWith("/background.js"))){const c=await cdp(t.webSocketDebuggerUrl);await c.call("Runtime.enable");const r=await c.call("Runtime.evaluate",{expression:"chrome.runtime.getManifest().short_name",returnByValue:true});c.close();if(r.result?.result?.value==="VidGrab")return t}};
 for(let i=0;i<80&&!sw;i++){await sleep(250);try{targets=await req("GET","/json/list");sw=await findOurs()}catch{}}
 const swc=await cdp(sw.webSocketDebuggerUrl);await swc.call("Runtime.enable");
 const ev=async(e)=>{const r=await swc.call("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value??JSON.stringify(r.result)};
 // drive the REAL save path: create a typed blob in the offscreen doc, then __vg.saveJob(...) like the engine does
 await ev(`chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'t'}).catch(e=>String(e))`); await sleep(800);
 const off=(await req("GET","/json/list")).find(t=>t.url.endsWith("/offscreen.html"));const oc=await cdp(off.webSocketDebuggerUrl);await oc.call("Runtime.enable");
 for (let k = 0; k < 3; k++) {
   const url=(await oc.call("Runtime.evaluate",{expression:`URL.createObjectURL(new Blob([new Uint8Array(${4096 + k})],{type:'video/mp4'}))`,returnByValue:true})).result.result.value;
   await ev(`__vg.testSave(${JSON.stringify(url)}, "Watch Movie – Title Test.mp4")`);
   await sleep(1500);
 }
 const { readdirSync, statSync } = await import("node:fs");
 console.log("on disk:", readdirSync(dl).map((f) => `${f} (${statSync(join(dl, f)).size})`).join(" | "));
 console.log((process.env.ORDER||"hook-first").padEnd(10), await ev(`chrome.downloads.search({}).then(d=>JSON.stringify(d.map(x=>x.filename.split('/').pop())))`));
}finally{chrome.kill("SIGKILL");await sleep(300);rmSync(profile,{recursive:true,force:true})}
