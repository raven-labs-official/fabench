#!/usr/bin/env python3
"""Offline arithmetic over frozen, evidence-backed search-audit annotations.

No extraction, retrieval, or LLM calls. Annotations still need independent validation.
See docs/bench-migration-20260912.md for the estimands.
"""
import argparse
import json
import math
from pathlib import Path


def positive(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError("weight must be finite and positive")
    return value


def probability(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("probability must be in [0, 1]")
    return value


def indexed(rows):
    out = {}
    for row in rows:
        key = row["id"]
        if not isinstance(key, str) or not key or key in out:
            raise ValueError("IDs must be unique nonempty strings")
        out[key] = row
    return out


def coverage(reference, matches, sources):
    """Group weights prevent finer splitting from automatically increasing credit.

    A match is an adjudicated coherent support bundle. identity_verified covers
    entity, measure, period, unit, attribution, and modality. The scorer verifies
    source quotations, not the semantic entailment supplied by the annotator.
    """
    refs = indexed(reference)
    by_ref = {key: [] for key in refs}
    for match in matches:
        if match["reference_id"] not in refs:
            raise ValueError("unknown reference")
        by_ref[match["reference_id"]].append(match)
    rows = []
    for key, ref in refs.items():
        facets = indexed(ref["facets"])
        if not facets:
            raise ValueError("a reference needs at least one facet")
        weights = {k: positive(f.get("weight", 1)) for k, f in facets.items()}
        best_partial, best_full, conflicting = 0.0, 0, False
        for match in by_ref[key]:
            if not isinstance(match.get("identity_verified"), bool):
                raise ValueError("identity_verified must be explicit")
            verdicts = match.get("facets", {})
            if set(verdicts) - set(facets):
                raise ValueError("unknown facet")
            supported = set()
            for fid, verdict in verdicts.items():
                label = verdict["label"]
                if label not in {"supported", "contradicted", "missing", "unknown"}:
                    raise ValueError("invalid entailment label")
                if label in {"supported", "contradicted"}:
                    evidence = verdict.get("evidence", [])
                    if not evidence:
                        raise ValueError("support/contradiction needs an exact source quote")
                    for e in evidence:
                        quote = e["quote"]
                        if not quote.strip() or quote not in sources[e["source_id"]]:
                            raise ValueError("quote is absent from the frozen source")
                if match["identity_verified"]:
                    if label == "supported":
                        supported.add(fid)
                    if label == "contradicted":
                        conflicting = True
            if match["identity_verified"]:
                best_partial = max(best_partial, sum(weights[k] for k in supported) / sum(weights.values()))
                best_full = max(best_full, int(supported == set(facets)))
        rows.append({"id": key, "weight": positive(ref.get("weight", 1)),
                     "partial": best_partial, "complete": best_full, "conflict_observed": conflicting})
    total = sum(r["weight"] for r in rows)
    return {"partial_coverage": sum(r["weight"] * r["partial"] for r in rows) / total if total else None,
            "complete_recall": sum(r["weight"] * r["complete"] for r in rows) / total if total else None,
            "reference_groups": len(rows), "conflicting_groups": sum(r["conflict_observed"] for r in rows),
            "groups": rows}


def leakage_bounds(exposures):
    """Descriptive bounds for fully audited recorded exposures; not a confidence interval.

    multiplicity counts repeated delivery of the exact same artifact within one
    event. Unknowns remain unknown; sampling requires a separate estimator.
    """
    rows = indexed(exposures)
    counts = {"safe": 0, "leak": 0, "unknown": 0}
    events = {}
    for row in rows.values():
        label = row["label"]
        if label not in counts:
            raise ValueError("invalid temporal label")
        weight = positive(row.get("multiplicity", 1))
        if int(weight) != weight:
            raise ValueError("multiplicity must be an integer")
        counts[label] += weight
        event = row["event_id"]
        if not isinstance(event, str) or not event:
            raise ValueError("event_id is required")
        events.setdefault(event, set()).add(label)
    n = sum(counts.values())
    ne = len(events)
    lower = sum("leak" in labels for labels in events.values())
    upper = sum(bool(labels & {"leak", "unknown"}) for labels in events.values())
    return {"exposures": n, "counts": counts,
            "leakage_lower": counts["leak"] / n if n else None,
            "leakage_upper": (counts["leak"] + counts["unknown"]) / n if n else None,
            "unknown_rate": counts["unknown"] / n if n else None,
            "events": ne, "event_leakage_lower": lower / ne if ne else None,
            "event_leakage_upper": upper / ne if ne else None,
            "interpretation": "Bounds over the annotated frame, conditional on the supplied labels; not confidence intervals."}


def corrected_leakage(population, audited):
    """Generalized difference / Horvitz-Thompson residual estimator.

    Each population item is a unique version+cutoff with a fixed model score and
    an exposure weight. Human audited items are probability-sampled, with known
    positive inclusion probabilities. Input assertions about the sampling design
    and human truth cannot be established by this arithmetic function.
    """
    pop = indexed(population)
    audit = indexed(audited)
    if set(audit) - set(pop):
        raise ValueError("audited item absent from population")
    if not pop or not audit:
        raise ValueError("both a population and a probability audit are required")
    weight = {k: positive(r.get("exposure_weight", 1)) for k, r in pop.items()}
    pred = {k: probability(r["model_score"]) for k, r in pop.items()}
    total = sum(weight.values())
    model = sum(weight[k] * pred[k] for k in pop) / total
    correction = 0.0
    for k, r in audit.items():
        if r["label"] not in (0, 1):
            raise ValueError("gold labels must be 0/1; unresolved items require bounds")
        pi = probability(r["inclusion_probability"])
        if pi <= 0:
            raise ValueError("inclusion probability must be positive")
        correction += weight[k] * (r["label"] - pred[k]) / pi / total
    estimate = model + correction
    return {"model_only_rate": model, "audit_correction": correction,
            "corrected_rate_unclipped": estimate, "out_of_range": not 0 <= estimate <= 1,
            "population_units": len(pop), "audited_units": len(audit),
            "confidence_interval": None,
            "interpretation": "Design-based point estimate only. Interval needs the actual stratified/cluster sampling design. No clipping is applied."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    x = json.loads(args.input.read_text())
    out = {"schema": "raven.search-audit-metrics.v1"}
    if "reference" in x:
        out["coverage"] = coverage(x["reference"], x["matches"], x["sources"])
    if "exposures" in x:
        out["leakage_bounds"] = leakage_bounds(x["exposures"])
    if "population" in x:
        out["corrected_leakage"] = corrected_leakage(x["population"], x["audited"])
    if len(out) == 1:
        raise ValueError("no supported audit inputs")
    text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        with args.out.open("x") as f:
            f.write(text)
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
