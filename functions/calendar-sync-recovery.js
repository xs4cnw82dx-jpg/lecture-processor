/* Recovery helpers kept separate so failure handling can be tested without deployment. */
const ACTIVE = new Set(['pending', 'syncing', 'connected', 'retrying', 'disconnecting']);

async function markConnectionDirty(db, uid, increment) {
  const connection = db.collection('study_google_calendars').doc(uid);
  const tombstone = db.collection('account_deletions').doc(uid);
  const outbox = db.collection('study_calendar_outbox').doc(uid);
  await db.runTransaction(async transaction => {
    const deleted = await transaction.get(tombstone);
    const current = await transaction.get(connection);
    const deletion = deleted.data() || {};
    if (deleted.exists && String(deletion.status || deletion.phase || '').trim().toLowerCase() !== 'cancelled') return;
    if (!current.exists || !ACTIVE.has(current.data()?.status)) return;
    transaction.set(outbox, { uid, generation: increment(1), next_attempt_at: 0 }, { merge: true });
  });
}

function connectionNeedsSync(before, after) {
  if (!after || !ACTIVE.has(after.status)) return false;
  if (!before) return true;
  if (['credentials', 'connection_id', 'include_deadlines', 'reminder_offset_minutes', 'remove_calendar', 'remove_synced_events']
    .some(key => before[key] !== after[key])) return true;
  return ['pending', 'disconnecting'].includes(after.status) && before.status !== after.status;
}

async function postponeFailedWake(db, uid, nowSeconds) {
  const ref = db.collection('study_calendar_outbox').doc(uid);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const queue = snapshot.data();
    // A timed-out HTTP request can still be running. Do not interfere with its lease.
    if ((queue.lease_until || 0) > nowSeconds) return;
    const attempts = Math.min(8, Number(queue.wake_failures || 0) + 1);
    const delay = Math.min(900, 30 * Math.pow(2, attempts));
    transaction.set(ref, {
      wake_failures: attempts,
      next_attempt_at: Math.max(Number(queue.next_attempt_at || 0), nowSeconds + delay),
    }, { merge: true });
  });
}

async function wakeDuePage(docs, { db, wake, now = Date.now, deadline, onError }) {
  // One unresponsive account must not hold up every later account in the queue.
  for (let offset = 0; offset < docs.length; offset += 4) {
    if (now() >= deadline) return false;
    await Promise.all(docs.slice(offset, offset + 4).map(async doc => {
      const nowSeconds = now() / 1000;
      if ((doc.data().lease_until || 0) > nowSeconds) return;
      try {
        await wake(doc.id, Math.min(65000, Math.max(1000, deadline - now() - 1000)));
      } catch (error) {
        await postponeFailedWake(db, doc.id, now() / 1000);
        onError(doc.id, error);
      }
    }));
  }
  return true;
}

module.exports = { connectionNeedsSync, markConnectionDirty, postponeFailedWake, wakeDuePage };
