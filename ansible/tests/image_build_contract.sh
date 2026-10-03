# image_build_contract.sh
# Section of run_contract_tests.sh (sourced: uses its pass / fail / assert_* and TMP_ROOT).
# The custom image build's functions (scripts/iso/image-build-lib.sh) run against a fake chroot
# tree: no root, no chroot, no network, no ISO. Covers where the build looks for the repository,
# the source it installs, its owner, the Ansible invocation, the first-boot files and the
# security postconditions of the finished tree.

# shellcheck source=../../scripts/iso/image-build-lib.sh
. scripts/iso/image-build-lib.sh

IMAGE_TEST="$TMP_ROOT/image"
mkdir -p "$IMAGE_TEST"

# A fake chroot: the image user has the test user's ids, so ownership can be checked unprivileged.
new_image_tree() {
    local tree="$1"
    rm -rf "$tree"
    mkdir -p "$tree/etc/sudoers.d" "$tree/etc/systemd/system/multi-user.target.wants" \
        "$tree/etc/systemd/system/sockets.target.wants" "$tree/home" "$tree/tmp"
    printf 'root:x:0:0::/root:/bin/bash\nubuntu:x:%s:%s::/home/ubuntu:/bin/bash\n' \
        "$(id -u)" "$(id -g)" > "$tree/etc/passwd"
    printf 'root:*:19000::::::\nubuntu:!:19000:0:99999:7:::\n' > "$tree/etc/shadow"
    printf '@includedir /etc/sudoers.d\n' > "$tree/etc/sudoers"
}

# A small QUESTiX-like repository with untracked files and build output next to the tracked ones.
FIXTURE_REPO="$IMAGE_TEST/repo"
mkdir -p "$FIXTURE_REPO"
git -C "$FIXTURE_REPO" init --quiet
printf 'repositories: {}\n' > "$FIXTURE_REPO/dependency.repos"
printf 'tracked\n' > "$FIXTURE_REPO/README.md"
git -C "$FIXTURE_REPO" add dependency.repos README.md
git -C "$FIXTURE_REPO" -c user.name=test -c user.email=test@example.invalid commit --quiet -m fixture
FIXTURE_COMMIT="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
mkdir -p "$FIXTURE_REPO/build" "$FIXTURE_REPO/install" "$FIXTURE_REPO/log" "$FIXTURE_REPO/src/ydlidar"
printf 'secret\n' > "$FIXTURE_REPO/untracked.env"
printf 'changed\n' > "$FIXTURE_REPO/README.md"  # a local edit is not the commit either

TREE="$IMAGE_TEST/tree"
new_image_tree "$TREE"
if questix_image_install_source "$FIXTURE_REPO" "$TREE" ubuntu > "$IMAGE_TEST/source.log" 2>&1; then
    SRC="$TREE/home/ubuntu/questix"
    [ "$(git -C "$SRC" rev-parse HEAD)" = "$FIXTURE_COMMIT" ] \
        && pass "image source: the checked-out commit, with its identity (git HEAD)" \
        || fail "image source: wrong commit"
    [ -f "$SRC/dependency.repos" ] && pass "image source: /home/ubuntu/questix/dependency.repos present" \
        || fail "image source: dependency.repos missing"
    if [ ! -e "$SRC/untracked.env" ] && [ ! -e "$SRC/build" ] && [ ! -e "$SRC/install" ] \
        && [ ! -e "$SRC/log" ] && [ ! -e "$SRC/src" ] && [ "$(cat "$SRC/README.md")" = tracked ]; then
        pass "image source: tracked files of the commit only (no untracked, build/install/log/src, local edits)"
    else
        fail "image source: build-host files leaked into the image"
    fi
    if [ -z "$(find "$SRC" ! -user "$(id -u)" -print -quit)" ] \
        && [ "$(stat -c %u:%g "$SRC/dependency.repos")" = "$(id -u):$(id -g)" ]; then
        pass "image source: owned by the image's ubuntu user (ids from the image's passwd)"
    else
        fail "image source: not owned by ubuntu"
    fi
    [ "$(git -C "$SRC" remote get-url origin)" = "https://github.com/scramble-robot/questix.git" ] \
        && pass "image source: origin points to the public repository, not the build host" \
        || fail "image source: origin is the build host path"
else
    fail "image source: install failed: $(tail -n 3 "$IMAGE_TEST/source.log")"
fi
if questix_image_install_source "$FIXTURE_REPO" "$TREE" ubuntu > /dev/null 2>&1; then
    fail "image source: an existing /home/ubuntu/questix was overwritten"
else
    pass "image source: refuses an existing destination"
fi
new_image_tree "$IMAGE_TEST/nouser"
sed -i '/^ubuntu:/d' "$IMAGE_TEST/nouser/etc/passwd"
if questix_image_install_source "$FIXTURE_REPO" "$IMAGE_TEST/nouser" ubuntu > /dev/null 2>&1; then
    fail "image source: installed without the user in the image"
else
    pass "image source: refuses an image without the user"
fi
NOTREPO="$IMAGE_TEST/notrepo"
mkdir -p "$NOTREPO"
git -C "$NOTREPO" init --quiet
printf 'x\n' > "$NOTREPO/x"
git -C "$NOTREPO" add x
git -C "$NOTREPO" -c user.name=t -c user.email=t@example.invalid commit --quiet -m x
new_image_tree "$IMAGE_TEST/notrepo-tree"
if questix_image_install_source "$NOTREPO" "$IMAGE_TEST/notrepo-tree" ubuntu > /dev/null 2>&1; then
    fail "image source: accepted a checkout without dependency.repos"
else
    pass "image source: refuses a checkout without dependency.repos"
fi
# The real repository resolves too (the build uses the script's own checkout).
new_image_tree "$IMAGE_TEST/real"
if questix_image_install_source "$REPO_ROOT" "$IMAGE_TEST/real" ubuntu > /dev/null 2>&1 \
    && [ "$(git -C "$IMAGE_TEST/real/home/ubuntu/questix" rev-parse HEAD)" = "$(git rev-parse HEAD)" ]; then
    pass "image source: this repository's HEAD installs as /home/ubuntu/questix"
else
    fail "image source: this repository does not install"
fi

# First-boot files and the security postconditions of a finished tree.
questix_image_install_first_boot scripts/iso "$TREE"
ln -s /etc/systemd/system/questix-first-boot.service \
    "$TREE/etc/systemd/system/multi-user.target.wants/questix-first-boot.service"
if questix_image_verify_security "$TREE" ubuntu > "$IMAGE_TEST/verify.log" 2>&1; then
    pass "image security: a finished tree passes (locked, no NOPASSWD, SSH off, first boot on)"
else
    fail "image security: a good tree failed: $(cat "$IMAGE_TEST/verify.log")"
fi
[ "$(stat -c %a "$TREE/usr/local/sbin/questix-first-boot-enroll")" = 755 ] \
    && [ "$(stat -c %a "$TREE/etc/systemd/system/questix-first-boot.service")" = 644 ] \
    && pass "image first boot: helper 0755, unit 0644" || fail "image first boot: wrong modes"

# Each broken postcondition is caught on its own.
break_and_verify() {
    local label="$1" change="$2"
    local broken="$IMAGE_TEST/broken"
    rm -rf "$broken"
    cp -a "$TREE" "$broken"
    (cd "$broken" && eval "$change")
    if questix_image_verify_security "$broken" ubuntu > "$IMAGE_TEST/broken.log" 2>&1; then
        fail "image security: not caught: $label"
    else
        pass "image security: caught: $label"
    fi
}
break_and_verify "a password set in the image" \
    "sed -i 's/^ubuntu:!:/ubuntu:\$6\$salt\$hash:/' etc/shadow"
break_and_verify "no password at all" "sed -i 's/^ubuntu:!:/ubuntu::/' etc/shadow"
break_and_verify "a NOPASSWD rule" "printf 'ubuntu ALL=(ALL) NOPASSWD: ALL\n' > etc/sudoers.d/zz-build"
break_and_verify "the legacy sudoers file" "printf 'ubuntu ALL=(ALL) ALL\n' > etc/sudoers.d/ubuntu"
break_and_verify "the legacy .pkla" \
    "mkdir -p etc/polkit-1/localauthority/50-local.d && touch etc/polkit-1/localauthority/50-local.d/50-questix-robot.pkla"
break_and_verify "ssh.socket enabled" "ln -s /usr/lib/systemd/system/ssh.socket etc/systemd/system/sockets.target.wants/ssh.socket"
break_and_verify "ssh.service enabled" "ln -s /usr/lib/systemd/system/ssh.service etc/systemd/system/multi-user.target.wants/ssh.service"
break_and_verify "console autologin" \
    "mkdir -p etc/systemd/system/getty@tty1.service.d && touch etc/systemd/system/getty@tty1.service.d/autologin.conf"
break_and_verify "desktop autologin" \
    "mkdir -p etc/gdm3 && printf '[daemon]\nAutomaticLoginEnable=true\n' > etc/gdm3/custom.conf"
break_and_verify "first boot not enabled" "rm etc/systemd/system/multi-user.target.wants/questix-first-boot.service"
break_and_verify "enrollment helper writable" "chmod 0775 usr/local/sbin/questix-first-boot-enroll"
break_and_verify "no QUESTiX source" "rm -rf home/ubuntu/questix"

# The build script itself: where it looks, what it runs, what it checks.
APPLY=scripts/apply-ansible-config.sh
assert_not_contains "$APPLY" 'ANSIBLE_DIR="$(pwd)/ansible"' "image build: no longer relies on the current directory"
assert_contains "$APPLY" 'REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"' "image build: repository from the script's own location"
assert_contains "$APPLY" 'questix_image_install_source "$REPO_ROOT" "$CHROOT_DIR" "$IMAGE_USER"' \
    "image build: installs the source before Ansible"
assert_contains "$APPLY" 'cd "$IMAGE_SOURCE/ansible"' "image build: runs the playbook from the image's own checkout"
for extra in '-e "questix_image_build=true"' '-e "enable_autologin=false"' \
    '-e "ansible_user=$IMAGE_USER"' '-e "workspace_path=$IMAGE_SOURCE"'; do
    assert_contains "$APPLY" "$extra" "image build: ansible-playbook $extra"
done
assert_not_contains "$APPLY" "ansible_become=false" "image build: no inventory ansible_become (would override become)"
assert_not_contains "$APPLY" "workspace_build_refuse_root" "image build: never switches off the root refusal"
assert_contains "$APPLY" 'IMAGE_ANSIBLE_VERSION=14.2.0' "image build: Ansible pinned like the CI"
assert_contains .github/workflows/ansible-check.yaml '"ansible==14.2.0"' "image build: the CI pin it follows"
assert_contains "$APPLY" 'rm -rf "$IMAGE_ANSIBLE_VENV"' "image build: the build's Ansible is not left in the image"
assert_contains "$APPLY" 'questix_image_verify_security "$CHROOT_DIR" "$IMAGE_USER"' \
    "image build: offline security postconditions before the image is made"
assert_contains "$APPLY" 'visudo -cf /etc/sudoers' "image build: sudoers syntax checked in the image"
assert_contains "$APPLY" 'systemctl is-enabled questix-first-boot.service' "image build: first boot enabled, checked"

# The roles under questix_image_build: the kit user's tasks become that user; no service start
# or systemd/udev reload in the chroot. The default (a normal setup) is unchanged.
if python3 - << 'PYTHON'
import glob, yaml
become_user = 0
for path in ["ansible/roles/ros2_build/tasks/main.yaml", "ansible/roles/robotics_workspace/tasks/main.yaml",
             "ansible/roles/ros2_installation/tasks/main.yaml",
             "ansible/roles/robot_autostart/tasks/robot_manager.yaml"]:
    text = open(path).read()
    assert not [l for l in text.splitlines() if l.strip() == "become: false"], path
    def walk(tasks):
        global become_user
        for task in tasks or []:
            walk(task.get("block"))
            if task.get("become") == "{{ questix_image_build | default(false) | bool }}":
                assert task.get("become_user"), task.get("name")
                become_user += 1
    walk(yaml.safe_load(text))
assert become_user == 12, become_user
tasks = yaml.safe_load(open("ansible/roles/robot_autostart/tasks/robot_manager.yaml"))
start = next(t for t in tasks if t["name"] == "Enable and start questix_robot_manager service")
assert "questix_image_build" in start["ansible.builtin.systemd"]["state"]
for path in ["ansible/roles/robot_autostart/handlers/main.yaml", "ansible/roles/hardware_interfaces/handlers/main.yaml"]:
    for handler in yaml.safe_load(open(path)):
        if "ansible.builtin.systemd" in handler:
            assert "questix_image_build" in handler.get("when", ""), (path, handler["name"])
PYTHON
then
    pass "image build: kit user tasks become the user (12), no start/reload in the chroot"
else
    fail "image build: roles are not ready for the image build"
fi
