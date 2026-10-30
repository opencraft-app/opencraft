import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import Mock, patch

PATH = Path(__file__).parents[2] / 'scripts/server-deployment/tool-memory-guard.py'
spec = importlib.util.spec_from_file_location('tool_memory_guard', PATH)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def event(what, values):
    payload = struct.pack('=IIIIHH', 1, 1, 0, 0, 40, 0)
    payload += struct.pack('=IIQ', what, 0, 123) + struct.pack('=' + 'I' * len(values), *values)
    return struct.pack('=IHHII', 16 + len(payload), 3, 0, 0, 0) + payload


class GuardTests(unittest.TestCase):
    def test_connector_filters_threads_and_preserves_process_fork_and_exec(self):
        data = event(1, [10, 10, 11, 11]) + event(1, [10, 10, 12, 10]) + event(2, [11, 11]) + event(0x80000000, [11, 11])
        self.assertEqual(list(guard.fork_events(data)), [(10, 11, 123), (None, 11, 123), (-1, 11, 123)])
        with self.assertRaises(ValueError):
            list(guard.fork_events(data[:-1]))

    def test_reparented_app_leaf_tool_is_not_lost_on_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'app').mkdir()
            (root / 'app/cgroup.procs').write_text('10\n11\n20\n')
            instance = object.__new__(guard.Guard)
            instance.memory = Mock()
            instance.root = root
            instance.groups = {}
            instance.members = {}
            instance.protected = {10, 11}
            instance.native = 11
            calls = []
            instance.collect = lambda: None
            instance.adopt = lambda parent, pid, stamp: calls.append((parent, pid))
            with patch.object(guard, 'children', return_value=set()):
                instance.reconcile()
            self.assertEqual(calls, [(11, 20)])

    def test_connector_accepts_ack_after_an_early_broadcast_event(self):
        sock = Mock()
        sock.recv.side_effect = [event(1, [10, 10, 11, 11]), event(0, [0])]
        with patch.object(guard.socket, 'socket', return_value=sock):
            self.assertIs(guard.connector(), sock)
        sock.setblocking.assert_called_once_with(False)
        sock.close.assert_not_called()

    def test_parent_change_does_not_change_process_identity(self):
        with patch.object(guard, 'identity', return_value=(1, 200)):
            self.assertTrue(guard.same_process(22, (99, 200)))

    def test_unrelated_global_event_does_not_read_proc(self):
        instance = object.__new__(guard.Guard)
        instance.memory = Mock()
        instance.protected = {10, 11}
        instance.members = {}
        with patch.object(guard, 'identity', side_effect=AssertionError('unrelated PID read')):
            instance.adopt(999, 1000, 123)

    def test_populated_dirty_group_is_checked_once_until_next_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            group = Path(directory)
            (group / 'cgroup.events').write_text('populated 1\nfrozen 0\n')
            instance = object.__new__(guard.Guard)
            instance.memory = Mock()
            instance.groups = {group: 1024}
            instance.dirty = {group}
            instance.members = {22: ((11, 200), group)}
            instance.release_finished()
            self.assertEqual(instance.dirty, set())
            with patch.object(Path, 'read_text', side_effect=AssertionError('repeat scan')):
                instance.release_finished()
            instance.retire(22)
            self.assertEqual(instance.dirty, {group})

    def test_restart_discards_empty_group_before_parsing_uninitialized_max(self):
        with tempfile.TemporaryDirectory() as directory:
            group = Path(directory)
            (group / 'cgroup.events').write_text('populated 0\nfrozen 0\n')
            (group / 'memory.max').write_text('max\n')
            with patch.object(Path, 'rmdir') as remove:
                self.assertIsNone(guard.recover_group_limit(group))
                remove.assert_called_once_with()
            (group / 'cgroup.events').write_text('populated 1\nfrozen 0\n')
            (group / 'memory.max').write_text('1024\n')
            self.assertEqual(guard.recover_group_limit(group), 1024)

    def test_memory_events_record_metadata_peak_and_all_counter_increments(self):
        with tempfile.TemporaryDirectory() as directory:
            group = Path(directory) / 'tool-22-100'
            group.mkdir()
            (group / 'memory.events').write_text('high 0\noom_kill 0\noom_group_kill 0\n')
            (group / 'memory.peak').write_text('8192')
            emitted = []
            observer = guard.MemoryObserver('generation.service', lambda event, **fields: emitted.append((event, fields)))
            try:
                with patch.object(guard, 'command_name', return_value='git'):
                    observer.track(group, 22)
                (group / 'memory.events').write_text('high 3\noom_kill 2\noom_group_kill 1\n')
                observer.observe(group)
                observer.observe(group)
                self.assertEqual([event for event, _ in emitted], ['tool-memory-high', 'tool-memory-oom'])
                self.assertEqual([fields['occurrences'] for _, fields in emitted], [3, 1])
                for _, fields in emitted:
                    self.assertEqual(fields['generation'], 'generation.service')
                    self.assertEqual(fields['command_name'], 'git')
                    self.assertEqual(fields['memory_peak_bytes'], 8192)
                    self.assertIn('timestamp', fields)
                    self.assertNotIn('argv', fields)
                    self.assertNotIn('content', fields)
            finally:
                observer.close()

    def test_process_exiting_before_move_is_not_reported_as_adopted(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = object.__new__(guard.Guard)
            instance.memory = Mock()
            instance.root = Path(directory)
            instance.protected, instance.members = {11}, {}
            instance.groups, instance.dirty = {}, set()
            instance.high, instance.maximum, instance.pids_max = 1024, 2048, 'max'
            instance.alive = lambda: True
            instance.contains = lambda pid: True
            instance.move = lambda *args: False
            instance.release_finished = Mock()
            instance.emit = Mock()
            with patch.object(guard, 'identity', return_value=(11, 100)), patch.object(guard, 'children', side_effect=AssertionError('dead process descendants')):
                instance.adopt(11, 22, 123)
            instance.emit.assert_not_called()
            self.assertIn(instance.root / 'tool-22-100', instance.dirty)

    def test_reused_pid_cannot_be_moved(self):
        instance = object.__new__(guard.Guard)
        instance.memory = Mock()
        instance.protected = set()
        instance.contains = lambda pid: True
        with tempfile.TemporaryDirectory() as directory:
            group = Path(directory)
            (group / 'cgroup.procs').write_text('')
            with patch.object(guard, 'identity', return_value=(1, 200)):
                self.assertFalse(instance.move(22, (1, 100), group))
            self.assertEqual((group / 'cgroup.procs').read_text(), '')


if __name__ == '__main__':
    unittest.main()
