import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import Blockly from 'blockly/core';
import 'blockly/blocks';
import * as Ja from 'blockly/msg/ja';
import {javascriptGenerator} from 'blockly/javascript';
import {registerQuestix, motionSample} from './questix.js';
Blockly.setLocale(Ja);
registerQuestix(Blockly, javascriptGenerator);
function planFor(state) {
  const workspace = new Blockly.Workspace();
  try {
    Blockly.serialization.workspaces.load(state, workspace);
    const plan=[];
    vm.runInNewContext(javascriptGenerator.workspaceToCode(workspace), {
      questixMotion: (v,w,seconds) => plan.push({v,w,seconds}),
    }, {timeout:1000});
    return plan;
  } finally {workspace.dispose();}
}
test('four-sided sample produces ordered forward, wait, left-turn, wait commands',()=>{
  const plan=planFor(motionSample);
  assert.equal(plan.length,16);
  assert.equal(plan.reduce((s,p)=>s+p.seconds,0),20);
  for(let i=0;i<16;i+=4){
    assert.deepEqual(plan[i],{v:0.3,w:0,seconds:2});
    assert.deepEqual(plan[i+1],{v:0,w:0,seconds:0.5});
    assert.equal(plan[i+2].v,0);
    assert.equal(plan[i+2].w,Math.PI/4);
  }
});
test('reverse and right turn have negative velocities',()=>{
  for(const [type,field] of [['questix_drive','v'],['questix_turn','w']]){
    const plan=planFor({blocks:{languageVersion:0,blocks:[{type,fields:{DIR:'-1'}}]}});
    assert.ok(plan[0][field]<0);
  }
});
