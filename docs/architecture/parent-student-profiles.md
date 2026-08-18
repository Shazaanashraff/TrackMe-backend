# Account and rider profiles

Status: implemented 2026-08-13

## Decision

TrackMe treats authentication and ridership as separate concerns. A `User` is the account holder that owns the login, email, phone, refresh tokens, devices, and push tokens. A `RiderProfile` is a person managed by that account. The profile is neutral until an enrollment supplies organization context.

The mobile app stores one `activeRiderId`. Changing it is a local selection, not an authentication event. Every rider-specific request carries that identifier, and the backend verifies ownership.

## Data model

- `RiderProfile`: independent rider code, name, optional contact override, default household places, QR version, active state, and the `category` (`SCHOOL`, `UNIVERSITY`, `OFFICE`) with its `details` map answered at account creation. It uses the existing `studentprofiles` collection for compatibility.
- `StudentOrganizationProfile`: organization-specific field values and schema version for one student.
- `HouseholdPlace`: reusable pickup/drop-off place owned by the parent account.
- `DriverEnrollment`: points to `studentId`, with independent shuttle status, organization details, and locations.
- `BoardingEvent` and student notifications: point to `studentId` so attendance and alerts never bleed between siblings.

## Enrollment flow

0. At registration the rider picks a category and answers what it asks for (a school's grade). It seeds their own rider row and is stored under the enrollment catalog's own field keys, which is what lets it prefill step 4. It is a claim, not an authority: `riderTag` stays derived from the enrolled driver's organization, and the two may disagree.
1. The account holder selects or creates a rider.
2. The app resolves the driver key with that `riderId`.
3. The backend returns the driver's organization and its configured standard fields.
4. The app renders only enabled fields and prefills them from the rider's signup answers overlaid by any values already saved for that organization, which win. Every enabled field is still shown and editable.
5. The backend derives Student, Employee, or Passenger from the resolved service type and validates before creating that rider's enrollment.

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
