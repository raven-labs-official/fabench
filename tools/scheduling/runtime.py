"""Read the registry, track process identity, and persist controller state."""
import datetime as dt
import json
from pathlib import Path
import sqlite3

from path_config import SHARED_REGISTRY_PATH

REG = SHARED_REGISTRY_PATH
# /proc still lists zombie (Z) and dead (X) processes after they have exited.
EXITED_STATES = ('Z', 'X')

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def save(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)


def rows(sql, args=()):
    with sqlite3.connect('file:' + REG + '?mode=ro', uri=True, timeout=30) as db:
        db.row_factory = sqlite3.Row
        return [dict(r) for r in db.execute(sql, args)]


def identity(pid):
    try:
        f = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'start_ticks': f[19], 'state': f[0],
                'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except (OSError, IndexError, ValueError):
        return None


def alive(saved):
    live = identity(saved.get('pid'))
    return bool(live and live['state'] not in EXITED_STATES and all(live[k] == saved.get(k) for k in ('start_ticks', 'boot_id')))


def publication_grace(run, epoch):
    stamp = run.get('finished_at_utc')
    return bool(stamp and epoch - dt.datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() < 300)



def active(run):
    return alive({'pid': run['pid'], 'start_ticks': str(run['process_started_ticks']), 'boot_id': run['boot_id']})
