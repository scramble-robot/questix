/* QUESTiX control map: SVG and text share the same numeric Joy assignments. */
const ControllerMap = (() => {
  const labels = typeof module !== "undefined" ? require('./control-labels.js') : ControlLabels;
  const namespace = "http://www.w3.org/2000/svg";
  const fields = [
    ["joy_controller", "linear_x_axis", "前進・後退"],
    ["joy_controller", "angular_z_axis", "旋回"],
    ["joy_controller", "linear_y_axis", "左右移動（全方向のみ）"],
    ["shot_component", "fire_button", "ディスク射出"],
    ["esc_motor_control", "full_speed_button", "ローラー回転"],
  ];
  const tiltFields = [
    ["shot_component", "tilt_axis", "チルト上下"],
    ["shot_component", "tilt_up_button_index", "チルトを上げる"],
    ["shot_component", "tilt_down_button_index", "チルトを下げる"],
  ];

  function location(controller, key, value) {
    if (!Number.isInteger(value) || value < 0) return null;
    if (labels.kind(key) === "axis") {
      if (value === 0 || value === 1) return "left-stick";
      if (value === 3 || value === 4) return "right-stick";
      if (value === 6 || value === 7) return "dpad";
      if (controller === "dualshock" && value === 2) return "left-trigger";
      if (controller === "dualshock" && value === 5) return "right-trigger";
      return null;
    }
    const common = { 4: "left-shoulder", 5: "right-shoulder", 6: "left-trigger",
      7: "right-trigger", 8: "menu-left", 9: "menu-right", 10: "home" };
    const face = controller === "uart"
      ? ["face-right", "face-bottom", "face-top", "face-left"]
      : ["face-bottom", "face-right", "face-top", "face-left"];
    if (value < 4) return face[value];
    if (common[value]) return common[value];
    const extra = controller === "uart"
      ? { 11: "capture", 12: "left-stick", 13: "right-stick" }
      : { 11: "left-stick", 12: "right-stick", 13: "touchpad" };
    return extra[value] || null;
  }

  function bindings(controller, values, saved) {
    const active = fields.slice();
    if (values.shot_component?.tilt_axis === -1) {
      active.push(...tiltFields.slice(1));
    } else {
      active.push(tiltFields[0]);
    }
    return active.filter(([node, key]) => Object.hasOwn(values[node] || {}, key)).map(([node, key, action]) => {
      const value = values[node][key];
      return { node, key, action, value, spot: location(controller, key, value),
        label: value === null ? "未入力" : labels.valueLabel(controller, key, value),
        changed: value !== saved[node]?.[key], target: `control-${node}-${key}` };
    });
  }

  function inputs(controller, spot) {
    const result = [];
    for (const [kind, key, count] of [["axis", "tilt_axis", 8], ["button", "fire_button", 14]]) {
      for (let value = 0; value < count; value++) {
        if (location(controller, key, value) === spot) {
          result.push({ id: `${kind}:${value}`, kind, value,
            label: labels.valueLabel(controller, key, value) });
        }
      }
    }
    return result;
  }

  function actions(values, kind) {
    return [...fields, ...tiltFields]
      .filter(([node, key]) => labels.kind(key) === kind && Object.hasOwn(values[node] || {}, key))
      .map(([node, key, action]) => ({ id: `${node}.${key}`, node, key, action }));
  }

  function planAssignment(controller, values, spot, inputId, actionId) {
    const input = inputs(controller, spot).find((item) => item.id === inputId);
    const action = input && actions(values, input.kind).find((item) => item.id === actionId);
    if (!action) throw new Error("入力と機能の組み合わせを選んでください。");
    const changes = [{ node: action.node, key: action.key, value: input.value }];
    if (action.key === "tilt_up_button_index" || action.key === "tilt_down_button_index") {
      const other = action.key === "tilt_up_button_index" ? "tilt_down_button_index" : "tilt_up_button_index";
      if (!Object.hasOwn(values.shot_component, "tilt_axis")) throw new Error("チルト設定を読み直してください。");
      if (values.shot_component[other] === input.value) {
        throw new Error("チルト上・下には異なるボタンを割り当ててください。");
      }
      changes.push({ node: "shot_component", key: "tilt_axis", value: -1 });
    }
    return changes;
  }

  function element(tag, attributes = {}, text = null) {
    const node = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== null) node.textContent = text;
    return node;
  }

  function draw(controller) {
    const dual = controller === "dualshock";
    const svg = element("svg", { viewBox: "0 0 720 370", role: "group",
      "aria-label": `${dual ? "DualShock" : "Switch"} コントローラーの操作図` });
    svg.append(element("title", {}, "ボタンやスティックを選ぶと、機能の割り当てを編集できます。"));
    svg.append(element("path", { d: "M192 112 Q157 108 143 150 L105 291 Q98 326 125 338 "
      + "Q154 351 174 323 L239 263 Q260 256 280 264 L440 264 Q460 256 481 263 "
      + "L546 323 Q566 351 595 338 Q622 326 615 291 L577 150 Q563 108 528 112 Z",
    fill: dual ? "#293243" : "#263b47", stroke: "#78869a", "stroke-width": 2 }));
    svg.append(element("text", { x: 360, y: 325, "text-anchor": "middle", fill: "#a9b8ca",
      "font-size": 14 }, dual ? "DUALSHOCK" : "UART / SWITCH"));
    const spots = new Map();
    function spot(id, x, y, name, radius = 24, shape = "circle") {
      const group = element("g", { class: "map-control", "data-spot": id });
      const outline = shape === "rect"
        ? element("rect", { x: x - radius, y: y - 17, width: radius * 2, height: 34, rx: 10 })
        : element("circle", { cx: x, cy: y, r: radius });
      outline.setAttribute("class", "map-control-shape");
      outline.setAttribute("fill", "#101c2d");
      outline.setAttribute("stroke", "#8998ac");
      outline.setAttribute("stroke-width", 2);
      group.append(outline, element("text", { x, y: y + 5, "text-anchor": "middle",
        fill: "#f2f6fc", "font-size": shape === "rect" ? 11 : name.length >= 7 ? 9 : name.length >= 4 ? 11 : 16 }, name));
      svg.append(group);
      spots.set(id, { group, x, y, radius, name });
    }
    spot("left-trigger", 208, 43, dual ? "L2" : "ZL", 43, "rect");
    spot("right-trigger", 512, 43, dual ? "R2" : "ZR", 43, "rect");
    spot("left-shoulder", 208, 93, dual ? "L1" : "L", 43, "rect");
    spot("right-shoulder", 512, 93, dual ? "R1" : "R", 43, "rect");
    if (dual) spot("touchpad", 360, 164, "TOUCH PAD", 46, "rect");
    spot("menu-left", dual ? 288 : 310, 136, dual ? "SHARE" : "−", 20);
    spot("menu-right", dual ? 432 : 410, 136, dual ? "OPTIONS" : "+", 20);
    spot("home", dual ? 360 : 400, 231, dual ? "PS" : "HOME", 19);
    if (!dual) spot("capture", 320, 231, "▣", 19);
    spot("left-stick", dual ? 275 : 202, dual ? 267 : 181, "L", 34);
    spot("right-stick", 445, 267, "R", 34);
    const dx = dual ? 201 : 270;
    const dy = dual ? 187 : 270;
    spot("dpad", dx, dy, "✚", 30);
    for (const [direction, x, y, label] of [
      ["top", 520, 151, dual ? "△" : "X"], ["right", 554, 185, dual ? "○" : "A"],
      ["bottom", 520, 219, dual ? "×" : "B"], ["left", 486, 185, dual ? "□" : "Y"],
    ]) spot(`face-${direction}`, x, y, label, 20);
    return { svg, spots };
  }

  function render(host, controller, values, saved, onJump, options = {}) {
    const assignments = bindings(controller, values, saved);
    const { svg, spots } = draw(controller);
    const list = document.createElement("div");
    list.className = "map-bindings";
    list.setAttribute("aria-label", "操作の割り当て一覧。選択すると設定項目へ移動します。");
    const markerBySpot = new Map();
    for (const assignment of assignments) {
      if (assignment.spot && !markerBySpot.has(assignment.spot)) {
        markerBySpot.set(assignment.spot, markerBySpot.size + 1);
      }
    }
    const cards = [];
    for (const assignment of assignments) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-binding" + (assignment.changed ? " map-binding-changed" : "");
      const number = document.createElement("span");
      number.className = "map-number";
      number.textContent = markerBySpot.get(assignment.spot) || "—";
      const description = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = assignment.action;
      const value = document.createElement("span");
      value.textContent = assignment.label + (assignment.changed ? " · 変更あり" : "");
      if (!assignment.spot && Number.isInteger(assignment.value) && assignment.value >= 0) {
        value.textContent += " · 図の対象外";
      }
      description.append(title, value);
      button.append(number, description);
      button.setAttribute("aria-label", `${assignment.action}: ${assignment.label}。設定へ移動`);
      button.addEventListener("click", () => onJump(assignment.target));
      const highlight = (active) => spots.get(assignment.spot)?.group.classList.toggle("map-highlight", active);
      button.addEventListener("mouseenter", () => highlight(true));
      button.addEventListener("mouseleave", () => highlight(false));
      button.addEventListener("focus", () => highlight(true));
      button.addEventListener("blur", () => highlight(false));
      list.append(button);
      cards.push({ button, assignment });
    }
    for (const [id, number] of markerBySpot) {
      const { group, x, y, radius } = spots.get(id);
      const mapped = cards.filter((card) => card.assignment.spot === id);
      group.classList.add("map-assigned");
      if (mapped.some((card) => card.assignment.changed)) group.classList.add("map-changed");
      group.append(element("circle", { cx: x + radius - 4, cy: y - 18, r: 12,
        fill: "#61dddf", stroke: "#122235", "stroke-width": 2 }),
      element("text", { x: x + radius - 4, y: y - 14, fill: "#10202d",
        "text-anchor": "middle", "font-size": 12, "font-weight": "bold" }, String(number)));
    }
    for (const [id, { group, name }] of spots) {
      const mapped = cards.filter((card) => card.assignment.spot === id);
      const title = id === "left-stick" ? "左スティック" : id === "right-stick" ? "右スティック"
        : id === "dpad" ? "十字キー" : name;
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-pressed", String(options.selectedSpot === id));
      group.classList.toggle("map-selected", options.selectedSpot === id);
      group.setAttribute("aria-label", `${title}: ${mapped.map(({ assignment }) => assignment.action).join("、") || "割り当てなし"}。機能を編集`);
      const choose = () => options.onSelect ? options.onSelect(id, title) : mapped[0]?.button.focus();
      group.addEventListener("click", choose);
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
      });
    }
    host.replaceChildren(svg, list);
  }

  return { location, bindings, inputs, actions, planAssignment, render };
})();
if (typeof module !== "undefined") module.exports = ControllerMap;
