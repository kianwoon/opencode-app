# innerText-blob plus count-probe beats selector-guessing on unknown DOM

- **Date**: 2026-09-23T14:02:07+0800
- **Type**: lesson

## What happened

LinkedIn notifications extraction: main li returned empty twice (mainLi=2 of li=10; li innerText tiny — notification cards are not li elements). Two selector guesses wasted two flights. The probe that cracked it returned per-selector counts plus a 600-char innerText sample in one call; the extraction that worked was a whitespace-collapsed main.innerText blob with slice bounds.

## Root cause / fix

On unknown DOM, never guess selectors twice: ONE probe returns querySelectorAll(sel).length per candidate selector + a bounded innerText sample; then extract from the innerText blob (slice bounds), parsing items client-side or in the report. Acceptance gate: extraction returns non-empty on the first blob read, or the probe output names the real container.
