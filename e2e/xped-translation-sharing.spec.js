const { test, expect } = require('@playwright/test');
const { editorFixture } = require('./helpers/xped-editor');
const model = require('../static/js/elearning-model');

const editor = '/physio/elearning/visual/edit';
const sharing = '**/api/elearning/expeditions/visual/sharing';
const translations = '**/api/elearning/expeditions/visual/translations';

async function openTranslations(page, fixture) {
  await page.route(translations, async route => {
    const { targetLanguage, textUpdates } = route.request().postDataJSON();
    for (const row of model.extractTranslationRows(fixture.exp, 'nl', targetLanguage)) {
      if (Object.hasOwn(textUpdates, row.key)) {
        row.locObj[targetLanguage] = textUpdates[row.key];
        if (row.locObj._review) delete row.locObj._review[targetLanguage];
      }
    }
    await route.fulfill({ json: { expedition: { ...fixture.exp, revision: ++fixture.exp.revision } } });
  });
  await page.goto(editor);
  await page.getByRole('tab', {name:'Translate', exact:true}).click();
}

test('translation links identify the actual fallback language and retain phone editing position', async ({page}) => {
  await page.setViewportSize({width:390, height:844});
  const fixture = await editorFixture(page);
  fixture.exp.startPage.subtitle = {nl:'', en:'Only this English passage exists.', de:''};
  await openTranslations(page,fixture);
  const row = page.locator('[data-field-key="startPage.subtitle"]');
  const field = row.getByRole('textbox');
  await row.getByRole('button',{name:/Preview Start/}).click();
  const sheet = page.locator('#el-tr-preview-dialog');
  await expect(sheet.getByText('Only this English passage exists.')).toHaveAttribute('lang','en');
  await sheet.getByRole('button',{name:/Translate Start Page · Subtitle \(EN fallback\)/}).click();
  await expect(field).toBeFocused();
  await field.fill('Eine kurze Einführung.');
  await field.evaluate(ta => ta.setSelectionRange(5,9));
  await row.getByRole('button',{name:/Preview Start/}).click();
  await expect(sheet.getByText('Eine kurze Einführung.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(field).toBeFocused();
  expect(await field.evaluate(ta=>[ta.selectionStart, ta.selectionEnd])).toEqual([5,9]);
});

test('source text replacement can be undone and missing fields leave the filter on blur',async ({page})=>{
  const fixture = await editorFixture(page);
  fixture.exp.startPage.title = {nl:'Het pad',en:'The route',de:'Der Weg'};
  fixture.exp.startPage.subtitle = {nl:'Een begin',en:'A beginning',de:''};
  await openTranslations(page,fixture);
  const title = page.locator('[data-field-key="startPage.title"]');
  const subtitle = page.locator('[data-field-key="startPage.subtitle"]');
  await title.getByRole('button',{name:'Use Dutch text'}).click();
  await expect(title.getByRole('textbox')).toHaveValue('Het pad');
  await page.locator('#el-toast').getByRole('button',{name:'Undo'}).click();
  await expect(title.getByRole('textbox')).toHaveValue('Der Weg');
  await page.locator('#el-tr-alt-toggle').click();
  await expect(title.getByText('The route',{exact:false})).toBeVisible();
  await page.locator('#el-tr-filter-host button').first().click();
  await page.getByRole('menuitem',{name:'Untranslated'}).click();
  await subtitle.getByRole('textbox').fill('Ein Anfang');
  await expect(subtitle.getByRole('textbox')).toBeFocused();
  await subtitle.getByRole('textbox').press('Control+Enter');
  await expect(subtitle).toHaveCount(0);
  await expect(page.locator('#el-translate-rows textarea:focus')).toBeVisible();
});

test('filtering preserves collapsed groups and next missing reveals the next unfinished field', async ({page})=>{
  const fixture = await editorFixture(page);
  await openTranslations(page, fixture);
  const groups = page.locator('.el-tr-group');
  await groups.nth(1).locator('summary').click();
  await groups.nth(2).locator('summary').click();
  await page.locator('#el-tr-alt-toggle').click();
  await expect(groups.nth(1)).not.toHaveAttribute('open','');
  await expect(groups.nth(2)).not.toHaveAttribute('open','');
  await groups.first().locator('textarea').last().focus();
  await page.locator('#el-tr-next-missing').click();
  await expect(groups.nth(1)).toHaveAttribute('open','');
  await expect(groups.nth(1).locator('textarea:focus')).toBeVisible();
});

test('two queued changes roll back to the last confirmed sharing state and scopes remain separate', async ({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  const fixture = await editorFixture(page);
  const share = {enabled:false,collectResponses:true,token:'local-only'};
  fixture.exp.share = {...share};
  const grants = ['Anna','Anne'].map((label,i)=>({id:'g'+i,label,targetLanguage:'de',urlPath:'/elearning/translate/local-'+i}));
  let release, writes=0;
  await page.route(sharing,async route=>{
    if (route.request().method()==='GET') return route.fulfill({json:{share,grants,members:[]}});
    if (++writes===1) {
      await new Promise(r=>{release=r;});
      share.enabled=true;
      return route.fulfill({json:{share}});
    }
    return route.fulfill({status:503,json:{error:'Sharing update failed'}});
  });
  await page.goto(editor);
  await expect(page.locator('#el-share-visibility')).toHaveText('Private');
  await page.locator('#el-share-btn').click();
  await expect(page.locator('#el-share-url')).toBeHidden();
  const toggle=page.locator('#el-share-enabled');
  await toggle.check(); await expect.poll(()=>writes).toBe(1);
  await toggle.uncheck(); release();
  await expect(page.locator('#el-share-status')).toContainText('Sharing update failed');
  await expect(toggle).toBeChecked();
  const cohort=page.locator('#el-share-cohort'); await cohort.fill('pilot-2');
  await expect(page.locator('#el-share-qr-cohort')).toContainText('pilot-2');
  await expect(page.locator('#el-share-open-link')).toHaveAttribute('href',/local-only\?cohort=pilot-2$/);
  await page.getByRole('tab',{name:'Translators',exact:true}).click();
  await expect(toggle).toBeHidden();
  await page.getByRole('button',{name:'Copy translator link for Anne (DE)'}).press('Enter');
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('/elearning/translate/local-1');
  await page.getByRole('button',{name:'Revoke translator link for Anna (DE)'}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('button',{name:/Revoke translator link/})).toHaveCount(2);
  await page.locator('#el-share-dialog').getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.locator('#el-share-visibility')).toHaveText('Link active');
  await page.locator('#el-share-btn').click();
  await expect(toggle).toBeChecked();
  expect(writes).toBe(2);
});

test('sharing opens while settings load and retry recovers without enabling privileged editor actions', async ({page})=>{
  const fixture=await editorFixture(page,{role:'edit'});fixture.exp.share={enabled:false};
  let release,attempt=0;
  await page.route(sharing,async route=>{
    if (++attempt===1) {
      await new Promise(r=>{release=r;});
      return route.fulfill({status:503,json:{error:'Sharing temporarily unavailable'}});
    }
    return route.fulfill({json:{share:{enabled:false},members:[],grants:[]}});
  });
  await page.goto(editor);await page.locator('#el-share-btn').click();
  await expect(page.locator('#el-share-loading')).toContainText('Loading');
  await expect(page.locator('#el-share-content')).toBeHidden();
  await expect.poll(()=>attempt).toBe(1);release();
  await page.locator('#el-share-retry-btn').click();
  await expect(page.locator('#el-share-enabled')).toBeDisabled();
  await expect(page.getByRole('tab',{name:'Collaborators'})).toHaveCount(0);
});

test('preview finishes with the same localized mini-plan and reflection as the learner and writes no responses', async ({page})=>{
  const fixture=await editorFixture(page);
  const step=fixture.exp.modules[0].steps[0];
  fixture.exp.modules=[{...fixture.exp.modules[0],steps:[step]}];
  const plan=model.createBlock('mini_plan');
  const reflection=model.createBlock('reflection');
  step.blocks=[plan,reflection];
  let responses=0;
  await page.route('**/responses',route=>{responses++;return route.fulfill({json:{ok:true}});});
  await page.goto(editor+'?step='+step.id);await page.locator('[data-mode=preview]').click();
  const preview=page.locator('#el-preview-container');
  await expect(preview.locator('.xped-step-crumb')).toContainText(fixture.exp.modules[0].title.en);
  const choice=plan.data.suggestions[0].label.en;
  await preview.getByRole('button',{name:choice}).click();
  await preview.locator('textarea').fill('A considered response');
  await preview.getByRole('button',{name:model.ui('en','finish')}).click();
  await expect(preview.getByRole('heading',{name:model.ui('en','myMiniPlan')})).toBeVisible();
  await expect(preview.getByRole('listitem')).toHaveText(choice);
  await expect(preview.getByText('A considered response')).toBeVisible();
  expect(responses).toBe(0);
});

test('a rejected edit remains recoverable with the explicit retry action', async ({page})=>{
  let attempts=0;
  await editorFixture(page,{saveStructure(route,body){
    if (++attempts===1) return route.fulfill({status:503,json:{error:'Connection interrupted'}});
    return route.fulfill({json:{expedition:{...body,revision:body.base_revision+1}}});
  }});
  await page.goto(editor);await page.locator('#el-exp-title').fill('Pending draft name');
  await expect(page.locator('#el-save-retry')).toContainText('Retry');
  await page.locator('#el-save-retry').click();
  await expect(page.locator('#el-save-state')).toHaveText('Saved');
  await expect(page.locator('#el-exp-title')).toHaveValue('Pending draft name');
  expect(attempts).toBe(2);
});

test('a saved translation survives undoing an unrelated block insertion', async ({page})=>{
  const fixture=await editorFixture(page,{saveStructure(route,body,exp){
    Object.assign(exp,body);
    return route.fulfill({json:{expedition:{...exp,revision:++exp.revision}}});
  }});
  const step=fixture.exp.modules[0].steps[0], original=step.blocks[0];
  const key='mod.'+fixture.exp.modules[0].id+'.stp.'+step.id+'.blk.'+original.id+'.statement';
  await openTranslations(page,fixture);
  await page.getByRole('tab',{name:'Create',exact:true}).click();
  await page.locator('.el-step-row').first().click();
  await page.getByRole('button',{name:'Add block at end'}).click();
  await page.locator('[data-picker-key="reflection"]').click();
  await page.locator('#el-picker-insert').click();
  await expect(page.locator('#el-canvas-card .xped-block-reflection')).toBeVisible();
  await page.getByRole('tab',{name:'Translate'}).click();
  await page.locator('[data-field-key="'+key+'"] textarea').fill('Meine Übersetzung bleibt erhalten.');
  await expect(page.locator('#el-undo-btn')).toBeHidden();
  await expect(page.locator('#el-redo-btn')).toBeHidden();
  await page.getByRole('tab',{name:'Create',exact:true}).click();
  await page.locator('#el-undo-btn').click();
  await expect.poll(()=>fixture.writes.at(-1)?.body.modules[0].steps[0].blocks.length).toBe(1);
  expect(fixture.writes.at(-1).body.modules[0].steps[0].blocks[0].data.statement.de).toBe('Meine Übersetzung bleibt erhalten.');
});

test('finishing the last missing translation offers all fields and rapid typing preserves a preview disclosure', async ({page})=>{
  const fixture=await editorFixture(page);
  const step=fixture.exp.modules[0].steps[0];
  const sources=model.createBlock('sources');
  sources.data.items[0].citation={nl:'Bron bij dit hoofdstuk',en:'Reference',de:'Quelle zum Kapitel'};
  const longText=model.createBlock('richtext');
  longText.data.body.nl=Array(45).fill('Een alinea in deze lange stap.').join('\n\n');
  step.blocks=[sources,longText];
  for (const row of model.extractTranslationRows(fixture.exp,'nl','de')) row.locObj.de=row.source||row.altSource||'Vollständig';
  sources.data.items[0].citation.de='';
  await openTranslations(page,fixture);
  await page.locator('#el-tr-filter-host button').first().click();
  await page.getByRole('menuitem',{name:'Untranslated'}).click();
  const field=page.locator('.el-tr-row textarea');
  await expect(field).toHaveCount(1);
  await field.focus();
  const disclosure=page.locator('#el-tr-preview-stage details').first();
  await disclosure.locator('summary').click();
  await field.focus();
  const preview=page.locator('#el-tr-preview-pane');
  await preview.evaluate(pane=>{pane.scrollTop=120;});
  await expect.poll(()=>preview.evaluate(pane=>pane.scrollTop)).toBe(120);
  await field.pressSequentially('Quelle zum Kapitel');
  await expect(page.locator('#el-tr-autosave')).toHaveText('Saved');
  await expect(field).toBeFocused();
  await expect(disclosure).toHaveAttribute('open','');
  await expect.poll(()=>preview.evaluate(pane=>pane.scrollTop)).toBe(120);
  await page.locator('#el-tr-next-missing').click();
  await expect(page.locator('.el-tr-complete')).toContainText('All DE fields are translated');
  await page.getByRole('button',{name:'Show all fields'}).click();
  await expect(page.locator('.el-tr-row').first()).toBeVisible();
});

test('sample peer results stay inside Preview and switching back retains the author selection', async ({page})=>{
  const fixture=await editorFixture(page);
  const step=fixture.exp.modules[1].steps[1], poll=model.createBlock('mcq');
  poll.settings.showPeerResults=true;
  step.blocks=[poll];
  const aggregates=[];
  page.on('request',req=>{if (/\/aggregates\/|\/public\/.*\/responses/.test(req.url())) aggregates.push(req.url());});
  await page.goto(editor+'?step='+step.id);
  await page.getByRole('tab',{name:'Preview'}).click();
  const pane=page.locator('#el-preview-container');
  await pane.getByRole('radio',{name:new RegExp(poll.data.options[0].label.en)}).click();
  await expect(pane.locator('.xped-peer-box')).toHaveCount(0);
  await page.locator('#el-pv-sample-peers').check();
  await expect(pane.locator('.xped-peer-box')).toContainText('24');
  await expect(pane.locator('.xped-step-crumb')).toContainText(fixture.exp.modules[1].title.en);
  await page.locator('#el-pv-sample-peers').uncheck();
  await expect(pane.locator('.xped-peer-box')).toHaveCount(0);
  await page.getByRole('tab',{name:'Create',exact:true}).click();
  await expect(page.locator('#el-canvas-card .xped-step-title')).toHaveText(step.title.en);
  expect(aggregates).toEqual([]);
});

test('a second tab explains pending edits before taking over', async ({page,context})=>{
  const second=await context.newPage();
  const firstFixture=await editorFixture(page), secondFixture=await editorFixture(second);
  Object.assign(secondFixture.exp,firstFixture.exp);
  let holder='';
  const server=structuredClone(firstFixture.exp);
  for (const tab of [page,second]) {
    await tab.route('**/api/elearning/expeditions/visual',async route=>{
      if (route.request().method()==='PUT') {
        const body=route.request().postDataJSON();
        if (body.base_revision!==server.revision) return route.fulfill({status:409,json:{error:'Changed elsewhere'}});
        Object.assign(server,body,{revision:server.revision+1});
      }
      await route.fulfill({json:{expedition:server}});
    });
  }
  const lease=async route=>{
    const req=route.request(),id=req.headers()['x-elearning-session'];
    if (!holder||holder===id||req.postDataJSON().takeover) {holder=id;return route.fulfill({json:{granted:true,lease_token:id,revision:server.revision}});}
    return route.fulfill({json:{granted:false,same_account:true,editor:{name:'Author'}}});
  };
  await page.route('**/visual/lease',lease);await second.route('**/visual/lease',lease);
  await page.goto(editor);await expect(page.locator('#el-exp-title')).toBeEnabled();
  await second.goto(editor);await expect(second.locator('#el-lease-banner')).toContainText('Save pending edits there first');
  await expect(second.locator('#el-exp-title')).toBeDisabled();
  await page.locator('#el-exp-title').fill('Updated in the first tab');
  await expect.poll(()=>server.revision).toBe(2);
  await second.locator('#el-takeover-btn').click();
  await expect(second.locator('#el-exp-title')).toHaveValue('Updated in the first tab');
  await expect(second.locator('#el-exp-title')).toBeEnabled();
  await second.locator('#el-exp-title').fill('Now edited in the second tab');
  await expect.poll(()=>server.title).toBe('Now edited in the second tab');
  expect(server.revision).toBe(3);
  await second.close();
});

test('a CSV import after a concurrent edit preserves the other language when the author returns to Create', async ({page})=>{
  const fixture=await editorFixture(page,{saveStructure(route,body,exp){
    Object.assign(exp,body);
    return route.fulfill({json:{expedition:{...exp,revision:++exp.revision}}});
  }});
  await page.goto(editor);
  await page.locator('#el-add-module-btn').click();
  await page.locator('[data-recipe=blank]').click();
  await expect.poll(()=>fixture.writes.length).toBe(1);
  await page.locator('[data-mode=translate]').click();
  Object.assign(fixture.exp.startPage.title,{en:'New English wording'});
  fixture.exp.revision++;
  await page.route('**/translations/import?target=de',route=>{
    fixture.exp.startPage.title.de='Eine neue Überschrift';
    return route.fulfill({json:{expedition:{...fixture.exp,revision:++fixture.exp.revision},appliedCount:1}});
  });
  await page.locator('#el-tr-import-csv-input').setInputFiles({
    name:'de.csv',mimeType:'text/csv',buffer:Buffer.from('field_key,target_text\nstartPage.title,Eine neue Überschrift\n')
  });
  await expect(page.locator('[data-field-key="startPage.title"] textarea')).toHaveValue('Eine neue Überschrift');
  await page.locator('[data-mode=edit]').click();
  await page.locator('#el-nav-start-page').click();
  await expect(page.locator('#el-canvas-card .xped-hero-title')).toHaveText('New English wording');
  await expect(page.locator('#el-undo-btn')).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
});

test('overlapping revisions preserve a downloadable local draft and require confirmation to use the saved version',async ({page})=>{
  const fixture=await editorFixture(page);
  const server=structuredClone(fixture.exp);
  await page.route('**/visual/lease',route=>route.fulfill({json:{granted:true,lease_token:'lease',revision:server.revision}}));
  await page.route('**/api/elearning/expeditions/visual',route=>route.request().method()==='GET'
    ? route.fulfill({json:{expedition:server}})
    : route.fulfill({status:409,json:{error:'A newer version is available.'}}));
  await page.goto(editor);
  await expect(page.locator('#el-exp-title')).toBeEnabled();
  await page.locator('#el-exp-title').fill('Local unsaved title');
  server.title='Remote title'; server.revision++;
  await page.locator('#el-save-retry').click();
  await expect(page.locator('#el-lease-banner')).toContainText('Both tabs changed');
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download my draft'}).click();
  const stream=await (await pending).createReadStream();
  const pieces=[]; for await (const part of stream) pieces.push(part);
  expect(JSON.parse(Buffer.concat(pieces)).title).toBe('Local unsaved title');
  await page.locator('#el-takeover-btn').click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator('#el-exp-title')).toHaveValue('Local unsaved title');
  await page.locator('#el-takeover-btn').click();
  await page.locator('dialog[open]').getByRole('button',{name:'Open saved version',exact:true}).click();
  await expect(page.locator('#el-exp-title')).toHaveValue('Remote title');
  await expect(page.locator('#el-exp-title')).toBeEnabled();
});

test('formatted fallback copy links to its own translation when another block uses identical wording', async ({page}) => {
  const fixture=await editorFixture(page);
  const step=fixture.exp.modules[0].steps[0];
  const formatted='Understand **persistent pain** and activity.\n\n- First idea\n- Second idea';
  const translated=model.createBlock('richtext'), missing=model.createBlock('richtext');
  translated.data.body={en:formatted,nl:'',de:formatted};
  missing.data.body={en:formatted,nl:'',de:''};
  step.blocks=[translated,missing];
  await openTranslations(page,fixture);
  const key='mod.'+fixture.exp.modules[0].id+'.stp.'+step.id+'.blk.'+missing.id+'.body';
  const field=page.locator('[data-field-key="'+key+'"] textarea');
  await field.focus();
  const stage=page.locator('#el-tr-preview-stage');
  await expect(stage.locator('[data-block-id="'+missing.id+'"] .xped-richtext-body')).toHaveAttribute('lang','en');
  await expect(stage.locator('[data-block-id="'+translated.id+'"] .el-tr-fallback-pill')).toHaveCount(0);
  await stage.getByRole('button',{name:/Translate .*Body text \(EN fallback\)/}).click();
  await expect(field).toBeFocused();
  await field.fill('Mein eigener Text');
  await expect(page.locator('#el-undo-btn')).toBeHidden();
  await expect(page.locator('#el-redo-btn')).toBeHidden();
});

test('owners can turn a learner link into an opt-in pilot and preview both choices', async ({ page }) => {
  const fixture = await editorFixture(page);
  const share = { enabled: true, collectResponses: false, token: 'local-only' };
  fixture.exp.share = share;
  const reflection = model.createBlock('reflection');
  reflection.data.prompt = { en: 'Your reflection' };
  const step = fixture.exp.modules[0].steps[0];
  step.blocks = [reflection];
  const posts = [];
  page.on('request', req => { if (req.url().includes('/public/') && req.method() === 'POST') posts.push(req.url()); });
  await page.route(sharing, route => {
    if (route.request().method() === 'POST') share.collectResponses = route.request().postDataJSON().collectResponses;
    return route.fulfill({ json: { share, grants: [], members: [] } });
  });
  await page.goto(editor + '?step=' + step.id);
  await page.locator('#el-share-btn').click();
  const collection = page.getByRole('checkbox', { name: 'Collect responses for a pilot' });
  await expect(collection).not.toBeChecked();
  await expect(page.locator('#el-share-cohort')).toBeHidden();
  await expect(page.locator('#el-share-peer-results')).toBeHidden();
  await collection.check();
  await expect(page.locator('#el-share-peer-results')).toBeVisible();
  await expect(page.locator('#el-share-enabled')).toBeChecked();
  await page.locator('#el-share-dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Preview' }).click();
  const pane = page.locator('#el-preview-container');
  for (const [choice, shares] of [['consentPrivate', false], ['consentShare', true]]) {
    await expect(pane.getByRole('textbox')).toHaveCount(0);
    await pane.getByRole('radio', { name: new RegExp(model.ui('en', choice)) }).check();
    await pane.getByRole('button', { name: model.ui('en', 'next'), exact: true }).click();
    await expect(pane.getByRole('textbox', { name: 'Your reflection' })).toHaveAccessibleDescription(shares ? model.ui('en', 'reflectionAccess') : '');
    await page.locator('#el-pv-from-step').click();
  }
  expect(posts).toEqual([]);
});
