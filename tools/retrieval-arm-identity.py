"""Presentation/continuation aliasing, gated by the immutable retrieval policy."""
BOTH_POLICY = {'version': 'mixed-half-prefix-v1', 'frozen': 'ceil(n/2)',
               'web_candidates': 'floor(n/2)', 'selection': 'rank-before-review',
               'refill': False, 'order': 'frozen-then-web',
               'cross_source_deduplication': 'exact-url-frozen-first', 'review': 'web-only'}


def recorded_arm(arm, conditions, condition_id=None):
    if arm not in ('both', 'mixed'):
        return arm
    matches = [c for c in conditions if c.get('arm') == arm and
               (condition_id is None or c.get('condition_id') == condition_id)]
    if matches and all(c.get('retrieval_mixed_policy') == BOTH_POLICY for c in matches):
        return 'both'
    # An old n+n merge must never satisfy or score a half-prefix experiment.
    return 'both-legacy' if arm == 'both' else 'mixed-unknown'
