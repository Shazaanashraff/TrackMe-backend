# Backend QA Update Triggers

Use this checklist to keep docs/TESTING_GUIDE.md in sync with backend changes.

## Update tests and TESTING_GUIDE when:
- Any API route path, method, or response shape changes.
- Validation rules change for any request payload.
- Auth or role gating rules change.
- Socket event names, payloads, or broadcast rules change.
- New environment variables are introduced or renamed.
- Error handling or status codes change.

## Required actions
- Update docs/TESTING_GUIDE.md rows.
- Update tests that cover the changed behavior.
- Update docs/TEST_PLAN_INTEGRATION.md if coverage scope changed.
