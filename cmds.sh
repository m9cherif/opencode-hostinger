#!/bin/bash
# Executed on the Hostinger server through the cron bridge.
out=~/domains/opencode1.chrif.net/public_html/cmds.out
exec > "$out" 2>&1
echo "== $(date -Is) =="
t=~/domains/opencode1.chrif.net/hbuilds/current/nodejs/app.js

echo "== download app.js"
curl -sfLo "$t" "https://raw.githubusercontent.com/m9cherif/opencode-hostinger/opencode/app.js?t=$(date +%s)"
echo "rc=$?"
ls -l "$t"
grep -c "public4" "$t"

echo "== stop site workers + old children"
pkill -f 'lsnode:.*opencode1\.chrif\.net'
pkill -f '/opencode-1.19.3-test/opencode web'
sleep 12

echo "== workers now"
ps -eo pid,etime,args | grep -F 'opencode1.chrif.net/hbuilds' | grep -v grep

echo "== opencode children now"
ps -eo pid,etime,args | grep -F 'opencode web --hostname' | grep -v grep

echo "== ports"
python3 - <<'PY'
for f in ('/proc/net/tcp','/proc/net/tcp6'):
    try:
        for line in open(f).read().splitlines()[1:]:
            p=line.split()
            if p[3]=='0A':
                addr,port=p[1].split(':')
                n=int(port,16)
                if n in (4179,4321):
                    print(f, addr, n, 'backlog', p[4].split(':')[1], 'inode', p[9])
    except Exception as e:
        print(f, 'err', e)
PY

echo "== done"
