/**
 * The oracle arm: hand the model the evidence it needed, and see whether that is enough.
 *
 * WHY. Retrieval arms have been scoring level with closed-book, and that result is consistent
 * with two opposite stories. Either the deciding evidence was never reachable at the anchor — in
 * which case the fix is corpus and ranking — or it was reached and misused, in which case the
 * fix is the harness. A transcript cannot separate them: a model that searched badly and a
 * corpus that lacks the answer produce the same empty result.
 *
 * So this arm removes retrieval from the question. Each model gets the closed-book prompt, no
 * tools, and a packet of evidence written by a hindsight analysis of what a forecaster needed on
 * the as-of date, restricted to claims that analysis marked as public BEFORE the anchor. Then:
 *
 *   oracle ≫ none   the evidence was worth having → the constraint is retrieval
 *   oracle ≈ none   the evidence was there and did not help → the constraint is reasoning
 *
 * This is a CEILING, not a system. The packet is chosen with the outcome known, so no deployable
 * retriever could match it, and the number it produces is an upper bound on what better search
 * could ever buy. A ceiling is exactly what is needed to decide where to spend, and it is worth
 * saying plainly that a ceiling near zero would be the more useful finding of the two.
 *
 * The closed-book comparison comes from the runs already in the registry rather than being
 * re-run here: this arm changes one thing, and re-deriving the baseline would change two.
 *
 * Usage:
 *   tsx src/experiments/oracle-evidence.ts --abduction abduction.json --llm deepseek:deepseek-v4-pro \
 *     [--out results.json] [--conc 4] [--limit 0]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AgenticSearchPredictor } from "../predictors/agentic-search.js";
import { createLlmClient } from "../llm/providers.js";
import { BudgetTier, NullRetrievalEnv } from "../predictors/types.js";
import type { Question } from "../types.js";

function arg(name: string, fallback = ""): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return (i >= 0 ? argv[i + 1] : undefined) ?? fallback;
}

interface Need {
  claim: string;
  why_decisive?: string;
  public_before_anchor?: boolean;
}
interface Abduced {
  id: string;
  as_of: string;
  needed_at_anchor: Need[];
}

/**
 * The packet the model sees.
 *
 * Claims only, never the reason a claim was decisive: "this is what settles it" is hindsight
 * about the outcome, and including it would hand over the answer rather than the evidence, which
 * is a different and much less interesting experiment.
 */
function packet(needs: Need[]): string {
  return needs.map((n, i) => `${i + 1}. ${n.claim}`).join("\n");
}

async function main() {
  const abductionPath = arg("abduction");
  const questionsPath = arg(
    "questions",
    "vendor/beta-raven-bench/data/polymarket-march-2026/agent_view/selected_300/questions.jsonl",
  );
  const llm = arg("llm", "deepseek");
  const out = arg("out", "");
  const conc = Number(arg("conc", "4"));
  const limit = Number(arg("limit", "0"));
  if (!abductionPath) {
    console.error("usage: oracle-evidence --abduction <abduction.json> --llm <provider:model> [--out f] [--conc N] [--limit N]");
    process.exit(2);
  }

  const abduced = (JSON.parse(readFileSync(abductionPath, "utf8")) as Abduced[]).map((a) => ({
    ...a,
    // Anything the abduction could not place before the anchor is not evidence a forecaster
    // could have had, and putting it in the packet would measure clairvoyance.
    needed_at_anchor: (a.needed_at_anchor ?? []).filter((n) => n.public_before_anchor !== false),
  }));

  const qs = new Map<string, Record<string, unknown>>();
  for (const line of readFileSync(questionsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const q = JSON.parse(line) as Record<string, unknown>;
    qs.set(String(q.id), q);
  }

  const eligible = abduced.filter((a) => a.needed_at_anchor.length > 0 && qs.has(a.id));
  // Counted before --limit is applied: a deliberately small run is not a skipped question, and
  // reporting them together makes a smoke test look like a coverage failure.
  const skipped = abduced.length - eligible.length;
  const work = limit > 0 ? eligible.slice(0, limit) : eligible;

  const li = llm.indexOf(":");
  const client = createLlmClient(li >= 0 ? llm.slice(0, li) : llm, li >= 0 ? llm.slice(li + 1) : undefined);

  console.error(`[INFO] execution_mode=live decision=user/oracle-arm`);
  console.error(`[INFO] llm=${client.id} questions=${work.length}${skipped ? ` (skipped ${skipped}: no evidence before the anchor or question missing)` : ""} concurrency=${conc}`);

  const results: Array<Record<string, unknown>> = [];
  let done = 0;
  let failed = 0;
  const queue = [...work];

  async function worker() {
    for (;;) {
      const a = queue.shift();
      if (!a) return;
      const raw = qs.get(a.id)!;
      const prompt = String(raw.prompt ?? "");
      const criteria = prompt.split("Resolution criteria:", 2)[1]?.trim() ?? "";
      const question: Question = {
        question_id: a.id,
        question_text: String(raw.en_title ?? ""),
        resolution_criteria: criteria,
        resolution_date: String(raw.end_time ?? ""),
        as_of_date: a.as_of,
        category: String(raw.domain ?? ""),
        difficulty_level: String(raw.forecast_difficulty ?? ""),
        source: "beta-raven-bench",
        language: "en",
      } as Question;

      // No backend: closed book. The ONLY difference from the `none` arm is the packet.
      const predictor = new AgenticSearchPredictor(client, undefined, {
        maxToolCalls: 0,
        providedEvidence: packet(a.needed_at_anchor),
      });
      try {
        const p = await predictor.predict(question, NullRetrievalEnv, BudgetTier.Unlimited);
        results.push({
          id: a.id,
          probability: p.probabilities[0],
          evidence_items: a.needed_at_anchor.length,
          rationale: p.rationale_md?.slice(0, 4000) ?? "",
        });
      } catch (e) {
        failed++;
        // Recorded, not swallowed: a silently dropped cell makes the arm look better than it is.
        results.push({ id: a.id, probability: null, evidence_items: a.needed_at_anchor.length, error: String(e).slice(0, 300) });
      }
      done++;
      if (done % 10 === 0) console.error(`[INFO] ${done}/${work.length} (failed ${failed})`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, conc) }, worker));

  const ok = results.filter((r) => r.probability != null);
  console.log(`Done: ${results.length} questions · succeeded ${ok.length} · failed ${failed}`);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ llm: client.id, generated_at_utc: new Date().toISOString(), results }, null, 1));
    console.log(`→ ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
