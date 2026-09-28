#!/usr/bin/env python3
"""隔离 dev 对象库中的失败激活回归；仅终止本测试启动的进程。"""
import argparse
import json
import hashlib
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

parser = argparse.ArgumentParser()
parser.add_argument('binary', type=Path)
parser.add_argument('--expect-leak', action='store_true', help='验证旧版本确实出现资源增长')
parser.add_argument('--rounds', type=int, default=30)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='celld-failed-activation-'))
env = {k: v for k, v in os.environ.items() if not k.startswith(('CELLD_', 'AWS_', 'S3_'))}
env.update(CELLD_TOKIO_THREADS='1', CELLD_WAKER_TICK_MS='1000')
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
base = f'http://127.0.0.1:{port}'
child = None
log = None
source = '''
class Counter {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const sql = this.state.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS entries(v TEXT)").toArray();
    if (new URL(req.url).pathname === "/write") {
      sql.exec("INSERT INTO entries VALUES (?)", "keep-me").toArray();
      this.state.storage.kv.put("baseline", "keep-kv");
    }
    return Response.json({rows: sql.exec("SELECT v FROM entries ORDER BY rowid").toArray(),
      kv: this.state.storage.kv.get("baseline") ?? null});
  }
}
export class LostCell extends Counter {}
export class NeighborCell extends Counter {}
export default { async fetch(req, env) {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok");
  const ns = url.searchParams.has("neighbor") ? env.NEIGHBOR : env.LOST;
  return ns.get(ns.idFromName("test")).fetch(req);
}};
'''
config = {'name': 'failed-activation', 'main': 'index.js', 'compatibility_date': '2025-03-01',
          'durable_objects': {'bindings': [{'name': 'LOST', 'class_name': 'LostCell'},
                                         {'name': 'NEIGHBOR', 'class_name': 'NeighborCell'}]},
          'migrations': [{'tag': 'v1', 'new_sqlite_classes': ['LostCell', 'NeighborCell']}]}
(root / 'wrangler.jsonc').write_text(json.dumps(config))
(root / 'index.js').write_text(source)

def request(path):
    try:
        with urllib.request.urlopen(base + path, timeout=15) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def stop():
    global child, log
    if child is not None:
        child.send_signal(signal.SIGINT)
        try:
            child.wait(timeout=45)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise AssertionError('dev 未在 45 秒内退出')
        child = None
        log.close()

def start(stage):
    global child, log
    log = (root / f'{stage}.log').open('w')
    child = subprocess.Popen([str(args.binary.resolve()), 'dev', '--no-watch', '--logs', '--port', str(port)],
                             cwd=root, env=env, stdout=log, stderr=log, start_new_session=True)
    for _ in range(150):
        assert child.poll() is None, f'启动失败，见 {root}/{stage}.log'
        try:
            if request('/health')[0] == 200:
                return
        except (OSError, TimeoutError):
            pass
        time.sleep(.2)
    raise AssertionError('启动超时')

def data(neighbor=False):
    status, body = request('/read' + ('?neighbor' if neighbor else ''))
    assert status == 200, (status, body)
    return json.loads(body)

def sample(cell):
    # dev 子进程才是持有 SQLite 的节点；lsof 的 f 字段逐个描述符计数。
    pids = subprocess.check_output(['pgrep', '-P', str(child.pid)], text=True).split()
    result = subprocess.run(['lsof', '-nP', '-a', '-p', ','.join(pids), '-Ffn'], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    fds = 0
    fd = ''
    for line in result.stdout.splitlines():
        if line.startswith('f'):
            fd = line[1:]
        elif line.startswith('n') and cell in line and 'db.sqlite' in line and fd[:1].isdigit():
            fds += 1
    dirs = [root / '.celld/dev/runtime' / cell / 'ltx']
    assert dirs[0].is_dir(), dirs
    assert len(dirs) == 1, dirs
    files = [p for p in dirs[0].rglob('*') if p.is_file()]
    return {'fds': fds, 'epochs': len(list(dirs[0].glob('e*'))), 'files': len(files),
            'bytes': sum(p.stat().st_size for p in files)}

report = {'binary': str(args.binary.resolve()), 'sha256': hashlib.file_digest(args.binary.open('rb'), 'sha256').hexdigest(),
          'directory': str(root), 'samples': []}
try:
    start('initial')
    assert request('/write')[0] == 200
    assert request('/write?neighbor')[0] == 200
    expected = {'rows': [{'v': 'keep-me'}], 'kv': 'keep-kv'}
    assert data() == expected
    assert data(True) == expected
    stop()
    dbpath = root / '.celld/dev/objects.sqlite3'
    with sqlite3.connect(dbpath) as db:
        keys = [r[0] for r in db.execute("SELECT key FROM objects WHERE key LIKE '%LostCell%/own.json'")]
        assert len(keys) == 1, keys
        cell = keys[0].split('/')[-2]
        # 写入本测试自己的旧 migration seed，触发周期扫描和 cleanup 两条 wake 路径。
        key = f'wake/entries/1970-01-01T00:00/{cell}/migration'
        etag = db.execute('SELECT next_etag FROM store_sequence').fetchone()[0]
        db.execute('UPDATE store_sequence SET next_etag = next_etag + 1')
        db.execute('INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?, ?)',
                   (key, json.dumps({'format': 2, 'cell': cell, 'migration_seed': True}).encode(),
                    etag, int(time.time()*1000), '{}'))
    report['cell'] = cell
    (root / 'index.js').write_text(source.replace('export class LostCell extends Counter {}', ''))
    missing_config = json.loads(json.dumps(config))
    missing_config['durable_objects']['bindings'] = [config['durable_objects']['bindings'][1]]
    missing_config['migrations'][0]['new_sqlite_classes'] = ['NeighborCell']
    (root / 'wrangler.jsonc').write_text(json.dumps(missing_config))
    start('missing')
    for i in range(args.rounds):
        status, body = request('/read')
        assert status == 500, (status, body)
        assert data(True) == expected
        assert request('/health')[0] == 200
        time.sleep(1)
        if i % 5 == 4:
            report['samples'].append(sample(cell))
            print(json.dumps(report['samples'][-1]), flush=True)
    # 不再发起失败请求，保留足够时间让两条周期 wake 路径各运行多轮。
    time.sleep(5)
    report['samples'].append(sample(cell))
    failure_log = (root / 'missing.log').read_text()
    report['failed_starts'] = failure_log.count(f'celld runtime start failed for {cell}: no Worker exports')
    assert report['failed_starts'] >= args.rounds, report
    first, last = report['samples'][0], report['samples'][-1]
    if args.expect_leak:
        assert last['fds'] >= first['fds'] + 20, report
        assert last['epochs'] > first['epochs'], report
    else:
        assert max(s['fds'] for s in report['samples']) <= 10, report
        assert max(s['epochs'] for s in report['samples']) <= 3, report
        assert max(s['bytes'] for s in report['samples']) <= first['bytes'] + 1024*1024, report
    stop()
    (root / 'index.js').write_text(source)
    (root / 'wrangler.jsonc').write_text(json.dumps(config))
    start('restored')
    assert data() == expected
    assert data(True) == expected
    stop()
    start('restarted')
    assert data() == expected
    assert data(True) == expected
    report['sql_kv_restored_and_restarted'] = True
    report['neighbor_healthy'] = True
    report['result'] = 'PASS old leak reproduced' if args.expect_leak else 'PASS cleanup and data recovery'
    print(json.dumps(report, indent=2), flush=True)
finally:
    stop()
    (root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'证据目录：{root}', flush=True)
