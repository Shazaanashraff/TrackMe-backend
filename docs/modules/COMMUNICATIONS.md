# Rider–driver communications

## Status

Implemented additively in September 2026. This module owns private rider–driver conversations, dated absences, driver announcements, delivery progress, socket events, and communication push jobs.

## Identity and authorization

- A conversation key is `(RiderProfile._id, Driver._id)`. `RiderProfile.accountId` authorizes passenger access; an ACTIVE `DriverEnrollment` authorizes new writes.
- Former participants can read existing history. Future absence notices are retired when an enrollment ends, and a new enrollment cannot reactivate them.
- Driver audiences come only from ACTIVE enrollments. An announcement freezes its reviewed rider IDs and count, then rechecks the referenced enrollment immediately before delivery.
- All message content is private. An announcement creates one message in each rider's private conversation.

## Data model and recovery

`Communication.js` defines Conversation, Message, Absence, Announcement, and CommunicationPushDelivery. Absence documents have a unique rider/driver/date index, a monotonic revision, acknowledged revision, full history, and embedded pending delivery events. `requestId` plus a payload hash makes a retry idempotent and rejects reuse for another operation. The retrying dispatcher materializes events into messages and notifications without requiring multi-document transactions.

Push acceptance is delivery transport state only. Reads update conversation cursors; absence acknowledgment updates `acknowledgedRevision` only through the explicit acknowledge endpoint. Invalid Expo tokens are removed after ticket or receipt errors.

## API

- `GET|POST /api/conversations`, `GET|POST /api/conversations/:id/messages`, `PUT /api/conversations/:id/read`
- `GET /api/conversations/audience`, `GET /api/conversations/presets`
- `GET|POST /api/absences`, `POST /api/absences/:id/cancel`, `POST /api/absences/:id/acknowledge`
- `GET /api/driver/riders`, `GET /api/driver/riders/:riderId`, `GET /api/driver/riders/:riderId/avatar`, `GET /api/driver/absences?date=YYYY-MM-DD`
- `GET|POST /api/driver/announcements`, `GET /api/driver/announcements/:id`, `POST /api/driver/announcements/:id/retry`
- `POST|DELETE /api/notifications/device-token`

Dates are whole Colombo days. New changes accept today through 30 days ahead. Typed text is plain text and limited to 1,000 characters. Presets use server-validated template IDs and parameters; the server generates canonical wording.

`GET /api/conversations/presets` is the driver's one-tap grid and is deliberately short: `on_my_way` and `delay_10`. A driver mid-route taps rather than browses, so anything less common (a custom delay, an unavailable date, free text) lives a few taps further on under More updates. Delay wording names no cause, because a driver seldom knows why they are behind. The open-ended delay keeps the wire id `traffic` even though its wording no longer says traffic: that id is stored on `Message.templateId` and on queued announcements, so renaming it would strand work already in flight. Retiring a preset id makes the server reject it with 400; stored messages and queued announcements are unaffected because their text is never re-canonicalised.

### The driver's rider directory

`GET /api/driver/riders` is the roster a driver browses, and it is polled every 30 s by a focused client, so it carries only what a row draws: identity, `organization`, `pickup.label`, `category`, `grade`, and the `hasAvatar`/`avatarVersion` pair. `grade` is whitelisted through `SIGNUP_FIELDS` (`utils/enrollmentSchema.js`) rather than exposing `details`, which also holds the organization's own enrolment answers — admission and employee numbers are not the driver's business. A category that is never asked for a grade returns `''`, even if one is stored.

`GET /api/driver/riders/:riderId` is where the contact number lives: `guardianPhoneOverride`, else the account holder's `phoneNumber`, via `effectiveContactPhone` (`utils/riders.js`). It is a separate request precisely because the roster is polled and this is read once, on a tap. **It carries no address at all**, and the roster's `pickup` is populated label-only, so neither draws the street held on `HouseholdPlace`.

Note that absence notices are a separate path and still do carry it: `listAbsences` populates `enrollmentId.pickupPlaceId` with `label address`, and the driver app's `AbsenceCard` renders both. That predates this directory and is unchanged here — worth revisiting if a driver should never see a street address anywhere.

`GET /api/driver/riders/:riderId/avatar` returns the picture alone, so a client can cache it against `avatarVersion` and never refetch an unchanged face. The parent-facing avatar routes (`riderRoutes.js`, `studentRoutes.js`) cannot serve a driver: they are `requireUser` and resolve through household ownership.

All three authorize on the caller's own ACTIVE enrollment (`activeEnrollment`). A rider the driver does not carry — or no longer carries — answers **404, not 403**, so a real rider id cannot be told apart from an invented one.

`hasAvatar` is computed in MongoDB by aggregation rather than by selecting `avatarUrl`. The picture is stored inline as a base64 data URL, so selecting it merely to test emptiness would pull a whole roster of images into application memory twice a minute per focused driver. `profileController.js` keeps images off list responses for the same reason but selects the field, because it reasons about roughly six household members; a driver roster is 20-60.

## Realtime contract

Authenticated sockets join `account:<accountId>` or `driver:<driverId>`. `communication:event` carries a stable `eventId`, `conversationId`, `riderId`, an optional absence revision, and — since 2026-09-10 — `text`/`sender`/`absenceStatus` (mirrors `Message.text`/`sender`/`absenceStatus`, undefined on a bare read-receipt event) so a client can show the real copy (e.g. an absence-acknowledgment banner) without a round-trip fetch of the thread. `queuePush`'s `data` payload carries the same fields. Clients deduplicate event IDs and refetch authoritative state after events and reconnects.

## Client expectations

Audience endpoints represent current ACTIVE enrollments. Clients may preserve a form's rider identity across navigation or profile switching, but must intersect any preselected recipients with the latest audience before review. The server remains authoritative and rechecks enrollment again on write. Clients also distinguish offline-without-cache, stale refresh failures, loading, and genuine empty results rather than presenting each as an empty list.

## Operations

Monitor `CommunicationPushDelivery` records in `failed` state and Announcement recipients in `failed`. The dispatcher runs every three seconds with leases and exponential retry. Expo credentials and receipts must be configured in production; `DeviceNotRegistered` tokens are pruned.
