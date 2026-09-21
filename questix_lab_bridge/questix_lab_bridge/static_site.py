"""Serve the QUESTiX LAB static site from the bridge port (plain HTTP GET only).

Opening ``http://<robot>:8897/`` in a browser then shows the teaching material, and the
page connects back to the same port over WebSocket. Pure functions, no ROS or asyncio.
"""

import mimetypes
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

LAB_RELATIVE = Path('scripts') / 'robot_manager' / 'static' / 'lab'

# mimetypes depends on the host's mime.types; module scripts are refused by browsers
# unless they are served as JavaScript, so pin what the site needs.
_CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.bin': 'application/octet-stream',
}

_NO_SITE_TEXT = (
    'QUESTiX LAB bridge: this port is the read-only WebSocket for the teaching material.\n'
    'The material itself was not found on this machine, so there is no page to show here.\n'
    'Set the "lab_dir" parameter to the directory that contains its index.html\n'
    '(scripts/robot_manager/static/lab in the QUESTiX repository), or open the material\n'
    'from robot_manager (http://localhost:8888/lab/) and connect to ws://<this host>:<port>.\n'
)


def find_lab_dir(configured=''):
    """Return the directory holding the site's index.html, or None.

    Order: the ``lab_dir`` parameter; otherwise every directory above this module, both as
    the repository root itself (``--symlink-install``, or a build inside the repository) and
    as a colcon workspace holding it under ``src/``; then ``$ROBOT_WS/src/*``; then the copy
    that ``scripts/install-robot-manager.sh`` places under /opt/questix_robot.
    """
    candidates = []
    if configured:
        candidates.append(Path(configured).expanduser())
    else:
        for parent in Path(__file__).resolve().parents:
            candidates.append(parent / LAB_RELATIVE)
            candidates += sorted(parent.glob('src/*/' + str(LAB_RELATIVE)))
        workspace = os.environ.get('ROBOT_WS')
        if workspace:
            candidates += sorted(Path(workspace).glob('src/*/' + str(LAB_RELATIVE)))
        candidates.append(Path('/opt/questix_robot/robot_manager/static/lab'))
    for candidate in candidates:
        if (candidate / 'index.html').is_file():
            return candidate.resolve()
    return None


def static_response(root, target):
    """Map a request target to ``(status, headers, body)``.

    ``root`` is None when the site was not found. Paths are resolved and must stay
    inside ``root``; anything else is a 404 rather than an error.
    """
    if root is None:
        return _text(404, _NO_SITE_TEXT)
    relative = unquote(urlsplit(target).path).lstrip('/')
    path = (root / relative).resolve()
    if path.is_dir():
        path = path / 'index.html'
    if root not in path.parents or not path.is_file():
        return _text(404, 'Not found.\n')
    content_type = (_CONTENT_TYPES.get(path.suffix.lower())
                    or mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
    return 200, _headers(content_type), path.read_bytes()


def _headers(content_type):
    return [
        ('Content-Type', content_type),
        ('X-Content-Type-Options', 'nosniff'),
        # Lessons are edited in place; always revalidate instead of serving stale modules.
        ('Cache-Control', 'no-cache'),
    ]


def _text(status, text):
    return status, _headers('text/plain; charset=utf-8'), text.encode('utf-8')
