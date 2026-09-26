const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../static/js/book-path-editor.js');
const world = (o, p) => {
  const a = (o.rotation || 0) * Math.PI / 180, x = (p[0] - .5) * o.w, y = (p[1] - .5) * o.h;
  return {x: o.x + o.w / 2 + x * Math.cos(a) - y * Math.sin(a), y: o.y + o.h / 2 + x * Math.sin(a) + y * Math.cos(a)};
};
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-8, `${a} != ${b}`);
for (const rotation of [0, 37, -90]) test(`bends expand beyond the original box without moving other points (${rotation}°)`, () => {
  const o = {x:20,y:30,w:65,h:15,rotation,pathPoints:[[0,.5],[.5,.5],[1,.5]]};
  const target = {x:58,y:120}, next = {...o, ...P.movePoint(o,1,target)};
  for (const i of [0,2]) {const a=world(o,o.pathPoints[i]), b=world(next,next.pathPoints[i]);near(a.x,b.x);near(a.y,b.y);}
  const bend=world(next,next.pathPoints[1]);near(bend.x,target.x);near(bend.y,target.y);
  assert.ok(next.pathPoints.flat().every(v=>v>=0&&v<=1));
});
test('right-click insertion chooses closest segment in physical millimeters',()=>{
  const o={x:10,y:10,w:100,h:50,rotation:0,pathPoints:[[0,0],[.5,1],[1,0]]};
  const result=P.insertion(o,{x:88,y:30});assert.equal(result.index,2);
  assert.ok(result.point[0]>.5);assert.ok(result.point[1]>0&&result.point[1]<1);
});
