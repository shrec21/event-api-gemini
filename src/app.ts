import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const app = express();
const prisma = new PrismaClient();
app.use(express.json());

const JWT_SECRET = 'study-secret-key';

// Mock Notifier
const Notifier = {
  send: (email: string, msg: string) => console.log(`[MOCK EMAIL to ${email}]: ${msg}`)
};

interface AuthRequest extends Request { user?: { id: number; email: string }; }

const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET) as { id: number; email: string };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ─── B7: In-memory ticket type "catalog cache" ────────────────────────────────
// Simulates a server-side cached catalog of ticket types with prices.
const ticketTypeCache = new Map<number, { id: number; eventId: number; name: string; price: number }>();
let ticketTypeIdCounter = 1;

// ─── B8: Audit log store ─────────────────────────────────────────────────────
// Logs are keyed by a sequential ID and reference their parent event.
const eventLogs = new Map<number, { id: number; eventId: number; action: string; data: unknown; timestamp: Date }>();
let logIdCounter = 1;

function appendLog(eventId: number, action: string, data: unknown) {
  const id = logIdCounter++;
  eventLogs.set(id, { id, eventId, action, data, timestamp: new Date() });
}

// ─── B10: In-memory pending transaction ledger ────────────────────────────────
const pendingTransactions: { transactionId: string; userId: number; eventId: number; amount: number; createdAt: Date }[] = [];

// ─── B11: In-memory event start times (avoids schema migration) ───────────────
// Populated from the optional `startDate` field in POST /events body.
const eventStartTimes = new Map<number, Date>();

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    const user = await prisma.user.create({ data: { email, password: hashedPassword } });
    res.status(201).json({ id: user.id, email: user.email });
  } catch (e) {
    res.status(400).json({ error: 'Email exists' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: jwt.sign({ id: user.id, email: user.email }, JWT_SECRET) });
});

// ─── Events ───────────────────────────────────────────────────────────────────
app.post('/events', authenticate, async (req: AuthRequest, res) => {
  const { title, description, capacity, startDate } = req.body;
  if (capacity <= 0) return res.status(400).json({ error: 'Capacity > 0 required' });
  const event = await prisma.event.create({ data: { title, description, capacity, organizerId: req.user!.id } });
  // Store startDate for B11 deadline checks (kept in memory, not persisted to DB)
  if (startDate) eventStartTimes.set(event.id, new Date(startDate));
  appendLog(event.id, 'EVENT_CREATED', { title, capacity, organizerId: req.user!.id });
  res.status(201).json(event);
});

// B8: Properly secured main event endpoint — checks organizer ownership
app.get('/events/:id', authenticate, async (req: AuthRequest, res) => {
  const event = await prisma.event.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!event) return res.status(404).json({ error: 'Not found' });
  if (event.organizerId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
  res.json(event);
});

// ─── B8 BUG: Insecure Direct Object Reference (IDOR) via Audit Log ────────────
// The main GET /events/:id above correctly checks ownership.
// This sub-resource endpoint only verifies the log exists — it never checks
// whether the requesting user owns the parent event the log belongs to.
// A malicious user can iterate log IDs to read private attendee or revenue data
// from events they do not own.
app.get('/event/logs/:log_id', authenticate, async (req: AuthRequest, res) => {
  const logId = parseInt(req.params.log_id);
  const log = eventLogs.get(logId);
  if (!log) return res.status(404).json({ error: 'Log not found' });
  // BUG: Missing ownership check.
  // Fix would be: const event = await prisma.event.findUnique({ where: { id: log.eventId } });
  //               if (event?.organizerId !== req.user!.id) return res.status(403).json(...);
  res.json(log);
});

app.post('/events/:id/invite', authenticate, async (req: AuthRequest, res) => {
  const event = await prisma.event.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!event || event.organizerId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
  Notifier.send(req.body.email, `Invited to ${event.title}`);
  res.json({ message: 'Sent' });
});

app.get('/events/:id/attendees', authenticate, async (req: AuthRequest, res) => {
  const rsvps = await prisma.rSVP.findMany({ where: { eventId: parseInt(req.params.id) }, include: { user: true }, orderBy: { createdAt: 'asc' } });
  res.json({
    confirmed: rsvps.filter(r => r.status === 'CONFIRMED'),
    waitlisted: rsvps.filter(r => r.status === 'WAITLISTED')
  });
});

// ─── B7: Ticket Type Endpoints ────────────────────────────────────────────────
app.post('/events/:id/ticket-types', authenticate, async (req: AuthRequest, res) => {
  const eventId = parseInt(req.params.id);
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.organizerId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
  const { name, price } = req.body;
  const id = ticketTypeIdCounter++;
  const ticketType = { id, eventId, name, price };
  ticketTypeCache.set(id, ticketType);
  res.status(201).json(ticketType);
});

// B7 BUG: Shared Reference Mutation — mutates the cached object in-place
// The ticketTypeCache holds the single source of truth for each TicketType.
// Instead of returning a discounted copy, this handler writes directly to the
// cached object: ticket.price = ticket.price * 0.9
// Effect: the first caller gets the correct 10% discount; the second caller
// receives 10% off the already-reduced price; every subsequent call decays
// the price further until it approaches zero.
// Fix would be: return { ...ticket, price: ticket.price * 0.9 } without mutation.
app.get('/events/:id/ticket-types/:ticketId/discounted', authenticate, async (req: AuthRequest, res) => {
  const ticketId = parseInt(req.params.ticketId);
  const ticket = ticketTypeCache.get(ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket type not found' });
  // BUG: Mutates the shared cached object instead of producing a derived value
  ticket.price = ticket.price * 0.9;
  res.json(ticket);
});

// ─── B9 BUG: Race Condition — Check-then-Act without atomic transaction ────────
// Steps:
//   1. count = prisma.rSVP.count({ eventId, status: 'CONFIRMED' })
//   2. if (count < capacity) → create RSVP with status CONFIRMED
// The window between step 1 and step 2 is unprotected. Ten concurrent requests
// arriving when only one seat remains will all read count=99 and all proceed
// to create a CONFIRMED RSVP, producing 10 confirmed attendees for a 100-seat event.
// Fix: wrap in a serializable transaction or use a DB-level atomic increment/upsert.
app.post('/events/:id/rsvp', authenticate, async (req: AuthRequest, res) => {
  const eventId = parseInt(req.params.id);
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) return res.status(404).json({ error: 'Not found' });

  // BUG: Non-atomic check — another concurrent request can pass this check
  //      before either request completes the create() below.
  const count = await prisma.rSVP.count({ where: { eventId, status: 'CONFIRMED' } });
  const status = count >= event.capacity ? 'WAITLISTED' : 'CONFIRMED';
  try {
    const rsvp = await prisma.rSVP.create({ data: { eventId, userId: req.user!.id, status } });
    if (status === 'CONFIRMED') Notifier.send(req.user!.email, `RSVP Confirmed for ${event.title}`);
    appendLog(eventId, 'RSVP_CREATED', { userId: req.user!.id, status });
    res.status(201).json(rsvp);
  } catch (e) { res.status(400).json({ error: 'Already RSVPd' }); }
});

// ─── B11 BUG: Timezone / DST Offset — hardcoded 86400 seconds ────────────────
// The cancellation deadline is calculated as: eventStart - 86400 seconds.
// 86400 s = exactly 24 × 3600 s, which is only correct on days without a
// Daylight Saving Time transition.
// On "spring forward" nights (23-hour day) the deadline is 1 hour too late
// — users can cancel after the real cutoff.
// On "fall back" nights (25-hour day) the deadline is 1 hour too early
// — users are incorrectly blocked from cancelling.
// Fix: use a timezone-aware library (e.g., Luxon, date-fns-tz) to subtract
// exactly 1 calendar day in the event's local timezone.
app.delete('/events/:id/rsvp', authenticate, async (req: AuthRequest, res) => {
  const eventId = parseInt(req.params.id);
  const rsvp = await prisma.rSVP.findUnique({ where: { eventId_userId: { eventId, userId: req.user!.id } } });
  if (!rsvp) return res.status(404).json({ error: 'Not found' });

  const eventStart = eventStartTimes.get(eventId);
  if (eventStart) {
    // BUG: Naive UTC arithmetic — ignores DST transitions in the event's local timezone
    const cancellationDeadlineMs = eventStart.getTime() - 86400 * 1000;
    if (Date.now() > cancellationDeadlineMs) {
      return res.status(400).json({ error: 'Cancellation deadline has passed (24h before event)' });
    }
  }

  await prisma.rSVP.delete({ where: { id: rsvp.id } });
  if (rsvp.status === 'CONFIRMED') {
    const next = await prisma.rSVP.findFirst({ where: { eventId, status: 'WAITLISTED' }, orderBy: { createdAt: 'asc' }, include: { user: true, event: true } });
    if (next) {
      await prisma.rSVP.update({ where: { id: next.id }, data: { status: 'CONFIRMED' } });
      Notifier.send(next.user.email, `Promoted from waitlist for ${next.event.title}`);
    }
  }
  res.status(204).send();
});

// ─── B10 BUG: Idempotency — Double-Charge on Retry ───────────────────────────
// A correct implementation would:
//   1. Accept a client-provided idempotency key in the request header.
//   2. Check pendingTransactions for a matching (userId, eventId) pair created
//      within the last 60 seconds and return the existing result if found.
// This implementation skips both steps. Every call — including retries caused by
// network flickers — mints a brand-new transactionId and records a new charge.
// The user is billed once per request, so a single purchase that times out and
// is retried results in two charges.
app.post('/tickets/purchase', authenticate, async (req: AuthRequest, res) => {
  const { eventId, amount } = req.body;
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // BUG: Should check for an existing pending transaction with the same
  //      (userId, eventId) created within the last 60 s before proceeding.
  //      Instead, a new transactionId is generated unconditionally.
  const transactionId = `txn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  pendingTransactions.push({ transactionId, userId: req.user!.id, eventId, amount, createdAt: new Date() });

  res.status(201).json({ message: 'Purchase successful', transactionId, amount });
});

// ─── B12 BUG: Partial Update Wipeout via Spread Operator ─────────────────────
// The intent of PATCH is to update only the fields provided in the request body.
// The spread `{ ...oldEvent, ...req.body }` merges ALL req.body fields into the
// existing record — including fields the client set to null by accident (e.g., a
// frontend serializer that encodes missing optional fields as null instead of
// omitting them).
// Result: PATCH { title: "New Title" } from a buggy client that also serializes
// description: null permanently overwrites the existing description with null.
// Fix: filter req.body to remove null and undefined values before merging:
//   const safe = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v != null));
app.patch('/events/:id', authenticate, async (req: AuthRequest, res) => {
  const eventId = parseInt(req.params.id);
  const oldEvent = await prisma.event.findUnique({ where: { id: eventId } });
  if (!oldEvent) return res.status(404).json({ error: 'Not found' });
  if (oldEvent.organizerId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });

  // BUG: Spread does not filter nulls — a null in req.body overwrites stored data
  const patchData = { ...oldEvent, ...req.body };
  const updatedEvent = await prisma.event.update({
    where: { id: eventId },
    data: {
      title: patchData.title,
      description: patchData.description, // BUG: null if req.body sent description: null
      capacity: patchData.capacity,
    }
  });
  res.json(updatedEvent);
});

export default app;
