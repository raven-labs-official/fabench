import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {ProviderReasoningCapture} from "./reasoning-capture.js";

test("long reasoning flushes bounded batches and is preserved byte-for-byte",()=>{
 const events:any[]=[];const capture=new ProviderReasoningCapture(e=>events.push(e));
 const pieces=["A".repeat(20_000),"中文\n".repeat(8_000)," final"];
 for(const text of pieces)capture.observe({reasoning_content:text});
 assert.ok(events.length>=2);const result=capture.finish(true);
 const frames=events.filter(e=>e.type==="provider_reasoning_frames").flatMap(e=>e.data.frames);
 assert.equal(frames.map(x=>x.fields.reasoning_content).join(""),pieces.join(""));
 assert.equal(result.readable_sha256,createHash("sha256").update(pieces.join("")).digest("hex"));
 assert.equal(capture.text,pieces.join(""));assert.equal(result.native_frames,3);
});
