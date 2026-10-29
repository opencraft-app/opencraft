#!/usr/bin/env python3
"""Build owned synthetic native history and run the real Core/AppHost regression.

No inference, existing profiles, credentials, or user histories are used. The
bounded local link is an explicit reproducibility condition, not natural data.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import uuid


def native_fixture(native, root, count, output_bytes):
    bootstrap = root / 'bootstrap'
    bootstrap.mkdir()
    env = {key: value for key, value in os.environ.items()
           if key in ('PATH', 'HOME', 'LANG', 'USER', 'SHELL', 'TMPDIR')}
    env['CODEX_HOME'] = str(bootstrap)
    messages = queue.Queue()
    with (root / 'native-bootstrap.log').open('w') as log:
        process = subprocess.Popen([native, 'app-server', '--listen', 'stdio://'],
                                   cwd=root, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=log, text=True)
        def receive():
            for line in process.stdout:
                messages.put(json.loads(line))
        threading.Thread(target=receive, daemon=True).start()
        def rpc(number, method, params):
            process.stdin.write(json.dumps({'id': number, 'method': method, 'params': params}) + '\n')
            process.stdin.flush()
            while True:
                message = messages.get(timeout=30)
                if message.get('id') == number:
                    if 'error' in message:
                        raise RuntimeError(f"Synthetic seed {method}: {message['error']}")
                    return message['result']
        try:
            rpc(1, 'initialize', {'clientInfo': {'name': 'synthetic-history-regression', 'version': '1'},
                                  'capabilities': {'experimentalApi': True}})
            process.stdin.write('{"method":"initialized"}\n')
            process.stdin.flush()
            started = rpc(2, 'thread/start', {'cwd': str(root), 'persistExtendedHistory': True,
                                            'baseInstructions': 'Synthetic local history fixture. Never call a model.'})
            rpc(3, 'thread/shellCommand', {'threadId': started['thread']['id'],
                                          'command': 'printf stage18-synthetic-seed', 'timeoutMs': 1000})
            while messages.get(timeout=30).get('method') != 'turn/completed':
                pass
        finally:
            process.terminate()
            process.wait(timeout=15)
    rollout = next(bootstrap.glob('sessions/**/*.jsonl'))
    records = [json.loads(line) for line in rollout.read_text().splitlines()]
    events = [row['payload'] for row in records if row['type'] == 'event_msg']
    start = next(row for row in events if row['type'] in ('task_started', 'turn_started'))
    complete = next(row for row in events if row['type'] in ('task_complete', 'turn_complete'))
    command = next(row for row in events if row['type'] == 'item_completed'
                   and row['item']['type'] == 'CommandExecution')
    home = root / 'corpus'
    home.mkdir()
    path = home / rollout.relative_to(bootstrap)
    path.parent.mkdir(parents=True)
    for name in ('state_5.sqlite', 'thread_history_1.sqlite'):
        with sqlite3.connect(f'file:{bootstrap/name}?mode=ro', uri=True) as source:
            with sqlite3.connect(home/name) as destination:
                source.backup(destination)
    database = sqlite3.connect(home/'thread_history_1.sqlite')
    database.row_factory = sqlite3.Row
    turn_template = dict(database.execute('SELECT * FROM thread_turns LIMIT 1').fetchone())
    item_template = dict(database.execute('SELECT * FROM thread_items LIMIT 1').fetchone())
    item_body = json.loads(item_template['item_json'])
    for table in ('thread_items', 'thread_turns', 'thread_history_projection_state'):
        database.execute('DELETE FROM ' + table)
    ordinal = 0
    with path.open('wb') as output:
        def write(kind, payload):
            nonlocal ordinal
            output.write((json.dumps({'timestamp': records[0]['timestamp'], 'ordinal': ordinal,
                                      'type': kind, 'payload': payload}, separators=(',', ':')) + '\n').encode())
            ordinal += 1
        meta = records[0]['payload']
        meta['base_instructions'] = {'text': ''}
        thread_id = meta['id']
        write('session_meta', meta)
        for number in range(count):
            turn_id, item_id = str(uuid.uuid4()), f'synthetic-command-{number}'
            begin_ordinal, begin_offset = ordinal, output.tell()
            old_turn = start['turn_id']
            write('event_msg', json.loads(json.dumps(start).replace(old_turn, turn_id)))
            event = json.loads(json.dumps(command))
            event['turn_id'] = turn_id
            event['item'].update(id=item_id, status='completed', exit_code=0,
                                 aggregated_output=f'synthetic-output-{number}\n' + 'x' * output_bytes)
            write('event_msg', event)
            write('event_msg', json.loads(json.dumps(complete).replace(old_turn, turn_id)))
            turn = {**turn_template, 'turn_id': turn_id, 'root_turn_id': turn_id,
                    'rollout_ordinal': begin_ordinal, 'rollout_byte_offset': begin_offset,
                    'rollout_end_ordinal': ordinal - 1, 'rollout_end_byte_offset': output.tell()}
            body = {**item_body, 'id': item_id, 'aggregatedOutput': event['item']['aggregated_output']}
            item = {**item_template, 'turn_id': turn_id, 'item_id': item_id,
                    'rollout_ordinal': begin_ordinal + 1, 'updated_at_ordinal': begin_ordinal + 1,
                    'item_json': json.dumps(body, separators=(',', ':'))}
            for table, row in (('thread_turns', turn), ('thread_items', item)):
                database.execute('INSERT INTO ' + table + '(' + ','.join(row) + ') VALUES ('
                                 + ','.join('?' for _ in row) + ')', list(row.values()))
        database.execute('INSERT INTO thread_history_projection_state VALUES (?,?,?)',
                         (thread_id, output.tell(), ordinal))
    database.commit()
    database.close()
    with sqlite3.connect(home/'state_5.sqlite') as state:
        state.execute('UPDATE threads SET rollout_path=? WHERE id=?', (str(path), thread_id))
    manifest = root/'fixture.json'
    manifest.write_text(json.dumps({'synthetic': True, 'home': str(home), 'path': str(path),
                                    'threadId': thread_id, 'turns': count, 'outputBytes': output_bytes}))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', required=True, help='OpenCraft native Codex executable')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2], help='OpenCraft checkout to exercise')
    parser.add_argument('--fixture', type=Path, help='Reuse a manifest from this synthetic generator')
    parser.add_argument('--turns', type=int, default=601)
    parser.add_argument('--output-bytes', type=int, default=524288)
    parser.add_argument('--mib-per-second', type=float, default=6)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--web-root', type=Path, help='Optional built Headless Application for DOM first paint')
    parser.add_argument('--chromium', help='Optional Chromium executable for DOM validation')
    parser.add_argument('--out', type=Path, help='Parent directory for a fresh evidence directory')
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix='history-cold-repro-', dir=args.out))
    fixture = args.fixture.resolve() if args.fixture else native_fixture(args.native, root, args.turns, args.output_bytes)
    command = [args.node, '--import', 'tsx', str(Path(__file__).with_suffix('.ts')),
               '--native', str(Path(args.native).resolve()), '--repo', str(args.repo.resolve()),
               '--fixture', str(fixture), '--mib-per-second', str(args.mib_per_second)]
    if args.web_root:
        command += ['--web-root', str(args.web_root.resolve()), '--screenshot', str(root/'first-paint.png')]
    if args.chromium:
        command += ['--chromium', args.chromium]
    with (root/'result.log').open('w') as output:
        result = subprocess.run(command, cwd=Path(__file__).resolve().parents[2], stdout=output,
                                stderr=subprocess.STDOUT, check=False, timeout=180)
    print(json.dumps({'synthetic': True, 'passed': result.returncode == 0, 'fixture': str(fixture),
                       'evidence': str(root), 'result': str(root/'result.log')}))
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
