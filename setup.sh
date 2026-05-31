cd "$(dirname "$0")/ansible"
ansible-playbook playbooks/setup_kit.yaml -i localhost, --connection=local --ask-become-pass
