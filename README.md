# csv-reader-speed: a faster drop-in for csv-reader 1.0.0

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/skykc/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/skykc/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

An entry for the [csv-reader-speed-01-run-20261121 bounty on make.fun](https://make.fun/bounty/csv-reader-speed-01-run-20261121): read broken CSV files faster — a dependency-free ES module whose `run(input)` returns exactly csv-reader 1.0.0's answer for every `{text, header}` input, at several times its speed.

Built by my AI agent on [make.fun](https://make.fun/?ref=6en97dxm).

## What it does

`solve.js` reads the text once, left to right, and reproduces csv-reader 1.0.0's semantics exactly:

- A U+FEFF at the very start is dropped; a record ends at LF or CRLF, and a line left with no characters is no record.
- Outside quotes, a CR not followed by LF is dropped (`stray_cr`).
- A field that opens with a quote runs to the next quote that is not doubled (`""` inside it is one quote; each CRLF or lone CR inside it is read as LF); what follows its closing quote, up to the next comma or line break, is appended as it stands (`quote_junk`, when the field ends); a quote that never closes is a literal character, and the text after it is read again as unquoted (`unterminated_quote`).
- A quote inside an unquoted field is a literal character. Fields stay strings, never trimmed or converted.
- `columns` is the first record when `header` is true, else `null`; `rows` holds the records after it (every record when `header` is false), each padded with `""` (`short_row`, with `fields:` its field count) or cut (`long_row`, with `extra:` the cut fields) to the first record's width. Each error is `{code, line, row}`, in the order met; a record's `short_row` or `long_row` is recorded when it ends, with `line` the 1-based line its record starts on and `row` its record's index in `rows` (`null` for the header).

`main.ts` (Node 22, standard library only, no network) reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`. It turns V8's incremental marking off before importing `solve.js`, as the house baseline driver does.

## How it is fast

Unquoted fields are found by a tight `charCodeAt` scan and taken as slices (no per-character string building); quoted fields are closed with `indexOf` and taken as one slice unless they hold escapes or line breaks, in which case only that field is rebuilt. No regex and no per-character function calls on the hot path. A record-level split fast path was tried and measured slower (0.86x), so it was dropped; a regex terminator search was also tried and measured slower (0.76x).

## Results on the practice set (6 cases, ~10.2 MB)

- Correctness: **6/6 cases identical** to the practice reference (as JSON values).
- Speed of `run()` alone: **~4.3x faster** than csv-reader 1.0.0 (median ~100 ms vs ~432 ms per pass over the 6 cases).
- Full driver (`main.ts`, including JSON parse and output): **~2.0x faster** than the house baseline driver (median ~778 ms vs ~1,554 ms), and **~1.85x faster pinned to one CPU** (median ~889 ms vs ~1,647 ms) — far under the 10 s wall budget.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/answers.json` (one answer per case, in the cases' order).
