#!/usr/bin/env python3
"""Offline auth-only patch; no credential reads, cloud calls or service restarts."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import zlib

LEGACY_BODY = '''**取值方式**（按顺序取第一个非空值）：

1. 环境变量 `VELA_WEBSITE_KEY`
2. 都不可用 → 停下来提示用户需要先通过 Vela 平台初始化实例，**不要继续调用 API**

API 地址同样从平台预置的环境变量 `VELA_API_BASE` 获取。
如果该变量不存在，按站点归属取生产默认值：
国内 `https://api.lightvela.com`、国际 `https://api.lightvela.ai`。

**注意：只有 API 地址有默认值，凭据没有默认值。**
`VELA_WEBSITE_KEY` 不存在时必须立即停止，不允许继续调用 API。

读取示例（token 与地址都不要 echo 出来）：

```bash
# API 地址：有默认值（国内站），变量不存在时降级使用
API_BASE="${VELA_API_BASE:-https://api.lightvela.com}"

# 凭据：无默认值，变量不存在时直接报错退出（:? 语法）
KEY="${VELA_WEBSITE_KEY:?VELA_WEBSITE_KEY not set, instance not initialized}"
```

'''
AUTH_BODY = '''**取值方式**（按顺序取第一个非空值）：

1. 当前执行环境中的 `VELA_WEBSITE_KEY`。
2. 环境变量缺失或为空时，在**同一次 terminal 命令的子 Shell** 中加载平台预置的 `/etc/vela/website-credential.env`，并 export `VELA_WEBSITE_KEY` 和 `VELA_API_BASE`。
3. 只有环境变量和文件兜底都不可用（文件缺失、不可读、加载失败或 Key 仍为空），才停下来提示用户需要通过 Vela 平台初始化实例，**不要继续调用 API**。

**环境变量为空不等于实例未初始化。必须先尝试凭据文件兜底，不要求用户重启 Agent、gateway 或实例。**

API 地址也优先使用当前环境中的非空 `VELA_API_BASE`，缺失时尝试同一凭据文件；
加载文件不得覆盖已有的非空环境变量。如果地址仍为空，按站点归属取生产默认值：
国内 `https://api.lightvela.com`、国际 `https://api.lightvela.ai`。
**只有 API 地址有默认值，凭据没有默认值。**

**加载凭据和使用凭据必须放在同一次终端执行中。** 将 API 请求或子脚本放在下面子 Shell 的结尾，
不要先单独执行加载命令，再在另一次 terminal 调用中使用凭据；每次认证命令都要重复加载步骤。
子 Shell 内 export 的变量可供同一命令启动的 Python/Node/其他子脚本读取，不会修改外层会话。
禁止输出 Key、凭据文件内容或含凭据的原始响应，禁止写入聊天、日志、项目代码或上传文件；
凭据处理及后续 API 请求期间保持 `set +x`，不要开启 shell tracing，不需要重启。

读取示例（在同一个子 Shell 中继续执行建站 API 请求或脚本）：

```bash
(
  set +x
  _vela_env_key="${VELA_WEBSITE_KEY:-}"
  _vela_env_base="${VELA_API_BASE:-}"
  if [ -z "$_vela_env_key" ] || [ -z "$_vela_env_base" ]; then
    if [ -f /etc/vela/website-credential.env ] && [ -r /etc/vela/website-credential.env ]; then
      # 文件仅由平台维护；抑制加载输出，失败时丢弃部分加载的值。
      if ! . /etc/vela/website-credential.env >/dev/null 2>&1; then
        VELA_WEBSITE_KEY=
        VELA_API_BASE=
      fi
    fi
  fi
  VELA_WEBSITE_KEY="${_vela_env_key:-${VELA_WEBSITE_KEY:-}}"
  VELA_API_BASE="${_vela_env_base:-${VELA_API_BASE:-}}"
  unset _vela_env_key _vela_env_base
  if [ -z "$VELA_WEBSITE_KEY" ]; then
    printf '%s\\n' 'website credential unavailable' >&2
    exit 1
  fi
  VELA_API_BASE="${VELA_API_BASE:-https://api.lightvela.com}"
  export VELA_WEBSITE_KEY VELA_API_BASE
  KEY="$VELA_WEBSITE_KEY"
  API_BASE="$VELA_API_BASE"

  # 在这里执行建站 API 请求或子脚本；不要打印 KEY，不要重新开启 set -x。
)
```

'''
LEGACY_AUTH = '''## 认证与 API 地址

每个实例拥有一个由平台预置的永久凭据（`VELA_WEBSITE_KEY`）。
凭据格式为 `vik_<key_id>_<secret>`，权限范围绑定该实例及其所属用户，
只能调用建站相关接口，不暴露任何账号级权限；凭据不得复制或外泄。

**取值方式**（按顺序取第一个非空值）：

1. 环境变量 `VELA_WEBSITE_KEY`
2. 都不可用 → 停下来提示用户需要先通过 Vela 平台初始化实例，**不要继续调用 API**

API 地址同样从平台预置的环境变量 `VELA_API_BASE` 获取。
如果该变量不存在，按站点归属取生产默认值：
国内 `https://api.lightvela.com`、国际 `https://api.lightvela.ai`。

**注意：只有 API 地址有默认值，凭据没有默认值。**
`VELA_WEBSITE_KEY` 不存在时必须立即停止，不允许继续调用 API。

读取示例（token 与地址都不要 echo 出来）：

```bash
# API 地址：有默认值（国内站），变量不存在时降级使用
API_BASE="${VELA_API_BASE:-https://api.lightvela.com}"

# 凭据：无默认值，变量不存在时直接报错退出（:? 语法）
KEY="${VELA_WEBSITE_KEY:?VELA_WEBSITE_KEY not set, instance not initialized}"
```

请求头：

```
Authorization: Vela-Instance-Key <key>
Content-Type: application/json
```

'''
AUTH_MARKER = '<!-- vela-website-credential-fallback:v1 -->'
AUTH_SECTION = LEGACY_AUTH.replace(LEGACY_BODY, AUTH_BODY, 1).replace(
    '## 认证与 API 地址\n', '## 认证与 API 地址\n' + "\n" + AUTH_MARKER + "\n", 1
)
PINNED_AUTH_SHA256 = '7ee96ef106e2853d6b3dfae389921403c5d47674aade190be2a93ba0c3f109bf'

PRIOR_MANUAL_AUTH = '''## 认证与 API 地址

每个实例拥有一个由平台预置的永久凭据（`VELA_WEBSITE_KEY`）。
凭据格式为 `vik_<key_id>_<secret>`，权限范围绑定该实例及其所属用户，
只能调用建站相关接口，不暴露任何账号级权限；凭据不得复制或外泄。

**取值方式**（按顺序取第一个非空值）：

1. 当前执行环境中的 `VELA_WEBSITE_KEY`。
2. 环境变量为空时，在当前终端命令中加载平台预置的 `/etc/vela/website-credential.env`，并导出其中的 `VELA_WEBSITE_KEY` 和 `VELA_API_BASE`。
3. 只有上述两个来源都不可用、文件不可读或加载后 Key 仍为空，才停下来提示用户需要通过 Vela 平台初始化实例，**不要继续调用 API**。

**环境变量为空不等于实例未初始化。必须先尝试凭据文件兜底，不需要用户重启 Agent、gateway 或实例。**

API 地址优先使用 `VELA_API_BASE`（包括凭据文件加载的值）。
如果该变量仍不存在，按站点归属取生产默认值：
国内 `https://api.lightvela.com`、国际 `https://api.lightvela.ai`。
**只有 API 地址有默认值，凭据没有默认值。**

**加载凭据和使用凭据必须放在同一次终端执行中。** 推荐包在子 Shell 内，避免把 Key 留在外层终端会话快照中。
分多次调用终端时，每一次需要认证的命令都要执行同样的加载步骤，不要假定上一次的 export 会保留。
不得输出凭据文件内容或 Key，不得将其写入聊天、日志、项目代码或上传文件；不要开启 shell 的 `set -x` 调试。

读取示例（在同一个子 Shell 中继续执行建站 API 请求或脚本）：

```bash
(
  if [ -z "${VELA_WEBSITE_KEY:-}" ]; then
    if [ ! -r /etc/vela/website-credential.env ]; then
      printf '%s\\\\n' 'website credential unavailable' >&2
      exit 1
    fi
    set -a
    . /etc/vela/website-credential.env
    set +a
  fi

  # Key 无默认值；只有文件兜底也失败后才停止。
  KEY="${VELA_WEBSITE_KEY:?website credential unavailable}"
  API_BASE="${VELA_API_BASE:-https://api.lightvela.com}"
  export VELA_WEBSITE_KEY
  export VELA_API_BASE="$API_BASE"

  # 在这里执行建站 API 请求或脚本；不要打印 KEY。
)
```

请求头：

```
Authorization: Vela-Instance-Key <key>
Content-Type: application/json
```

'''

# Only these exact, reviewed historical sections may be replaced. Do not normalize
# arbitrary custom auth. The vwk version is the repository's original static Skill.
KNOWN_AUTH = {
    hashlib.sha256(value.encode()).hexdigest()
    for value in (
        LEGACY_AUTH,
        AUTH_SECTION.replace("\n" + AUTH_MARKER + "\n", "", 1),
        LEGACY_AUTH.replace('vik_<key_id>', 'vwk_<key_id>'),
        PRIOR_MANUAL_AUTH,
        PRIOR_MANUAL_AUTH.replace('(\n  if ', '(\n  set +x\n  if ', 1),
    )
}
SECTION = re.compile(r'^## 认证与 API 地址\n.*?(?=^## |\Z)', re.M | re.S)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def plan(original):
    text = original.decode('utf-8')
    sections = list(SECTION.finditer(text))
    if len(sections) != 1:
        return 'skipped-unknown-auth', original
    section = sections[0]
    current = section.group()
    replacement = AUTH_SECTION
    if 'vwk_<key_id>' in current:
        replacement = replacement.replace('vik_<key_id>', 'vwk_<key_id>', 1)
    # Exact reviewed production v1 is already repaired; never rewrite it
    # solely to upgrade its wording or the stricter canonical edge guards.
    if current == replacement:
        return 'already-current', original
    if digest(current.encode()) == PINNED_AUTH_SHA256:
        return 'already-pinned-v1', original
    if digest(current.encode()) not in KNOWN_AUTH:
        return 'skipped-unknown-auth', original
    return 'patched', (text[:section.start()] + replacement + text[section.end():]).encode()


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def regular_bytes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 2 * 1024 * 1024:
            raise ValueError('unsafe Skill file')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            return source.read(), metadata
    finally:
        os.close(fd)


def stage(parent, content, metadata, mode):
    fd, name = tempfile.mkstemp(prefix='.website-auth-stage-', dir=parent)
    path = Path(name)
    try:
        with os.fdopen(fd, 'wb') as out:
            if (os.fstat(out.fileno()).st_uid, os.fstat(out.fileno()).st_gid) != (metadata.st_uid, metadata.st_gid):
                os.fchown(out.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(out.fileno(), mode)
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        return path
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def patch(path):
    # Refuse managed releases and redirected files: patching would invalidate the
    # existing bundle digest/rollback receipt or touch a different installation.
    path = Path(os.path.abspath(path))
    for ancestor in (*reversed(path.parents), path):
        if ancestor.is_symlink():
            raise ValueError('symlink Skill path')
    if not path.exists():
        return {'status': 'skipped-missing'}
    if os.path.lexists(path.parent / 'bundle.json'):
        return {'status': 'skipped-managed-bundle'}
    if not path.is_file():
        raise ValueError('unsafe Skill file')
    lock = os.open(path.parent / '.website-auth.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise ValueError('unsafe patch lock')
        fcntl.flock(lock, fcntl.LOCK_EX)
        original, metadata = regular_bytes(path)
        status, updated = plan(original)
        result = {'status': status, 'before_sha256': digest(original)}
        if status != 'patched':
            return result
        backup = path.with_name(path.name + '.auth-backup-' + digest(original))
        backup_stage = stage(path.parent, original, metadata, 0o600)
        try:
            try:
                os.link(backup_stage, backup)
            except FileExistsError:
                saved, saved_meta = regular_bytes(backup)
                if saved != original or stat.S_IMODE(saved_meta.st_mode) != 0o600:
                    raise ValueError('existing backup differs or is not private') from None
            sync_dir(path.parent)
        finally:
            backup_stage.unlink(missing_ok=True)
        replacement = stage(path.parent, updated, metadata, stat.S_IMODE(metadata.st_mode))
        try:
            latest, latest_meta = regular_bytes(path)
            if latest != original or (latest_meta.st_ino, latest_meta.st_mtime_ns) != (metadata.st_ino, metadata.st_mtime_ns):
                raise ValueError('Skill changed during patch')
            os.replace(replacement, path)
            sync_dir(path.parent)
        finally:
            replacement.unlink(missing_ok=True)
        result.update(after_sha256=digest(updated), backup=str(backup))
        return result
    finally:
        os.close(lock)


def command():
    """Return a self-contained, credential-free TAT payload; never invoke TAT."""
    source = base64.b64encode(zlib.compress(Path(__file__).read_bytes(), 9)).decode()
    script = "#!/bin/bash\nset -eu\nset +x\npython3 - <<'WEBSITE_AUTH_PY'\n"
    script += 'import base64,zlib,json,os\nfrom pathlib import Path\n'
    script += 'ns = {"__name__": "website_auth_patch"}\n'
    script += f'exec(compile(zlib.decompress(base64.b64decode({source!r})), "website_auth_patch", "exec"), ns)\n'
    script += 'try:\n    result = ns["patch"](Path(os.environ["HOME"]) / ".hermes/skills/website-builder/SKILL.md")\n'
    script += 'except (OSError, ValueError):\n    print("WEBSITE_AUTH_RESULT=" + json.dumps({"status": "error"}))\n    raise SystemExit(1)\n'
    script += 'print("WEBSITE_AUTH_RESULT=" + json.dumps(result, sort_keys=True))\nWEBSITE_AUTH_PY\n'
    if len(script.encode()) > 64000:
        raise ValueError('auth command exceeds size budget')
    return script


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--skill-path', type=Path, help='patch exactly this unmanaged SKILL.md')
    group.add_argument('--command-output', type=Path, help='prepare payload only; exclusive-create, no cloud call')
    args = parser.parse_args()
    try:
        if args.command_output:
            fd = os.open(args.command_output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as out:
                out.write(command())
            result = {'status': 'command-prepared'}
        else:
            result = patch(args.skill_path)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError):
        # No exception messages, Skill contents, environment, or keys in logs.
        print(json.dumps({'status': 'error'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
