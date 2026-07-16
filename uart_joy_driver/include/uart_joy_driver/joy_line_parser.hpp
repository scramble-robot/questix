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

#ifndef UART_JOY_DRIVER__JOY_LINE_PARSER_HPP_
#define UART_JOY_DRIVER__JOY_LINE_PARSER_HPP_

#include <cstddef>
#include <cstdint>
#include <sensor_msgs/msg/joy.hpp>
#include <string>

namespace uart_joy_driver {

constexpr size_t kJoyAxisCount = 8;
constexpr size_t kJoyButtonCount = 16;
constexpr int kExpectedFunctionId = 0x01;

// Parse a 1- or 2-character hex token into a byte. Returns false on empty,
// over-length, malformed, or out-of-range (> 0xFF) input.
bool parseHexByte(const std::string& token, uint8_t& value);

// Map a raw 0..255 stick value to a normalized [-1, 1] axis. 0x80 is neutral.
// When invert is true the sign is flipped. Values whose magnitude falls below
// deadzone are snapped to 0.
double normalizeAxis(uint8_t value, bool invert, double deadzone);

// Fill joy_msg.axes[6] (horizontal) and axes[7] (vertical) from a D-pad code.
void fillDpadAxes(uint8_t dpad_value, sensor_msgs::msg::Joy& joy_msg);

// Convert one ASCII line from the receiver module into a Joy message. Accepts an
// optional "key:" prefix before the payload, and either a 7-token data frame or
// an 8-token frame led by the expected function id. Returns false on any
// malformed frame. Does not set joy_msg.header.stamp.
bool parseControllerLine(const std::string& line, double deadzone, sensor_msgs::msg::Joy& joy_msg);

}  // namespace uart_joy_driver

#endif  // UART_JOY_DRIVER__JOY_LINE_PARSER_HPP_
