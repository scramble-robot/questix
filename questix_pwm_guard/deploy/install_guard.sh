#!/bin/bash
# Teacher-run protected installer entry. Does not start/enable/stop any service.
set -euo pipefail
export PATH=/usr/bin:/bin
unset BASH_ENV ENV PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH
exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C /usr/bin/python3 -I "${BASH_SOURCE[0]%/*}/install_guard.py" "${BASH_SOURCE[0]}" "$@"
