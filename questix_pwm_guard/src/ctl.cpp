// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <iostream>

#include "questix_pwm_guard/client.hpp"
int main(int argc, char** argv) {
  if (argc < 2 || argc > 3) {
    std::cerr << "usage: questix_pwm_ctl status|authorize|low [socket]\n";
    return 2;
  }
  std::string op = argv[1];
  if (op == "status")
    op = "STATUS";
  else if (op == "authorize")
    op = "AUTHORIZE";
  else if (op == "low")
    op = "LOW";
  else
    return 2;
  questix_pwm_guard::Client c;
  if (!c.connect(argc == 3 ? argv[2] : "/run/questix_pwm_guard/control.sock")) return 2;
  auto r = c.call(op);
  std::cout << "state=" << r.state << " applied_us=" << r.applied << " error=" << r.error
            << " (API state, not waveform)\n";
  return r.ok ? 0 : 1;
}
