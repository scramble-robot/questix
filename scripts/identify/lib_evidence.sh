#!/usr/bin/env bash
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
#
# record.sh 用の証跡ヘルパー（design/model_based_drive_control.md Phase A）。
#
# 目的は「どの source・どの実効パラメータ・どの条件で取ったデータか」を
# 後から第三者が一意に辿れるようにすること。scripts/identify/ 内で閉じた小道具で、
# 授業用ロガーの API を先取りしない。
#
# 使い方: source scripts/identify/lib_evidence.sh
# 単体確認: bash scripts/identify/test_evidence.sh

# ---- git / 実行環境の同一性 -------------------------------------------------

# 完全な commit SHA（短縮しない）。git でなければ "unknown"。
evidence_git_full_sha() {
  git -C "$1" rev-parse HEAD 2>/dev/null || echo unknown
}

# ブランチ名。detached HEAD なら "(detached)"。
evidence_git_branch() {
  local branch
  branch="$(git -C "$1" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -n "$branch" ]]; then
    echo "$branch"
  elif git -C "$1" rev-parse --git-dir >/dev/null 2>&1; then
    echo "(detached)"
  else
    echo unknown
  fi
}

# detached HEAD か: true / false / unknown
evidence_git_detached() {
  if ! git -C "$1" rev-parse --git-dir >/dev/null 2>&1; then
    echo unknown
  elif git -C "$1" symbolic-ref --quiet HEAD >/dev/null 2>&1; then
    echo false
  else
    echo true
  fi
}

# 作業ツリーの状態: clean / dirty / unknown
evidence_git_dirty() {
  local status
  if ! git -C "$1" rev-parse --git-dir >/dev/null 2>&1; then
    echo unknown
    return
  fi
  status="$(git -C "$1" status --porcelain 2>/dev/null || true)"
  if [[ -n "$status" ]]; then echo dirty; else echo clean; fi
}

# git status --porcelain（clean なら空、git でなければ注記）を stdout へ。
# diff 本体は自動保存しない（容量と機微情報のため。必要なら手動で添付する）。
evidence_git_status_body() {
  if ! git -C "$1" rev-parse --git-dir >/dev/null 2>&1; then
    echo "# not a git working tree: $1"
    return
  fi
  git -C "$1" status --porcelain 2>/dev/null || true
}

# source_identity.txt の本体を stdout へ。key: value の平文（機械可読だが YAML 依存なし）。
evidence_source_identity() {
  local repo="$1"
  echo "git_commit: $(evidence_git_full_sha "$repo")"
  echo "git_branch: $(evidence_git_branch "$repo")"
  echo "git_detached_head: $(evidence_git_detached "$repo")"
  echo "git_worktree: $(evidence_git_dirty "$repo")"
  echo "git_describe: $(git -C "$repo" describe --tags --always --dirty 2>/dev/null || echo unknown)"
  echo "repo_dir: $repo"
  echo "hostname: $(hostname 2>/dev/null || echo unknown)"
  echo "uname: $(uname -srm 2>/dev/null || echo unknown)"
  echo "user: ${USER:-unknown}"
  echo "ros_distro: ${ROS_DISTRO:-unset}"
  echo "ros_domain_id: ${ROS_DOMAIN_ID:-unset}"
  echo "rmw_implementation: ${RMW_IMPLEMENTATION:-unset}"
  echo "ros_localhost_only: ${ROS_LOCALHOST_ONLY:-unset}"
  echo "recorded_at: $(date -Iseconds)"
}

# ---- rosbag 対象 topic ------------------------------------------------------

# 記録対象 topic を決める。
#   evidence_select_topics REQUIRED_CSV OPTIONAL_CSV AVAILABLE_FILE
# required は在否に関わらず必ず含める（preflight で別途 hard fail 済みの前提）。
# optional は AVAILABLE_FILE（`ros2 topic list` の出力、1 行 1 topic）にある場合だけ含める。
# optional が無いことは失敗条件にしない。
evidence_select_topics() {
  local required_csv="$1" optional_csv="$2" available="$3" t
  local -a out=() __req=() __opt=()
  IFS=',' read -r -a __req <<<"$required_csv"
  for t in "${__req[@]}"; do
    [[ -n "$t" ]] && out+=("$t")
  done
  if [[ -n "$optional_csv" ]]; then
    IFS=',' read -r -a __opt <<<"$optional_csv"
    for t in "${__opt[@]}"; do
      [[ -z "$t" ]] && continue
      if [[ -f "$available" ]] && grep -qxF "$t" "$available"; then
        out+=("$t")
      fi
    done
  fi
  if [[ ${#out[@]} -gt 0 ]]; then
    printf '%s\n' "${out[@]}"
  fi
}

# ---- パラメータ snapshot ----------------------------------------------------

# before / after の差分を OUT へ書く。
#   evidence_param_diff BEFORE AFTER OUT
# 戻り値: 0 = 同一（OUT は作らない）, 1 = 差分あり, 2 = 比較不能
evidence_param_diff() {
  local before="$1" after="$2" out="$3"
  if [[ ! -s "$before" || ! -s "$after" ]]; then
    return 2
  fi
  if diff -u "$before" "$after" >"$out" 2>/dev/null; then
    rm -f "$out"
    return 0
  fi
  return 1
}

# ---- bag integrity ----------------------------------------------------------

# bag_info.txt を緩く検査する。rosbag2 の出力書式に強く依存する parser は作らない:
#   - required topic 名が出力に現れるか（現れなければ警告）
#   - "Messages: 0" 相当の total 0 を見つけたら警告
# 警告文を stdout に出し、警告があれば 1 を返す。
evidence_bag_info_warnings() {
  local info="$1" required_csv="$2" t rc=0
  local -a __req=()
  if [[ ! -s "$info" ]]; then
    echo "bag info を取得できませんでした（$info が空）"
    return 1
  fi
  IFS=',' read -r -a __req <<<"$required_csv"
  for t in "${__req[@]}"; do
    [[ -z "$t" ]] && continue
    if ! grep -qF "$t" "$info"; then
      echo "bag に $t が見当たりません"
      rc=1
    fi
  done
  if grep -Eq '^[[:space:]]*Messages:[[:space:]]*0[[:space:]]*$' "$info"; then
    echo "bag のメッセージ総数が 0 です"
    rc=1
  fi
  return "$rc"
}
