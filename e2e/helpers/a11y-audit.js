// Lists keyboard and screen-reader problems among the controls a user can reach:
// a reachable control without a name, a control nested inside another control,
// a reachable control inside content hidden from assistive technology, and an
// element marked `hidden` that a stylesheet still displays.
async function accessibilityProblems(page) {
  return page.evaluate(() => {
    const focusable = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex],[contenteditable="true"]';
    const interactive = 'a[href],button,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[role="radio"]';
    const text = node => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
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
        const image = node.querySelector('img[alt]:not([alt=""]), svg[aria-label], [role="img"][aria-label]');
        if (image) return image.getAttribute('alt') || image.getAttribute('aria-label');
      }
      return (node.getAttribute('title') || node.getAttribute('placeholder') || '').trim();
    };
    const rendered = node => {
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const problems = [];
    for (const node of document.querySelectorAll(focusable)) {
      if (node.disabled || node.tabIndex < 0 || node.closest('[inert]') || !rendered(node)) continue;
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
        return !node.disabled && node.tabIndex >= 0 && !node.closest('[inert]')
          && style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      })
      .map(node => node.tagName.toLowerCase() + (node.id ? '#' + node.id : ''));
  }, selector);
}

module.exports = { accessibilityProblems, reachableControlsInside };
