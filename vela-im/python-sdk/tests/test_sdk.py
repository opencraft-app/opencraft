import io
import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vela_im import AgentWorker, VelaClient, WorkerError, GroupReplyMode, platform_group_id, uuid7, state_dir_for  # noqa: E402
from vela_im import cli  # noqa: E402

# Behaves like the real worker's process contract: Unix socket, worker.json, parent PID, SIGTERM cleanup.
FAKE_WORKER = r"""
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const dir=process.env.VELA_WORKER_DIR,sock=path.join(dir,'w.sock');
if(process.env.FAKE_FAIL){console.error('bot credential rejected');process.exit(2)}
const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
 res.writeHead(200,{'content-type':'application/json'});
 res.end(JSON.stringify(req.url==='/health'?{ok:true,ready:true,pid:process.pid}:{path:req.url,method:req.method,body:body?JSON.parse(body):null,
  parent:process.env.VELA_WORKER_PARENT_PID,api:process.env.VELA_API_URL,credential:process.env.VELA_BOT_CREDENTIAL_FILE}));
})});
try{fs.rmSync(sock)}catch{}
server.listen(sock,()=>{fs.writeFileSync(path.join(dir,'worker.json'),JSON.stringify({pid:process.pid,socket:sock,ready:true,userID:'a_self'}))});
process.on('SIGTERM',()=>{fs.rmSync(path.join(dir,'worker.json'),{force:true});process.exit(0)});
"""


class AgentWorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.script = Path(self.tmp.name) / "fake-worker.cjs"
        self.script.write_text(FAKE_WORKER)
        self.state = Path(self.tmp.name) / "state"
        self.credential = Path(self.tmp.name) / "credential"
        self.credential.write_text("vbc_secret")

    def tearDown(self):
        os.environ.pop("FAKE_FAIL", None)
        self.tmp.cleanup()

    def worker(self):
        return AgentWorker("http://127.0.0.1:18080/v1", self.credential, self.state, script=self.script)

    def test_one_bot_one_worker_bound_to_the_starting_process(self):
        owner = self.worker()
        endpoint = owner.start(timeout=20)
        self.assertEqual(endpoint.user_id, "a_self")
        echo = VelaClient(endpoint).request("/call", {"method": "getLoginUser"})
        self.assertEqual(echo["parent"], str(os.getpid()))
        self.assertEqual(echo["api"], "http://127.0.0.1:18080/v1")
        self.assertEqual(echo["credential"], str(self.credential), "the worker reads the credential file itself")
        borrower = self.worker()
        self.assertEqual(borrower.start(timeout=20).pid, endpoint.pid)  # reused, no second Tencent login
        borrower.stop()
        self.assertIsNotNone(owner.running(), "a borrower must not stop the owner's worker")
        owner.stop()
        time.sleep(0.2)
        self.assertIsNone(owner.running())

    def test_failed_worker_reports_its_log(self):
        os.environ["FAKE_FAIL"] = "1"
        with self.assertRaisesRegex(WorkerError, "credential rejected"):
            self.worker().start(timeout=10)

    def test_missing_credential_and_bad_url_are_rejected(self):
        self.credential.unlink()
        with self.assertRaisesRegex(WorkerError, "credential missing"):
            self.worker().start(timeout=5)
        with self.assertRaises(ValueError):
            AgentWorker("ftp://example.com", self.credential, self.state)


class ClientMappingTest(unittest.TestCase):
    def client(self):
        client = object.__new__(VelaClient)
        client.requests = []
        client.endpoint = type("E", (), {"user_id": "a_self"})()
        client.request = lambda path, body=None, method=None, timeout=65: client.requests.append((path, body)) or {"path": path, "body": body}
        return client

    def test_group_changes_go_to_the_platform_and_reads_go_to_tencent(self):
        c = self.client()
        group = str(uuid.UUID("0198f4c2-7a35-7f14-86ab-2e57552e473f"))
        tencent = "vg_" + group.replace("-", "")
        c.create_group("共同空间", ["u_peer", "a_peer"], GroupReplyMode.MENTION_CONTEXT)
        c.add_group_members("GROUP" + tencent, ["a_more"])
        c.remove_group_members(tencent, ["u_peer"])
        c.set_group_reply_mode(group, "all")
        c.quit_group(tencent)
        c.dismiss_group(tencent)
        c.get_group_members(tencent)
        created = c.requests[0][1]["args"][0]
        self.assertEqual((c.requests[0][0], created["name"], created["memberUserIds"], created["replyMode"]),
                         ("/platform", "共同空间", ["u_peer", "a_peer"], "mention_context"))
        self.assertEqual(uuid.UUID(created["groupId"]).version, 7)
        self.assertEqual(c.requests[1:], [
            ("/platform", {"method": "addGroupMember", "args": [group, "a_more"]}),
            ("/platform", {"method": "removeGroupMember", "args": [group, "u_peer"]}),
            ("/platform", {"method": "updateGroup", "args": [group, {"replyMode": "all"}]}),
            ("/platform", {"method": "removeGroupMember", "args": [group, "a_self"]}),
            ("/platform", {"method": "dismissGroup", "args": [group]}),
            ("/invoke", {"method": "getGroupMembers", "args": [tencent]}),
        ])
        with self.assertRaisesRegex(ValueError, "不是平台群"):
            c.add_group_members("@TGS#legacy", ["a_more"])

    def test_every_message_type_local_media_and_reply_lineage(self):
        c = self.client()
        for kind in ("text", "textAt", "image", "audio", "video", "file", "location", "face", "custom", "merger", "forward"):
            c.send("a_peer", "C2C", kind, {"native": "untouched"})
        self.assertEqual(len({body["type"] for _, body in c.requests}), 11)
        with self.assertRaises(ValueError):
            c.send("a_peer", "C2C", "sticker-pack")
        c.send("GROUPvg_0198f4c27a357f1486ab2e57552e473f", "GROUP", "text", {"text": "hi"}, reply_to_message_id="m1")
        self.assertEqual((c.requests[-1][1]["to"], c.requests[-1][1]["replyToMessageID"]), ("vg_0198f4c27a357f1486ab2e57552e473f", "m1"))

    def test_platform_group_ids_and_uuid7(self):
        group = "0198f4c2-7a35-7f14-86ab-2e57552e473f"
        self.assertEqual(platform_group_id("vg_0198f4c27a357f1486ab2e57552e473f"), group)
        self.assertEqual(platform_group_id("GROUPvg_0198f4c27a357f1486ab2e57552e473f"), group)
        self.assertEqual(platform_group_id(group), group)
        self.assertIsNone(platform_group_id("@TGS#abc"))
        self.assertEqual(uuid.UUID(uuid7()).version, 7)


class CLITest(unittest.TestCase):
    def run_cli(self, argv, env=None):
        calls = []

        class FakeClient:
            user_id = "a_self"

            def __getattr__(self, name):
                return lambda *args, **kwargs: calls.append((name, args, kwargs)) or {"ok": name}

        output = io.StringIO()
        with patch.dict(os.environ, env or {}, clear=False), patch.object(cli.VelaClient, "for_profile", return_value=FakeClient()), redirect_stdout(output):
            code = cli.main(argv)
        return code, calls

    def test_send_defaults_to_the_current_conversation_and_carries_the_hop_chain(self):
        code, calls = self.run_cli(["send", "--text", "收到"], {"HERMES_SESSION_CHAT_ID": "GROUPvg_x", "HERMES_SESSION_MESSAGE_ID": "m42"})
        self.assertEqual(code, 0)
        self.assertEqual(calls, [("send", ("vg_x", "GROUP", "text", {"text": "收到"}), {"reply_to_message_id": "m42"})])

    def test_explicit_recipient_starts_a_new_chain(self):
        code, calls = self.run_cli(["send", "--to", "u_owner", "--text", "完成了"], {"HERMES_SESSION_CHAT_ID": "GROUPvg_x", "HERMES_SESSION_MESSAGE_ID": "m42"})
        self.assertEqual(calls[0][1][:2], ("u_owner", "C2C"))
        self.assertIsNone(calls[0][2]["reply_to_message_id"])

    def test_group_commands_resolve_the_current_group(self):
        env = {"HERMES_SESSION_CHAT_ID": "GROUPvg_0198f4c27a357f1486ab2e57552e473f"}
        _, calls = self.run_cli(["group", "add", "a_peer"], env)
        self.assertEqual(calls, [("add_group_members", ("vg_0198f4c27a357f1486ab2e57552e473f", ["a_peer"]), {})])
        _, calls = self.run_cli(["group", "set", "--reply-mode", "all"], env)
        self.assertEqual(calls[0][0], "update_group")
        _, calls = self.run_cli(["group", "create", "--name", "评审", "--members", "u_a", "a_b"])
        self.assertEqual(calls, [("create_group", ("评审", ["u_a", "a_b"], None), {})])

    def test_profile_state_lives_under_hermes_home(self):
        self.assertEqual(state_dir_for("/tmp/hermes/profiles/a"), Path("/tmp/hermes/profiles/a/plugin-data/vela-im"))

    def test_no_worker_is_a_clear_error(self):
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"HERMES_HOME": home}), patch("sys.stderr", output):
            self.assertEqual(cli.main(["whoami"]), 1)
        self.assertIn("没有在线的 Vela IM worker", output.getvalue())


if __name__ == "__main__":
    unittest.main()
