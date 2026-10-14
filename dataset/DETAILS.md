# FABench dataset details

This file defines the columns of each table and describes how the news archive was built and checked. The dataset card (`README.md`) gives the overview.

## 1. Questions

`questions/july-2026-07-01/questions.parquet` has one row per question. The 287 questions consist of 254 written by our question-writing agents (`subset = sept-17-254`) and 33 taken from Polymarket (`subset = poly-new-33`). English text is authoritative; the Chinese question text is a translation.

| Column | Meaning |
| --- | --- |
| `question_id` | Question id, for example `J-FIN-M01` or `POLY-…` |
| `anchor`, `as_of_utc`, `information_cutoff_utc` | The forecast date, 2026-07-01T00:00:00Z. Agents may use only information from before it |
| `subset`, `question_pool` | The question set and the topic pool the question was drawn from |
| `question_en`, `question_zh` | Question text in English and its Chinese translation |
| `background_en`, `resolution_criteria_en`, `target_period_en` | Background, resolution criteria and the period the question is about |
| `prediction_cutoff_utc`, `prediction_cutoff_role` | The deadline the forecast refers to, and what it marks (for example `event_deadline` or `observation_end`) |
| `category`, `subcategory`, `paper_domain` | Topic labels; `paper_domain` is one of the nine domains in which results are reported |
| `question_type` | `event_only` for a yes-or-no event, `natural_numeric` for a quantity compared with a threshold |
| `threshold_operator`, `threshold_value`, `threshold_unit`, `numeric_target_unit` | The threshold of a numeric question and the unit of the quantity |
| `resolution_result`, `resolution_date` | The outcome (1 for Yes, 0 for No) and the date it was determined |
| `numeric_result` | The realized value of a numeric question. Empty when withheld |
| `numeric_result_withheld`, `numeric_result_withheld_reason` | True for the 18 questions whose value is third-party market data, with the source of the restriction |
| `numeric_result_json`, `threshold_value_json` | The realized value and the threshold as originally recorded, in JSON; the value may carry its unit. `numeric_result` and `threshold_value` hold the same numbers as floats |
| `resolution_source_urls` | Where the outcome can be checked |
| `source_origin`, `source_platform`, `source_url`, `source_market_id` | Where the question came from: our own writing, Polymarket or ForecastBench |
| `forecastbench_id`, `forecastbench_source` | The ForecastBench question id and its data source, for questions adapted from ForecastBench |
| `linked_market_id`, `linked_market_url`, `linked_market_match` | The Polymarket market linked to a question we wrote, and whether it asks about the same event (`same_event`) or the exact same question (`exact`) |
| `text_license`, `attribution` | The license of the question text and the credit it requires (see `LICENSE.md`) |
| `selection_reviewer_ids` | Anonymous ids of the people who reviewed the question during selection |
| `threshold_revised_after_outcome` | True for the 17 finance questions whose threshold we revised after the outcome was known |
| `model_prompt`, `response_format` | The exact prompt the agent received and the answer format it had to follow |
| `canary` | The canary GUID |

The 54 questions linked to Polymarket are the 33 Polymarket questions and the 21 questions with a `linked_market_id`. `market/july-2026-07-01/polymarket_prices.parquet` gives the market price that the leaderboard compares agents with: for each of these questions, the last Yes price of the market before the forecast date (55 or 56 seconds before it), read from Polymarket's public price history. `match_classification` is `native_market_question` for the 33 Polymarket questions and the value of `linked_market_match` for the other 21.

## 2. News archive

**Source.** The articles come from the 4,663 Common Crawl CC-News files in WARC (web archive) format from September 2025 through June 2026, listed in `corpus/manifest/warc-shards.parquet`.

**Extraction** (`tools/cc-news-to-jsonl.py` in the code repository). For each WARC response record with an HTML content type, the title is the HTML `<title>` and the body is the plain text of the main content, extracted with Resiliparse. A record is kept when its body has at least 200 characters and fastText `lid.176` labels its first 1,000 characters as English with probability at least 0.5. The characters U+2028 and U+2029 are replaced with spaces.

**Ingest** (`src/corpus/ingest-ccnews.ts`). Articles from 14 template and catalogue hosts are dropped, such as currency converters, directories of stock photos and salaries, and generated stock pages. Government, education and intergovernmental hosts (`.gov`, `.edu`, `.int`) are always kept. URLs are not de-duplicated, so a page crawled twice appears as two articles. `doc_id` follows the ingest order, which is not chronological.

**Which articles belong to a forecast date.** An article belongs to the archive of a forecast date if its capture time (`acquired_at`, the WARC-Date, to the second) is strictly earlier than that date. Publication dates are not used, and no article was captured exactly at the forecast date. Capture starts at 2025-09-01T00:45:01Z. The last June WARC file runs past midnight, and its 4,589 records captured after the forecast date are excluded. This is why the largest `doc_id` in the July archive is 20,076,315.

| Column | Meaning |
| --- | --- |
| `doc_id` | Article id, as used in search results and in the search index |
| `url`, `domain` | The WARC target URL and its lower-cased host |
| `title`, `body` | The extracted title and the exact text that is indexed and returned |
| `acquired_at`, `crawl_date` | The capture time (UTC timestamp) and the WARC-Date string as stored |
| `wire` | The wire service named in the first 1,500 characters (`AP`, `Reuters`, `AFP` or `NPR`), or empty |
| `source` | Always `ccnews` |
| `warc_file`, `warc_extract_index` | The Common Crawl path of the WARC file, and the position of the article among the extractor's output lines for that file |
| `body_bytes`, `body_sha256` | Length in UTF-8 bytes and SHA-256 of `body` |
| `capture_sha256` | SHA-256 of `JSON.stringify([url, title, body, crawl_date])`. The search index stores this hash and checks it on every read |
| `part` | In the manifests only: the corpus file that holds the article |

**Checks** (`corpus/verification-20261008.json`). The July manifest matches the July search index of the leaderboard runs row by row in article ids and capture hashes, and both give the fingerprint `195e0abc…c3ff`. For 10,000 random articles, the text and hashes equal what the retrieval code returns. Every article in the corpus database equals its line in the extractor's output; this check covered the whole database, including captures after the forecast date that are not released here.

**Using the archive.** In the code repository, `tools/corpus-from-parquet.py` loads the files into a corpus database and checks both hashes of every article, and `build-frozen-index.ts` builds the search index for a forecast date. The reproduction guide gives the commands.

**Rebuilding it from Common Crawl.**

1. Download each `warc_file` listed in `warc_shards` from `https://data.commoncrawl.org/<warc_file>`.
2. Run `tools/cc-news-to-jsonl.py` with fastwarc 1.0.9, resiliparse 1.0.9, fasttext-wheel 0.9.2, numpy 1.26.4, `lid.176.bin` (SHA-256 `7e69ec5451bc261cc7844e49e4792a85d7f09c06789ec800fc4a44aec362764e`) and `--min-chars 200`. Line k of the output for a WARC file corresponds to the article with that `warc_file` and `warc_extract_index = k`; `extract_file_sha256` in `warc_shards` is the hash of our output for the file.
3. Join on `warc_file` and `warc_extract_index`, confirm `url` and `crawl_date`, take `doc_id` from the manifest and check `body_sha256`. The dropped hosts are absent from the manifest, so no further filtering is needed.
4. Keep the articles captured before the forecast date and build the index. The hash it stores for each article must equal `capture_sha256`.

Running step 2 again on three WARC files from September 2025, November 2025 and June 2026 (14,968 records) reproduced our extractor output byte for byte. Other library versions may keep or drop borderline records, which shifts `warc_extract_index`. Joining on `warc_file`, `url` and `crawl_date` and checking `body_sha256` detects such shifts.

## 3. Wikipedia revisions

`corpus/wiki/july-2026-07-01-684.parquet` lists the 684 pages that the leaderboard runs searched in the archive and full settings. `july-2026-07-01-884.parquet` adds 200 pages about entities named in the questions; one later run used it.

| Column | Meaning |
| --- | --- |
| `title`, `requested_title`, `page_id` | The page title as Wikipedia returns it, the title that was requested, and the page id |
| `rev_id`, `parent_rev_id`, `rev_timestamp` | The pinned revision, its parent and its time, which is always before the forecast date |
| `permanent_url` | `https://en.wikipedia.org/w/index.php?oldid=<rev_id>` |
| `rev_sha1`, `content_sha256` | MediaWiki's SHA-1 of the revision content and the SHA-256 of the wikitext that was indexed |
| `fetched_at` | When the revision was fetched |
| `in_684` | In the 884-page list: whether the page is also in the 684-page list |

The code repository's `tools/from-dataset.py wiki-plan` and `wiki-check` fetch these revisions into a local cache and confirm that each one matches its hash.
