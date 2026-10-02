#!/usr/bin/env python3
"""CAS-publish the regional code-plane tree to management desired Git."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
from pathlib import Path


TARGET = Path("management/code-plane")
EXPECTED = {"evidence.json", "kustomization.yaml", "fdb-cluster.yaml", "fdb-backup.yaml", "worker-registry.yaml", "worker-registry-private.yaml"}
REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")


def run(*args, cwd=None, env=None): return subprocess.run(args,cwd=cwd,env=env,check=True,capture_output=True,text=True).stdout.strip()
def digest(value): return "sha256:" + hashlib.sha256(value).hexdigest()


def inventory(root):
    result={}
    for path in sorted(root.rglob("*")):
        if path.is_symlink(): raise ValueError("desired tree contains a symlink")
        if path.is_file(): result[path.relative_to(root).as_posix()]=digest(path.read_bytes())
        elif not path.is_dir(): raise ValueError("desired tree contains a special file")
    return result


def safe_url(value, local=False):
    parsed=urllib.parse.urlsplit(value)
    if parsed.password or parsed.query or parsed.fragment or not parsed.path: raise ValueError("unsafe Git URL")
    if parsed.scheme=="http" and parsed.hostname and not parsed.username and (parsed.hostname.endswith(".svc.cluster.local") or (local and parsed.hostname in {"127.0.0.1","localhost"})): return value
    if parsed.scheme in {"https","ssh"} and parsed.hostname and not parsed.username: return value
    if local and parsed.scheme=="file" and parsed.path.startswith("/"): return value
    raise ValueError("Git URL must be credential-free")


def publish(root,render_path,write_url,read_url,expected,receipt,allow_local=False):
    write_url,read_url=safe_url(write_url,allow_local),safe_url(read_url,allow_local)
    if not REVISION.fullmatch(expected): raise ValueError("invalid expected revision")
    render=json.loads(render_path.read_text()); files=inventory(root)
    if (render.get("schema"),render.get("verdict")) != ("actor-regional-code-plane-desired-render/v1","passed") or files!=render.get("files") or set(files)!=EXPECTED: raise ValueError("desired tree differs from rendering")
    if not receipt.is_absolute() or receipt.exists() or not receipt.parent.is_dir(): raise ValueError("receipt must be a new absolute path")
    with tempfile.TemporaryDirectory(prefix="actor-code-plane-publish.",dir="/data/tmp") as tmp:
        repo=Path(tmp)/"repo"; run("git","clone","--quiet","--single-branch","--branch","main",write_url,str(repo)); observed=run("git","rev-parse","HEAD",cwd=repo); target=repo/TARGET
        if observed!=expected:
            ancestor=subprocess.run(("git","merge-base","--is-ancestor",expected,observed),cwd=repo).returncode==0
            if not ancestor or not target.is_dir() or inventory(target)!=files: raise ValueError("Git CAS base differs")
            revision=observed; resumed=True
        else:
            resumed=False
            if target.exists() and inventory(target)!=files: shutil.rmtree(target)
            if not target.exists():
                target.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(root,target); run("git","add","--",TARGET.as_posix(),cwd=repo)
                env=dict(os.environ,GIT_AUTHOR_NAME="actor-management-publisher",GIT_AUTHOR_EMAIL="management-publisher@actor.invalid",GIT_COMMITTER_NAME="actor-management-publisher",GIT_COMMITTER_EMAIL="management-publisher@actor.invalid")
                run("git","commit","--quiet","-m","Update regional code plane desired state",cwd=repo,env=env)
            revision=run("git","rev-parse","HEAD",cwd=repo); run("git","push","--quiet","origin","HEAD:refs/heads/main",cwd=repo)
        if inventory(target)!=files or run("git","ls-remote","--refs","origin","refs/heads/main",cwd=repo).split()[0]!=revision: raise ValueError("published Git state differs")
    value={"schema":"actor-regional-code-plane-desired-publication/v1","verdict":"passed","repository":{"url":read_url,"branch":"main","path":TARGET.as_posix()},"baseRevision":expected,"observedRevision":observed,"gitRevision":revision,"resumedAfterPublication":resumed,"renderReceiptSha256":digest(render_path.read_bytes()),"files":files}
    fd,staged=tempfile.mkstemp(prefix=f".{receipt.name}.",dir=receipt.parent)
    try:
        os.fchmod(fd,0o644)
        with os.fdopen(fd,"w") as stream: json.dump(value,stream,indent=2,sort_keys=True); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.link(staged,receipt)
    finally:
        try: os.unlink(staged)
        except FileNotFoundError: pass
    return value


def main():
    p=argparse.ArgumentParser(); p.add_argument("--desired-root",type=Path,required=True); p.add_argument("--render-receipt",type=Path,required=True); p.add_argument("--repository-url",required=True); p.add_argument("--read-url",required=True); p.add_argument("--expected-revision",required=True); p.add_argument("--receipt",type=Path,required=True); p.add_argument("--allow-local-repository",action="store_true",help=argparse.SUPPRESS); a=p.parse_args()
    value=publish(a.desired_root,a.render_receipt,a.repository_url,a.read_url,a.expected_revision,a.receipt,a.allow_local_repository); print(json.dumps({"verdict":"passed","revision":value["gitRevision"]},sort_keys=True))


if __name__=="__main__": main()
