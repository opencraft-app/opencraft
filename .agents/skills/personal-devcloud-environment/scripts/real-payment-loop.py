#!/usr/bin/env python3
# Real end-to-end closed loop probe for the personal DevCloud environment.
# inquiry(batch) -> place-and-pay(create) -> Pass active
#   -> inquiry(modify) -> place-and-pay(modify) -> Pass active on target bundle
#   -> refund -> isolated -> delete -> history_pass deleted
# Every request/response is recorded to a JSON transcript for contract tests.
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

SITE = os.environ.get("PERSONAL_DEV_SITE", "cn")
PORT = os.environ.get("INTERNAL_TRADE_PORT", "28084")
BASE = "http://127.0.0.1:" + PORT + "/internal/trade"
TOKEN = os.environ["LV_INTERNAL_TOKEN"]
UIN = os.environ["LV_UIN"]
APP_ID = os.environ["LV_APP_ID"]
SOURCE_BUNDLE = os.environ.get("LV_SOURCE_BUNDLE", "bundle_launch_01")
TARGET_BUNDLE = os.environ.get("LV_TARGET_BUNDLE", "bundle_cruise_ai_01")
PEER_BUNDLE = os.environ.get("LV_PEER_BUNDLE", "bundle_cruise_01")
OUT = os.environ.get("LV_TRANSCRIPT", "/tmp/lv-e2e/transcript.json")

transcript = []


def mysql(sql):
    cmd = [
        "kubectl", "exec", "-i", "-n", "localstack-system", "statefulset/mysql", "--",
        "sh", "-c",
        "MYSQL_PWD=$MYSQL_ROOT_PASSWORD exec mysql -N -B -uroot",
    ]
    p = subprocess.run(cmd, input=sql, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("mysql failed: " + p.stderr.strip())
    return p.stdout.strip()


def save():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(transcript, fh, ensure_ascii=False, indent=2)


def call(method, path, payload=None, expect=200):
    url = BASE + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if data:
        req.add_header("Content-Type", "application/json")
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            status = resp.status
            body = resp.read().decode()
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read().decode()
    elapsed = round(time.time() - started, 3)
    try:
        parsed = json.loads(body)
    except Exception:
        parsed = body
    transcript.append({
        "site": SITE,
        "method": method,
        "path": path,
        "request": payload,
        "status": status,
        "response": parsed,
        "elapsedSeconds": elapsed,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    print("[" + str(elapsed) + "s] " + method + " " + path + " -> " + str(status))
    print("  req: " + json.dumps(payload, ensure_ascii=False))
    print("  res: " + json.dumps(parsed, ensure_ascii=False)[:1500])
    sys.stdout.flush()
    if expect is not None and status != expect:
        save()
        raise SystemExit("unexpected status " + str(status) + " for " + path)
    return parsed


def note(label, value):
    transcript.append({"observation": label, "value": value,
                       "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    print("  # " + label + ": " + str(value))
    sys.stdout.flush()


def call_after_deal_lock(method, path, payload, attempts=24, interval=20):
    """变配刚发货完时，计费 order-center 侧的 deal/resource lock 还没释放，
    此刻发起 OnlineRefund 必然返回 returnCode=100151
    `deal lock error[[ERR_RESOURCE_LOCK]...exist locks]`。
    这是真实可复现的时序坑，不是环境坏了：锁释放后同一请求即成功。
    这里对且仅对该错误做退避重试，其他失败立即中止，避免把重复扣费/退费请求打上去。
    重试期间的失败样本不进 transcript，只保留最终成功的那一次和重试次数观测。
    """
    for attempt in range(1, attempts + 1):
        parsed = call(method, path, payload, expect=None)
        if transcript and transcript[-1].get("status") == 200:
            if attempt > 1:
                note("dealLockRetriesFor" + path.rsplit("/", 1)[-1], attempt - 1)
            return parsed
        body = json.dumps(parsed, ensure_ascii=False)
        if "100151" not in body and "ERR_RESOURCE_LOCK" not in body:
            save()
            raise SystemExit("unexpected failure for " + path + ": " + body[:800])
        transcript.pop()
        print("  ... deal lock still held, retrying in " + str(interval) + "s "
              "(" + str(attempt) + "/" + str(attempts) + ")")
        sys.stdout.flush()
        time.sleep(interval)
    save()
    raise SystemExit("deal lock never released for " + path)


def utc_literal_to_cst(literal):
    """把 DB 里的 UTC 字面值 '2006-01-02 15:04:05' 转成 jifei 要求的北京时间字面值。"""
    import datetime
    t = datetime.datetime.strptime(literal.strip(), "%Y-%m-%d %H:%M:%S")
    return (t + datetime.timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")

def wait_for(label, fn, timeout=480, interval=5):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        cur = fn()
        if cur != last:
            print("  ... " + label + ": " + str(cur))
            sys.stdout.flush()
            last = cur
        if cur and cur[0]:
            return cur
        time.sleep(interval)
    save()
    raise SystemExit("timeout waiting for " + label + ", last=" + str(last))


def main():
    # externalUserId 是 CTL 侧的业务用户 ID。优先用调用方透传的 state 值；
    # 否则依次回退到现存 Pass、历史 Pass（全新环境里 history_pass 可能是空表）。
    external_user = os.environ.get("LV_EXTERNAL_USER_ID", "").strip()
    for fallback in ("SELECT user_id FROM ctl.`pass` ORDER BY id DESC LIMIT 1;",
                     "SELECT user_id FROM ctl.history_pass ORDER BY id DESC LIMIT 1;",
                     "SELECT user_id FROM ctl.user_resource_quota ORDER BY id DESC LIMIT 1;"):
        if external_user:
            break
        external_user = mysql(fallback).strip()
    if not external_user:
        raise SystemExit("no external user id found; pass LV_EXTERNAL_USER_ID explicitly")
    note("externalUserId", external_user)

    common = {"externalUserId": external_user, "uin": UIN, "appId": APP_ID}

    resume_deal = os.environ.get("LV_RESUME_CREATE_DEAL", "")
    if resume_deal:
        deal = resume_deal
        note("resumedCreateDeal", deal)
    else:
        call("POST", "/inquiry/batch", dict(common, bundleIds=[SOURCE_BUNDLE, PEER_BUNDLE],
                                            period=1, timeUnit="m", goodsNum=1, payMode=1))
        order = call("POST", "/orders/place-and-pay", dict(common, bundleId=SOURCE_BUNDLE,
                                                           period=1, timeUnit="m", goodsNum=1, payMode=1))
        deal = order["dealName"]
    note("createDealName", deal)

    def create_state():
        row = mysql("SELECT CONCAT_WS('|',status,IFNULL(resource_id,'')) FROM trade.trade_order "
                    "WHERE deal_name='" + deal + "';")
        parts = row.split("|") if row else ["", ""]
        status = parts[0]
        rid = parts[1] if len(parts) > 1 else ""
        pass_row = ""
        if rid:
            pass_row = mysql("SELECT CONCAT_WS('|',status,bundle_id,expired_time) "
                             "FROM ctl.`pass` WHERE pass_id='" + rid + "';")
        done = status == "provisioned" and pass_row.startswith("active|")
        return (done, status, rid, pass_row)

    _, _, resource_id, pass_row = wait_for("create provisioned", create_state)
    note("resourceId", resource_id)
    note("passAfterCreate", pass_row)
    # curDeadline 是 jifei 协议层字段，契约为北京时间（CST, UTC+8）字面值
    # （trade/internal/jifei/timezone.go: CurDeadlineLocation）。
    # ctl.pass.expired_time 在 DB 里是 UTC 字面值，直接透传会让 trade 按 CST 解析，
    # 与 CTL 基线相差 8 小时，checkModify 必然 PASS_MODIFY_CONFIG_MISMATCH。
    cur_deadline = utc_literal_to_cst(pass_row.split("|")[2])
    note("curDeadlineCST", cur_deadline)

    modify_common = dict(common, resourceId=resource_id, sourceBundleId=SOURCE_BUNDLE,
                         targetBundleId=TARGET_BUNDLE, curDeadline=cur_deadline, payMode=1)
    call("POST", "/inquiry/modify", modify_common)
    mod = call("POST", "/orders/modify/place-and-pay", modify_common)
    mod_deal = mod["dealName"]
    note("modifyDealName", mod_deal)

    def modify_state():
        order_status = mysql("SELECT status FROM trade.trade_order WHERE deal_name='" + mod_deal + "';")
        pr = mysql("SELECT CONCAT_WS('|',status,bundle_id,IFNULL(modify_flow_id,''),IFNULL(modify_target_bundle_id,'')) "
                   "FROM ctl.`pass` WHERE pass_id='" + resource_id + "';")
        done = order_status == "provisioned" and pr.startswith("active|" + TARGET_BUNDLE + "|")
        return (done, order_status, pr)

    _, _, pass_after_modify = wait_for("modify provisioned", modify_state)
    note("passAfterModify", pass_after_modify)
    note("userResourceQuotaAfterModify", mysql(
        "SELECT GROUP_CONCAT(CONCAT_WS(':',resource_name,resource_quota_total,resource_quota_available) SEPARATOR ', ') "
        "FROM ctl.user_resource_quota WHERE user_id='" + external_user + "';"))
    note("sandboxModifyOperation", mysql(
        "SELECT CONCAT_WS('|',status,current_step,IFNULL(target_pool_id,'')) "
        "FROM sandbox.modify_operations ORDER BY id DESC LIMIT 1;"))

    call_after_deal_lock("POST", "/resources/" + resource_id + "/refund",
                         {"ownerUin": UIN, "uin": UIN, "appId": int(APP_ID),
                          "bundleId": TARGET_BUNDLE})

    def isolated_state():
        pr = mysql("SELECT status FROM ctl.`pass` WHERE pass_id='" + resource_id + "';")
        return (pr in ("isolated", "expired", ""), pr)

    _, isolated = wait_for("pass isolated", isolated_state, timeout=360)
    note("passAfterRefund", isolated)

    call_after_deal_lock("POST", "/resources/" + resource_id + "/delete",
                         {"uin": UIN, "appId": int(APP_ID), "bundleId": TARGET_BUNDLE})

    def deleted_state():
        hp = mysql("SELECT CONCAT_WS('|',status,bundle_id) FROM ctl.history_pass "
                   "WHERE pass_id='" + resource_id + "';")
        return (hp.startswith("deleted|"), hp)

    _, deleted = wait_for("history_pass deleted", deleted_state, timeout=360)
    note("historyPassAfterDelete", deleted)

    note("tradeFlowsForDeals", mysql(
        "SELECT GROUP_CONCAT(CONCAT_WS(':',flow_type,status) ORDER BY id SEPARATOR ', ') "
        "FROM trade.trade_flow WHERE id >= (SELECT MIN(id) FROM trade.trade_flow "
        "WHERE deal_name='" + deal + "');"))
    save()
    print("TRANSCRIPT_SAVED " + OUT)


if __name__ == "__main__":
    main()
