// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef FAKES__LGPIO_H_
#define FAKES__LGPIO_H_
// Link-time fake declarations. This test never links the real lgpio library.
int lgGpiochipOpen(int chip);
int lgGpioClaimOutput(int handle, int flags, int pin, int level);
int lgTxServo(int handle, int pin, int width, int frequency, int offset, int cycles);
int lgGpioWrite(int handle, int pin, int level);
int lgGpiochipClose(int handle);
#endif  // FAKES__LGPIO_H_
