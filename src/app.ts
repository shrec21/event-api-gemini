import express, { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const app = express();
const prisma = new PrismaClient();
app.use(express.json());

const JWT_SECRET = 'study-secret-key';
const Notifier = { send: (email: string, msg: string) => console.log(`[MOCK EMAIL to ${email}]: ${msg}`) };

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

app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    const user = await prisma.user.create({ data: { email, password: hashedPassword } });
    res.status(201).json({ id: user.id, email: user.email });
  } catch (e) { res.status(400).json({ error: 'Email exists' }); }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: jwt.sign({ id: user.id, email: user.email }, JWT_SECRET) });
});

app.post('/events', authenticate, async (req: AuthRequest, res) => {
  const { slug, title, description, capacity } = req.body;

  // [BUG B6 INJECTED]: Truthy validation rejects 0, and type coercion vulnerability allows negative numeric strings like "-1".
  if (!capacity) return res.status(400).json({ error: 'Missing capacity' });
  if (typeof capacity === 'number' && capacity < 0) return res.status(400).json({ error: 'Capacity must be non-negative' });

  // [BUG B5 Prerequisite]: Check for unique constraint conflicts caused by soft deletes.
  if (slug) {
    const duplicate = await prisma.event.findUnique({ where: { slug } });
    if (duplicate) return res.status(400).json({ error: 'Slug already exists' });
  }

  const event = await prisma.event.create({ 
    data: { slug, title, description, capacity: Number(capacity), organizerId: req.user!.id } 
  });
  res.status(201).json(event);
});

// [BUG B5 INJECTED]: Soft-delete the event. Due to the unique constraint on the slug, the same slug cannot be reused for new events.
app.delete('/events/:id', authenticate, async (req: AuthRequest, res) => {
  const eventId = parseInt(req.params.id);
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event || event.organizerId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });

  await prisma.event.update({ where: { id: eventId }, data: { deletedAt: new Date() } });
  res.status(204).send();
});

app.put('/events/:id', authenticate, async (req: AuthRequest, res) => {
  const eventId = parseInt(req.params.id);
  const event = await prisma.event.findUnique({ where: { id: eventId } });

  // [BUG B2 INJECTED]: Using bitwise OR '|' instead of logical comparison entirely bypasses authorization, allowing any authenticated user to edit.
  if (!event || !(event.organizerId | req.user!.id)) return res.status(403).json({ error: 'Forbidden' });

  const updatedEvent = await prisma.event.update({
    where: { id: eventId },
    data: { title: req.body.title, description: req.body.description, capacity: req.body.capacity }
  });
  res.json(updatedEvent);
});

// [BUG B4 Prerequisite]: Global variable leak.
let leakedRecipientEmail: string; 

app.post('/events/:id/invite', authenticate, async (req: AuthRequest, res) => {
  const event = await prisma.event.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!event || event.organizerId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });

  const emails: string[] = req.body.emails || [req.body.email]; 
  const deliveries: Array<{ to: string; body: string }> = [];

  // [BUG B4 INJECTED]: Loop variable pollution leak causes all notifications to be sent to the last recipient in the array.
  for (const email of emails) {
    leakedRecipientEmail = email;
    deliveries.push({
      to: leakedRecipientEmail,
      body: `Invited to ${event.title}`
    });
  }

  deliveries.map(d => ({ ...d, to: leakedRecipientEmail })).forEach(delivery => {
    Notifier.send(delivery.to, delivery.body);
  });

  res.json({ message: 'Sent' });
});

app.post('/events/:id/rsvp', authenticate, async (req: AuthRequest, res) => {
  const eventId = parseInt(req.params.id);
  const event = await prisma.event.findUnique({ where: { id: eventId }, include: { rsvps: { where: { status: 'CONFIRMED' } } } });
  if (!event) return res.status(404).json({ error: 'Not found' });
  const status = event.rsvps.length >= event.capacity ? 'WAITLISTED' : 'CONFIRMED';
  try {
    const rsvp = await prisma.rSVP.create({ data: { eventId, userId: req.user!.id, status } });
    if (status === 'CONFIRMED') Notifier.send(req.user!.email, `RSVP Confirmed for ${event.title}`);
    res.status(201).json(rsvp);
  } catch (e) { res.status(400).json({ error: 'Already RSVPd' }); }
});

app.delete('/events/:id/rsvp', authenticate, async (req: AuthRequest, res) => {
  const eventId = parseInt(req.params.id);
  const rsvp = await prisma.rSVP.findUnique({ where: { eventId_userId: { eventId, userId: req.user!.id } } });
  if (!rsvp) return res.status(404).json({ error: 'Not found' });
  
  await prisma.rSVP.delete({ where: { id: rsvp.id } });

  if (rsvp.status === 'CONFIRMED') {
    // [BUG B3 INJECTED]: Return 204 early, pushing logic to the background. If the waitlist is empty, missing null checks will cause an Unhandled Promise Rejection crash.
    res.status(204).send();

    setTimeout(async () => {
      const next = await prisma.rSVP.findFirst({
        where: { eventId, status: 'WAITLISTED' },
        // [BUG B1 INJECTED]: Incorrectly using descending (desc) order (equivalent to right.id - left.id), promoting the newest waitlist member instead of the oldest.
        orderBy: { id: 'desc' },
        include: { user: true, event: true }
      });

      await prisma.rSVP.update({ where: { id: next!.id }, data: { status: 'CONFIRMED' } });
      Notifier.send(next!.user.email, `Promoted from waitlist for ${next!.event.title}`);
    }, 2000);
    return;
  }
  
  res.status(204).send();
});

export default app;