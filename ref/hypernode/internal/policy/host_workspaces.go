package policy

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/crypto/ssh"
	goja "hypernode/internal/policy/jsvm"
	"hypernode/internal/workspaces"
)

func (h *hostRuntime) workspacesContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 30*time.Second)
}

func refProjection(ref workspaces.Ref) map[string]any {
	return map[string]any{"id": ref.ID, "driver": ref.Driver}
}

func attachmentProjection(attachment workspaces.Attachment) map[string]any {
	return map[string]any{
		"id":        attachment.ID,
		"workspace": refProjection(attachment.Workspace),
		"endpoint": map[string]any{
			"transport": attachment.Endpoint.Transport,
			"host":      attachment.Endpoint.Host,
			"port":      attachment.Endpoint.Port,
			"username":  attachment.Endpoint.Username,
			"subsystem": attachment.Endpoint.Subsystem,
		},
	}
}

func (h *hostRuntime) workspaceAttachment(attachmentID string) (workspaces.Attachment, error) {
	h.mu.Lock()
	attachment, found := h.workspaceAttachments[attachmentID]
	h.mu.Unlock()
	if !found {
		return workspaces.Attachment{}, fmt.Errorf("unknown workspace attachment: %s", attachmentID)
	}
	return attachment, nil
}

func (h *hostRuntime) callWorkspaceAttachment(
	attachmentID string, request workspaceStdioRequest,
) (workspaceStdioMessage, error) {
	attachment, err := h.workspaceAttachment(attachmentID)
	if err != nil {
		return workspaceStdioMessage{}, err
	}
	ctx, cancel := h.workspacesContext()
	defer cancel()
	return h.workspaceAttachmentPool.call(ctx, attachmentID, attachment.Endpoint, request)
}

// installWorkspaces exposes provider-neutral resource primitives. It does not
// expose Btrfs paths, runc bundle IDs or host user directories to policy code.
func (h *hostRuntime) installWorkspaces(vm *goja.Runtime) error {
	object := vm.NewObject()
	if err := object.Set("enabled", h.workspaceManager != nil); err != nil {
		return err
	}
	if err := object.Set("root", func() map[string]any {
		if h.workspaceManager == nil {
			return nil
		}
		root := h.workspaceManager.Root()
		if root == nil {
			return nil
		}
		return map[string]any{"threadId": root.ThreadID, "workspace": refProjection(root.Workspace)}
	}); err != nil {
		return err
	}
	if err := object.Set("status", func() map[string]any {
		if h.workspaceManager == nil {
			return map[string]any{"enabled": false}
		}
		snapshot := h.workspaceManager.Snapshot()
		return map[string]any{
			"enabled":        true,
			"driver":         h.workspaceDriver,
			"root":           objectRoot(snapshot.Root),
			"threadCount":    len(snapshot.Threads),
			"workspaceCount": len(snapshot.Workspaces),
		}
	}); err != nil {
		return err
	}
	if err := object.Set("ensureThread", func(threadID string) (map[string]any, error) {
		if h.workspaceManager == nil {
			return nil, fmt.Errorf("workspace manager is disabled")
		}
		ctx, cancel := h.workspacesContext()
		defer cancel()
		ref, becameRoot, err := h.workspaceManager.EnsureThread(ctx, threadID, h.workspaceDriver)
		if err != nil {
			return nil, err
		}
		return map[string]any{"workspace": refProjection(ref), "becameRoot": becameRoot}, nil
	}); err != nil {
		return err
	}
	if err := object.Set("forkThread", func(sourceThreadID, destinationThreadID string) (map[string]any, error) {
		if h.workspaceManager == nil {
			return nil, fmt.Errorf("workspace manager is disabled")
		}
		ctx, cancel := h.workspacesContext()
		defer cancel()
		ref, err := h.workspaceManager.ForkThread(ctx, sourceThreadID, destinationThreadID)
		if err != nil {
			return nil, err
		}
		return refProjection(ref), nil
	}); err != nil {
		return err
	}
	if err := object.Set("deleteThread", func(threadID string) error {
		if h.workspaceManager == nil {
			return nil
		}
		ctx, cancel := h.workspacesContext()
		defer cancel()
		return h.workspaceManager.DeleteThread(ctx, threadID)
	}); err != nil {
		return err
	}
	if err := object.Set("attach", func(threadID, principalID, username, mode string) (map[string]any, error) {
		if h.workspaceManager == nil {
			return nil, fmt.Errorf("workspace manager is disabled")
		}
		ref, found := h.workspaceManager.WorkspaceForThread(threadID)
		if !found {
			return nil, fmt.Errorf("thread has no workspace: %s", threadID)
		}
		ctx, cancel := h.workspacesContext()
		defer cancel()
		attachment, err := h.workspaceManager.Attach(ctx, ref, workspaces.AttachSpec{
			Principal: workspaces.Principal{ID: principalID, Username: username},
			Mode:      workspaces.Mode(mode),
		})
		if err != nil {
			return nil, err
		}
		h.mu.Lock()
		h.workspaceAttachments[attachment.ID] = attachment
		h.mu.Unlock()
		return attachmentProjection(attachment), nil
	}); err != nil {
		return err
	}
	if err := object.Set("metadata", func(attachmentID, logicalPath string) (map[string]any, error) {
		response, err := h.callWorkspaceAttachment(attachmentID, workspaceStdioRequest{
			Operation: "metadata", Path: logicalPath,
		})
		if err != nil {
			return nil, err
		}
		if response.Metadata == nil {
			return nil, fmt.Errorf("workspace metadata response is empty")
		}
		metadata := response.Metadata
		return map[string]any{
			"isDirectory": metadata.IsDirectory, "isFile": metadata.IsFile,
			"isSymlink": metadata.IsSymlink, "createdAtMs": metadata.CreatedAtMs,
			"modifiedAtMs": metadata.ModifiedAtMs,
		}, nil
	}); err != nil {
		return err
	}
	if err := object.Set("readDirectory", func(attachmentID, logicalPath string) ([]map[string]any, error) {
		response, err := h.callWorkspaceAttachment(attachmentID, workspaceStdioRequest{
			Operation: "list", Path: logicalPath,
		})
		if err != nil {
			return nil, err
		}
		entries := make([]map[string]any, 0, len(response.Entries))
		for _, entry := range response.Entries {
			entries = append(entries, map[string]any{
				"fileName": entry.FileName, "isDirectory": entry.IsDirectory, "isFile": entry.IsFile,
			})
		}
		return entries, nil
	}); err != nil {
		return err
	}
	if err := object.Set("readFile", func(attachmentID, logicalPath string) ([]byte, error) {
		response, err := h.callWorkspaceAttachment(attachmentID, workspaceStdioRequest{
			Operation: "read", Path: logicalPath,
		})
		return response.Data, err
	}); err != nil {
		return err
	}
	if err := object.Set("writeFile", func(attachmentID, logicalPath string, data []byte) error {
		_, err := h.callWorkspaceAttachment(attachmentID, workspaceStdioRequest{
			Operation: "write", Path: logicalPath, Data: data,
		})
		return err
	}); err != nil {
		return err
	}
	if err := object.Set("createDirectory", func(attachmentID, logicalPath string, recursive bool) error {
		_, err := h.callWorkspaceAttachment(attachmentID, workspaceStdioRequest{
			Operation: "mkdir", Path: logicalPath, Recursive: recursive,
		})
		return err
	}); err != nil {
		return err
	}
	if err := object.Set("remove", func(attachmentID, logicalPath string, recursive, force bool) error {
		_, err := h.callWorkspaceAttachment(attachmentID, workspaceStdioRequest{
			Operation: "remove", Path: logicalPath, Recursive: recursive, Force: force,
		})
		return err
	}); err != nil {
		return err
	}
	if err := object.Set("copy", func(attachmentID, source, destination string, recursive bool) error {
		_, err := h.callWorkspaceAttachment(attachmentID, workspaceStdioRequest{
			Operation: "copy", Path: source, DestinationPath: destination, Recursive: recursive,
		})
		return err
	}); err != nil {
		return err
	}
	if err := object.Set("execute", func(
		attachmentID, cwd string,
		command []string,
		environment map[string]any,
		timeoutMs int64,
		disableTimeout bool,
		outputBytesCap int,
		disableOutputCap bool,
	) (map[string]any, error) {
		env := make(map[string]*string, len(environment))
		for name, raw := range environment {
			if raw == nil {
				env[name] = nil
				continue
			}
			value, ok := raw.(string)
			if !ok {
				return nil, fmt.Errorf("workspace process env %s must be a string or null", name)
			}
			env[name] = &value
		}
		response, err := h.callWorkspaceAttachment(attachmentID, workspaceStdioRequest{
			Operation: "exec", Path: cwd, Command: command, Environment: env,
			TimeoutMs: timeoutMs, DisableTimeout: disableTimeout,
			OutputBytesCap: outputBytesCap, DisableOutputCap: disableOutputCap,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"exitCode":         response.ExitCode,
			"stdout":           response.Stdout,
			"stderr":           response.Stderr,
			"stdoutCapReached": response.StdoutCapReached,
			"stderrCapReached": response.StderrCapReached,
		}, nil
	}); err != nil {
		return err
	}
	if err := object.Set("startProcess", func(
		id, attachmentID, cwd string,
		command []string,
		environment map[string]any,
		timeoutMs int64,
		disableTimeout bool,
		outputBytesCap int,
		disableOutputCap bool,
		interactiveStdin bool,
	) error {
		attachment, err := h.workspaceAttachment(attachmentID)
		if err != nil {
			return err
		}
		env := make(map[string]*string, len(environment))
		for name, raw := range environment {
			if raw == nil {
				env[name] = nil
				continue
			}
			value, ok := raw.(string)
			if !ok {
				return fmt.Errorf("workspace process env %s must be a string or null", name)
			}
			env[name] = &value
		}
		ctx, cancel := h.workspacesContext()
		defer cancel()
		return h.workspaceAttachmentPool.startProcess(ctx, id, attachmentID, attachment.Endpoint, workspaceStdioRequest{
			Operation: "spawn", Path: cwd, Command: command, Environment: env,
			TimeoutMs: timeoutMs, DisableTimeout: disableTimeout,
			OutputBytesCap: outputBytesCap, DisableOutputCap: disableOutputCap,
			InteractiveStdin: interactiveStdin,
		})
	}); err != nil {
		return err
	}
	if err := object.Set("drainProcess", h.workspaceAttachmentPool.drainProcess); err != nil {
		return err
	}
	if err := object.Set("writeProcess", func(id, text string) error {
		return h.workspaceAttachmentPool.writeProcess(id, []byte(text))
	}); err != nil {
		return err
	}
	if err := object.Set("closeProcess", h.workspaceAttachmentPool.closeProcess); err != nil {
		return err
	}
	if err := object.Set("openTerminal", func(id, attachmentID string, cols, rows int) (map[string]any, error) {
		attachment, err := h.workspaceAttachment(attachmentID)
		if err != nil {
			return nil, err
		}
		ctx, cancel := h.workspacesContext()
		defer cancel()
		return h.workspaceAttachmentPool.openTerminal(ctx, id, attachmentID, attachment.Endpoint, cols, rows)
	}); err != nil {
		return err
	}
	if err := object.Set("writeTerminal", h.workspaceAttachmentPool.writeTerminal); err != nil {
		return err
	}
	if err := object.Set("resizeTerminal", h.workspaceAttachmentPool.resizeTerminal); err != nil {
		return err
	}
	if err := object.Set("drainTerminal", h.workspaceAttachmentPool.drainTerminal); err != nil {
		return err
	}
	if err := object.Set("closeTerminal", h.workspaceAttachmentPool.closeTerminal); err != nil {
		return err
	}
	if err := object.Set("watch", h.startWorkspaceAttachmentWatch); err != nil {
		return err
	}
	if err := object.Set("drainWatch", h.drainWorkspaceAttachmentWatch); err != nil {
		return err
	}
	if err := object.Set("unwatch", h.stopWorkspaceAttachmentWatch); err != nil {
		return err
	}
	if err := object.Set("detach", func(attachmentID string) error {
		if h.workspaceManager == nil {
			return nil
		}
		h.mu.Lock()
		attachment, found := h.workspaceAttachments[attachmentID]
		if found {
			delete(h.workspaceAttachments, attachmentID)
		}
		watchIDs := make([]string, 0)
		for watchID, currentAttachmentID := range h.workspaceAttachmentWatchRefs {
			if currentAttachmentID == attachmentID {
				watchIDs = append(watchIDs, watchID)
			}
		}
		h.mu.Unlock()
		for _, watchID := range watchIDs {
			_ = h.stopWorkspaceAttachmentWatch(watchID)
		}
		h.workspaceAttachmentPool.detach(attachmentID)
		if !found {
			return nil
		}
		ctx, cancel := h.workspacesContext()
		defer cancel()
		return h.workspaceManager.Detach(ctx, attachment)
	}); err != nil {
		return err
	}
	return vm.Set("hostWorkspaces", object)
}

func (h *hostRuntime) startWorkspaceAttachmentWatch(id, attachmentID, logicalPath string) error {
	if id == "" {
		return fmt.Errorf("workspace watch id is required")
	}
	logicalPath, err := workspaceLogicalPath(logicalPath)
	if err != nil {
		return err
	}
	attachment, err := h.workspaceAttachment(attachmentID)
	if err != nil {
		return err
	}
	watch := newRemoteWorkspaceWatch(logicalPath, h.wakes.notify)
	h.mu.Lock()
	if h.closed || h.workspaceAttachmentWatches[id] != nil {
		h.mu.Unlock()
		return fmt.Errorf("duplicate or closed workspace attachment watch id")
	}
	h.workspaceAttachmentWatches[id] = watch
	h.workspaceAttachmentWatchRefs[id] = attachmentID
	h.mu.Unlock()
	go watch.run(
		func(ctx context.Context) (*ssh.Client, error) {
			return h.workspaceAttachmentPool.client(ctx, attachmentID, attachment.Endpoint)
		},
		func(client *ssh.Client) { h.workspaceAttachmentPool.invalidate(attachmentID, client) },
	)
	return nil
}

func (h *hostRuntime) drainWorkspaceAttachmentWatch(id string) ([]string, error) {
	h.mu.Lock()
	watch := h.workspaceAttachmentWatches[id]
	h.mu.Unlock()
	if watch == nil {
		return nil, fmt.Errorf("unknown workspace attachment watch: %s", id)
	}
	return watch.drain(), nil
}

func (h *hostRuntime) stopWorkspaceAttachmentWatch(id string) error {
	h.mu.Lock()
	watch := h.workspaceAttachmentWatches[id]
	delete(h.workspaceAttachmentWatches, id)
	delete(h.workspaceAttachmentWatchRefs, id)
	h.mu.Unlock()
	if watch != nil {
		watch.Close()
	}
	return nil
}

func objectRoot(root *workspaces.RootBinding) any {
	if root == nil {
		return nil
	}
	return map[string]any{"threadId": root.ThreadID, "workspace": refProjection(root.Workspace)}
}
