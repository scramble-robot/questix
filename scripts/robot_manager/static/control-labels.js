/* QUESTiX controller labels. Numeric indices remain the persisted ROS contract. */
const ControlLabels = (() => {
  const buttons = {
    // Exact UART protocol order: uart_joy_driver/src/joy_line_parser.cpp.
    uart: ["A", "B", "X", "Y", "L", "R", "ZL", "ZR", "−（マイナス）", "＋（プラス）",
      "HOME", "キャプチャー", "左スティック押し込み", "右スティック押し込み"],
    // Linux DualShock layout used by the QUESTiX defaults, not device autodetection.
    // joy_node exposes device-dependent raw indices; retain explicit numbers and custom entries.
    dualshock: ["×（クロス）", "○（サークル）", "△（トライアングル）", "□（スクエア）",
      "L1", "R1", "L2", "R2", "SHARE", "OPTIONS", "PS", "L3（左スティック押し込み）",
      "R3（右スティック押し込み）", "タッチパッド押し込み"],
  };
  const axes = {
    uart: { 0: "左スティック 左右", 1: "左スティック 上下", 3: "右スティック 左右",
      4: "右スティック 上下", 6: "十字キー 左右", 7: "十字キー 上下" },
    dualshock: { 0: "左スティック 左右", 1: "左スティック 上下", 2: "L2 トリガー",
      3: "右スティック 左右", 4: "右スティック 上下", 5: "R2 トリガー",
      6: "十字キー 左右", 7: "十字キー 上下" },
  };
  const controllerNames = { uart: "UART / Switch", dualshock: "DualShock", web: "Web（ブラウザ・スマホ）" };
  const buttonKeys = new Set([
    "fire_button", "tilt_up_button_index", "tilt_down_button_index", "full_speed_button",
  ]);
  const axisKeys = new Set([
    "linear_x_axis", "linear_y_axis", "angular_z_axis", "tilt_axis", "tilt_up_axis", "tilt_down_axis",
    "left_stick_vertical_axis", "right_stick_vertical_axis", "left_axis_index", "right_axis_index",
  ]);

  function kind(key) {
    return buttonKeys.has(key) ? "button" : axisKeys.has(key) ? "axis" : null;
  }

  function valueLabel(controller, key, value) {
    const type = kind(key);
    if (type === "button") {
      const name = buttons[controller]?.[value];
      return name ? `${name}（ボタン ${value}）` : `ボタン ${value}（名前未登録）`;
    }
    if (type === "axis") {
      if (value === -1) return key.startsWith("tilt_") ? "ボタンで操作（-1）" : "使用しない（-1）";
      const name = axes[controller]?.[value];
      return name ? `${name}（軸 ${value}）` : `軸 ${value}（名前未登録）`;
    }
    if (typeof value === "boolean") return value ? "ON" : "OFF";
    return String(value);
  }

  function controllerName(controller) {
    return controllerNames[controller] || "未設定";
  }

  function options(controller, field) {
    return Array.from({ length: field.max - field.min + 1 }, (_, offset) => {
      const value = field.min + offset;
      return { value, label: valueLabel(controller, field.key, value) };
    });
  }

  function changedCount(saved, draft) {
    return Object.entries(saved).reduce((count, [node, values]) => count
      + Object.keys(values).filter((key) => values[key] !== draft[node][key]).length, 0);
  }

  // Controllers whose operator controls are edited here; the browser controller (web) has its
  // buttons fixed by its own page, so its profile (controls.web.yaml) is not editable.
  return {
    kind, valueLabel, options, changedCount, controllerName,
    controllers: Object.keys(controllerNames), editable: ["uart", "dualshock"],
  };
})();

// Allow hardware-free tests with Node's built-in test runner.
if (typeof module !== "undefined") module.exports = ControlLabels;
