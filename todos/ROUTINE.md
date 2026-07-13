# Backend TODO Routine

You are the TODO routine for the **backend** (Express + Mongoose + Socket.IO). Follow this file and
`todos/CLAUDE.md` exactly. Do **ONE** todo this run, then stop. All commands run from `backend/`.

1. **Pre-flight:** `git status` clean and up to date with `origin/main` (`git fetch`; work from
   latest `main`). Dirty tree → **stop and report**.

2. **DEDUP FIRST:**
   - `gh pr list --state open --json number,title,headRefName`
   - `git ls-remote --heads origin 'todo/*'`
   - Any todo with an open PR OR an existing `todo/NNN-slug` origin branch is **IN FLIGHT — skip it.**
     Also skip todos already in `todos/complete/` on main.

3. **Pick:** from `todos/todo-list.md`, the FIRST not-skipped, unchecked, non-blocked row whose
   `Dep` are all `[x]`, by priority then lowest number. None eligible → report and **stop.**

4. **Implement:** branch `todo/NNN-slug` off `main`. Read `todos/active/NNN-slug.md` fully + every
   doc it cites (esp. any `docs/features/*/*.md` plan). Implement its *Step-by-step* exactly; honour
   *Out of scope*. Guardrails (CLAUDE.md): controllers stay thin; models own schema; keep auth +
   socket contracts stable; every contract change gets an integration test + a `docs/TESTING_GUIDE.md`
   row. Never log secrets/tokens.

5. **Blocked by a genuine unknown** (unclear product decision, missing upstream contract): **STOP** —
   write it into the todo's `## Blocked`, commit nothing functional, no PR, report. Don't guess.

6. **Verify** (all green; never weaken a test): `npm test` (smoke) and `npm run test:integration`
   (jest); plus the completion test `bash todos/completion-tests/todo-NNN.sh`.

7. **Close-out ON THE BRANCH:** `git mv todos/active/NNN-slug.md todos/complete/NNN-slug.md`; tick the
   `todo-list.md` row (`[ ]`→`[x]`, add `done: YYYY-MM-DD <sha>`); add the TESTING_GUIDE row(s);
   Conventional Commit `feat(todo-NNN): <summary>`.

8. **Push** `todo/NNN-slug`, open PR `todo-NNN: <slug>` confirming tests + completion green. **Do NOT
   self-merge.**

9. **Stop.** One todo handled. Report the PR link (or blocked / none-eligible reason).
