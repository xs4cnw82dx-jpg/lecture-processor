(function () {
  'use strict';
  const byId = id => document.getElementById('acct-' + id);
  const status = byId('status');
  const form = byId('confirmation');
  let auth;
  try { auth = window.Xped.bootstrap.getAuth(); } catch (_) {
    status.textContent = 'Sign-in is temporarily unavailable. Reload this page to try again.';
    return;
  }
  const api = window.Xped.auth.createAuthClient(auth);
  let busy = false;
  let confirmedUser = null;

  function confirmDeletion(show) {
    confirmedUser = show ? auth.currentUser : null;
    byId('begin').setAttribute('aria-expanded', String(show));
    form.hidden = !show;
    byId('consent').checked = false;
    if (show) byId('consent').focus();
  }

  window.Xped.bootstrap.onAuthStateReady(auth, function (user) {
    confirmDeletion(false);
    byId('reauth').hidden = true;
    byId('signin').hidden = Boolean(user);
    byId('controls').hidden = !user;
    byId('identity').textContent = user ? user.email : '';
  });

  async function run(action) {
    if (busy || !auth.currentUser) return;
    busy = true;
    status.textContent = '';
    const buttons = byId('controls').querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    try { await action(auth.currentUser); } catch (error) {
      status.textContent = error.studioMessage || 'The request could not be completed. Please try again.';
    } finally {
      busy = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  async function checkResponse(response) {
    if (response.ok) return;
    if (response.status === 403 || response.status === 401) byId('reauth').hidden = false;
    const error = new Error();
    error.studioMessage = (await response.json()).error;
    throw error;
  }
  byId('export').addEventListener('click', () => run(async () => {
    const response = await api.authFetch('/api/academy/account/export');
    await checkResponse(response);
    await window.Xped.download.downloadResponseBlob(response, 'xped-academy-account.json');
    status.textContent = 'Your account download is ready.';
  }));
  byId('begin').addEventListener('click', () => confirmDeletion(form.hidden));
  byId('cancel').addEventListener('click', () => { confirmDeletion(false); byId('begin').focus(); });
  byId('reauth').addEventListener('click', () => run(async () => {
    await auth.signOut();
    window.location.assign('/inloggen?next=/instellingen');
  }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!byId('consent').checked || !confirmedUser || auth.currentUser !== confirmedUser) {
      confirmDeletion(false);
      return;
    }
    run(async user => {
      status.textContent = 'Transferring course records and removing your account…';
      let complete = false;
      do {
        if (auth.currentUser !== user) throw new Error('Account changed');
        const response = await api.authFetch('/api/academy/account/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmUid: user.uid })
        }, { retryOn401: false });
        await checkResponse(response);
        const result = await response.json();
        if (typeof result.complete !== 'boolean' || (result.complete ? response.status !== 200 : response.status !== 202)) {
          throw new Error('Unexpected account status');
        }
        complete = result.complete;
        if (!complete) {
          const seconds = Number(response.headers.get('Retry-After'));
          const delay = Number.isFinite(seconds) && seconds >= 1 ? seconds : 1;
          await new Promise(resolve => window.setTimeout(resolve, delay * 1000));
        }
      } while (!complete);
      if (auth.currentUser === user) await auth.signOut();
      status.textContent = 'Your Studio account has been deleted.';
      byId('controls').hidden = true;
      byId('signin').hidden = false;
      status.setAttribute('tabindex', '-1');
      status.focus();
    });
  });
})();
