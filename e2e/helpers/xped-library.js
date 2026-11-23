async function signedIn(page) {
  await page.route('https://**/*', route => route.abort());
  await page.route('**/api/auth/user', route => route.fulfill({ json: {
    uid: 'author',
    credits: { lecture_standard: 0, lecture_extended: 0, slides: 0, interview_short: 0, interview_medium: 0, interview_long: 0 },
    unlimited_credits: { lecture: false, slides: false, interview: false },
  } }));
  await page.route('**/static/js/firebase-bootstrap.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `const listeners = [];
      const makeUser = uid => uid && ({ uid, getIdToken: async () => uid });
      const auth = {
        currentUser: makeUser('author'),
        onAuthStateChanged(fn) { listeners.push(fn); queueMicrotask(() => fn(auth.currentUser)); return () => {}; }
      };
      window.switchAccount = uid => { auth.currentUser = makeUser(uid); listeners.forEach(fn => fn(auth.currentUser)); };
      window.firebase = {auth: () => auth};
      window.LectureProcessorBootstrap = {getAuth: () => auth, onAuthStateReady: (a, fn) => a.onAuthStateChanged(fn)};`,
  }));
}

module.exports = { signedIn };
