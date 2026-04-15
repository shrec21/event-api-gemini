# Intentional Bugs B7–B12

Six bugs were added to `src/app.ts` on top of the baseline event management API (B0) for academic analysis.

---

## B7 — Shared Reference Mutation
**Endpoints:** `POST /events/:id/ticket-types`, `GET /events/:id/ticket-types/:ticketId/discounted`

Ticket types are stored in an in-memory `Map` (simulating a server-side cache). The discounted-price endpoint mutates the cached object directly:

```ts
ticket.price = ticket.price * 0.9;
```

Every call permanently reduces the stored price by 10%. The first caller gets the correct discount; subsequent callers get 10% off an already-reduced price, decaying toward zero.

---

## B8 — Insecure Direct Object Reference (IDOR) via Audit Log
**Endpoints:** `GET /events/:id` (secured), `GET /event/logs/:log_id` (insecure)

Actions (event creation, RSVPs) are recorded in an in-memory log store keyed by a sequential integer ID. The main event endpoint correctly checks that the requesting user is the organizer. The log endpoint only checks whether the log ID exists — it never verifies that the user owns the parent event. Any authenticated user can enumerate log IDs to read private data from events they do not own.

---

## B9 — Race Condition: Over-Subscription
**Endpoint:** `POST /events/:id/rsvp`

The RSVP handler uses a check-then-act pattern across two separate database calls:

```ts
const count = await prisma.rSVP.count({ where: { eventId, status: 'CONFIRMED' } });
// --- race window ---
const rsvp = await prisma.rSVP.create({ ... status });
```

Under concurrent load, multiple requests can read the same count before any write lands, allowing more confirmed RSVPs than the event capacity permits.

---

## B10 — Idempotency Failure: Double-Charge on Retry
**Endpoint:** `POST /tickets/purchase`

A new transaction ID is generated on every request:

```ts
const transactionId = `txn_${Date.now()}_${Math.random()...}`;
```

The server never checks for an existing pending transaction with the same `(userId, eventId)` pair. A client retry caused by a network timeout creates a second charge record, billing the user twice for one purchase.

---

## B11 — Timezone / DST Offset in Cancellation Deadline
**Endpoint:** `DELETE /events/:id/rsvp`

The cancellation deadline is computed as:

```ts
const deadlineMs = eventStart.getTime() - 86400 * 1000;
```

`86400 × 1000 ms` equals exactly 24 clock-hours, but a calendar day in a DST-observing timezone is sometimes 23 hours (spring-forward) or 25 hours (fall-back). During spring-forward, users can cancel past the real cutoff; during fall-back, they are incorrectly blocked an hour early. Events can supply a `startDate` in `POST /events` to activate this check.

---

## B12 — Partial Update Wipeout via Spread Operator
**Endpoint:** `PATCH /events/:id`

The handler merges the request body over the existing record using spread:

```ts
const patchData = { ...oldEvent, ...req.body };
```

Fields not included in the request but sent as `null` by a buggy client are not filtered out before the database write. A `PATCH { title: "New Title" }` from a frontend that also serializes `description: null` permanently overwrites the stored description with `null`.
