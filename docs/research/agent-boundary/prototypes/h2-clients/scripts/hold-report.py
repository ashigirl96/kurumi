# Joins the hold gateway's capture with each client's START/END lines into one table per client.
import json, os, re, sys
from datetime import datetime
O = sys.argv[1]
def client_of(host, path):
    if host == 'echo.gw': return 'curl' if path.startswith('/curl') else 'node-fetch'
    if host == 'holdup.example': return 'curl-via-iron'
    if host == 'git.gw': return 'git-push'
    if host == 'npm.gw': return 'npm-publish' if path.startswith('/pub-fake') else 'npm-install'
    if host == 'api.gw': return 'gh'
    if host in ('pypi.gw', 'files.gw'): return 'pip'
    if host == 'modelhold.gw': return 'claude-model'
    if host in ('model.gw', 'docs.gw'): return 'claude-webfetch'
    return '?'
ts = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
reqs, events = {}, {}
cap = os.path.join(O, 'hold-capture.jsonl')
for line in open(cap) if os.path.exists(cap) else []:
    j = json.loads(line)
    if 'event' in j: events.setdefault(j['id'], []).append(j)
    else: reqs[j['id']] = j
for c in ['curl', 'curl-via-iron', 'git-push', 'npm-install', 'npm-publish', 'gh', 'pip', 'node-fetch', 'claude-model', 'claude-webfetch']:
    f = os.path.join(O, c + '.txt')
    txt = open(f).read() if os.path.exists(f) else ''
    st = re.search(r'^START (\d+)', txt, re.M); en = re.search(r'^END (\d+) exit=(\d+)', txt, re.M)
    start = int(st.group(1)) if st else None
    print(f'## {c}')
    if st and en: print(f'client ran {int(en.group(1)) - start} s, exit={en.group(2)}')
    else: print('client did not finish inside the window' if st else 'client never started')
    held = [r for r in reqs.values() if client_of(r['host'], r['path']) == c]
    for r in sorted(held, key=lambda r: r['id']):
        ev = events.get(r['id'], [])
        if not any(e['event'] == 'hold-start' for e in ev): continue
        rel = ts(r['at']) - start if start else float('nan')
        desc = ', '.join(f"{e['event']}@{e.get('after_s', '')}s" + (f" status={e['status']}" if 'status' in e else '') for e in ev if e['event'] != 'hold-start')
        print(f"  held request #{r['id']} {r['method']} {r['host']}{r['path'][:60]} arrived +{rel:.1f}s: {desc or 'still held at collection'}")
    tail = [l for l in txt.strip().splitlines() if not l.startswith(('START', 'END'))][-4:]
    for l in tail: print('  | ' + l[:220])
