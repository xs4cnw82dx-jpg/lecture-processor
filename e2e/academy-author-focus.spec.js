const { test, expect } = require('./helpers/academy-service');
const Model = require('../static/js/elearning-model');

async function auditKeyboardStops(page) {
  const seen = await page.evaluateHandle(() => new Set());
  const stops = [];
  try {
    for (let i = 0; i < 250; i++) {
      await page.keyboard.press('Tab');
      const current = await page.evaluate(async seen => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const node = document.activeElement;
        if (!node || node === document.body) return null;
        if (seen.has(node)) return {repeat:true};
        seen.add(node);
        const style = getComputedStyle(node);
        const width = parseFloat(style.outlineWidth);
        const outset = width + parseFloat(style.outlineOffset);
        const r = node.getBoundingClientRect();
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const a = ancestor.getBoundingClientRect();
          const parentStyle = getComputedStyle(ancestor);
          if (/auto|scroll|hidden|clip/.test(parentStyle.overflowX)) {
            left = Math.max(left, a.left + ancestor.clientLeft);
            right = Math.min(right, a.left + ancestor.clientLeft + ancestor.clientWidth);
          }
          if (/auto|scroll|hidden|clip/.test(parentStyle.overflowY)) {
            top = Math.max(top, a.top + ancestor.clientTop);
            bottom = Math.min(bottom, a.top + ancestor.clientTop + ancestor.clientHeight);
          }
        }
        return {
          id:node.id, name:(node.getAttribute('aria-label') || node.textContent || node.tagName).trim().slice(0,40),
          area:node.closest('dialog,.el-topbar,#el-outline,#el-inspector,#el-stage')?.classList[0],
          ring:node.matches(':focus-visible') && style.outlineStyle !== 'none' && width >= 2 && style.outlineColor !== 'transparent' && style.outlineColor !== 'rgba(0, 0, 0, 0)',
          clipped:Math.max(left - r.left + outset, top - r.top + outset, r.right + outset - right, r.bottom + outset - bottom) > 1,
        };
      }, seen);
      if (current?.repeat) return stops;
      if (current) stops.push(current);
    }
    throw Error('Keyboard focus did not complete a cycle');
  } finally { await seen.dispose(); }
}

test('Create dialog and course editor show an unclipped indicator on every keyboard stop', async ({academyPage:page,academyOrigin,request}) => {
  await page.emulateMedia({colorScheme:'light'});
  await page.setViewportSize({width:1440,height:900});
  const result=await request.post(academyOrigin+'/api/elearning/expeditions',{
    headers:{Authorization:'Bearer academy-preview-token'}, data:Model.createExpeditionPreset('blank','Focusroute','nl'),
  });
  expect(result.ok()).toBeTruthy();
  const {expedition}=await result.json();
  await page.goto(academyOrigin+'/expedities');
  const trigger=page.locator('#el-new-expedition-btn');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#el-create-dialog')).toBeVisible();
  const dialog=await auditKeyboardStops(page);
  expect(dialog.map(s=>s.id)).toEqual(expect.arrayContaining(['el-new-title','el-create-confirm','el-create-cancel']));
  expect(dialog.filter(s=>!s.ring || s.clipped)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.goto(academyOrigin+'/expedities/'+expedition.id+'/bewerken');
  await expect(page.locator('#el-exp-title')).toBeEnabled();
  const editor=await auditKeyboardStops(page);
  expect(editor.map(s=>s.area)).toEqual(expect.arrayContaining(['el-topbar','el-outline-rail','el-inspector']));
  expect(editor.length).toBeGreaterThan(15);
  expect(editor.filter(s=>!s.ring || s.clipped)).toEqual([]);
  const inspector = page.locator('#el-inspector [role=tablist]');
  const first = inspector.getByRole('tab').first();
  await first.focus();
  await page.keyboard.press('End');
  const selected = inspector.getByRole('tab',{selected:true});
  await expect(selected).toBeFocused();
  await expect(inspector).toHaveCSS('overflow-x','auto');
  const tabs = await inspector.boundingBox();
  const tab = await selected.boundingBox();
  expect(tab.x).toBeGreaterThanOrEqual(tabs.x - 1);
  expect(tab.x + tab.width).toBeLessThanOrEqual(tabs.x + tabs.width + 1);
  await expect(selected).toHaveCSS('border-bottom-width','2px');
  await expect(selected).not.toHaveCSS('border-bottom-color','rgba(0, 0, 0, 0)');
  await expect(first).toHaveCSS('border-bottom-color','rgba(0, 0, 0, 0)');
});
