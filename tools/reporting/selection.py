"""Answer selection shared by historical reports and the pinned paper loader.

Sources are ordered by priority; selection never uses prediction quality.
"""
MODEL_ALIASES = {
    'deepseek:deepseek-flash': 'DeepSeek Flash',
    'bailian:qwen3.6-35b-a3b': 'Qwen 3.6 · 35B A3B',
    'bailian:qwen3.8-27b': 'Qwen 3.8 · 27B',
    'glm:glm-5.3': 'GLM 5.3',
    'kimi:k3': 'Kimi K3',
    'codex:gpt-6-astra': 'GPT-6 Astra',
    'claude:claude-opus-5': 'Claude Opus 5',
    'claude:claude-opus-5-5': 'Claude Opus 5.5',
    'openrouter:anthropic/claude-opus-5': 'Claude Opus 5',
    'jev:jev-1.13.0': 'JEV 1.13.0',
    'codex:gpt-5.6-sol': 'GPT-5.6 Sol',
    'codex:gpt-6-sol': 'GPT-6 Sol',
    'codex-personal:gpt-5.6-sol': 'GPT-5.6 Sol',
}
PAPER_FALLBACKS = {
    'Kimi K3': 'openrouter:moonshotai/kimi-k3',
    'Qwen 3.8 · 27B': 'openrouter:qwen/qwen3.8-27b',
    'Qwen 3.6 · 35B A3B': 'openrouter:qwen/qwen3.6-35b-a3b',
}


def ordered_runs(runs):
    """Original strict answers precede postprocess; earliest run breaks ties."""
    return sorted(runs, key=lambda run: (
        run['config'].get('execution_mode') == 'postprocess',
        run.get('started_at_utc') or '', run['run_id']))


def select_answers_by_priority(sources, question_ids=None):
    """Prefer the first source; preserve the entire selected provenance record.

    A null answer in a preferred source stays missing, matching the paper's
    established rule. Callers omit invalid candidates before ordering sources.
    """
    selected = {}
    for source in reversed(sources):
        selected.update({answer['question_id']: answer for answer in source})
    return {qid: answer for qid, answer in selected.items()
            if (question_ids is None or qid in question_ids) and answer.get('probability') is not None}


def paper_answers(rows, model, arm, question_ids, grades):
    sources = [rows.get((model, arm), {}).get('answers', [])]
    fallback = PAPER_FALLBACKS.get(model)
    if fallback:
        sources.append(rows.get((fallback, arm), {}).get('answers', []))
    selected = select_answers_by_priority(sources, question_ids)
    for qid, answer in selected.items():
        if answer['outcome'] != grades[qid]:
            raise ValueError(f'Grading mismatch: {model}/{arm}/{qid}')
    return selected
