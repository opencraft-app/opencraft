package instance

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"
)

const workspaceFilesTimeoutSec = 30
const workspaceFileOutputPrefix = "__CTL_WS_FILE__"

var allowedWorkspaceFiles = []string{
	"SOUL.md",
	"IDENTITY.md",
	"AGENTS.md",
	"USER.md",
	"TOOLS.md",
	"HEARTBEAT.md",
}

func normalizeWorkspaceFileName(fileName string) (string, bool) {
	trimmed := strings.TrimSpace(fileName)
	for _, allowed := range allowedWorkspaceFiles {
		if trimmed == allowed {
			return trimmed, true
		}
	}
	return "", false
}

func workspaceFilesCommand(fileName string) string {
	workspaceDir := `${HOME}/.openclaw/workspace`
	var lines []string
	lines = append(lines,
		fmt.Sprintf(`WORKSPACE_DIR="%s"`, workspaceDir),
		`emit_file() {`,
		`  local name="$1"`,
		`  local path="$WORKSPACE_DIR/$name"`,
		`  if [ ! -f "$path" ]; then return 0; fi`,
		fmt.Sprintf(`  printf '%s%%s\t' "$name"`, workspaceFileOutputPrefix),
		`  base64 < "$path" | tr -d '\n'`,
		`  printf '\n'`,
		`}`,
	)
	if fileName != "" {
		lines = append(lines, fmt.Sprintf(`emit_file %s`, shellQuoteArg(fileName)))
	} else {
		for _, allowed := range allowedWorkspaceFiles {
			lines = append(lines, fmt.Sprintf(`emit_file %s`, shellQuoteArg(allowed)))
		}
	}
	return strings.Join(lines, "\n")
}

func workspaceWriteCommand(fileName, content string) string {
	workspaceDir := `${HOME}/.openclaw/workspace`
	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	return strings.Join([]string{
		fmt.Sprintf(`WORKSPACE_DIR="%s"`, workspaceDir),
		`mkdir -p "$WORKSPACE_DIR"`,
		fmt.Sprintf(`cat <<'__CTL_WS_EOF__' | base64 -d > "$WORKSPACE_DIR/%s"`, fileName),
		encoded,
		`__CTL_WS_EOF__`,
	}, "\n")
}

func parseWorkspaceFilesOutput(output string) ([]*transport.WorkspaceFileResponse, error) {
	lines := strings.Split(output, "\n")
	items := make([]*transport.WorkspaceFileResponse, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, workspaceFileOutputPrefix) {
			continue
		}
		payload := strings.TrimPrefix(trimmed, workspaceFileOutputPrefix)
		name, encoded, ok := strings.Cut(payload, "\t")
		if !ok {
			return nil, fmt.Errorf("invalid workspace output line")
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
		if err != nil {
			return nil, fmt.Errorf("decode workspace file %s: %w", name, err)
		}
		items = append(items, &transport.WorkspaceFileResponse{
			Name:    name,
			Content: string(decoded),
			Exists:  true,
		})
	}
	return items, nil
}

func (l *logic) loadOwnedRunningInstance(ctx pctx.Context, instanceID string) (*modelinstance.Entity, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	entityUserID := strings.TrimSpace(entity.UserId)
	if entityUserID != "" && entityUserID != strings.TrimSpace(ctx.GetUserID()) {
		return nil, errcode.ErrInstanceNotFound
	}
	if entity.Status != modelinstance.InstanceStatusRunning {
		return nil, errcode.Wrap(errcode.ErrDebugNotSupported, "instance status is %s, expected running", entity.Status)
	}
	if strings.TrimSpace(entity.SandboxId) == "" || isPendingSandboxID(entity.SandboxId) {
		return nil, errcode.Wrap(errcode.ErrDebugNotSupported, "instance sandbox is not ready")
	}
	return entity, nil
}

func (l *logic) execWorkspaceCommand(ctx pctx.Context, sandboxID, commandKind, bash string) (*psandbox.ExecCommandResult, error) {
	return l.execWorkspaceCommandWithOutputLimit(ctx, sandboxID, commandKind, bash, debugProcessOutputMaxBytes)
}

func (l *logic) execWorkspaceCommandWithOutputLimit(ctx pctx.Context, sandboxID, commandKind, bash string, maxOutputBytes int) (*psandbox.ExecCommandResult, error) {
	result, err := l.execSandboxProcessCommandWithOutputLimit(ctx, sandboxID, commandKind, &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", bash},
		Pty:  false,
	}, workspaceFilesTimeoutSec, maxOutputBytes)
	if err != nil {
		if strings.Contains(commandKind, "write") && errors.Is(err, errcode.ErrSandboxTimeout) {
			return nil, errcode.ErrDebugExecTimeout
		}
		return nil, err
	}
	if !sandboxCommandSucceeded(result) {
		return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "%s", sandboxCommandFailureDetail(result))
	}
	return result, nil
}

func (l *logic) GetWorkspaceFiles(ctx pctx.Context, instanceID string, fileName string) (*transport.WorkspaceFilesResponse, error) {
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if fileName != "" {
		var ok bool
		fileName, ok = normalizeWorkspaceFileName(fileName)
		if !ok {
			return nil, errcode.ErrInstanceInvalidParam
		}
	}

	result, err := l.execWorkspaceCommand(ctx, entity.SandboxId, "workspace_files_read", workspaceFilesCommand(fileName))
	if err != nil {
		return nil, err
	}

	items, err := parseWorkspaceFilesOutput(result.Output)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "%v", err)
	}

	if fileName != "" && len(items) == 0 {
		return &transport.WorkspaceFilesResponse{
			Items: []*transport.WorkspaceFileResponse{{
				Name:    fileName,
				Content: "",
				Exists:  false,
			}},
		}, nil
	}

	return &transport.WorkspaceFilesResponse{Items: items}, nil
}

func (l *logic) UpdateWorkspaceFile(ctx pctx.Context, instanceID string, req *transport.UpdateWorkspaceFileRequest) (*transport.WorkspaceFileResponse, error) {
	if req == nil {
		return nil, errcode.ErrInstanceInvalidParam
	}
	fileName, ok := normalizeWorkspaceFileName(req.Name)
	if !ok {
		return nil, errcode.ErrInstanceInvalidParam
	}
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	if _, err := l.execWorkspaceCommand(ctx, entity.SandboxId, "workspace_files_write", workspaceWriteCommand(fileName, req.Content)); err != nil {
		return nil, err
	}

	return &transport.WorkspaceFileResponse{
		Name:    fileName,
		Content: req.Content,
		Exists:  true,
	}, nil
}
