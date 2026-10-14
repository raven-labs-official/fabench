/** Read only model-visible tool responses; findings are exposure clues, not leak verdicts. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { countMarketPriceMentions } from "../retrieval/market-blocklist.js";

type Obj = Record<string, any>;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function inspectVisibleContent(content: unknown, anchor: string) {
  const findings: Obj[] = [];
  const visit = (value: unknown, location: string) => {
    if (typeof value === "string") {
      const mentions = countMarketPriceMentions(value);
      if (mentions) {
        const start = Math.max(
          0,
          value.search(
            /polymarket|kalshi|manifold|metaculus|predictit|prediction market|betting market|bookmaker/i,
          ) - 60,
        );
        findings.push({
          kind: "market_price_mention",
          location,
          mentions,
          excerpt: value.slice(start, start + 400),
        });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
    } else if (value && typeof value === "object") {
      for (const [key, field] of Object.entries(value)) {
        const path = `${location}.${key}`;
        if (
          /^(publish(?:ed)?_?date|publication_date|published_at|available_?at|date)$/i.test(
            key,
          ) &&
          typeof field === "string"
        ) {
          if (
            /^\d{4}-\d{2}-\d{2}$/.test(field) &&
            field === anchor.slice(0, 10)
          ) {
            findings.push({
              kind: "same_day_unknown_time",
              location: path,
              observed: field,
            });
          } else if (
            /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(field) &&
            Date.parse(field) >= Date.parse(anchor)
          ) {
            findings.push({
              kind: "date_not_before_anchor",
              location: path,
              observed: field,
              url: (value as Obj).url ?? null,
            });
          }
        }
        visit(field, path);
      }
    }
  };
  visit(content, "$");
  return findings;
}

export function auditExposure(path: string) {
  const raw = readFileSync(path, "utf8");
  const events = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const start = events.find((event) => event.type === "cell_started")?.data;
  const anchor = start?.as_of ?? start?.as_of_date;
  if (typeof anchor !== "string" || !Number.isFinite(Date.parse(anchor)))
    throw new Error("Missing trace anchor");
  const findings: Obj[] = [],
    issues: Obj[] = [];
  let visibleResponses = 0;
  for (const event of events) {
    if (
      event.type !== "tool_call_finished" ||
      !["web_search", "web_fetch"].includes(event.data?.name)
    )
      continue;
    const data = event.data;
    try {
      let content: unknown;
      if (typeof data.content === "string") {
        try {
          content = JSON.parse(data.content);
        } catch {
          content = data.content;
        }
      } else if (data.model_visible_content?.text_blob) {
        const {
          text_blob: blob,
          reconstruction: _reconstruction,
          ...metadata
        } = data.model_visible_content;
        const root = resolve(dirname(path), "..");
        const blobPath = resolve(root, blob.path);
        if (!blobPath.startsWith(root + sep))
          throw new Error("Blob path outside trace archive");
        const text = readFileSync(blobPath, "utf8");
        if (digest(text) !== blob.sha256) throw new Error("Blob hash mismatch");
        content = { ...metadata, text };
      } else throw new Error("Model-visible content missing");
      visibleResponses++;
      for (const finding of inspectVisibleContent(content, anchor)) {
        findings.push({
          ...finding,
          sequence: event.sequence,
          call_id: data.call_id,
          tool: data.name,
        });
      }
    } catch (error) {
      issues.push({
        sequence: event.sequence,
        error: (error as Error).message,
      });
    }
  }
  return {
    trace: resolve(path),
    trace_sha256: digest(raw),
    question_id: start.question_id,
    arm: start.arm,
    anchor,
    visible_responses: visibleResponses,
    findings,
    issues,
    interpretation:
      "Date observations and market-price mentions require source review; they do not establish outcome leakage or prediction impact.",
  };
}
