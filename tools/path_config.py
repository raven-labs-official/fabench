"""Optional non-secret paths and installation settings shared with src/path-config.ts.

A value comes from the first of: its environment variable (FABENCH_*, or the former RAVEN_*
name when that is unset; see env_names.py); the JSON file named by FABENCH_PATHS_CONFIG;
config/site.json, where a deployment may commit its own defaults (the public source tree has
none). Relative paths in a file resolve against that file's directory.
docs/configuration.md lists every key.

Shell scripts read a setting with `python3 tools/path_config.py get KEY`.
"""
import json
import os
from pathlib import Path
import sys

try:
    from env_names import project_env
except ImportError:  # `python3 -I tools/path_config.py` leaves this directory off sys.path
    sys.path.append(str(Path(__file__).resolve().parent))
    from env_names import project_env


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SITE_CONFIG_FILE = PROJECT_ROOT / 'config' / 'site.json'

# Roots used when none is configured. Nothing can exist or be created under /dev/null, so
# existence checks fail and writes fail, exactly as on a host without the shared filesystem.
UNCONFIGURED_SHARED_ROOT = '/dev/null/FABENCH_SHARED_ROOT-not-set'
UNCONFIGURED_DATA_ROOT = '/dev/null/FABENCH_DATA_ROOT-not-set'

# Settings a shell script may read, with their environment variables.
SETTINGS = {
    'sharedRoot': ('FABENCH_SHARED_ROOT', True),
    'dataRoot': ('FABENCH_DATA_ROOT', True),
    'siteName': ('FABENCH_SITE_NAME', False),
    'teamGroup': ('FABENCH_TEAM_GROUP', False),
    'reportHost': ('FABENCH_REPORT_HOST', False),
}


def absolute_path(path):
    return Path(os.path.abspath(path))


def _read_config(path):
    try:
        config = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f'Cannot read path configuration {path}: {error}') from error
    if not isinstance(config, dict):
        raise ValueError(f'{path}: path configuration must be a JSON object')
    return config


def _config_entry(key):
    """(file, value) from the first configuration file that sets key, or None."""
    config_file = project_env('FABENCH_PATHS_CONFIG', '').strip()
    site_file = Path(SITE_CONFIG_FILE)
    for file in (config_file or None, site_file if site_file.exists() else None):
        if file is None:
            continue
        path = absolute_path(file)
        config = _read_config(path)
        if key in config:
            return path, config[key]
    return None


def configured_path(key, environment_name):
    override = project_env(environment_name, '').strip()
    if override:
        return absolute_path(override)
    entry = _config_entry(key)
    if entry is None:
        return None
    path, value = entry
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{path}: {key} must be a nonempty path')
    return absolute_path(path.parent / value)


def configured_setting(key, environment_name):
    """A non-path setting (a name), with the same layers as configured_path."""
    override = project_env(environment_name, '').strip()
    if override:
        return override
    entry = _config_entry(key)
    if entry is None:
        return None
    path, value = entry
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{path}: {key} must be a nonempty string')
    return value


def required_path(key, environment_name):
    path = configured_path(key, environment_name)
    if path is None:
        raise ValueError(
            f'Set {environment_name}, or set {key} in the JSON file selected by FABENCH_PATHS_CONFIG')
    return path


# Fixed locations of the multi-user shared filesystem layout, all below one configured root,
# with the same names and values as src/path-config.ts. Callers keep their own environment
# overrides; checks that require a shared location compare against these values.
SHARED_ROOT = str(configured_path('sharedRoot', 'FABENCH_SHARED_ROOT') or UNCONFIGURED_SHARED_ROOT)
SHARED_RUNS_ROOT = f'{SHARED_ROOT}/runs'
SHARED_BENCH_DIR = f'{SHARED_RUNS_ROOT}/raven-bench'
SHARED_RESULTS_DIR = f'{SHARED_BENCH_DIR}/results'
SHARED_REGISTRY_PATH = f'{SHARED_BENCH_DIR}/registry.sqlite'
TEAM_CONFIG_DIR = f'{SHARED_ROOT}/config/raven-bench'
CURRENT_RELEASE = f'{SHARED_ROOT}/current/raven-bench'
FROZEN_SHARED_CACHE = f'{SHARED_ROOT}/cache/frozen-query/cache.sqlite'


def setting(key):
    """A setting by its JSON key; the roots fall back to their unconfigured paths."""
    environment_name, is_path = SETTINGS[key]
    if is_path:
        value = configured_path(key, environment_name)
        if value is None:
            return UNCONFIGURED_SHARED_ROOT if key == 'sharedRoot' else UNCONFIGURED_DATA_ROOT
        return str(value)
    return configured_setting(key, environment_name)


def main(argv):
    if len(argv) != 2 or argv[0] != 'get' or argv[1] not in SETTINGS:
        print(f'usage: path_config.py get {{{",".join(SETTINGS)}}}', file=sys.stderr)
        return 2
    try:
        value = setting(argv[1])
    except ValueError as error:
        print(f'[ERR] {error}', file=sys.stderr)
        return 1
    if value is None:
        environment_name = SETTINGS[argv[1]][0]
        print(f'[ERR] Set {environment_name}, or set {argv[1]} in the JSON file selected by FABENCH_PATHS_CONFIG',
              file=sys.stderr)
        return 1
    print(value)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
