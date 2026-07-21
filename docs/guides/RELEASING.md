# Releasing — backend

The backend does **not** ship a versioned artifact the way the mobile apps do. It deploys.

| Path | Use when | Mechanism |
|---|---|---|
| **Auto-deploy** | any merge to `main` | Render `autoDeploy: true` → `npm install` → `npm start` |
| **Git tag** | a meaningful API version | annotated `v<version>` on the backend repo |
| **Migration** | schema/data change | a script under `scripts/`, run explicitly (never automatic) |

Deploy config lives in [`render.yaml`](../../render.yaml): service `bus-tracking-backend`,
health check `GET /health` every 30 s (timeout 15 s, sized for cold-start DB connect).
Environment/setup: [`SETUP.md`](../../SETUP.md).

---

## Release gates

```bash
npm test                  # node --test smoke suite
npm run test:integration  # jest (serial, maxWorkers:1, shared Mongo)
```
- [ ] Both green.
- [ ] [`CHANGES.md`](../CHANGES.md) has entries since the last tag.
- [ ] Every touched module's [`modules/*.md`](../modules/) doc + [`TESTING_GUIDE.md`](../TESTING_GUIDE.md) updated.
- [ ] **Any changed contract is reflected in the consuming app's module doc** (user-app /
      driver-app / web-admin). A backend release can break three clients at once — this is the
      gate that catches it.
- [ ] New/changed env vars are set in the Render dashboard **before** the deploy, and recorded in
      `SETUP.md`. `render.yaml` intentionally holds no secrets.
- [ ] Any required migration is written, tested, and has a rollback note.

## Step-by-step

1. **Contracts** — if a response shape, status code, or socket payload changed, update the
   consuming apps' docs and confirm those clients tolerate it. Prefer additive changes; the mobile
   apps are not force-updated and old versions stay in the field.
2. **Migration first** — run it against staging, verify, then production. Backfills that a new code
   path depends on must land **before** the deploy that needs them.
3. **Merge to `main`** — Render auto-deploys. Watch the health check go green.
4. **Tag** (for a meaningful API version):
   ```bash
   git tag -a v<version> -m "backend v<version>"
   git push origin v<version>
   ```
5. **Record** — roll `CHANGES.md` entries into [`CHANGELOG.md`](../../CHANGELOG.md); sync the
   submodule pointer in the umbrella repo.

---

## Notes
- **Rollback** = redeploy the previous commit on Render. A migration is *not* rolled back by
  redeploying — write the reverse script if the change isn't backward-compatible.
- **Cold start:** the free tier spins down after ~15 min idle; the health check and an external
  uptime pinger keep it warm. A slow first request is expected, not a bug.
- **Never commit secrets.** `JWT_SECRET`, `MONGODB_URI`, `CLIENT_ORIGINS` and the room-key
  encryption key/pepper are dashboard-only. Rotating the room-key key invalidates existing private
  route keys — see [`modules/PRIVATE_ROUTES.md`](../modules/PRIVATE_ROUTES.md) §8.
