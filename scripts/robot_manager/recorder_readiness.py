"""Read-only recorder checks and one bounded, event-triggered trial query."""

import copy
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from robot_manager import trial

TTL_SEC = 60
RETRY_SEC = 5
QUERY_SEC = 15
BUDGET_SEC = 60


def timestamp():
    """Return an unambiguous wall-clock time for display, never for expiry."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def check(code, state, message):
    """Keep stable check identifiers separate from display text."""
    return {"code": code, "state": state, "message": message}


def storage_checks(config, valid_path):
    """Inspect effective permissions and capacity without creating anything."""
    output = {"path": config.get("OUTPUT_DIR", ""), "exists": False,
              "writable": False, "creatable": False, "free_bytes": None,
              "min_free_bytes": None}
    path = Path(output["path"])
    if not valid_path.fullmatch(output["path"]):
        return output, [check("output_path", "fail", "OUTPUT_DIR が不正です")]
    try:
        minimum = int(config["MIN_FREE_GB"])
        if minimum < 0:
            raise ValueError
        output["min_free_bytes"] = minimum * 1024**3
    except (ValueError, KeyError, TypeError):
        return output, [check("free_space", "unknown", "空き容量の制限設定を確認できません")]
    try:
        # lstat also detects dangling links; stat then refuses them rather than treating
        # their parent as a usable creation destination.
        ancestor = path
        while True:
            try:
                ancestor.lstat()
                break
            except FileNotFoundError:
                if ancestor == ancestor.parent:
                    raise
                ancestor = ancestor.parent
        if not ancestor.is_dir():
            raise NotADirectoryError(str(ancestor))
        # Check traversal through every existing parent using the service's effective IDs.
        traversable = all(os.access(p, os.X_OK, effective_ids=True)
                          for p in (ancestor, *ancestor.parents))
        writable = traversable and os.access(ancestor, os.W_OK | os.X_OK, effective_ids=True)
        writable = writable and not (os.statvfs(ancestor).f_flag & os.ST_RDONLY)
        output["exists"] = ancestor == path
        output["writable"] = bool(output["exists"] and writable)
        output["creatable"] = bool(not output["exists"] and writable)
        message = "保存先に書き込めます" if output["exists"] else "保存先を作成できます"
        if not writable:
            message = ("保存先に書き込めません：" if output["exists"]
                       else "保存先を作成できません：") + str(path)
        checks = [check("output_path", "pass" if writable else "fail", message)]
        try:
            usage = shutil.disk_usage(ancestor)
        except OSError:
            return output, checks + [check("free_space", "unknown", "空き容量を確認できません")]
        output["free_bytes"] = usage.free
        low = usage.free < output["min_free_bytes"]
        checks.append(check("free_space", "fail" if low else "pass",
                            f"空き容量が足りません：{usage.free / 1024**3:.1f} GiB < {minimum} GiB"
                            if low else "空き容量は足りています"))
        return output, checks
    except (OSError, ValueError, NotImplementedError):
        return output, [check("output_path", "unknown", "保存先を確認できません：" + str(path)),
                        check("free_space", "unknown", "空き容量を確認できません")]


def source_check(runtime, timeout):
    """Check the same source candidates and exact-SHA contract with bounded git reads."""
    for candidate, _origin in trial.source_candidates(runtime.robot_ws):
        def git(args):
            result = subprocess.run(
                ["git", "-C", str(candidate), *args], capture_output=True, text=True,
                timeout=timeout(),
            )
            return result.stdout.strip() if result.returncode == 0 else None

        root = git(["rev-parse", "--show-toplevel"])
        if not root or not trial.is_questix_source(Path(root)):
            continue
        if not trial.has_exact_commit({"commit": git(["rev-parse", "HEAD"]) or ""}):
            raise HTTPException(503, "QUESTiX のソースから commit SHA を取得できません")
        return
    raise HTTPException(503, "QUESTiX のソース（git checkout）を特定できません")


class Readiness:
    """Hold one service cache, one generation and at most one trial worker."""

    def __init__(self, query, clock=time.monotonic):
        """Inject a read-only query and monotonic clock for deterministic tests."""
        self.query = query
        self.clock = clock
        self.lock = threading.Lock()
        self.service_lock = threading.Lock()
        self.service_source = lambda: "unknown"
        self.service_value = "unknown"
        self.service_at = float("-inf")
        self.observed_service = None
        self.generation = 0
        self.result = self.empty()
        self.expires = None
        self.running = False
        self.pending = False
        self.timer = None
        self.last_query = float("-inf")

    @staticmethod
    def empty(state="not_checked", message="証拠付き記録の開始条件を再確認してください"):
        """Return a complete preflight shape even before any query."""
        return {"state": state, "message": message, "checked_at": None,
                "expires_at": None, "missing_required": [], "warnings": []}

    def set_service_source(self, source):
        """Inject app's existing service reader without importing app here."""
        with self.service_lock:
            self.service_source = source
            self.service_at = float("-inf")

    def service(self, fresh=False):
        """Cache read-only state for one second; starts explicitly bypass it."""
        with self.service_lock:
            if fresh or self.clock() - self.service_at >= 1:
                try:
                    value = self.service_source()
                except Exception:  # noqa: BLE001 - unavailable state must fail closed
                    value = "unknown"
                self.service_value = value or "unknown"
                self.service_at = self.clock()
            value = self.service_value
        with self.lock:
            if self.observed_service is not None and value != self.observed_service:
                self._invalidate()
            self.observed_service = value
        return value

    def _invalidate(self):
        self.generation += 1
        self.result = self.empty()
        self.expires = None
        self.pending = False
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None

    def invalidate(self):
        """Invalidate after a successful recorder configuration save."""
        with self.lock:
            self._invalidate()

    def snapshot(self):
        """Expire a result once, without scheduling another ROS query."""
        with self.lock:
            if self.expires is not None and self.clock() >= self.expires:
                self._invalidate()
                self.result = self.empty("stale", "確認結果が古くなりました。再確認してください")
            return self.generation, copy.deepcopy(self.result)

    def request(self):
        """Coalesce explicit refreshes, retaining only the latest pending request."""
        with self.lock:
            self.pending = True
            self._schedule()

    def _schedule(self):
        if self.running or self.timer is not None or not self.pending:
            return
        # A new query replaces the old result; its old expiry must not invalidate
        # a refresh that is still running.
        self.expires = None
        delay = RETRY_SEC - (self.clock() - self.last_query)
        if delay > 0:
            self.result = self.empty("checking", "開始条件を再確認しています")
            self.timer = threading.Timer(delay, self._scheduled)
            self.timer.daemon = True
            self.timer.start()
            return
        self.pending = False
        self.running = True
        self.last_query = self.clock()
        generation = self.generation
        self.result = self.empty("checking", "開始条件を確認しています")
        threading.Thread(target=self._run, args=(generation,), daemon=True).start()

    def _scheduled(self):
        with self.lock:
            self.timer = None
            self._schedule()

    def _run(self, generation):
        deadline = self.clock() + BUDGET_SEC

        def timeout():
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise subprocess.TimeoutExpired("readiness", BUDGET_SEC)
            return min(QUERY_SEC, remaining)

        try:
            result = self.query(timeout)
            timeout()  # Do not publish success after the total budget expired.
        except HTTPException as exc:
            result = self.empty("error", str(exc.detail))
        except (OSError, subprocess.SubprocessError, ValueError):
            result = self.empty("error", "ROS環境・ソースの開始条件を確認できません（再確認してください）")
        except Exception:  # noqa: BLE001 - a worker failure must not leave checking forever
            result = self.empty("error", "開始条件の確認に失敗しました。再確認してください")
        now = datetime.now(timezone.utc)
        result["checked_at"] = now.isoformat(timespec="milliseconds")
        result["expires_at"] = datetime.fromtimestamp(now.timestamp() + TTL_SEC,
                                                    timezone.utc).isoformat(timespec="milliseconds")
        with self.lock:
            if generation == self.generation:
                self.result = result
                self.expires = self.clock() + TTL_SEC
            self.running = False
            self._schedule()
