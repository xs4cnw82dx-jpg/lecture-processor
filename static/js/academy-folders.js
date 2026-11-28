(function () {
  'use strict';
  var uiText = typeof window !== 'undefined' && window.Xped && window.Xped.i18n ? window.Xped.i18n.t : function (message) { return message; };

  window.XpedAcademyFolders = function (api, reload, render) {
    function byId(id) { return document.getElementById('academy-folder-' + id); }
    var bar = byId('bar');
    var filter = byId('filter');
    var dialog = byId('dialog');
    var name = byId('name');
    var destination = byId('destination');
    var confirm = byId('confirm');
    var error = byId('error');
    var folders = [];
    var editing = null;

    function current(id) { return folders.find(function (folder) { return folder.id === id; }); }

    function option(text, value, literal) {
      var item = new Option(text, value);
      if (literal) item.setAttribute('translate', 'no');
      return item;
    }

    function folderOption(folder) {
      return option(folder.name, folder.id, folder.id !== 'account-review');
    }

    function actions() {
      var selected = current(filter.value);
      var custom = selected && selected.id !== 'account-review';
      byId('rename').hidden = !custom || selected.deleting;
      byId('delete').hidden = !custom;
    }

    function update(rows, show, selection) {
      var previous = selection === undefined ? filter.value : selection;
      folders = rows || [];
      filter.replaceChildren(option(uiText('All expeditions'), '*'), option(uiText('Unfiled'), ''));
      folders.forEach(function (folder) { filter.add(folderOption(folder)); });
      filter.value = previous === '' || current(previous) ? previous : '*';
      bar.hidden = !show;
      actions();
    }

    function close() {
      editing = null;
      if (dialog.open) dialog.close();
      name.value = '';
      destination.replaceChildren();
      error.hidden = true;
    }

    function open(action, course) {
      var selected = current(filter.value);
      var naming = action === 'create' || action === 'rename';
      editing = { action: action, course: course, folder: selected };
      confirm.disabled = false;
      byId('cancel').disabled = false;
      error.hidden = true;
      byId('name-field').hidden = !naming;
      byId('destination-field').hidden = action !== 'move';
      byId('delete-note').hidden = action !== 'delete';
      name.required = naming;
      name.value = action === 'rename' ? selected.name : '';
      var titles = { create: uiText('New folder'), rename: uiText('Rename folder'), delete: uiText('Delete folder'), move: uiText('Move expedition') };
      byId('title').textContent = titles[action];
      confirm.textContent = action === 'delete' ? uiText('Delete folder') : action === 'move' ? uiText('Move') : uiText('Save');
      confirm.className = action === 'delete' ? 'btn danger' : 'btn primary';
      if (action === 'move') {
        destination.replaceChildren(option(uiText('Unfiled'), ''));
        folders.filter(function (folder) { return !folder.deleting; }).forEach(function (folder) {
          destination.add(folderOption(folder));
        });
        destination.value = current(course.folderId) && !current(course.folderId).deleting ? course.folderId : '';
      }
      dialog.showModal();
      (naming ? name : action === 'move' ? destination : byId('cancel')).focus();
    }

    filter.addEventListener('change', function () { actions(); render(); });
    ['create', 'rename', 'delete'].forEach(function (action) {
      byId(action).addEventListener('click', function () { open(action); });
    });
    byId('cancel').addEventListener('click', close);
    dialog.addEventListener('cancel', function (event) {
      if (confirm.disabled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    byId('form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var operation = editing;
      if (!operation || confirm.disabled) return;
      confirm.disabled = true;
      byId('cancel').disabled = true;
      dialog.setAttribute('closedby', 'none');
      error.hidden = true;
      var action = operation.action;
      var url = '/api/academy/folders';
      var options = { method: 'POST', body: JSON.stringify({ name: name.value.trim() }) };
      if (action === 'move') {
        url = '/api/academy/expeditions/' + encodeURIComponent(operation.course.id) + '/folder';
        options = { method: 'PUT', body: JSON.stringify({ folderId: destination.value }) };
      } else if (action !== 'create') {
        url += '/' + encodeURIComponent(operation.folder.id);
        options = action === 'delete' ? { method: 'DELETE' } : { method: 'PATCH', body: options.body };
      }
      try {
        var data = await api(url, options);
        if (editing !== operation) return;
        close();
        await reload(action === 'create' ? data.id : undefined);
      } catch (err) {
        if (editing === operation && err.code !== 'auth/session-changed') {
          error.textContent = err.message;
          error.hidden = false;
        }
      } finally {
        if (editing === operation || !editing) {
          confirm.disabled = false;
          byId('cancel').disabled = false;
          dialog.setAttribute('closedby', 'any');
        }
      }
    });

    return {
      update: update,
      reset: function () { close(); update([], false, '*'); },
      selected: function () { return filter.value !== '*'; },
      matches: function (course) {
        if (filter.value === '*') return true;
        if (course.role !== 'owner') return false;
        var folder = current(course.folderId);
        return (folder ? folder.id : '') === filter.value;
      },
      move: function (course) { open('move', course); },
    };
  };
})();
