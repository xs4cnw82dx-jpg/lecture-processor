(function () {
  'use strict';

  const doc = document;
  let popoverId = 0;
  const $ = id => doc.getElementById('xc-' + id);
  const { language: lang, t: uiText, number, date: formatDate } = window.Xped.i18n;
  const date = value => Number.isFinite(value) && value >= 86400 ? formatDate(value * 1000, { dateStyle: 'medium' }) : '—';
  const roles = {
    owner: uiText('workspace.role.owner'), admin: uiText('workspace.role.admin'),
    author: uiText('workspace.role.author'), edit: uiText('workspace.role.coauthor'), translate: uiText('workspace.role.translator'),
  };
  const courseId = doc.body.dataset.courseId;
  const teamPage = doc.body.dataset.academyWorkspace === 'team';
  const path = '/expedities/' + encodeURIComponent(courseId);
  let focusPerson = new URLSearchParams(location.search).get('persoon')?.trim().toLowerCase();
  const shareEndpoint = '/api/elearning/expeditions/' + encodeURIComponent(courseId) + '/sharing';
  let auth, client, workspace, sharing, identity, epoch = 0, task, loading, coverURL;
  const content = $('content');

  function node(tag, value, className) {
    const item = doc.createElement(tag);
    if (value != null) item.textContent = value;
    if (className) item.className = className;
    return item;
  }
  function action(label, click, style = 'btn') {
    const button = node('button', label, style);
    button.type = 'button';
    button.addEventListener('click', click);
    return button;
  }
  function link(label, href, className) {
    const anchor = node('a', label, className);
    anchor.href = href;
    return anchor;
  }
  function userText(tag, value) {
    const item = node(tag, value);
    item.translate = false;
    return item;
  }
  function textOf(value) {
    return typeof value === 'string' ? value : value?.[lang] || value?.nl || value?.de || value?.en || '';
  }
  function isCurrent(version) { return version === epoch && identity && auth.currentUser?.uid === identity.uid; }

  async function api(url, body, version = epoch) {
    if (!isCurrent(version)) throw new Error(uiText('workspace.signInAgain'));
    const response = await client.authFetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!isCurrent(version)) throw new Error(uiText('workspace.accountChanged'));
    if (!response.ok) {
      const error = new Error(window.Xped.i18n?.t?.(result.error) || result.error || uiText('workspace.retryPrompt'));
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function state(message, options = {}) {
    $('state').hidden = false;
    $('state').querySelector('p').textContent = message;
    $('signin').hidden = !options.signin;
    $('retry').hidden = !options.retry;
    if ($('contact')) $('contact').hidden = !options.contact;
    content.setAttribute('aria-busy', String(!!options.busy));
  }
  function notice(message, undo, type = 'success') {
    const version = epoch;
    window.Xped.ux.toast(message, { type, scope: 'collaboration', action: undo ? {
      label: uiText('workspace.undo'),
      onClick: async () => {
        if (!isCurrent(version)) return;
        try {
          await undo();
          if (isCurrent(version)) notice(uiText('workspace.accessRestored'));
        } catch (error) {
          if (isCurrent(version)) notice(error.message, null, 'error');
        }
      },
    } : null });
  }
  function detail(dl, title, value) { dl.append(node('dt', title), node('dd', value)); }
  function field(label, name, type, values) {
    const group = node('label', null, 'xc-field');
    group.append(node('span', label));
    const input = node(values ? 'select' : 'input');
    input.name = name;
    if (values) values.forEach(([value, text]) => input.add(new Option(text, value)));
    else input.type = type || 'text';
    input.required = true;
    group.append(input);
    return group;
  }
  function clearDialog() {
    const dialog = $('dialog');
    if (dialog?.open) dialog.close();
    task = null;
  }
  function dialog(title, fields, submit, handle, options = {}) {
    const frame = $('dialog');
    $('dialog-title').textContent = title;
    $('dialog-error').textContent = '';
    $('dialog-fields').replaceChildren(...fields);
    $('confirm').textContent = submit || '';
    $('confirm').hidden = !handle;
    $('confirm').disabled = false;
    $('confirm').className = options.danger ? 'btn danger' : 'btn primary';
    $('cancel').textContent = handle ? uiText('workspace.cancel') : uiText('workspace.close');
    task = handle;
    frame.classList.toggle('is-sheet', !!options.sheet);
    frame.showModal();
    const first = frame.querySelector('.xc-fields input:not([type=checkbox]), .xc-fields select, #xc-cancel');
    first?.focus();
  }
  function confirmInline(button, message, run) {
    if (button.parentElement.querySelector('.xc-inline-confirm')) return;
    const pane = node('span', null, 'xc-inline-confirm');
    const original = doc.activeElement;
    pane.append(node('span', message));
    const cancel = action(uiText('workspace.cancel'), () => { pane.remove(); original?.focus(); }, 'xc-text-action');
    const confirm = action(uiText('workspace.confirm'), async () => {
      confirm.disabled = cancel.disabled = true;
      try { await run(); pane.remove(); }
      catch (error) { notice(error.message, null, 'error'); confirm.disabled = cancel.disabled = false; }
    }, 'xc-text-action is-danger');
    pane.append(cancel, confirm);
    button.after(pane);
    cancel.focus();
  }

  function safeURL(raw) {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin || !/^\/(?:start|vertalen|expedities)\//.test(url.pathname)) throw new Error(uiText('workspace.invalidLink'));
    return url.href;
  }
  function copyField(raw, title) {
    const full = safeURL(raw);
    const group = node('div', null, 'xc-copy');
    const displayed = full.replace(/^https?:\/\//, '');
    const a = link('', full);
    a.append(node('span', displayed.slice(0,-4), 'xc-url-prefix'), node('span', displayed.slice(-4), 'xc-url-suffix'));
    a.setAttribute('aria-label', displayed);
    a.title = full;
    const copy = action(uiText('workspace.copy'), async () => {
      try {
        await navigator.clipboard.writeText(full);
        copy.textContent = '✓';
        notice(uiText('workspace.linkCopied'));
        setTimeout(() => { copy.textContent = uiText('workspace.copy'); }, 1500);
      } catch (_) {
        const input = field(uiText('workspace.copyableLink'), 'url');
        input.lastChild.value = full;
        input.lastChild.readOnly = true;
        dialog(title, [input], '', null);
        input.lastChild.select();
      }
    }, 'xc-text-action');
    copy.setAttribute('aria-label', uiText('workspace.copyLink'));
    const qr = action('QR', () => showQR(full, qr), 'xc-text-action');
    qr.setAttribute('aria-haspopup', 'dialog');
    qr.setAttribute('aria-expanded', 'false');
    group.append(a, copy, qr);
    return group;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = link('', url);
    anchor.download = name;
    doc.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function showQR(url, trigger) {
    const svg = window.XpedElearningQR.createSvgElement(url);
    svg.setAttribute('aria-label', uiText('workspace.linkQRCode'));
    const image = node('div', null, 'xc-qr'); image.append(svg);
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    const svgButton = action(uiText('workspace.downloadSVG'), () => download(blob, 'xped-qr.svg'));
    const pngButton = action(uiText('workspace.downloadPNG'), async () => {
      const source = URL.createObjectURL(blob);
      try {
        const img = new Image(); img.src = source; await img.decode();
        const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1024;
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, 1024, 1024);
        canvas.toBlob(file => { if (file) download(file, 'xped-qr.png'); }, 'image/png');
      } catch (_) { notice(uiText('workspace.imageFailed')); }
      finally { URL.revokeObjectURL(source); }
    });
    const actions = node('div', null, 'xc-actions'); actions.append(svgButton, pngButton);
    const title = uiText('workspace.qrCode');
    anchoredDetails(trigger, title, [image, actions]);
  }

  function anchoredDetails(trigger, title, children) {
    if (!('showPopover' in HTMLElement.prototype)) { dialog(title, children, '', null); return; }
    const previous = doc.querySelector('.xc-qr-popover:popover-open');
    if (previous) {
      const same = trigger.getAttribute('aria-controls') === previous.id;
      previous.hidePopover();
      if (same) return;
    }
    const panel = node('div', null, 'xc-qr-popover');
    panel.popover = 'auto';
    panel.id = 'xc-details-' + (++popoverId);
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-label',title);
    const close = action(uiText('workspace.close'), () => panel.hidePopover(), 'xc-text-action');
    const header = node('header');
    header.append(node('strong', title), close);
    panel.append(header, ...children);
    trigger.parentElement.append(panel);
    trigger.classList.add('xc-qr-target');
    trigger.setAttribute('aria-controls', panel.id);
    trigger.setAttribute('aria-expanded', 'true');
    panel.addEventListener('beforetoggle', event => {
      if (event.newState !== 'closed') return;
      trigger.classList.remove('xc-qr-target');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
      queueMicrotask(() => {
        if (panel.contains(doc.activeElement) || doc.activeElement === doc.body) trigger.focus();
        panel.remove();
      });
    });
    panel.showPopover();
    close.focus();
  }

  async function showCover(cover) {
    if (!cover || cover.kind === 'none') return;
    const version = epoch;
    const image = $('cover-image');
    const figure = $('cover');
    let source;
    if (cover.kind === 'xped') {
      if (!/^\/static\/images\/xped\/[a-zA-Z0-9_.-]+$/.test(cover.staticPath || '')) return;
      source = cover.staticPath;
    } else if (cover.kind === 'asset' && cover.assetId) {
      const response = await client.authFetch('/api/elearning/expeditions/' + encodeURIComponent(courseId) + '/assets/' + encodeURIComponent(cover.assetId));
      if (!response.ok || !isCurrent(version)) return;
      const blob = await response.blob();
      if (!isCurrent(version) || !blob.type.startsWith('image/')) return;
      source = coverURL = URL.createObjectURL(blob);
    } else return;
    image.addEventListener('load', () => {
      if (isCurrent(version)) figure.hidden = false;
    }, { once: true });
    image.src = source;
  }

  function showCourseStatus(course) {
    const label = $('state-mark');
    const shareEnabled = !!course.share?.enabled;
    label.textContent = course.role === 'translate' ? roles.translate : window.Xped.i18n.courseStatus({
      shareEnabled, collectResponses: course.share?.collectResponses, hasPublished: course.hasPublished,
    })[1];
    label.classList.toggle('is-live',shareEnabled);
  }

  function showCourse() {
    const c = workspace.course, role = c.role;
    const title = c.title || uiText('workspace.course');
    $('title').textContent = title;
    doc.dispatchEvent(new CustomEvent('academy:course-title',{detail:title}));
    void showCover(workspace.cover).catch(() => { /* The course remains usable when its optional image is offline. */ });
    doc.title = title + ' · xPED Academy';
    showCourseStatus(c);
    const modules = c.modules || [], steps = modules.reduce((count, mod) => count + mod.steps, 0);
    $('count').textContent = uiText('count.stations', { count: modules.length }) + ' · ' + uiText('count.steps', { count: steps });
    if (window.XpedAcademyControls && modules.length) $('strip').append(window.XpedAcademyControls.routeStrip(modules, { size: 'regular' }));
    for (const mod of modules) {
      const item = node('li');
      const stationTitle = textOf(mod.title) || uiText('workspace.station');
      const firstStep = mod.firstStepId;
      const dest = path + '/bewerken?' + new URLSearchParams(role === 'translate' ? { modus: 'vertalen', taal: workspace.target } : firstStep ? { module: mod.id, step: firstStep } : {});
      const label = link(stationTitle, dest);
      label.translate = false;
      item.append(label, node('small', uiText('count.steps', { count: mod.steps })));
      $('stations').append(item);
    }
    if (!modules.length) $('stations').append(node('li', uiText('workspace.emptyRoute')));
    detail($('meta'), uiText('workspace.yourRole'), roles[role]);
    detail($('meta'), uiText('workspace.contentLanguage'), (c.defaultLanguage || 'nl').toUpperCase());
    detail($('meta'), uiText('workspace.updated'), date(c.updated_at));
    const translationURL = path + '/bewerken?modus=vertalen&taal=' + encodeURIComponent(workspace.target);
    $('translate').href = translationURL;
    if (role === 'translate') $('edit').href = translationURL;
    $('translation-heading').textContent = uiText('workspace.translationInto', { language: workspace.target.toUpperCase() });
    const coverage = workspace.coverage[workspace.target] || { translated: 0, total: workspace.translations.length };
    $('coverage').textContent = uiText('count.translated', { count: coverage.total, ready: number(coverage.translated) });
    const deadline = $('deadline');
    if (deadline) {
      deadline.value = workspace.dueDate || '';
      window.Xped.i18n.localizeCalendars($('deadline-form'));
      $('deadline-form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type=submit]');
        if (button.disabled) return;
        button.disabled = true;
        try {
          const result = await api('/api/academy/courses/' + encodeURIComponent(courseId) + '/translation-date',
            {language: workspace.target, date: deadline.value || null});
          workspace.dueDate = result.dueDate;
          notice(uiText('workspace.deadlineSaved'));
        } catch (error) { notice(error.message, null, 'error'); }
        finally { button.disabled = false; }
      });
    } else if (workspace.dueDate) {
      const note = $('deadline-label');
      const time = node('time', window.Xped.i18n.date(new Date(workspace.dueDate + 'T12:00:00'), {dateStyle:'long'}));
      time.dateTime = workspace.dueDate;
      note.append(uiText('workspace.deadline') + ' · ', time);
      note.hidden = false;
    }
    $('review-only').addEventListener('change', showTranslations);
    showTranslations();
    if ($('pause')) $('pause').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try { const result = await api(shareEndpoint, { action: 'update_public', pausedMessage: $('paused-message').value }); sharing.share = result.share; notice(uiText('workspace.noteSaved')); }
      catch (error) { notice(error.message, null, 'error'); } finally { button.disabled = false; }
    });
    showView();
  }
  function showTranslations() {
    const rows = workspace.translations.filter(row => !$('review-only').checked || row.status !== 'translated');
    const list = $('translation-rows'); list.replaceChildren();
    if (!rows.length) { list.append(node('p', uiText('workspace.translationsUpToDate'))); return; }
    for (const row of rows) {
      const item = node('div', null, 'xc-translation');
      item.append(userText('p', row.source || row.nl || '—'), userText('p', row.target || '—'));
      const review = node('div', null, 'xc-translation-action');
      const status = row.status === 'needs_review' ? uiText('workspace.needsReview') : row.status === 'untranslated' ? uiText('workspace.missing') : uiText('workspace.translated');
      const params = new URLSearchParams({ modus: 'vertalen', taal: workspace.target, filter: 'alle', veld: row.key, tab: 'vertalingen' });
      const edit = link(row.status === 'needs_review' ? uiText('workspace.review') : uiText('workspace.edit'), path + '/bewerken?' + params, 'xc-text-action');
      edit.setAttribute('aria-label', edit.textContent + ' · ' + (row.source || row.nl || row.target).slice(0, 70));
      review.append(node('small', status), edit);
      item.append(review);
      list.append(item);
    }
  }
  function showView() {
    if (teamPage || !workspace) return;
    const anchors = [...content.querySelectorAll('[data-view]')];
    const selected = anchors.find(a => a.hash === location.hash) || anchors.find(a => a.dataset.view === (workspace.course.role === 'translate' ? 'vertalingen' : 'overzicht'));
    for (const a of anchors) {
      const active = a === selected;
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      $(a.dataset.view).hidden = !active;
    }
    // Keep the originating course tab on ordinary links, including open in a new tab.
    for (const link of content.querySelectorAll('a[href]')) {
      const destination = new URL(link.href);
      if (destination.origin !== location.origin || destination.pathname !== path + '/bewerken') continue;
      destination.searchParams.set('tab', selected.dataset.view);
      link.href = destination.href;
    }
    if (['delen', 'instellingen'].includes(selected.dataset.view)) void loadSharing();
  }
  async function loadSharing(refresh = false) {
    if (sharing && !refresh) return;
    if (loading) return loading;
    const version = epoch;
    loading = (async () => {
      try {
        const result = await api(shareEndpoint);
        if (!isCurrent(version)) return;
        sharing = result;
        showSharing();
      } catch (error) {
        if (isCurrent(version)) {
          window.Xped.ux.toast(error.message, { type: 'error', scope: 'collaboration',
            action: { label: uiText('workspace.retry'), onClick: () => { if (isCurrent(version)) loadSharing(true); } },
          });
        }
      } finally { if (isCurrent(version)) loading = null; }
    })();
    return loading;
  }
  function showSharing() {
    const data = sharing.share;
    const host = $('learner-link'); host.replaceChildren();
    if (data.token) host.append(copyField('/start/' + encodeURIComponent(data.token), uiText('workspace.learnerLink')));
    if (!$('sharing-settings')) return;
    $('paused-message').value = data.pausedMessage || '';
    $('response-dependency').hidden = !!data.collectResponses;
    for (const input of $('sharing-settings').querySelectorAll('[data-xc-setting]')) {
      input.checked = !!data[input.name];
      input.disabled = !data.collectResponses && !!input.closest('#xc-response-options');
      if (input.disabled) input.setAttribute('aria-describedby','xc-response-dependency');
      else input.removeAttribute('aria-describedby');
      input.onchange = async () => {
        const controls = $('sharing-settings');
        controls.disabled = true;
        const version = epoch;
        try {
          const result = await api(shareEndpoint, { action: 'update_public', [input.name]: input.checked });
          if (!isCurrent(version)) return;
          sharing.share = result.share; workspace.course.share = result.share;
          if (result.share.enabled) workspace.course.hasPublished = true;
          showCourseStatus(workspace.course);
          $('sharing-status').textContent = uiText('workspace.saved');
        } catch (error) { if (isCurrent(version)) notice(error.message, null, 'error'); }
        finally { if (isCurrent(version)) { controls.disabled = false; showSharing(); } }
      };
    }
    const members = $('members'), grants = $('grants');
    members.replaceChildren(); grants.replaceChildren();
    for (const member of sharing.members) {
      const row = node('li'), info = node('span', null, 'xc-person-info');
      info.append(userText('strong', member.email), node('small', roles[member.role]));
      row.append(info, action(uiText('workspace.changeRole'), () => memberDialog(member), 'xc-text-action'));
      const remove = action(uiText('workspace.remove'), () => confirmInline(remove, uiText('workspace.confirmRemoveAccess'), () => revoke('member', member)), 'xc-text-action is-danger');
      row.append(remove); members.append(row);
    }
    for (const grant of sharing.grants) {
      const row = node('li'), info = node('span', null, 'xc-person-info');
      info.append(userText('strong', grant.label || uiText('workspace.translatorLink')), node('small', grant.targetLanguage.toUpperCase() + ' · ' + uiText('workspace.createdAt', { date: date(grant.createdAt) }) + ' · ' + (grant.lastOpenedAt ? uiText('workspace.openedAt', { date: date(grant.lastOpenedAt) }) : uiText('workspace.neverOpened'))));
      row.append(info, copyField(grant.urlPath, uiText('workspace.translatorLink')));
      const remove = action(uiText('workspace.revoke'), () => confirmInline(remove, uiText('workspace.confirmRevokeLink'), () => revoke('grant', grant)), 'xc-text-action is-danger');
      row.append(remove); grants.append(row);
    }
    if (!members.children.length) members.append(node('li', uiText('workspace.onlyYou'), 'xc-empty'));
    if (!grants.children.length) grants.append(node('li', uiText('workspace.noTranslatorLinks'), 'xc-empty'));
  }
  async function revoke(kind, target) {
    const member = kind === 'member';
    const data = member ? { action: 'remove_member', email: target.email } : { action: 'revoke_grant', grantId: target.id };
    const result = await api(shareEndpoint, data);
    await loadSharing(true);
    notice(member ? uiText('workspace.memberRemoved') : uiText('workspace.linkRevoked'), result.undo ? async () => {
      await api(shareEndpoint, { ...data, action: member ? 'restore_member' : 'restore_grant', undo: result.undo });
      await loadSharing(true);
    } : null);
  }
  function memberDialog(member) {
    const email = field(uiText('workspace.email'), 'email', 'email');
    const role = field(uiText('workspace.role'), 'role', null, [['edit', roles.edit], ['translate', roles.translate]]);
    if (member) { email.lastChild.value = member.email; email.lastChild.readOnly = true; role.lastChild.value = member.role; }
    dialog(member ? uiText('workspace.changeRole') : uiText('workspace.addMember'), [email, role], uiText('workspace.save'), async data => {
      await api(shareEndpoint, { action: 'add_member', email: data.get('email'), role: data.get('role') });
      await loadSharing(true); notice(uiText('workspace.accessSaved'));
    });
  }
  function grantDialog() {
    const name = field(uiText('workspace.recipient'), 'name');
    const select = field(uiText('workspace.targetLanguage'), 'target', null, [['de','Deutsch'],['nl','Nederlands']]);
    dialog(uiText('workspace.createTranslatorLink'), [name, select], uiText('workspace.createLink'), async data => {
      await api(shareEndpoint, { action: 'create_grant', role: 'translate', targetLanguage: data.get('target'), label: data.get('name') });
      await loadSharing(true); notice(uiText('workspace.translatorLinkCreated'));
    });
  }
  function rotateDialog() {
    const title = workspace.course.title;
    const confirmation = field(uiText('workspace.typeCourseTitle'), 'title');
    dialog(uiText('workspace.renewLink'), [node('p', uiText('workspace.renewHelp')), userText('strong', title), confirmation], uiText('workspace.renewAction'), async data => {
      if (data.get('title') !== title) throw new Error(uiText('workspace.titleMismatch'));
      await api(shareEndpoint, { action: 'update_public', rotateToken: true, confirmTitle: title });
      await loadSharing(true); notice(uiText('workspace.learnerLinkCreated'));
    }, { danger: true });
  }

  function teamDialog() {
    const email = field(uiText('workspace.email'), 'email', 'email');
    const role = field(uiText('workspace.role'), 'role', null, [['author',roles.author], ['edit',roles.edit], ['translate',roles.translate]]);
    const selection = node('fieldset', null, 'xc-course-checks');
    selection.append(node('legend', uiText('workspace.courses')));
    const note = node('p');
    selection.append(note);
    const update = () => {
      note.textContent = role.querySelector('select').value === 'author' ? uiText('workspace.authorHelp') : uiText('workspace.selectCourses');
    };
    role.lastChild.addEventListener('change', update); update();
    for (const course of workspace.courses) {
      const label = node('label', null, 'xc-check');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.name = 'courses'; checkbox.value = course.id;
      label.append(checkbox, userText('span', course.title)); selection.append(label);
    }
    dialog(uiText('workspace.inviteMember'), [email, role, selection], uiText('workspace.grantAccess'), async data => {
      const courses = data.getAll('courses');
      if (!courses.length && data.get('role') !== 'author') throw new Error(uiText('workspace.chooseOneCourse'));
      await api('/api/academy/team/invitations', { email: data.get('email'), role: data.get('role'), courses });
      await refreshTeam();
      notice(uiText('workspace.accessGranted'));
    }, { sheet: true });
  }
  async function refreshTeam() {
    const updated = await api('/api/academy/team');
    workspace = updated; showTeam();
  }
  function showTeam() {
    const people = workspace.people;
    $('team-count').textContent = uiText('workspace.people', { count: people.length });
    const table = node('table', null, 'xc-team-table');
    const head = table.createTHead().insertRow();
    const labels = [uiText('workspace.person'), uiText('workspace.role'), uiText('workspace.courses'), uiText('workspace.lastSignIn'), 'Status', uiText('workspace.actions')];
    for (const label of labels) { const th = node('th', label); th.scope = 'col'; head.append(th); }
    const tbody = table.createTBody();
    for (const person of people.slice().sort((a,b) => (b.admin || false) - (a.admin || false) || a.email.localeCompare(b.email,lang))) {
      const row = tbody.insertRow(), first = row.insertCell();
      if (focusPerson && [person.email, person.name].some(value => value && value.trim().toLowerCase() === focusPerson)) { row.classList.add('is-selected'); row.tabIndex = -1; }
      const id = node('div', null, 'xc-identity'), avatar = node('span', (person.name || person.email).split(/[\s.@_-]+/).slice(0,2).map(word => word.charAt(0)).join('').toUpperCase(), 'xc-avatar');
      avatar.setAttribute('aria-hidden','true'); const info = node('span', null, 'xc-person-info');
      if (person.name) info.append(userText('strong', person.name), userText('small', person.email)); else info.append(userText('strong', person.email));
      id.append(avatar, info); first.append(id);
      const assigned = [...new Set(person.courses.map(course => course.role).filter(role => role !== 'owner'))];
      const titles = person.admin ? [roles.admin] : [...(person.author ? [roles.author] : []), ...assigned.map(role => roles[role])];
      row.insertCell().textContent = titles.join(' · ');
      const courses = row.insertCell();
      if (person.courses.length) {
        const showCourses = action(number(person.courses.length), event => {
          const list = node('ul', null, 'xc-course-list'); person.courses.forEach(course => {
            const li = node('li'), anchor = link(course.title, '/expedities/' + encodeURIComponent(course.id));
            anchor.translate = false; li.append(anchor, node('small', roles[course.role])); list.append(li);
          });
          anchoredDetails(event.currentTarget, person.name || person.email, [list]);
        }, 'xc-text-action');
        showCourses.setAttribute('aria-haspopup','dialog');
        showCourses.setAttribute('aria-expanded','false');
        showCourses.setAttribute('aria-label',uiText('workspace.personCourses', { person: person.name || person.email, total: number(person.courses.length) }));
        courses.append(showCourses);
      } else courses.textContent = '0';
      row.insertCell().textContent = date(person.lastSignIn);
      row.insertCell().append(node('span', person.active || person.admin ? uiText('workspace.active') : workspace.profilesAvailable === false ? uiText('workspace.unknown') : uiText('workspace.invited'), 'xc-person-state' + (person.active || person.admin ? ' is-active' : '')));
      const actions = row.insertCell();
      if (person.author && !person.admin) {
        const revokeBtn = action(uiText('workspace.revokeAuthor'), () => confirmInline(revokeBtn, uiText('workspace.revokeAuthorHelp'), async () => {
          await api('/api/academy/authors', { action:'revoke', email: person.email });
          await refreshTeam();
          notice(uiText('workspace.authorRevoked'), async () => {
            await api('/api/academy/authors', { action:'grant', email: person.email }); await refreshTeam();
          });
        }), 'xc-text-action is-danger'); actions.append(revokeBtn);
      }
      [...row.cells].forEach((cell, i) => { cell.dataset.column = labels[i]; });
    }
    $('team-list').replaceChildren(table);
    if (focusPerson) { table.querySelector('.is-selected')?.focus(); focusPerson = ''; }
  }
  function bindControls() {
    const handlers = { member: () => memberDialog(), grant: grantDialog, rotate: rotateDialog, team: teamDialog };
    content.querySelectorAll('[data-xc-open]').forEach(button => button.addEventListener('click', handlers[button.dataset.xcOpen]));
    const frame = $('dialog');
    $('cancel').addEventListener('click', clearDialog); $('close').addEventListener('click', clearDialog);
    frame.addEventListener('cancel', event => { if ($('confirm').disabled) event.preventDefault(); });
    $('dialog-form').addEventListener('submit', async event => {
      event.preventDefault(); const handler = task;
      if (!handler || $('confirm').disabled) return;
      const version = epoch;
      const confirm = $('confirm');
      const form = $('dialog-form');
      confirm.disabled = $('cancel').disabled = $('close').disabled = true;
      confirm.setAttribute('aria-busy','true');
      try { await handler(new FormData(form)); if (isCurrent(version)) clearDialog(); }
      catch (error) { if (isCurrent(version)) $('dialog-error').textContent = error.message; }
      finally { if (isCurrent(version)) { confirm.disabled = $('cancel').disabled = $('close').disabled = false; confirm.removeAttribute('aria-busy'); } }
    });
  }
  async function load(user) {
    const version = ++epoch;
    if ($('dialog')?.open) $('dialog').close();
    if (coverURL) { URL.revokeObjectURL(coverURL); coverURL = ''; }
    window.Xped.ux.clearToasts('collaboration');
    identity = user; task = workspace = sharing = loading = null;
    content.replaceChildren();
    doc.dispatchEvent(new CustomEvent('academy:course-title',{detail:''}));
    if (!user || !user.emailVerified) {
      window.dispatchEvent(new CustomEvent('academy:workspace-access', { detail: { canCreate: false, studioAdmin: false, courses: [] } }));
      state(user ? uiText('workspace.verifyEmail') : uiText('workspace.signInPrompt'), { signin:true });
      return;
    }
    state(uiText('workspace.loading'), {busy:true});
    try {
      const result = await api(teamPage ? '/api/academy/team' : '/api/academy/courses/' + encodeURIComponent(courseId) + '/workspace', undefined, version);
      if (!isCurrent(version)) return;
      // The server includes only controls for the verified account and course role.
      const fragment = new DOMParser().parseFromString(result.html, 'text/html');
      content.replaceChildren(...fragment.body.childNodes);
      workspace = result;
      window.dispatchEvent(new CustomEvent('academy:workspace-access', { detail: {
        canCreate: teamPage || !!result.canCreate, studioAdmin: teamPage || !!result.studioAdmin,
        courses: result.course ? [{role: result.course.role}] : [],
      } }));
      bindControls();
      if (teamPage) showTeam(); else showCourse();
      $('state').hidden = true; content.setAttribute('aria-busy','false');
    } catch (error) {
      if (!isCurrent(version)) return;
      state(error.status === 403 ? uiText('workspace.forbidden') : error.message,
        { contact: error.status === 403, retry: error.status !== 403 });
    }
  }
  $('retry').addEventListener('click', () => load(auth?.currentUser));
  window.addEventListener('hashchange', showView);
  try {
    auth = window.Xped.bootstrap.getAuth();
    client = window.Xped.auth.createAuthClient(auth);
    auth.onAuthStateChanged(load);
  } catch (_) { state(uiText('workspace.authUnavailable')); }
})();
