🐞 Bug Lab – Function Overview & Issues

This section documents exported functions and the known “bug-lab” issues in their implementations.

**1. selectNextPromotedCandidate(candidates)**

Selects the best waitlist candidate based on a computed score.

Behavior:

Sorts candidates using computePromotionScore
Applies tie-breaking logic to pick a winner

Bug-lab issues:

Tie-breaker incorrectly prefers higher id instead of earlier createdAt
computePromotionScore gives a disproportionate “age boost” using createdAt.getTime() / 1000, but only when vip !== null, making scoring inconsistent and unintuitive



**2. hasPermission(user, requiredPermission)**

Checks whether a user has the required permission bit.

Bug-lab issue:

Uses bitwise OR (|) instead of AND (&)
Result: almost always evaluates to a truthy value → over-permissive access control



**3. cancelRsvpAndNotifyNext(fetchNextUser, sendEmail, scheduleTask?)**

Cancels an RSVP and triggers a background task to notify the next user.

Behavior:

Fetches next user
Sends them a welcome email
Immediately returns { status: 200 }

Bug-lab issue:

Does not handle nextUser === null
Unsafe usage of non-null assertions:
nextUser!.email
formatWelcomeEmail(nextUser)
Can lead to runtime crashes



**4. buildNotifications(recipients, templateFactory?)**

Builds notification payloads for a list of recipients.

Behavior:

Generates { to, body } messages for each recipient

Bug-lab issue:

Uses a module-level variable leakedRecipientEmail
Overwrites .to for all messages in final mapping
Result: all notifications may be sent to the last recipient (data leak / cross-talk bug)



**5. createEventWithSoftDeleteBug(existingEvents, input)**

Creates a new event if no existing event shares the same slug.

Bug-lab issue:

Duplicate check ignores deletedAt
Soft-deleted events still block reuse of the same slug



**6. softDeleteEvent(events, eventId)**

Marks an event as deleted.

Behavior:

Returns a new array
Sets deletedAt = now for matching event

Status:

✅ No known issues (reference implementation)



**7. validateCapacity({ capacity })**

Validates and returns event capacity.

Bug-lab issues:

if (!input.capacity) incorrectly treats 0 as invalid
Accepts string values like "10" without proper validation
Returns untrusted type → false type safety
