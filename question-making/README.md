# Question sets

This directory holds the code that turns a question catalog written by authors into the files a run reads. The FABench questions themselves are in the dataset, and [reproduction](../docs/reproduction.md) converts them with `tools/from-dataset.py`.

## Export a catalog

```bash
python3 question-making/export.py --author /path/to/questions_author.json --out /path/to/exported --prefix my-set
```

The export writes three files. `my-set-model-test.jsonl` is what the model sees, including the rendered prompt. `my-set-grading-key.jsonl` holds the outcomes and is never shown to the model. `export_manifest.json` records what was exported. Only questions marked usable are exported. The exporter checks that ids are unique, that all questions share one forecast date and that prediction cutoffs are valid. It also checks that every prompt contains the question, the target period and the resolution criteria. `--check-prompts FILE` and `--check-grades FILE` compare the output with files you reviewed earlier.

`exporting/records.py` maps the fields, `exporting/catalog.py` validates the catalog and `exporting/files.py` writes the files. `july-0917/scripts/export_platform_files.py` runs the same export with the file prefix of the July 2026 set.

To run an exported set, pass `--preset custom --questions-file ... --grading-file ...` (see [reproduction](../docs/reproduction.md)). Every run records an id for the question set, which includes a hash of both files.
