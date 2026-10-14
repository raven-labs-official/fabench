import assert from "node:assert/strict";
import test from "node:test";
import { parseAvailabilityAssessment } from "./temporal-availability.js";
import { LeakFilter } from "./leak-filter.js";
import { isRetrievalInfrastructureError } from "./infrastructure-error.js";

function assessment(label: "clean" | "leaked" | "unknown", quote = "LIVE_HEADLINE") {
  return { main:{label:"clean", reason:"Old article"}, ancillary:{label, reason:"Separate update"},
    useful:true, evidence:label === "clean" ? [] : [{ area:"ancillary", label, quote, availability_basis:"Separate issue date" }] };
}
const document = { body:"😀 LIVE_HEADLINE", title:"Preview", url:"https://example.test/page" };
const completion = (value: unknown) => ({ text:JSON.stringify(value), costUsd:0, inputTokens:0, outputTokens:0 });

test("unresolved ancillary information cannot be cleared by a model-supplied global verdict", () => {
  const result = parseAvailabilityAssessment({ ...assessment("unknown"), label:"clean", withheld:false, body_sha256:"fake" }, document);
  assert.equal(result.label, "unknown");
  assert.equal(result.evidence[0]?.start, 3);
  assert.equal(result.evidence[0]?.offsetUnit, "utf16");
  assert.equal("body_sha256" in result, false);
});

test("temporal evidence must exist and support each non-clean component", () => {
  assert.throws(() => parseAvailabilityAssessment(assessment("unknown", "invented quote"), document), /not found/);
  assert.throws(() => parseAvailabilityAssessment({ ...assessment("unknown"), evidence:[] }, document), /unverified/);
  const inconsistent = assessment("unknown");
  inconsistent.evidence[0]!.label = "leaked";
  assert.throws(() => parseAvailabilityAssessment(inconsistent, document), /disagree/);
});

test("a quote in the supplied title is verified as title evidence, not body evidence", () => {
  const result = parseAvailabilityAssessment(assessment("leaked", "Final score"), { ...document, title:"Final score" });
  assert.equal(result.label, "leaked");
  assert.equal(result.evidence[0]?.source, "title");
});

test("clean navigation is not converted into uncertainty because it is unhelpful", () => {
  const result = parseAvailabilityAssessment({ ...assessment("clean"), useful:false }, document);
  assert.equal(result.label, "clean");
  assert.equal(result.useful, false);
});

test("unknown in an early passage survives later clean text and cached delivery", async () => {
  let calls = 0;
  const filter = new LeakFilter({ id:"fixture", async complete(request) {
    calls++; return completion(assessment(request.prompt.includes("LIVE_HEADLINE") ? "unknown" : "clean"));
  } }, { availabilityPolicy:"component-availability-v4", reviewChars:40, reviewAttempts:1 });
  const body = "LIVE_HEADLINE".padEnd(40) + "old facts".padEnd(40);
  const check = () => filter.checkWithTrace(document.url, document.title, body, "2026-09-02", {reviewAll:true});
  const first = await check(), cached = await check();
  assert.equal(first.leaked, false);
  assert.equal(first.uncertain, true);
  assert.equal(first.withheld, true);
  assert.equal(first.reviewedChars, body.length);
  assert.equal(cached.uncertain, true);
  assert.equal(cached.cacheHit, true);
  assert.equal(calls, 2);
  assert.equal(filter.snapshot().uncertaintyDropped, 1);
});

test("a confirmed leak in a later passage supersedes earlier uncertainty", async () => {
  let calls = 0;
  const filter = new LeakFilter({ id:"fixture", async complete(request) {
    calls++;
    if (request.prompt.includes("LATER_RESULT")) return completion(assessment("leaked", "LATER_RESULT"));
    return completion(assessment(request.prompt.includes("LIVE_HEADLINE") ? "unknown" : "clean"));
  } }, { availabilityPolicy:"component-availability-v4", reviewChars:40, reviewAttempts:1 });
  const body = "LIVE_HEADLINE".padEnd(40) + "old facts".padEnd(40) + "LATER_RESULT".padEnd(40);
  const got = await filter.checkWithTrace(document.url, document.title, body, "2026-09-02", {reviewAll:true});
  assert.equal(got.leaked, true);
  assert.equal(got.uncertain, false);
  assert.equal(got.availability?.evidence[0]?.start, 80);
  assert.equal(calls, 3);
  assert.equal(filter.snapshot().uncertaintyDropped, 0);
});

test("a malformed v4 verdict is an infrastructure error, never a cached clean pass", async () => {
  let broken = true;
  const filter = new LeakFilter({ id:"fixture", async complete() {
    return completion(broken ? {leaked:false, reason:"legacy shape"} : assessment("clean"));
  } }, { availabilityPolicy:"component-availability-v4", reviewAttempts:1 });
  const check = () => filter.checkWithTrace(document.url, document.title, document.body, "2026-09-02", {reviewAll:true});
  await assert.rejects(check(), isRetrievalInfrastructureError);
  broken = false;
  const got = await check();
  assert.equal(got.withheld, false);
  assert.equal(got.cacheHit, false);
});

test("default policy audits live header claims while keeping physical-capture review on its original contract", async () => {
  const systems: string[] = [];
  const filter = new LeakFilter({id:"fixture",async complete(request){
    systems.push(request.system ?? "");
    return completion(request.system?.includes("Header audit:")
      ? assessment("unknown") : {leaked:false,reason:"Pre-announced future schedule"});
  }},{reviewAttempts:1});
  const body="LIVE_HEADLINE. Conference planned for September 5, 2026.";
  const live=await filter.checkWithTrace(document.url,document.title,body,"2026-09-02",{reviewAll:true});
  const physical=await filter.checkWithTrace(document.url,document.title,body,"2026-09-02");
  assert.equal(live.uncertain,true);
  assert.equal(physical.withheld,false);
  assert.equal(systems.length,2);
  assert.match(systems[0]!,/BEFORE the main title/);
  assert.doesNotMatch(systems[1]!,/Header audit:/);
});
