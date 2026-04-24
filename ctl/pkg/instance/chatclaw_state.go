package instance

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"slices"
	"strconv"
	"strings"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/transport"
	"github.com/google/uuid"
)

const (
	chatClawDBPath                  = `${HOME}/.openclaw/chatclaw.sqlite3`
	chatClawSQLiteTimeoutSec        = 30
	chatClawRuntimeUser             = "lightclaw"
	chatClawSnapshotAgentPrefix     = "__CTL_CC_AGENT__"
	chatClawSnapshotTeamPrefix      = "__CTL_CC_TEAM__"
	chatClawSnapshotConvPrefix      = "__CTL_CC_CONVERSATION__"
	chatClawSnapshotUploadPrefix    = "__CTL_CC_UPLOAD__"
	chatClawProjectionOKPrefix      = "__CTL_CC_PROJECTION__OK"
	chatClawProjectionChangedPrefix = "__CTL_CC_PROJECTION__CHANGED"
	chatClawProjectionNoopPrefix    = "__CTL_CC_PROJECTION__NOOP"
	chatClawProjectionErrorPrefix   = "__CTL_CC_PROJECTION__ERROR"
)

var (
	allowedChatClawSpecialties       = []string{"general", "coding", "research", "writing", "design"}
	allowedChatClawConversationKinds = []string{"conversation", "team_lane"}
	allowedChatClawUploadOwnerTypes  = []string{"agent", "team", "workspace"}
	chatClawUUIDFn                   = uuid.NewString
)

func ensureSQLite3InstalledCommand() string {
	return strings.Join([]string{
		`ensure_sqlite3() {`,
		`  if command -v sqlite3 >/dev/null 2>&1; then return 0; fi`,
		`  if command -v yum >/dev/null 2>&1; then yum install -y sqlite >/dev/null; return $?; fi`,
		`  if command -v dnf >/dev/null 2>&1; then dnf install -y sqlite >/dev/null; return $?; fi`,
		`  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y sqlite3 >/dev/null; return $?; fi`,
		`  if command -v apk >/dev/null 2>&1; then apk add --no-cache sqlite >/dev/null; return $?; fi`,
		`  echo "sqlite3 not installed and no supported package manager found" >&2`,
		`  return 127`,
		`}`,
		`ensure_sqlite3`,
	}, "\n")
}

func ensureChatClawRuntimeUserCommand() string {
	return strings.Join([]string{
		fmt.Sprintf(`OPENCLAW_RUNTIME_USER="${OPENCLAW_RUNTIME_USER:-%s}"`, chatClawRuntimeUser),
		`OPENCLAW_RUNTIME_UID="${OPENCLAW_RUNTIME_UID:-$(id -u "$OPENCLAW_RUNTIME_USER" 2>/dev/null || true)}"`,
		`OPENCLAW_RUNTIME_HOME="${OPENCLAW_RUNTIME_HOME:-$(getent passwd "$OPENCLAW_RUNTIME_USER" 2>/dev/null | cut -d: -f6)}"`,
		`if [ -z "$OPENCLAW_RUNTIME_HOME" ]; then OPENCLAW_RUNTIME_HOME="/home/$OPENCLAW_RUNTIME_USER"; fi`,
		`export OPENCLAW_RUNTIME_USER OPENCLAW_RUNTIME_UID OPENCLAW_RUNTIME_HOME`,
	}, "\n")
}

type chatClawAgentRow struct {
	ID            string
	Name          string
	Description   string
	Specialty     string
	WorkspacePath string
	CreatedAt     int64
	UpdatedAt     int64
}

type chatClawTeamRow struct {
	ID          string
	Name        string
	Description string
	AgentIDs    []string
	CreatedAt   int64
	UpdatedAt   int64
}

type chatClawConversationRow struct {
	ID              string
	Kind            string
	AgentID         string
	TeamID          string
	Title           string
	RuntimeThreadID string
	CreatedAt       int64
	UpdatedAt       int64
}

type chatClawSnapshot struct {
	Agents        []chatClawAgentRow
	Teams         []chatClawTeamRow
	Conversations []chatClawConversationRow
	Uploads       []chatClawWorkspaceUploadRow
}

type chatClawWorkspaceUploadRow struct {
	ID             string
	Store          string
	StoreKey       string
	OwnerType      string
	OwnerID        string
	AgentID        string
	ConversationID string
	FileName       string
	MediaType      string
	SizeBytes      int64
	WorkspacePath  string
	RelativePath   string
	CreatedAt      int64
	UpdatedAt      int64
}

const chatClawWorkspaceUploadStore = "workspace-upload"

func sqlQuoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func sqlHexDecode(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", nil
	}
	decoded, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func nowUnix() int64 {
	return time.Now().UTC().Unix()
}

func chatClawWorkspacePathForAgent(agentID string) string {
	if strings.TrimSpace(agentID) == "" || agentID == "main" {
		return "$OPENCLAW_RUNTIME_HOME/.openclaw/workspace"
	}
	return fmt.Sprintf("$OPENCLAW_RUNTIME_HOME/.openclaw/workspace-%s", agentID)
}

func generateChatClawEntityID(prefix string) string {
	return prefix + "_" + strings.ReplaceAll(chatClawUUIDFn(), "-", "")
}

func normalizeChatClawSpecialty(value string) (string, bool) {
	normalized := strings.TrimSpace(strings.ToLower(value))
	if slices.Contains(allowedChatClawSpecialties, normalized) {
		return normalized, true
	}
	return "", false
}

func normalizeChatClawConversationKind(value string) (string, bool) {
	normalized := strings.TrimSpace(strings.ToLower(value))
	if slices.Contains(allowedChatClawConversationKinds, normalized) {
		return normalized, true
	}
	return "", false
}

func normalizeChatClawUploadOwnerType(value string) (string, bool) {
	normalized := strings.TrimSpace(strings.ToLower(value))
	if slices.Contains(allowedChatClawUploadOwnerTypes, normalized) {
		return normalized, true
	}
	return "", false
}

func ensureChatClawSchemaCommand() string {
	return strings.Join([]string{
		ensureSQLite3InstalledCommand(),
		ensureChatClawRuntimeUserCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`mkdir -p "$(dirname "$CHATCLAW_DB")"`,
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`PRAGMA journal_mode=WAL;`,
		`CREATE TABLE IF NOT EXISTS chatclaw_agents (`,
		`  id TEXT PRIMARY KEY,`,
		`  name TEXT NOT NULL,`,
		`  description TEXT NOT NULL DEFAULT '',`,
		`  specialty TEXT NOT NULL,`,
		`  workspace_path TEXT NOT NULL DEFAULT '',`,
		`  created_at INTEGER NOT NULL,`,
		`  updated_at INTEGER NOT NULL`,
		`);`,
		`CREATE TABLE IF NOT EXISTS chatclaw_teams (`,
		`  id TEXT PRIMARY KEY,`,
		`  name TEXT NOT NULL,`,
		`  description TEXT NOT NULL DEFAULT '',`,
		`  agent_ids TEXT NOT NULL DEFAULT '[]',`,
		`  created_at INTEGER NOT NULL,`,
		`  updated_at INTEGER NOT NULL`,
		`);`,
		`CREATE TABLE IF NOT EXISTS chatclaw_conversations (`,
		`  id TEXT PRIMARY KEY,`,
		`  kind TEXT NOT NULL,`,
		`  agent_id TEXT NOT NULL DEFAULT '',`,
		`  team_id TEXT NOT NULL DEFAULT '',`,
		`  title TEXT NOT NULL,`,
		`  runtime_thread_id TEXT NOT NULL DEFAULT '',`,
		`  created_at INTEGER NOT NULL,`,
		`  updated_at INTEGER NOT NULL`,
		`);`,
		`CREATE TABLE IF NOT EXISTS chatclaw_workspace_uploads (`,
		`  id TEXT PRIMARY KEY,`,
		`  store TEXT NOT NULL DEFAULT 'workspace-upload',`,
		`  store_key TEXT NOT NULL DEFAULT '',`,
		`  owner_type TEXT NOT NULL,`,
		`  owner_id TEXT NOT NULL,`,
		`  agent_id TEXT NOT NULL,`,
		`  conversation_id TEXT NOT NULL DEFAULT '',`,
		`  file_name TEXT NOT NULL,`,
		`  media_type TEXT NOT NULL,`,
		`  size_bytes INTEGER NOT NULL,`,
		`  workspace_path TEXT NOT NULL,`,
		`  relative_path TEXT NOT NULL,`,
		`  created_at INTEGER NOT NULL,`,
		`  updated_at INTEGER NOT NULL`,
		`);`,
		`SQL`,
		`if ! sqlite3 "$CHATCLAW_DB" "SELECT 1 FROM pragma_table_info('chatclaw_workspace_uploads') WHERE name = 'store' LIMIT 1;" | grep -q 1; then`,
		`  sqlite3 "$CHATCLAW_DB" "ALTER TABLE chatclaw_workspace_uploads ADD COLUMN store TEXT NOT NULL DEFAULT 'workspace-upload';"`,
		`fi`,
		`if ! sqlite3 "$CHATCLAW_DB" "SELECT 1 FROM pragma_table_info('chatclaw_workspace_uploads') WHERE name = 'store_key' LIMIT 1;" | grep -q 1; then`,
		`  sqlite3 "$CHATCLAW_DB" "ALTER TABLE chatclaw_workspace_uploads ADD COLUMN store_key TEXT NOT NULL DEFAULT '';"`,
		`fi`,
		`sqlite3 "$CHATCLAW_DB" "UPDATE chatclaw_workspace_uploads SET store = 'workspace-upload' WHERE store IS NULL OR store = '';"`,
		`sqlite3 "$CHATCLAW_DB" "UPDATE chatclaw_workspace_uploads SET store_key = id WHERE store_key IS NULL OR store_key = '';"`,
		`if ! sqlite3 "$CHATCLAW_DB" "SELECT 1 FROM pragma_table_info('chatclaw_agents') WHERE name = 'workspace_path' LIMIT 1;" | grep -q 1; then`,
		`  sqlite3 "$CHATCLAW_DB" "ALTER TABLE chatclaw_agents ADD COLUMN workspace_path TEXT NOT NULL DEFAULT '';"`,
		`fi`,
		`conversation_columns="$(sqlite3 "$CHATCLAW_DB" "SELECT group_concat(name, ',') FROM pragma_table_info('chatclaw_conversations');")"`,
		`if [ "$conversation_columns" != "id,kind,agent_id,team_id,title,runtime_thread_id,created_at,updated_at" ]; then`,
		`  sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`DROP TABLE IF EXISTS chatclaw_conversations;`,
		`CREATE TABLE chatclaw_conversations (`,
		`  id TEXT PRIMARY KEY,`,
		`  kind TEXT NOT NULL,`,
		`  agent_id TEXT NOT NULL DEFAULT '',`,
		`  team_id TEXT NOT NULL DEFAULT '',`,
		`  title TEXT NOT NULL,`,
		`  runtime_thread_id TEXT NOT NULL DEFAULT '',`,
		`  created_at INTEGER NOT NULL,`,
		`  updated_at INTEGER NOT NULL`,
		`);`,
		`SQL`,
		`fi`,
		`sqlite3 "$CHATCLAW_DB" <<SQL`,
		`.timeout 5000`,
		fmt.Sprintf(`INSERT OR IGNORE INTO chatclaw_agents (id, name, description, specialty, workspace_path, created_at, updated_at) VALUES ('main', 'Main', 'Primary ChatClaw agent', 'general', '%s/.openclaw/workspace', %d, %d);`, `${OPENCLAW_RUNTIME_HOME}`, nowUnix(), nowUnix()),
		`UPDATE chatclaw_agents`,
		`SET workspace_path = CASE`,
		`  WHEN id = 'main' THEN '$OPENCLAW_RUNTIME_HOME/.openclaw/workspace'`,
		`  ELSE '$OPENCLAW_RUNTIME_HOME/.openclaw/workspace-' || id`,
		`END`,
		`WHERE workspace_path = '' OR workspace_path IS NULL;`,
		fmt.Sprintf(`INSERT OR IGNORE INTO chatclaw_teams (id, name, description, agent_ids, created_at, updated_at) VALUES ('solo-team', 'Solo Team', 'Single-runtime collaboration shell', '["main"]', %d, %d);`, nowUnix(), nowUnix()),
		`SQL`,
	}, "\n")
}

func chatClawSnapshotCommand() string {
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`.mode tabs`,
		fmt.Sprintf(`SELECT '%s' || id || char(9) || hex(name) || char(9) || hex(description) || char(9) || specialty || char(9) || hex(workspace_path) || char(9) || created_at || char(9) || updated_at FROM chatclaw_agents ORDER BY created_at, id;`, chatClawSnapshotAgentPrefix),
		fmt.Sprintf(`SELECT '%s' || id || char(9) || hex(name) || char(9) || hex(description) || char(9) || hex(agent_ids) || char(9) || created_at || char(9) || updated_at FROM chatclaw_teams ORDER BY created_at, id;`, chatClawSnapshotTeamPrefix),
		fmt.Sprintf(`SELECT '%s' || id || char(9) || kind || char(9) || agent_id || char(9) || team_id || char(9) || hex(title) || char(9) || hex(runtime_thread_id) || char(9) || created_at || char(9) || updated_at FROM chatclaw_conversations ORDER BY updated_at DESC, created_at DESC, id;`, chatClawSnapshotConvPrefix),
		fmt.Sprintf(`SELECT '%s' || id || char(9) || store || char(9) || store_key || char(9) || owner_type || char(9) || owner_id || char(9) || agent_id || char(9) || conversation_id || char(9) || hex(file_name) || char(9) || hex(media_type) || char(9) || size_bytes || char(9) || hex(workspace_path) || char(9) || hex(relative_path) || char(9) || created_at || char(9) || updated_at FROM chatclaw_workspace_uploads ORDER BY updated_at DESC, created_at DESC, id;`, chatClawSnapshotUploadPrefix),
		`SQL`,
	}, "\n")
}

func chatClawCreateAgentCommand(id string, req *transport.CreateChatClawAgentRequest) string {
	now := nowUnix()
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		ensureChatClawRuntimeUserCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		fmt.Sprintf(`WORKSPACE_PATH="%s"`, strings.ReplaceAll(chatClawWorkspacePathForAgent(id), "$OPENCLAW_RUNTIME_HOME", `${OPENCLAW_RUNTIME_HOME}`)),
		`sqlite3 "$CHATCLAW_DB" <<SQL`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(
			`INSERT INTO chatclaw_agents (id, name, description, specialty, workspace_path, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %d, %d);`,
			sqlQuoteLiteral(id),
			sqlQuoteLiteral(strings.TrimSpace(req.Name)),
			sqlQuoteLiteral(strings.TrimSpace(req.Description)),
			sqlQuoteLiteral(strings.TrimSpace(req.Specialty)),
			`'$WORKSPACE_PATH'`,
			now,
			now,
		),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

func chatClawUpdateAgentCommand(agentID string, req *transport.UpdateChatClawAgentRequest) string {
	sets := make([]string, 0, 4)
	if req.Name != nil {
		sets = append(sets, "name = "+sqlQuoteLiteral(strings.TrimSpace(*req.Name)))
	}
	if req.Description != nil {
		sets = append(sets, "description = "+sqlQuoteLiteral(strings.TrimSpace(*req.Description)))
	}
	if req.Specialty != nil {
		sets = append(sets, "specialty = "+sqlQuoteLiteral(strings.TrimSpace(*req.Specialty)))
	}
	sets = append(sets, fmt.Sprintf("updated_at = %d", nowUnix()))

	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(`UPDATE chatclaw_agents SET %s WHERE id = %s;`, strings.Join(sets, ", "), sqlQuoteLiteral(agentID)),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

func chatClawDeleteAgentCommand(agentID string) string {
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(`DELETE FROM chatclaw_agents WHERE id = %s AND id <> 'main';`, sqlQuoteLiteral(agentID)),
		fmt.Sprintf(`UPDATE chatclaw_teams SET agent_ids = (SELECT json_group_array(value) FROM json_each(agent_ids) WHERE value <> %s) WHERE EXISTS (SELECT 1 FROM json_each(agent_ids) WHERE value = %s);`, sqlQuoteLiteral(agentID), sqlQuoteLiteral(agentID)),
		fmt.Sprintf(`DELETE FROM chatclaw_conversations WHERE kind = 'conversation' AND agent_id = %s;`, sqlQuoteLiteral(agentID)),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

func chatClawCreateTeamCommand(id string, req *transport.CreateChatClawTeamRequest) string {
	now := nowUnix()
	agentIDsJSON, _ := json.Marshal(req.AgentIDs)
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(
			`INSERT INTO chatclaw_teams (id, name, description, agent_ids, created_at, updated_at) VALUES (%s, %s, %s, %s, %d, %d);`,
			sqlQuoteLiteral(id),
			sqlQuoteLiteral(strings.TrimSpace(req.Name)),
			sqlQuoteLiteral(strings.TrimSpace(req.Description)),
			sqlQuoteLiteral(string(agentIDsJSON)),
			now,
			now,
		),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

func chatClawUpdateTeamCommand(teamID string, req *transport.UpdateChatClawTeamRequest) string {
	sets := make([]string, 0, 4)
	if req.Name != nil {
		sets = append(sets, "name = "+sqlQuoteLiteral(strings.TrimSpace(*req.Name)))
	}
	if req.Description != nil {
		sets = append(sets, "description = "+sqlQuoteLiteral(strings.TrimSpace(*req.Description)))
	}
	if req.AgentIDs != nil {
		agentIDsJSON, _ := json.Marshal(req.AgentIDs)
		sets = append(sets, "agent_ids = "+sqlQuoteLiteral(string(agentIDsJSON)))
	}
	sets = append(sets, fmt.Sprintf("updated_at = %d", nowUnix()))

	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(`UPDATE chatclaw_teams SET %s WHERE id = %s;`, strings.Join(sets, ", "), sqlQuoteLiteral(teamID)),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

func chatClawDeleteTeamCommand(teamID string) string {
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(`DELETE FROM chatclaw_teams WHERE id = %s AND id <> 'solo-team';`, sqlQuoteLiteral(teamID)),
		fmt.Sprintf(`DELETE FROM chatclaw_conversations WHERE kind = 'team_lane' AND team_id = %s;`, sqlQuoteLiteral(teamID)),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

func chatClawCreateConversationCommand(id string, req *transport.CreateChatClawConversationRequest) string {
	now := nowUnix()
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "New conversation"
	}
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(
			`INSERT INTO chatclaw_conversations (id, kind, agent_id, team_id, title, runtime_thread_id, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %d, %d);`,
			sqlQuoteLiteral(id),
			sqlQuoteLiteral(strings.TrimSpace(req.Kind)),
			sqlQuoteLiteral(strings.TrimSpace(req.AgentID)),
			sqlQuoteLiteral(strings.TrimSpace(req.TeamID)),
			sqlQuoteLiteral(title),
			"''",
			now,
			now,
		),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

func chatClawUpdateConversationCommand(conversationID string, req *transport.UpdateChatClawConversationRequest) string {
	sets := make([]string, 0, 4)
	if req.AgentID != nil {
		sets = append(sets, "agent_id = "+sqlQuoteLiteral(strings.TrimSpace(*req.AgentID)))
	}
	if req.Title != nil {
		title := strings.TrimSpace(*req.Title)
		if title == "" {
			title = "New conversation"
		}
		sets = append(sets, "title = "+sqlQuoteLiteral(title))
	}
	sets = append(sets, fmt.Sprintf("updated_at = %d", nowUnix()))
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(`UPDATE chatclaw_conversations SET %s WHERE id = %s;`, strings.Join(sets, ", "), sqlQuoteLiteral(conversationID)),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

func chatClawDeleteConversationCommand(conversationID string) string {
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(`DELETE FROM chatclaw_conversations WHERE id = %s;`, sqlQuoteLiteral(conversationID)),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

type resolvedChatClawUploadOwner struct {
	OwnerType     string
	OwnerID       string
	AgentID       string
	WorkspacePath string
}

func sanitizeWorkspaceUploadFilename(fileName string) string {
	trimmed := strings.TrimSpace(fileName)
	if trimmed == "" {
		return "file"
	}
	replacer := strings.NewReplacer("/", "-", "\\", "-", "\x00", "", "\n", "-", "\r", "-")
	sanitized := replacer.Replace(trimmed)
	if sanitized == "" {
		return "file"
	}
	return sanitized
}

func resolveChatClawUploadOwner(snapshot *chatClawSnapshot, ownerType, ownerID string) (*resolvedChatClawUploadOwner, error) {
	switch ownerType {
	case "agent":
		for _, agent := range snapshot.Agents {
			if agent.ID == ownerID {
				return &resolvedChatClawUploadOwner{
					OwnerType:     ownerType,
					OwnerID:       ownerID,
					AgentID:       agent.ID,
					WorkspacePath: agent.WorkspacePath,
				}, nil
			}
		}
	case "team":
		for _, team := range snapshot.Teams {
			if team.ID == ownerID {
				if len(team.AgentIDs) == 0 {
					return nil, errcode.ErrInstanceInvalidParam
				}
				primaryAgentID := team.AgentIDs[0]
				for _, agent := range snapshot.Agents {
					if agent.ID == primaryAgentID {
						return &resolvedChatClawUploadOwner{
							OwnerType:     ownerType,
							OwnerID:       ownerID,
							AgentID:       agent.ID,
							WorkspacePath: agent.WorkspacePath,
						}, nil
					}
				}
				return nil, errcode.ErrInstanceInvalidParam
			}
		}
	case "workspace":
		for _, agent := range snapshot.Agents {
			if agent.ID == "main" {
				return &resolvedChatClawUploadOwner{
					OwnerType:     ownerType,
					OwnerID:       ownerID,
					AgentID:       agent.ID,
					WorkspacePath: agent.WorkspacePath,
				}, nil
			}
		}
	}
	return nil, errcode.ErrInstanceInvalidParam
}

func chatClawWorkspaceUploadRelativePath(id, fileName string) string {
	safeName := sanitizeWorkspaceUploadFilename(fileName)
	return fmt.Sprintf("uploads/%s-%s", id, safeName)
}

func chatClawWriteWorkspaceUploadProcessRequest(resolved *resolvedChatClawUploadOwner, relativePath string, sizeBytes int64) *psandbox.ProcessStartRequest {
	targetPath := strings.TrimSuffix(resolved.WorkspacePath, "/") + "/" + strings.TrimPrefix(relativePath, "/")
	command := strings.Join([]string{
		fmt.Sprintf(`WORKSPACE_PATH=%s`, shellQuoteArg(resolved.WorkspacePath)),
		fmt.Sprintf(`TARGET_PATH=%s`, shellQuoteArg(targetPath)),
		`mkdir -p "$WORKSPACE_PATH/uploads"`,
		fmt.Sprintf(`head -c %d > "$TARGET_PATH"`, sizeBytes),
	}, "\n")
	return &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", command},
		Pty:  false,
	}
}

func chatClawInsertWorkspaceUploadMetadataCommand(id string, req *transport.UploadWorkspaceAttachmentRequest, resolved *resolvedChatClawUploadOwner, relativePath string, now int64) string {
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`BEGIN IMMEDIATE;`,
		fmt.Sprintf(
			`INSERT INTO chatclaw_workspace_uploads (id, store, store_key, owner_type, owner_id, agent_id, conversation_id, file_name, media_type, size_bytes, workspace_path, relative_path, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %d, %s, %s, %d, %d);`,
			sqlQuoteLiteral(id),
			sqlQuoteLiteral(chatClawWorkspaceUploadStore),
			sqlQuoteLiteral(id),
			sqlQuoteLiteral(resolved.OwnerType),
			sqlQuoteLiteral(resolved.OwnerID),
			sqlQuoteLiteral(resolved.AgentID),
			sqlQuoteLiteral(strings.TrimSpace(req.ConversationID)),
			sqlQuoteLiteral(strings.TrimSpace(req.FileName)),
			sqlQuoteLiteral(strings.TrimSpace(req.MediaType)),
			req.SizeBytes,
			sqlQuoteLiteral(resolved.WorkspacePath),
			sqlQuoteLiteral(relativePath),
			now,
			now,
		),
		`COMMIT;`,
		`SQL`,
	}, "\n")
}

func chatClawWorkspaceUploadsQuery(uploadID, ownerType, ownerID, conversationID string, limit int) string {
	clauses := []string{"1=1"}
	if uploadID != "" {
		clauses = append(clauses, "id = "+sqlQuoteLiteral(uploadID))
	}
	if ownerType != "" {
		clauses = append(clauses, "owner_type = "+sqlQuoteLiteral(ownerType))
	}
	if ownerID != "" {
		clauses = append(clauses, "owner_id = "+sqlQuoteLiteral(ownerID))
	}
	if conversationID != "" {
		clauses = append(clauses, "conversation_id = "+sqlQuoteLiteral(conversationID))
	}
	if limit <= 0 {
		limit = 50
	}
	return fmt.Sprintf(`SELECT '%s' || id || char(9) || store || char(9) || store_key || char(9) || owner_type || char(9) || owner_id || char(9) || agent_id || char(9) || conversation_id || char(9) || hex(file_name) || char(9) || hex(media_type) || char(9) || size_bytes || char(9) || hex(workspace_path) || char(9) || hex(relative_path) || char(9) || created_at || char(9) || updated_at FROM chatclaw_workspace_uploads WHERE %s ORDER BY updated_at DESC, created_at DESC, id LIMIT %d;`, chatClawSnapshotUploadPrefix, strings.Join(clauses, " AND "), limit)
}

func chatClawListWorkspaceUploadsCommand(req *transport.ListWorkspaceUploadsRequest) string {
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`.mode tabs`,
		chatClawWorkspaceUploadsQuery("", strings.TrimSpace(req.OwnerType), strings.TrimSpace(req.OwnerID), strings.TrimSpace(req.ConversationID), req.Limit),
		`SQL`,
	}, "\n")
}

func chatClawGetWorkspaceUploadCommand(uploadID string) string {
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`sqlite3 "$CHATCLAW_DB" <<'SQL'`,
		`.timeout 5000`,
		`.mode tabs`,
		chatClawWorkspaceUploadsQuery(strings.TrimSpace(uploadID), "", "", "", 1),
		`SQL`,
	}, "\n")
}

func chatClawReadWorkspaceUploadContentCommand(upload *chatClawWorkspaceUploadRow) string {
	return strings.Join([]string{
		fmt.Sprintf(`TARGET_PATH=%s`, shellQuoteArg(strings.TrimSuffix(upload.WorkspacePath, "/")+"/"+strings.TrimPrefix(upload.RelativePath, "/"))),
		`if [ ! -f "$TARGET_PATH" ]; then echo "missing upload file" >&2; exit 1; fi`,
		`base64 < "$TARGET_PATH" | tr -d '\n'`,
	}, "\n")
}

func chatClawProjectionCommand() string {
	// Rebuild derived OpenClaw config/workspace state from SQLite truth.
	return strings.Join([]string{
		ensureChatClawSchemaCommand(),
		ensureChatClawRuntimeUserCommand(),
		fmt.Sprintf(`CHATCLAW_DB=%s`, shellQuoteArg(chatClawDBPath)),
		`OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_RUNTIME_HOME/.openclaw/openclaw.json}"`,
		`mkdir -p "$(dirname "$OPENCLAW_CONFIG_PATH")"`,
		`NODE_SCRIPT="$(mktemp /tmp/chatclaw-projection-XXXXXX.js)"`,
		`cat <<'NODE' > "$NODE_SCRIPT"`,
		`const fs = require("fs");`,
		`const path = require("path");`,
		`const configPath = process.argv[2];`,
		`const runtimeHome = process.argv[3] || process.env.HOME || "";`,
		`const rows = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map((line) => {`,
		`  const [id, nameHex, descriptionHex, specialty, workspacePathHex] = line.split("\t");`,
		`  const decode = (hex) => hex ? Buffer.from(hex, "hex").toString("utf8") : "";`,
		`  return { id, name: decode(nameHex), description: decode(descriptionHex), specialty, workspacePath: decode(workspacePathHex) };`,
		`});`,
		`let config = {};`,
		`let changed = false;`,
		`const writeIfChanged = (filePath, nextContent) => {`,
		`  const normalizedNext = nextContent.endsWith("\n") ? nextContent : nextContent + "\n";`,
		`  let previous = null;`,
		`  try { if (fs.existsSync(filePath)) previous = fs.readFileSync(filePath, "utf8"); } catch (_) { previous = null; }`,
		`  if (previous !== normalizedNext) {`,
		`    fs.writeFileSync(filePath, normalizedNext);`,
		`    changed = true;`,
		`  }`,
		`};`,
		`try {`,
		`  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, "utf8"));`,
		`} catch (_) { config = {}; }`,
		`if (!config.agents || typeof config.agents !== "object") config.agents = {};`,
		`if (!config.gateway || typeof config.gateway !== "object") config.gateway = {};`,
		`if (!config.gateway.controlUi || typeof config.gateway.controlUi !== "object") config.gateway.controlUi = {};`,
		`if (!config.gateway.auth || typeof config.gateway.auth !== "object") config.gateway.auth = {};`,
		`if (!config.gateway.auth.trustedProxy || typeof config.gateway.auth.trustedProxy !== "object") config.gateway.auth.trustedProxy = {};`,
		`config.agents.list = rows.map((agent) => ({`,
		`  id: agent.id,`,
		`  name: agent.name || agent.id,`,
		`  workspace: agent.workspacePath || (agent.id === "main" ? "~/.openclaw/workspace" : ` + "`~/.openclaw/workspace-${agent.id}`" + `),`,
		`}));`,
		`config.gateway.port = typeof config.gateway.port === "number" && config.gateway.port > 0 ? config.gateway.port : 18789;`,
		`config.gateway.mode = "local";`,
		`config.gateway.bind = "lan";`,
		`config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;`,
		`config.gateway.controlUi.allowedOrigins = ["*"];`,
		`config.gateway.auth.mode = "trusted-proxy";`,
		`config.gateway.auth.token = typeof config.gateway.auth.token === "string" ? config.gateway.auth.token : "";`,
		`config.gateway.auth.trustedProxy.userHeader = "Host";`,
		`config.gateway.trustedProxies = ["0.0.0.0/0"];`,
		`const nextConfig = JSON.stringify(config, null, 2) + "\n";`,
		`let previousConfig = null;`,
		`try { if (fs.existsSync(configPath)) previousConfig = fs.readFileSync(configPath, "utf8"); } catch (_) { previousConfig = null; }`,
		`if (previousConfig !== nextConfig) {`,
		`  fs.writeFileSync(configPath, nextConfig);`,
		`  changed = true;`,
		`}`,
		`for (const agent of rows) {`,
		`  const workspaceDir = agent.workspacePath || (agent.id === "main" ? path.join(runtimeHome, ".openclaw", "workspace") : path.join(runtimeHome, ".openclaw", ` + "`workspace-${agent.id}`" + `));`,
		`  fs.mkdirSync(workspaceDir, { recursive: true });`,
		`  const soul = ['# Soul of ' + agent.name, '', 'I am ' + agent.name + ', an AI agent.', '', '## Personality', '', agent.description || 'A helpful AI assistant.'].join('\n');`,
		`  const identity = ['# ' + agent.name, '', '## Role', agent.specialty || 'general', '', '## Description', agent.description || 'I am ready to help.'].join('\n');`,
		`  writeIfChanged(path.join(workspaceDir, 'SOUL.md'), soul);`,
		`  writeIfChanged(path.join(workspaceDir, 'IDENTITY.md'), identity);`,
		`  for (const file of ['AGENTS.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md']) {`,
		`    const filePath = path.join(workspaceDir, file);`,
		`    if (!fs.existsSync(filePath)) { fs.writeFileSync(filePath, ''); changed = true; }`,
		`  }`,
		`}`,
		`console.log(changed ? '` + chatClawProjectionChangedPrefix + `' : '` + chatClawProjectionNoopPrefix + `');`,
		`NODE`,
		`chmod 644 "$NODE_SCRIPT"`,
		`sqlite3 -tabs "$CHATCLAW_DB" "SELECT id, hex(name), hex(description), specialty, hex(workspace_path) FROM chatclaw_agents ORDER BY created_at, id;" | sudo -u "$OPENCLAW_RUNTIME_USER" HOME="$OPENCLAW_RUNTIME_HOME" node "$NODE_SCRIPT" "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_RUNTIME_HOME"`,
		`status=$?`,
		`rm -f "$NODE_SCRIPT"`,
		`if [ $status -ne 0 ]; then printf '` + chatClawProjectionErrorPrefix + `\n'; exit 1; fi`,
		`printf '` + chatClawProjectionOKPrefix + `\n'`,
	}, "\n")
}

func chatClawGatewayRestartCommand() string {
	return strings.Join([]string{
		ensureChatClawRuntimeUserCommand(),
		`if [ -z "$OPENCLAW_RUNTIME_UID" ]; then echo "missing runtime uid" >&2; exit 1; fi`,
		`sudo -u "$OPENCLAW_RUNTIME_USER" XDG_RUNTIME_DIR="/run/user/$OPENCLAW_RUNTIME_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$OPENCLAW_RUNTIME_UID/bus" systemctl --user restart openclaw-gateway.service`,
	}, "\n")
}

func parseChatClawSnapshotOutput(output string) (*chatClawSnapshot, error) {
	lines := strings.Split(output, "\n")
	snapshot := &chatClawSnapshot{}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		switch {
		case strings.HasPrefix(trimmed, chatClawSnapshotAgentPrefix):
			fields := strings.Split(strings.TrimPrefix(trimmed, chatClawSnapshotAgentPrefix), "\t")
			if len(fields) != 7 {
				return nil, fmt.Errorf("invalid agent snapshot row")
			}
			name, err := sqlHexDecode(fields[1])
			if err != nil {
				return nil, err
			}
			description, err := sqlHexDecode(fields[2])
			if err != nil {
				return nil, err
			}
			workspacePath, err := sqlHexDecode(fields[4])
			if err != nil {
				return nil, err
			}
			createdAt, err := parseUnixField(fields[5])
			if err != nil {
				return nil, err
			}
			updatedAt, err := parseUnixField(fields[6])
			if err != nil {
				return nil, err
			}
			snapshot.Agents = append(snapshot.Agents, chatClawAgentRow{
				ID:            fields[0],
				Name:          name,
				Description:   description,
				Specialty:     fields[3],
				WorkspacePath: workspacePath,
				CreatedAt:     createdAt,
				UpdatedAt:     updatedAt,
			})
		case strings.HasPrefix(trimmed, chatClawSnapshotTeamPrefix):
			fields := strings.Split(strings.TrimPrefix(trimmed, chatClawSnapshotTeamPrefix), "\t")
			if len(fields) != 6 {
				return nil, fmt.Errorf("invalid team snapshot row")
			}
			name, err := sqlHexDecode(fields[1])
			if err != nil {
				return nil, err
			}
			description, err := sqlHexDecode(fields[2])
			if err != nil {
				return nil, err
			}
			agentIDsJSON, err := sqlHexDecode(fields[3])
			if err != nil {
				return nil, err
			}
			var agentIDs []string
			if strings.TrimSpace(agentIDsJSON) != "" {
				if err := json.Unmarshal([]byte(agentIDsJSON), &agentIDs); err != nil {
					return nil, err
				}
			}
			createdAt, err := parseUnixField(fields[4])
			if err != nil {
				return nil, err
			}
			updatedAt, err := parseUnixField(fields[5])
			if err != nil {
				return nil, err
			}
			snapshot.Teams = append(snapshot.Teams, chatClawTeamRow{
				ID:          fields[0],
				Name:        name,
				Description: description,
				AgentIDs:    agentIDs,
				CreatedAt:   createdAt,
				UpdatedAt:   updatedAt,
			})
		case strings.HasPrefix(trimmed, chatClawSnapshotConvPrefix):
			fields := strings.Split(strings.TrimPrefix(trimmed, chatClawSnapshotConvPrefix), "\t")
			if len(fields) != 8 {
				return nil, fmt.Errorf("invalid conversation snapshot row")
			}
			title, err := sqlHexDecode(fields[4])
			if err != nil {
				return nil, err
			}
			runtimeThreadID, err := sqlHexDecode(fields[5])
			if err != nil {
				return nil, err
			}
			createdAt, err := parseUnixField(fields[6])
			if err != nil {
				return nil, err
			}
			updatedAt, err := parseUnixField(fields[7])
			if err != nil {
				return nil, err
			}
			snapshot.Conversations = append(snapshot.Conversations, chatClawConversationRow{
				ID:              fields[0],
				Kind:            fields[1],
				AgentID:         fields[2],
				TeamID:          fields[3],
				Title:           title,
				RuntimeThreadID: runtimeThreadID,
				CreatedAt:       createdAt,
				UpdatedAt:       updatedAt,
			})
		case strings.HasPrefix(trimmed, chatClawSnapshotUploadPrefix):
			fields := strings.Split(strings.TrimPrefix(trimmed, chatClawSnapshotUploadPrefix), "\t")
			if len(fields) != 14 {
				return nil, fmt.Errorf("invalid workspace upload snapshot row")
			}
			fileName, err := sqlHexDecode(fields[7])
			if err != nil {
				return nil, err
			}
			mediaType, err := sqlHexDecode(fields[8])
			if err != nil {
				return nil, err
			}
			sizeBytes, err := parseUnixField(fields[9])
			if err != nil {
				return nil, err
			}
			workspacePath, err := sqlHexDecode(fields[10])
			if err != nil {
				return nil, err
			}
			relativePath, err := sqlHexDecode(fields[11])
			if err != nil {
				return nil, err
			}
			createdAt, err := parseUnixField(fields[12])
			if err != nil {
				return nil, err
			}
			updatedAt, err := parseUnixField(fields[13])
			if err != nil {
				return nil, err
			}
			snapshot.Uploads = append(snapshot.Uploads, chatClawWorkspaceUploadRow{
				ID:             fields[0],
				Store:          fields[1],
				StoreKey:       fields[2],
				OwnerType:      fields[3],
				OwnerID:        fields[4],
				AgentID:        fields[5],
				ConversationID: fields[6],
				FileName:       fileName,
				MediaType:      mediaType,
				SizeBytes:      sizeBytes,
				WorkspacePath:  workspacePath,
				RelativePath:   relativePath,
				CreatedAt:      createdAt,
				UpdatedAt:      updatedAt,
			})
		}
	}
	return snapshot, nil
}

func parseUnixField(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	return strconv.ParseInt(value, 10, 64)
}

func asTime(v int64) time.Time {
	if v <= 0 {
		return time.Unix(0, 0).UTC()
	}
	return time.Unix(v, 0).UTC()
}

func (l *logic) execChatClawSQLiteCommand(ctx pctx.Context, sandboxID, commandKind, bash string) (string, error) {
	result, err := l.execSandboxProcessCommand(ctx, sandboxID, commandKind, &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", bash},
		Pty:  false,
	}, chatClawSQLiteTimeoutSec)
	if err != nil {
		return "", err
	}
	if !sandboxCommandSucceeded(result) {
		return "", errcode.Wrap(errcode.ErrDebugExecFailed, "%s", sandboxCommandFailureDetail(result))
	}
	return result.Output, nil
}

func (l *logic) getChatClawSnapshot(ctx pctx.Context, sandboxID string) (*chatClawSnapshot, error) {
	output, err := l.execChatClawSQLiteCommand(ctx, sandboxID, "chatclaw_state_read", chatClawSnapshotCommand())
	if err != nil {
		return nil, err
	}
	return parseChatClawSnapshotOutput(output)
}

func (l *logic) reconcileChatClawDerivedState(ctx pctx.Context, sandboxID string) error {
	output, err := l.execChatClawSQLiteCommand(ctx, sandboxID, "chatclaw_projection_sync", chatClawProjectionCommand())
	if err != nil {
		return err
	}
	if strings.Contains(output, chatClawProjectionErrorPrefix) {
		return errcode.Wrap(errcode.ErrDebugExecFailed, "chatclaw projection failed")
	}
	if strings.Contains(output, chatClawProjectionChangedPrefix) {
		restartResult, restartErr := l.execSandboxProcessCommand(ctx, sandboxID, "chatclaw_gateway_restart", &psandbox.ProcessStartRequest{
			Cmd:  "/bin/bash",
			Args: []string{"-l", "-c", chatClawGatewayRestartCommand()},
			Pty:  false,
		}, chatClawSQLiteTimeoutSec)
		if restartErr != nil {
			return errcode.Wrap(errcode.ErrDebugExecFailed, "chatclaw gateway restart: %v", restartErr)
		}
		if !sandboxCommandSucceeded(restartResult) {
			return errcode.Wrap(errcode.ErrDebugExecFailed, "chatclaw gateway restart %s", sandboxCommandFailureDetail(restartResult))
		}
	}
	return nil
}

func mapChatClawState(snapshot *chatClawSnapshot) *transport.ChatClawStateResponse {
	resp := &transport.ChatClawStateResponse{
		Agents:        make([]*transport.ChatClawAgentResponse, 0, len(snapshot.Agents)),
		Teams:         make([]*transport.ChatClawTeamResponse, 0, len(snapshot.Teams)),
		Conversations: make([]*transport.ChatClawConversationResponse, 0, len(snapshot.Conversations)),
	}
	for _, agent := range snapshot.Agents {
		resp.Agents = append(resp.Agents, &transport.ChatClawAgentResponse{
			ID:            agent.ID,
			Name:          agent.Name,
			Description:   agent.Description,
			Specialty:     agent.Specialty,
			WorkspacePath: agent.WorkspacePath,
			CreatedAt:     asTime(agent.CreatedAt),
			UpdatedAt:     asTime(agent.UpdatedAt),
		})
	}
	for _, team := range snapshot.Teams {
		resp.Teams = append(resp.Teams, &transport.ChatClawTeamResponse{
			ID:          team.ID,
			Name:        team.Name,
			Description: team.Description,
			AgentIDs:    team.AgentIDs,
			CreatedAt:   asTime(team.CreatedAt),
			UpdatedAt:   asTime(team.UpdatedAt),
		})
	}
	for _, conversation := range snapshot.Conversations {
		resp.Conversations = append(resp.Conversations, &transport.ChatClawConversationResponse{
			ID:        conversation.ID,
			Kind:      conversation.Kind,
			AgentID:   conversation.AgentID,
			TeamID:    conversation.TeamID,
			Title:     conversation.Title,
			CreatedAt: asTime(conversation.CreatedAt),
			UpdatedAt: asTime(conversation.UpdatedAt),
		})
	}
	return resp
}

func (l *logic) GetChatClawState(ctx pctx.Context, instanceID string) (*transport.ChatClawStateResponse, error) {
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	return mapChatClawState(snapshot), nil
}

func (l *logic) SyncChatClawState(ctx pctx.Context, instanceID string) (*transport.ChatClawStateResponse, error) {
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if err := l.reconcileChatClawDerivedState(ctx, entity.SandboxId); err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	return mapChatClawState(snapshot), nil
}

func (l *logic) CreateChatClawAgent(ctx pctx.Context, instanceID string, req *transport.CreateChatClawAgentRequest) (*transport.ChatClawAgentResponse, error) {
	if req == nil || strings.TrimSpace(req.Name) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	specialty, ok := normalizeChatClawSpecialty(req.Specialty)
	if !ok {
		return nil, errcode.ErrInstanceInvalidParam
	}
	req.Specialty = specialty
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	agentID := generateChatClawEntityID("agent")
	if _, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_agent_create", chatClawCreateAgentCommand(agentID, req)); err != nil {
		return nil, err
	}
	if err := l.reconcileChatClawDerivedState(ctx, entity.SandboxId); err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	for _, agent := range snapshot.Agents {
		if agent.ID == agentID {
			return &transport.ChatClawAgentResponse{
				ID:            agent.ID,
				Name:          agent.Name,
				Description:   agent.Description,
				Specialty:     agent.Specialty,
				WorkspacePath: agent.WorkspacePath,
				CreatedAt:     asTime(agent.CreatedAt),
				UpdatedAt:     asTime(agent.UpdatedAt),
			}, nil
		}
	}
	return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "created agent missing from snapshot")
}

func (l *logic) UpdateChatClawAgent(ctx pctx.Context, instanceID, agentID string, req *transport.UpdateChatClawAgentRequest) (*transport.ChatClawAgentResponse, error) {
	if req == nil || strings.TrimSpace(agentID) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	if req.Specialty != nil {
		specialty, ok := normalizeChatClawSpecialty(*req.Specialty)
		if !ok {
			return nil, errcode.ErrInstanceInvalidParam
		}
		req.Specialty = &specialty
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if _, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_agent_update", chatClawUpdateAgentCommand(agentID, req)); err != nil {
		return nil, err
	}
	if err := l.reconcileChatClawDerivedState(ctx, entity.SandboxId); err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	for _, agent := range snapshot.Agents {
		if agent.ID == agentID {
			return &transport.ChatClawAgentResponse{
				ID:            agent.ID,
				Name:          agent.Name,
				Description:   agent.Description,
				Specialty:     agent.Specialty,
				WorkspacePath: agent.WorkspacePath,
				CreatedAt:     asTime(agent.CreatedAt),
				UpdatedAt:     asTime(agent.UpdatedAt),
			}, nil
		}
	}
	return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "updated agent missing from snapshot")
}

func (l *logic) DeleteChatClawAgent(ctx pctx.Context, instanceID, agentID string) error {
	if strings.TrimSpace(agentID) == "" || agentID == "main" {
		return errcode.ErrInstanceInvalidParam
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return err
	}
	if _, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_agent_delete", chatClawDeleteAgentCommand(agentID)); err != nil {
		return err
	}
	return l.reconcileChatClawDerivedState(ctx, entity.SandboxId)
}

func (l *logic) CreateChatClawTeam(ctx pctx.Context, instanceID string, req *transport.CreateChatClawTeamRequest) (*transport.ChatClawTeamResponse, error) {
	if req == nil || strings.TrimSpace(req.Name) == "" || len(req.AgentIDs) == 0 {
		return nil, errcode.ErrInstanceInvalidParam
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	teamID := generateChatClawEntityID("team")
	if _, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_team_create", chatClawCreateTeamCommand(teamID, req)); err != nil {
		return nil, err
	}
	if err := l.reconcileChatClawDerivedState(ctx, entity.SandboxId); err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	for _, team := range snapshot.Teams {
		if team.ID == teamID {
			return &transport.ChatClawTeamResponse{
				ID:          team.ID,
				Name:        team.Name,
				Description: team.Description,
				AgentIDs:    team.AgentIDs,
				CreatedAt:   asTime(team.CreatedAt),
				UpdatedAt:   asTime(team.UpdatedAt),
			}, nil
		}
	}
	return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "created team missing from snapshot")
}

func (l *logic) UpdateChatClawTeam(ctx pctx.Context, instanceID, teamID string, req *transport.UpdateChatClawTeamRequest) (*transport.ChatClawTeamResponse, error) {
	if req == nil || strings.TrimSpace(teamID) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if _, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_team_update", chatClawUpdateTeamCommand(teamID, req)); err != nil {
		return nil, err
	}
	if err := l.reconcileChatClawDerivedState(ctx, entity.SandboxId); err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	for _, team := range snapshot.Teams {
		if team.ID == teamID {
			return &transport.ChatClawTeamResponse{
				ID:          team.ID,
				Name:        team.Name,
				Description: team.Description,
				AgentIDs:    team.AgentIDs,
				CreatedAt:   asTime(team.CreatedAt),
				UpdatedAt:   asTime(team.UpdatedAt),
			}, nil
		}
	}
	return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "updated team missing from snapshot")
}

func (l *logic) DeleteChatClawTeam(ctx pctx.Context, instanceID, teamID string) error {
	if strings.TrimSpace(teamID) == "" || teamID == "solo-team" {
		return errcode.ErrInstanceInvalidParam
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return err
	}
	if _, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_team_delete", chatClawDeleteTeamCommand(teamID)); err != nil {
		return err
	}
	return l.reconcileChatClawDerivedState(ctx, entity.SandboxId)
}

func (l *logic) CreateChatClawConversation(ctx pctx.Context, instanceID string, req *transport.CreateChatClawConversationRequest) (*transport.ChatClawConversationResponse, error) {
	if req == nil {
		return nil, errcode.ErrInstanceInvalidParam
	}
	kind, ok := normalizeChatClawConversationKind(req.Kind)
	if !ok {
		return nil, errcode.ErrInstanceInvalidParam
	}
	req.Kind = kind
	req.AgentID = strings.TrimSpace(req.AgentID)
	req.TeamID = strings.TrimSpace(req.TeamID)
	switch req.Kind {
	case "conversation":
		if req.AgentID == "" || req.TeamID != "" {
			return nil, errcode.ErrInstanceInvalidParam
		}
	case "team_lane":
		if req.TeamID == "" || req.AgentID != "" {
			return nil, errcode.ErrInstanceInvalidParam
		}
	default:
		return nil, errcode.ErrInstanceInvalidParam
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	conversationID := generateChatClawEntityID("conv")
	if _, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_conversation_create", chatClawCreateConversationCommand(conversationID, req)); err != nil {
		return nil, err
	}
	if err := l.reconcileChatClawDerivedState(ctx, entity.SandboxId); err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	for _, conversation := range snapshot.Conversations {
			if conversation.ID == conversationID {
				return &transport.ChatClawConversationResponse{
					ID:        conversation.ID,
					Kind:      conversation.Kind,
					AgentID:   conversation.AgentID,
					TeamID:    conversation.TeamID,
					Title:     conversation.Title,
					CreatedAt: asTime(conversation.CreatedAt),
					UpdatedAt: asTime(conversation.UpdatedAt),
				}, nil
			}
	}
	return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "created conversation missing from snapshot")
}

func (l *logic) UpdateChatClawConversation(ctx pctx.Context, instanceID, conversationID string, req *transport.UpdateChatClawConversationRequest) (*transport.ChatClawConversationResponse, error) {
	if req == nil || strings.TrimSpace(conversationID) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	var existing *chatClawConversationRow
	for i := range snapshot.Conversations {
		if snapshot.Conversations[i].ID == conversationID {
			existing = &snapshot.Conversations[i]
			break
		}
	}
	if existing == nil {
		return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "updated conversation missing from snapshot")
	}
	if req.AgentID != nil {
		trimmed := strings.TrimSpace(*req.AgentID)
		if existing.Kind != "conversation" || trimmed == "" {
			return nil, errcode.ErrInstanceInvalidParam
		}
		req.AgentID = &trimmed
	}
	if _, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_conversation_update", chatClawUpdateConversationCommand(conversationID, req)); err != nil {
		return nil, err
	}
	if err := l.reconcileChatClawDerivedState(ctx, entity.SandboxId); err != nil {
		return nil, err
	}
	snapshot, err = l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	for _, conversation := range snapshot.Conversations {
			if conversation.ID == conversationID {
				return &transport.ChatClawConversationResponse{
					ID:        conversation.ID,
					Kind:      conversation.Kind,
					AgentID:   conversation.AgentID,
					TeamID:    conversation.TeamID,
					Title:     conversation.Title,
					CreatedAt: asTime(conversation.CreatedAt),
					UpdatedAt: asTime(conversation.UpdatedAt),
				}, nil
			}
	}
	return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "updated conversation missing from snapshot")
}

func (l *logic) DeleteChatClawConversation(ctx pctx.Context, instanceID, conversationID string) error {
	if strings.TrimSpace(conversationID) == "" {
		return errcode.ErrInstanceInvalidParam
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return err
	}
	if _, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_conversation_delete", chatClawDeleteConversationCommand(conversationID)); err != nil {
		return err
	}
	return l.reconcileChatClawDerivedState(ctx, entity.SandboxId)
}

func buildChatClawGatewayURL(sandboxID string) string {
	return fmt.Sprintf("wss://18789-%s.sandbox.lightclaw.tech", strings.TrimSpace(sandboxID))
}

func buildChatClawSessionID(instanceID, sessionKey string) string {
	hashPart := func(value string) string {
		hasher := fnv.New64a()
		_, _ = hasher.Write([]byte(value))
		return fmt.Sprintf("%016x", hasher.Sum64())
	}
	return fmt.Sprintf("ses_%s_%s", hashPart(instanceID), hashPart(sessionKey))
}

func (l *logic) GetChatClawRuntimeBootstrap(ctx pctx.Context, instanceID, conversationID string) (*transport.ChatClawRuntimeBootstrapResponse, error) {
	if strings.TrimSpace(conversationID) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	var conversation *chatClawConversationRow
	for i := range snapshot.Conversations {
		if snapshot.Conversations[i].ID == conversationID {
			conversation = &snapshot.Conversations[i]
			break
		}
	}
	if conversation == nil {
		return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "conversation missing from snapshot")
	}
	teamAgentIDs := make([]string, 0)
	if conversation.Kind == "team_lane" {
		for _, team := range snapshot.Teams {
			if team.ID == conversation.TeamID {
				teamAgentIDs = append(teamAgentIDs, team.AgentIDs...)
				break
			}
		}
	}

	upstreamSessionKey := strings.TrimSpace(conversation.RuntimeThreadID)
	if upstreamSessionKey == "" {
		if conversation.Kind == "conversation" {
			agentID := strings.TrimSpace(conversation.AgentID)
			if agentID == "" {
				agentID = "main"
			}
			upstreamSessionKey = fmt.Sprintf("agent:%s:chatclaw:%s", agentID, conversation.ID)
		} else {
			upstreamSessionKey = fmt.Sprintf("chatclaw:%s", conversation.ID)
		}
	}
	gatewayToken := strings.TrimSpace(entity.GatewayAuthToken)
	if gatewayToken == "" {
		return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "gateway auth token is empty")
	}

	return &transport.ChatClawRuntimeBootstrapResponse{
		UserID:             entity.UserId,
		InstanceID:         entity.InstanceId,
		ConversationID:     conversation.ID,
		ConversationKind:   conversation.Kind,
		AgentID:            conversation.AgentID,
		TeamID:             conversation.TeamID,
		TeamAgentIDs:       teamAgentIDs,
		SessionID:          buildChatClawSessionID(entity.InstanceId, conversation.ID),
		SessionTitle:       conversation.Title,
		UpstreamSessionKey: upstreamSessionKey,
		GatewayURL:         buildChatClawGatewayURL(entity.SandboxId),
		GatewayToken:       gatewayToken,
	}, nil
}

func mapWorkspaceUpload(row chatClawWorkspaceUploadRow, instanceID string) *transport.WorkspaceUploadResponse {
	return &transport.WorkspaceUploadResponse{
		ID:             row.ID,
		Store:          row.Store,
		StoreKey:       row.StoreKey,
		OwnerType:      row.OwnerType,
		OwnerID:        row.OwnerID,
		AgentID:        row.AgentID,
		ConversationID: row.ConversationID,
		FileName:       row.FileName,
		MediaType:      row.MediaType,
		SizeBytes:      row.SizeBytes,
		WorkspacePath:  row.WorkspacePath,
		RelativePath:   row.RelativePath,
		ContentURL:     fmt.Sprintf("/v1/instances/%s/workspace/uploads/%s/content", instanceID, row.ID),
		CreatedAt:      asTime(row.CreatedAt),
		UpdatedAt:      asTime(row.UpdatedAt),
	}
}

func (l *logic) UploadWorkspaceAttachment(ctx pctx.Context, instanceID string, req *transport.UploadWorkspaceAttachmentRequest) (*transport.WorkspaceUploadResponse, error) {
	if req == nil || len(req.Content) == 0 || strings.TrimSpace(req.FileName) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	ownerType, ok := normalizeChatClawUploadOwnerType(req.OwnerType)
	if !ok {
		return nil, errcode.ErrInstanceInvalidParam
	}
	req.OwnerType = ownerType
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	snapshot, err := l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveChatClawUploadOwner(snapshot, req.OwnerType, strings.TrimSpace(req.OwnerID))
	if err != nil {
		return nil, err
	}
	uploadID := generateChatClawEntityID("upload")
	relativePath := chatClawWorkspaceUploadRelativePath(uploadID, req.FileName)
	writeResult, err := l.execSandboxProcessCommandWithStdin(
		ctx,
		entity.SandboxId,
		"chatclaw_workspace_upload_write",
		chatClawWriteWorkspaceUploadProcessRequest(resolved, relativePath, req.SizeBytes),
		req.Content,
		workspaceFilesTimeoutSec,
	)
	if err != nil {
		if writeResult != nil && !sandboxCommandSucceeded(writeResult) {
			return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "%s", sandboxCommandFailureDetail(writeResult))
		}
		return nil, err
	}
	if !sandboxCommandSucceeded(writeResult) {
		return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "%s", sandboxCommandFailureDetail(writeResult))
	}
	now := nowUnix()
	if _, err := l.execChatClawSQLiteCommand(
		ctx,
		entity.SandboxId,
		"chatclaw_workspace_upload_metadata_create",
		chatClawInsertWorkspaceUploadMetadataCommand(uploadID, req, resolved, relativePath, now),
	); err != nil {
		return nil, err
	}
	snapshot, err = l.getChatClawSnapshot(ctx, entity.SandboxId)
	if err != nil {
		return nil, err
	}
	for _, upload := range snapshot.Uploads {
		if upload.ID == uploadID {
			return mapWorkspaceUpload(upload, instanceID), nil
		}
	}
	return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "created upload missing from snapshot")
}

func (l *logic) ListWorkspaceUploads(ctx pctx.Context, instanceID string, req *transport.ListWorkspaceUploadsRequest) (*transport.WorkspaceUploadsResponse, error) {
	if req == nil {
		req = &transport.ListWorkspaceUploadsRequest{}
	}
	if req.OwnerType != "" {
		ownerType, ok := normalizeChatClawUploadOwnerType(req.OwnerType)
		if !ok {
			return nil, errcode.ErrInstanceInvalidParam
		}
		req.OwnerType = ownerType
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	output, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_workspace_upload_list", chatClawListWorkspaceUploadsCommand(req))
	if err != nil {
		return nil, err
	}
	snapshot, err := parseChatClawSnapshotOutput(output)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "%v", err)
	}
	resp := &transport.WorkspaceUploadsResponse{
		Items: make([]*transport.WorkspaceUploadResponse, 0, len(snapshot.Uploads)),
	}
	for _, upload := range snapshot.Uploads {
		resp.Items = append(resp.Items, mapWorkspaceUpload(upload, instanceID))
	}
	return resp, nil
}

func (l *logic) GetWorkspaceUpload(ctx pctx.Context, instanceID, uploadID string) (*transport.WorkspaceUploadResponse, error) {
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	output, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_workspace_upload_get", chatClawGetWorkspaceUploadCommand(uploadID))
	if err != nil {
		return nil, err
	}
	snapshot, err := parseChatClawSnapshotOutput(output)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "%v", err)
	}
	if len(snapshot.Uploads) == 0 {
		return nil, errcode.ErrInstanceInvalidParam
	}
	return mapWorkspaceUpload(snapshot.Uploads[0], instanceID), nil
}

func (l *logic) GetWorkspaceUploadContent(ctx pctx.Context, instanceID, uploadID string) (*transport.WorkspaceUploadResponse, []byte, error) {
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, nil, err
	}
	output, err := l.execChatClawSQLiteCommand(ctx, entity.SandboxId, "chatclaw_workspace_upload_get", chatClawGetWorkspaceUploadCommand(uploadID))
	if err != nil {
		return nil, nil, err
	}
	snapshot, err := parseChatClawSnapshotOutput(output)
	if err != nil {
		return nil, nil, errcode.Wrap(errcode.ErrDebugExecFailed, "%v", err)
	}
	if len(snapshot.Uploads) == 0 {
		return nil, nil, errcode.ErrInstanceInvalidParam
	}
	upload := snapshot.Uploads[0]
	maxOutputBytes := int(((upload.SizeBytes + 2) / 3 * 4) + 1024)
	if maxOutputBytes < debugProcessOutputMaxBytes {
		maxOutputBytes = debugProcessOutputMaxBytes
	}
	contentOutput, err := l.execWorkspaceCommandWithOutputLimit(ctx, entity.SandboxId, "chatclaw_workspace_upload_content", chatClawReadWorkspaceUploadContentCommand(&upload), maxOutputBytes)
	if err != nil {
		return nil, nil, err
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(contentOutput.Output))
	if err != nil {
		return nil, nil, errcode.Wrap(errcode.ErrDebugExecFailed, "decode upload content: %v", err)
	}
	return mapWorkspaceUpload(upload, instanceID), decoded, nil
}
