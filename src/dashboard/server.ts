import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DashboardData } from "./data.js";
import { SHARED_REGISTRY_PATH, SITE_NAME } from "../path-config.js";
import { projectEnv } from "../env-names.js";
const data=new DashboardData(projectEnv("FABENCH_DASHBOARD_REGISTRY")??SHARED_REGISTRY_PATH);
/** The page names the configured server; every other asset is served unchanged. */
const siteLabel=SITE_NAME.toUpperCase().replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
const asset=(name:string)=>{const body=readFileSync(fileURLToPath(new URL("./public/"+name,import.meta.url)));
  return name==="index.html"?body.toString("utf8").replace("{{SITE_NAME}}",siteLabel):body;};
const assets=new Map([["/",["index.html","text/html; charset=utf-8"]],["/app.js",["app.js","text/javascript; charset=utf-8"]],["/style.css",["style.css","text/css; charset=utf-8"]]]);
const server=createServer((req,res)=>{
  res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("Cache-Control","no-store");
  res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host??"") || req.headers["sec-fetch-site"]==="cross-site") {res.writeHead(403);res.end();return;}
  if(req.method!=="GET"){res.writeHead(405);res.end();return;}
  try {
    const url=new URL(req.url??"/","http://localhost");
    if(assets.has(url.pathname)){const [name,type]=assets.get(url.pathname)!;res.setHeader("Content-Type",type!);res.end(asset(name!));return;}
    res.setHeader("Content-Type","application/json");
    if(url.pathname==="/api/runs"){res.end(JSON.stringify(data.snapshot()));return;}
    if(url.pathname==="/api/run"){const value=data.detail(url.searchParams.get("id")??"");res.writeHead(value?200:404);res.end(JSON.stringify(value??{error:"Run not found"}));return;}
    if(url.pathname==="/api/compare"){
      const ids=[...new Set((url.searchParams.get("ids")??"").split(",").filter(Boolean))];
      if(ids.length<2||ids.length>12){res.writeHead(400);res.end(JSON.stringify({error:"Choose 2–12 comparable runs"}));return;}
      try {res.end(JSON.stringify(data.compare(ids,url.searchParams.get("arm")??"")));}catch{res.writeHead(422);res.end(JSON.stringify({error:"These runs cannot be compared: choose one condition group and arm."}));}return;
    }
    if(url.pathname==="/healthz"){res.end(JSON.stringify({ok:true,readOnly:true}));return;}
    res.writeHead(404);res.end(JSON.stringify({error:"Not found"}));
  }catch{res.writeHead(503);res.end(JSON.stringify({error:"Registry or archive temporarily unavailable. Retry shortly."}));}
});
server.requestTimeout=10000;server.headersTimeout=10000;
server.listen(Number(projectEnv("FABENCH_DASHBOARD_PORT")??8787),"127.0.0.1",()=>console.log("FABench dashboard listening on loopback"));
process.on("SIGTERM",()=>server.close(()=>{data.close();process.exit(0);}));
