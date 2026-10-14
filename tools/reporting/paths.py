"""Resolve local report inputs without changing the team's default SSH query."""
from dataclasses import dataclass
from pathlib import Path

from path_config import PROJECT_ROOT, absolute_path, configured_path


@dataclass(frozen=True)
class ReportPaths:
    results: Path
    registry: Path
    local: bool


def add_input_arguments(parser):
    parser.add_argument('--local', action='store_true', help='Read local files; never query SSH')
    parser.add_argument('--results-dir', type=Path, help='Root containing the pinned question sets')
    parser.add_argument('--registry', type=Path, help='Read-only registry file or snapshot')


def report_paths(args, shared_root):
    configured_results = (configured_path('resultsDir', 'FABENCH_RESULTS_DIR')
                          if args.results_dir is None else None)
    configured_registry = (configured_path('registryPath', 'FABENCH_EXPERIMENT_REGISTRY')
                           if args.registry is None else None)
    local = bool(args.local or args.results_dir is not None or args.registry is not None
                 or configured_results is not None or configured_registry is not None)
    default_root = PROJECT_ROOT / 'results' if local else shared_root
    results = absolute_path(args.results_dir or configured_results or default_root)
    registry = absolute_path(args.registry or configured_registry or results / 'registry.sqlite')
    return ReportPaths(results, registry, local)
