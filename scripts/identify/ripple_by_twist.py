#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""ripple_analysis.py を、区間の区切りに /target_twist（補正前の目標）を使って実行する.

ripple_analysis.py（ブランチ feat/drive-measurement-fidelity の scripts/identify/）は「指令が一定の
区間」を解析する。/drive_status から読むとき、その指令は各輪の target_rpm = モータに実際に
送った値で、共振ダンピング（velocity_damping_gain_sec > 0）を有効にすると補正のぶん毎 tick
変わるため、一定の区間が 1 つも見つからない（「定速区間=0」）。

このスクリプトは bag の /target_twist（record.sh が必ず記録する）から各輪の目標 RPM を
運動学（differential_kinematics と同じ式・同じ符号: 左は前進で正、右は前進で負）で求め、
それを区切りに使って ripple_analysis.py の解析と表示をそのまま行う。補正なしの記録に使っても
区間は同じになるので、補正あり・なしを同じ基準で比べられる。

wheel_radius / wheel_separation は、bag の隣の drive_component_params_before.yaml（record.sh が
保存する）から読む。無ければ --wheel-radius / --wheel-separation（既定 0.05 / 0.5）。

使い方:
  python3 scripts/identify/ripple_by_twist.py --ripple ~/ripple_analysis.py \\
      --bag ~/ident_data/ident_<ID>_<床>_<日時>/bag [--settle 1.0 --min-sec 3 ...]
"""
from __future__ import annotations

import argparse
import importlib.util
import math
import os
import sys


def wheel_reference_rpm(linear, angular, wheel_radius, wheel_separation):
    """車体 twist → (左, 右) の車輪 RPM（differential_kinematics::twistToWheelRpm と同じ）。"""
    circumference = 2.0 * math.pi * wheel_radius
    if not circumference > 0.0:
        return 0.0, 0.0
    v_left = linear - angular * wheel_separation / 2.0
    v_right = linear + angular * wheel_separation / 2.0
    return v_left / circumference * 60.0, -v_right / circumference * 60.0


def reference_series(frame_times, twist_times, twists, wheel_radius, wheel_separation, side):
    """各フレーム時刻の直前に届いていた /target_twist から、その輪の目標 RPM（整数）を並べる。

    twist_times は昇順。最初の twist より前のフレームは目標 0。
    """
    out = []
    j = -1
    for t in frame_times:
        while j + 1 < len(twist_times) and twist_times[j + 1] <= t:
            j += 1
        if j < 0:
            out.append(0.0)
            continue
        left, right = wheel_reference_rpm(twists[j][0], twists[j][1], wheel_radius,
                                          wheel_separation)
        out.append(float(round(left if side == "left" else right)))
    return out


def read_geometry(bag_path, default_radius, default_separation):
    """record.sh の drive_component_params_before.yaml から車輪の寸法を読む。"""
    path = os.path.join(os.path.dirname(os.path.abspath(bag_path.rstrip("/"))),
                        "drive_component_params_before.yaml")
    try:
        import yaml

        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f) or {}
    except (OSError, ImportError, ValueError):
        return default_radius, default_separation, "既定値（--wheel-radius / --wheel-separation）"
    params = {}
    for node in doc.values() if isinstance(doc, dict) else []:
        if isinstance(node, dict) and isinstance(node.get("ros__parameters"), dict):
            params = node["ros__parameters"]
    radius = params.get("wheel_radius", default_radius)
    separation = params.get("wheel_separation", default_separation)
    return float(radius), float(separation), path


def read_twists(ripple, bag_path):
    """bag の /target_twist を (受信時刻 [s], (linear.x, angular.z)) の並びで返す。"""
    reader, types, deserialize_message, get_message = ripple._open_bag(bag_path)
    if "/target_twist" not in types:
        raise SystemExit(f"bag に /target_twist がありません: {sorted(types)}")
    msg_type = get_message(types["/target_twist"])
    times, twists = [], []
    while reader.has_next():
        name, raw, stamp_ns = reader.read_next()
        if name != "/target_twist":
            continue
        msg = deserialize_message(raw, msg_type)
        times.append(stamp_ns * 1e-9)
        twists.append((float(msg.linear.x), float(msg.angular.z)))
    return times, twists


def load_ripple(path):
    """ripple_analysis.py をモジュールとして読み込む。"""
    spec = importlib.util.spec_from_file_location("ripple_analysis", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"{path} を読み込めません")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args(argv=None):
    """コマンドライン引数。"""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ripple", default=os.path.expanduser("~/ripple_analysis.py"),
                    help="ripple_analysis.py の場所（既定 ~/ripple_analysis.py）")
    ap.add_argument("--bag", required=True, help="rosbag2 ディレクトリ")
    ap.add_argument("--wheel-radius", type=float, default=0.05)
    ap.add_argument("--wheel-separation", type=float, default=0.5)
    ap.add_argument("--settle", type=float, default=1.0)
    ap.add_argument("--min-sec", type=float, default=3.0)
    ap.add_argument("--min-revs", type=float, default=3.0)
    ap.add_argument("--min-rpm", type=float, default=10.0)
    ap.add_argument("--json", metavar="OUT", help="数値要約を JSON で保存")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not os.path.exists(args.ripple):
        raise SystemExit(f"{args.ripple} がありません。次で取り出してください:\n"
                         "  git show origin/feat/drive-measurement-fidelity:"
                         "scripts/identify/ripple_analysis.py > ~/ripple_analysis.py")
    ripple = load_ripple(args.ripple)
    radius, separation, geometry_source = read_geometry(args.bag, args.wheel_radius,
                                                        args.wheel_separation)
    data = ripple.load_bag(args.bag)
    twist_times, twists = read_twists(ripple, args.bag)
    if not twists:
        raise SystemExit("/target_twist のメッセージが 1 つもありません")
    for side in ripple.SIDES:
        wheel = data["wheels"][side]
        wheel["command"] = ripple.np.asarray(
            reference_series(wheel["t"], twist_times, twists, radius, separation, side),
            dtype=float)
    print(f"区間の区切り: /target_twist（{len(twists)} 件）、wheel_radius={radius} "
          f"wheel_separation={separation}（{geometry_source}）")
    result = ripple.analyze(data, ripple.ENCODER_ERROR_PCT, None, args.min_rpm, args.settle,
                            args.min_sec, args.min_revs, ripple.TRACK_ORDERS)
    print(ripple.report(result))
    if args.json:
        import json

        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(ripple.to_json(result), f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
