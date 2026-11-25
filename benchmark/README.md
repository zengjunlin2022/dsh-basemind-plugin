# Phase 3 A/B benchmark (3C Pilot / 3D full)

Answers one question: **do the plugin's Bootstrap, Skills and CLI surfaces change agent
behaviour and cost, compared with the same plugin exposing only MCP tools?**

Design (plan §14–§20): group **A** = `skills:false`, `bootstrap:false`, `cliTool:false`;
group **B** = defaults. Same commit, same BaseMind 0.34.0 binary, same isolated index, same
model, same prompt, new session per run, interleaved order.

## Layout

| Path | Contents |
| --- | --- |
| `tasks/*.json` | Frozen prompt per task (B1–B6). Change only when a pilot shows the prompt is ambiguous; record the change. |
| `ground-truth/*.json` | Required elements, acceptable alternatives, unacceptable answers. Established with native `git`/`grep`/reading *before* any A/B run. |
| `setup-staged.mjs` | Rebuilds the synthetic B5 repository (`%TEMP%/bm-staged`: three staged defects, one staged non-defect, one unstaged and one untracked distraction). |
| `run.mjs` | Runs one task against an already-running profile instance and stores metrics (usage, tool calls, schema/catalog bytes, duration, final answer). |
| `results/` | Raw per-run JSON + session log paths. **Not committed** (see `.gitignore`). |

## Running

```
node benchmark/setup-staged.mjs
# boot one profile (bm-bench-a = group A, bm-bench-b = group B) and note its log:
dsh bm-bench-b --no-open --port 0 > D:/_bm_phase3/bench/bench-b.log
node benchmark/run.mjs --task B1-java-symbol --log D:/_bm_phase3/bench/bench-b.log   --label B-deepseek --out D:/_bm_phase3/bench/results/B1-B-deepseek.json
```

Both profiles pin `BASEMIND_DATA_HOME`/`BASEMIND_COMMS_DIR` to one throwaway directory, so
every run queries the same index and never touches the user's own BaseMind state.

## Scoring

Rule-based against the ground truth: required elements are matched by file path, line
number (±slack), symbol, commit SHA or statement; group labels are hidden while scoring.
PASS = all required elements, PARTIAL = core elements with a documented gap, FAIL =
missing key elements, wrong file/symbol/commit, fabricated evidence, scope violation or
incomplete run. Every FAIL/PARTIAL is classified per plan §19.4 (A upstream parsing,
B upstream search/index, C plugin routing, D plugin guidance, E model tool choice,
F environment/index).

## Isolation and scope

- Business repositories are read-only; every task says "不要修改任何檔案".
- Only the isolated BaseMind data home is written (`basemind scan` during setup).
- Results keep raw session logs outside the repository; only anonymous summaries are
  committed.
