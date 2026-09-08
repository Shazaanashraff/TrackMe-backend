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
- `GET /api/driver/riders`, `GET /api/driver/absences?date=YYYY-MM-DD`
- `GET|POST /api/driver/announcements`, `GET /api/driver/announcements/:id`, `POST /api/driver/announcements/:id/retry`
- `POST|DELETE /api/notifications/device-token`

Dates are whole Colombo days. New changes accept today through 30 days ahead. Typed text is plain text and limited to 1,000 characters. Presets use server-validated template IDs and parameters; the server generates canonical wording.

## Realtime contract

Authenticated sockets join `account:<accountId>` or `driver:<driverId>`. `communication:event` carries a stable `eventId`, `conversationId`, `riderId`, and optional absence revision. Clients deduplicate event IDs and refetch authoritative state after events and reconnects.

## Client expectations

Audience endpoints represent current ACTIVE enrollments. Clients may preserve a form's rider identity across navigation or profile switching, but must intersect any preselected recipients with the latest audience before review. The server remains authoritative and rechecks enrollment again on write. Clients also distinguish offline-without-cache, stale refresh failures, loading, and genuine empty results rather than presenting each as an empty list.

## Operations

Monitor `CommunicationPushDelivery` records in `failed` state and Announcement recipients in `failed`. The dispatcher runs every three seconds with leases and exponential retry. Expo credentials and receipts must be configured in production; `DeviceNotRegistered` tokens are pruned.
