// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once
#include <charconv>
#include <cstdint>
#include <sstream>
#include <string>
namespace questix_pwm_guard {
struct Request {
  std::string op;
  uint64_t session{0};
  uint64_t seq{0};
  int pulse{0};
};
template <class T>
bool decimal(const std::string& s, T& value) {
  if (s.empty() || s.front() == '-' || s.front() == '+') return false;
  auto r = std::from_chars(s.data(), s.data() + s.size(), value);
  return r.ec == std::errc{} && r.ptr == s.data() + s.size();
}
inline bool parse_request(const std::string& frame, Request& r) {
  std::istringstream in(frame);
  std::string version, s, q, p, extra;
  return (in >> version >> r.op >> s >> q >> p) && version == "1" && !(in >> extra) &&
         decimal(s, r.session) && decimal(q, r.seq) && decimal(p, r.pulse) &&
         (r.op == "STATUS" || r.op == "AUTHORIZE" || r.op == "LOW" || r.op == "ARM" ||
          r.op == "COMPLETE" || r.op == "COMMAND" || r.op == "SHUTDOWN" || r.op == "STOP");
}
}  // namespace questix_pwm_guard
