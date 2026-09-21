export function registerQuestix(Blockly, javascriptGenerator) {
javascriptGenerator.addReservedWords('questixMotion');
Blockly.defineBlocksWithJsonArray([
 {type:'questix_drive',message0:'%1 速度 %2 m/s で %3 秒',args0:[{type:'field_dropdown',name:'DIR',options:[['前進する','1'],['後退する','-1']]},{type:'field_number',name:'SPEED',value:0.3,min:0.05,max:0.8,precision:0.05},{type:'field_number',name:'SECONDS',value:2,min:0.1,max:10,precision:0.1}],previousStatement:null,nextStatement:null,colour:'#4c97ff',tooltip:'QUESTiXのROSシミュレーションを前後に動かします。'},
 {type:'questix_turn',message0:'%1 速度 %2 度/秒で %3 秒',args0:[{type:'field_dropdown',name:'DIR',options:[['左に回転する','1'],['右に回転する','-1']]},{type:'field_number',name:'SPEED',value:45,min:10,max:85,precision:1},{type:'field_number',name:'SECONDS',value:2,min:0.1,max:10,precision:0.1}],previousStatement:null,nextStatement:null,colour:'#4c97ff',tooltip:'その場で回転します。加減速があるため回転角度は目安です。'},
 {type:'questix_wait',message0:'停止して %1 秒待つ',args0:[{type:'field_number',name:'SECONDS',value:1,min:0.1,max:10,precision:0.1}],previousStatement:null,nextStatement:null,colour:'#4c97ff'}
]);
javascriptGenerator.forBlock.questix_drive=b=>`questixMotion(${Number(b.getFieldValue('DIR'))*Number(b.getFieldValue('SPEED'))}, 0, ${Number(b.getFieldValue('SECONDS'))});\n`;
javascriptGenerator.forBlock.questix_turn=b=>`questixMotion(0, ${Number(b.getFieldValue('DIR'))*Number(b.getFieldValue('SPEED'))*Math.PI/180}, ${Number(b.getFieldValue('SECONDS'))});\n`;
javascriptGenerator.forBlock.questix_wait=b=>`questixMotion(0, 0, ${Number(b.getFieldValue('SECONDS'))});\n`;
}
export const motionCategory={kind:'category',name:'QUESTiX',colour:'#4c97ff',contents:['questix_drive','questix_turn','questix_wait'].map(type=>({kind:'block',type}))};
const pause = () => ({type:'questix_wait',fields:{SECONDS:0.5}});
const turn = {type:'questix_turn',fields:{DIR:'1',SPEED:45,SECONDS:2},next:{block:pause()}};
const middlePause=pause();middlePause.next={block:turn};
const drive={type:'questix_drive',fields:{DIR:'1',SPEED:0.3,SECONDS:2},next:{block:middlePause}};
export const motionSample={blocks:{languageVersion:0,blocks:[{
 type:'controls_repeat_ext',x:28,y:30,
 inputs:{TIMES:{shadow:{type:'math_number',fields:{NUM:4}}},DO:{block:drive}}
}]}};
