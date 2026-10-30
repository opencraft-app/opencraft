#!/usr/bin/python3
"""Opt-in Linux guard for one registered, already-delegated generation.

No argv, environment, session contents or tool output are read. Registration and
unit creation belong to the installer; this program never enables delegation.
"""
import argparse
from datetime import datetime, timezone
import json
import errno
import fnmatch
import os
from pathlib import Path
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import time


def identity(pid):
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
        fields = raw[raw.rindex(')') + 2:].split()
        return int(fields[1]), int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


def same_process(pid, stamp):
    observed = identity(pid)
    return bool(observed and stamp and observed[1] == stamp[1])


def children(pid):
    result = set()
    try:
        for task in Path(f'/proc/{pid}/task').iterdir():
            try:
                result.update(map(int, (task / 'children').read_text().split()))
            except FileNotFoundError:
                continue
    except FileNotFoundError:
        pass
    return result


def process_cgroup(pid):
    lines = Path(f'/proc/{pid}/cgroup').read_text().splitlines()
    return next(line[3:] for line in lines if line.startswith('0::'))


def anonymous_bytes(pid):
    try:
        lines = Path(f'/proc/{pid}/status').read_text().splitlines()
        return next(int(line.split()[1]) * 1024 for line in lines if line.startswith('RssAnon:'))
    except (OSError, StopIteration):
        return 0


def fork_events(data):
    """Decode complete netlink messages, excluding thread-only fork events."""
    offset = 0
    while offset + 16 <= len(data):
        length, kind = struct.unpack_from('=IH', data, offset)
        if length < 16 or offset + length > len(data):
            raise ValueError('truncated connector message')
        if kind in (2, 4):
            raise ValueError('connector loss or error')
        if length >= 60:
            idx, val = struct.unpack_from('=II', data, offset + 16)
            if (idx, val) == (1, 1):
                what, _, timestamp = struct.unpack_from('=IIQ', data, offset + 36)
                if what == 1 and length >= 68:
                    _, parent, child, tgid = struct.unpack_from('=IIII', data, offset + 52)
                    if child == tgid:
                        yield parent, child, timestamp
                elif what == 2:
                    pid, tgid = struct.unpack_from('=II', data, offset + 52)
                    if pid == tgid:
                        yield None, pid, timestamp
                elif what == 0x80000000:
                    pid, tgid = struct.unpack_from('=II', data, offset + 52)
                    if pid == tgid:
                        yield -1, pid, timestamp
        offset += (length + 3) & ~3


def connector():
    sock = socket.socket(socket.AF_NETLINK, socket.SOCK_DGRAM, 11)
    try:
        sock.bind((os.getpid(), 1))
        body = struct.pack('=IIIIHHI', 1, 1, 0, 0, 4, 0, 1)
        sock.send(struct.pack('=IHHII', 16 + len(body), 3, 0, 1, os.getpid()) + body)
        deadline = time.monotonic() + 2
        accepted = False
        while not accepted and time.monotonic() < deadline:
            sock.settimeout(max(.001, deadline - time.monotonic()))
            data = sock.recv(1024 * 1024)
            offset = 0
            while offset + 16 <= len(data):
                length, kind = struct.unpack_from('=IH', data, offset)
                if length < 16 or offset + length > len(data) or kind in (2, 4):
                    raise OSError('connector subscription failed')
                if length >= 56 and struct.unpack_from('=II', data, offset + 16) == (1, 1) and struct.unpack_from('=I', data, offset + 36)[0] == 0:
                    if struct.unpack_from('=I', data, offset + 52)[0]:
                        raise OSError('connector subscription rejected')
                    accepted = True
                offset += (length + 3) & ~3
        if not accepted:
            raise OSError('connector subscription acknowledgement timed out')
        sock.setblocking(False)
        return sock
    except BaseException:
        sock.close()
        raise


def command_name(pid):
    try:
        # Kernel comm only: never argv, environment, cwd or session content.
        value = Path(f'/proc/{pid}/comm').read_text().strip()
        return ''.join(c if c.isprintable() else '?' for c in value)[:64] or 'unknown'
    except OSError:
        return 'unknown'


class MemoryObserver:
    def __init__(self, unit, emit):
        self.unit, self.emit = unit, emit
        self.poll = select.poll()
        self.tracked, self.by_fd = {}, {}

    def track(self, group, pid):
        if group in self.tracked:
            return
        fd = os.open(group / 'memory.events', os.O_RDONLY | os.O_CLOEXEC)
        self.tracked[group] = {'fd': fd, 'counts': {}, 'names': [], 'pid': pid}
        self.by_fd[fd] = group
        self.poll.register(fd, select.POLLPRI | select.POLLERR)
        self.name(group, pid)
        self.observe(group)

    def name(self, group, pid):
        record = self.tracked.get(group)
        if record:
            name = command_name(pid)
            if name != 'unknown' and name not in record['names']:
                record['names'] = (record['names'] + [name])[-32:]

    def observe(self, group):
        record = self.tracked.get(group)
        if not record:
            return
        try:
            os.lseek(record['fd'], 0, os.SEEK_SET)
            counts = dict((k, int(v)) for k, v in (line.split() for line in os.read(record['fd'], 4096).decode().splitlines()))
            peak = int((group / 'memory.peak').read_text())
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ENODEV, errno.ESRCH):
                return
            raise
        old = record['counts']
        high = counts.get('high', 0) - old.get('high', 0)
        killed = counts.get('oom_kill', 0) - old.get('oom_kill', 0)
        group_killed = counts.get('oom_group_kill', 0) - old.get('oom_group_kill', 0)
        for event, delta in [('tool-memory-high', high), ('tool-memory-oom', group_killed or killed)]:
            if delta > 0:
                self.emit(event, generation=self.unit, tool_group=group.name,
                          command_name=(record['names'] or ['unknown'])[-1], command_names=record['names'],
                          memory_peak_bytes=peak, timestamp=datetime.now(timezone.utc).isoformat(),
                          occurrences=delta, high_total=counts.get('high', 0),
                          oom_kill_total=counts.get('oom_kill', 0), oom_kill_delta=killed, oom_group_kill_delta=group_killed,
                          observation_key=f"{self.unit}/{group.name}/{event}/{counts.get('high', 0)}/{counts.get('oom_kill', 0)}")
        record['counts'] = counts

    def drain(self):
        for fd, _ in self.poll.poll(0):
            group = self.by_fd.get(fd)
            if group is not None:
                self.observe(group)

    def drop(self, group):
        self.observe(group)
        record = self.tracked.pop(group, None)
        if record:
            self.poll.unregister(record['fd'])
            self.by_fd.pop(record['fd'], None)
            os.close(record['fd'])

    def close(self):
        for group in tuple(self.tracked):
            self.drop(group)


def recover_group_limit(group):
    # mkdir and the following controller writes are not atomic. An empty group
    # left by SIGKILL can still have memory.max=max; remove it before parsing.
    populated = dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines())['populated']
    if populated == '0':
        for child in sorted((p for p in group.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            child.rmdir()
        group.rmdir()
        return None
    return int((group / 'memory.max').read_text())


class Guard:
    def __init__(self, unit, native_pid, high, maximum, pids_max='max'):
        if not re.fullmatch(r'[A-Za-z0-9_.:@\\-]+\.service', unit):
            raise ValueError('invalid owner unit')
        raw = subprocess.check_output(['systemctl', 'show', unit, '-p', 'ControlGroup', '-p', 'Delegate', '-p', 'DelegateSubgroup', '-p', 'OOMPolicy', '-p', 'MainPID', '-p', 'MemoryMax'], text=True)
        props = dict(line.split('=', 1) for line in raw.splitlines())
        relative = props['ControlGroup']
        if not relative.endswith('/' + unit) or '..' in relative.split('/'):
            raise ValueError('owner cgroup mismatch')
        if props['Delegate'] != 'yes' or props['DelegateSubgroup'] != 'app' or props['OOMPolicy'] != 'continue':
            raise ValueError('owner requires delegation, app leaf and OOMPolicy=continue')
        if not 0 < high <= maximum or not props['MemoryMax'].isdigit():
            raise ValueError('invalid limits or unbounded owner')
        self.relative, self.root = relative, Path('/sys/fs/cgroup' + relative)
        self.native, self.native_id = native_pid, identity(native_pid)
        self.owner, self.owner_id = int(props['MainPID']), identity(int(props['MainPID']))
        if not self.native_id or not self.owner_id or not self.contains(native_pid) or self.contains(os.getpid()):
            raise ValueError('unverified native or guard placement')
        self.high, self.maximum, self.pids_max = high, maximum, pids_max
        self.memory = MemoryObserver(unit, self.emit)
        self.protected = {native_pid, self.owner}
        current = native_pid
        while current != self.owner:
            state = identity(current)
            if not state or state[0] <= 1:
                raise ValueError('native is not an owner descendant')
            current = state[0]
            self.protected.add(current)
        self.members = {}
        self.dirty = set()
        self.groups = {}
        for group in self.root.glob('tool-*'):
            if not re.fullmatch(r'tool-\d+-\d+', group.name) or group.is_symlink():
                raise ValueError('unrecognized tool group')
            # Capture counters/peak even for empty groups before removing them.
            self.memory.track(group, int(group.name.split('-')[1]))
            limit = recover_group_limit(group)
            if limit is not None:
                self.groups[group] = limit
            else:
                self.memory.drop(group)
        if not {'memory', 'pids'} <= set((self.root / 'cgroup.subtree_control').read_text().split()):
            if (self.root / 'cgroup.procs').read_text().strip():
                raise ValueError('delegated root still contains processes')
            (self.root / 'cgroup.subtree_control').write_text('+memory +pids')

    def contains(self, pid):
        try:
            path = process_cgroup(pid)
            return path == self.relative or path.startswith(self.relative + '/')
        except (OSError, StopIteration):
            return False

    def alive(self):
        return same_process(self.native, self.native_id) and same_process(self.owner, self.owner_id)

    def retire(self, pid):
        member = self.members.get(pid)
        if member:
            self.dirty.add(member[1])

    def release_finished(self):
        for group in tuple(self.dirty):
            try:
                populated = dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines())['populated']
                self.dirty.discard(group)
                if populated == '0':
                    self.memory.drop(group)
                    for child in sorted((p for p in group.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
                        child.rmdir()
                    group.rmdir()
                    self.groups.pop(group, None)
                    self.dirty.discard(group)
            except FileNotFoundError:
                self.memory.drop(group)
                self.groups.pop(group, None)
                self.dirty.discard(group)

    def collect(self):
        self.dirty.update(self.groups)
        self.release_finished()
        for pid, (stamp, _) in list(self.members.items()):
            if not same_process(pid, stamp):
                del self.members[pid]

    def move(self, pid, stamp, group):
        if not same_process(pid, stamp) or not self.contains(pid) or pid in self.protected:
            return False
        try:
            with Path(f'/proc/{pid}/oom_score_adj').open('w') as score:
                if not same_process(pid, stamp):
                    return False
                score.write('0')
            (group / 'cgroup.procs').write_text(str(pid))
        except (ProcessLookupError, FileNotFoundError):
            return False
        if not same_process(pid, stamp):
            return False
        self.members[pid] = (stamp, group)
        self.memory.name(group, pid)
        return True

    def adopt(self, parent, pid, timestamp):
        if pid in self.protected or (parent not in self.protected and parent not in self.members):
            return
        stamp = identity(pid)
        if not stamp:
            return
        if pid in self.members and self.members[pid][0][1] == stamp[1]:
            group = self.members[pid][1]
            try:
                location = process_cgroup(pid)
                if location == self.relative + '/' + group.name or location.startswith(self.relative + '/' + group.name + '/'):
                    self.memory.name(group, pid)
                    return
            except (OSError, StopIteration):
                return
            del self.members[pid]
        if not self.alive() or not self.contains(pid):
            return
        inherited = self.members.get(parent)
        if inherited and same_process(parent, inherited[0]):
            self.move(pid, stamp, inherited[1])
            return
        if parent not in self.protected:
            return
        self.release_finished()
        before_anon = anonymous_bytes(pid)
        group = self.root / f'tool-{pid}-{stamp[1]}'
        group.mkdir()
        try:
            for name, value in [('memory.high', self.high), ('memory.max', self.maximum), ('memory.swap.max', 0), ('memory.oom.group', 1), ('pids.max', self.pids_max)]:
                (group / name).write_text(str(value))
            self.groups[group] = self.maximum
            self.memory.track(group, pid)
            if not self.move(pid, stamp, group):
                self.dirty.add(group)
                self.release_finished()
                return
        except BaseException:
            # Leave any populated group constrained and discoverable on restart.
            if not (group / 'cgroup.procs').read_text().strip():
                group.rmdir()
                self.groups.pop(group, None)
            raise
        residual_upper = max(before_anon, anonymous_bytes(pid))
        pending = list(children(pid))
        seen = {pid}
        while pending:
            descendant = pending.pop()
            if descendant in seen or descendant in self.protected:
                continue
            seen.add(descendant)
            child_stamp = identity(descendant)
            if child_stamp:
                try:
                    location = process_cgroup(descendant)
                except (OSError, StopIteration):
                    continue
                if location == self.relative + '/' + group.name or location.startswith(self.relative + '/' + group.name + '/'):
                    self.members[descendant] = (child_stamp, group)
                else:
                    before_child = anonymous_bytes(descendant)
                    self.move(descendant, child_stamp, group)
                    residual_upper += max(before_child, anonymous_bytes(descendant))
                pending.extend(children(descendant))
        self.emit('adopted', pid=pid, pre_adoption_anon_upper_bytes=residual_upper, delay_ms=round((time.monotonic_ns() - timestamp) / 1e6, 3))

    def reconcile(self):
        self.collect()
        # Seed membership from surviving groups after guard restart, including
        # reparented processes, then walk all Native worker-thread children.
        for group in self.groups:
            for raw in (group / 'cgroup.procs').read_text().split():
                pid = int(raw)
                stamp = identity(pid)
                if stamp:
                    self.move(pid, stamp, group)
        # Anything left in the registered app leaf outside the explicitly
        # protected bootstrap set is also accounted for after reparenting.
        for raw in (self.root / 'app/cgroup.procs').read_text().split():
            pid = int(raw)
            if pid not in self.protected and pid not in self.members:
                self.adopt(self.native, pid, time.monotonic_ns())
        pending = [self.native]
        seen = set()
        while pending:
            parent = pending.pop()
            if parent in seen:
                continue
            seen.add(parent)
            for pid in children(parent):
                self.adopt(parent, pid, time.monotonic_ns())
                pending.append(pid)

    @staticmethod
    def emit(event, **fields):
        print(json.dumps({'event': event, **fields}), flush=True)


def discover_native(unit, executable):
    raw = subprocess.check_output(['systemctl', 'show', unit, '-p', 'MainPID', '-p', 'ControlGroup'], text=True)
    props = dict(line.split('=', 1) for line in raw.splitlines())
    owner = int(props['MainPID'])
    if not owner or not props['ControlGroup']:
        return None
    leaf = Path('/sys/fs/cgroup' + props['ControlGroup']) / 'app/cgroup.procs'
    candidates = []
    try:
        for value in leaf.read_text().split():
            pid = int(value)
            try:
                stamp = identity(pid)
                if stamp and Path(f'/proc/{pid}/exe').resolve() == executable:
                    candidates.append((stamp[1], pid))
            except OSError:
                continue
    except FileNotFoundError:
        return None
    return min(candidates)[1] if candidates else None


def eligible_native(unit, config):
    raw = subprocess.check_output(['systemctl', 'show', unit, '-p', 'MainPID', '-p', 'ControlGroup', '-p', 'Delegate', '-p', 'DelegateSubgroup', '-p', 'OOMPolicy', '-p', 'MemoryMax', '-p', 'OOMScoreAdjust'], text=True)
    props = dict(line.split('=', 1) for line in raw.splitlines())
    if (props.get('Delegate'), props.get('DelegateSubgroup'), props.get('OOMPolicy')) != ('yes', 'app', 'continue') or props.get('OOMScoreAdjust') != '-1000' or not props.get('MemoryMax', '').isdigit() or int(props.get('MainPID', '0')) <= 0:
        return None
    relative = props.get('ControlGroup', '')
    if not relative.endswith('/' + unit):
        return None
    names = config.get('nativeExecutableNames', ['codex'])
    candidates = []
    for raw_pid in Path('/sys/fs/cgroup' + relative + '/app/cgroup.procs').read_text().split():
        pid = int(raw_pid)
        try:
            stamp = identity(pid)
            if stamp and Path(f'/proc/{pid}/exe').resolve().name in names:
                candidates.append((stamp[1], pid))
        except OSError:
            continue
    return min(candidates)[1] if candidates else None


def watch_generations(config_path, config):
    workers = {}
    stopping = False
    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    pattern = config.get('generationUnitPattern', 'opencraft-codex-*.service')
    if not re.fullmatch(r'[A-Za-z0-9_.@*?-]+\.service', pattern):
        raise ValueError('invalid generation unit pattern')
    script = str(Path(__file__).resolve())
    def consider(unit):
        if unit in workers or not fnmatch.fnmatchcase(unit, pattern):
            return
        try:
            pid = eligible_native(unit, config)
            if pid:
                workers[unit] = subprocess.Popen([sys.executable, script, '--unit', unit, '--native-pid', str(pid), '--config', str(config_path)])
                Guard.emit('worker-started', generation=unit, native_pid=pid)
        except (OSError, ValueError, subprocess.CalledProcessError):
            Guard.emit('owner-discovery-retry', generation=unit)
    try:
        sock = connector()
    except OSError:
        sock = None
        Guard.emit('discovery-poll-fallback', interval_ms=100)
    next_scan = 0
    Guard.emit('discovery-ready', mode='connector' if sock else 'poll')
    try:
        while not stopping:
            for unit, process in tuple(workers.items()):
                if process.poll() is not None:
                    Guard.emit('worker-exited', generation=unit, status=process.returncode)
                    del workers[unit]
            if time.monotonic() >= next_scan:
                try:
                    raw = subprocess.check_output(['systemctl', 'list-units', '--all', '--type=service', '--no-pager', '--output=json', pattern], text=True)
                    for entry in json.loads(raw):
                        if entry.get('active') in ('active', 'activating'):
                            consider(entry['unit'])
                except (OSError, ValueError, subprocess.CalledProcessError):
                    Guard.emit('systemd-discovery-retry')
                next_scan = time.monotonic() + (1 if sock else .1)
            delay = max(0, min(.1, next_scan - time.monotonic()))
            if sock and select.select([sock], [], [], delay)[0]:
                try:
                    for parent, pid, _ in fork_events(sock.recv(1024 * 1024)):
                        if parent is not None:  # Only native exec discovers a new generation.
                            continue
                        try:
                            if Path(f'/proc/{pid}/exe').resolve().name not in config.get('nativeExecutableNames', ['codex']):
                                continue
                            units = [part for part in process_cgroup(pid).split('/') if part.endswith('.service')]
                            if units:
                                consider(units[-1])
                        except (OSError, StopIteration):
                            continue
                except (OSError, ValueError):
                    Guard.emit('discovery-poll-fallback', interval_ms=100, reason='connector-loss')
                    sock.close()
                    sock = None
                    next_scan = 0
            elif not sock:
                time.sleep(delay)
    finally:
        if sock:
            sock.close()
        for process in workers.values():
            process.terminate()
        for process in workers.values():
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--unit')
    parser.add_argument('--watch-generations', action='store_true')
    parser.add_argument('--config', type=Path)
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--native-pid', type=int)
    source.add_argument('--native-executable', type=Path)
    parser.add_argument('--high-mib', type=int)
    parser.add_argument('--max-mib', type=int)
    parser.add_argument('--pids-max')
    args = parser.parse_args()
    config = json.loads(args.config.read_text()) if args.config else {}
    if args.config and (config.get('schemaVersion') != 1 or not isinstance(config.get('nativeExecutableNames'), list) or not config['nativeExecutableNames'] or not all(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', name) for name in config['nativeExecutableNames'])):
        parser.error('invalid configured policy schema/native executable names')
    high = args.high_mib if args.high_mib is not None else config.get('toolMemoryHighMiB')
    maximum = args.max_mib if args.max_mib is not None else config.get('toolMemoryMaxMiB')
    pids_max = args.pids_max if args.pids_max is not None else config.get('toolPidsMax', 'max')
    if isinstance(pids_max, str) and pids_max.isdecimal():
        pids_max = int(pids_max)
    if any(type(value) is not int or value <= 0 for value in [high, maximum]) or high > maximum or (pids_max != 'max' and (type(pids_max) is not int or pids_max <= 0)):
        parser.error('provide positive configured tool High/Max and pids.max')
    if args.watch_generations:
        if not args.config or args.unit or args.native_pid or args.native_executable:
            parser.error('watch mode requires only --config')
        return watch_generations(args.config.resolve(), config)
    if not args.unit or not (args.native_pid or args.native_executable):
        parser.error('worker requires --unit and native identity')
    native_pid = args.native_pid
    if args.native_executable:
        if not args.native_executable.is_absolute():
            parser.error('native executable must be absolute')
        while native_pid is None:
            native_pid = discover_native(args.unit, args.native_executable.resolve())
            if native_pid is None:
                time.sleep(.1)
    guard = Guard(args.unit, native_pid, high * 2**20, maximum * 2**20, pids_max)
    # APP remains protected by the unit's -1000. Native must stay killable
    # when no adopted tool is available, including a failed guard interval.
    with Path(f'/proc/{native_pid}/oom_score_adj').open('w') as score:
        if not same_process(native_pid, guard.native_id):
            raise RuntimeError('native changed before priority setup')
        score.write('-999')
    try:
        sock = connector()
    except OSError:
        sock = None
        guard.emit('poll-fallback', interval_ms=100)
    guard.reconcile()
    guard.emit('ready', mode='connector' if sock else 'poll')
    next_scan = time.monotonic() + (1 if sock else .1)
    while guard.alive():
        guard.memory.drain()
        delay = max(0, min(.1, next_scan - time.monotonic()))
        if sock and select.select([sock], [], [], delay)[0]:
            try:
                events = list(fork_events(sock.recv(1024 * 1024)))
            except (OSError, ValueError):
                # Only socket/decoder loss changes connector mode. A tool that
                # exits during adoption must never degrade all future tools.
                guard.emit('poll-fallback', interval_ms=100, reason='connector-loss')
                sock.close()
                sock = None
                guard.reconcile()
                next_scan = time.monotonic() + .1
            else:
                for parent, pid, timestamp in events:
                    if parent == -1:
                        guard.retire(pid)
                        continue
                    if parent is None:
                        stamp = identity(pid)
                        parent = stamp[0] if stamp else None
                    try:
                        guard.adopt(parent, pid, timestamp)
                    except OSError as error:
                        if error.errno not in (errno.ENOENT, errno.ENODEV, errno.ESRCH, errno.EEXIST):
                            raise
                        guard.emit('adoption-retry', pid=pid, errno=error.errno)
                        next_scan = 0
        elif not sock:
            time.sleep(delay)
        if time.monotonic() >= next_scan:
            guard.reconcile()
            next_scan = time.monotonic() + (1 if sock else .1)
    if sock:
        sock.close()
    guard.memory.close()
    # Restart=always re-enters discovery for the next owner/native incarnation.


if __name__ == '__main__':
    main()
