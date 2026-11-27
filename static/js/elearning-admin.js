(function (root) {
  'use strict';
  function create(api, refreshLibrary) {
    function el(id) { return document.getElementById('el-admin-' + id); }
    function t(key, params) { return root.LectureI18n ? root.LectureI18n.t(key, params) : key.replace(/\{(\w+)\}/g, (_, k) => params[k]); }
    var dialog = el('dialog');
    var course = el('course');
    var controls = el('controls');
    var shareForm = el('share-form');
    var authorForm = el('author-form');
    var generation = 0;
    var courses = [];
    var view = 'access';
    var confirmedShare = {};
    var shareKeys = ['enabled', 'collectResponses', 'showPeerResults', 'collectPilotFeedback', 'allowStepComments'];

    function wipe() {
      ++generation;
      course.replaceChildren();
      ['members', 'grants', 'totals', 'breakdown'].forEach(function (id) { el(id).replaceChildren(); });
      ['member-form', 'grant-form', 'share-form'].forEach(function (id) { el(id).reset(); });
      if (authorForm) {
        authorForm.reset();
        el('author-list').replaceChildren();
      }
      confirmedShare = {};
      el('link').value = '';
      el('report').removeAttribute('href');
      el('sharing-tools').removeAttribute('href');
      el('status').textContent = '';
      el('retry').hidden = true;
      controls.hidden = true;
    }

    function reset() {
      courses = [];
      el('btn').hidden = true;
      if (dialog.open) dialog.close();
      wipe();
    }

    function setCourses(eligible, items) {
      if (!eligible) { reset(); return; }
      courses = items.filter(function (item) { return item.role === 'owner' && !item.deletionPending; });
      el('btn').hidden = false;
    }

    function sharingUrl() {
      return '/api/elearning/admin/expeditions/' + encodeURIComponent(course.value) + '/sharing';
    }

    async function copy(path) {
      var current = generation;
      var url = new URL(path, location.origin).href;
      try {
        await navigator.clipboard.writeText(url);
        if (current === generation) el('status').textContent = t('Link copied.');
      } catch (_) {
        if (current !== generation) return;
        var input = document.createElement('input');
        input.className = 'xped-input';
        input.readOnly = true;
        input.value = url;
        input.setAttribute('aria-label', t('Link to copy'));
        el('status').replaceChildren(document.createTextNode(t('Select and copy this link.')), input);
        input.select();
      }
    }

    function action(label, run) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small';
      btn.textContent = t(label);
      btn.addEventListener('click', run);
      return btn;
    }

    function row(title, detail, buttons) {
      var item = document.createElement('li');
      var info = document.createElement('div');
      var name = document.createElement('strong');
      name.textContent = title;
      name.setAttribute('translate', 'no');
      var description = document.createElement('small');
      description.textContent = detail;
      info.append(name, description);
      var actions = document.createElement('div');
      actions.className = 'el-admin-row-actions';
      actions.append.apply(actions, buttons);
      item.append(info, actions);
      return item;
    }

    function removeAction(label, onRemove, message) {
      return action(label, function (event) {
        var button = event.currentTarget;
        var actions = button.parentElement;
        var originals = Array.from(actions.children);
        var cancel = action('Cancel', function () { actions.replaceChildren.apply(actions, originals); button.focus(); });
        var confirm = action('Confirm removal', onRemove);
        actions.replaceChildren(cancel, confirm);
        if (message) {
          var warning = document.createElement('small');
          warning.textContent = t(message);
          actions.prepend(warning);
        }
        cancel.focus();
      });
    }

    function renderSharing(data) {
      el('members').replaceChildren.apply(el('members'), data.members.map(function (member) {
        var roleLabel = member.role === 'edit' ? 'Co-Editor' : 'Translator';
        return row(member.email, t(roleLabel), [
          action('Change role', function () {
            el('email').value = member.email;
            el('role').value = member.role;
            el('role').focus();
          }),
          removeAction('Remove', function () { update({ action: 'remove_member', email: member.email }); }),
        ]);
      }));
      el('grants').replaceChildren.apply(el('grants'), data.grants.map(function (grant) {
        return row(grant.label, grant.targetLanguage.toUpperCase(), [
          action('Copy link', function () { copy(grant.urlPath); }),
          removeAction('Revoke', function () { update({ action: 'revoke_grant', grantId: grant.id }); }),
        ]);
      }));
      var share = data.share;
      confirmedShare = share;
      el('paused').value = share.pausedMessage || '';
      shareKeys.forEach(function (key) { shareForm.elements[key].checked = !!share[key]; });
      el('extra').disabled = !share.collectResponses;
      el('link').value = share.token ? new URL('/elearning/p/' + encodeURIComponent(share.token), location.origin).href : '';
      el('copy').disabled = !share.enabled || !share.token;
      var path = '/physio/elearning/' + encodeURIComponent(course.value);
      el('report').href = path + '/responses';
      el('sharing-tools').href = path + '/edit?panel=sharing';
    }

    async function loadSharing() {
      var current = ++generation;
      controls.hidden = true;
      controls.disabled = true;
      el('retry').hidden = true;
      el('status').textContent = '';
      if (!course.value) return;
      el('status').textContent = t('Loading access settings…');
      try {
        var data = await api(sharingUrl());
        if (current !== generation) return;
        renderSharing(data);
        controls.hidden = false;
        controls.disabled = false;
        el('status').textContent = '';
      } catch (err) {
        if (current === generation) { el('status').textContent = err.message; el('retry').hidden = false; }
      }
    }

    async function update(payload, form) {
      if (controls.hidden || controls.disabled) return;
      var current = ++generation;
      el('retry').hidden = true;
      var url = sharingUrl();
      controls.disabled = true;
      el('status').textContent = t('Saving…');
      try {
        await api(url, { method: 'POST', body: JSON.stringify(payload) });
        if (current !== generation) return;
        if (form && form !== shareForm) form.reset();
        var data = await api(url);
        if (current !== generation) return;
        renderSharing(data);
        el('status').textContent = t('Saved');
        if (payload.action === 'update_public') refreshLibrary();
      } catch (err) {
        if (current !== generation) return;
        el('status').textContent = err.message;
        el('retry').hidden = false;
      } finally {
        if (current === generation) controls.disabled = false;
      }
    }

    async function authors(actionName, email) {
      var current = ++generation;
      var panel = el('author-controls');
      panel.disabled = true;
      el('retry').hidden = true;
      el('status').textContent = t(actionName ? 'Saving…' : 'Loading authors…');
      try {
        if (actionName) {
          await api('/api/academy/authors', { method: 'POST', body: JSON.stringify({ action: actionName, email: email }) });
          if (current !== generation) return;
          authorForm.reset();
        }
        var data = await api('/api/academy/authors');
        if (current !== generation) return;
        el('author-list').replaceChildren(...data.authors.map(function (address) {
          return row(address, '', [removeAction('Revoke', function () { authors('revoke', address); },
            'This author will lose access to their own expeditions until you restore access.')]);
        }));
        el('status').textContent = data.authors.length ? (actionName ? t('Saved') : '') : t('No invited authors yet.');
        panel.disabled = false;
      } catch (err) {
        if (current !== generation) return;
        el('status').textContent = err.message;
        el('retry').hidden = false;
      }
    }

    function metric(label, value) {
      var cell = document.createElement('div');
      var term = document.createElement('dt');
      var number = document.createElement('dd');
      term.textContent = t(label);
      number.textContent = value;
      cell.append(term, number);
      return cell;
    }

    async function statistics() {
      var current = ++generation;
      el('totals').replaceChildren();
      el('breakdown').replaceChildren();
      el('status').textContent = t('Loading statistics…');
      el('retry').hidden = true;
      try {
        var data = await api('/api/elearning/admin/statistics');
        if (current !== generation) return;
        el('status').textContent = '';
        el('totals').replaceChildren(metric('Recorded sessions', data.sessions), metric('Completed', data.completed),
          metric('Completion rate', data.sessions ? Math.round(100 * data.completed / data.sessions) + '%' : '—'));
        data.courses.forEach(function (item) {
          var report = document.createElement('a');
          report.className = 'el-action-link';
          report.href = '/physio/elearning/' + encodeURIComponent(item.id) + '/responses';
          report.textContent = t('Responses');
          var detail = t('{completed} of {total} sessions completed', { completed: item.completed, total: item.sessions });
          el('breakdown').appendChild(row(item.title, detail, [report]));
        });
      } catch (err) {
        if (current === generation) { el('status').textContent = err.message; el('retry').hidden = false; }
      }
    }

    function tab(next) {
      view = next;
      var sections = authorForm ? ['access', 'authors', 'stats'] : ['access', 'stats'];
      sections.forEach(function (id) {
        var active = view === id;
        el(id).hidden = !active;
        el(id + '-tab').setAttribute('aria-pressed', String(active));
      });
      if (next === 'stats') statistics();
      else if (next === 'authors') authors();
      else loadSharing();
    }

    el('btn').addEventListener('click', function () {
      wipe();
      courses.forEach(function (item) {
        var option = new Option(item.title, item.id);
        option.setAttribute('translate', 'no');
        course.add(option);
      });
      course.parentElement.hidden = !courses.length;
      el('empty').hidden = !!courses.length;
      dialog.showModal();
      tab('access');
    });
    dialog.addEventListener('close', function () { if (!dialog.open) wipe(); });
    course.addEventListener('change', function () {
      el('member-form').reset();
      el('grant-form').reset();
      loadSharing();
    });
    el('access-tab').addEventListener('click', function () { tab('access'); });
    if (authorForm) {
      el('authors-tab').addEventListener('click', function () { tab('authors'); });
      authorForm.addEventListener('submit', function (event) {
        event.preventDefault();
        if (!el('author-controls').disabled) authors('grant', el('author-email').value.trim());
      });
    }
    el('stats-tab').addEventListener('click', function () { tab('stats'); });
    el('retry').addEventListener('click', function () { tab(view); });
    el('member-form').addEventListener('submit', function (event) {
      event.preventDefault();
      update({ action: 'add_member', email: el('email').value.trim(), role: el('role').value }, this);
    });
    el('grant-form').addEventListener('submit', function (event) {
      event.preventDefault();
      update({ action: 'create_grant', label: el('name').value.trim(), role: 'translate', targetLanguage: el('lang').value }, this);
    });
    shareForm.elements.collectResponses.addEventListener('change', function () { el('extra').disabled = !this.checked; });
    shareForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var changes = {};
      shareKeys.forEach(function (key) {
        var checked = shareForm.elements[key].checked;
        if (checked !== !!confirmedShare[key]) changes[key] = checked;
      });
      if (el('paused').value !== (confirmedShare.pausedMessage || '')) changes.pausedMessage = el('paused').value;
      if (Object.keys(changes).length) update(Object.assign({ action: 'update_public' }, changes), this);
    });
    el('rotate').addEventListener('click', function () { update({ action: 'update_public', rotateToken: true }); });
    el('copy').addEventListener('click', function () { copy(el('link').value); });
    el('copy-studio').addEventListener('click', function () { copy('/physio/elearning/' + encodeURIComponent(course.value) + '/edit'); });

    return { setCourses: setCourses, reset: reset };
  }
  root.XpedStudioAdmin = { create: create };
})(window);
