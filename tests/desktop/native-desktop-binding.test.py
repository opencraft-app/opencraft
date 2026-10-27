"""The desktop binding belongs to the operator, never a viewer or inherited env."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / 'apps/local-agent-host/native/linux'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


observer = load('native_observer', ROOT / 'desktop-observer.py')
installer = load('native_installer', ROOT / 'install-desktop.py')


class BindingTest(unittest.TestCase):
    def setUp(self):
        self.binding = dict(display=':7', sourceUnit='existing.service', executable='/usr/bin/Xvnc',
                            args=[':7', '-localhost'], uid=1002, xauthority='/private/.Xauthority')
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.file = Path(self.directory.name) / 'desktop.json'
        self.file.write_text(json.dumps(self.binding))
        self.file.chmod(0o600)

    def read(self, file_uid=0, parent_mode=0o755, symlink=False):
        native_stat = os.fstat
        def metadata(fd):
            info = native_stat(fd)
            return SimpleNamespace(st_uid=file_uid, st_mode=info.st_mode, st_size=info.st_size)
        def lstat(path):
            return SimpleNamespace(st_uid=0, st_mode=(stat.S_IFLNK if symlink else stat.S_IFDIR) | parent_mode)
        with patch.object(observer, 'CONFIGURATION', self.file), patch.object(Path, 'lstat', lstat), patch.object(observer.os, 'fstat', metadata):
            return observer.configuration()

    def test_explicit_binding_selects_existing_display_not_inherited_environment(self):
        with patch.dict(os.environ, {'DISPLAY': ':999', 'XAUTHORITY': '/wrong'}):
            self.assertEqual(self.read(), self.binding)
        args = observer.observer_arguments(self.binding)
        self.assertEqual(args[args.index('-display') + 1], ':7')
        self.assertEqual(args[args.index('-rfbport') + 1], '5903')
        for flag in ['-viewonly', '-nosel', '-noremote', '-nocmds', '-localhost']:
            self.assertIn(flag, args)

    def test_untrusted_configuration_is_rejected(self):
        for kwargs in [dict(file_uid=1002), dict(parent_mode=0o777), dict(symlink=True)]:
            with self.subTest(kwargs=kwargs), self.assertRaises(observer.Unavailable):
                self.read(**kwargs)
        self.file.chmod(0o644)
        with self.assertRaises(observer.Unavailable):
            self.read()

    def test_viewers_cannot_add_targets_or_commands_to_the_binding(self):
        for update in [dict(uid=0), dict(uid=True), dict(display=':1;command'),
                       dict(sourceUnit='/evil.service'), dict(executable='/bin/sh'),
                       dict(xauthority='relative'), dict(args=['\0']), dict(target='remote')]:
            with self.subTest(update=update):
                self.file.write_text(json.dumps({**self.binding, **update}))
                with self.assertRaises(observer.Unavailable):
                    self.read()

    def test_observation_epoch_change_revokes_the_verified_identity(self):
        runtime = observer.Runtime.__new__(observer.Runtime)
        runtime.binding = self.binding
        runtime.observer, runtime.observer_invocation = 50, 'old'
        runtime.xvfb_invocation, runtime.uid = 'source', 1002
        with patch.object(observer, 'configuration', return_value=self.binding), patch.object(observer, 'unit_process', side_effect=[(50, 'replacement'), (20, 'source')]):
            with self.assertRaises(observer.Unavailable):
                runtime.identity()

    def test_binding_replacement_revokes_existing_media_and_control(self):
        runtime = observer.Runtime.__new__(observer.Runtime)
        runtime.binding = self.binding
        with patch.object(observer, 'configuration', return_value={**self.binding, 'display': ':8'}):
            with self.assertRaises(observer.Unavailable):
                runtime.identity()

    def test_systemd_arguments_cannot_expand_or_split_private_paths(self):
        self.assertEqual(installer.quote('/private/a b/%x/$HOME'), '"/private/a b/%%x/$$HOME"')
        for value in ['a\nb', 'a\0b']:
            with self.assertRaises(ValueError):
                installer.quote(value)

    def test_source_unit_and_display_are_not_arbitrary_commands(self):
        for unit, display in [('/bad.service', ':1'), ('bad', ':1'), ('safe.service', ':1;command')]:
            with self.assertRaises(ValueError):
                installer.binding(unit, display, '/not-read')



if __name__ == '__main__':
    unittest.main()
