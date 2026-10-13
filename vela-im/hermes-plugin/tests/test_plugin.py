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
class FakeEvent(dict):
    """Hermes' MessageEvent as a dict, advertising the per-turn fields current Hermes has."""
    __dataclass_fields__ = {"channel_prompt": None, "reply_to_message_id": None, "reply_to_text": None, "reply_to_author_name": None}


sys.modules["gateway.platforms.event"].MessageEvent = FakeEvent
sys.modules["gateway.platforms.event"].MessageType = types.SimpleNamespace(
    TEXT="text", PHOTO="photo", VOICE="voice", VIDEO="video", DOCUMENT="document", LOCATION="location", STICKER="sticker")
spec = importlib.util.spec_from_file_location("vela_test_plugin", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
from vela_test_plugin.adapter import should_reply, normalized, chain, quoted, VelaAdapter, is_system  # noqa: E402
from vela_test_plugin.runtime import outbound_lineage, worker_for, configured, install_cli  # noqa: E402
from vela_test_plugin.vela_im import WorkerEndpoint  # noqa: E402


class Recorder:
    """Records high-level SDK calls the adapter makes."""
    def __init__(self): self.calls = []
    def __getattr__(self, name):
        def call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return {"data": {"message": {"ID": "sent-%d" % len(self.calls)}}} if name == "send" else {"method": name, "args": args}
        return call


class PluginTest(unittest.TestCase):
    def test_humans_and_bots_have_identical_direct_chat_admission(self):
        for sender in ("u_person", "a_agent"):
            self.assertTrue(should_reply({"ID": "1", "from": sender, "type": "TIMTextElem", "conversationID": "C2C" + sender}, "a_self", "all"))
        self.assertFalse(should_reply({"from": "a_self"}, "a_self", "all"))

    def test_quoted_message_follows_tencent_reply_convention(self):
        reply = {"messageReply": {"messageID": "m1", "messageAbstract": "部署好了吗", "messageSender": "Alice", "version": 1}}
        self.assertEqual(quoted({"cloudCustomData": json.dumps(reply)}), {"sender": "Alice", "abstract": "部署好了吗", "messageID": "m1"})
        self.assertIsNone(quoted({"cloudCustomData": json.dumps({"vela": {"hops": 1}})}))
        self.assertIsNone(quoted({"cloudCustomData": "not json"}))

    def test_platform_policy_notice_and_group_tips_are_never_answered(self):
        notice = {"ID": "n", "from": "@TIM#SYSTEM", "type": "TIMCustomElem", "conversationID": "GROUPvg_x",
                  "payload": {"data": json.dumps({"businessID": "vela_group_policy", "replyMode": "all"})}}
        self.assertTrue(is_system(notice))
        self.assertFalse(should_reply(notice, "a_self", "all"))
        self.assertFalse(should_reply({**notice, "type": "TIMGroupTipElem"}, "a_self", "all"))
        created = {**notice, "from": "administrator",
                   "payload": {"data": json.dumps({"businessID": "group_create", "opUser": "u_owner", "cmd": 0, "version": 4})}}
        self.assertTrue(is_system(created))
        self.assertFalse(should_reply(created, "a_self", "all"))
        self.assertFalse(is_system({"type": "TIMCustomElem", "payload": {"data": "opaque"}}))

    def test_agent_loop_bound(self):
        message = {"ID": "1", "from": "a_other", "conversationID": "GROUPgroup", "payload": {"text": "hello"},
                   "cloudCustomData": json.dumps({"vela": {"hops": 6, "chainId": "root"}})}
        self.assertFalse(should_reply(message, "a_self", "all"))
        self.assertEqual(chain(message), {"hops": 6, "chainId": "root"})

    def test_arbitrary_custom_payload_is_preserved(self):
        text, kind, media = normalized({"type": "TIMCustomElem", "payload": {"data": "opaque", "extension": {"unknown": [1, 2, 3]}}})
        self.assertIn('"unknown": [1, 2, 3]', text)
        self.assertEqual((kind, media), ("TEXT", []))

    def test_each_profile_gets_one_worker_from_its_delivered_credential(self):
        with tempfile.TemporaryDirectory() as home, patch('vela_test_plugin.runtime.hermes_home', return_value=Path(home)), \
                patch('vela_test_plugin.runtime.setting', return_value=""):
            data = Path(home) / "plugin-data" / "vela-im"
            self.assertFalse(configured(), "no credential has been delivered yet")
            data.mkdir(parents=True)
            (data / "credential").write_text("vbc_secret")
            (data / "config.json").write_text(json.dumps({"apiBaseUrl": "http://127.0.0.1:18080/v1"}))
            self.assertTrue(configured())
            worker = worker_for()
            self.assertIs(worker_for(), worker)
            self.assertEqual((worker.state_dir, worker.credential_file, worker.api_url),
                             (data, data / "credential", "http://127.0.0.1:18080/v1"))

    def test_cli_launcher_carries_no_identity(self):
        with tempfile.TemporaryDirectory() as bin_dir, patch('vela_test_plugin.runtime.sys.executable', str(Path(bin_dir) / "python")):
            target = install_cli()
            script = target.read_text()
            self.assertIn("vela_im.cli", script)
            self.assertNotIn("vbc_", script)
            self.assertTrue(target.stat().st_mode & 0o111)


class AdapterTest(unittest.IsolatedAsyncioTestCase):
    def adapter(self, client):
        adapter = object.__new__(VelaAdapter); adapter.client = client; adapter._lineage = {}; adapter.user_id = 'a_self'
        adapter._turns, adapter._waiting, adapter._rechecked, adapter._rosters = {}, {}, set(), {}
        adapter._control = {"policy": "owner", "owners": set(), "at": 0.0}
        return adapter

    async def test_group_turns_list_members_and_how_to_mention_them(self):
        members = [{"userID": "u_owner", "nick": "用户9259"}, {"userID": "a_self", "nick": "伙伴1"}, {"userID": "a_peer", "nick": "健康管家"}]
        calls = []
        client = types.SimpleNamespace(get_group_members=lambda group: calls.append(group) or members)
        adapter = self.adapter(client); adapter._control["owners"] = {"u_owner"}; events = []
        adapter.build_source = lambda **kw: kw
        async def handle(event): events.append(event)
        adapter.handle_message = handle
        policy = {"members": [{"userId": "u_owner", "kind": "human"}, {"userId": "a_self", "kind": "bot"}, {"userId": "a_peer", "kind": "bot"}]}
        adapter._control["owners"] = {"u_owner", "a_sibling"}
        members.append({"userID": "a_sibling", "nick": "伙伴2"})
        for message_id in ("m1", "m2"):
            await adapter._dispatch_event({'ID': message_id, 'from': 'u_owner', 'nick': '用户9259', 'type': 'TIMTextElem',
                                           'conversationID': 'GROUPvg_g', '_vela_policy': policy, 'payload': {'text': '@伙伴1 hi'}})
        self.assertEqual(events[-1]["text"], "@伙伴1 hi")  # the transcript keeps only what was said
        prompt = events[-1]["channel_prompt"]
        self.assertIn("Group members: 用户9259 (u_owner, human, your owner); 伙伴1 (a_self, agent, you); 健康管家 (a_peer, agent); 伙伴2 (a_sibling, agent, belongs to your owner).", prompt)
        self.assertIn("vela_im send --at <userID>", prompt)
        self.assertEqual(calls, ["vg_g"])  # the roster is reused while membership is unchanged

    async def test_hermes_status_lines_never_reach_the_chat(self):
        adapter = self.adapter(Recorder())
        result = await adapter.send_or_update_status("GROUPvg_g", "status", "Session is free; loading the latest transcript...")
        self.assertTrue(result["success"])
        self.assertEqual(adapter.client.calls, [])

    async def test_adapter_starts_its_worker_on_connect_and_stops_it_on_disconnect(self):
        events = []
        with tempfile.TemporaryDirectory() as state:
            worker = types.SimpleNamespace(state_dir=Path(state), start=lambda: events.append('start') or WorkerEndpoint('/tmp/w.sock', 42, 'a_self'),
                                           stop=lambda: events.append('stop'))
            with patch('vela_test_plugin.adapter.worker_for', return_value=worker), \
                 patch('vela_test_plugin.adapter.VelaClient.capabilities', lambda self: {'identity': {'id': 'a_self', 'name': 'Alpha'}}):
                adapter = VelaAdapter(types.SimpleNamespace(extra={}))
                adapter._poll = lambda: asyncio.sleep(3600)
                self.assertTrue(await adapter.connect())
                self.assertEqual((adapter.user_id, adapter.client.endpoint.pid), ('a_self', 42))
                await adapter.disconnect()
        self.assertEqual(events, ['start', 'stop'])

    async def test_everyone_mentioning_an_agent_in_a_group_shares_one_session(self):
        adapter = self.adapter(None); sources = []
        adapter.build_source = lambda **kw: sources.append(kw) or kw
        async def handle(event): pass
        adapter.handle_message = handle
        for sender in ('u_alice', 'u_bob', 'a_peer'):
            await adapter._dispatch_event({'ID': sender, 'from': sender, 'nick': sender.upper(), 'type': 'TIMTextElem',
                                           'conversationID': 'GROUPvg_g', 'payload': {'text': '@a_self hi'}})
        self.assertEqual({s['thread_id'] for s in sources}, {'GROUPvg_g'})
        await adapter._dispatch_event({'ID': 'dm', 'from': 'u_alice', 'type': 'TIMTextElem', 'conversationID': 'C2Cu_alice', 'payload': {'text': 'hi'}})
        self.assertNotIn('thread_id', sources[-1])

    def commanded(self, policy, owners=("u_owner",), prepared=None):
        control = {"commandPolicy": policy, "owner": {"userIds": [*owners, "a_self"]}}
        client = types.SimpleNamespace(control=lambda: control,
                                       prepare_group_reply=lambda message_id, hops: prepared(message_id) if prepared else None)
        adapter = self.adapter(client); adapter.identity_name = 'Hermes Alpha'
        adapter._control = {"policy": "owner", "owners": set(), "at": 0.0}; adapter.state = {"pending": {}}; adapter._save = lambda: None
        adapter.max_hops, adapter._inflight = 6, set()
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

    async def test_owner_can_command_by_default_others_cannot(self):
        adapter = self.commanded('owner')
        group = {'conversationID': 'GROUPvg_g', 'type': 'TIMTextElem', 'atUserList': ['a_self']}
        await adapter._receive({**group, 'ID': '1', 'from': 'u_owner', 'payload': {'text': '@Hermes Alpha /new'}})
        self.assertEqual([(e['text'], e['source']['thread_id']) for e in adapter.handled], [('/new', 'GROUPvg_g')])
        await adapter._receive({**group, 'ID': '2', 'from': 'u_stranger', 'payload': {'text': '@Hermes Alpha /new'}})
        self.assertEqual(len(adapter.handled), 1)
        self.assertEqual(adapter.sent, [('GROUPvg_g', '只有我的主人可以对我使用 Hermes 命令（/new）。')])

    async def test_anyone_policy_lets_peers_command_the_agent(self):
        adapter = self.commanded('anyone')
        await adapter._receive({'ID': '1', 'from': 'a_peer', 'conversationID': 'C2Ca_peer', 'type': 'TIMTextElem', 'payload': {'text': '/model hy4'}})
        self.assertEqual(adapter.handled[0]['text'], '/model hy4'); self.assertEqual(adapter.sent, [])

    async def test_group_admission_follows_the_platform_rules(self):
        decisions = {'yes': True, 'no': False}
        def prepared(message_id):
            return {'shouldReply': decisions[message_id], 'message': {'ID': message_id, 'from': 'u_a', 'type': 'TIMTextElem',
                    'conversationID': 'GROUPvg_g', 'payload': {'text': 'hi'}}, 'policy': {'contextMessages': 0},
                    'context': [], 'contextStatus': 'not_requested'}
        adapter = self.commanded('owner', prepared=prepared)
        for message_id in ('yes', 'no'):
            await adapter._receive({'ID': message_id, 'from': 'u_a', 'type': 'TIMTextElem', 'conversationID': 'GROUPvg_g', 'payload': {'text': 'hi'}})
        self.assertEqual([e['message_id'] for e in adapter.handled], ['yes'])

    async def test_group_messages_wait_for_the_running_turn_instead_of_interrupting_it(self):
        def prepared(message_id):
            return {'shouldReply': True, 'message': {'ID': message_id, 'from': 'u_a', 'type': 'TIMTextElem',
                    'conversationID': 'GROUPvg_g', 'payload': {'text': 'hi'}}, 'policy': {'contextMessages': 0},
                    'context': [], 'contextStatus': 'not_requested'}
        adapter = self.commanded('owner', prepared=prepared)
        for message_id in ('first', 'second', 'third'):
            await adapter._receive({'ID': message_id, 'from': 'u_a', 'type': 'TIMTextElem', 'conversationID': 'GROUPvg_g', 'payload': {'text': 'hi'}})
        await adapter._receive({'ID': 'dm', 'from': 'u_a', 'type': 'TIMTextElem', 'conversationID': 'C2Cu_a', 'payload': {'text': 'hi'}})
        self.assertEqual([e['message_id'] for e in adapter.handled], ['first', 'dm'])
        done = lambda message_id, chat_id: types.SimpleNamespace(message_id=message_id, source=types.SimpleNamespace(chat_id=chat_id))
        await adapter.on_processing_complete(done('first', 'GROUPvg_g'), 'success')
        await asyncio.sleep(0)
        self.assertEqual([e['message_id'] for e in adapter.handled], ['first', 'dm', 'second'])

        await adapter._receive({'ID': 'stop', 'from': 'u_owner', 'type': 'TIMTextElem', 'conversationID': 'GROUPvg_g',
                                'atUserList': ['a_self'], 'payload': {'text': '@Hermes Alpha /stop'}})
        self.assertEqual(adapter.handled[-1]['text'], '/stop')
        self.assertNotIn('third', adapter.state['pending'])
        await adapter.on_processing_complete(done('second', 'GROUPvg_g'), 'success')
        await asyncio.sleep(0)
        self.assertNotIn('third', [e['message_id'] for e in adapter.handled])

    async def test_pending_group_messages_are_rechecked_against_current_rules_after_a_restart(self):
        decisions = {'kept': True, 'stale': False}
        adapter = self.commanded('owner', prepared=lambda message_id: {'shouldReply': decisions[message_id]})
        message = lambda message_id: {'ID': message_id, 'from': 'a_peer', 'type': 'TIMTextElem', 'conversationID': 'GROUPvg_g', 'payload': {'text': 'hi'}}
        adapter.state['pending'] = {m: {'message': message(m), 'attempts': 0} for m in ('stale', 'kept')}
        for message_id in ('stale', 'kept'):
            await adapter._replay(message_id, message(message_id))
        self.assertEqual(list(adapter.state['pending']), ['kept'])
        self.assertEqual([e['message_id'] for e in adapter.handled], ['kept'])

    async def test_agent_recognises_its_owner_in_ordinary_messages(self):
        adapter = self.commanded('owner')
        await adapter._receive({'ID': '1', 'from': 'u_owner', 'nick': '主人', 'conversationID': 'C2Cu_owner', 'type': 'TIMTextElem', 'payload': {'text': '帮我看看'}})
        await adapter._receive({'ID': '2', 'from': 'u_other', 'nick': '路人', 'conversationID': 'C2Cu_other', 'type': 'TIMTextElem', 'payload': {'text': '你好'}})
        self.assertIn('from your owner 主人 (u_owner)', adapter.handled[0]['channel_prompt'])
        self.assertNotIn('from your owner', adapter.handled[0]['text'])
        self.assertNotIn('owner', adapter.handled[1]['text'])

    async def test_automatic_reply_carries_the_next_hop(self):
        client = Recorder(); adapter = self.adapter(client)
        event = types.SimpleNamespace(message_id='m', raw_message={'ID': 'm', 'cloudCustomData': json.dumps({'vela': {'chainId': 'root', 'hops': 2}})}, source=types.SimpleNamespace(chat_id='C2Ca_peer'))
        await adapter.on_processing_start(event)
        await adapter.send('C2Ca_peer', 'answer')
        self.assertEqual(json.loads(client.calls[0][2]['cloudCustomData'])['vela'], {'chainId': 'root', 'hops': 3, 'senderKind': 'bot'})
        outbound_lineage.set(None)

    async def test_new_group_turn_uses_prepared_context_without_fetching_history_again(self):
        def no_history(*args): raise AssertionError('new turns must use the worker-prepared context')
        message = {'ID': 'current', 'conversationID': 'GROUPgroup', '_vela_context_status': 'complete', '_vela_context': [
            {'ID': 'prior', 'from': 'agent-peer', 'type': 'TIMCustomElem', 'payload': {'data': 'opaque', 'extension': {'nested': [1, 2]}}}
        ]}
        text = await self.adapter(types.SimpleNamespace(get_messages=no_history))._history_context(message)
        entries = json.loads(text.split('\n')[1]); self.assertEqual(entries[0]['id'], 'prior'); self.assertIn('nested', entries[0]['text'])
        message['_vela_context_status'] = 'anchor_missing'
        text = await self.adapter(None)._history_context(message); self.assertNotIn('opaque', text)

    async def test_attachments_typed_with_text_reach_the_model_with_that_text(self):
        from vela_test_plugin.adapter import safe_file_name
        adapter = self.commanded('owner'); adapter._bundles = {}
        image = {'ID': 'p1', 'from': 'u_owner', 'conversationID': 'C2Cu_owner', 'type': 'TIMImageElem',
                 'payload': {'imageInfoArray': [{'url': 'https://x.my-imcloud.com/a.png'}]}, 'cloudCustomData': json.dumps({'velaBundle': 'b1'})}
        report = {'ID': 'p2', 'from': 'u_owner', 'conversationID': 'C2Cu_owner', 'type': 'TIMFileElem',
                  'payload': {'fileUrl': 'https://x.my-imcloud.com/f', 'fileName': '周报.pdf'}, 'cloudCustomData': json.dumps({'velaBundle': 'b1'})}
        adapter.client.message = lambda message_id: report if message_id == 'p2' else None
        with patch('vela_test_plugin.adapter.download', side_effect=lambda url, mime, name: '/m/' + (name or 'image.jpg')):
            await adapter._receive(image)
            self.assertEqual(adapter.handled, [], 'an attachment waits for the text sent with it')
            await adapter._receive({'ID': 't1', 'from': 'u_owner', 'conversationID': 'C2Cu_owner', 'type': 'TIMTextElem', 'payload': {'text': '这是什么'},
                                    'cloudCustomData': json.dumps({'velaBundle': 'b1', 'velaBundleParts': ['p1', 'p2']})})
            self.assertEqual(len(adapter.handled), 1)
            self.assertIn('这是什么', adapter.handled[0]['text'])
            self.assertEqual(adapter.handled[0]['media_urls'], ['/m/image.jpg', '/m/周报.pdf'])
            self.assertEqual(adapter._bundles, {})

            orphan = {**image, 'ID': 'p3', 'cloudCustomData': json.dumps({'velaBundle': 'b2'})}
            await adapter._receive(orphan)
            adapter._bundles['b2']['at'] -= 31
            await adapter._flush_bundles()
            self.assertEqual([e['message_id'] for e in adapter.handled], ['t1', 'p3'], 'an attachment whose text never came is handled alone')
        self.assertEqual(safe_file_name('../../etc/passwd'), 'passwd')
        self.assertEqual(safe_file_name('a/b\\c.pdf'), 'b_c.pdf')

    async def test_a_quote_reaches_the_model_in_full_not_just_its_preview(self):
        adapter = self.commanded('owner'); adapter._bundles = {}
        original = {'ID': 'm1', 'from': 'a_self', 'type': 'TIMTextElem', 'payload': {'text': '第一段。' * 200}}
        adapter.client.message = lambda message_id: original if message_id == 'm1' else None
        reply = {'messageReply': {'messageID': 'm1', 'messageAbstract': '第一段。第一段…', 'messageSender': 'Alpha'}}
        await adapter._receive({'ID': 't', 'from': 'u_owner', 'conversationID': 'C2Cu_owner', 'type': 'TIMTextElem',
                                'payload': {'text': '这段什么意思'}, 'cloudCustomData': json.dumps(reply)})
        self.assertEqual(adapter.handled[0]['reply_to_text'], '第一段。' * 200)
        self.assertEqual(adapter.handled[0]['reply_to_message_id'], 'm1')
        self.assertEqual((adapter.handled[0]['text'], adapter.handled[0]['reply_to_author_name']), ('这段什么意思', 'Alpha'))
        adapter.client.message = lambda message_id: None
        await adapter._receive({'ID': 't2', 'from': 'u_owner', 'conversationID': 'C2Cu_owner', 'type': 'TIMTextElem',
                                'payload': {'text': '这段呢'}, 'cloudCustomData': json.dumps(reply)})
        self.assertEqual(adapter.handled[1]['reply_to_text'], '第一段。第一段…', 'without the original the preview is still passed on')

    async def test_agent_shows_it_is_working_until_processing_completes(self):
        client = Recorder(); adapter = self.adapter(client); adapter._heartbeats = {}
        adapter.state, adapter._inflight, adapter._save = {'pending': {}}, set(), lambda: None
        event = types.SimpleNamespace(message_id='m', raw_message={'ID': 'm'}, source=types.SimpleNamespace(chat_id='GROUPvg_g'))
        await adapter.on_processing_start(event)
        await asyncio.sleep(0.05)
        name, args, kwargs = next(c for c in client.calls if c[0] == 'send')
        self.assertEqual(args[:3], ('vg_g', 'GROUP', 'custom'))
        self.assertEqual(json.loads(args[3]['data']), {'businessID': 'vela_agent_status', 'state': 'working', 'messageID': 'm'})
        self.assertTrue(kwargs['options']['onlineUserOnly'], 'status is online-only: no history, no unread')
        await adapter.on_processing_complete(event, types.SimpleNamespace(value='success'))
        await asyncio.sleep(0.05)
        self.assertEqual(json.loads([c for c in client.calls if c[0] == 'send'][-1][1][3]['data'])['state'], 'idle')
        self.assertEqual(adapter._heartbeats, {})
        self.assertTrue(is_system({'type': 'TIMCustomElem', 'payload': {'data': json.dumps({'businessID': 'vela_agent_status', 'state': 'working'})}}))
        outbound_lineage.set(None)

    async def test_context_failure_does_not_leave_a_message_permanently_inflight(self):
        adapter = self.adapter(None); adapter._inflight = set(); adapter.state = {'pending': {'m': {'attempts': 0}}}; adapter._save = lambda: None
        async def fail(message): raise RuntimeError('history temporarily unavailable')
        adapter._dispatch_event = fail
        with self.assertRaises(RuntimeError): await adapter._dispatch({'ID': 'm'})
        self.assertNotIn('m', adapter._inflight); self.assertEqual(adapter.state['pending']['m']['attempts'], 1)


if __name__ == "__main__": unittest.main()
