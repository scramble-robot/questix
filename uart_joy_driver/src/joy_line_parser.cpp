// Copyright (c) 2026 Questix Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <sstream>
#include <string>
#include <uart_joy_driver/joy_line_parser.hpp>
#include <vector>

namespace uart_joy_driver {

namespace {

std::vector<std::string> splitString(const std::string& input, char delimiter) {
  std::vector<std::string> tokens;
  std::stringstream ss(input);
  std::string token;

  while (std::getline(ss, token, delimiter)) {
    tokens.push_back(token);
  }

  return tokens;
}

}  // namespace

bool parseHexByte(const std::string& token, uint8_t& value) {
  if (token.empty() || token.size() > 2) {
    return false;
  }

  char* end_ptr = nullptr;
  const uint64_t parsed = static_cast<uint64_t>(std::strtoul(token.c_str(), &end_ptr, 16));
  if (end_ptr == nullptr || *end_ptr != '\0' || parsed > 0xFFUL) {
    return false;
  }

  value = static_cast<uint8_t>(parsed);
  return true;
}

double normalizeAxis(uint8_t value, bool invert, double deadzone) {
  double normalized = (static_cast<int>(value) - 128) / 127.0;
  normalized = std::clamp(normalized, -1.0, 1.0);
  if (invert) {
    normalized = -normalized;
  }
  if (std::abs(normalized) < deadzone) {
    normalized = 0.0;
  }
  return normalized;
}

void fillDpadAxes(uint8_t dpad_value, sensor_msgs::msg::Joy& joy_msg) {
  // Right-hand coordinate frame: D-pad left = +1, right = -1.
  // 右手座標系: 十字キー左を +1、右を -1 として出力します。
  double horizontal = 0.0;
  double vertical = 0.0;

  switch (dpad_value) {
    case 1:
      vertical = 1.0;
      break;
    case 2:
      horizontal = -1.0;
      vertical = 1.0;
      break;
    case 3:
      horizontal = -1.0;
      break;
    case 4:
      horizontal = -1.0;
      vertical = -1.0;
      break;
    case 5:
      vertical = -1.0;
      break;
    case 6:
      horizontal = 1.0;
      vertical = -1.0;
      break;
    case 7:
      horizontal = 1.0;
      break;
    case 8:
      horizontal = 1.0;
      vertical = 1.0;
      break;
    default:
      break;
  }

  joy_msg.axes[6] = static_cast<float>(horizontal);
  joy_msg.axes[7] = static_cast<float>(vertical);
}

bool parseControllerLine(const std::string& line, double deadzone, sensor_msgs::msg::Joy& joy_msg) {
  std::string payload = line;
  const auto separator_pos = payload.find(':');
  if (separator_pos != std::string::npos) {
    payload = payload.substr(separator_pos + 1);
  }

  const auto tokens = splitString(payload, ',');
  size_t data_start_index = 0;
  if (tokens.size() == 8) {
    uint8_t function_id = 0;
    if (!parseHexByte(tokens[0], function_id) || function_id != kExpectedFunctionId) {
      return false;
    }
    data_start_index = 1;
  } else if (tokens.size() != 7) {
    return false;
  }

  uint8_t byte0 = 0;
  uint8_t byte1 = 0;
  uint8_t dpad = 0;
  uint8_t lx = 0x80;
  uint8_t ly = 0x80;
  uint8_t rx = 0x80;
  uint8_t ry = 0x80;

  if (!parseHexByte(tokens[data_start_index + 0], byte0) ||
      !parseHexByte(tokens[data_start_index + 1], byte1) ||
      !parseHexByte(tokens[data_start_index + 2], dpad) ||
      !parseHexByte(tokens[data_start_index + 3], lx) ||
      !parseHexByte(tokens[data_start_index + 4], ly) ||
      !parseHexByte(tokens[data_start_index + 5], rx) ||
      !parseHexByte(tokens[data_start_index + 6], ry)) {
    return false;
  }

  joy_msg.axes.assign(kJoyAxisCount, 0.0F);
  joy_msg.buttons.assign(kJoyButtonCount, 0);

  // Right-hand coordinate frame: stick left = +1, stick right = -1.
  // 右手座標系: スティック左を +1、右を -1 として出力します。
  joy_msg.axes[0] = static_cast<float>(normalizeAxis(lx, true, deadzone));
  joy_msg.axes[1] = static_cast<float>(normalizeAxis(ly, true, deadzone));
  joy_msg.axes[3] = static_cast<float>(normalizeAxis(rx, true, deadzone));
  joy_msg.axes[4] = static_cast<float>(normalizeAxis(ry, true, deadzone));
  fillDpadAxes(dpad, joy_msg);

  joy_msg.buttons[0] = (byte0 & 0x01) ? 1 : 0;   // A
  joy_msg.buttons[1] = (byte0 & 0x02) ? 1 : 0;   // B
  joy_msg.buttons[2] = (byte0 & 0x04) ? 1 : 0;   // X
  joy_msg.buttons[3] = (byte0 & 0x08) ? 1 : 0;   // Y
  joy_msg.buttons[4] = (byte0 & 0x10) ? 1 : 0;   // L
  joy_msg.buttons[5] = (byte0 & 0x20) ? 1 : 0;   // R
  joy_msg.buttons[6] = (byte0 & 0x40) ? 1 : 0;   // ZL
  joy_msg.buttons[7] = (byte0 & 0x80) ? 1 : 0;   // ZR
  joy_msg.buttons[8] = (byte1 & 0x01) ? 1 : 0;   // Minus
  joy_msg.buttons[9] = (byte1 & 0x02) ? 1 : 0;   // Plus
  joy_msg.buttons[10] = (byte1 & 0x04) ? 1 : 0;  // Home
  joy_msg.buttons[11] = (byte1 & 0x08) ? 1 : 0;  // Capture
  joy_msg.buttons[12] = (byte1 & 0x10) ? 1 : 0;  // LStick
  joy_msg.buttons[13] = (byte1 & 0x20) ? 1 : 0;  // RStick

  return true;
}

}  // namespace uart_joy_driver
