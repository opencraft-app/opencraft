package instance

import (
	"encoding/json"
	"strconv"
	"strings"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/transport"
)

const channelHistoryKind = "lightvela.channel-history.v1"

var channelHistorySources = map[string]bool{
	"weixin": true, "qq": true, "qqbot": true, "feishu": true,
	"lark": true, "dingtalk": true, "wecom": true, "yuanbao": true,
	"telegram": true, "discord": true, "slack": true, "whatsapp": true,
}

// The script runs as agentuser and resolves the Bot from Hermes before reading.
// The selected Profile's state.db isolates Bots;
// non-multiplexed Hermes gateways use agent:main: keys in every Profile.
// Rows without a channel session_key remain excluded.
const readChannelHistoryScript = hermesProfileListFunctions + `
import re
import sqlite3
import sys

KIND = "lightvela.channel-history.v1"
SOURCES = ("weixin", "qq", "qqbot", "feishu", "lark", "dingtalk", "wecom", "yuanbao", "telegram", "discord", "slack", "whatsapp")
mode, bot_id, instance_id, source, before, raw_limit, session_id = sys.argv[1:]
prefix = "agent:main:"
limit = min(max(int(raw_limit), 1), 50)

def emit(**payload):
    print(json.dumps({"kind": KIND, **payload}, ensure_ascii=False, separators=(",", ":")))

try:
    profiles = asyncio.run(list_hermes_profiles())["items"]
except Exception:
    emit(error="profile_list_failed")
    sys.exit(0)

profile = ""
for item in profiles:
    native_id = item.get("native_id", "")
    is_default = item.get("is_default") or native_id == "default"
    if (instance_id if is_default else native_id) == bot_id:
        profile = "main" if is_default else native_id
        break
if not profile:
    emit(error="bot_not_found")
    sys.exit(0)
if not re.fullmatch(r"[a-zA-Z0-9_-]+", profile):
    emit(error="invalid_profile")
    sys.exit(0)

def clip(value):
    return value if len(value) <= 2000 else value[:2000] + "…（内容已截断）"

def text_content(value):
    if not isinstance(value, str) or not value.strip():
        return "此消息包含暂不支持预览的内容"
    if value.startswith("\x00json:"):
        try:
            decoded = json.loads(value[6:])
            if isinstance(decoded, str):
                return clip(decoded)
            if isinstance(decoded, (list, dict)):
                parts = decoded if isinstance(decoded, list) else [decoded]
                plain = [part.get("text") for part in parts if isinstance(part, dict) and part.get("type") in ("text", "input_text", "output_text") and isinstance(part.get("text"), str)]
                if len(plain) != len(parts):
                    plain.append("此消息包含暂不支持预览的内容")
                return clip("\n".join(plain) or "此消息包含暂不支持预览的内容")
        except ValueError:
            return "此消息包含暂不支持预览的内容"
        return "此消息包含暂不支持预览的内容"
    return clip(value)

root = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
if profile != "main":
    root = root / "profiles" / profile
database = root / "state.db"
if not database.is_file():
    emit(items=[] if mode == "list" else None, not_found=mode != "list")
    sys.exit(0)

try:
    db = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    session_columns = {row[1] for row in db.execute("PRAGMA table_info(sessions)")}
    message_columns = {row[1] for row in db.execute("PRAGMA table_info(messages)")}
    if not {"id", "source", "started_at", "session_key"}.issubset(session_columns) or not {"id", "session_id", "role", "content", "timestamp", "tool_calls"}.issubset(message_columns):
        emit(error="unsupported_schema")
        sys.exit(0)
    tool_filter = " AND (tool_calls IS NULL OR tool_calls = '') AND content IS NOT NULL AND trim(content) <> ''"
    if "display_kind" in message_columns:
        tool_filter += " AND display_kind IS NULL"
    if "active" in message_columns and "compacted" in message_columns:
        tool_filter += " AND (active = 1 OR compacted = 1)"
    elif "active" in message_columns:
        tool_filter += " AND active = 1"
    if "_compressed_summary" in message_columns:
        tool_filter += " AND COALESCE(_compressed_summary, 0) = 0"
    if "display_metadata" in message_columns:
        tool_filter += " AND CASE WHEN json_valid(display_metadata) THEN COALESCE(json_extract(display_metadata, '$.model_only'), 0) ELSE 0 END = 0"
    source_marks = ",".join("?" for _ in SOURCES)
    scope = "substr(s.session_key, 1, ?) = ? AND s.source IN (" + source_marks + ")"
    scope_args = [len(prefix), prefix, *SOURCES]
    if mode == "list":
        sources = [row[0] for row in db.execute("SELECT DISTINCT s.source FROM sessions s WHERE " + scope + " ORDER BY s.source", scope_args)]
        matching_sources = ("qq", "qqbot") if source == "qqbot" else (("feishu", "lark") if source == "feishu" else (source,))
        extra = " AND s.source IN (" + ",".join("?" for _ in matching_sources) + ")" if source else ""
        args = [*scope_args, *(matching_sources if source else ())]
        latest = "COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id AND m.role IN ('user','assistant')" + tool_filter + "), s.started_at)"
        title = "s.display_name" if "display_name" in session_columns else ("s.title" if "title" in session_columns else "NULL")
        chat_type = "s.chat_type" if "chat_type" in session_columns else "NULL"
        user_id = "s.user_id" if "user_id" in session_columns else "NULL"
        chat_id = "s.chat_id" if "chat_id" in session_columns else "NULL"
        visible = "SELECT s.id, s.source, " + title + " AS title, " + chat_type + " AS chat_type, " + user_id + " AS user_id, " + chat_id + " AS chat_id, " + latest + " AS updated_at FROM sessions s WHERE " + scope + extra
        if before:
            cursor = db.execute("WITH visible AS (" + visible + ") SELECT updated_at, id FROM visible WHERE id = ?", [*args, before]).fetchone()
            if cursor is None:
                emit(error="invalid_cursor")
                sys.exit(0)
            boundary = " WHERE (updated_at < ? OR (updated_at = ? AND id < ?))"
            args.extend([cursor["updated_at"], cursor["updated_at"], cursor["id"]])
        else:
            boundary = ""
        rows = db.execute("WITH visible AS (" + visible + ") SELECT * FROM visible" + boundary + " ORDER BY updated_at DESC, id DESC LIMIT ?", [*args, limit + 1]).fetchall()
        items = []
        for row in rows[:limit]:
            kind = str(row["chat_type"] or "").lower()
            kind = "group" if kind in ("group", "supergroup", "channel") else ("private" if kind in ("private", "dm", "direct") else "unknown")
            title = str(row["title"] or "").strip()
            if not title or title in (row["user_id"], row["chat_id"]) or re.fullmatch(r"[A-Za-z0-9_:-]{16,}", title):
                title = "未命名群聊" if kind == "group" else "未命名私聊" if kind == "private" else "未命名会话"
            preview = db.execute("SELECT content FROM messages WHERE session_id = ? AND role IN ('user','assistant')" + tool_filter + " ORDER BY id DESC LIMIT 1", (row["id"],)).fetchone()
            items.append({"id": row["id"], "source": row["source"], "title": title[:80], "chat_type": kind, "updated_at": row["updated_at"], "preview": text_content(preview[0])[:160] if preview else ""})
        emit(items=items, sources=sources, next_cursor=items[-1]["id"] if len(rows) > limit else "")
    elif mode == "messages":
        session = db.execute("SELECT s.id FROM sessions s WHERE s.id = ? AND " + scope, [session_id, *scope_args]).fetchone()
        if session is None:
            emit(not_found=True)
            sys.exit(0)
        cursor = int(before) if before else 0
        rows = db.execute("SELECT id, role, content, timestamp FROM messages WHERE session_id = ? AND role IN ('user','assistant')" + tool_filter + (" AND id < ?" if cursor else "") + " ORDER BY id DESC LIMIT ?", [session_id, *([cursor] if cursor else []), limit + 1]).fetchall()
        items = [{"id": row["id"], "role": row["role"], "text": text_content(row["content"]), "timestamp": row["timestamp"]} for row in reversed(rows[:limit])]
        emit(items=items, next_cursor=str(items[0]["id"]) if len(rows) > limit else "")
    else:
        emit(error="invalid_mode")
finally:
    db.close()
`

type channelHistoryPayload struct {
	Kind       string          `json:"kind"`
	Items      json.RawMessage `json:"items"`
	Sources    []string        `json:"sources"`
	NextCursor string          `json:"next_cursor"`
	NotFound   bool            `json:"not_found"`
	Error      string          `json:"error"`
}

func (l *logic) readChannelHistory(ctx pctx.Context, instanceID, botID, mode, source, before, sessionID string, limit int) (*channelHistoryPayload, error) {
	if !channelHistorySources[source] && source != "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	if limit < 1 || limit > 50 || strings.TrimSpace(botID) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	if _, err := l.instanceDao.GetByInstanceID(ctx, instanceID); err != nil {
		return nil, err
	}
	command := buildHermesPythonCommand(readChannelHistoryScript, mode, strings.TrimSpace(botID), instanceID, source, before, strconv.Itoa(limit), sessionID)
	result, err := l.execHermesProfileCommand(ctx, instanceID, command)
	if err != nil || result == nil {
		// Command output may contain message text; never forward it in errors.
		return nil, errcode.ErrChannelHistoryUnavailable
	}
	var payload channelHistoryPayload
	if parseLastJSONLine(result.Output, &payload) != nil || payload.Kind != channelHistoryKind {
		return nil, errcode.ErrChannelHistoryUnavailable
	}
	if payload.Error == "invalid_cursor" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	if payload.Error == "bot_not_found" {
		return nil, errcode.ErrInstanceBotNotFound
	}
	if payload.Error == "profile_list_failed" {
		return nil, errcode.ErrInstanceBotProfileFailed
	}
	if payload.Error != "" {
		return nil, errcode.ErrChannelHistoryUnavailable
	}
	return &payload, nil
}

func (l *logic) ListChannelSessions(ctx pctx.Context, instanceID, botID, source, before string, limit int) (*transport.ChannelSessionsResponse, error) {
	payload, err := l.readChannelHistory(ctx, instanceID, botID, "list", source, before, "", limit)
	if err != nil {
		return nil, err
	}
	var items []transport.ChannelSession
	if err := json.Unmarshal(payload.Items, &items); err != nil || items == nil {
		return nil, errcode.ErrChannelHistoryUnavailable
	}
	return &transport.ChannelSessionsResponse{Items: items, Sources: payload.Sources, NextCursor: payload.NextCursor}, nil
}

func (l *logic) ListChannelMessages(ctx pctx.Context, instanceID, botID, sessionID, before string, limit int) (*transport.ChannelMessagesResponse, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	if before != "" {
		cursor, err := strconv.ParseInt(before, 10, 64)
		if err != nil || cursor <= 0 {
			return nil, errcode.ErrInstanceInvalidParam
		}
	}
	payload, err := l.readChannelHistory(ctx, instanceID, botID, "messages", "", before, sessionID, limit)
	if err != nil {
		return nil, err
	}
	if payload.NotFound {
		return nil, errcode.ErrChannelHistoryNotFound
	}
	var items []transport.ChannelMessage
	if err := json.Unmarshal(payload.Items, &items); err != nil || items == nil {
		return nil, errcode.ErrChannelHistoryUnavailable
	}
	return &transport.ChannelMessagesResponse{Items: items, NextCursor: payload.NextCursor}, nil
}
