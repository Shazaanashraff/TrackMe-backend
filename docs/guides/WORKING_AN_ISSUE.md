# Working a GitHub issue — backend

How a filed issue becomes a merged change, whether it's picked up by a scheduled/routine agent
or a manual "finish up #N" Claude Code session. **Same gate either way** — automation doesn't
skip the regression check, it just runs it unattended.

Issues live on [`Shazaanashraff/TrackMe-backend`](https://github.com/Shazaanashraff/TrackMe-backend)
(not the umbrella `LiveTrack` repo — that repo has no `src/` to run tests against). New issue →
use the **Task / Issue** form (`.github/ISSUE_TEMPLATE/task.yml`), which asks for Summary,
Acceptance criteria, and Regression tests required up front.

---

## 1. Pick it up

```bash
gh issue view <N> --repo Shazaanashraff/TrackMe-backend
```

Read Summary + Acceptance criteria + Regression tests required. If any of the three is missing
or too vague to act on, say so on the issue and ask rather than guessing scope — this applies to
agents too; a routine that can't determine scope should comment and stop, not improvise.

```bash
git checkout main && git pull
git checkout -b issue/<N>-<slug>
```

Find the owning module via [`../../CLAUDE.md`](../../CLAUDE.md) → "Where to look".

## 2. Build it

The actual change loop — layering, tests-as-you-go, module doc updates — is
[`ADDING_A_FEATURE.md`](ADDING_A_FEATURE.md). This doc is only the wrapper around it that's
specific to issues.

## 3. Regression gate — must be green before a PR opens

```bash
npm test                  # node --test smoke suite
npm run test:integration  # jest integration suite
```

- Run every command listed in the issue's "Regression tests required" checklist.
- That checklist is a **floor, not a ceiling** — if the change touches something it didn't
  anticipate (a new authz branch, an index invariant), add the test per
  [`ADDING_A_TEST.md`](ADDING_A_TEST.md) and run it too.
- A response shape, status code, or socket payload changed → also confirm the consuming app
  (`user-app` / `driver-app` / `web-admin`) doc was updated, per §4 of `ADDING_A_FEATURE.md`.
- Can't get a listed check green and the fix is genuinely out of scope for this issue? Say so in
  the PR body — don't merge around a red check or quietly drop it from the list.

## 4. Open the PR

```bash
gh pr create --title "<type>(<scope>): <summary>" --body "Closes #<N>

## Regression tests
- [x] npm test
- [x] npm run test:integration
- [x] <anything else the issue or ADDING_A_TEST.md called for>
"
```

`Closes #<N>` is required in the body — merging the PR then auto-closes the issue. The body must
restate the regression checklist with boxes actually checked, not a bare "tests pass".

## 5. Merge to main

- `.github/workflows/ci.yml` must be green on the PR itself — a green local run is not a
  substitute for CI.
- `gh pr merge <N> --squash --delete-branch`
- Append the [`../CHANGES.md`](../CHANGES.md) entry, referencing the issue number, before/with the
  merge — same gate as any other push.
- If the umbrella repo's submodule pointer needs updating, do that as a follow-up commit in
  `LiveTrack`, not inside this PR.

---

## Agents / routines

- A scheduled or routine agent follows this doc exactly like a manual session. The regression
  gate is not optional because no one is watching it run.
- If a routine can't get the gate green, it **leaves the PR open** (does not merge) and comments
  on the issue with what failed and why — never merge red to keep a routine's success rate up.
- A manual "finish up issue #N" session starts at step 1 (re-read the issue) even if a branch with
  code already exists — don't assume a prior session's checklist was actually run to completion.

## Definition of done

- [ ] Branch `issue/<N>-<slug>`.
- [ ] Change follows [`ADDING_A_FEATURE.md`](ADDING_A_FEATURE.md).
- [ ] Every regression test in the issue's checklist ran green, plus anything
      [`ADDING_A_TEST.md`](ADDING_A_TEST.md) called for on top of it.
- [ ] Cross-repo contract changes reflected in the consuming app's module doc.
- [ ] PR body has `Closes #<N>` and the checked-off regression list.
- [ ] CI green on the PR.
- [ ] [`../CHANGES.md`](../CHANGES.md) entry appended.
- [ ] Merged (squash) to `main`, issue auto-closed, branch deleted.
