# Parent account and student profiles

Status: implemented 2026-08-13

## Decision

TrackMe treats authentication and ridership as separate concerns. A `User` is the parent or guardian account that owns the login, email, phone, refresh tokens, devices, and push tokens. A `StudentProfile` is a rider managed by that account.

The mobile app stores one `activeStudentId`. Changing it is a local selection, not an authentication event. Every student-specific request carries that identifier, and the backend verifies that the authenticated account owns it.

## Data model

- `StudentProfile`: independent rider code, name, optional phone override, default household places, QR version, and active state.
- `StudentOrganizationProfile`: organization-specific field values and schema version for one student.
- `HouseholdPlace`: reusable pickup/drop-off place owned by the parent account.
- `DriverEnrollment`: points to `studentId`, with independent shuttle status, organization details, and locations.
- `BoardingEvent` and student notifications: point to `studentId` so attendance and alerts never bleed between siblings.

## Enrollment flow

1. The parent selects or creates a student.
2. The app resolves the driver key with that `studentId`.
3. The backend returns the driver's organization and its configured standard fields.
4. The app renders only enabled fields, prefills saved organization values, and validates required fields.
5. The backend checks schema version, ownership, phone, locations, and organization responses before creating that student's enrollment.

Managers configure their own organization's form. Superadmins can override any organization. Schema changes mark incomplete existing organization profiles as `needsUpdate`; existing shuttle access remains active.

## Compatibility and migration

`npm run migrate:students` is dry-run by default. `npm run migrate:students -- --apply` creates one first student for every existing passenger, preserving the legacy user ObjectId so existing attendance references and QR identities remain resolvable. `--verify` reports remaining legacy enrollment references.

The backend temporarily keeps `/api/enrollments/redeem` for older app builds. It assigns the account's first migrated student and does not enforce newly introduced organization fields. New builds use resolve + student enrollment endpoints.

## Security invariants

- A parent cannot read or mutate another account's students or places.
- A driver can record attendance only for an actively enrolled student assigned to that driver.
- Managers see only enrollments belonging to their drivers.
- Organization response keys must come from the service-type catalog; unknown fields are rejected.
- Switching students never rotates or replaces authentication credentials.
