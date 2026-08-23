#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

ROS_DOMAIN_ID="$(python3 scripts/resolve_ros_domain_id.py)"

ansible-playbook ansible/playbooks/setup_kit.yaml -i localhost, --connection=local --ask-become-pass \
    -e "ros_domain_id=${ROS_DOMAIN_ID}"
