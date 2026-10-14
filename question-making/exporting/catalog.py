"""Export an author catalog, keeping rendered prompts and answers in separate files."""
import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .files import file_sha256, write_json, write_jsonl
from .records import grading_row, model_row

EXACT_SECOND = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')


def parse_utc(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def export_catalog(author, out, check_prompts=None, check_grades=None, prefix='raven'):
    catalog = json.loads(Path(author).read_text())
    asof = catalog['information_as_of_utc']
    assert EXACT_SECOND.match(asof), asof
    questions = catalog['questions']
    assert len({q['id'] for q in questions}) == len(questions)
    models, grades, wrapped, untemplated = [], [], [], []
    for q in questions:
        assert q['active'] == (q['admission']['status'] == 'usable'), q['id']
        if not q['active']:
            continue
        t = q['timing']
        assert q['cut_off_time'] == t['forecast_as_of_utc'] == asof, q['id']
        params = q.get('prompt_parameters')
        if params is None:
            # Replacement rows carry only the rendered prompt; check its key lines instead.
            untemplated.append(q['id'])
            assert q['question_en'] in q['model_input_en'], q['id']
            assert 'Target period: ' + t['target_period_en'] in q['model_input_en'], q['id']
            assert q['resolution_criteria_en'] in q['model_input_en'], q['id']
        else:
            assert params['as_of_date'] == asof, q['id']
            assert params['prediction_cutoff_utc'] == t['prediction_cutoff_utc'], q['id']
            assert params['question_en'] == q['question_en'], q['id']
            assert params['target_period_en'] == t['target_period_en'], q['id']
            assert params['resolution_criteria_en'] == q['resolution_criteria_en'], q['id']
            assert catalog['prompt_templates']['template_en'].format(**params) == q['model_input_en'], q['id']
        prompt = q['model_input_en']
        assert prompt.count('Information as-of date (UTC): ' + asof) == 1, q['id']
        assert prompt.count('Prediction cutoff (UTC): ' + t['prediction_cutoff_utc']) == 1, q['id']
        assert parse_utc(t['prediction_cutoff_utc']) > parse_utc(asof), q['id']
        assert parse_utc(q['resolution_date']) > parse_utc(asof), q['id']
        assert q['resolution_result'] in (0, 1), q['id']
        unit = (q['prediction_spec'].get('numeric_target') or {}).get('unit')
        num = q['numeric_result']
        if unit:
            if isinstance(num, (int, float)) and not isinstance(num, bool):
                num = {'value': num, 'unit': unit}
                wrapped.append(q['id'])
            assert isinstance(num, dict) and set(num) == {'value', 'unit'}, q['id']
            assert type(num['value']) in (int, float) and math.isfinite(num['value']), q['id']
            assert num['unit'] == unit, q['id']
        else:
            assert num is None, q['id']
        models.append(model_row(q, asof, unit))
        grades.append(grading_row(q, num))
    if check_prompts:
        draft = {r['id']: r['prompt'] for r in map(json.loads, Path(check_prompts).read_text().splitlines()) if r}
        assert draft == {m['id']: m['prompt'] for m in models}, 'model prompts differ from the published draft'
    if check_grades:
        draft = {r['id']: r for r in map(json.loads, Path(check_grades).read_text().splitlines()) if r}
        assert set(draft) == {g['id'] for g in grades}, 'grading IDs differ from the published draft'
        for g in grades:
            d = draft[g['id']]
            assert (d['resolution_result'], d['resolution_date']) == (g['resolution_result'], g['resolution_date']), g['id']
            expected = d['numeric_result']
            if isinstance(expected, (int, float)) and not isinstance(expected, bool):
                expected = {'value': expected, 'unit': g['numeric_result']['unit']}
            assert expected == g['numeric_result'], g['id']
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    files = {f'{prefix}-model-test.jsonl': models, f'{prefix}-grading-key.jsonl': grades}
    for name, rows in files.items():
        write_jsonl(out / name, rows)
    stats = dict(
        source_author_file=str(Path(author).resolve()),
        source_author_sha256=file_sha256(author),
        question_version=catalog['question_version'], release_status=catalog['release_status'],
        information_as_of_utc=asof, usable_questions=len(models),
        numeric_questions=sum(g['numeric_result'] is not None for g in grades),
        event_only_questions=sum(g['numeric_result'] is None for g in grades),
        yes=sum(g['resolution_result'] for g in grades), no=sum(1 - g['resolution_result'] for g in grades),
        categories=dict(sorted(Counter(m['source_feed'] for m in models).items())),
        scalar_numeric_results_wrapped=wrapped,
        prompts_without_template_parameters=untemplated,
        files={name: file_sha256(out / name) for name in files},
    )
    write_json(out / 'export_manifest.json', stats)
    return stats


