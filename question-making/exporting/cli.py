"""Command-line entry for author catalog exports."""
import argparse
import json
from .catalog import export_catalog


def main(default_prefix='raven'):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--author', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--check-prompts')
    parser.add_argument('--check-grades')
    parser.add_argument('--prefix', default=default_prefix)
    args = parser.parse_args()
    stats = export_catalog(args.author, args.out, args.check_prompts, args.check_grades, args.prefix)
    print(json.dumps(stats, ensure_ascii=False, indent=2))
