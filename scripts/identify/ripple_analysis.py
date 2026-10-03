#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""車輪速度の揺れを「回転に同期する成分」と「周波数が一定の成分」に分ける.

足回りの前後振動の原因（1 回転周期の機械要因 / ファーム速度ループの約 1.8 Hz 振動 / その重なり）を、
車輪を浮かせた試験と床上試験の記録から切り分けるための解析。

入力（どれか 1 つ）:
  --bag <rosbag2 dir>  /drive_control_sample（questix_msgs/DriveControlSample）があれば優先して読み、
                       無ければ /drive_status（旧 bag）を読む。ROS 2 環境（rosbag2_py）が必要。
  --csv <file>         次のどちらか（ヘッダで判別）:
                         * サンプル CSV: このスクリプトの --export-csv が /drive_control_sample から
                           書き出したもの（列 seq, left_feedback_new, ... ）
                         * QUESTiX LAB の生データ CSV（「-messages.csv」。stream 列の drive 行の
                           *_raw_rpm_native / *_target_rpm_native / *_feedback_stamp_s を使う。
                           位置が無いので回転角は速度の積分で求める。20 Hz に間引かれている）

処理:
  1. 車輪ごとにフィードバックフレームを 1 回ずつに揃える: /drive_control_sample は feedback_new と
     feedback_count で重複を除き、seq の飛びで欠落を数える。/drive_status と LAB CSV は車輪ごとの
     受信時刻（feedback stamp）が同じ行を重複として除く。
  2. 符号を前進が正にそろえる（右輪はワイヤ上で前進が負）。
  3. position_raw（0..32767 = 1 回転）の巻き戻りをつなぎ直す（区間内の速度から予測した増分に
     最も近い巻き数を選ぶので、数フレームの欠落があってもつながる）。位置が無ければ速度を積分する。
  4. 指令（ref / target）が一定で回転数が十分な区間を自動で抜き出す（定速区間）。
  5. 区間ごとに: 回転角で同期平均（速度・電流）→ 次数スペクトル（1 回転 = 1 次）、同期平均を
     引いた残りの時間スペクトル、生の時間スペクトルの卓越周波数。
  6. 区間をまたいで: 回転数と卓越周波数・振幅の表（キャンベル線図相当）、卓越周波数が回転数に
     比例するか（回転同期）一定か（ループ・構造）の判定。左右の和（前後）と差（旋回）も同様。

エンコーダの誤差による見かけの速度変動（既定: 平均速度の約 1% × 次数）を下回る成分は
「判別不能」とする（--encoder-error-pct）。周波数 f の成分の次数は f / 回転周波数なので、
閾値は pct/100 × f × 60 [rpm]（回転数によらない）。

出力: 標準出力のテキスト要約、--json に数値要約、--plot <dir> に PNG（matplotlib があるときだけ）。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys

import numpy as np

POSITION_COUNTS = 32768  # position_raw: 0..32767 <-> 0..360 deg
CURRENT_AMP_PER_RAW = 8.0 / 32767.0  # current_raw: -32767..32767 <-> -8..+8 A
SIDES = ("left", "right")
# ワイヤ上の符号 -> 前進が正（drive_component は左右を鏡像に取り付けている）
FORWARD_SIGN = {"left": 1.0, "right": -1.0}

# 定速区間の既定
MIN_SEGMENT_RPM = 10.0  # これより遅い指令の区間は使わない
SETTLE_SEC = 1.0  # 指令が変わってから捨てる時間
MIN_SEGMENT_SEC = 3.0
MIN_SEGMENT_REVS = 3.0
MAX_ORDER = 8
MIN_PEAK_HZ = 0.3  # これより下の時間スペクトルは卓越周波数の候補にしない
ENCODER_ERROR_PCT = 1.0
# 区間をまたいだ周波数の判定
CLASSIFY_REL_RMS = 0.10  # モデル（比例 / 一定）の相対 RMS 残差がこれ以下なら当てはまる
CLASSIFY_MIN_ROT_SPREAD = 1.3  # 回転周波数の最大/最小がこれ未満なら判別しない


# ----------------------------------------------------------------------------- 読み込み
def _new_wheel():
    return {"t": [], "rpm": [], "position": [], "current": [], "command": []}


def _finish(wheels, stats, source, angle_source):
    out = {}
    for side, w in wheels.items():
        arr = {k: np.asarray(v, dtype=float) for k, v in w.items()}
        order = np.argsort(arr["t"], kind="stable")
        out[side] = {k: v[order] for k, v in arr.items()}
    return {"source": source, "angle_source": angle_source, "wheels": out, "stats": stats}


def frames_from_control_samples(rows):
    """/drive_control_sample の行（dict）から、車輪ごとに新しいフレームだけを取り出す.

    rows の各要素: seq, {side}_feedback_new, {side}_feedback_count, {side}_feedback_stamp,
    {side}_velocity_rpm_raw, {side}_position_raw, {side}_current_raw, {side}_command_rpm。
    """
    wheels = {side: _new_wheel() for side in SIDES}
    stats = {"samples": len(rows), "seq_gaps": 0, "lost_samples": 0,
             "duplicates_removed": {s: 0 for s in SIDES},
             "frames_missing": {s: 0 for s in SIDES}}
    last_seq = None
    last_count = {s: None for s in SIDES}
    for row in rows:
        seq = int(row["seq"])
        if last_seq is not None and seq != last_seq + 1:
            stats["seq_gaps"] += 1
            stats["lost_samples"] += max(0, seq - last_seq - 1)
        last_seq = seq
        for side in SIDES:
            count = int(row[f"{side}_feedback_count"])
            stamp = float(row[f"{side}_feedback_stamp"])
            new = bool(int(row[f"{side}_feedback_new"])) and stamp > 0.0
            if not new or count == last_count[side]:
                stats["duplicates_removed"][side] += 1
                continue
            if last_count[side] is not None and count > last_count[side] + 1:
                # 受信はしたが、そのフレームを載せたサンプルが欠落した
                stats["frames_missing"][side] += count - last_count[side] - 1
            last_count[side] = count
            w = wheels[side]
            w["t"].append(stamp)
            w["rpm"].append(float(row[f"{side}_velocity_rpm_raw"]))
            w["position"].append(float(row[f"{side}_position_raw"]))
            w["current"].append(float(row[f"{side}_current_raw"]) * CURRENT_AMP_PER_RAW)
            w["command"].append(float(row[f"{side}_command_rpm"]))
    return _finish(wheels, stats, "drive_control_sample", "position")


def frames_from_stamped_rows(rows, source, has_position):
    """/drive_status や LAB CSV のように、車輪ごとの受信時刻で重複を判別する行から取り出す.

    rows の各要素: {side}_stamp（0 / NaN = 未受信）, {side}_rpm_raw, {side}_command,
    任意で {side}_position, {side}_current_amp。
    """
    wheels = {side: _new_wheel() for side in SIDES}
    stats = {"samples": len(rows), "duplicates_removed": {s: 0 for s in SIDES}}
    last_stamp = {s: None for s in SIDES}
    for row in rows:
        for side in SIDES:
            stamp = row.get(f"{side}_stamp")
            rpm = row.get(f"{side}_rpm_raw")
            if stamp is None or not math.isfinite(stamp) or stamp <= 0.0 or rpm is None \
                    or not math.isfinite(rpm):
                continue
            if stamp == last_stamp[side]:
                stats["duplicates_removed"][side] += 1
                continue
            last_stamp[side] = stamp
            w = wheels[side]
            w["t"].append(stamp)
            w["rpm"].append(rpm)
            w["position"].append(row.get(f"{side}_position", math.nan) if has_position
                                 else math.nan)
            w["current"].append(row.get(f"{side}_current_amp", math.nan))
            w["command"].append(row.get(f"{side}_command", math.nan))
    return _finish(wheels, stats, source, "position" if has_position else "speed_integral")


def _float(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return math.nan


SAMPLE_CSV_COLUMNS = ["stamp", "seq"] + [
    f"{side}_{name}" for side in SIDES for name in (
        "feedback_new", "feedback_count", "feedback_stamp", "velocity_rpm_raw", "position_raw",
        "current_raw", "command_rpm", "ref_rpm")]


def load_csv(path):
    """サンプル CSV か QUESTiX LAB の生データ CSV を読む（ヘッダで判別）."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        rows = list(reader)
    if "seq" in header and "left_feedback_new" in header:
        return frames_from_control_samples(rows)
    if "stream" in header and "left_raw_rpm_native" in header:
        out = []
        for row in rows:
            if row.get("stream") != "drive":
                continue
            item = {}
            for side in SIDES:
                stamp = _float(row.get(f"{side}_feedback_stamp_s"))
                if not math.isfinite(stamp):
                    stamp = _float(row.get("stamp_s"))
                item[f"{side}_stamp"] = stamp
                item[f"{side}_rpm_raw"] = _float(row.get(f"{side}_raw_rpm_native"))
                item[f"{side}_command"] = _float(row.get(f"{side}_target_rpm_native"))
                item[f"{side}_current_amp"] = _float(row.get(f"{side}_current_a"))
            out.append(item)
        return frames_from_stamped_rows(out, "lab_csv", has_position=False)
    raise SystemExit(
        f"{path}: 列から形式が分かりません（サンプル CSV か QUESTiX LAB の -messages.csv を渡す）")


def _open_bag(path):
    try:
        import rosbag2_py
        from rclpy.serialization import deserialize_message
        from rosidl_runtime_py.utilities import get_message
    except ImportError as e:
        raise SystemExit(f"rosbag2 の読み込みに ROS 2 環境が必要です: {e}")
    reader = rosbag2_py.SequentialReader()
    reader.open(rosbag2_py.StorageOptions(uri=path, storage_id=""),
                rosbag2_py.ConverterOptions("", ""))
    types = {t.name: t.type for t in reader.get_all_topics_and_types()}
    return reader, types, deserialize_message, get_message


def _stamp_sec(stamp):
    return stamp.sec + stamp.nanosec * 1e-9


def read_control_sample_rows(path, topic="/drive_control_sample"):
    """Bag の /drive_control_sample をサンプル CSV と同じ列の行（dict）にする。無ければ None."""
    reader, types, deserialize_message, get_message = _open_bag(path)
    if topic not in types:
        return None
    msg_type = get_message(types[topic])
    rows = []
    while reader.has_next():
        name, raw, _ = reader.read_next()
        if name != topic:
            continue
        m = deserialize_message(raw, msg_type)
        row = {"stamp": _stamp_sec(m.header.stamp), "seq": m.seq}
        for side in SIDES:
            w = getattr(m, side)
            row.update({
                f"{side}_feedback_new": int(w.feedback_new),
                f"{side}_feedback_count": w.feedback_count,
                f"{side}_feedback_stamp": _stamp_sec(w.feedback_stamp),
                f"{side}_velocity_rpm_raw": w.velocity_rpm_raw,
                f"{side}_position_raw": w.position_raw,
                f"{side}_current_raw": w.current_raw,
                f"{side}_command_rpm": w.command_rpm,
                f"{side}_ref_rpm": w.ref_rpm,
            })
        rows.append(row)
    return rows


def load_bag(path):
    """/drive_control_sample を優先し、無ければ /drive_status（旧 bag）から読む."""
    rows = read_control_sample_rows(path)
    if rows:
        return frames_from_control_samples(rows)
    reader, types, deserialize_message, get_message = _open_bag(path)
    topic = "/drive_status"
    if topic not in types:
        raise SystemExit(f"bag に /drive_control_sample も {topic} もありません: {list(types)}")
    msg_type = get_message(types[topic])
    if not hasattr(msg_type().left, "velocity_rpm_raw"):
        raise SystemExit("questix_msgs/MotorFeedback に velocity_rpm_raw がありません"
                         "（LPF 後の値では揺れが約半分に見えるため解析しない）")
    out = []
    while reader.has_next():
        name, raw, _ = reader.read_next()
        if name != topic:
            continue
        m = deserialize_message(raw, msg_type)
        item = {}
        for side in SIDES:
            fb = getattr(m, side)
            item[f"{side}_stamp"] = _stamp_sec(fb.header.stamp)
            item[f"{side}_rpm_raw"] = float(fb.velocity_rpm_raw)
            item[f"{side}_command"] = float(fb.target_rpm)
            item[f"{side}_position"] = float(fb.position_raw)
            item[f"{side}_current_amp"] = float(fb.current_amp)
        out.append(item)
    return frames_from_stamped_rows(out, "drive_status", has_position=True)


def export_csv(bag_path, out_path):
    """Bag の /drive_control_sample をサンプル CSV に書き出す."""
    rows = read_control_sample_rows(bag_path)
    if not rows:
        raise SystemExit("bag に /drive_control_sample がありません")
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=SAMPLE_CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


# ----------------------------------------------------------------------------- 前処理
def unwrap_position(t, position_raw, rpm):
    """position_raw の巻き戻りをつなぐ（単位: 回転、ワイヤの符号のまま）.

    各フレーム間で、速度（rpm）から予測した増分に最も近い巻き数を選ぶ。数フレームの欠落や
    0..32767 の境界をまたいでもつながる。
    """
    rev = np.empty(len(position_raw))
    if len(rev) == 0:
        return rev
    rev[0] = position_raw[0] / POSITION_COUNTS
    for k in range(1, len(rev)):
        dt = t[k] - t[k - 1]
        predicted = 0.5 * (rpm[k] + rpm[k - 1]) / 60.0 * dt  # [rev]
        delta = (position_raw[k] - position_raw[k - 1]) / POSITION_COUNTS
        wraps = round(predicted - delta)
        rev[k] = rev[k - 1] + delta + wraps
    return rev


def integrate_speed(t, rpm):
    """台形積分で回転角 [rev] を求める（位置が無いとき）."""
    rev = np.zeros(len(t))
    if len(t) > 1:
        rev[1:] = np.cumsum(0.5 * (rpm[1:] + rpm[:-1]) / 60.0 * np.diff(t))
    return rev


def forward_wheel(wheel, side, angle_source):
    """1 輪を前進が正の速度・角度・電流にする."""
    sign = FORWARD_SIGN[side]
    t = wheel["t"]
    rpm_wire = wheel["rpm"]
    if angle_source == "position" and np.all(np.isfinite(wheel["position"])) and len(t):
        rev = sign * unwrap_position(t, wheel["position"], rpm_wire)
    else:
        rev = sign * integrate_speed(t, rpm_wire)
    return {"t": t, "rpm": sign * rpm_wire, "rev": rev, "current": sign * wheel["current"],
            "command": sign * wheel["command"]}


def constant_segments(wheel, min_rpm=MIN_SEGMENT_RPM, settle=SETTLE_SEC,
                      min_sec=MIN_SEGMENT_SEC, min_revs=MIN_SEGMENT_REVS, window=None):
    """指令が一定で回転数が十分な区間（index の [start, stop)）を返す.

    区間を分ける指令は wheel["segment_command"]（左右の和・差のとき）か wheel["command"]。
    指令が無い（NaN）なら全体を 1 区間とみなす。大きな受信の途切れ（中央値の間隔の 5 倍か
    0.25 s の長い方）でも区間を切る。回転の速さは回転角の傾きで判定する（旋回成分のように
    速度の平均が 0 に近いチャンネルでも、車輪が回っていれば区間になる）。
    window=(t0, t1) を渡すとその範囲だけを 1 区間にする。
    """
    t = wheel["t"]
    if len(t) < 4:
        return []
    if window is not None:
        idx = np.nonzero((t >= window[0]) & (t <= window[1]))[0]
        return [(int(idx[0]), int(idx[-1]) + 1)] if len(idx) > 3 else []
    cmd = wheel.get("segment_command", wheel["command"])
    if not np.any(np.isfinite(cmd)):
        cmd = np.zeros(len(t))
        use_command = False
    else:
        use_command = True
    gap = max(0.25, 5.0 * float(np.median(np.diff(t))))
    bounds = [0]
    for k in range(1, len(t)):
        if (use_command and cmd[k] != cmd[k - 1]) or (t[k] - t[k - 1]) > gap:
            bounds.append(k)
    bounds.append(len(t))
    segments = []
    for start, stop in zip(bounds[:-1], bounds[1:]):
        if use_command and abs(cmd[start]) < min_rpm:
            continue
        t0 = t[start] + (settle if use_command else 0.0)
        first = int(np.searchsorted(t[start:stop], t0)) + start
        if stop - first < 4:
            continue
        duration = t[stop - 1] - t[first]
        revs = abs(wheel["rev"][stop - 1] - wheel["rev"][first])
        if duration >= min_sec and revs >= min_revs and revs / duration * 60.0 >= min_rpm:
            segments.append((first, stop))
    return segments


# ----------------------------------------------------------------------------- スペクトル
def uniform(t, values):
    """不等間隔のサンプルを中央値の間隔の一様格子に線形補間する."""
    dt = float(np.median(np.diff(t)))
    grid = np.arange(t[0], t[-1] + 1e-12, dt)
    return grid, np.interp(grid, t, values), dt


def amplitude_spectrum(values, step, pad=8):
    """Hann 窓の片側振幅スペクトル（正弦波の振幅をそのまま読める正規化）を返す."""
    x = np.asarray(values, dtype=float)
    x = x - np.mean(x)
    n = len(x)
    if n < 4:
        return np.zeros(0), np.zeros(0)
    window = np.hanning(n)
    spectrum = np.fft.rfft(x * window, n=n * pad)
    amp = 2.0 * np.abs(spectrum) / np.sum(window)
    freq = np.fft.rfftfreq(n * pad, d=step)
    return freq, amp


def dominant_peak(freq, amp, low=MIN_PEAK_HZ, high=None):
    sel = freq >= low
    if high is not None:
        sel &= freq <= high
    if not np.any(sel):
        return None
    idx = np.nonzero(sel)[0][int(np.argmax(amp[sel]))]
    return {"freq_hz": float(freq[idx]), "amp_rpm": float(amp[idx])}


def synchronous_fit(rev, values, max_order=MAX_ORDER):
    """回転角で同期平均する: 回転角の Fourier 級数（1..max_order 次）へ最小二乗で当てはめる.

    角度に一様なサンプルでの同期平均と同じものを、サンプルが角度に偏っていても（20 Hz に
    間引かれた記録、回転数と周期が近い記録）偏らずに求める。回転に同期しない揺れは多くの
    回転にわたって打ち消し合う（使う回転数が多いほど小さく残る）。
    返り値: 次数ごとの振幅のリストと、各サンプルでの同期成分（平均 0）。
    """
    phase = 2.0 * math.pi * (rev - rev[0])
    columns = [np.ones(len(rev))]
    for n in range(1, max_order + 1):
        columns += [np.cos(n * phase), np.sin(n * phase)]
    basis = np.column_stack(columns)
    coef, *_ = np.linalg.lstsq(basis, values, rcond=None)
    amps = [float(math.hypot(coef[2 * n - 1], coef[2 * n])) for n in range(1, max_order + 1)]
    return amps, basis[:, 1:] @ coef[1:]


def resolvable(freq_hz, amp_rpm, encoder_error_pct):
    """エンコーダ誤差による見かけの変動（pct% × 次数 × 平均速度 = pct/100 × f × 60）を超えるか."""
    return bool(amp_rpm > encoder_error_pct / 100.0 * freq_hz * 60.0)


def analyze_segment(wheel, start, stop, encoder_error_pct=ENCODER_ERROR_PCT):
    t = wheel["t"][start:stop]
    rpm = wheel["rpm"][start:stop]
    rev = wheel["rev"][start:stop]
    current = wheel["current"][start:stop]
    mean_rpm = float(np.mean(rpm))
    # 回転周波数は回転角の傾きから（左右の差のように速度の平均が 0 に近いチャンネルでも、
    # 同期の基準は車輪の回転）。
    slope_rps = (rev[-1] - rev[0]) / (t[-1] - t[0])
    f_rot = abs(slope_rps)
    out = {
        "t_start": float(t[0]), "t_end": float(t[-1]), "frames": int(len(t)),
        "mean_rpm": mean_rpm, "std_rpm": float(np.std(rpm)),
        "p2p_rpm": float(np.max(rpm) - np.min(rpm)), "rotation_hz": f_rot,
        "command_rpm": float(np.nanmean(wheel["command"][start:stop]))
        if np.any(np.isfinite(wheel["command"][start:stop])) else None,
    }
    grid, uniform_rpm, step = uniform(t, rpm)
    freq, amp = amplitude_spectrum(uniform_rpm, step)
    peak = dominant_peak(freq, amp)
    if peak:
        peak["order"] = peak["freq_hz"] / f_rot if f_rot > 0 else None
        peak["resolvable"] = resolvable(peak["freq_hz"], peak["amp_rpm"], encoder_error_pct)
    out["time_peak"] = peak
    # 回転角と速度の整合（位置から求めた角度のとき、カウント/回転の前提や向きの確認）。
    # 比が 1 から大きく外れたら 1 回転 = 32768 カウントの前提か巻き戻しを疑う。
    if abs(mean_rpm) > 1e-9:
        out["angle_speed_ratio"] = float(slope_rps * 60.0 / mean_rpm)

    turns = abs(rev[-1] - rev[0])
    revs = int(math.floor(turns))
    out["revolutions"] = revs
    # 1 回転あたりのサンプル数の半分（角度のナイキスト）未満の次数だけを見る
    max_order = int(min(MAX_ORDER, (len(t) / turns - 1) // 2)) if turns > 0 else 0
    if revs >= 1 and max_order >= 1:
        orders, sync = synchronous_fit(rev, rpm, max_order)
        out["orders"] = [
            {"order": n + 1, "freq_hz": (n + 1) * f_rot, "amp_rpm": a,
             "resolvable": resolvable((n + 1) * f_rot, a, encoder_error_pct)}
            for n, a in enumerate(orders)]
        if np.all(np.isfinite(current)):
            out["current_orders_amp"] = synchronous_fit(rev, current, max_order)[0]
        # 同期成分を引いた残り（回転に同期しない揺れ）の時間スペクトル
        _, uniform_res, _ = uniform(t, rpm - sync)
        rfreq, ramp = amplitude_spectrum(uniform_res, step)
        rpeak = dominant_peak(rfreq, ramp)
        if rpeak:
            rpeak["order"] = rpeak["freq_hz"] / f_rot if f_rot > 0 else None
            rpeak["resolvable"] = resolvable(rpeak["freq_hz"], rpeak["amp_rpm"],
                                             encoder_error_pct)
        out["residual_peak"] = rpeak
    else:
        out["orders"] = []
        out["residual_peak"] = None
    out["_spectrum"] = (freq, amp)
    return out


# ----------------------------------------------------------------------------- 判定
def classify(points, rel_rms=CLASSIFY_REL_RMS, min_spread=CLASSIFY_MIN_ROT_SPREAD):
    """(回転周波数, 卓越周波数) の組から、周波数が回転数に比例するか一定かを判定する.

    返り値の kind: "rotation_synchronous"（f = k × 回転周波数、k は次数）, "fixed_frequency"
    （f ≒ 一定）, "unclear"（どちらも当てはまらない / 両方当てはまる）, "insufficient"
    （区間が 2 つ未満、または回転数の範囲が狭すぎる）。
    """
    pts = [(fr, f) for fr, f in points if fr > 0 and f is not None and math.isfinite(f)]
    if len(pts) < 2:
        return {"kind": "insufficient", "reason": "定速区間が 2 つ未満（回転数が 1 水準のみ）"}
    fr = np.array([p[0] for p in pts])
    f = np.array([p[1] for p in pts])
    if fr.max() / fr.min() < min_spread:
        return {"kind": "insufficient",
                "reason": f"回転数の範囲が狭い（最大/最小 {fr.max() / fr.min():.2f} < {min_spread}）"}
    k = float(np.sum(f * fr) / np.sum(fr * fr))
    prop_rms = float(np.sqrt(np.mean((f - k * fr) ** 2)) / np.mean(f))
    const = float(np.mean(f))
    const_rms = float(np.sqrt(np.mean((f - const) ** 2)) / const)
    result = {"proportional_order": k, "proportional_rel_rms": prop_rms,
              "constant_hz": const, "constant_rel_rms": const_rms, "segments": len(pts)}
    prop_ok = prop_rms <= rel_rms
    const_ok = const_rms <= rel_rms
    if prop_ok and not const_ok:
        result["kind"] = "rotation_synchronous"
    elif const_ok and not prop_ok:
        result["kind"] = "fixed_frequency"
    else:
        result["kind"] = "unclear"
    return result


def _sync_order1_summary(segments):
    """1 次（1 回転周期）の同期成分の振幅を、車輪の回転数（回転角の傾き）の順に並べる."""
    rows = []
    for s in segments:
        if s["orders"]:
            o1 = s["orders"][0]
            rows.append({"rotation_rpm": s["rotation_hz"] * 60.0, "amp_rpm": o1["amp_rpm"],
                         "resolvable": o1["resolvable"]})
    return sorted(rows, key=lambda r: r["rotation_rpm"])


def combine_wheels(left, right):
    """左右（前進が正）を共通の時間で並べ、和（前後）と差（旋回）の速度にする."""
    t0 = max(left["t"][0], right["t"][0])
    t1 = min(left["t"][-1], right["t"][-1])
    if t1 <= t0:
        return None
    step = float(min(np.median(np.diff(left["t"])), np.median(np.diff(right["t"]))))
    grid = np.arange(t0, t1, step)
    lv = np.interp(grid, left["t"], left["rpm"])
    rv = np.interp(grid, right["t"], right["rpm"])
    lc = np.interp(grid, left["t"], left["command"]) if np.all(np.isfinite(left["command"])) \
        else np.full(len(grid), np.nan)
    rc = np.interp(grid, right["t"], right["command"]) if np.all(np.isfinite(right["command"])) \
        else np.full(len(grid), np.nan)
    # 区間は両輪の指令の大きさ（どちらかが変われば変わる）で分ける。
    common = {"t": grid, "segment_command": 0.5 * (np.abs(lc) + np.abs(rc))}
    left_rev = np.interp(grid, left["t"], left["rev"])
    right_rev = np.interp(grid, right["t"], right["rev"])
    common_rev = 0.5 * (left_rev + right_rev)
    forward = dict(common, rpm=0.5 * (lv + rv), rev=common_rev, current=np.full(len(grid), np.nan),
                   command=0.5 * (lc + rc))
    turn = dict(common, rpm=0.5 * (rv - lv), rev=common_rev, current=np.full(len(grid), np.nan),
                command=0.5 * (rc - lc))
    return {"forward": forward, "turn": turn}


def analyze(data, encoder_error_pct=ENCODER_ERROR_PCT, window=None, min_rpm=MIN_SEGMENT_RPM,
            settle=SETTLE_SEC, min_sec=MIN_SEGMENT_SEC, min_revs=MIN_SEGMENT_REVS):
    """読み込んだデータ全体を解析し、JSON にできる要約を返す."""
    result = {"source": data["source"], "angle_source": data["angle_source"],
              "stats": data["stats"], "encoder_error_pct": encoder_error_pct, "wheels": {},
              "_spectra": {}}
    forward_wheels = {}
    for side in SIDES:
        raw = data["wheels"][side]
        if len(raw["t"]) < 4:
            result["wheels"][side] = {"frames": int(len(raw["t"])), "segments": []}
            continue
        wheel = forward_wheel(raw, side, data["angle_source"])
        forward_wheels[side] = wheel
        result["wheels"][side] = summarize_wheel(
            wheel, side, result, encoder_error_pct, window, min_rpm, settle, min_sec, min_revs)
    if len(forward_wheels) == 2:
        combined = combine_wheels(forward_wheels["left"], forward_wheels["right"])
        if combined:
            for name, wheel in combined.items():
                result["wheels"][name] = summarize_wheel(
                    wheel, name, result, encoder_error_pct, window, min_rpm, settle, min_sec,
                    min_revs)
    return result


def summarize_wheel(wheel, name, result, encoder_error_pct, window, min_rpm, settle, min_sec,
                    min_revs):
    segments = []
    for start, stop in constant_segments(wheel, min_rpm, settle, min_sec, min_revs, window):
        seg = analyze_segment(wheel, start, stop, encoder_error_pct)
        result["_spectra"][(name, len(segments))] = seg.pop("_spectrum")
        segments.append(seg)
    raw_points = [(s["rotation_hz"], s["time_peak"]["freq_hz"]) for s in segments
                  if s["time_peak"] and s["time_peak"]["resolvable"]]
    res_points = [(s["rotation_hz"], s["residual_peak"]["freq_hz"]) for s in segments
                  if s.get("residual_peak") and s["residual_peak"]["resolvable"]]
    sync_rows = _sync_order1_summary(segments)
    sync_resolvable = [r for r in sync_rows if r["resolvable"]]
    return {
        "frames": int(len(wheel["t"])),
        "segments": segments,
        "campbell": [{"mean_rpm": s["mean_rpm"], "rotation_rpm": s["rotation_hz"] * 60.0,
                      "rotation_hz": s["rotation_hz"],
                      "peak_hz": s["time_peak"]["freq_hz"] if s["time_peak"] else None,
                      "peak_amp_rpm": s["time_peak"]["amp_rpm"] if s["time_peak"] else None,
                      "order1_amp_rpm": s["orders"][0]["amp_rpm"] if s["orders"] else None}
                     for s in segments],
        "dominant": classify(raw_points),
        "non_synchronous": classify(res_points),
        "order1": {
            "segments_resolvable": len(sync_resolvable),
            "segments": len(sync_rows),
            "largest_at_rpm": max(sync_resolvable, key=lambda r: r["amp_rpm"])["rotation_rpm"]
            if sync_resolvable else None,
            "by_rpm": sync_rows,
        },
    }


# ----------------------------------------------------------------------------- 出力
KIND_TEXT = {
    "rotation_synchronous": "回転数に比例（回転同期）",
    "fixed_frequency": "回転数によらず一定（ループ・構造）",
    "unclear": "判別できない（どちらのモデルにも当てはまらない / 両方に当てはまる）",
    "insufficient": "判別不能",
}


def describe(name, summary):
    lines = [f"[{name}] frames={summary['frames']} 定速区間={len(summary['segments'])}"]
    for s in summary["segments"]:
        peak = s["time_peak"]
        o1 = s["orders"][0] if s["orders"] else None
        res = s.get("residual_peak")
        lines.append(
            f"  {s['mean_rpm']:7.1f} rpm (回転 {s['rotation_hz'] * 60:.0f} rpm = "
            f"{s['rotation_hz']:.2f} Hz, {s['revolutions']} 回転, "
            f"p2p {s['p2p_rpm']:.1f})"
            + (f"  卓越 {peak['freq_hz']:.2f} Hz {peak['amp_rpm']:.2f} rpm"
               + ("" if peak["resolvable"] else " [判別不能]") if peak else "")
            + (f"  1次 {o1['amp_rpm']:.2f} rpm" + ("" if o1["resolvable"] else " [判別不能]")
               if o1 else "")
            + (f"  非同期 {res['freq_hz']:.2f} Hz {res['amp_rpm']:.2f} rpm"
               + ("" if res["resolvable"] else " [判別不能]") if res else ""))
    for key, label in (("dominant", "卓越周波数"), ("non_synchronous", "同期成分を除いた残り")):
        c = summary[key]
        text = KIND_TEXT[c["kind"]]
        if c["kind"] == "insufficient":
            text += f"（{c['reason']}）"
        elif c["kind"] == "rotation_synchronous":
            text += f"（次数 ≈ {c['proportional_order']:.2f}）"
        elif c["kind"] == "fixed_frequency":
            text += f"（≈ {c['constant_hz']:.2f} Hz）"
        lines.append(f"  {label}: {text}")
    o1 = summary["order1"]
    if o1["largest_at_rpm"] is not None:
        lines.append(f"  1 次の同期成分: {o1['segments_resolvable']}/{o1['segments']} 区間で判別可、"
                     f"最大は {o1['largest_at_rpm']:.0f} rpm")
    return lines


def report(result):
    lines = [f"source={result['source']} angle={result['angle_source']} "
             f"encoder_error={result['encoder_error_pct']}%/次数"]
    stats = result["stats"]
    if "seq_gaps" in stats:
        lines.append(f"samples={stats['samples']} seq の飛び={stats['seq_gaps']}"
                     f"（欠落 {stats['lost_samples']}） 重複除去={stats['duplicates_removed']}"
                     f" 欠落フレーム={stats['frames_missing']}")
    else:
        lines.append(f"samples={stats['samples']} 重複除去={stats['duplicates_removed']}")
    for name in ("left", "right", "forward", "turn"):
        if name in result["wheels"]:
            lines += describe(name, result["wheels"][name])
    return "\n".join(lines)


def to_json(result):
    return {k: v for k, v in result.items() if not k.startswith("_")}


def plot(result, out_dir):
    """Campbell 相当の図と区間ごとの時間スペクトル（PNG のラベルは日本語フォントが無くても読めるよう英語）."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib が無いため PNG は出しません", file=sys.stderr)
        return []
    import os
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for name in ("left", "right", "forward", "turn"):
        summary = result["wheels"].get(name)
        if not summary or not summary["segments"]:
            continue
        fig, (ax_c, ax_s) = plt.subplots(1, 2, figsize=(11, 4))
        rpm = [s["rotation_hz"] * 60.0 for s in summary["segments"]]
        peak = [s["time_peak"]["freq_hz"] if s["time_peak"] else np.nan
                for s in summary["segments"]]
        amp = [s["time_peak"]["amp_rpm"] if s["time_peak"] else 0.0
               for s in summary["segments"]]
        ax_c.scatter(rpm, peak, s=[20 + 20 * a for a in amp], label="dominant peak")
        span = np.linspace(0, max(rpm) * 1.1, 10)
        for order in (1, 2):
            ax_c.plot(span, order * span / 60.0, "--", lw=1, label=f"order {order}")
        ax_c.set_xlabel("wheel rotation [rpm]")
        ax_c.set_ylabel("frequency [Hz]")
        ax_c.legend()
        for index in range(len(summary["segments"])):
            freq, amp_spec = result["_spectra"][(name, index)]
            ax_s.plot(freq, amp_spec, lw=1, label=f"{rpm[index]:.0f} rpm")
        ax_s.set_xlim(0, 6)
        ax_s.set_xlabel("frequency [Hz]")
        ax_s.set_ylabel("amplitude [rpm]")
        ax_s.legend(fontsize=7)
        fig.suptitle(name)
        path = os.path.join(out_dir, f"ripple_{name}.png")
        fig.tight_layout()
        fig.savefig(path, dpi=120)
        plt.close(fig)
        written.append(path)
    return written


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--bag", help="rosbag2 ディレクトリ")
    src.add_argument("--csv", help="サンプル CSV または QUESTiX LAB の -messages.csv")
    p.add_argument("--export-csv", metavar="OUT",
                   help="--bag の /drive_control_sample をサンプル CSV に書き出して終わる")
    p.add_argument("--json", metavar="OUT", help="数値要約を JSON で保存")
    p.add_argument("--plot", metavar="DIR", help="PNG を保存（matplotlib が必要）")
    p.add_argument("--window", metavar="T0,T1",
                   help="自動抽出の代わりにこの時刻範囲 [s]（feedback stamp）を 1 区間にする")
    p.add_argument("--encoder-error-pct", type=float, default=ENCODER_ERROR_PCT,
                   help="エンコーダ誤差による見かけの変動 [%%/次数]（既定 1.0）")
    p.add_argument("--min-rpm", type=float, default=MIN_SEGMENT_RPM)
    p.add_argument("--settle", type=float, default=SETTLE_SEC)
    p.add_argument("--min-sec", type=float, default=MIN_SEGMENT_SEC)
    p.add_argument("--min-revs", type=float, default=MIN_SEGMENT_REVS)
    args = p.parse_args(argv)

    if args.export_csv:
        if not args.bag:
            raise SystemExit("--export-csv には --bag が必要です")
        print(f"{export_csv(args.bag, args.export_csv)} 行を {args.export_csv} に書き出しました")
        return 0
    data = load_bag(args.bag) if args.bag else load_csv(args.csv)
    window = tuple(float(v) for v in args.window.split(",")) if args.window else None
    result = analyze(data, args.encoder_error_pct, window, args.min_rpm, args.settle,
                     args.min_sec, args.min_revs)
    print(report(result))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(to_json(result), f, ensure_ascii=False, indent=2)
    if args.plot:
        for path in plot(result, args.plot):
            print(f"PNG: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
