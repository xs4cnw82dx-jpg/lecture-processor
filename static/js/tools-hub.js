(function () {
  'use strict';
  var api = window.LectureProcessorTools;
  if (!api) return;
  var search = document.getElementById('hub-search');
  var category = 'all';
  var filters = Array.from(document.querySelectorAll('[data-category]'));
  var state = api.snapshot();
  var list = document.getElementById('hub-favorites-list');
  var status = document.getElementById('hub-favorites-status');
  var favoriteFocus = null;

  function button(label, action, id, text) {
    var node = document.createElement('button');
    node.type = 'button';
    node.textContent = text;
    node.setAttribute('aria-label', label);
    node.dataset.favoriteAction = action;
    node.dataset.id = id;
    node.disabled = state.saving;
    return node;
  }

  function render() {
    var focused = document.activeElement;
    var focusId = focused && focused.dataset.id;
    var focusAction = focused && focused.dataset.favoriteAction;
    if (focusId && focusAction) favoriteFocus = { id: focusId, action: focusAction };
    list.replaceChildren();
    state.ids.forEach(function (id, index) {
      var tool = state.catalog.find(function (item) { return item.id === id; });
      if (!tool) return;
      var row = document.createElement('li');
      row.className = 'hub-favorite-row';
      var link = document.createElement('a');
      link.href = tool.url;
      link.textContent = tool.name;
      row.appendChild(link);
      var actions = document.createElement('div');
      actions.className = 'hub-favorite-actions';
      var up = button('Move ' + tool.name + ' up', 'up', id, '↑');
      var down = button('Move ' + tool.name + ' down', 'down', id, '↓');
      up.disabled = state.saving || index === 0;
      down.disabled = state.saving || index === state.ids.length - 1;
      actions.append(up, down, button('Remove ' + tool.name + ' from favorites', 'remove', id, '×'));
      row.appendChild(actions);
      list.appendChild(row);
    });
    document.getElementById('hub-favorite-count').textContent = state.ids.length + (state.ids.length === 1 ? ' tool' : ' tools');
    var empty = document.getElementById('hub-favorites-empty');
    empty.hidden = state.ids.length > 0;
    empty.textContent = !state.signedIn ? 'Sign in to save your favorite tools here and in the sidebar.' :
      (!state.ready ? 'Loading your favorites…' : 'Select the star beside any tool to add your first favorite.');
    status.textContent = state.error || (state.saving ? 'Saving favorites…' : '');
    status.classList.toggle('is-error', !!state.error);
    document.querySelectorAll('[data-favorite]').forEach(function (star) {
      var id = star.dataset.favorite;
      var tool = state.catalog.find(function (item) { return item.id === id; });
      var selected = state.ids.includes(id);
      star.setAttribute('aria-pressed', String(selected));
      star.setAttribute('aria-label', (selected ? 'Remove ' : 'Add ') + tool.name + (selected ? ' from favorites' : ' to favorites'));
      star.disabled = !state.ready || state.saving;
      star.title = !state.signedIn ? 'Sign in to save favorites' : '';
    });
    if (favoriteFocus && !state.saving) {
      var target = Array.from(list.querySelectorAll('button')).find(function (node) {
        return node.dataset.id === favoriteFocus.id && node.dataset.favoriteAction === favoriteFocus.action && !node.disabled;
      });
      if (!target) target = Array.from(list.querySelectorAll('button')).find(function (node) { return node.dataset.id === favoriteFocus.id && !node.disabled; });
      if (!target) target = list.querySelector('button:not(:disabled)') || document.querySelector('[data-favorite="' + favoriteFocus.id + '"]');
      if (target) target.focus();
      favoriteFocus = null;
    }
  }

  function filterTools() {
    var query = search.value.trim().toLowerCase();
    var words = query.split(/\s+/).filter(Boolean);
    var count = 0;
    document.querySelectorAll('[data-tool-category]').forEach(function (section) {
      var matchesCategory = category === 'all' || category === section.dataset.toolCategory;
      var visible = 0;
      section.querySelectorAll('[data-tool-id]').forEach(function (card) {
        var matches = matchesCategory && words.every(function (word) { return card.dataset.search.includes(word); });
        card.hidden = !matches;
        if (matches) visible++;
      });
      section.hidden = !visible;
      count += visible;
    });
    filters.forEach(function (filter) { filter.setAttribute('aria-pressed', String(filter.dataset.category === category)); });
    document.getElementById('hub-no-results').hidden = count > 0;
    document.getElementById('hub-results-status').textContent = count + (count === 1 ? ' tool found' : ' tools found');
  }

  async function save(ids, message) {
    try {
      var ok = await api.save(ids);
      if (ok) status.textContent = message;
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('is-error');
    }
  }

  document.querySelectorAll('[data-favorite]').forEach(function (star) {
    star.addEventListener('click', function () {
      var id = star.dataset.favorite;
      var selected = state.ids.includes(id);
      save(selected ? state.ids.filter(function (item) { return item !== id; }) : state.ids.concat(id), selected ? 'Removed from favorites.' : 'Added to favorites.');
    });
  });
  list.addEventListener('click', function (event) {
    var target = event.target.closest('[data-favorite-action]');
    if (!target || target.disabled) return;
    var ids = state.ids.slice();
    var index = ids.indexOf(target.dataset.id);
    if (index < 0) return;
    if (target.dataset.favoriteAction === 'remove') ids.splice(index, 1);
    else {
      var next = index + (target.dataset.favoriteAction === 'up' ? -1 : 1);
      if (next < 0 || next >= ids.length) return;
      ids.splice(index, 1);
      ids.splice(next, 0, target.dataset.id);
    }
    save(ids, 'Favorites updated.');
  });
  filters.forEach(function (filter) { filter.addEventListener('click', function () { category = filter.dataset.category; filterTools(); }); });
  search.addEventListener('input', filterTools);
  document.getElementById('hub-clear-search').addEventListener('click', function () { search.value = ''; category = 'all'; filterTools(); search.focus(); });
  window.addEventListener('lp:tool-favorites', function (event) { state = event.detail; render(); });
  render();
  filterTools();
})();
