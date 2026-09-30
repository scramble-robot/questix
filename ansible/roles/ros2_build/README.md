# ros2_build Role

Makes the QUESTiX workspace runnable on a fresh kit (`setup_kit.yaml`, after `robotics_workspace`
and before `robot_autostart`). Before this role, a freshly set-up kit had an empty `src/` and no
`build/` `install/` `log/`, so Robot Manager's lessons failed with
`Package 'questix_lab_bridge' not found`.

## What it does

`workspace_path` is the QUESTiX checkout itself (`setup_kit_vars.yaml`: `~/questix`).

1. Refuses a `workspace_path` without `dependency.repos` (not the checkout).
2. Imports the repositories of `dependency.repos` that are **missing** from `src/`
   (`vcs import --input dependency.repos --skip-existing src`). Existing checkouts are never
   updated, reset or re-cloned; updating them is a deliberate `vcs pull src`.
3. Installs the workspace's rosdep keys (`rosdep install --from-paths <workspace> --ignore-src
   --rosdistro jazzy -r -y`). It reads the index the `ros2_installation` role's `rosdep update`
   wrote as the user (`ROS_HOME=~/.ros`); only this step runs as root (for apt-get).
4. `colcon build --symlink-install` as the user.
5. Checks: `install/setup.bash` exists; `src/ build/ install/ log/` belong to `target_user`;
   `ros2 pkg prefix` resolves every package of `workspace_required_packages`;
   `ros2 pkg executables questix_lab_bridge` lists `lab_bridge_node`. A failed check fails the
   setup, so the completion message only appears for a built workspace.

It starts no node and sends no command. A second `setup.sh` imports nothing new, lets rosdep find
nothing to install and rebuilds incrementally. Check mode builds nothing.

## Variables

| Variable | Default | Meaning |
|---|---|---|
| `workspace_path` | `/home/{{ target_user }}/questix` | the QUESTiX checkout |
| `workspace_required_packages` | `questix_launcher`, `questix_msgs`, `questix_lab_bridge` | must resolve after the build |
| `workspace_ros_setup` | `/opt/ros/{{ ros2_distro }}/setup.bash` | ROS environment for the build |
| `workspace_user_ros_home` | `/home/{{ target_user }}/.ros` | the rosdep index rosdep install reads |
| `workspace_rosdep_become` | `true` | rosdep install as root (apt-get) |
| `workspace_build_refuse_root` | `true` | never build as root; only the isolated contract tests, run as root, set it false |

Tests: `ansible/tests/run_contract_tests.sh` section 8 runs these tasks against a temp workspace
with fake `vcs` / `rosdep` / `colcon` / `ros2` (`ansible/tests/fake_ros_tools/`).
