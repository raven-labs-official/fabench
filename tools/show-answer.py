#!/usr/bin/env python3
"""Print one answer from a run transcript, in the order the model produced it.

The transcript is one JSON object per (question, arm) and runs to ~90 MB for a full run, so
it is not something to open. This prints a single answer as a readable trace: what it thought
on each turn, what it searched, what came back, what it read, and what it committed to.

Usage:
  tools/show-answer.py results/transcript-<tag>.jsonl              # list what is in there
  tools/show-answer.py results/transcript-<tag>.jsonl 3            # the 4th record
  tools/show-answer.py results/transcript-<tag>.jsonl braven::abc frozen
  tools/show-answer.py results/trace-<tag>/ 0 --full               # every thought/query/result
  tools/show-answer.py results/trace-<tag>/ 0 --json-output answer.json
"""
import json, os, sys, textwrap

raw_args = sys.argv[1:]
full = "--full" in raw_args
json_output = None
if "--json-output" in raw_args:
    output_index = raw_args.index("--json-output")
    if output_index + 1 >= len(raw_args):
        raise SystemExit("--json-output requires a file path")
    json_output = raw_args[output_index + 1]
    raw_args = raw_args[:output_index] + raw_args[output_index + 2:]
args = [arg for arg in raw_args if arg != "--full"]
if not args:
    raise SystemExit(
        "usage: show-answer.py TRACE_OR_CELLS [ROW|QUESTION_ID] [ARM] "
        "[--full] [--json-output FILE]"
    )
input_path = args[0]
trace_directory = input_path if os.path.isdir(input_path) else None
path = os.path.join(input_path, "cells.jsonl") if trace_directory else input_path
rows = [json.loads(l) for l in open(path) if l.strip()]

if len(args) == 1:
    print(f"{len(rows)} records · {len(set(r['question_id'] for r in rows))} questions × "
          f"{sorted(set(r['arm'] for r in rows))}\n")
    for i, r in enumerate(rows[:40]):
        hit = "✓" if (r["probability"] is not None and r["ground_truth"] is not None
                      and abs(r["probability"] - r["ground_truth"]) < 0.5) else "✗"
        print(f"  [{i:>3}] {hit} p={r['probability']:.2f} truth={r['ground_truth']} "
              f"{r['arm']:<7} {r['question'][:56]}")
    if len(rows) > 40:
        print(f"  … {len(rows)-40} more")
    sys.exit()

sel = args[1]
r = rows[int(sel)] if sel.isdigit() else next(
    x for x in rows if x["question_id"] == sel and (len(args) < 3 or x["arm"] == args[2]))
trace_events = []
if trace_directory and r.get("trace_file"):
    event_path = os.path.join(trace_directory, r["trace_file"])
    if os.path.exists(event_path):
        trace_events = [json.loads(line) for line in open(event_path) if line.strip()]

def event_for(event_type, call_id):
    return next((event.get("data") or {} for event in trace_events
                 if event.get("type") == event_type
                 and (event.get("data") or {}).get("call_id") == call_id), None)

def read_blob(ref):
    if not trace_directory or not ref:
        return None
    path = ref.get("path") if isinstance(ref, dict) else str(ref)
    root = os.path.realpath(trace_directory)
    target = os.path.realpath(os.path.join(root, path))
    if target != root and not target.startswith(root + os.sep):
        return None
    try:
        return open(target, encoding="utf-8").read()
    except OSError:
        return None
condition = r.get("condition") or {}
manifest = {}
if trace_directory:
    manifest_path = os.path.join(trace_directory, "manifest.json")
    if os.path.exists(manifest_path):
        manifest = json.load(open(manifest_path))
manifest_run = manifest.get("run") or {}

model_config = {
    "forecaster": manifest_run.get("llm_client") or {"id": condition.get("model")},
    "forecaster_reasoning": manifest_run.get("reasoning") or {
        "reasoning_mode": condition.get("reasoning_mode"),
        "thinking_effort": condition.get("thinking_effort"),
        "requested_thinking_effort": condition.get("requested_thinking_effort"),
        "source": condition.get("reasoning_source"),
    },
    "filter": manifest_run.get("leakFilterClient") or {"id": condition.get("filter_model")},
    "filter_reasoning": manifest_run.get("leakFilterReasoning") or condition.get("filter_reasoning"),
    "filter_policy": manifest_run.get("leakFilterPolicy") or condition.get("filter_policy"),
    "harness": condition.get("harness"),
    "search_type": condition.get("search_type") or r.get("arm"),
    "max_tool_calls": condition.get("max_tool_calls"),
    "max_search_calls": condition.get("max_search_calls"),
    "max_fetch_calls": condition.get("max_fetch_calls"),
    "max_results_per_search": condition.get("max_results_per_search"),
    "budget_scope": condition.get("budget_scope"),
    "question_concurrency": manifest_run.get("conc"),
}

if json_output:
    turns = []
    for thought in r.get("reasoning_turns") or []:
        turns.append({
            "turn": thought["turn"],
            "assistant": {
                "text": thought.get("text") or "",
                "reasoning": thought.get("reasoning") or "",
            },
            "tool_calls": [
                call for call in r.get("tool_calls") or [] if call["turn"] == thought["turn"]
            ],
        })
    export = {
        "display_header": {
            "stage": "Question being forecast",
            "question": r["question"],
            "question_id": r["question_id"],
            "as_of": r["as_of"],
        },
        "model_config": model_config,
        "schema_version": "raven.question-trace-export.v1",
        "run": {
            "run_id": manifest.get("run_id"),
            "tag": manifest.get("tag"),
            "started_at_utc": manifest.get("started_at_utc"),
            "finished_at_utc": manifest.get("updated_at_utc"),
            "question_set_id": condition.get("question_set_id"),
            "question_sample_id": condition.get("question_sample_id"),
            "condition_id": condition.get("condition_id"),
            "code_fingerprint_sha256": condition.get("code_fingerprint_sha256"),
            "git": (manifest.get("runtime") or {}).get("git"),
        },
        "trajectory": {
            "turns": turns,
            "sources_read": r.get("sources_read") or [],
            "retrieval_audits": [
                (event.get("data") or {}).get("audit") for event in trace_events
                if event.get("type") == "retrieval_audit"
            ],
        },
        "result": {
            "status": r.get("status"),
            "probability": r.get("probability"),
            "ground_truth": r.get("ground_truth"),
            "final_answer": r.get("final_answer"),
            "duration_ms": r.get("duration_ms"),
            "input_tokens": r.get("input_tokens"),
            "output_tokens": r.get("output_tokens"),
            "reasoning_tokens": r.get("reasoning_tokens"),
            "forecaster_cost_usd": r.get("cost_usd"),
        },
    }
    output_directory = os.path.dirname(os.path.abspath(json_output))
    os.makedirs(output_directory, exist_ok=True)
    with open(json_output, "w") as output_file:
        json.dump(export, output_file, ensure_ascii=False, indent=2)
        output_file.write("\n")
    print(f"Saved JSON: {os.path.abspath(json_output)}")
    sys.exit()

w = lambda t, ind="      ": textwrap.fill(" ".join(str(t).split()), 96,
                                          initial_indent=ind, subsequent_indent=ind)
print(f"\n{'='*100}\n▶ Question being forecast\n{r['question']}\n{'='*100}")
print("⚙ Model configuration")
print(f"  Forecaster: {condition.get('model') or (model_config['forecaster'] or {}).get('id')}")
print(f"  Reasoning: {condition.get('reasoning_source')} · "
      f"mode={condition.get('reasoning_mode')} · effort={condition.get('thinking_effort')}")
print(f"  Filter: {condition.get('filter_model') or (model_config['filter'] or {}).get('id')}")
print(f"  Harness/Search: {condition.get('harness')} / {condition.get('search_type') or r.get('arm')}")
print(f"  Tool budget: total={condition.get('max_tool_calls')} · "
      f"search={condition.get('max_search_calls')} · fetch={condition.get('max_fetch_calls')}")
print(f"  Concurrency: questions={model_config.get('question_concurrency')} · "
      f"filter={(model_config.get('filter_policy') or {}).get('review_concurrency')}\n")
usage = ""
if r.get("input_tokens") is not None:  # older transcripts lack these fields
    usage = (f" · {r['input_tokens']:,}→{r['output_tokens']:,} tok"
             f" · {r['duration_ms'] / 1000:.0f}s")
print(f"As of {r['as_of'][:10]} · arm {r['arm']} · probability {r['probability']} · "
      f"truth {r['ground_truth']} · ${r['cost_usd']:.4f}{usage}\n")

for t in r["reasoning_turns"]:
    if t.get("reasoning"):
        print(f"── Turn {t['turn']} · reasoning ({len(t['reasoning'])} chars)")
        thought = t["reasoning"] if full else t["reasoning"][:1200]
        print(w(thought) + ("\n      …" if not full and len(t["reasoning"]) > 1200 else ""))
    calls = [c for c in r["tool_calls"] if c["turn"] == t["turn"]]
    for c in calls:
        q = c["args"].get("query") or c["args"].get("url", "")
        print(f"\n   🔍 {c['name']}(\"{str(q)[:70]}\") → {c['outcome']}")
        results = c.get("results") or []
        for d in results if full else results[:5]:
            print(f"      [{d.get('source') or '—'}] {d['title'][:80]}")
            if full:
                date = d.get("publishDate") or d.get("crawlDate") or "date unknown"
                print(f"         {date} · {d['url']}")
                if d.get("snippet"):
                    print(w(d["snippet"], "         "))
        if full and c.get("fetched"):
            d = c["fetched"]
            date = d.get("publishDate") or d.get("crawlDate") or "date unknown"
            print(f"      FULL TEXT · {d['chars']:,} chars · {date}")
            print(f"         {d['url']}")
            finished = event_for("tool_call_finished", c.get("call_id")) or {}
            archived = finished.get("model_visible_content") or {}
            body = read_blob(archived.get("text_blob"))
            if body is None and isinstance(finished.get("content"), str):
                try:
                    body = json.loads(finished["content"]).get("text")
                except (ValueError, AttributeError):
                    body = None
            if body:
                print(w(body, "         "))
        if full:
            audit_event = event_for("retrieval_audit", c.get("call_id")) or {}
            audit = audit_event.get("audit") or c.get("audit") or {}
            candidates = audit.get("candidates") or []
            if candidates:
                print(f"      AUDIT · {len(candidates)} candidates")
                for candidate in candidates:
                    leak = candidate.get("leak_filter") or {}
                    fetch = candidate.get("fetch") or {}
                    blob = fetch.get("body_blob") or {}
                    print(f"         #{candidate.get('provider_rank')} "
                          f"{candidate.get('final_disposition')} · {candidate.get('url')}")
                    if leak:
                        print(f"            leak={leak.get('leaked')} · {leak.get('reason')} · "
                              f"evidence={leak.get('evidenceQuote') or '—'}")
                    if blob:
                        print(f"            body={blob.get('path')} · "
                              f"{fetch.get('body_chars', 0):,} chars · sha256={blob.get('sha256')}")
        if full and c.get("funnel"):
            f = c["funnel"]
            print("      FUNNEL · " + " · ".join([
                f"provider={f.get('provider_hits', 0)}",
                f"dated={f.get('pages_dated_pre_anchor', 0)}",
                f"undated={f.get('pages_undated', 0)}",
                f"late={f.get('pages_post_anchor_or_invalid', 0)}",
                f"review={f.get('leak_reviews', 0)}",
                f"drop={f.get('leak_dropped', 0)}",
                f"cache={f.get('leak_cache_hits', 0)}",
                f"served={f.get('served', 0)}",
            ]))
    print()

if r["sources_read"]:
    print(f"── {len(r['sources_read'])} articles read in full")
    for s in r["sources_read"]:
        print(f"      {s['title'][:88]}")
print(f"\n── Final reasoning\n{w(r['final_answer'], '   ')}")
