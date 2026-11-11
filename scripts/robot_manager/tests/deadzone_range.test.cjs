const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(new URL('../static/controls.js', `file://${__filename}`), 'utf8');
const context = vm.createContext({
  document: { addEventListener() {} },
  TuningModel: require('../static/tuning-model.js'),
});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);

test('saved deadzones, including inactive drivers, share warnings without altering speed policy', () => {
  run(`controlProfile = { controller: 'dualshock', groups: [
    {node:'joy_node',fields:[{key:'deadzone',min:0.05,max:0.99}]},
    {node:'uart_joy_driver',fields:[{key:'deadzone',min:0.05,max:0.99}]},
    {node:'joy_controller',fields:[{key:'angular_input_ratio',min:-6,max:6}]}
  ] }`);
  const issues = JSON.parse(run(`JSON.stringify(tuningRangeIssues({
    joy_node:{deadzone:0},uart_joy_driver:{deadzone:0.049},
    joy_controller:{angular_input_ratio:-10}}))`));
  assert.deepEqual(issues.map(i => [i.node, i.value]),
    [['joy_node',0],['uart_joy_driver',0.049],['joy_controller',-10]]);
  assert.equal(run(`tuningRangeIssues({joy_node:{deadzone:0.05},
    uart_joy_driver:{deadzone:0.05},joy_controller:{angular_input_ratio:-6}}).length`),0);
  assert.equal(run(`tuningFields.joy_node.deadzone.scale`),100);
  assert.match(run(`tuningRangeMessage({key:'deadzone',value:0,min:0.05,max:0.99})`), /スティックの遊び 0%.*5%/);
  for(const node of ['joy_node','uart_joy_driver']) {
    const help=run(`tuningFields.${node}.deadzone.help`);
    assert.match(help,/5%/); assert.match(help,/10%/);
    assert.match(help,/止まらない・動き出さない/);
  }
});


test('percent warnings and inactive-driver repair fields display 0.049 as 4.9', () => {
  assert.match(run(`tuningRangeMessage({key:'deadzone',value:0.049,min:0.05,max:0.99})`), /4\.9%/);
  function element() {
    return { children: [], classList: { toggle() {} },
      appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; }, addEventListener() {},
      setAttribute(name, value) { this[name] = value; } };
  }
  const host = element();
  context.document = { getElementById: () => host, createElement: element };
  run(`controlProfile = {controller:'dualshock',groups:[
    {node:'joy_node',label:'ゲームパッドの入力',fields:[{key:'deadzone',min:0.05,max:0.99}]},
    {node:'uart_joy_driver',label:'UART 入力',fields:[{key:'deadzone',min:0.05,max:0.99}]}
  ],values:{joy_node:{deadzone:0.1},uart_joy_driver:{deadzone:0.049}}};
  controlDraft = controlProfile.values;
  createRangeWarning();`);
  const input = host.children.flatMap(child => child.children).find(child => child.type === 'number');
  assert.equal(String(input.value), '4.9');
});
