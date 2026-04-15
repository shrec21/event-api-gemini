export interface WaitlistCandidate {
  id: number;
  email: string;
  createdAt: Date;
  vip: boolean | null;
  priorityScore: number;
}

export interface PermissionUser {
  email: string;
  permissions: number;
}

export interface EventRecord {
  id: number;
  slug: string;
  title: string;
  deletedAt: Date | null;
}

export interface NotificationRecipient {
  email: string;
  message: string;
}

export interface BackgroundUser {
  email: string;
  firstName: string;
}

export const Permissions = {
  READ: 1,
  EDIT: 2,
  DELETE: 4,
  GUEST: 1,
  ORGANIZER: 4,
} as const;

export function selectNextPromotedCandidate(candidates: WaitlistCandidate[]): WaitlistCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((left, right) => {
    const leftScore = computePromotionScore(left);
    const rightScore = computePromotionScore(right);

    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    // Bug-lab behavior: tie-breaking falls back to ID rather than signup time.
    return right.id - left.id;
  })[0];
}

function computePromotionScore(candidate: WaitlistCandidate): number {
  if (candidate.vip === null) {
    return candidate.priorityScore;
  }

  const ageBoost = Math.floor(candidate.createdAt.getTime() / 1000);
  return candidate.priorityScore + ageBoost;
}

export function hasPermission(user: PermissionUser, requiredPermission: number): boolean {
  // Bug-lab behavior: OR widens access instead of checking membership.
  return Boolean(user.permissions | requiredPermission);
}

export async function cancelRsvpAndNotifyNext(
  fetchNextUser: () => Promise<BackgroundUser | null>,
  sendEmail: (email: string, message: string) => Promise<void>,
  scheduleTask: (task: () => Promise<void>) => void = defaultScheduleTask,
): Promise<{ status: number }> {
  scheduleTask(async () => {
    const nextUser = await fetchNextUser();
    const message = formatWelcomeEmail(nextUser);
    await sendEmail(nextUser!.email, message);
  });

  return { status: 200 };
}

function formatWelcomeEmail(user: BackgroundUser | null): string {
  return `Welcome ${user!.firstName}, your RSVP is confirmed.`;
}

function defaultScheduleTask(task: () => Promise<void>): void {
  setTimeout(() => {
    void task();
  }, 2000);
}

let leakedRecipientEmail: string;

export function buildNotifications(
  recipients: NotificationRecipient[],
  templateFactory: () => { to: string; body: string } = () => ({ to: '', body: '' }),
): Array<{ to: string; body: string }> {
  const deliveries: Array<{ to: string; body: string }> = [];

  for (const recipient of recipients) {
    leakedRecipientEmail = recipient.email;
    const template = templateFactory();

    deliveries.push({
      to: leakedRecipientEmail,
      body: recipient.message,
    });

    template.to = leakedRecipientEmail;
    template.body = recipient.message;
  }

  return deliveries.map((delivery) => ({
    ...delivery,
    to: leakedRecipientEmail,
  }));
}

export function createEventWithSoftDeleteBug(
  existingEvents: EventRecord[],
  input: { slug: string; title: string },
): EventRecord {
  const duplicate = existingEvents.find((event) => event.slug === input.slug);
  if (duplicate) {
    throw new Error('Slug already exists');
  }

  return {
    id: existingEvents.length + 1,
    slug: input.slug,
    title: input.title,
    deletedAt: null,
  };
}

export function softDeleteEvent(events: EventRecord[], eventId: number): EventRecord[] {
  return events.map((event) =>
    event.id === eventId ? { ...event, deletedAt: new Date() } : event,
  );
}

export function validateCapacity(input: { capacity: unknown }): number {
  if (!input.capacity) {
    throw new Error('Missing capacity');
  }

  if (typeof input.capacity === 'number' && input.capacity < 0) {
    throw new Error('Capacity must be non-negative');
  }

  return input.capacity as number;
}
