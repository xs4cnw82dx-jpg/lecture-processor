const { expect } = require('@playwright/test');

async function expectProductControls(page) {
  await expect.poll(async () => page.evaluate(() => {
    const visible = node => {
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      return !node.closest('[hidden],[inert]') && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 2 && box.height > 2;
    };
    return Array.from(document.querySelectorAll('select,input,button,summary,audio,video')).filter(visible).flatMap(node => {
      const style = getComputedStyle(node), id = node.id || node.getAttribute('aria-label') || node.textContent.trim().slice(0,40) || node.tagName;
      if (node.tagName === 'SELECT') return [id + ': visible native select'];
      if (node.tagName === 'INPUT' && ['date','time','color'].includes(node.type)) return [id + ': visible native ' + node.type + ' picker'];
      if (node.tagName === 'INPUT' && ['checkbox','radio','range'].includes(node.type) && style.appearance !== 'none') return [id + ': native ' + node.type];
      if (node.tagName === 'BUTTON' && ['outset','inset'].includes(style.borderTopStyle)) return [id + ': native button border'];
      if (node.tagName === 'SUMMARY' && style.listStyleType !== 'none') return [id + ': native disclosure marker'];
      if (['AUDIO','VIDEO'].includes(node.tagName) && node.controls) return [id + ': native media controls'];
      return [];
    });
  }), { message:'All visible site controls should use the product UI', timeout:5000 }).toEqual([]);
}
module.exports = { expectProductControls };
