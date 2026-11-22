// Lists keyboard and screen-reader problems among the controls a user can reach:
// a reachable control without a name, a control nested inside another control,
// a reachable control inside content hidden from assistive technology, and an
// element marked `hidden` that a stylesheet still displays.
async function accessibilityProblems(page) {
  return page.evaluate(() => {
    const focusable = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex],[contenteditable="true"]';
    const interactive = 'a[href],button,select,textarea,summary,[tabindex]:not([tabindex^="-"]),'
      + ['button', 'link', 'checkbox', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'radio',
        'treeitem', 'gridcell', 'combobox', 'slider', 'spinbutton'].map(role => '[role="' + role + '"]').join(',');
    // Text a screen reader would read: skips aria-hidden, hidden and undisplayed parts.
    const text = node => {
      if (!node) return '';
      const parts = [];
      const walk = current => {
        if (current.nodeType === Node.TEXT_NODE) { parts.push(current.textContent); return; }
        if (current.nodeType !== Node.ELEMENT_NODE) return;
        if (current.getAttribute('aria-hidden') === 'true' || current.hidden || getComputedStyle(current).display === 'none') return;
        if (current !== node && current.getAttribute('aria-label')) { parts.push(current.getAttribute('aria-label')); return; }
        if (current.tagName === 'IMG') { parts.push(current.getAttribute('alt') || ''); return; }
        current.childNodes.forEach(walk);
      };
      walk(node);
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    };
    const describe = node => {
      const name = node.id ? '#' + node.id : node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/)[0] : '';
      return node.tagName.toLowerCase() + name;
    };
    const accessibleName = node => {
      const labelledBy = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map(id => text(document.getElementById(id))).join(' ').trim();
      if (labelledBy) return labelledBy;
      if ((node.getAttribute('aria-label') || '').trim()) return node.getAttribute('aria-label').trim();
      if (node.labels && node.labels.length) {
        const fromLabels = Array.from(node.labels).map(text).join(' ').trim();
        if (fromLabels) return fromLabels;
      }
      if (['submit', 'button', 'reset'].includes(node.type) && node.tagName === 'INPUT' && node.value) return node.value;
      if (node.tagName !== 'INPUT' && node.tagName !== 'SELECT' && node.tagName !== 'TEXTAREA') {
        const content = text(node);
        if (content) return content;
      }
      return (node.getAttribute('title') || node.getAttribute('placeholder') || '').trim();
    };
    const rendered = node => {
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const problems = [];
    for (const node of document.querySelectorAll(focusable)) {
      if (node.matches(':disabled') || node.tabIndex < 0 || node.closest('[inert]') || !rendered(node)) continue;
      if (node.closest('[aria-hidden="true"]')) problems.push('reachable inside aria-hidden content: ' + describe(node));
      if (!accessibleName(node)) problems.push('reachable control without a name: ' + describe(node));
      const outer = node.parentElement && node.parentElement.closest(interactive);
      if (outer) problems.push('control nested inside another control: ' + describe(node) + ' in ' + describe(outer));
    }
    for (const node of document.querySelectorAll('[hidden]')) {
      if (getComputedStyle(node).display !== 'none') problems.push('element marked hidden is still displayed: ' + describe(node));
    }
    return [...new Set(problems)];
  });
}

// Lists the controls inside `selector` that keyboard users can currently reach.
async function reachableControlsInside(page, selector) {
  return page.evaluate(selector => {
    const focusable = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex],[contenteditable="true"]';
    return Array.from(document.querySelectorAll(selector)).flatMap(container => Array.from(container.querySelectorAll(focusable)))
      .filter(node => {
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        return !node.matches(':disabled') && node.tabIndex >= 0 && !node.closest('[inert]')
          && style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      })
      .map(node => node.tagName.toLowerCase() + (node.id ? '#' + node.id : ''));
  }, selector);
}

module.exports = { accessibilityProblems, reachableControlsInside };
