"""Real subprocess/socket fault tests with a compile-time fake Output, never sysfs/GPIO."""
import errno, os, signal, socket, subprocess, sys, tempfile, time
from pathlib import Path
server = sys.argv[1]
def connect(path):
    s=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);s.settimeout(1);s.connect(str(path));return s
def call(s, op, session=0, seq=0, pulse=0):
    s.send(f'1 {op} {session} {seq} {pulse}'.encode())
    r=s.recv(256).decode().split(); assert r[0]=='1';return r
def waitfor(test, timeout=2):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if test():return
        time.sleep(.01)
    raise AssertionError('deadline exceeded')
with tempfile.TemporaryDirectory(prefix='questix-ipc-') as directory:
    d=Path(directory);sock=d/'control';ledger=d/'writes'
    def launch():
        p=subprocess.Popen([server,'--socket',str(sock),'--lock',str(d/'lock'),'--fake-log',str(ledger),'--allowed-uid',str(os.getuid()),'--admin-uid',str(os.getuid()),'--socket-gid',str(os.getgid())],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        waitfor(lambda:sock.exists() or p.poll() is not None)
        assert p.poll() is None, p.communicate()
        return p
    def authorize_and_arm(admin):
        assert call(admin,'AUTHORIZE')[1]=='1'
        client=connect(sock);r=call(client,'ARM');assert r[1]=='1' and r[2]=='ARMING'
        session=int(r[4]);assert call(client,'COMPLETE',session,1)[1]=='1';return client,session
    p=launch()
    try:
        a=connect(sock);assert call(a,'ARM')[1]=='0'
        # Root/admin socket is not an owner; permission to authorize does not grant a session.
        c,s=authorize_and_arm(a)
        assert call(c,'COMMAND',s,2,1800)[1]=='1'
        attacker=connect(sock);assert call(attacker,'COMMAND',s,3,2000)[1]=='0';attacker.close()
        assert call(c,'SHUTDOWN',s,3)[1]=='1'
        assert call(c,'COMMAND',s,4,1000)[1]=='0'
        time.sleep(.55);r=call(c,'STATUS');assert r[2]=='TERMINAL_LOW' and r[3]=='0'
        c.close();time.sleep(.03)
        # Lease expiry, with the client socket still open, stops the output.
        c,s=authorize_and_arm(a);assert call(c,'COMMAND',s,2,1800)[1]=='1'
        time.sleep(1.1);r=call(c,'COMMAND',s,3,1000);assert r[1]=='0' and r[2]=='FAULT_LOW' and r[3]=='0'
        # Successful diagnostic/stop RPCs must retain the original lease fault cause.
        r=call(c,'STATUS');assert r[1]=='1' and int(r[5])==-errno.ETIMEDOUT
        r=call(c,'STOP',s,4);assert r[1]=='1' and r[2]=='FAULT_LOW' and int(r[5])==-errno.ETIMEDOUT
        c.close();time.sleep(.03)
        # Real owner process SIGKILL and SIGSTOP, not just voluntary socket close.
        owner_code = """import socket,sys,signal
s=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);s.connect(sys.argv[1])
def call(op,session=0,seq=0,pulse=0):
 s.send(f'1 {op} {session} {seq} {pulse}'.encode());return s.recv(256).decode().split()
r=call('ARM');assert r[1]=='1';session=int(r[4]);assert call('COMPLETE',session,1)[1]=='1'
assert call('COMMAND',session,2,1800)[1]=='1'
print('READY',flush=True);signal.pause()
"""
        for sig in (signal.SIGKILL,signal.SIGSTOP):
            assert call(a,'AUTHORIZE')[1]=='1'
            child=subprocess.Popen([sys.executable,'-c',owner_code,str(sock)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                assert child.stdout.readline().strip()==b'READY'
                os.kill(child.pid,sig)
                waitfor(lambda:call(a,'STATUS')[2]=='FAULT_LOW')
            finally:
                if child.poll() is None:child.kill()
                child.communicate(timeout=2)
            time.sleep(.03)
        # After guard SIGKILL/restart, there is no recovered arm ticket or pulse command.
        a.close();p.kill();p.wait(timeout=2);sock.unlink()
        p=launch();a=connect(sock);assert call(a,'STATUS')[3]=='0';assert call(a,'ARM')[1]=='0';a.close()
    finally:
        if p.poll() is None:p.terminate()
        stdout,stderr=p.communicate(timeout=3)
        assert p.returncode==0,(stdout,stderr)
    assert ledger.read_text().splitlines()[-1].endswith(' 0')
print('guard IPC shutdown/lease/disconnect/restart/session tests PASS (fake Output)')
