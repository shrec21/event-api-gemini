import {
  Permissions,
  buildNotifications,
  cancelRsvpAndNotifyNext,
  createEventWithSoftDeleteBug,
  hasPermission,
  selectNextPromotedCandidate,
  softDeleteEvent,
  validateCapacity,
  type EventRecord,
  type NotificationRecipient,
  type WaitlistCandidate,
} from '../labs/bug-lab';

describe('Bug Lab Scenarios', () => {
  it('B1: uses ID ordering instead of temporal ordering when VIP is null', () => {
    const candidates: WaitlistCandidate[] = [
      {
        id: 10,
        email: 'first@example.com',
        createdAt: new Date('2026-04-14T10:00:00.000Z'),
        vip: null,
        priorityScore: 50,
      },
      {
        id: 11,
        email: 'second@example.com',
        createdAt: new Date('2026-04-14T10:05:00.000Z'),
        vip: null,
        priorityScore: 50,
      },
    ];

    const promoted = selectNextPromotedCandidate(candidates);

    expect(promoted?.email).toBe('second@example.com');
  });

  it('B2: guest mode passes organizer check because OR is used instead of AND', () => {
    const guestUser = { email: 'guest@example.com', permissions: Permissions.GUEST };

    expect(hasPermission(guestUser, Permissions.ORGANIZER)).toBe(true);
  });

  it('B3: background notify task returns 200 then rejects later when no next user exists', async () => {
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    let scheduledTask: (() => Promise<void>) | undefined;

    const result = await cancelRsvpAndNotifyNext(
      async () => null,
      sendEmail,
      (task) => {
        scheduledTask = task;
      },
    );

    expect(result.status).toBe(200);
    await expect(scheduledTask?.()).rejects.toThrow(
      "Cannot read properties of null (reading 'firstName')",
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('B4: notification loop leaks the last recipient email into every delivery', () => {
    const recipients: NotificationRecipient[] = [
      { email: 'alpha@example.com', message: 'First promotion' },
      { email: 'beta@example.com', message: 'Second promotion' },
      { email: 'gamma@example.com', message: 'Third promotion' },
    ];

    const deliveries = buildNotifications(recipients);

    expect(deliveries).toEqual([
      { to: 'gamma@example.com', body: 'First promotion' },
      { to: 'gamma@example.com', body: 'Second promotion' },
      { to: 'gamma@example.com', body: 'Third promotion' },
    ]);
  });

  it('B5: soft-deleted event still blocks slug reuse', () => {
    const existingEvents: EventRecord[] = [
      { id: 1, slug: 'summer-bash', title: 'Summer Bash', deletedAt: null },
    ];

    const afterDelete = softDeleteEvent(existingEvents, 1);

    expect(() =>
      createEventWithSoftDeleteBug(afterDelete, {
        slug: 'summer-bash',
        title: 'Summer Bash Recreated',
      }),
    ).toThrow('Slug already exists');
  });

  it('B6: truthy validation rejects zero capacity as missing', () => {
    expect(() => validateCapacity({ capacity: 0 })).toThrow('Missing capacity');
  });

  it('B6: type coercion allows a negative numeric string through range validation', () => {
    expect(validateCapacity({ capacity: ' -1 ' })).toBe(' -1 ');
  });
});
