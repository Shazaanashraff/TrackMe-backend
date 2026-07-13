# backend/todos — Routine Rules

Read with `ROUTINE.md`. Guardrails for any backend todo run.

## Scope discipline
- One todo per run; implement only its *Step-by-step*. Extras → PR-body suggestion or `## Blocked`.

## Architecture guardrails (../CLAUDE.md)
- `src/` layers: `controllers/` (thin request handlers) · `models/` (Mongoose schema + methods) ·
  `routes/` · `middleware/` · `socket/` · `utils/`. Keep controllers thin; put schema/derivations in
  models/utils.
- Preserve existing auth (JWT), refresh, and Socket.IO event contracts. New secrets get their own env
  var — never reuse the auth `JWT_SECRET` for unrelated signing (e.g. QR tokens use a dedicated secret).
- No secrets/tokens in logs.

## Testing policy (../CLAUDE.md "no untested code")
- Any CRUD or websocket change → integration test (jest, `npm run test:integration`).
- Any contract change (endpoint shape, payload, ack) → a new/updated `docs/TESTING_GUIDE.md` row.
- Keep `npm test` (smoke) + `npm run test:integration` green. Never weaken a test to pass a completion
  test.

## Cross-repo features
- When a todo is part of a cross-repo feature, its spec cites the plan under `docs/features/<feature>/`.
  Downstream app todos depend on the backend contract landing first — don't break the documented shape.

## When unsure
- Genuine unknown (product decision, unclear contract) → `## Blocked`, no functional commit, report.

## File map
- `ROUTINE.md` · `CLAUDE.md` · `todo-list.md` · `active/NNN-slug.md` · `complete/NNN-slug.md` ·
  `completion-tests/todo-NNN.sh`.
