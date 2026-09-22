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
  // Numbers identify functions and remain stable when their inputs move.
  const numbers = { linear_x_axis: 1, angular_z_axis: 2, fire_button: 3,
    full_speed_button: 4, tilt_axis: 5, tilt_up_button_index: 5,
    tilt_down_button_index: 5, linear_y_axis: 6 };
  const colors = { 1: "#83dbc5", 2: "#94c7ff", 3: "#f1af88", 4: "#c5b2f5", 5: "#e7ce88", 6: "#83d5dd" };
  const shortNames = { linear_x_axis: "前進・後退", angular_z_axis: "旋回", fire_button: "射出",
    full_speed_button: "ローラー", tilt_axis: "チルト上下", tilt_up_button_index: "チルトを上げる",
    tilt_down_button_index: "チルトを下げる", linear_y_axis: "左右移動" };

  function actionLabel(key, action) { return `${numbers[key]} · ${action}`; }

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
      : { 11: "left-stick", 12: "right-stick" };
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
      return { node, key, action, number: numbers[key], value, spot: location(controller, key, value),
        label: value === null ? "未入力" : labels.valueLabel(controller, key, value),
        changed: value !== saved[node]?.[key], target: `control-${node}-${key}` };
    }).sort((a, b) => a.number - b.number);
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
      .map(([node, key, action]) => ({ id: `${node}.${key}`, node, key, action }))
      .sort((a, b) => numbers[a.key] - numbers[b.key]);
  }

  function destinations(controller, key) {
    const kind = labels.kind(key);
    return Array.from({ length: kind === "axis" ? 8 : 14 }, (_, value) => ({
      id: `${kind}:${value}`, kind, value, spot: location(controller, key, value),
      label: labels.valueLabel(controller, key, value),
    })).filter((item) => item.spot);
  }

  function planAssignment(controller, values, spot, inputId, actionId) {
    const input = inputs(controller, spot).find((item) => item.id === inputId);
    const action = input && actions(values, input.kind).find((item) => item.id === actionId);
    if (!action) throw new Error("入力と機能の組み合わせを選んでください。");
    if (action.key === "tilt_up_button_index" || action.key === "tilt_down_button_index") {
      return planTiltButton(values, action.key, input.value);
    }
    return [{ node: action.node, key: action.key, value: input.value }];
  }

  function planTiltButton(values, key, value) {
    if (!["tilt_up_button_index", "tilt_down_button_index"].includes(key)
        || !Number.isInteger(value) || value < 0 || value > 63) {
      throw new Error("チルトのボタンを選んでください。");
    }
    const other = key === "tilt_up_button_index" ? "tilt_down_button_index" : "tilt_up_button_index";
    const shot = values.shot_component || {};
    if (![key, other, "tilt_axis"].every((field) => Object.hasOwn(shot, field))) {
      throw new Error("チルト設定を読み直してください。");
    }
    if (shot[other] === value) throw new Error("チルト上・下には異なるボタンを割り当ててください。");
    // A direction edit never includes the opposite button in its patch.
    return [{ node: "shot_component", key, value },
      { node: "shot_component", key: "tilt_axis", value: -1 }];
  }

  function planTiltAssignment(settings) {
    const index = (value) => Number.isInteger(value) && value >= 0 && value <= 63;
    if (settings.mode === "axis" && index(settings.axis)) {
      return [{ node: "shot_component", key: "tilt_axis", value: settings.axis }];
    }
    if (settings.mode !== "buttons" || !index(settings.up) || !index(settings.down)) {
      throw new Error("チルトの入力を選んでください。");
    }
    if (settings.up === settings.down) throw new Error("チルト上・下には異なるボタンを割り当ててください。");
    return [
      { node: "shot_component", key: "tilt_axis", value: -1 },
      { node: "shot_component", key: "tilt_up_button_index", value: settings.up },
      { node: "shot_component", key: "tilt_down_button_index", value: settings.down },
    ];
  }

  function element(tag, attributes = {}, text = null) {
    const node = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== null) node.textContent = text;
    return node;
  }

  function draw(controller, compact, usedSpots) {
    const dual = controller === "dualshock";
    const svg = element("svg", { viewBox: compact ? "130 10 460 350" : "-95 -15 910 405", role: "group",
      "aria-label": `${dual ? "DualShock" : "Switch"} コントローラーの操作図` });
    svg.append(element("title", {}, "ボタンやスティックを選ぶと、機能の割り当てを編集できます。"));
    const defs = element("defs");
    const gradient = element("linearGradient", { id: "controller-shell", x2: "0", y2: "1" });
    gradient.append(element("stop", { offset: "0", "stop-color": "#465665" }),
      element("stop", { offset: "1", "stop-color": "#202c36" }));
    defs.append(gradient);
    svg.append(defs);
    svg.append(element("ellipse", { cx: 360, cy: 329, rx: 192, ry: 19, fill: "#060d14", opacity: ".35" }));
    svg.append(element("path", { d: "M242 112 Q207 108 193 150 L155 291 Q148 326 175 338 "
      + "Q204 351 224 323 L289 263 Q310 256 330 264 L390 264 Q410 256 431 263 "
      + "L496 323 Q516 351 545 338 Q572 326 565 291 L527 150 Q513 108 478 112 "
      + "L430 118 Q360 154 290 118 Z",
    fill: "url(#controller-shell)", stroke: "#6b7e8c", "stroke-width": 1.5 }));
    svg.append(element("path", { d: "M211 251 L181 311 Q178 321 190 320 L266 255 M509 251 L539 311 Q542 321 530 320 L454 255",
      fill: "none", stroke: "#8493a0", "stroke-width": 2, opacity: ".2" }));
    svg.append(element("text", { x: 360, y: 325, "text-anchor": "middle", fill: "#a9b8ca",
      "font-size": 10, "letter-spacing": 3 }, dual ? "DUALSHOCK" : "SWITCH / UART"));
    const spots = new Map();
    function spot(id, x, y, name, radius = 24, shape = "circle") {
      const group = element("g", { class: "map-control", "data-spot": id });
      const outline = shape === "rect"
        ? element("rect", { x: x - radius, y: y - 17, width: radius * 2, height: 34, rx: 10 })
        : element("circle", { cx: x, cy: y, r: radius });
      outline.setAttribute("class", "map-control-shape");
      outline.setAttribute("fill", "#17232e");
      outline.setAttribute("stroke", "#677986");
      outline.setAttribute("stroke-width", 1.5);
      group.append(outline);
      if (id.endsWith("-stick")) {
        group.append(element("circle", { cx: x, cy: y, r: radius - 7, fill: "#293945", stroke: "#425461", "stroke-width": 2 }),
          element("circle", { cx: x, cy: y, r: radius - 12, fill: "none", stroke: "#6c7e8a", "stroke-width": 1, opacity: ".45" }));
      }
      if (id === "dpad") {
        group.append(element("path", { d: `M${x-8} ${y-23} h16 v15 h15 v16 h-15 v15 h-16 v-15 h-15 v-16 h15 Z`,
          fill: "#354752", stroke: "#8b9ba6", "stroke-width": 1 }));
      } else {
        const faceColors = dual ? { "face-top": "#83dbc5", "face-right": "#ee9b9e", "face-bottom": "#94c7ff", "face-left": "#d0b1ee" } : {};
        group.append(element("text", { x, y: y + 5, "text-anchor": "middle",
          fill: faceColors[id] || "#e6edf2", "font-size": shape === "rect" ? 11 : name.length >= 7 ? 9 : name.length >= 4 ? 11 : 16 }, name));
      }
      svg.append(group);
      spots.set(id, { group, x, y, radius, name });
    }
    spot("left-trigger", 258, 43, dual ? "L2" : "ZL", 43, "rect");
    spot("right-trigger", 462, 43, dual ? "R2" : "ZR", 43, "rect");
    spot("left-shoulder", 258, 93, dual ? "L1" : "L", 43, "rect");
    spot("right-shoulder", 462, 93, dual ? "R1" : "R", 43, "rect");
    // Keep the central area quiet; auxiliary buttons appear when assigned.
    if (usedSpots.has("menu-left")) spot("menu-left", 330, 171, dual ? "SHARE" : "−", 20);
    if (usedSpots.has("menu-right")) spot("menu-right", 390, 171, dual ? "OPTIONS" : "+", 20);
    if (usedSpots.has("home")) spot("home", 360, 215, dual ? "PS" : "HOME", 19);
    if (!dual && usedSpots.has("capture")) spot("capture", 320, 215, "▣", 19);
    spot("left-stick", dual ? 315 : 252, dual ? 267 : 181, "L", 34);
    spot("right-stick", 405, 267, "R", 34);
    const dx = dual ? 251 : 310;
    const dy = dual ? 187 : 270;
    spot("dpad", dx, dy, "✚", 30);
    for (const [direction, x, y, label] of [
      ["top", 470, 151, dual ? "△" : "X"], ["right", 504, 185, dual ? "○" : "A"],
      ["bottom", 470, 219, dual ? "×" : "B"], ["left", 436, 185, dual ? "□" : "Y"],
    ]) spot(`face-${direction}`, x, y, label, 20);
    return { svg, spots };
  }

  function render(host, controller, values, saved, onAction, options = {}) {
    const assignments = bindings(controller, values, saved);
    const { svg, spots } = draw(controller, options.compact, new Set(assignments.map((item) => item.spot)));
    const list = document.createElement("div");
    list.className = "map-bindings";
    list.setAttribute("aria-label", "機能一覧。選択すると割り当て先のポップアップが開きます。");
    const markerBySpot = new Map();
    for (const assignment of assignments) {
      if (assignment.spot) {
        if (!markerBySpot.has(assignment.spot)) markerBySpot.set(assignment.spot, new Set());
        markerBySpot.get(assignment.spot).add(assignment.number);
      }
    }
    const cards = [];
    for (const assignment of assignments) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-binding" + (assignment.changed ? " map-binding-changed" : "");
      const number = document.createElement("span");
      number.className = "map-number";
      number.textContent = assignment.number;
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
      button.setAttribute("data-action", `${assignment.node}.${assignment.key}`);
      button.setAttribute("data-on-map", String(Boolean(assignment.spot)));
      number.setAttribute("style", `--function-color: ${colors[assignment.number]}`);
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-label", `${actionLabel(assignment.key, assignment.action)}: ${assignment.label}。割り当てを編集`);
      button.addEventListener("click", () => onAction(assignment));
      const highlight = (active) => spots.get(assignment.spot)?.group.classList.toggle("map-highlight", active);
      button.addEventListener("mouseenter", () => highlight(true));
      button.addEventListener("mouseleave", () => highlight(false));
      button.addEventListener("focus", () => highlight(true));
      button.addEventListener("blur", () => highlight(false));
      list.append(button);
      cards.push({ button, assignment });
    }
    const calloutRows = new Map();
    for (const left of [true, false]) {
      const side = assignments.filter((item) => item.spot && (spots.get(item.spot).x < 360) === left)
        .sort((a, b) => spots.get(a.spot).y - spots.get(b.spot).y);
      let previous = -20;
      side.forEach((item, index) => {
        const y = Math.min(Math.max(spots.get(item.spot).y, previous + 52), 350 - (side.length - index - 1) * 52);
        calloutRows.set(`${item.node}.${item.key}`, y);
        previous = y;
      });
    }
    for (const [id, assignedNumbers] of markerBySpot) {
      const { group, x, y, radius } = spots.get(id);
      const mapped = cards.filter((card) => card.assignment.spot === id);
      group.classList.add("map-assigned");
      if (mapped.some((card) => card.assignment.changed)) group.classList.add("map-changed");
      [...assignedNumbers].forEach((number, index) => {
        const badgeIndex = x < 360 ? assignedNumbers.size - index - 1 : index;
        const badgeX = x + (x < 360 ? -1 : 1) * (radius - 4 + badgeIndex * 24);
        const assignment = mapped.find((card) => card.assignment.number === number).assignment;
        const actionId = `${assignment.node}.${assignment.key}`;
        // Siblings, not nested buttons: each number edits its own function.
        const badge = element("g", { class: "map-function", role: "button", tabindex: "0",
          "data-map-function": actionId, "aria-haspopup": "dialog",
          "aria-label": `${actionLabel(assignment.key, assignment.action)}。割り当て先を編集` });
        badge.classList.toggle("map-function-changed", assignment.changed);
        badge.append(element("circle", { cx: badgeX, cy: y - 18, r: 12,
          fill: colors[number], stroke: "#122235", "stroke-width": 2 }),
        element("text", { x: badgeX, y: y - 14, fill: "#10202d",
          "text-anchor": "middle", "font-size": 12, "font-weight": "bold" }, String(number)));
        if (!options.compact) {
          const left = x < 360;
          const rowY = calloutRows.get(actionId);
          const labelX = left ? -74 : 616;
          const edgeX = left ? 105 : 605;
          const elbowX = left ? 130 : 582;
          badge.append(element("path", { d: `M${x + (left ? -radius : radius)} ${y} L${elbowX} ${rowY} H${edgeX}`,
            fill: "none", stroke: colors[number], "stroke-width": 1, opacity: ".45", "pointer-events": "none" }),
          element("rect", { x: labelX - 6, y: rowY - 27, width: 184, height: 48, rx: 9,
            fill: "transparent", class: "map-callout-hit" }),
          element("text", { x: labelX, y: rowY - 5, fill: colors[number], "font-size": 18, "font-weight": 600 }, shortNames[assignment.key]),
          element("text", { x: labelX, y: rowY + 14, fill: "#9cabb7", "font-size": 12 },
            assignment.label.replace(/（(?:軸|ボタン) \d+）/, "") + (assignment.changed ? " · 変更" : "")));
        }
        const choose = () => onAction(assignment, `[data-map-function="${actionId}"]`);
        badge.addEventListener("click", choose);
        badge.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
        });
        svg.append(badge);
      });
    }
    for (const [id, { group, name }] of spots) {
      const mapped = cards.filter((card) => card.assignment.spot === id);
      const title = id === "left-stick" ? "左スティック" : id === "right-stick" ? "右スティック"
        : id === "dpad" ? "十字キー" : name;
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-haspopup", "dialog");
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

  return { location, bindings, inputs, actions, destinations, actionLabel, planAssignment, planTiltButton, planTiltAssignment, render };
})();
if (typeof module !== "undefined") module.exports = ControllerMap;
