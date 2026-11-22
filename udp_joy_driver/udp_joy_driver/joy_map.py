"""Map bundle controls to the UART Switch2-native Joy layout."""

# Joy index -> bundle button bit; BACK=8, GUIDE=12 in the bundle.
BUTTON_BITS = (2, 1, 3, 0, 4, 5, 6, 7, 8, 9, 12, 13, 10, 11)


def neutral():
    """Return eight neutral axes and fourteen released buttons."""
    return [0.0] * 8, [0] * 14


def normalize_axis(value, deadzone):
    """Match uart_joy_driver: left/up positive, strict deadzone boundary."""
    value = -max(-1.0, min(1.0, (value - 128) / 127.0))
    return 0.0 if abs(value) < deadzone else value


def map_joy(report, deadzone):
    """Return axes/buttons; triggers are buttons only, axes 2 and 5 stay zero."""
    axes, buttons = neutral()
    for index, value in zip((0, 1, 3, 4), report.axes):
        axes[index] = normalize_axis(value, deadzone)
    if report.dpad is not None:
        axes[6] = float(bool(report.dpad & 4)) - float(bool(report.dpad & 8))
        axes[7] = float(bool(report.dpad & 1)) - float(bool(report.dpad & 2))
    else:
        axes[6] = float(report.hat in (5, 6, 7)) - float(report.hat in (1, 2, 3))
        axes[7] = float(report.hat in (0, 1, 7)) - float(report.hat in (3, 4, 5))
    buttons = [int(bool(report.buttons & (1 << bit))) for bit in BUTTON_BITS]
    return axes, buttons
