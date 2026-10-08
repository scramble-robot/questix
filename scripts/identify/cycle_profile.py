#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""record.sh の記録から、定速区間の揺れを 1 周期ごとに重ねて「予測できる揺れか」を図にする.

目的: 床の上の低速で続く約 1.75 Hz の揺れを、実測を待たずに先回りで打ち消せるか（揺れの形が
毎周期そろっているか）を判断する。区間は /target_twist（補正前の目標）が一定の範囲で、変化から
--settle 秒を捨てる（current_stats.py と同じ区切り）。各輪・各区間について:

  - 実測速度の上向きの平均横切り（ヒステリシス付き）で周期に切り、各周期を --bins 点に揃えて
    重ねる（速度・電流・送った指令）。速度と電流は進行方向を正にそろえる（電流は区間の平均が
    正 = 進める向き。負の部分は逆トルク = ブレーキ）
  - 周波数と周期のばらつき（標準偏差 / 平均）
  - 波形の再現性 R²: 各周期が平均の波形でどれだけ説明できるか（1 に近いほど毎周期同じ形）
  - 1 周期前からの予測 R²: 「1 周期前の値がまた来る」とだけ仮定した予測の当たり具合
  - 平均の波形の最低速度、ほぼ止まっている（--stall-rpm 以下）時間 [ms/周期]、逆電流の割合
  - 電流の山から速度の山までの遅れ [ms]（慣性だけなら 1/4 周期）

出力は 1 枚の HTML（図 + 数値の表。ブラウザで開く）。表は標準出力にも出す。
bag は mcap_lite.py で読む（ROS 2 不要。record.sh の既定 = 圧縮なしの MCAP）。

使い方:
  python3 scripts/identify/cycle_profile.py ~/ident_data/ident_dev_carpet_20261008_0109/bag \\
      [他の bag ...] [--out cycle_profile.html]
"""
from __future__ import annotations

import argparse
import bisect
import html
import math
import os
import re
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mcap_lite  # noqa: E402

SIDES = ("left", "right")
SIDE_LABEL = {"left": "左輪", "right": "右輪"}


# --- 読み込み ----------------------------------------------------------------------------------

def wheel_reference_rpm(linear, angular, wheel_radius, wheel_separation):
    """車体 twist → (左, 右) の車輪 RPM（differential_kinematics::twistToWheelRpm と同じ）。"""
    circumference = 2.0 * math.pi * wheel_radius
    if not circumference > 0.0:
        return 0.0, 0.0
    v_left = linear - angular * wheel_separation / 2.0
    v_right = linear + angular * wheel_separation / 2.0
    return v_left / circumference * 60.0, -v_right / circumference * 60.0


def read_params(bag_path):
    """隣の drive_component_params_before.yaml から使う値を読む（yaml モジュール不要）。"""
    path = os.path.join(os.path.dirname(os.path.abspath(bag_path.rstrip("/"))),
                        "drive_component_params_before.yaml")
    values = {"wheel_radius": 0.05, "wheel_separation": 0.5}
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return values, False
    for key in ("wheel_radius", "wheel_separation", "velocity_damping_gain_sec",
                "velocity_lag_assist_gain", "velocity_lag_assist_overshoot_gain",
                "firmware_accel_time_0p1ms_per_rpm"):
        match = re.search(rf"^\s*{key}:\s*([-+0-9.eE]+)\s*$", text, flags=re.M)
        if match:
            values[key] = float(match.group(1))
    return values, True


def read_bag(bag_path):
    """(/target_twist の [(t, (v, w))], 輪ごとの [(t, rpm, current, command)]) を返す。"""
    topics = mcap_lite.read_topics(bag_path, ("/drive_status", "/target_twist"))
    for topic in ("/drive_status", "/target_twist"):
        if not topics[topic]:
            raise SystemExit(f"{bag_path}: {topic} がありません")
    twists = [(t * 1e-9, (float(m["linear"]["x"]), float(m["angular"]["z"])))
              for t, m in topics["/target_twist"]]
    frames = {side: [] for side in SIDES}
    last = {side: None for side in SIDES}
    for _, msg in topics["/drive_status"]:
        for side in SIDES:
            fb = msg[side]
            stamp = fb["header"]["stamp"]["sec"] + fb["header"]["stamp"]["nanosec"] * 1e-9
            # 同じフレームは publish のたびに数 µs ずれた時刻で載る（5 ms 以内は同じ）
            if stamp <= 0.0 or (last[side] is not None and abs(stamp - last[side]) < 0.005):
                continue
            last[side] = stamp
            frames[side].append((stamp, float(fb["velocity_rpm_raw"]), float(fb["current_amp"]),
                                 float(fb["target_rpm"])))
    for side in SIDES:
        frames[side].sort()
    return twists, frames


def segments(twists, settle, min_sec):
    """目標が一定の区間 [(t0, t1, (v, w))]（変化から settle 秒を捨てる、0 の区間は除く）。"""
    out = []
    i = 0
    while i < len(twists):
        j = i
        while j + 1 < len(twists) and twists[j + 1][1] == twists[i][1]:
            j += 1
        t0 = twists[i][0] + settle
        t1 = twists[j][0]
        if twists[i][1] != (0.0, 0.0) and t1 - t0 >= min_sec:
            out.append((t0, t1, twists[i][1]))
        i = j + 1
    return out


# --- 解析（純粋関数） ------------------------------------------------------------------------

def interp(times, values, t):
    """昇順の times 上で線形補間（範囲外は端の値）。"""
    k = bisect.bisect_left(times, t)
    if k <= 0:
        return values[0]
    if k >= len(times):
        return values[-1]
    t0, t1 = times[k - 1], times[k]
    if t1 == t0:
        return values[k]
    a = (t - t0) / (t1 - t0)
    return values[k - 1] + a * (values[k] - values[k - 1])


def upward_crossings(times, values, center, band):
    """center を下から上へ横切る時刻（下は center-band 未満、上は center+band 超えで確定）。"""
    out = []
    state = None  # "low" / "high"
    candidate = None
    for k, x in enumerate(values):
        if x < center - band:
            state = "low"
            candidate = None
        elif state == "low" and candidate is None and x > center and k > 0:
            prev = values[k - 1]
            a = (center - prev) / (x - prev) if x != prev else 0.0
            candidate = times[k - 1] + a * (times[k] - times[k - 1])
        if state == "low" and candidate is not None and x > center + band:
            out.append(candidate)
            state = "high"
            candidate = None
    return out


def r_squared(actual, predicted):
    """決定係数（actual の平均まわり）。分散が 0 なら None。"""
    mean = sum(actual) / len(actual)
    sst = sum((a - mean) ** 2 for a in actual)
    if sst <= 0.0:
        return None
    sse = sum((a - p) ** 2 for a, p in zip(actual, predicted))
    return 1.0 - sse / sst


def profile(samples, ref_rpm, bins=40, stall_rpm=2.0):
    """1 区間・1 輪の周期の重ね合わせと指標。samples は [(t, rpm, current, command)]。

    周期が 3 つ取れなければ cycles=[] で返す（指標は None）。
    """
    direction = 1.0 if ref_rpm >= 0.0 else -1.0
    times = [s[0] for s in samples]
    speed = [s[1] * direction for s in samples]
    current = [s[2] for s in samples]
    drive_sign = 1.0 if sum(current) >= 0.0 else -1.0
    current = [c * drive_sign for c in current]
    command = [s[3] * direction for s in samples]
    target = abs(ref_rpm)
    res = {"target": target, "n_frames": len(samples), "cycles": [], "bins": bins,
           "stall_rpm": stall_rpm}
    if len(samples) < 20:
        return res
    mean = sum(speed) / len(speed)
    p2p = max(speed) - min(speed)
    res.update(mean=mean, p2p=p2p, min_raw=min(speed),
               stall_pct=100.0 * sum(1 for v in speed if v <= stall_rpm) / len(speed),
               reverse_i_pct=100.0 * sum(1 for c in current if c < 0.0) / len(current),
               command_varies=(max(command) - min(command)) > 0.5)
    band = max(1.5, 0.1 * p2p)
    crossings = upward_crossings(times, speed, mean, band)
    periods = [b - a for a, b in zip(crossings, crossings[1:])]
    if len(periods) < 3:
        return res
    median = statistics.median(periods)
    cycles = [(a, b) for a, b in zip(crossings, crossings[1:]) if 0.5 * median <= b - a <= 2.0 * median]
    if len(cycles) < 3:
        return res
    kept = [b - a for a, b in cycles]
    period = sum(kept) / len(kept)
    res.update(period=period, freq=1.0 / period,
               period_cv=(statistics.pstdev(kept) / period) if period > 0 else None)

    def fold(values):
        out = []
        for a, b in cycles:
            out.append([interp(times, values, a + (k + 0.5) / bins * (b - a))
                        for k in range(bins)])
        return out

    spd = fold(speed)
    cur = fold(current)
    cmd = fold(command)
    mean_spd = [sum(c[k] for c in spd) / len(spd) for k in range(bins)]
    mean_cur = [sum(c[k] for c in cur) / len(cur) for k in range(bins)]
    mean_cmd = [sum(c[k] for c in cmd) / len(cmd) for k in range(bins)]
    flat = [v for c in spd for v in c]
    template = [mean_spd[k] for c in spd for k in range(bins)]
    # 1 周期前の値がまた来る、とだけ仮定した予測（区間の先頭 1 周期は予測できないので除く）
    actual, predicted = [], []
    for t, v in zip(times, speed):
        if t - period >= times[0]:
            actual.append(v)
            predicted.append(interp(times, speed, t - period))
    # 電流の山 → 速度の山の遅れ: 平均波形の巡回相互相関が最大になるずれ
    mc = sum(mean_cur) / bins
    ms = sum(mean_spd) / bins
    best_k, best = 0, -math.inf
    for k in range(bins):
        corr = sum((mean_cur[i] - mc) * (mean_spd[(i + k) % bins] - ms) for i in range(bins))
        if corr > best:
            best_k, best = k, corr
    stall_bins = sum(1 for v in mean_spd if v <= stall_rpm)
    res.update(cycles=cycles, speed_cycles=spd, current_cycles=cur, mean_speed=mean_spd,
               mean_current=mean_cur, mean_command=mean_cmd,
               template_r2=r_squared(flat, template),
               predict_r2=r_squared(actual, predicted) if len(actual) > 10 else None,
               min_mean=min(mean_spd), stall_ms=1000.0 * period * stall_bins / bins,
               current_to_speed_ms=1000.0 * period * best_k / bins)
    return res


def verdict(res):
    """(短い判定, 説明)。"""
    if not res.get("cycles"):
        return "周期なし", "周期が 3 つ以上取れない（揺れが小さい、または区間が短い）"
    r2 = res.get("template_r2")
    cv = res.get("period_cv")
    if r2 is not None and cv is not None and r2 >= 0.6 and cv <= 0.15:
        text = "予測しやすい", "毎周期ほぼ同じ形・同じ長さ。先回りの補正（周期モデル・進み補償）の候補"
    elif r2 is not None and r2 >= 0.3:
        text = "ややそろう", "形はある程度そろうが周期ごとの差も大きい。先回りは部分的にしか効かない"
    else:
        text = "不規則", "周期ごとに形が違う。先回りの補正は効きにくい"
    if res.get("stall_ms", 0.0) > 0.0:
        text = (text[0] + "・止まる区間あり",
                text[1] + f"。平均の波形でも毎周期 {res['stall_ms']:.0f} ms ほぼ止まる（引っかかり）")
    return text


# --- 図（HTML + インライン SVG。外部ライブラリなし） --------------------------------------------

def nice_ticks(lo, hi, count=5):
    """lo..hi を覆う見やすい目盛り。"""
    if hi <= lo:
        hi = lo + 1.0
    raw = (hi - lo) / count
    mag = 10 ** math.floor(math.log10(raw))
    step = min((s * mag for s in (1, 2, 2.5, 5, 10) if s * mag >= raw), default=10 * mag)
    start = math.floor(lo / step) * step
    ticks = []
    v = start
    while v <= hi + step * 0.5:
        ticks.append(round(v, 10))
        v += step
    return ticks


def _fmt(value, digits=2, none="—"):
    return none if value is None else f"{value:.{digits}f}"


def _polyline(xs, ys, cls):
    points = " ".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys))
    return f'<polyline class="{cls}" points="{points}"/>'


def _chart(res, kind, width, height):
    """速度（kind="speed"）または電流（kind="current"）の 1 枚。x は 1 周期 [ms]。"""
    left, right, top, bottom = 46, 14, 18, 22
    pw, ph = width - left - right, height - top - bottom
    bins = res["bins"]
    period_ms = res["period"] * 1000.0
    if kind == "speed":
        cycles, mean, unit = res["speed_cycles"], res["mean_speed"], "rpm"
        values = [v for c in cycles for v in c] + [res["target"]]
        if res.get("command_varies"):
            values += res["mean_command"]
        # 止まりかける区間だけ 0（停止の帯）まで見せる。止まらない高速では揺れの形を大きく見せる
        if min(values) <= max(10.0, 0.3 * res["target"]):
            values.append(0.0)
    else:
        cycles, mean, unit = res["current_cycles"], res["mean_current"], "A"
        values = [v for c in cycles for v in c] + [0.0]
    ticks = nice_ticks(min(values), max(values), 4 if kind == "current" else 5)
    lo, hi = ticks[0], ticks[-1]

    def sx(k):
        return left + (k + 0.5) / bins * pw

    def sy(v):
        return top + (hi - v) / (hi - lo) * ph

    out = [f'<svg class="chart" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
           f'role="img" aria-label="{"速度" if kind == "speed" else "電流"}の 1 周期の重ね合わせ">']
    for t in ticks:
        y = sy(t)
        out.append(f'<line class="grid" x1="{left}" x2="{left + pw}" y1="{y:.1f}" y2="{y:.1f}"/>')
        out.append(f'<text class="tick" x="{left - 6}" y="{y + 3.5:.1f}" text-anchor="end">'
                   f'{t:g}</text>')
    for q in range(5):
        x = left + q / 4 * pw
        anchor = "end" if q == 4 else "middle"
        label = f"{period_ms * q / 4:.0f}" + (" ms" if q == 4 else "")
        out.append(f'<text class="tick" x="{x:.1f}" y="{top + ph + 16}" text-anchor="{anchor}">'
                   f'{label}</text>')
    out.append(f'<text class="axis" x="{left - 6}" y="9" text-anchor="end">{unit}</text>')
    if kind == "speed" and lo <= res["stall_rpm"]:
        y0, y1 = sy(min(res["stall_rpm"], hi)), sy(max(lo, 0.0))
        out.append(f'<rect class="stall" x="{left}" y="{y0:.1f}" width="{pw}" '
                   f'height="{max(0.0, y1 - y0):.1f}"/>')
        out.append(f'<text class="note" x="{left + pw - 4}" y="{y0 - 3:.1f}" text-anchor="end">'
                   f'ほぼ停止（≤{res["stall_rpm"]:g} rpm）</text>')
    if kind == "speed":
        yt = sy(res["target"])
        out.append(f'<line class="target" x1="{left}" x2="{left + pw}" y1="{yt:.1f}" '
                   f'y2="{yt:.1f}"/>')
        out.append(f'<text class="note" x="{left + 4}" y="{yt - 4:.1f}">目標 {res["target"]:.0f}'
                   f'</text>')
    else:
        yz = sy(0.0)
        out.append(f'<line class="zero" x1="{left}" x2="{left + pw}" y1="{yz:.1f}" '
                   f'y2="{yz:.1f}"/>')
        if lo < 0.0:
            out.append(f'<text class="note" x="{left + pw - 4}" y="{yz + 12:.1f}" '
                       f'text-anchor="end">0 より下 = 逆トルク（ブレーキ）</text>')
    xs = [sx(k) for k in range(bins)]
    cls = "speed" if kind == "speed" else "current"
    for c in cycles:
        out.append(_polyline(xs, [sy(v) for v in c], f"{cls}-cycle"))
    if kind == "speed" and res.get("command_varies"):
        out.append(_polyline(xs, [sy(v) for v in res["mean_command"]], "command-mean"))
    out.append(_polyline(xs, [sy(v) for v in mean], f"{cls}-mean"))
    # ホバー: 位相ごとの値（平均と周期間の幅）
    step = pw / bins
    for k in range(bins):
        col = [c[k] for c in cycles]
        tip = (f"{period_ms * (k + 0.5) / bins:.0f} ms: 平均 {mean[k]:.1f} {unit}"
               f"（周期ごと {min(col):.1f}〜{max(col):.1f}）")
        if kind == "speed":
            tip += f" / 電流 平均 {res['mean_current'][k]:.2f} A"
        out.append(f'<rect class="hit" x="{left + k * step:.1f}" y="{top}" width="{step:.1f}" '
                   f'height="{ph}"><title>{html.escape(tip)}</title></rect>')
    out.append("</svg>")
    return "".join(out)


STYLE = """
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f3f2ef;--text-primary:#0b0b0b;
--text-secondary:#52514e;--text-muted:#6f6e69;--grid:#e4e3df;--speed:#2a78d6;--current:#eb6834;
--command:#1baf7a;--stall:#ecebe7;--border:#dcdbd6}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{
color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242422;--text-primary:#ffffff;
--text-secondary:#c3c2b7;--text-muted:#9a998f;--grid:#33332f;--speed:#3987e5;--current:#d95926;
--command:#199e70;--stall:#2c2c29;--border:#3a3a36}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242422;
--text-primary:#ffffff;--text-secondary:#c3c2b7;--text-muted:#9a998f;--grid:#33332f;
--speed:#3987e5;--current:#d95926;--command:#199e70;--stall:#2c2c29;--border:#3a3a36}
html,body{margin:0;background:var(--surface-1)}
.viz-root{background:var(--surface-1);color:var(--text-primary);padding:16px;
font:14px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;max-width:1000px;
margin:0 auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
p,li{color:var(--text-secondary)}.muted{color:var(--text-muted);font-size:12px}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin:8px 0 4px;color:var(--text-secondary)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{display:inline-block;width:22px;height:0;border-top:2px solid}
.sw.thin{border-top-width:1px;opacity:.5}.sw.dash{border-top-style:dashed}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:16px}
.panel{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;
padding:10px 10px 6px}
.panel h3{font-size:14px;margin:0 0 2px}.panel .v{font-size:13px;color:var(--text-secondary);
margin:0 0 6px}
.chart{display:block;width:100%;height:auto}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .tick,.chart .axis{fill:var(--text-muted);font-size:11px}
.chart .note{fill:var(--text-secondary);font-size:11px}
.chart .stall{fill:var(--stall)}
.chart .target{stroke:var(--text-secondary);stroke-width:1;stroke-dasharray:4 3}
.chart .zero{stroke:var(--text-muted);stroke-width:1}
.chart polyline{fill:none;stroke-linejoin:round;stroke-linecap:round}
.chart .speed-cycle{stroke:var(--speed);stroke-width:1;opacity:.28}
.chart .speed-mean{stroke:var(--speed);stroke-width:2.5}
.chart .current-cycle{stroke:var(--current);stroke-width:1;opacity:.28}
.chart .current-mean{stroke:var(--current);stroke-width:2.5}
.chart .command-mean{stroke:var(--command);stroke-width:2;stroke-dasharray:5 3}
.chart .hit{fill:transparent}.chart .hit:hover{fill:var(--text-muted);opacity:.12}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;font-size:13px;min-width:720px}
th,td{border-bottom:1px solid var(--border);padding:4px 8px;text-align:right;white-space:nowrap}
th{color:var(--text-secondary);font-weight:600}td.l,th.l{text-align:left}
"""


def render_html(reports):
    """reports: [(bag 名, params, [(区間ラベル, side, res)])] → HTML 文字列。"""
    parts = ['<!doctype html><html lang="ja"><head><meta charset="utf-8">',
             '<meta name="viewport" content="width=device-width,initial-scale=1">',
             "<title>Cycle Profile</title>", f"<style>{STYLE}</style></head><body>",
             '<div class="viz-root">', "<h1>揺れの 1 周期プロファイル</h1>",
             "<p>定速区間の揺れを 1 周期ずつ重ねた図。<b>細い線が太い線（平均）にぴったり重なるほど、"
             "毎周期同じ形 = 先回りで打ち消しやすい</b>。速度が灰色の帯に入っている時間は車輪が"
             "ほぼ止まっている（引っかかり）。電流は進める向きを正にそろえてあり、0 より下は"
             "逆トルク（ブレーキ）。線の上にカーソルを置くと位相ごとの値が出る。</p>",
             '<div class="legend">',
             '<span><i class="sw thin" style="border-color:var(--speed)"></i>速度（各周期）</span>',
             '<span><i class="sw" style="border-color:var(--speed)"></i>速度（平均）</span>',
             '<span><i class="sw dash" style="border-color:var(--text-secondary)"></i>目標</span>',
             '<span><i class="sw dash" style="border-color:var(--command)"></i>送った指令（平均、'
             "補正ありのときだけ）</span>",
             '<span><i class="sw" style="border-color:var(--current)"></i>電流（平均）</span>',
             "</div>"]
    for name, params, panels in reports:
        settings = ", ".join(f"{k}={params[k]:g}" for k in (
            "velocity_damping_gain_sec", "velocity_lag_assist_gain",
            "velocity_lag_assist_overshoot_gain", "firmware_accel_time_0p1ms_per_rpm")
            if k in params)
        parts.append(f"<h2>{html.escape(name)}</h2>")
        parts.append(f'<p class="muted">{html.escape(settings or "パラメータ記録なし")}</p>')
        parts.append('<div class="tablewrap"><table><thead><tr>'
                     '<th class="l">区間</th><th class="l">輪</th><th>周期数</th><th>周波数 Hz</th>'
                     '<th>周期のばらつき</th><th>波形の再現性 R²</th><th>1 周期前予測 R²</th>'
                     '<th>p2p rpm</th><th>最低 rpm（平均波形）</th><th>停止 ms/周期</th>'
                     '<th>逆電流 %</th><th>電流→速度 ms</th><th class="l">判定</th>'
                     "</tr></thead><tbody>")
        for label, side, res in panels:
            short, _ = verdict(res)
            cv = res.get("period_cv")
            parts.append(
                f'<tr><td class="l">{html.escape(label)}</td><td class="l">{SIDE_LABEL[side]}</td>'
                f'<td>{len(res.get("cycles", []))}</td><td>{_fmt(res.get("freq"))}</td>'
                f'<td>{"—" if cv is None else f"{100 * cv:.0f}%"}</td>'
                f'<td>{_fmt(res.get("template_r2"))}</td><td>{_fmt(res.get("predict_r2"))}</td>'
                f'<td>{_fmt(res.get("p2p"), 0)}</td><td>{_fmt(res.get("min_mean"), 1)}</td>'
                f'<td>{_fmt(res.get("stall_ms"), 0)}</td>'
                f'<td>{_fmt(res.get("reverse_i_pct"), 0)}</td>'
                f'<td>{_fmt(res.get("current_to_speed_ms"), 0)}</td>'
                f'<td class="l">{html.escape(short)}</td></tr>')
        parts.append("</tbody></table></div>")
        parts.append('<div class="grid2">')
        for label, side, res in panels:
            short, detail = verdict(res)
            parts.append('<div class="panel">')
            parts.append(f"<h3>{html.escape(label)}・{SIDE_LABEL[side]}：{html.escape(short)}</h3>")
            parts.append(f'<p class="v">{html.escape(detail)}</p>')
            if res.get("cycles"):
                parts.append(_chart(res, "speed", 460, 200))
                parts.append(_chart(res, "current", 460, 120))
            parts.append("</div>")
        parts.append("</div>")
    parts.append("<h2>判定の目安</h2><ul>"
                 "<li><b>予測しやすい</b>（再現性 R² ≥ 0.6 かつ周期のばらつき ≤ 15%）: 揺れは毎周期"
                 "ほぼ同じ。周期モデルで先回りの補正（逆位相を少し早めに出す）や進み補償が効く見込み。"
                 "</li><li><b>ややそろう</b>（R² ≥ 0.3）: 先回りは部分的。遅れを減らす（進み補償）"
                 "ほうが素直。</li><li><b>不規則</b>: 先回りは効きにくい。引っかかり（停止 ms）が"
                 "長いなら機構側の摩擦への対策が本命。</li>"
                 "<li><b>電流→速度 ms</b>: 電流の山から速度の山までの遅れ。慣性だけなら 1/4 周期。"
                 "これより長いほど、ファームの応答の遅れが大きい。</li></ul>")
    parts.append("</div></body></html>")
    return "".join(parts)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("bags", nargs="+", help="rosbag2 ディレクトリ（または .mcap）")
    ap.add_argument("--out", default="cycle_profile.html", help="出力 HTML（既定 ./cycle_profile.html）")
    ap.add_argument("--settle", type=float, default=1.0)
    ap.add_argument("--min-sec", type=float, default=2.0)
    ap.add_argument("--bins", type=int, default=40)
    ap.add_argument("--stall-rpm", type=float, default=2.0)
    args = ap.parse_args(argv)
    reports = []
    for bag in args.bags:
        params, _ = read_params(bag)
        twists, frames = read_bag(bag)
        name = os.path.basename(os.path.dirname(os.path.abspath(bag.rstrip("/")))) or bag
        panels = []
        print(f"\n=== {name}")
        print("  輪    目標rpm  周期数  周波数Hz  ばらつき  再現性R²  予測R²  p2p  最低rpm  停止ms"
              "  逆電流%  電流→速度ms  判定")
        for t0, t1, (v, w) in segments(twists, args.settle, args.min_sec):
            refs = dict(zip(SIDES, wheel_reference_rpm(v, w, params["wheel_radius"],
                                                       params["wheel_separation"])))
            kind = "旋回" if v == 0.0 else ("直進" if w == 0.0 else "走行")
            for side in SIDES:
                samples = [f for f in frames[side] if t0 <= f[0] <= t1]
                res = profile(samples, refs[side], args.bins, args.stall_rpm)
                label = f"{kind} {refs[side]:+.0f} rpm"
                panels.append((label, side, res))
                cv = res.get("period_cv")
                print(f"  {side:5s} {refs[side]:7.0f}  {len(res.get('cycles', [])):6d}"
                      f"  {_fmt(res.get('freq')):>8s}  {'—' if cv is None else f'{100 * cv:.0f}%':>8s}"
                      f"  {_fmt(res.get('template_r2')):>8s}  {_fmt(res.get('predict_r2')):>6s}"
                      f"  {_fmt(res.get('p2p'), 0):>3s}  {_fmt(res.get('min_mean'), 1):>7s}"
                      f"  {_fmt(res.get('stall_ms'), 0):>6s}  {_fmt(res.get('reverse_i_pct'), 0):>7s}"
                      f"  {_fmt(res.get('current_to_speed_ms'), 0):>11s}  {verdict(res)[0]}")
        reports.append((name, params, panels))
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(render_html(reports))
    print(f"\n図: {os.path.abspath(args.out)}（ブラウザで開く）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
