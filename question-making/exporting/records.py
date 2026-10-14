"""Project author records into the model and grading data contracts."""


def model_row(question, asof, unit):
    timing = question['timing']
    return dict(
        id=question['id'], question_en=question['question_en'], question_zh=question['question_zh'],
        as_of_date=asof, prediction_cutoff_utc=timing['prediction_cutoff_utc'],
        prediction_cutoff_role=timing['prediction_cutoff_role'], target_period_en=timing['target_period_en'],
        resolution_criteria=question['resolution_criteria_en'], source_feed=question['category']['id'],
        response_format='raven.forecast.v2.1', numeric_target_unit=unit,
        prompt=question['model_input_en'], data_contract='raven.question.v3', cut_off_time=asof,
    )


def grading_row(question, numeric_result):
    return dict(id=question['id'], resolution_date=question['resolution_date'],
                resolution_result=question['resolution_result'], numeric_result=numeric_result)
