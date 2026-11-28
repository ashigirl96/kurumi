# U4 analysis over the base-URL gateway's capture: what an approval could show for each real write,
# whether inspected bytes == forwarded bytes (gateway sha256 vs the fake's received sha256), and whether
# a method/path binder or a canonical-body binder catches each swap. Usage: python3 -I u4-analyze.py <run-dir>
import base64, gzip, hashlib, json, re, sys, zlib
R = sys.argv[1]
cap = [json.loads(l) for l in open(f'{R}/gw-capture.jsonl')]
fakes = [json.loads(l) for l in open(f'{R}/fakes.jsonl') if '"host"' in l]
sha = lambda b: hashlib.sha256(b).hexdigest()

def pkt_lines(b):
    i, out = 0, []
    while i + 4 <= len(b):
        n = int(b[i:i + 4], 16)
        if n == 0: return out, b[i + 4:]
        out.append(b[i + 4:i + n]); i += n
    return out, b[i:]

def pack_objects(p):
    # Walks a PACK v2 stream: type and, for non-delta commits, tree/parents/message.
    if p[:4] != b'PACK': return []
    count = int.from_bytes(p[8:12], 'big'); i = 12; objs = []
    names = {1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta'}
    for _ in range(count):
        c = p[i]; i += 1; t = (c >> 4) & 7; size = c & 15; shift = 4
        while c & 0x80: c = p[i]; i += 1; size |= (c & 0x7f) << shift; shift += 7
        if t == 6:
            c = p[i]; i += 1
            while c & 0x80: c = p[i]; i += 1
        elif t == 7: i += 20
        d = zlib.decompressobj(); data = d.decompress(p[i:]); i = len(p) - len(d.unused_data)
        o = {'type': names.get(t, t)}
        if t == 1:
            txt = data.decode(errors='replace')
            o['id'] = hashlib.sha1(b'commit %d\0' % len(data) + data).hexdigest()
            o['parents'] = re.findall(r'^parent (\w+)', txt, re.M)
            o['message'] = txt.split('\n\n', 1)[1].strip()
        objs.append(o)
    return objs

def view(r):
    raw = base64.b64decode(r['body_b64'] or '')
    h = r['headers']; ct = h.get('content-type', ''); ce = h.get('content-encoding', '')
    v = {'method_path': f"{r['method']} {r['host']}{r['path']}"}
    if h.get('transfer-encoding'): v['transfer-encoding'] = h['transfer-encoding']
    body = raw
    if ce:
        v['content-encoding'] = ce
        body = gzip.decompress(raw) if ce == 'gzip' else raw
    canon = None
    if 'json' in ct or (body[:1] == b'{'):
        j = json.loads(body)
        if 'query' in j:
            q = j['query']; m = re.search(r'\b(query|mutation|subscription)\b\s*(\w*)', q)
            root = re.search(r'\{\s*(\w+)', q)
            v['graphql'] = {'operation': m.group(1) if m else 'query', 'name': m.group(2) if m else '', 'root_field': root.group(1) if root else None, 'variables': j.get('variables')}
        elif 'versions' in j and '_attachments' in j:
            att = {k: {'length': a.get('length'), 'sha256_of_tarball': sha(base64.b64decode(a['data']))} for k, a in j['_attachments'].items()}
            v['npm_publish'] = {'name': j.get('name'), 'versions': list(j['versions']), 'attachments': att}
        else:
            v['json'] = j
        canon = json.dumps(j, sort_keys=True, separators=(',', ':')).encode()
    elif ct.startswith('multipart/form-data'):
        boundary = ct.split('boundary=')[1].strip('"').encode()
        parts = []
        for seg in body.split(b'--' + boundary)[1:-1]:
            head, _, content = seg.strip(b'\r\n').partition(b'\r\n\r\n')
            disp = head.decode()
            parts.append({'name': re.search(r'name="([^"]*)"', disp).group(1),
                          'filename': (re.search(r'filename="([^"]*)"', disp) or [None, None])[1],
                          'size': len(content), 'sha256': sha(content)[:16]})
        v['multipart'] = {'boundary': boundary.decode(), 'parts': parts}
        canon = json.dumps(sorted(parts, key=lambda p: p['name']), sort_keys=True).encode()
    elif ct == 'application/x-git-receive-pack-request':
        lines, rest = pkt_lines(body)
        cmds = []
        for ln in lines:
            ref_part = ln.split(b'\0')[0].decode().strip()
            old, new, ref = ref_part.split(' ')
            cmds.append({'old': old[:12], 'new': new[:12], 'ref': ref, 'caps': ln.split(b'\0')[1].decode().split()[:4] if b'\0' in ln else None})
        objs = pack_objects(rest)
        for c in cmds:
            full_new = next((o for o in objs if o.get('id', '').startswith(c['new'])), None)
            c['new_commit_message'] = full_new and full_new['message']
            c['new_parents'] = full_new and [p[:12] for p in full_new['parents']]
            # Walk parents inside the pack only: the gateway has no copy of the upstream's object graph.
            seen, todo, reach = set(), [full_new] if full_new else [], False
            while todo:
                o = todo.pop()
                for par in o['parents']:
                    if par.startswith(c['old']): reach = True
                    nxt = next((x for x in objs if x.get('id') == par), None)
                    if nxt and par not in seen: seen.add(par); todo.append(nxt)
            c['update_kind'] = ('create' if set(c['old']) == {'0'} else 'delete' if set(c['new']) == {'0'}
                                else 'fast-forward (provable from the pack)' if reach
                                else 'not provable from the pack: force or needs the upstream graph')
        v['git_receive_pack'] = {'commands': cmds, 'pack_objects': [o['type'] for o in objs], 'pack_sha256': sha(rest)[:16]}
        canon = json.dumps([[c['old'], c['new'], c['ref']] for c in cmds]).encode() + sha(rest).encode()
    else:
        v['raw_preview'] = body[:120].decode(errors='replace')
        canon = body
    return v, sha(canon)

# label captures by the preceding marker; keep the side-effecting requests
label, cases = None, {}
for r in cap:
    if r.get('verdict') != 'forward': continue
    m = re.match(r'/__mark/(.+)', r['path'])
    if m: label = m.group(1); continue
    write = r['method'] in ('POST', 'PUT', 'PATCH', 'DELETE') and 'git-upload-pack' not in r['path']
    if label and write:
        body = base64.b64decode(r['body_b64'] or b'')
        if r['path'].endswith('graphql') and b'mutation' not in body: continue
        cases.setdefault(label, []).append(r)

# inspected == forwarded: every gateway-forwarded write must reach the fake with the same sha256
fake_shas = {}
for f in fakes: fake_shas.setdefault(f['sha256'], 0); fake_shas[f['sha256']] += 1
checked = [r for rs in cases.values() for r in rs]
same = sum(1 for r in checked if r['sha256'] in fake_shas)
print(f'inspected==forwarded: {same}/{len(checked)} gateway-captured writes arrived at the fake with an identical body sha256\n')

views = {}
for lab, rs in cases.items():
    r = rs[-1]
    v, canon = view(r)
    views[lab] = (r, v, canon)
    print(f'### {lab}  (raw sha256 {r["sha256"][:16]}, canonical {canon[:16]}, {len(rs)} write request(s))')
    print(json.dumps(v, ensure_ascii=False, indent=1)[:1500])

pairs = [('gh-issue-A', 'gh-issue-B'), ('gql-A', 'gql-B'), ('gql-A', 'gql-B-op'), ('git-A', 'git-B-ref'), ('git-A', 'git-B-force'),
         ('mp-A', 'mp-B'), ('gz-A', 'gz-B'), ('chunk-A', 'chunk-B'),
         ('mp-A', 'mp-A-again'), ('gz-A', 'gz-A-again'), ('json-A', 'json-A-reordered')]
print('\n| approved | then sent | same method+path? | method/path binder | raw-bytes digest binder | canonical-body binder |')
print('|---|---|---|---|---|---|')
for a, b in pairs:
    if a not in views or b not in views: print(f'| {a} | {b} | missing | | | |'); continue
    (ra, _, ca), (rb, _, cb) = views[a], views[b]
    mp_same = (ra['method'], ra['host'], ra['path']) == (rb['method'], rb['host'], rb['path'])
    swap = not b.endswith(('again', 'reordered'))
    def verdict(equal):
        if swap: return 'misses the swap (allows B)' if equal else 'catches the swap'
        return 'accepts the re-send' if equal else 'rejects the same intent (false positive)'
    print(f"| {a} | {b} | {'yes' if mp_same else 'no: ' + rb['method'] + ' ' + rb['path']} | {verdict(mp_same)} | {verdict(mp_same and ra['sha256'] == rb['sha256'])} | {verdict(mp_same and ca == cb)} |")
