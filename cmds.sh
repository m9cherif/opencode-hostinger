#!/bin/bash
# Executed on the Hostinger server through the cron bridge.
out=~/domains/opencode1.chrif.net/public_html/cmds.out
exec > "$out" 2>&1
echo "== $(date -Is) =="
b=~/opencode-1.19.3-test/opencode

echo "== version"
"$b" --version 2>&1 | head -3

echo "== web help"
"$b" web --help 2>&1 | head -70

echo "== serve help"
"$b" serve --help 2>&1 | head -40

echo "== node candidates"
ls /opt/alt/alt-nodejs*/root/usr/bin/node 2>/dev/null
command -v lsnode
ls -l /usr/local/bin/lsnode 2>/dev/null

echo "== python tcp self test on 4400"
(python3 -m http.server 4400 --bind 127.0.0.1 >/dev/null 2>&1 &)
sleep 1
curl -s -m 3 -o /dev/null -w "py127=%{http_code}\n" http://127.0.0.1:4400/ ; echo "rc=$?"
pkill -f "http.server 4400" 2>/dev/null

echo "== unix socket test"
rm -f /tmp/t.sock
python3 -c "
import socket,os
p='/tmp/t.sock'
s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(1)
c,_=s.accept(); c.send(b'UNIX-OK'); c.close(); s.close()
" &
sleep 1
python3 -c "
import socket
c=socket.socket(socket.AF_UNIX); c.connect('/tmp/t.sock')
print('unix_recv', c.recv(16))
" 2>&1

echo "== child 4321 via 127.0.0.1"
curl -s -m 3 -o /dev/null -w "c127=%{http_code}\n" http://127.0.0.1:4321/ ; echo "rc=$?"
echo "== child 4321 via public ipv4"
curl -s -m 3 -o /dev/null -w "c4=%{http_code}\n" http://217.65.157.33:4321/ ; echo "rc=$?"
echo "== child 4321 via hostname"
getent hosts opencode1.chrif.net
curl -s -m 3 -o /dev/null -w "chost=%{http_code}\n" https://opencode1.chrif.net:4321/ ; echo "rc=$?"

echo "== interfaces"
hostname -I 2>/dev/null
ip -o addr 2>/dev/null | head -6

echo "== done"
