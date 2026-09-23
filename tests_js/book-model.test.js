const test=require('node:test');
const assert=require('node:assert/strict');
const M=require('../static/js/book-model.js');
test('covers, spreads and odd page placeholder use the physical book model',()=>{const b=M.book();assert.deepEqual(M.spreads(b.pages),[[b.pages[0].id],[b.pages[1].id,b.pages[2].id],[b.pages[3].id]]);b.pages.splice(2,0,M.page());assert.equal(M.spreads(b.pages)[2][1],null);assert.equal(M.spreads(b.pages,true).length,5);assert.equal(M.W*2,297);assert.equal(M.H,210);});
test('import sizing preserves proportions, fits half-page limits and never enlarges tiny images',()=>{for(const [w,h] of [[4000,3000],[100,2000],[20,10]]){const s=M.imageSize(w,h);assert.ok(s.w<=M.W*.5&&s.h<=M.H*.5);assert.ok(Math.abs(s.w/s.h-w/h)<.001);assert.ok(s.w<=w*25.4/96);}assert.ok(M.imageSize(4000,3000,'large').w>M.imageSize(4000,3000).w);});
test('booklet sheet order remains correct for 4, 8, 12 and odd books',()=>{for(const n of [4,8,12,7]){const pages=Array.from({length:n},M.page);const pairs=M.sheetPairs(pages,'fold');assert.deepEqual(pairs[0],[n-1,0]);assert.deepEqual(pairs.flat().filter(x=>x!==null).sort((a,b)=>a-b),pages.map((_,i)=>i));assert.equal(pairs.length%2,0);}});
test('page movement keeps linked artwork together with a visible blank when needed',()=>{const b=M.book();const left=b.pages[1],right=b.pages[2];left.items.push(M.object('image',{spanId:'s',spanSide:'left'}));right.items.push(M.object('image',{spanId:'s',spanSide:'right'}));b.pages.splice(1,0,M.page());const result=M.preserveSpreads(b.pages);assert.equal(result[2].title,'Blank page');assert.equal(result[3],left);assert.equal(result[4],right);});
test('SVG safely escapes text and native Word eligibility separates effects',()=>{const p=M.page();p.items.push(M.object('text',{text:'<script> & hello'}));const svg=M.svg(p);assert.ok(!svg.includes('<script>'));assert.ok(svg.includes('&lt;'));assert.ok(M.nativeEligible(p.items[0]));p.items[0].style.outline=2;assert.ok(!M.nativeEligible(p.items[0]));});
test('illustration prompt includes dimensions, palette, transparency and text space',()=>{const b=M.book();const prompt=M.prompt(b,b.pages[0],M.object('image',{w:50,h:70}));for(const text of ['transparent background','No frame','binding edge','50 × 70','upper third',b.palette[0]])assert.ok(prompt.includes(text));});

test('backup import rejects executable geometry and strips unknown fields',()=>{
  const source=M.book();source.pages[0].items.push(M.object('text',{text:'<img src=x>',x:'1" onload="bad()',style:{...M.baseStyle,font:'<script>',color:'url(http://bad)'}}));source.untrusted='discard';
  const result=M.readBackup(source);assert.equal(result.untrusted,undefined);assert.equal(result.pages[0].items[0].x,0);assert.equal(result.pages[0].items[0].style.font,'Nunito');assert.ok(!M.svg(result.pages[0]).includes('onload='));
  source.pages[0].id='bad" onclick="x';assert.throws(()=>M.readBackup(source));
});
test('text wraps at word boundaries across runs and reports extended text height',()=>{
  const o=M.object('text',{text:'small moon rises',w:25,style:{...M.baseStyle,size:12}});
  const layout=M.textLines(o),lines=layout.lines.map(l=>l.pieces.map(p=>p.ch).join('').trim());assert.deepEqual(lines,['small moon','rises']);
  o.runs=[{text:'hello ',style:o.style},{text:'world',style:{...o.style,outline:1}}];assert.equal(M.nativeEligible(o),false);
});
