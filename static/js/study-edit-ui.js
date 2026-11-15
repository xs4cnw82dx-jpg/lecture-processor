(function (root) {
  'use strict';
  function text(value) { return root.LectureI18n ? root.LectureI18n.t(value) : value; }
  function element(tag, value, className) {
    var node = document.createElement(tag);
    if (value) node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function button(label, action, callback) {
    var node = element('button', text(label), 'btn');
    node.type = 'button'; node.dataset.editAction = action;
    node.addEventListener('click', callback);
    return node;
  }
  function notice(container, options) {
    if (!container) return;
    var selected = container.querySelector('select'), previous = selected && selected.value;
    container.replaceChildren();
    container.hidden = !options.messages.length && !options.records.length;
    options.messages.forEach(function (message) { container.appendChild(element('p', text(message))); });
    if (options.blocked) {
      var actions = element('div', '', 'actions');
      actions.append(button('Review changes', 'review', options.onReview), button('Discard local changes', 'discard', options.onDiscard));
      container.append(actions);
    }
    if (options.records.length) {
      container.append(element('p', text('An unfinished draft is available on this device.')));
      var select = element('select', '', 'pack-edit-draft-select');
      select.setAttribute('aria-label', text('Choose a draft'));
      options.records.forEach(function (record) {
        var label = text(record.payload.editor_mode === 'builder' ? 'Builder draft' : 'Editor draft');
        var option = element('option'); option.value = record.id;
        option.textContent = label + ' · ' + new Date(record.payload.saved_at).toLocaleString(document.documentElement.lang || 'en');
        select.append(option);
      });
      if (options.records.some(function (record) { return record.id === previous; })) select.value = previous;
      var recovery = element('div', '', 'actions');
      recovery.append(button('Recover draft', 'recover', function () { options.onRecover(select.value); }),
        button('Discard draft', 'discard-record', function () { options.onDiscardRecord(select.value); }));
      container.append(select, recovery);
    }
  }
  var labels = { title: 'Title', folder_id: 'Folder', course: 'Course', subject: 'Subject', semester: 'Semester', block: 'Block',
    notes_markdown: 'Notes', flashcards: 'Flashcards', test_questions: 'Practice questions' };
  function preview(container, field, value, options) {
    if (field === 'folder_id') { container.append(element('p', options.folderName(value))); return; }
    if (!Array.isArray(value)) { container.append(element('pre', String(value || text('Empty')))); return; }
    if (!value.length) container.append(element('p', text('Empty')));
    value.forEach(function (item, index) {
      var row = element('article', '', 'pack-edit-preview-item');
      row.append(element('strong', String(index + 1) + '. ' + (field === 'flashcards' ? item.front : item.question)));
      if (field === 'flashcards') {
        row.append(element('p', item.back));
        if (root.StudyPictures) root.StudyPictures.pictures(row, item, options.packId);
      } else {
        (item.options || []).forEach(function (option) { row.append(element('p', option)); });
        row.append(element('p', text('Correct Answer') + ': ' + item.answer), element('p', item.explanation));
      }
      container.append(row);
    });
  }
  function review(container, options) {
    container.replaceChildren();
    options.fields.forEach(function (field) {
      var section = element('section', '', 'pack-edit-review-field');
      section.append(element('h3', text(labels[field])));
      var columns = element('div', '', 'pack-edit-review-columns');
      ['saved', 'draft'].forEach(function (source) {
        var column = element('div', '', 'pack-edit-review-version');
        column.append(element('h4', text(source === 'saved' ? 'Saved version' : 'Your changes')));
        var content = element('div', '', 'pack-edit-preview');
        content.setAttribute('translate', 'no');
        preview(content, field, options[source][field], options);
        column.append(content); columns.append(column);
      });
      var choice = element('label', '', 'pack-edit-review-choice'), input = element('input');
      input.type = 'checkbox'; input.dataset.reviewField = field;
      input.addEventListener('change', function () { options.onChoose(field, input.checked); });
      choice.append(input, element('span', text('Use my changes')));
      section.append(choice, columns); container.append(section);
    });
  }
  root.LectureProcessorStudyEditUI = { notice: notice, review: review };
})(window);
