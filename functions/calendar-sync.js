/* Durable calendar wakeups. No Google user tokens pass through these functions. */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleAuth } = require('google-auth-library');
const { connectionNeedsSync, markConnectionDirty, wakeDuePage } = require('./calendar-sync-recovery');
const workerUrl = defineString('CALENDAR_WORKER_URL');
const workerAccount = defineString('CALENDAR_WORKER_SERVICE_ACCOUNT');
const auth = new GoogleAuth();

async function wake(uid, timeout = 110000) {
  const url = workerUrl.value();
  if (!url.startsWith('https://')) throw new Error('Calendar worker requires HTTPS');
  const client = await auth.getIdTokenClient(url);
  await client.request({ url, method: 'POST', data: { uid }, timeout });
}
async function dirty(uid) {
  if (!uid) return;
  await markConnectionDirty(getFirestore(), uid, amount => FieldValue.increment(amount));
}
const options = { serviceAccount: workerAccount, timeoutSeconds: 120, memory: '256MiB', maxInstances: 3, retry: true };
exports.studyCalendarOutbox = onDocumentWritten({ ...options, document: 'study_calendar_outbox/{uid}' }, async event => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!after || after.generation === before?.generation) return;
  await wake(event.params.uid);
});
exports.studyCalendarSessionChanged = onDocumentWritten({ ...options, document: 'planner_sessions/{id}' }, async event => {
  await dirty(event.data?.after.data()?.uid || event.data?.before.data()?.uid);
});
exports.studyCalendarGoalChanged = onDocumentWritten({ ...options, document: 'study_goals/{id}' }, async event => {
  await dirty(event.data?.after.data()?.uid || event.data?.before.data()?.uid);
});
exports.studyCalendarPreferencesChanged = onDocumentWritten({ ...options, document: 'study_plan_preferences/{uid}' }, async event => {
  await dirty(event.params.uid);
});
exports.studyCalendarConnectionChanged = onDocumentWritten({ ...options, document: 'study_google_calendars/{uid}' }, async event => {
  if (connectionNeedsSync(event.data?.before.data(), event.data?.after.data())) await dirty(event.params.uid);
});
exports.studyCalendarRecovery = onSchedule({
  schedule: 'every 5 minutes', serviceAccount: workerAccount, timeoutSeconds: 540, memory: '256MiB', maxInstances: 1,
}, async () => {
  const db = getFirestore();
  const expired = await db.collection('study_calendar_oauth_states').where('expires_at', '<=', Date.now() / 1000 - 86400).limit(200).get();
  if (!expired.empty) {
    const cleanup = db.batch();
    expired.docs.forEach(doc => cleanup.delete(doc.ref));
    await cleanup.commit();
  }
  // Ordered cursor avoids starving accounts after the first page. Leases make overlap harmless.
  let cursor;
  const deadline = Date.now() + 480000;
  while (Date.now() < deadline) {
    let query = db.collection('study_calendar_outbox').where('next_attempt_at', '<=', Date.now() / 1000).orderBy('next_attempt_at').limit(20);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    const finishedPage = await wakeDuePage(page.docs, { db, wake, deadline,
      onError: (uid, error) => {
        // The durable queue is retried next sweep. Never log request config (contains auth).
        console.error('Calendar wakeup failed', { uid, code: error.code || 'request_failed' });
      },
    });
    if (!finishedPage) return;
    if (page.size < 20) break;
    cursor = page.docs[page.docs.length - 1];
  }
});
