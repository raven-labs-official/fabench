/** One persistent bridge per Python reader process; uses the exact same Node quota policy. */
import { createInterface } from "node:readline";
import { sharedRateLimiter, type Permit } from "../src/llm/shared-rate-limit.js";
const limiter=sharedRateLimiter();
if (!limiter) throw new Error("API admission bridge requires shared admission");
const permits=new Map<string,Permit>();
const lines=createInterface({input:process.stdin});
const send=(value:unknown)=>process.stdout.write(JSON.stringify(value)+"\n");
lines.on("line",line=>void(async()=>{
  let message:any;
  try {
    message=JSON.parse(line);
    if (message.op==="acquire") {
      const permit=await limiter.acquire(String(message.resource));
      const token=String(message.id); permits.set(token,permit);
      send({id:message.id,ok:true,token});
    } else {
      const permit=permits.get(String(message.token));
      if (!permit) throw new Error("Unknown admission permit");
      if (message.op==="limited") permit.limited(message.retry_after);
      else if (message.op==="release") { permit.release(message.success===true); permits.delete(String(message.token)); }
      else throw new Error("Unknown admission operation");
      send({id:message.id,ok:true});
    }
  } catch { send({id:message?.id??null,ok:false,error:"API admission unavailable"}); }
})());
function close() { for(const permit of permits.values())permit.release(); process.exit(0); }
lines.on("close",close); process.on("SIGTERM",close); process.on("SIGINT",close);
