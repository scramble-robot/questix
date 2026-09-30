# openssh_server Role

Installs `openssh-server` on a kit (maintenance, VS Code Remote SSH) and makes sure SSH is
enabled and running, with Ubuntu's own configuration.

- `install_openssh_server: true` (default): install the package, validate the configuration
  (`sshd -t`), enable and start SSH, and check that the unit is enabled and active.
- `install_openssh_server: false`: the role does nothing. It never removes the package, stops or
  disables SSH, or changes `/etc/ssh/sshd_config*`.

Ubuntu 24.04 starts sshd by socket activation (`ssh.socket` starts `ssh.service` on the first
connection). The role enables and starts `ssh.socket` when the package provides it and
`ssh.service` otherwise, and checks that unit (`systemctl is-enabled` / `is-active`). Starting
`ssh.service` directly would stop `ssh.socket` and change Ubuntu's default.

Not done here (a separate hardening design if needed): passwords or `PasswordAuthentication`,
root login, `authorized_keys`, firewall rules, port or cipher changes.
