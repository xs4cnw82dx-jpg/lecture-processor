(function () {
  'use strict';

  const doc = document;
  let popoverId = 0;
  const $ = id => doc.getElementById('xc-' + id);
  const { language: lang, copy: say, number, date: formatDate } = window.Xped.i18n;
  const date = value => Number.isFinite(value) && value >= 86400 ? formatDate(value * 1000, { dateStyle: 'medium' }) : '—';
  const roles = {
    owner: say('Eigenaar', 'Eigentümer:in'), admin: say('Beheerder', 'Administrator:in'),
    author: say('Auteur', 'Autor:in'), edit: say('Mede-auteur', 'Mitautor:in'), translate: say('Vertaler', 'Übersetzer:in'),
  };
  const courseId = doc.body.dataset.courseId;
  const teamPage = doc.body.dataset.academyWorkspace === 'team';
  const path = '/expedities/' + encodeURIComponent(courseId);
  let focusPerson = new URLSearchParams(location.search).get('persoon')?.trim().toLowerCase();
  const shareEndpoint = '/api/elearning/expeditions/' + encodeURIComponent(courseId) + '/sharing';
  let auth, client, workspace, sharing, identity, epoch = 0, task, loading, undoTimer, coverURL;
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
    if (!isCurrent(version)) throw new Error(say('Log opnieuw in.', 'Melden Sie sich erneut an.'));
    const response = await client.authFetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!isCurrent(version)) throw new Error(say('Het account is gewijzigd.', 'Das Konto hat sich geändert.'));
    if (!response.ok) {
      const error = new Error(window.Xped.i18n?.t?.(result.error) || result.error || say('Probeer het opnieuw.', 'Versuchen Sie es erneut.'));
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
    const host = $('feedback');
    if (!host) return;
    clearTimeout(undoTimer);
    const text = node('span');
    host.replaceChildren(text);
    window.Xped.ux.toast(message, { element: host, textElement: text, type, duration: undo ? 8000 : 5000, hide: () => host.replaceChildren() });
    if (undo) {
      const button = action(say('Ongedaan maken', 'Rückgängig'), async () => {
        clearTimeout(undoTimer);
        button.disabled = true;
        try { await undo(); notice(say('Toegang hersteld.', 'Zugriff wiederhergestellt.')); }
        catch (error) { notice(error.message, null, 'error'); }
      }, 'xc-text-action');
      host.append(button);
      undoTimer = setTimeout(() => { if (host.contains(button)) button.remove(); }, 8000);
    }
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
    $('cancel').textContent = handle ? say('Annuleren', 'Abbrechen') : say('Sluiten', 'Schließen');
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
    const cancel = action(say('Annuleren', 'Abbrechen'), () => { pane.remove(); original?.focus(); }, 'xc-text-action');
    const confirm = action(say('Bevestigen', 'Bestätigen'), async () => {
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
    if (url.origin !== location.origin || !/^\/(?:start|vertalen|expedities)\//.test(url.pathname)) throw new Error(say('Ongeldige link.', 'Ungültiger Link.'));
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
    const copy = action(say('Kopiëren', 'Kopieren'), async () => {
      try {
        await navigator.clipboard.writeText(full);
        copy.textContent = '✓';
        notice(say('Link gekopieerd.', 'Link kopiert.'));
        setTimeout(() => { copy.textContent = say('Kopiëren', 'Kopieren'); }, 1500);
      } catch (_) {
        const input = field(say('Link om te kopiëren', 'Link zum Kopieren'), 'url');
        input.lastChild.value = full;
        input.lastChild.readOnly = true;
        dialog(title, [input], '', null);
        input.lastChild.select();
      }
    }, 'xc-text-action');
    copy.setAttribute('aria-label', say('Link kopiëren', 'Link kopieren'));
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
    svg.setAttribute('aria-label', say('QR-code voor de link', 'QR-Code für den Link'));
    const image = node('div', null, 'xc-qr'); image.append(svg);
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    const svgButton = action(say('SVG downloaden', 'SVG herunterladen'), () => download(blob, 'xped-qr.svg'));
    const pngButton = action(say('PNG downloaden', 'PNG herunterladen'), async () => {
      const source = URL.createObjectURL(blob);
      try {
        const img = new Image(); img.src = source; await img.decode();
        const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1024;
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, 1024, 1024);
        canvas.toBlob(file => { if (file) download(file, 'xped-qr.png'); }, 'image/png');
      } catch (_) { notice(say('De afbeelding kon niet worden gemaakt.', 'Das Bild konnte nicht erstellt werden.')); }
      finally { URL.revokeObjectURL(source); }
    });
    const actions = node('div', null, 'xc-actions'); actions.append(svgButton, pngButton);
    const title = say('QR-code', 'QR-Code');
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
    const close = action(say('Sluiten', 'Schließen'), () => panel.hidePopover(), 'xc-text-action');
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
    const title = c.title || say('Expeditie', 'Expedition');
    $('title').textContent = title;
    doc.dispatchEvent(new CustomEvent('academy:course-title',{detail:title}));
    void showCover(workspace.cover).catch(() => { /* The course remains usable when its optional image is offline. */ });
    doc.title = title + ' · xPED Academy';
    showCourseStatus(c);
    const modules = c.modules || [], steps = modules.reduce((count, mod) => count + mod.steps, 0);
    $('count').textContent = number(modules.length) + ' ' + (modules.length === 1 ? say('station', 'Station') : say('stations', 'Stationen')) + ' · ' + number(steps) + ' ' + (steps === 1 ? say('stap','Schritt') : say('stappen','Schritte'));
    if (window.XpedAcademyControls && modules.length) $('strip').append(window.XpedAcademyControls.routeStrip(modules, { size: 'regular' }));
    for (const mod of modules) {
      const item = node('li');
      const stationTitle = textOf(mod.title) || say('Station', 'Station');
      const firstStep = mod.firstStepId;
      const dest = path + '/bewerken?' + new URLSearchParams(role === 'translate' ? { modus: 'vertalen', taal: workspace.target } : firstStep ? { module: mod.id, step: firstStep } : {});
      const label = link(stationTitle, dest);
      label.translate = false;
      item.append(label, node('small', number(mod.steps) + ' ' + (mod.steps === 1 ? say('stap', 'Schritt') : say('stappen', 'Schritte'))));
      $('stations').append(item);
    }
    if (!modules.length) $('stations').append(node('li', say('Deze expeditie heeft nog geen stations.', 'Diese Expedition hat noch keine Stationen.')));
    detail($('meta'), say('Jouw rol', 'Ihre Rolle'), roles[role]);
    detail($('meta'), say('Inhoudstaal', 'Inhaltssprache'), (c.defaultLanguage || 'nl').toUpperCase());
    detail($('meta'), say('Bijgewerkt', 'Aktualisiert'), date(c.updated_at));
    const translationURL = path + '/bewerken?modus=vertalen&taal=' + encodeURIComponent(workspace.target);
    $('translate').href = translationURL;
    if (role === 'translate') $('edit').href = translationURL;
    $('translation-heading').textContent = say('Vertaling naar ', 'Übersetzung nach ') + workspace.target.toUpperCase();
    const coverage = workspace.coverage[workspace.target] || { translated: 0, total: workspace.translations.length };
    $('coverage').textContent = number(coverage.translated) + ' / ' + number(coverage.total) + ' ' + say('teksten vertaald', 'Texte übersetzt');
    const deadline = $('deadline');
    if (deadline) {
      deadline.value = workspace.dueDate || '';
      $('deadline-form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button');
        if (button.disabled) return;
        button.disabled = true;
        try {
          const result = await api('/api/academy/courses/' + encodeURIComponent(courseId) + '/translation-date',
            {language: workspace.target, date: deadline.value || null});
          workspace.dueDate = result.dueDate;
          notice(say('Streefdatum opgeslagen.', 'Zieldatum gespeichert.'));
        } catch (error) { notice(error.message, null, 'error'); }
        finally { button.disabled = false; }
      });
    } else if (workspace.dueDate) {
      const note = $('deadline-label');
      const time = node('time', window.Xped.i18n.date(new Date(workspace.dueDate + 'T12:00:00'), {dateStyle:'long'}));
      time.dateTime = workspace.dueDate;
      note.append(say('Streefdatum vertaling · ', 'Zieldatum der Übersetzung · '), time);
      note.hidden = false;
    }
    $('review-only').addEventListener('change', showTranslations);
    showTranslations();
    if ($('pause')) $('pause').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try { const result = await api(shareEndpoint, { action: 'update_public', pausedMessage: $('paused-message').value }); sharing.share = result.share; notice(say('Bericht opgeslagen.', 'Nachricht gespeichert.')); }
      catch (error) { notice(error.message, null, 'error'); } finally { button.disabled = false; }
    });
    showView();
  }
  function showTranslations() {
    const rows = workspace.translations.filter(row => !$('review-only').checked || row.status !== 'translated');
    const list = $('translation-rows'); list.replaceChildren();
    if (!rows.length) { list.append(node('p', say('Alle teksten zijn bijgewerkt.', 'Alle Texte sind aktuell.'))); return; }
    for (const row of rows) {
      const item = node('div', null, 'xc-translation');
      item.append(userText('p', row.source || row.nl || '—'), userText('p', row.target || '—'));
      const review = node('div', null, 'xc-translation-action');
      const status = row.status === 'needs_review' ? say('Te controleren', 'Zu prüfen') : row.status === 'untranslated' ? say('Ontbreekt', 'Fehlt') : say('Vertaald', 'Übersetzt');
      const params = new URLSearchParams({ modus: 'vertalen', taal: workspace.target, filter: 'alle', veld: row.key, tab: 'vertalingen' });
      const edit = link(row.status === 'needs_review' ? say('Controleren','Prüfen') : say('Bewerken','Bearbeiten'), path + '/bewerken?' + params, 'xc-text-action');
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
          notice(error.message, null, 'error');
          const retry = action(say('Opnieuw proberen','Erneut versuchen'), () => loadSharing(true));
          $('feedback').append(retry);
        }
      } finally { if (isCurrent(version)) loading = null; }
    })();
    return loading;
  }
  function showSharing() {
    const data = sharing.share;
    const host = $('learner-link'); host.replaceChildren();
    if (data.token) host.append(copyField('/start/' + encodeURIComponent(data.token), say('Deelnemerslink','Teilnahmelink')));
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
          $('sharing-status').textContent = say('Opgeslagen', 'Gespeichert');
        } catch (error) { if (isCurrent(version)) notice(error.message, null, 'error'); }
        finally { if (isCurrent(version)) { controls.disabled = false; showSharing(); } }
      };
    }
    const members = $('members'), grants = $('grants');
    members.replaceChildren(); grants.replaceChildren();
    for (const member of sharing.members) {
      const row = node('li'), info = node('span', null, 'xc-person-info');
      info.append(userText('strong', member.email), node('small', roles[member.role]));
      row.append(info, action(say('Rol wijzigen','Rolle ändern'), () => memberDialog(member), 'xc-text-action'));
      const remove = action(say('Verwijderen','Entfernen'), () => confirmInline(remove, say('Toegang tot deze expeditie intrekken?','Zugriff auf diese Expedition entziehen?'), () => revoke('member', member)), 'xc-text-action is-danger');
      row.append(remove); members.append(row);
    }
    for (const grant of sharing.grants) {
      const row = node('li'), info = node('span', null, 'xc-person-info');
      info.append(userText('strong', grant.label || say('Vertalerslink', 'Übersetzungslink')), node('small', grant.targetLanguage.toUpperCase() + ' · ' + say('Gemaakt ', 'Erstellt ') + date(grant.createdAt) + ' · ' + (grant.lastOpenedAt ? say('Geopend ', 'Geöffnet ') + date(grant.lastOpenedAt) : say('Nog niet geopend', 'Noch nicht geöffnet'))));
      row.append(info, copyField(grant.urlPath, say('Vertalerslink','Übersetzungslink')));
      const remove = action(say('Intrekken','Widerrufen'), () => confirmInline(remove, say('Deze link intrekken?', 'Diesen Link widerrufen?'), () => revoke('grant', grant)), 'xc-text-action is-danger');
      row.append(remove); grants.append(row);
    }
    if (!members.children.length) members.append(node('li', say('Alleen jij hebt toegang met een account.', 'Nur Sie haben Zugriff mit einem Konto.'), 'xc-empty'));
    if (!grants.children.length) grants.append(node('li', say('Er zijn nog geen vertalerslinks.', 'Es gibt noch keine Übersetzungslinks.'), 'xc-empty'));
  }
  async function revoke(kind, target) {
    const member = kind === 'member';
    const data = member ? { action: 'remove_member', email: target.email } : { action: 'revoke_grant', grantId: target.id };
    const result = await api(shareEndpoint, data);
    await loadSharing(true);
    notice(member ? say('Teamlid verwijderd.', 'Teammitglied entfernt.') : say('Link ingetrokken.', 'Link widerrufen.'), result.undo ? async () => {
      await api(shareEndpoint, { ...data, action: member ? 'restore_member' : 'restore_grant', undo: result.undo });
      await loadSharing(true);
    } : null);
  }
  function memberDialog(member) {
    const email = field(say('E-mailadres','E-Mail-Adresse'), 'email', 'email');
    const role = field(say('Rol','Rolle'), 'role', null, [['edit', roles.edit], ['translate', roles.translate]]);
    if (member) { email.lastChild.value = member.email; email.lastChild.readOnly = true; role.lastChild.value = member.role; }
    dialog(member ? say('Rol wijzigen','Rolle ändern') : say('Teamlid toevoegen','Mitglied hinzufügen'), [email, role], say('Opslaan','Speichern'), async data => {
      await api(shareEndpoint, { action: 'add_member', email: data.get('email'), role: data.get('role') });
      await loadSharing(true); notice(say('Toegang opgeslagen.', 'Zugriff gespeichert.'));
    });
  }
  function grantDialog() {
    const name = field(say('Naam van de ontvanger','Name der empfangenden Person'), 'name');
    const select = field(say('Doeltaal','Zielsprache'), 'target', null, [['de','Deutsch'],['nl','Nederlands']]);
    dialog(say('Vertalerslink maken','Übersetzungslink erstellen'), [name, select], say('Link maken','Link erstellen'), async data => {
      await api(shareEndpoint, { action: 'create_grant', role: 'translate', targetLanguage: data.get('target'), label: data.get('name') });
      await loadSharing(true); notice(say('Vertalerslink gemaakt.', 'Übersetzungslink erstellt.'));
    });
  }
  function rotateDialog() {
    const title = workspace.course.title;
    const confirmation = field(say('Typ de titel van de expeditie','Geben Sie den Expeditionstitel ein'), 'title');
    dialog(say('Deelnemerslink vernieuwen','Teilnahmelink erneuern'), [node('p', say('De oude link en alle afgedrukte QR-codes werken daarna niet meer.', 'Der bisherige Link und alle gedruckten QR-Codes funktionieren danach nicht mehr.')), userText('strong', title), confirmation], say('Link vernieuwen','Link erneuern'), async data => {
      if (data.get('title') !== title) throw new Error(say('Typ de titel precies zoals hierboven.', 'Geben Sie den Titel genau wie oben ein.'));
      await api(shareEndpoint, { action: 'update_public', rotateToken: true, confirmTitle: title });
      await loadSharing(true); notice(say('Nieuwe deelnemerslink gemaakt.', 'Neuer Teilnahmelink erstellt.'));
    }, { danger: true });
  }

  function teamDialog() {
    const email = field(say('E-mailadres','E-Mail-Adresse'), 'email', 'email');
    const role = field(say('Rol','Rolle'), 'role', null, [['author',roles.author], ['edit',roles.edit], ['translate',roles.translate]]);
    const selection = node('fieldset', null, 'xc-course-checks');
    selection.append(node('legend', say('Expedities', 'Expeditionen')));
    const note = node('p');
    selection.append(note);
    const update = () => {
      note.textContent = role.querySelector('select').value === 'author' ? say('Een auteur kan eigen expedities maken. Een selectie hieronder geeft ook bewerktoegang.', 'Autor:innen können eigene Expeditionen erstellen. Die Auswahl unten erlaubt zusätzlich das Bearbeiten.') : say('Kies de expedities waarvoor deze rol geldt.', 'Wählen Sie die Expeditionen für diese Rolle.');
    };
    role.lastChild.addEventListener('change', update); update();
    for (const course of workspace.courses) {
      const label = node('label', null, 'xc-check');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.name = 'courses'; checkbox.value = course.id;
      label.append(checkbox, userText('span', course.title)); selection.append(label);
    }
    dialog(say('Teamlid uitnodigen','Teammitglied einladen'), [email, role, selection], say('Toegang verlenen','Zugriff gewähren'), async data => {
      const courses = data.getAll('courses');
      if (!courses.length && data.get('role') !== 'author') throw new Error(say('Kies ten minste één expeditie.', 'Wählen Sie mindestens eine Expedition.'));
      await api('/api/academy/team/invitations', { email: data.get('email'), role: data.get('role'), courses });
      await refreshTeam();
      notice(say('Toegang verleend. Het teamlid kan met dit e-mailadres inloggen.', 'Zugriff gewährt. Das Teammitglied kann sich mit dieser E-Mail-Adresse anmelden.'));
    }, { sheet: true });
  }
  async function refreshTeam() {
    const updated = await api('/api/academy/team');
    workspace = updated; showTeam();
  }
  function showTeam() {
    const people = workspace.people;
    $('team-count').textContent = number(people.length) + ' ' + (people.length === 1 ? say('persoon','Person') : say('personen','Personen'));
    const table = node('table', null, 'xc-team-table');
    const head = table.createTHead().insertRow();
    const labels = [say('Persoon','Person'), say('Rol','Rolle'), say('Expedities','Expeditionen'), say('Laatste aanmelding','Letzte Anmeldung'), 'Status', say('Acties','Aktionen')];
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
        showCourses.setAttribute('aria-label',say('Expedities van ','Expeditionen von ') + (person.name || person.email) + ' (' + number(person.courses.length) + ')');
        courses.append(showCourses);
      } else courses.textContent = '0';
      row.insertCell().textContent = date(person.lastSignIn);
      row.insertCell().append(node('span', person.active || person.admin ? say('Actief','Aktiv') : workspace.profilesAvailable === false ? say('Onbekend','Unbekannt') : say('Uitgenodigd','Eingeladen'), 'xc-person-state' + (person.active || person.admin ? ' is-active' : '')));
      const actions = row.insertCell();
      if (person.author && !person.admin) {
        const revokeBtn = action(say('Auteursrecht intrekken','Autor:innenrecht entziehen'), () => confirmInline(revokeBtn, say('Deze auteur verliest ook toegang tot de eigen expedities totdat je het auteursrecht herstelt. Auteursrecht intrekken?', 'Die Person verliert auch den Zugriff auf ihre eigenen Expeditionen, bis Sie das Autor:innenrecht wiederherstellen. Recht entziehen?'), async () => {
          await api('/api/academy/authors', { action:'revoke', email: person.email });
          await refreshTeam();
          notice(say('Auteursrecht ingetrokken.','Autor:innenrecht entzogen.'), async () => {
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
    clearTimeout(undoTimer); identity = user; task = workspace = sharing = loading = null;
    content.replaceChildren();
    doc.dispatchEvent(new CustomEvent('academy:course-title',{detail:''}));
    if (!user || !user.emailVerified) {
      window.dispatchEvent(new CustomEvent('academy:workspace-access', { detail: { canCreate: false, studioAdmin: false, courses: [] } }));
      state(user ? say('Bevestig je e-mailadres om deze pagina te openen.', 'Bestätigen Sie Ihre E-Mail-Adresse, um diese Seite zu öffnen.') : say('Log in om deze pagina te openen.', 'Melden Sie sich an, um diese Seite zu öffnen.'), { signin:true });
      return;
    }
    state(say('Laden…','Wird geladen…'), {busy:true});
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
      state(error.status === 403 ? say('Je hebt geen toegang tot deze pagina.', 'Sie haben keinen Zugriff auf diese Seite.') : error.message,
        { contact: error.status === 403, retry: error.status !== 403 });
    }
  }
  $('retry').addEventListener('click', () => load(auth?.currentUser));
  window.addEventListener('hashchange', showView);
  try {
    auth = window.Xped.bootstrap.getAuth();
    client = window.Xped.auth.createAuthClient(auth);
    auth.onAuthStateChanged(load);
  } catch (_) { state(say('Inloggen is tijdelijk niet beschikbaar. Herlaad de pagina om het opnieuw te proberen.', 'Die Anmeldung ist vorübergehend nicht verfügbar. Laden Sie die Seite erneut.')); }
})();
