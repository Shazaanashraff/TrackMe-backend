# Adding a feature — backend

The one loop for shipping an endpoint or behaviour change. It exists so every change lands with
a doc, tests (**including authz failures**), and a change-log entry.

> This service is a contract for three clients. Read §4 before you change any response shape.

---

## 0. Orient

- Find the module via [`CLAUDE.md`](../../CLAUDE.md) → "Where to look". New module? Copy
  [`_MODULE_TEMPLATE.md`](_MODULE_TEMPLATE.md) → `docs/modules/<NAME>.md` and fill §1–4 as a design
  sketch first.
- Read its **API surface**, **Authorization**, and **Change protocol** sections.
- Baseline green: `npm test && npm run test:integration`.

## 1. Build in the standard direction

**route → middleware → controller → model.**

| Layer | Where | Rule |
|---|---|---|
| Route | `src/routes/*Routes.js` | Path + middleware + controller fn. **No business logic.** Declare literal paths *above* `/:param` routes. |
| Validation | `src/middleware/validators.js` | One validator per endpoint, then `handleValidationErrors`. Never trust the client. |
| Guard | `src/middleware/auth.js` | `protect` + the right `requireRoles` wrapper. A role check is not ownership — scope manager queries to `req.user._id`. |
| Controller | `src/controllers/*Controller.js` | Orchestration + explicit status codes. |
| Model | `src/models/*.js` | Schema + **indexes that enforce invariants** (uniqueness beats controller checks under concurrency). |
| Utils | `src/utils/*.js` | Pure helpers. Crypto/geo logic belongs here, not in a controller. |
| Realtime | `src/socket/socketHandler.js` | Emit via `req.app.get('io')`; never import `io` directly. |

## 2. Test every changed behaviour

Follow [`ADDING_A_TEST.md`](ADDING_A_TEST.md). Minimum for a new endpoint:
- happy path,
- each distinct failure status (400 / 401 / 403 / 404 / 409 / 429),
- **the authorization failure** — wrong role *and* right role/wrong owner,
- any concurrency invariant (duplicate submit, retry).

Add the row in [`../TESTING_GUIDE.md`](../TESTING_GUIDE.md).

## 3. Update the docs

- The module doc: API surface, data model, side effects, gotchas, **Status**.
- Cross-cutting assumption changed? Update it, per [`../QA_UPDATE_TRIGGERS.md`](../QA_UPDATE_TRIGGERS.md).
- New module? Add it to [`CLAUDE.md`](../../CLAUDE.md) and [`../README.md`](../README.md).

## 4. Contract changes are cross-repo

If a response shape, status code, field name, or socket payload changed:
- Update the consuming app's module doc (`user-app`, `driver-app`, `web-admin`) **in the same
  change**, and say so in the `CHANGES.md` entry.
- Prefer **additive** changes. Old mobile builds stay in the field and are not force-updated —
  removing or renaming a field breaks users who haven't updated.

## 5. Green gate + log + push

```bash
npm test
npm run test:integration
```
- Append a [`../CHANGES.md`](../CHANGES.md) entry.
- Push. The pre-push check ([`../../scripts/check-docs.mjs`](../../scripts/check-docs.mjs)) warns
  if `src/` changed without a `CHANGES.md` entry or the touched module's doc.

---

### Definition of done
- [ ] route → middleware → controller → model; no logic in routes.
- [ ] Validation + the correct guard, with ownership scoping where relevant.
- [ ] Invariants enforced by an index, not just controller code.
- [ ] Tests incl. authz failures and every distinct status code; green.
- [ ] `TESTING_GUIDE.md` row added.
- [ ] Module doc updated (or created) incl. Status.
- [ ] Consuming app docs updated if a contract moved.
- [ ] `CHANGES.md` entry appended.
