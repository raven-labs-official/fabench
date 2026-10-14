#!/usr/bin/env python3
"""Compare the legacy regex text path with Trafilatura on saved HTML only.

Run in an isolated environment with trafilatura==2.2.0. This is a local pilot,
not the production reader or a proof of temporal admissibility.
"""
import argparse
import hashlib
import importlib.metadata
import json
import re
from pathlib import Path
import trafilatura


def regex_text(html):
    text = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    for a, b in [("&amp;", "&"), ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">")]:
        text = text.replace(a, b)
    return re.sub(r"\s+", " ", text).strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("html", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    data = args.html.read_bytes()
    html = data.decode("utf-8", errors="replace")
    outputs = {"legacy_regex": regex_text(html)}
    for mode in ["standard", "precision", "recall"]:
        options = {"favor_" + mode: True} if mode != "standard" else {}
        outputs[mode] = trafilatura.extract(html, output_format="txt", include_comments=False,
                                           include_tables=True, **options) or ""
    report = {"source": str(args.html), "raw_sha256": hashlib.sha256(data).hexdigest(),
              "trafilatura_version": importlib.metadata.version("trafilatura"),
              "scope": "Extraction comparison only; these bytes are not certified historical evidence.",
              "outputs": {k: {"chars": len(v), "sha256": hashlib.sha256(v.encode()).hexdigest(), "text": v}
                          for k, v in outputs.items()}}
    with args.out.open("x") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(json.dumps({k: v["chars"] for k, v in report["outputs"].items()}))


if __name__ == "__main__":
    main()
