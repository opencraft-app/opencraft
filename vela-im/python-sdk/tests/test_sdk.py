import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vela_im import AgentWorker, VelaClient, WorkerError, GroupReplyMode  # noqa: E402

# Behaves like the real worker's process contract: runtime file, bearer secret, parent PID, SIGTERM cleanup.
FAKE_WORKER = r"""
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const dir=process.env.VELA_WORKER_DIR,secret='s3cret-'+process.pid;
if(process.env.FAKE_FAIL){console.error('identity credential rejected');process.exit(2)}
const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
 if(req.headers.authorization!=='Bearer '+secret){res.writeHead(401);return res.end('{}')}
 res.writeHead(200,{'content-type':'application/json'});
 res.end(JSON.stringify(req.url==='/health'?{ok:true,ready:true,pid:process.pid}:{path:req.url,method:req.method,body:body?JSON.parse(body):null,parent:process.env.VELA_WORKER_PARENT_PID,api:process.env.VELA_API_URL}));
})});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(path.join(dir,'worker.json'),JSON.stringify({pid:process.pid,port:server.address().port,secret,ready:true,userID:'a_self'}))});
process.on('SIGTERM',()=>{fs.rmSync(path.join(dir,'worker.json'),{force:true});process.exit(0)});
"""


class AgentWorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.script = Path(self.tmp.name) / "fake-worker.cjs"
        self.script.write_text(FAKE_WORKER)
        self.state = Path(self.tmp.name) / "state"

    def tearDown(self):
        os.environ.pop("FAKE_FAIL", None)
        self.tmp.cleanup()

    def worker(self):
        return AgentWorker("http://127.0.0.1:8787", "vela_token", self.state, script=self.script)

    def test_one_identity_one_worker_bound_to_the_starting_process(self):
        owner = self.worker()
        endpoint = owner.start(timeout=20)
        self.assertEqual(endpoint.user_id, "a_self")
        echo = VelaClient(endpoint).request("/call", {"method": "getLoginUser"})
        self.assertEqual(echo["parent"], str(os.getpid()))
        self.assertEqual(echo["api"], "http://127.0.0.1:8787")
        borrower = self.worker()
        self.assertEqual(borrower.start(timeout=20).pid, endpoint.pid)  # reused, no second Tencent login
        borrower.stop()
        self.assertIsNotNone(owner.running(), "a borrower must not stop the owner's worker")
        owner.stop()
        time.sleep(0.2)
        self.assertIsNone(owner.running())
        self.assertFalse((self.state / "worker.json").exists())

    def test_failed_worker_reports_its_log(self):
        os.environ["FAKE_FAIL"] = "1"
        with self.assertRaisesRegex(WorkerError, "credential rejected"):
            self.worker().start(timeout=10)

    def test_remote_identity_service_requires_https(self):
        with self.assertRaises(ValueError):
            AgentWorker("http://im.example.com", "token")
        with self.assertRaises(ValueError):
            AgentWorker("https://im.example.com", "")


class ClientMappingTest(unittest.TestCase):
    def client(self):
        client = object.__new__(VelaClient)
        client.requests = []
        client.request = lambda path, body=None, method=None, timeout=65: client.requests.append((path, body)) or {"path": path, "body": body}
        return client

    def test_high_level_operations_map_to_the_shared_sdk_names(self):
        c = self.client()
        c.add_friend("h_peer", "hi")
        c.accept_friend("h_peer")
        c.create_group("共同空间", ["h_peer", "a_peer"])
        c.add_group_members("GROUP@TGS#g", ["a_more"])
        c.remove_group_members("@TGS#g", ["h_peer"])
        c.set_group_reply_policy("GROUP@TGS#g", GroupReplyMode.MENTION_CONTEXT)
        c.dismiss_group("@TGS#g")
        self.assertEqual(c.requests, [
            ("/invoke", {"method": "addFriend", "args": ["h_peer", {"wording": "hi", "remark": ""}]}),
            ("/invoke", {"method": "acceptFriend", "args": ["h_peer", {}]}),
            ("/invoke", {"method": "createGroup", "args": [{"name": "共同空间", "memberIDs": ["h_peer", "a_peer"], "type": "Public"}]}),
            ("/invoke", {"method": "addGroupMembers", "args": ["@TGS#g", ["a_more"]]}),
            ("/invoke", {"method": "removeGroupMembers", "args": ["@TGS#g", ["h_peer"]]}),
            ("/invoke", {"method": "setGroupReplyPolicy", "args": ["@TGS#g", "mention_context"]}),
            ("/invoke", {"method": "dismissGroup", "args": ["@TGS#g"]}),
        ])

    def test_every_message_type_and_local_media_path(self):
        c = self.client()
        for kind in ("text", "textAt", "image", "audio", "video", "file", "location", "face", "custom", "merger", "forward"):
            c.send("a_peer", "C2C", kind, {"native": "untouched"})
        self.assertEqual({body["type"] for _, body in c.requests}, {"text", "textAt", "image", "audio", "video", "file", "location", "face", "custom", "merger", "forward"})
        with self.assertRaises(ValueError):
            c.send("a_peer", "C2C", "sticker-pack")
        with tempfile.NamedTemporaryFile(suffix=".png") as f:
            c.send_file("GROUP@TGS#g", f.name, "image", "GROUP")
            path, body = c.requests[-1]
            self.assertEqual((path, body["to"], body["attachment"]), ("/send", "@TGS#g", {"path": str(Path(f.name).resolve())}))


if __name__ == "__main__":
    unittest.main()
