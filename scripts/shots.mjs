// Screenshots of popup + side panel with real data (headless Chromium, CDP).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
const dist = resolve("dist"); const profile = mkdtempSync(join(tmpdir(), "vg-shots-")); const port = 9335;
const out = resolve("docs"); mkdirSync(out, { recursive: true });
const { createReadStream, statSync: st0, existsSync: ex0 } = await import("node:fs");
const fixDir = resolve("tests/fixtures"); const fixPort = 8778;
const fixSrv = http.createServer((rq, rs) => {
  const path = decodeURIComponent(new URL(rq.url, "http://x").pathname.slice(1));
  if (!path) { rs.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return rs.end(`<!doctype html><meta charset="utf-8"><title>Big Buck Bunny – trailer (VP9)</title><video src="/src.webm" muted autoplay></video><script>fetch('/fmp4.m3u8').then(r=>r.text())</script>`); }
  const f = join(fixDir, path); if (!ex0(f)) { rs.writeHead(404); return rs.end(); }
  const size = st0(f).size; const ct = f.endsWith(".webm") ? "video/webm" : f.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";
  const range = /bytes=(\d*)-(\d*)/.exec(rq.headers.range || "");
  if (range && (range[1] || range[2])) { const start = range[1] ? parseInt(range[1], 10) : Math.max(0, size - parseInt(range[2], 10)); const end = range[1] && range[2] ? Math.min(size - 1, parseInt(range[2], 10)) : size - 1; rs.writeHead(206, { "content-type": ct, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" }); return createReadStream(f, { start, end }).pipe(rs); }
  rs.writeHead(200, { "content-type": ct, "content-length": size, "accept-ranges": "bytes" }); if (rq.method === "HEAD") return rs.end(); createReadStream(f).pipe(rs);
});
await new Promise((r) => fixSrv.listen(fixPort, "127.0.0.1", r));
const chrome = spawn(process.env.CHROME_BIN, ["--headless=new","--no-sandbox","--disable-gpu",`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,`--load-extension=${dist}`,"--enable-unsafe-extension-debugging","--disable-features=DisableLoadExtensionCommandLineSwitch","--no-first-run","--window-size=1200,900","about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const req=(m,p)=>new Promise((res,rej)=>{const r=http.request({host:"127.0.0.1",port,path:p,method:m},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{try{res(JSON.parse(b))}catch{rej(new Error(b))}})});r.on("error",rej);r.end()});
async function cdp(ws0){const ws=new WebSocket(ws0);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let id=0;const p=new Map();const o={};ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}else if(m.method==="Runtime.consoleAPICalled"){const txt=m.params.args.map(a=>a.value??a.description).join(" ");if(txt.startsWith("THUMBS"))console.log("  ",txt)}};o.call=(method,params={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});o.close=()=>ws.close();return o}
try {
  let sw, targets=[];
  const findOurs=async()=>{for(const t of targets.filter(t=>t.type==="service_worker"&&t.url.endsWith("/background.js"))){const c=await cdp(t.webSocketDebuggerUrl);await c.call("Runtime.enable");const r=await c.call("Runtime.evaluate",{expression:"chrome.runtime.getManifest().short_name",returnByValue:true});c.close();if(r.result?.result?.value==="VidGrab")return t}};
  for(let i=0;i<60&&!sw;i++){await sleep(250);try{targets=await req("GET","/json/list");sw=await findOurs()}catch{}}
  const extId=new URL(sw.url).host;
  const swc=await cdp(sw.webSocketDebuggerUrl); await swc.call("Runtime.enable");
  const ev=async(e)=>{const r=await swc.call("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value};
  // page with media
  const pt=await req("PUT","/json/new?about:blank"); const pg=await cdp(pt.webSocketDebuggerUrl); await pg.call("Page.enable");
  await ev("__vg.setSettings({ minSizeKB: 10 })");
  await pg.call("Page.navigate",{url:`http://127.0.0.1:${fixPort}/`}); await sleep(1500);
  await pg.call("Runtime.evaluate",{expression:`fetch('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8').then(r=>r.text());const v=document.createElement('video');v.src='https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';v.muted=true;document.body.appendChild(v);v.load();`});
  await sleep(5000);
  const tabId=await ev(`chrome.tabs.query({url:'http://127.0.0.1:${fixPort}/*'}).then(t=>t[0]?.id)`);
  const media=await ev(`__vg.getTabMedia(${tabId})`);
  // start two jobs so the side panel has content; pause one
  const direct=media.find(m=>m.kind!=="hls"); const hls=media.find(m=>m.url.includes("_ld_7"));
  const insp = hls ? await ev(`__vg.inspectHls(${JSON.stringify(hls)})`) : null; void insp;
  if(direct) await ev(`__vg.startDownload(${JSON.stringify(direct)})`);
  let j2; if(hls) j2=await ev(`__vg.startDownload(${JSON.stringify(hls)})`);
  await sleep(2500);
  const shot=async(url,w,h,file,prep)=>{const t=await req("PUT",`/json/new?${url}`);const c=await cdp(t.webSocketDebuggerUrl);await c.call("Page.enable");await c.call("Runtime.enable");const evs=[];c.onEvent=(e)=>evs.push(e);await c.call("Emulation.setDeviceMetricsOverride",{width:w,height:h,deviceScaleFactor:2,mobile:false});await sleep(1500);if(prep)await c.call("Runtime.evaluate",{expression:prep,awaitPromise:true});await sleep(900);const m=await c.call("Page.getLayoutMetrics");const ch=Math.min(2000,Math.ceil(m.result.cssContentSize?.height||m.result.contentSize.height));await c.call("Emulation.setDeviceMetricsOverride",{width:w,height:Math.max(h,ch),deviceScaleFactor:2,mobile:false});await sleep(300);const r=await c.call("Page.captureScreenshot",{format:"png",captureBeyondViewport:true});writeFileSync(join(out,file),Buffer.from(r.result.data,"base64"));console.log("wrote",file);c.close()};
  // popup needs the "active tab" to be example.com: make it active first
  await ev(`chrome.tabs.update(${tabId},{active:true})`);
  await shot(`chrome-extension://${extId}/popup.html`,440,420,"popup.png",`new Promise(r=>setTimeout(r,9000)).then(()=>{const t=[...document.querySelectorAll('.card')].find(c=>c.querySelector('.chip.hls'))||document.querySelector('.card');t?.querySelector('.cb')?.click();console.log('THUMBS', document.querySelectorAll('.thumb.has-img').length, '/', document.querySelectorAll('.thumb').length);return new Promise(r=>setTimeout(r,400))})`);
  await shot(`chrome-extension://${extId}/popup.html`,440,520,"picker.png",`new Promise(r=>setTimeout(r,7000)).then(()=>{const t=[...document.querySelectorAll('.card')].find(c=>c.querySelector('.title')?.textContent==='x36xhzz');t?.querySelector('.dl .btn')?.click();return new Promise(r=>setTimeout(r,1500))})`);
  await shot(`chrome-extension://${extId}/sidepanel.html`,380,620,"sidepanel.png");
  await shot(`chrome-extension://${extId}/sidepanel.html`,380,600,"settings.png",`document.querySelector('[data-view=settings]').click()`);
  swc.close(); pg.close();
} finally { fixSrv.close(); chrome.kill("SIGKILL"); await sleep(300); rmSync(profile,{recursive:true,force:true}); }
