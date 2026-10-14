import { appendManualRetrievalReview } from "./manual-review.js";

function arg(name: string): string {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1]!;
}

const verdict = arg("verdict");
if (!(["leak", "clean", "uncertain"] as string[]).includes(verdict))
  throw new Error("--verdict must be leak, clean, or uncertain");

const path = appendManualRetrievalReview(arg("archive"), {
  body_sha256: arg("body-sha256"),
  url: arg("url"),
  verdict: verdict as "leak" | "clean" | "uncertain",
  reason: arg("reason"),
  evidence_quote: process.argv.includes("--evidence-quote")
    ? arg("evidence-quote")
    : undefined,
  reviewer: process.argv.includes("--reviewer") ? arg("reviewer") : undefined,
});
console.log(`manual review appended: ${path}`);

