import importlib.util
import json
import sys
import types
import unittest
import tempfile
import asyncio
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for name in ("gateway", "gateway.config", "gateway.platforms", "gateway.platforms.base", "gateway.platforms.event"):
    sys.modules.setdefault(name, types.ModuleType(name))


class FakeBase:
    def __init__(self, config, platform):
        self.config = config
    @property
    def name(self): return 'vela_im'  # read-only in Hermes' BasePlatformAdapter
    def _mark_connected(self): self.connected = True
    def _mark_disconnected(self): self.connected = False


sys.modules["gateway.config"].Platform = str
sys.modules["gateway.platforms.base"].BasePlatformAdapter = FakeBase
sys.modules["gateway.platforms.base"].SendResult = dict
sys.modules["gateway.platforms.event"].MessageEvent = dict
sys.modules["gateway.platforms.event"].MessageType = types.SimpleNamespace(TEXT="text")
spec = importlib.util.spec_from_file_location("vela_test_plugin", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
from vela_test_plugin.adapter import should_reply, normalized, chain, VelaAdapter  # noqa: E402
from vela_test_plugin.runtime import current_delivery, outbound_lineage, worker_for  # noqa: E402
from vela_test_plugin.vela_im import VelaClient, WorkerEndpoint  # noqa: E402
from vela_test_plugin.tools import execute, attachment  # noqa: E402


class Recorder:
    """Records high-level SDK calls the tools make."""
    def __init__(self): self.calls = []
    def __getattr__(self, name):
        def call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return {"data": {"message": {"ID": "sent-%d" % len(self.calls)}}} if name == "send" else {"method": name, "args": args}
        return call


class PluginTest(unittest.TestCase):
    def test_public_demo_attachment_directory_does_not_expose_host_files(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            media = Path(root) / 'test.txt'; media.write_text('demo media')
            secret = Path(outside) / 'private.txt'; secret.write_text('outside')
            with patch('vela_test_plugin.tools.setting', return_value=root):
                self.assertEqual(attachment(media), {"path": str(media.resolve())})
                with self.assertRaisesRegex(ValueError, 'outside'): attachment(secret)
                link = Path(root) / 'escape'; link.symlink_to(secret)
                with self.assertRaisesRegex(ValueError, 'outside'): attachment(link)

    def test_agents_have_identical_reply_admission(self):
        for sender in ("h_person", "a_agent"):
            self.assertTrue(should_reply({"ID": "1", "from": sender, "type": "TIMTextElem", "conversationID": "C2C" + sender}, "a_self"))
        self.assertFalse(should_reply({"from": "a_self"}, "a_self"))

    def test_group_mentions_and_agent_loop_bound(self):
        message = {"ID": "1", "from": "a_other", "conversationID": "GROUPgroup", "payload": {"text": "hello"}}
        self.assertFalse(should_reply(message, "a_self"))
        self.assertTrue(should_reply(message, "a_self", "all"))
        message['atUserList'] = ['__kImSDK_MesssageAtALL__']
        self.assertTrue(should_reply(message, "a_self", "mention_context"))
        message["atUserList"] = ["a_self"]
        self.assertTrue(should_reply(message, "a_self"))
        message["cloudCustomData"] = json.dumps({"vela": {"hops": 6, "chainId": "root"}})
        self.assertFalse(should_reply(message, "a_self", "all"))
        self.assertEqual(chain(message), {"hops": 6, "chainId": "root"})

    def test_arbitrary_custom_payload_is_preserved(self):
        text, kind, media = normalized({"type": "TIMCustomElem", "payload": {"data": "opaque", "extension": {"unknown": [1, 2, 3]}}})
        self.assertIn('"unknown": [1, 2, 3]', text)
        self.assertEqual((kind, media), ("TEXT", []))

    def test_friend_group_and_member_tools_use_sdk_operations(self):
        c = Recorder()
        execute("vela_friends", {"action": "add", "user_id": "h_friend", "wording": "hi"}, c)
        execute("vela_friends", {"action": "accept", "user_id": "h_friend"}, c)
        execute("vela_groups", {"action": "create", "name": "平等群", "member_ids": ["h_a", "a_b"]}, c)
        execute("vela_group_members", {"action": "add", "group_id": "@TGS#g", "user_ids": ["a_c"]}, c)
        execute("vela_group_members", {"action": "remove", "group_id": "@TGS#g", "user_ids": ["a_peer"]}, c)
        execute("vela_group_members", {"action": "role", "group_id": "@TGS#g", "user_ids": ["h_a"], "role": "Admin"}, c)
        execute("vela_groups", {"action": "set_reply_policy", "group_id": "@TGS#g", "mode": "all"}, c)
        execute("vela_groups", {"action": "dismiss", "group_id": "@TGS#g"}, c)
        self.assertEqual([(name, args) for name, args, _ in c.calls], [
            ("add_friend", ("h_friend", "hi", "")), ("accept_friend", ("h_friend", None)),
            ("create_group", ("平等群", ["h_a", "a_b"], "Public")), ("add_group_members", ("@TGS#g", ["a_c"])),
            ("remove_group_members", ("@TGS#g", ["a_peer"], None)), ("set_group_member_role", ("@TGS#g", "h_a", "Admin")),
            ("set_group_reply_policy", ("@TGS#g", "all")), ("dismiss_group", ("@TGS#g",)),
        ])

    def test_complete_message_types_are_passed_to_native_sdk(self):
        for message_type in ("text", "textAt", "image", "audio", "video", "file", "location", "face", "custom", "merger", "forward"):
            c = Recorder()
            execute("vela_send_message", {"to": "a_peer", "type": message_type, "payload": {"native": "untouched"}}, c)
            self.assertEqual(c.calls[0][1], ("a_peer", "C2C", message_type, {"native": "untouched"}))

    def test_group_conversation_prefix_is_removed_before_tool_send(self):
        c = Recorder()
        execute('vela_send_message', {'to': 'GROUP@TGS#abc', 'conversation_type': 'GROUP', 'payload': {'text': 'hello'}}, c)
        self.assertEqual(c.calls[0][1][0], '@TGS#abc')
        client = object.__new__(VelaClient); client.request = lambda path, body: body
        self.assertEqual(client.send('GROUP@TGS#abc', 'GROUP')['to'], '@TGS#abc')
        self.assertEqual(client.send('GROUPcustom', 'GROUP')['to'], 'GROUPcustom')

    def test_each_profile_identity_gets_one_worker_under_its_own_hermes_home(self):
        with tempfile.TemporaryDirectory() as home, patch('vela_test_plugin.runtime.hermes_home', return_value=Path(home)):
            alpha = worker_for("http://127.0.0.1:8787", "alpha-token")
            self.assertIs(worker_for("http://127.0.0.1:8787", "alpha-token"), alpha)
            beta = worker_for("http://127.0.0.1:8787", "beta-token")
            self.assertIsNot(alpha, beta)
            self.assertEqual(alpha.state_dir.parent, Path(home) / "plugin-data" / "vela-im")
            self.assertNotEqual(alpha.state_dir, beta.state_dir)


class AdapterTest(unittest.IsolatedAsyncioTestCase):
    def adapter(self, client):
        adapter = object.__new__(VelaAdapter); adapter.client = client; adapter._lineage = {}; adapter.user_id = 'a_self'
        return adapter

    async def test_adapter_starts_its_worker_on_connect_and_stops_it_on_disconnect(self):
        events = []
        with tempfile.TemporaryDirectory() as state:
            worker = types.SimpleNamespace(state_dir=Path(state), start=lambda: events.append('start') or WorkerEndpoint('http://127.0.0.1:1', 's', 42, 'a_self'),
                                           stop=lambda: events.append('stop'))
            with patch('vela_test_plugin.adapter.worker_for', return_value=worker), \
                 patch('vela_test_plugin.adapter.VelaClient.capabilities', lambda self: {'identity': {'id': 'a_self', 'name': 'Alpha'}}):
                adapter = VelaAdapter(types.SimpleNamespace(extra={"url": "http://127.0.0.1:8787", "token": "t"}))
                adapter._poll = lambda: asyncio.sleep(3600)
                self.assertTrue(await adapter.connect())
                self.assertEqual((adapter.user_id, adapter.client.endpoint.pid), ('a_self', 42))
                await adapter.disconnect()
        self.assertEqual(events, ['start', 'stop'])

    async def test_successful_tool_delivery_suppresses_duplicate_status_only_in_current_chat(self):
        async def turn(target):
            client = Recorder(); adapter = self.adapter(client)
            event = types.SimpleNamespace(message_id='incoming', raw_message={'ID': 'incoming'}, source=types.SimpleNamespace(chat_id='GROUP@TGS#current'))
            await adapter.on_processing_start(event)
            # Hermes tool execution inherits a shared per-turn context into its worker thread.
            await asyncio.to_thread(execute, 'vela_send_message', {'to': target, 'conversation_type': 'GROUP', 'payload': {'text': 'hello'}}, client)
            result = await adapter.send(event.source.chat_id, '已发送，sequence…')
            self.assertTrue(result['success']); return [args[0] for name, args, _ in client.calls if name == 'send']
        same, other = await asyncio.gather(turn('GROUP@TGS#current'), turn('@TGS#other'))
        self.assertEqual(same, ['@TGS#current']); self.assertEqual(other, ['@TGS#other', '@TGS#current'])
        current_delivery.set(None); outbound_lineage.set(None)

    async def test_everyone_mentioning_an_agent_in_a_group_shares_one_session(self):
        adapter = self.adapter(None); sources = []
        adapter.build_source = lambda **kw: sources.append(kw) or kw
        async def handle(event): pass
        adapter.handle_message = handle
        for sender in ('h_alice', 'h_bob', 'a_peer'):
            await adapter._dispatch_event({'ID': sender, 'from': sender, 'nick': sender.upper(), 'type': 'TIMTextElem',
                                           'conversationID': 'GROUP@TGS#g', 'payload': {'text': '@a_self hi'}})
        self.assertEqual({s['thread_id'] for s in sources}, {'GROUP@TGS#g'})
        await adapter._dispatch_event({'ID': 'dm', 'from': 'h_alice', 'type': 'TIMTextElem', 'conversationID': 'C2Ch_alice', 'payload': {'text': 'hi'}})
        self.assertNotIn('thread_id', sources[-1])

    def commanded(self, policy, owners=("h_owner",)):
        control = {"commandPolicy": policy, "owner": {"identities": [{"id": i} for i in (*owners, "a_self")]}}
        adapter = self.adapter(types.SimpleNamespace(get_control=lambda: control)); adapter.identity_name = 'Hermes Alpha'
        adapter._control = {"policy": "owner", "owners": set(), "at": 0.0}; adapter.state = {"pending": {}}; adapter._save = lambda: None
        adapter.group_mode, adapter.max_hops, adapter._inflight = 'mention', 6, set()
        adapter.handled, adapter.sent = [], []
        async def handle(event): adapter.handled.append(event)
        async def send(chat_id, content, **kw): adapter.sent.append((chat_id, content))
        adapter.handle_message, adapter.send = handle, send
        adapter.build_source = lambda **kw: kw
        return adapter

    def test_commands_are_found_behind_mentions(self):
        from vela_test_plugin.adapter import command_text
        names = {'a_self', 'Hermes Alpha'}
        for text in ('/new', '  /new', '@Hermes Alpha /new', '@a_self /model gpt', '@all /new', '@Hermes Alpha @all /status'):
            self.assertTrue(command_text({'type': 'TIMTextElem', 'payload': {'text': text}}, names).startswith('/'), text)
        for text in ('hello /new', '@Hermes Alpha hi', 'path is /tmp'):
            self.assertIsNone(command_text({'type': 'TIMTextElem', 'payload': {'text': text}}, names), text)
        self.assertIsNone(command_text({'type': 'TIMCustomElem', 'payload': {'data': '/new'}}, names))

    async def test_owner_can_command_by_default_others_cannot(self):
        adapter = self.commanded('owner')
        group = {'conversationID': 'GROUP@TGS#g', 'type': 'TIMTextElem', 'atUserList': ['a_self']}
        await adapter._receive({**group, 'ID': '1', 'from': 'h_owner', 'payload': {'text': '@Hermes Alpha /new'}})
        self.assertEqual([(e['text'], e['source']['thread_id']) for e in adapter.handled], [('/new', 'GROUP@TGS#g')])
        await adapter._receive({**group, 'ID': '2', 'from': 'h_stranger', 'payload': {'text': '@Hermes Alpha /new'}})
        self.assertEqual(len(adapter.handled), 1)
        self.assertEqual(adapter.sent, [('GROUP@TGS#g', '只有我的主人可以对我使用 Hermes 命令（/new）。')])
        self.assertEqual(adapter.state['pending'], {}, 'commands are never replayed from the pending queue')

    async def test_anyone_policy_lets_peers_command_the_agent(self):
        adapter = self.commanded('anyone')
        await adapter._receive({'ID': '1', 'from': 'a_peer', 'conversationID': 'C2Ca_peer', 'type': 'TIMTextElem', 'payload': {'text': '/model hy4'}})
        self.assertEqual(adapter.handled[0]['text'], '/model hy4'); self.assertEqual(adapter.sent, [])

    async def test_agent_recognises_its_owner_in_ordinary_messages(self):
        adapter = self.commanded('owner')
        await adapter._receive({'ID': '1', 'from': 'h_owner', 'nick': '主人', 'conversationID': 'C2Ch_owner', 'type': 'TIMTextElem', 'payload': {'text': '帮我看看'}})
        await adapter._receive({'ID': '2', 'from': 'h_other', 'nick': '路人', 'conversationID': 'C2Ch_other', 'type': 'TIMTextElem', 'payload': {'text': '你好'}})
        self.assertIn('from your owner 主人 (h_owner)', adapter.handled[0]['text'])
        self.assertNotIn('owner', adapter.handled[1]['text'])

    async def test_automatic_reply_carries_the_next_hop(self):
        client = Recorder(); adapter = self.adapter(client)
        event = types.SimpleNamespace(message_id='m', raw_message={'ID': 'm', 'cloudCustomData': json.dumps({'vela': {'chainId': 'root', 'hops': 2}})}, source=types.SimpleNamespace(chat_id='C2Ca_peer'))
        await adapter.on_processing_start(event)
        await adapter.send('C2Ca_peer', 'answer')
        self.assertEqual(json.loads(client.calls[0][2]['cloudCustomData'])['vela'], {'chainId': 'root', 'hops': 3, 'senderKind': 'agent'})
        current_delivery.set(None); outbound_lineage.set(None)

    async def test_context_contains_only_ten_preceding_messages_and_never_later_messages(self):
        history = [{'ID': str(i), 'type': 'TIMTextElem', 'from': 'human', 'payload': {'text': 'message-' + str(i)}} for i in range(22)]
        client = types.SimpleNamespace(get_messages=lambda *args: {'messageList': history, 'isCompleted': True})
        text = await self.adapter(client)._history_context({'ID': '15', 'conversationID': 'GROUPgroup'})
        entries = json.loads(text.split('\n')[1]); self.assertEqual([x['id'] for x in entries], [str(i) for i in range(5, 15)])
        self.assertNotIn('message-16', text)
        missing = await self.adapter(client)._history_context({'ID': 'missing', 'conversationID': 'GROUPgroup'}); self.assertNotIn('message-', missing)

    async def test_context_failure_does_not_leave_a_message_permanently_inflight(self):
        adapter = self.adapter(None); adapter._inflight = set(); adapter.state = {'pending': {'m': {'attempts': 0}}}; adapter._save = lambda: None
        async def fail(message): raise RuntimeError('history temporarily unavailable')
        adapter._dispatch_event = fail
        with self.assertRaises(RuntimeError): await adapter._dispatch({'ID': 'm'})
        self.assertNotIn('m', adapter._inflight); self.assertEqual(adapter.state['pending']['m']['attempts'], 1)

    async def test_new_group_turn_uses_sdk_prepared_context_without_fetching_history_again(self):
        def no_history(*args): raise AssertionError('new turns must use the SDK-prepared context')
        message = {'ID': 'current', 'conversationID': 'GROUPgroup', '_vela_context_status': 'complete', '_vela_context': [
            {'ID': 'prior', 'from': 'agent-peer', 'type': 'TIMCustomElem', 'payload': {'data': 'opaque', 'extension': {'nested': [1, 2]}}}
        ]}
        text = await self.adapter(types.SimpleNamespace(get_messages=no_history))._history_context(message)
        entries = json.loads(text.split('\n')[1]); self.assertEqual(entries[0]['id'], 'prior'); self.assertIn('nested', entries[0]['text'])
        message['_vela_context_status'] = 'anchor_missing'
        text = await self.adapter(None)._history_context(message); self.assertNotIn('opaque', text)


if __name__ == "__main__": unittest.main()
