import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import * as Ja from 'blockly/msg/ja';
import {javascriptGenerator} from 'blockly/javascript';
import './style.css';
import {registerQuestix, motionCategory, motionSample} from './questix.js';
Blockly.setLocale(Ja);
registerQuestix(Blockly, javascriptGenerator);
const $ = id => document.getElementById(id);
const block = type => ({kind:'block',type});
const toolbox = {kind:'categoryToolbox',contents:[motionCategory,
 {kind:'category',name:'文字・表示',categorystyle:'text_category',contents:['text_print','text','text_join','text_length'].map(block)},
 {kind:'category',name:'くり返し',categorystyle:'loop_category',contents:['controls_repeat_ext','controls_whileUntil','controls_for','controls_flow_statements'].map(block)},
 {kind:'category',name:'条件・判定',categorystyle:'logic_category',contents:['controls_if','logic_compare','logic_operation','logic_boolean','logic_negate'].map(block)},
 {kind:'category',name:'数・計算',categorystyle:'math_category',contents:['math_number','math_arithmetic','math_random_int','math_modulo'].map(block)},
 {kind:'category',name:'変数',categorystyle:'variable_category',custom:'VARIABLE'},
 {kind:'category',name:'関数',categorystyle:'procedure_category',custom:'PROCEDURE'}]};
const theme = Blockly.Theme.defineTheme('scratchInspired', {
 base: Blockly.Themes.Classic,
 blockStyles: {
 text_blocks:{colourPrimary:'#9966ff',colourSecondary:'#855cd6',colourTertiary:'#774dcb'},
 loop_blocks:{colourPrimary:'#ffab19',colourSecondary:'#ec9c13',colourTertiary:'#cf8b17'},
 logic_blocks:{colourPrimary:'#59c059',colourSecondary:'#46ad46',colourTertiary:'#389438'},
 math_blocks:{colourPrimary:'#59c059',colourSecondary:'#46ad46',colourTertiary:'#389438'},
 variable_blocks:{colourPrimary:'#ff8c1a',colourSecondary:'#ed7b0c',colourTertiary:'#db6e00'},
 procedure_blocks:{colourPrimary:'#ff6680',colourSecondary:'#ed526d',colourTertiary:'#db405c'}
 },
 categoryStyles:{text_category:{colour:'#9966ff'},loop_category:{colour:'#ffab19'},logic_category:{colour:'#59c059'},math_category:{colour:'#59c059'},variable_category:{colour:'#ff8c1a'},procedure_category:{colour:'#ff6680'}},
 componentStyles:{workspaceBackgroundColour:'#f9f9ff',toolboxBackgroundColour:'#ffffff',toolboxForegroundColour:'#575e75',flyoutBackgroundColour:'#f2f2fa',flyoutForegroundColour:'#575e75',flyoutOpacity:1,scrollbarColour:'#c5c5d6',scrollbarOpacity:0.5},
 fontStyle:{family:'system-ui, sans-serif',weight:'bold',size:12}
});
const workspace = Blockly.inject('workspace',{toolbox,theme,renderer:'zelos',trashcan:true,grid:{spacing:24,length:2,colour:'#dbe3ef',snap:true},zoom:{controls:true,wheel:true,startScale:window.innerWidth < 1000 ? 0.65 : 0.85},move:{scrollbars:true,drag:true,wheel:true}});
const sample = {blocks:{languageVersion:0,blocks:[{type:'controls_repeat_ext',x:45,y:45,inputs:{TIMES:{shadow:{type:'math_number',fields:{NUM:3}}},DO:{block:{type:'text_print',inputs:{TEXT:{shadow:{type:'text',fields:{TEXT:'こんにちは、Blockly！'}}}}}}}}]}};
const key = 'questix-blockly-playground-v1';
let worker, timer, runId = '', rosRunning = false;
const rosMode = !import.meta.env.DEV;
const api = async (path, body) => {
 const response = await fetch('/api/' + path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(2000)});
 const data = await response.json(); if(!response.ok)throw new Error(data.error || 'ROS接続エラー'); return data;
};
const trail = [];
function drawPose(pose) {
 const canvas=$('ros-map'), ctx=canvas.getContext('2d');
 if(!trail.length || Math.hypot(pose.x-trail.at(-1).x,pose.y-trail.at(-1).y)>0.015)trail.push({x:pose.x,y:pose.y});
 if(trail.length>2500)trail.shift();
 const extent=Math.max(2,...trail.map(p=>Math.max(Math.abs(p.x),Math.abs(p.y))));
 const scale=130/extent, cx=180, cy=150;
 ctx.clearRect(0,0,360,300);ctx.strokeStyle='#edf0f7';ctx.lineWidth=1;
 for(let n=-Math.ceil(extent);n<=Math.ceil(extent);n++){ctx.beginPath();ctx.moveTo(cx+n*scale,0);ctx.lineTo(cx+n*scale,300);ctx.stroke();ctx.beginPath();ctx.moveTo(0,cy+n*scale);ctx.lineTo(360,cy+n*scale);ctx.stroke();}
 ctx.strokeStyle='#855cd6';ctx.lineWidth=2;ctx.beginPath();trail.forEach((p,i)=>i?ctx.lineTo(cx+p.x*scale,cy-p.y*scale):ctx.moveTo(cx+p.x*scale,cy-p.y*scale));ctx.stroke();
 ctx.save();ctx.translate(cx+pose.x*scale,cy-pose.y*scale);ctx.rotate(-pose.yaw);ctx.fillStyle='#4c97ff';ctx.beginPath();ctx.moveTo(16,0);ctx.lineTo(-10,-10);ctx.lineTo(-6,0);ctx.lineTo(-10,10);ctx.closePath();ctx.fill();ctx.restore();
 $('pose').textContent=`X ${pose.x.toFixed(2)} m / Y ${pose.y.toFixed(2)} m / ${(pose.yaw*180/Math.PI).toFixed(0)}°`;
}
async function pollROS(){
 if(!rosMode){$('ros-state').textContent='ROS版はポート5174で起動します';return;}
 try {
  if(rosRunning)await api('heartbeat',{id:runId});
  const response=await fetch('/api/status',{signal:AbortSignal.timeout(1000)});if(!response.ok)throw Error('接続エラー');
  const state=await response.json();$('ros-state').textContent=state.connected?'● ROS接続済み · シミュレーション':'○ ROS待機中';
  drawPose(state.pose);
  $('control-mode').value=state.mode || 'blockly';
  $('run').disabled=state.mode==='controller' || rosRunning || !!worker;
  $('control-hint').textContent=state.mode==='controller'?(state.controller_armed?'コントローラー操作中 · Bで停止':'スティックを中央に戻し、Aで操作開始 · Bで停止'):'Blocklyの緑の旗で実行';
  if(rosRunning && state.id===runId){$('speech').textContent=state.running?`動作 ${state.step} / ${state.total}`:state.reason;if(!state.running){stop(state.reason);$('output').textContent+=state.reason+'\n';}}
 }catch(e){$('ros-state').textContent='○ ROS未接続';if(rosRunning)stop('ROSとの通信が途切れました');}
 setTimeout(pollROS,250);
}
$('motion-sample').onclick=()=>{stop('走行サンプルを追加しました');const bottom=workspace.getBlocksBoundingBox().bottom;const added=Blockly.serialization.blocks.append(motionSample.blocks.blocks[0],workspace);added.moveBy(0,Math.max(0,bottom)+40);workspace.centerOnBlock(added.id);refresh();};
$('control-mode').onchange=async()=>{
 const mode=$('control-mode').value;stop('操作元を切り替え中');
 try{await api('mode',{mode});$('status').textContent='操作元を切り替えました';$('speech').textContent=mode==='controller'?'スティックを中央に戻してAで開始':'緑の旗で実行';}
 catch(e){$('status').textContent=e.message;}
};
$('control-mode').disabled=!rosMode;
$('clear-trail').onclick=()=>{trail.length=0;};
pollROS();
window.addEventListener('pagehide',()=>{if(runId)fetch('/api/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:runId}),keepalive:true}).catch(()=>{});});
function stop(message) {if(runId && rosMode)api('stop',{id:runId}).catch(()=>{});rosRunning=false;if(worker)worker.terminate();worker=null;clearTimeout(timer);$('run').disabled=false;$('stop').disabled=true;if(message){$('status').textContent=message;$('speech').textContent=message;}}
function refresh(){try{$('code').textContent=javascriptGenerator.workspaceToCode(workspace);localStorage.setItem(key,JSON.stringify(Blockly.serialization.workspaces.save(workspace)));$('status').textContent='自動保存済み';}catch(e){$('status').textContent='保存・生成エラー: '+e.message;}}
try {const saved=localStorage.getItem(key);Blockly.serialization.workspaces.load(saved?JSON.parse(saved):(rosMode?motionSample:sample),workspace);}catch(e){Blockly.serialization.workspaces.load(rosMode?motionSample:sample,workspace);$('status').textContent='保存データを読み込めませんでした';}
workspace.addChangeListener(e=>{if(!e.isUiEvent)refresh();});
refresh();
new ResizeObserver(()=>Blockly.svgResize(workspace)).observe($('workspace'));
$('sample').onclick=()=>{if(!confirm('現在のブロックをサンプルに戻しますか？'))return;stop();Blockly.serialization.workspaces.load(rosMode?motionSample:sample,workspace);refresh();};
$('stop').onclick=()=>stop('停止しました');
$('run').onclick=()=>{
 stop();$('output').textContent='';$('speech').textContent='実行中…';
 let code;try{code=javascriptGenerator.workspaceToCode(workspace);}catch(e){$('output').textContent=e.message;return;}
 const source=`const plan=[]; function questixMotion(v,w,seconds){if(plan.length>=200)throw Error('動作は200個以内にしてください');plan.push({v,w,seconds});} const window = self;\nself.alert = value => self.postMessage({type:'print',value:String(value)});\ntry {\n${code}\nself.postMessage({type:'done',plan});\n} catch(e) { self.postMessage({type:'error',value:e.message}); }`;
 const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
 worker=new Worker(url);URL.revokeObjectURL(url);$('run').disabled=true;$('stop').disabled=false;$('status').textContent='実行中';
 let lines=0;
 worker.onmessage=async ({data})=>{if(data.type==='print'){if(++lines<=500){$('output').textContent+=data.value+'\n';$('speech').textContent=data.value;}else stop('出力が500行を超えたため停止しました');}else if(data.type==='error'){$('output').textContent+='エラー: '+data.value;stop('エラー');}else{
 clearTimeout(timer);if(worker)worker.terminate();worker=null;
 if(data.plan.length){
  if(!rosMode){$('output').textContent='ROS版を起動してください: ros2 launch questix_blockly simulation.launch.py → http://127.0.0.1:5174';stop('ROS版で実行できます');return;}
  const id=crypto.randomUUID();runId=id;rosRunning=true;
  try{await api('run',{id,plan:data.plan});if(runId===id && rosRunning){$('output').textContent+=`ROSに ${data.plan.length} 個の動作を送信しました。\n`;$('status').textContent='ROS実行中';}}
  catch(e){if(runId===id){$('output').textContent+=e.message;stop('実行できませんでした');}}
 }else{if(!lines)$('output').textContent='実行が完了しました（表示する出力はありません）。';stop('実行完了');}
 }};
 worker.onerror=e=>{$('output').textContent='エラー: '+e.message;stop('エラー');};
 timer=setTimeout(()=>stop('5秒を超えたため停止しました'),5000);
};
