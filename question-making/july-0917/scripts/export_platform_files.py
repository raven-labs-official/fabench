#!/usr/bin/env python3
"""July batch entry; shared export implementation lives in question-making/exporting."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from exporting.catalog import export_catalog
from exporting.cli import main


def export(author, out, check_prompts=None, check_grades=None, prefix='raven-july-2026'):
    return export_catalog(author, out, check_prompts, check_grades, prefix)


if __name__ == '__main__':
    main(default_prefix='raven-july-2026')
