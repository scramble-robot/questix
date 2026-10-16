"""Real subprocess/socket failures with compile-time fake Output; never sysfs or services."""
import errno
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

server = sys.argv[1]


def connect(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    s.settimeout(1)
    s.connect(str(path))
    return s


def call(s, op, session=0, seq=0, pulse=0):
    s.send(f'1 {op} {session} {seq} {pulse}'.encode())
    r = s.recv(256).decode().split()
    assert r[0] == '1', r
    return r


def waitfor(test, timeout=2):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if test():
            return
        time.sleep(.01)
    raise AssertionError('deadline exceeded')


with tempfile.TemporaryDirectory(prefix='questix-ipc-') as directory:
    d = Path(directory)
    sock, ledger = d/'control', d/'writes'

    def launch(extra=()):
        p = subprocess.Popen([server, '--socket', str(sock), '--lock', str(d/'lock'),
                              '--fake-log', str(ledger), '--allowed-uid', str(os.getuid()),
                              '--admin-uid', str(os.getuid()+1), '--socket-gid', str(os.getgid()),
                              *extra], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # bind() creates the socket file before listen(): wait until it accepts a connection.
        def ready():
            if p.poll() is not None:
                return True
            try:
                connect(sock).close()
            except (FileNotFoundError, ConnectionRefusedError):
                return False
            return True

        waitfor(ready)
        assert p.poll() is None, p.communicate()
        return p

    def arm():
        c = connect(sock)
        r = call(c, 'ARM')
        assert r[1] == '1' and r[2] == 'ARMING', r
        session = int(r[4])
        assert call(c, 'COMPLETE', session, 1)[1] == '1'
        return c, session

    p = launch()
    try:
        probe = connect(sock)
        assert call(probe, 'AUTHORIZE')[1] == '0'  # removed, before active owner exists
        probe.close()
        c, session = arm()
        assert call(c, 'STATUS')[1] == '0'
        assert call(c, 'LOW')[1] == '0'
        assert call(c, 'COMMAND', session, 2, 1800)[1] == '1'
        attacker = connect(sock)
        assert call(attacker, 'COMMAND', session, 3, 2000)[1] == '0'
        assert call(attacker, 'REPORT', session)[1] == '0'
        attacker.close()
        # Owner fd, not caller-provided session/sequence, establishes stop authority.
        assert call(c, 'SHUTDOWN', 0, 0)[1] == '1'
        assert call(c, 'SHUTDOWN', session, 1)[1] == '1'
        assert call(c, 'COMMAND', session, 4, 1800)[1] == '0'
        time.sleep(.55)
        r = call(c, 'REPORT', session)
        assert r[2] == 'TERMINAL_LOW' and r[3] == '0', r
        c.close()
        time.sleep(.03)
        c, session = arm()
        assert call(c, 'COMMAND', session, 2, 2000)[1] == '1'
        r = call(c, 'COMMAND', session, 3, 2001)
        assert r[1] == '0' and r[2] == 'FAULT_LOW' and r[3] == '0', r
        c.close()
        time.sleep(.03)
        c, session = arm()
        assert call(c, 'COMMAND', session, 10, 1800)[1] == '1'
        assert call(c, 'STOP', 0, 0)[1] == '1'
        assert call(c, 'REPORT', session)[3] == '0'
        c.close()
        time.sleep(.03)
        c, session = arm()
        assert call(c, 'COMMAND', session, 2, 1800)[1] == '1'
        r = call(c, 'COMMAND', session, 2, 1800)
        assert r[1] == '0' and r[2] == 'FAULT_LOW' and int(r[5]) == -errno.EPROTO, r
        c.close()
        time.sleep(.03)
        c, session = arm()
        assert call(c, 'COMMAND', session, 2, 1800)[1] == '1'
        r = call(c, 'COMMAND', session, 0, 1800)
        assert r[1] == '0' and r[2] == 'FAULT_LOW', r
        c.close()
        time.sleep(.03)
        c, session = arm()
        assert call(c, 'COMMAND', session, 2, 1800)[1] == '1'
        time.sleep(.6)  # default500ms lease, executor renewal absent
        r = call(c, 'REPORT', session)
        assert r[2] == 'FAULT_LOW' and r[3] == '0' and int(r[5]) == -errno.ETIMEDOUT, r
        r = call(c, 'STOP', session, 0)
        assert r[1] == '1' and int(r[5]) == -errno.ETIMEDOUT, r
        c.close()
        time.sleep(.03)
        owner_code = '''import socket,sys,signal
s=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);s.connect(sys.argv[1])
def call(op,session=0,seq=0,pulse=0):
 s.send(f'1 {op} {session} {seq} {pulse}'.encode());return s.recv(256).decode().split()
r=call('ARM');assert r[1]=='1';session=int(r[4]);assert call('COMPLETE',session,1)[1]=='1'
assert call('COMMAND',session,2,1800)[1]=='1'
print('READY',flush=True);signal.pause()
'''
        for sig in (signal.SIGKILL, signal.SIGSTOP):
            child = subprocess.Popen([sys.executable, '-c', owner_code, str(sock)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                assert child.stdout.readline().strip() == b'READY'
                os.kill(child.pid, sig)
                waitfor(lambda: ledger.read_text().splitlines()[-1].endswith(' 0'))
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=2)
            time.sleep(.03)
        # Reserve an admin slot despite15 robot connections. Use real distinct UID when root.
        clients = []
        for _ in range(15):
            client = connect(sock)
            assert call(client, 'STATUS')[1] == '0'  # accepted before filling the next slot
            clients.append(client)
        if os.getuid() == 0:
            d.chmod(0o755)  # private test fixture only, to permit UID1 access to its socket
            admin_code = '''import socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);s.connect(sys.argv[1])
def call(op):
 s.send(f'1 {op} 0 0 0'.encode());return s.recv(256).decode().split()
assert call('STATUS')[1]=='1'
assert call('ARM')[1]=='0'
assert call('LOW')[1]=='1'
print('REAL_DISTINCT_UID_ADMIN_SLOT_AND_ROLE_PASS')
'''
            result = subprocess.run([sys.executable, '-c', admin_code, str(sock)],
                                    preexec_fn=lambda: os.setuid(1), capture_output=True, text=True)
            assert result.returncode == 0, result.stderr
            print(result.stdout.strip())
        else:
            print('REAL_DISTINCT_UID_ADMIN_TEST_SKIP: requires isolated root test runner; '
                  'robot STATUS/LOW refusal tested; no product credential override')
        for c in clients:
            c.close()
        time.sleep(.03)
        p.kill()
        killed_stdout, _ = p.communicate(timeout=2)
        assert b'rearm previous_session=' in killed_stdout, killed_stdout
        assert b'previous_fault=-110 session=' in killed_stdout, killed_stdout
        sock.unlink(missing_ok=True)
        p = launch()
        c = connect(sock)
        # Restart has Low, but a new explicit ARM is permitted by the simplified contract.
        assert ledger.read_text().splitlines()[-1].endswith(' 0')
        assert call(c, 'ARM')[1] == '1'
        c.close()
    finally:
        if p.poll() is None:
            p.terminate()
        stdout, stderr = p.communicate(timeout=3)
        assert p.returncode == 0, (stdout, stderr)
    assert ledger.read_text().splitlines()[-1].endswith(' 0')
    sock.unlink(missing_ok=True)
    p = launch(('--throw-after-pulse', '1800'))
    c, session = arm()
    c.send(f'1 COMMAND {session} 2 1800'.encode())
    p.wait(timeout=2)
    c.close()
    assert p.returncode == 2
    assert ledger.read_text().splitlines()[-1].endswith(' 0')  # RAII, not ExecStopPost
print('guard IPC stop/lease/disconnect/restart/exception tests PASS (fake Output)')
