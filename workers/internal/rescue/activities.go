package rescue

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"go.temporal.io/sdk/activity"
	"golang.org/x/crypto/ssh"
)

type Activities struct{}

const maxTATInlineArchiveBytes = 16 * 1024

func ActivityOptions(name string) activity.RegisterOptions {
	return activity.RegisterOptions{Name: name}
}

func logActivity(ctx context.Context, msg string, keyvals ...interface{}) {
	defer func() {
		_ = recover()
	}()
	activity.GetLogger(ctx).Info(msg, keyvals...)
}

func (Activities) LocateInstance(ctx context.Context, req ExportRequest, cfg TencentConfig) (InstanceInfo, error) {
	logActivity(ctx, "locating rescue target", "instance_id", req.InstanceID, "preferred_region", req.Region)
	info, err := ResolveInstanceRegion(ctx, cfg, req)
	if err != nil {
		return InstanceInfo{}, temporalActivityError(err)
	}
	logActivity(ctx, "rescue target located", "instance_id", info.InstanceID, "region", info.Region, "state", info.State, "public_ip", info.PublicIP)
	return info, nil
}

func (Activities) EnterRescueMode(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) error {
	logActivity(ctx, "entering rescue mode", "instance_id", req.InstanceID, "region", region, "username", req.RescueUsername, "stop_type", req.StopType)
	if req.RescuePasswordEnv == "" || os.Getenv(req.RescuePasswordEnv) == "" {
		return temporalActivityError(fmt.Errorf("rescue password env %q is not set", req.RescuePasswordEnv))
	}
	client, err := NewTencentClient(cfg, region)
	if err != nil {
		return temporalActivityError(err)
	}
	if err := EnterRescue(ctx, client, req); err != nil {
		return temporalActivityError(err)
	}
	logActivity(ctx, "enter rescue mode requested", "instance_id", req.InstanceID, "region", region)
	return nil
}

func (Activities) WaitRescueRunning(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) (string, error) {
	if !req.Execute {
		fmt.Printf("[dry-run] would wait for %s RUNNING after rescue mode\n", req.InstanceID)
		return "DRY_RUN", nil
	}
	client, err := NewTencentClient(cfg, region)
	if err != nil {
		return "", temporalActivityError(err)
	}
	return WaitInstanceState(ctx, client, req.InstanceID, map[string]bool{"RUNNING": true, "RESCUE_MODE": true}, time.Duration(req.WaitTimeoutSeconds)*time.Second)
}

func (Activities) WaitInstanceRunning(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) (string, error) {
	if !req.Execute {
		fmt.Printf("[dry-run] would wait for %s RUNNING\n", req.InstanceID)
		return "DRY_RUN", nil
	}
	client, err := NewTencentClient(cfg, region)
	if err != nil {
		return "", temporalActivityError(err)
	}
	return WaitInstanceState(ctx, client, req.InstanceID, map[string]bool{"RUNNING": true}, time.Duration(req.WaitTimeoutSeconds)*time.Second)
}

func (Activities) WaitRescueSSH(ctx context.Context, req ExportRequest, instance InstanceInfo) error {
	if !req.Execute {
		fmt.Printf("[dry-run] would wait for rescue SSH on %s\n", sshHost(req, instance))
		return nil
	}
	host := sshHost(req, instance)
	if host == "" {
		return temporalActivityError(fmt.Errorf("no SSH host available; pass --ssh-host or ensure the CVM has a public IP"))
	}
	deadline := time.Now().Add(time.Duration(req.WaitTimeoutSeconds) * time.Second)
	var lastErr error
	fmt.Printf("[rescue] waiting for SSH host=%s user=%s port=%d %s\n", host, req.SSHUser, req.SSHPort, sshAuthDebug(req))
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return err
		}
		client, err := dialSSH(req, host)
		if err == nil {
			client.Close()
			fmt.Printf("[rescue] SSH reachable host=%s\n", host)
			return nil
		}
		lastErr = err
		recordHeartbeat(ctx, map[string]string{
			"kind": "ssh",
			"host": host,
			"err":  trimForLog(err.Error(), 256),
		})
		fmt.Printf("[rescue] SSH not ready host=%s err=%v\n", host, err)
		if err := sleepContext(ctx, 5*time.Second); err != nil {
			return err
		}
	}
	return fmt.Errorf("timed out waiting for rescue SSH on %s: %w", host, lastErr)
}

func (Activities) WaitRescueTAT(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) error {
	if !req.Execute {
		fmt.Printf("[dry-run] would wait for TAT agent on %s\n", req.InstanceID)
		return nil
	}
	logActivity(ctx, "waiting for rescue TAT agent", "instance_id", req.InstanceID, "region", region, "timeout_seconds", req.TATWaitTimeoutSeconds)
	client, err := NewTencentClient(cfg, region)
	if err != nil {
		return temporalActivityError(err)
	}
	timeout := req.TATWaitTimeoutSeconds
	if timeout <= 0 {
		timeout = req.WaitTimeoutSeconds
	}
	info, err := WaitTATOnline(ctx, client, req.InstanceID, time.Duration(timeout)*time.Second)
	if err != nil {
		return err
	}
	logActivity(ctx, "rescue TAT agent online", "instance_id", req.InstanceID, "region", region, "status", info.Status, "environment", info.Environment)
	return nil
}

func (Activities) PrepareArchive(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) (PreparedArchive, error) {
	script := BuildArchiveScript(req)
	if !req.Execute {
		fmt.Println("[dry-run] SSH archive command:")
		fmt.Println(script)
		return PreparedArchive{InstanceID: req.InstanceID, Region: region, RemotePath: req.RemoteWorkDir + "/dry-run-rescue-export" + archiveSuffix(req), MountedDevice: "dry-run-device", SHA256: "dry-run-sha256"}, nil
	}
	return PreparedArchive{}, fmt.Errorf("PrepareArchive requires instance-aware SSH; use PrepareArchiveOverSSH")
}

func (Activities) PrepareArchiveOverSSH(ctx context.Context, req ExportRequest, instance InstanceInfo) (PreparedArchive, error) {
	script := BuildArchiveScript(req)
	if !req.Execute {
		fmt.Println("[dry-run] SSH archive command:")
		fmt.Println(script)
		return PreparedArchive{InstanceID: req.InstanceID, Region: instance.Region, RemotePath: req.RemoteWorkDir + "/dry-run-rescue-export" + archiveSuffix(req), MountedDevice: "dry-run-device", SHA256: "dry-run-sha256"}, nil
	}
	host := sshHost(req, instance)
	if host == "" {
		return PreparedArchive{}, temporalActivityError(fmt.Errorf("no SSH host available; pass --ssh-host or ensure the CVM has a public IP"))
	}
	fmt.Printf("[rescue] preparing remote archive over SSH host=%s paths=%s\n", host, strings.Join(req.RemotePaths, ","))
	stdout, stderr, err := runSSHCommand(req, host, "bash -s", script)
	output := stdout + stderr
	if err != nil {
		return PreparedArchive{}, fmt.Errorf("remote archive command failed: %w output=%s", err, trimForLog(output, 4096))
	}
	marker, err := ParseArchiveMarker(output)
	if err != nil {
		return PreparedArchive{}, fmt.Errorf("%w; output=%s", err, output)
	}
	fmt.Printf("[rescue] remote archive ready path=%s device=%s bytes=%d sha256=%s\n", marker.Archive, marker.Device, marker.Bytes, marker.SHA256)
	return PreparedArchive{InstanceID: req.InstanceID, Region: instance.Region, RemotePath: marker.Archive, MountedDevice: marker.Device, SHA256: marker.SHA256, ByteSize: marker.Bytes, RemoteOutput: trimForLog(output, 2048)}, nil
}

func (Activities) PrepareArchiveOverTAT(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) (PreparedArchive, error) {
	client, err := NewTencentClient(cfg, region)
	if err != nil {
		return PreparedArchive{}, temporalActivityError(err)
	}
	prepared, err := prepareArchiveTATCommand(ctx, req, cfg, region)
	if err != nil {
		return PreparedArchive{}, err
	}
	result, err := RunTATCommandAndWait(ctx, client, req, prepared.Command.CommandName, prepared.Command.Script, prepared.Command.TimeoutSeconds)
	if err != nil {
		return PreparedArchive{}, err
	}
	return finalizeArchiveOverTAT(req, prepared, result)
}

func (Activities) PrepareArchiveTATCommand(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) (PreparedTATArchive, error) {
	logActivity(ctx, "preparing TAT archive command", "instance_id", req.InstanceID, "region", region, "transport", req.CommandTransport, "archive_mode", normalizeArchiveMode(req.ArchiveMode), "stream_upload", req.COSUploadBucket != "")
	prepared, err := prepareArchiveTATCommand(ctx, req, cfg, region)
	if err != nil {
		return PreparedTATArchive{}, err
	}
	logActivity(ctx, "prepared TAT archive command", "instance_id", req.InstanceID, "region", region, "mode", prepared.Mode, "object_key", prepared.ObjectKey, "bucket", prepared.Bucket)
	return prepared, nil
}

func (Activities) StartTATCommand(ctx context.Context, req ExportRequest, cfg TencentConfig, region string, command TATCommandRequest) (TATCommandResult, error) {
	logActivity(ctx, "starting TAT command", "instance_id", req.InstanceID, "region", region, "command_name", command.CommandName, "timeout_seconds", command.TimeoutSeconds)
	client, err := NewTencentClient(cfg, region)
	if err != nil {
		return TATCommandResult{}, temporalActivityError(err)
	}
	result, err := SubmitTATCommand(ctx, client, req, command.CommandName, command.Script, command.TimeoutSeconds)
	if err != nil {
		return TATCommandResult{}, err
	}
	logActivity(ctx, "TAT command submitted", "instance_id", req.InstanceID, "region", region, "command_id", result.CommandID, "invocation_id", result.InvocationID)
	return result, nil
}

func (Activities) WaitTATCommand(ctx context.Context, req ExportRequest, cfg TencentConfig, region string, submitted TATCommandResult) (TATCommandResult, error) {
	if !req.Execute {
		return submitted, nil
	}
	logActivity(ctx, "waiting for TAT command", "instance_id", req.InstanceID, "region", region, "command_id", submitted.CommandID, "invocation_id", submitted.InvocationID)
	client, err := NewTencentClient(cfg, region)
	if err != nil {
		return TATCommandResult{}, temporalActivityError(err)
	}
	timeout := time.Duration(req.CommandTimeoutSeconds+120) * time.Second
	result, err := WaitTATInvocation(ctx, client, submitted, timeout)
	if err != nil {
		return TATCommandResult{}, err
	}
	logActivity(ctx, "TAT command finished", "instance_id", req.InstanceID, "region", region, "command_id", result.CommandID, "invocation_id", result.InvocationID, "status", result.TaskStatus, "exit_code", result.ExitCode, "output_url", result.OutputURL)
	return result, nil
}

func (Activities) FinalizeArchiveOverTAT(ctx context.Context, req ExportRequest, prepared PreparedTATArchive, result TATCommandResult) (PreparedArchive, error) {
	return finalizeArchiveOverTAT(req, prepared, result)
}

func prepareArchiveTATCommand(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) (PreparedTATArchive, error) {
	if err := ValidateArchiveMode(req.ArchiveMode); err != nil {
		return PreparedTATArchive{}, temporalActivityError(err)
	}
	if req.COSUploadBucket != "" {
		return prepareStreamUploadTATCommand(ctx, req, cfg, region)
	}
	script := BuildArchiveScript(req)
	prepared := PreparedTATArchive{
		InstanceID: req.InstanceID,
		Region:     region,
		Mode:       "remote-archive",
		Command: TATCommandRequest{
			CommandName:    "rescue-export-archive",
			Script:         script,
			TimeoutSeconds: req.CommandTimeoutSeconds,
		},
	}
	if !req.Execute {
		fmt.Println("[dry-run] TAT archive command:")
		fmt.Println(script)
		prepared.RemotePath = req.RemoteWorkDir + "/dry-run-rescue-export" + archiveSuffix(req)
		prepared.MountedDevice = "dry-run-device"
		prepared.SHA256 = "dry-run-sha256"
		return prepared, nil
	}
	fmt.Printf("[rescue] prepared remote archive TAT command instance=%s user=%s workdir=%s paths=%s\n",
		req.InstanceID, req.TATUsername, req.TATWorkingDirectory, strings.Join(req.RemotePaths, ","))
	return prepared, nil
}

func prepareStreamUploadTATCommand(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) (PreparedTATArchive, error) {
	if !req.Execute {
		return PreparedTATArchive{
			InstanceID: req.InstanceID,
			Region:     region,
			Mode:       "stream-upload",
			ObjectURL:  "dry-run-cos-object",
			ObjectKey:  "dry-run-key",
			Bucket:     req.COSUploadBucket,
			Command: TATCommandRequest{
				CommandName:    "rescue-export-stream-upload",
				Script:         "dry-run",
				TimeoutSeconds: req.CommandTimeoutSeconds,
			},
		}, nil
	}
	uploaderPath, err := buildRescueUploader()
	if err != nil {
		return PreparedTATArchive{}, err
	}
	uploaderKey := cosKey(req, "uploaders", fmt.Sprintf("rescue-uploader-linux-amd64-%d", time.Now().Unix()))
	archiveKey := cosObjectKey(req)
	uploaderPUT, err := GenerateCOSUploadTarget(ctx, cfg, req, uploaderKey, http.MethodPut)
	if err != nil {
		return PreparedTATArchive{}, temporalActivityError(err)
	}
	uploaderGET, err := GenerateCOSUploadTarget(ctx, cfg, req, uploaderKey, http.MethodGet)
	if err != nil {
		return PreparedTATArchive{}, temporalActivityError(err)
	}
	archivePUT, err := GenerateCOSUploadTarget(ctx, cfg, req, archiveKey, http.MethodPut)
	if err != nil {
		return PreparedTATArchive{}, temporalActivityError(err)
	}
	archiveGET, err := GenerateCOSUploadTarget(ctx, cfg, req, archiveKey, http.MethodGet)
	if err != nil {
		return PreparedTATArchive{}, temporalActivityError(err)
	}
	if err := putLocalFile(uploaderPUT.SignedURL, uploaderPath); err != nil {
		return PreparedTATArchive{}, err
	}
	cfgJSON, err := json.Marshal(map[string]any{
		"upload_url":   archivePUT.SignedURL,
		"object_url":   archivePUT.ObjectURL,
		"mount_root":   req.MountRoot,
		"device_globs": req.DeviceGlobs,
		"remote_paths": req.RemotePaths,
		"archive_mode": normalizeArchiveMode(req.ArchiveMode),
	})
	if err != nil {
		return PreparedTATArchive{}, err
	}
	fmt.Printf("[rescue] uploaded rescue uploader to COS bucket=%s key=%s archive_key=%s archive_url=%s\n",
		req.COSUploadBucket, uploaderKey, archiveKey, archivePUT.ObjectURL)
	script := BuildUploaderRunScript(uploaderGET.SignedURL, string(cfgJSON))
	if encodedLen := base64.StdEncoding.EncodedLen(len([]byte(script))); encodedLen > 64*1024 {
		return PreparedTATArchive{}, temporalActivityError(fmt.Errorf("TAT uploader script is too large after base64: %d bytes", encodedLen))
	}
	return PreparedTATArchive{
		InstanceID:  req.InstanceID,
		Region:      region,
		Mode:        "stream-upload",
		ObjectURL:   archivePUT.ObjectURL,
		DownloadURL: archiveGET.SignedURL,
		ObjectKey:   archiveKey,
		Bucket:      req.COSUploadBucket,
		Command: TATCommandRequest{
			CommandName:    "rescue-export-stream-upload",
			Script:         script,
			TimeoutSeconds: req.CommandTimeoutSeconds,
		},
	}, nil
}

func finalizeArchiveOverTAT(req ExportRequest, prepared PreparedTATArchive, result TATCommandResult) (PreparedArchive, error) {
	switch prepared.Mode {
	case "stream-upload":
		if !req.Execute {
			return PreparedArchive{InstanceID: prepared.InstanceID, Region: prepared.Region, ObjectURL: prepared.ObjectURL, ObjectKey: prepared.ObjectKey, Bucket: prepared.Bucket}, nil
		}
		marker, err := ParseUploadMarker(result.Output)
		if err != nil {
			return PreparedArchive{}, fmt.Errorf("%w; tat_status=%s dropped=%d output_url=%s output=%s",
				err, result.TaskStatus, result.DroppedBytes, result.OutputURL, trimForLog(result.Output, 4096))
		}
		fmt.Printf("[rescue] archive streamed to COS object_url=%s download_url_generated=true device=%s bytes=%d sha256=%s invocation_id=%s\n",
			marker.ObjectURL, marker.Device, marker.Bytes, marker.SHA256, result.InvocationID)
		return PreparedArchive{
			InstanceID:    prepared.InstanceID,
			Region:        prepared.Region,
			MountedDevice: marker.Device,
			SHA256:        marker.SHA256,
			ByteSize:      marker.Bytes,
			RemoteOutput:  trimForLog(result.Output, 2048),
			ObjectURL:     marker.ObjectURL,
			DownloadURL:   prepared.DownloadURL,
			ObjectKey:     prepared.ObjectKey,
			Bucket:        prepared.Bucket,
		}, nil
	case "remote-archive":
		if !req.Execute {
			return PreparedArchive{
				InstanceID:    prepared.InstanceID,
				Region:        prepared.Region,
				RemotePath:    prepared.RemotePath,
				MountedDevice: prepared.MountedDevice,
				SHA256:        prepared.SHA256,
				ByteSize:      prepared.ByteSize,
			}, nil
		}
		marker, err := ParseArchiveMarker(result.Output)
		if err != nil {
			return PreparedArchive{}, fmt.Errorf("%w; tat_status=%s dropped=%d output_url=%s output=%s",
				err, result.TaskStatus, result.DroppedBytes, result.OutputURL, trimForLog(result.Output, 4096))
		}
		fmt.Printf("[rescue] remote archive ready via TAT path=%s device=%s bytes=%d sha256=%s invocation_id=%s\n",
			marker.Archive, marker.Device, marker.Bytes, marker.SHA256, result.InvocationID)
		return PreparedArchive{InstanceID: prepared.InstanceID, Region: prepared.Region, RemotePath: marker.Archive, MountedDevice: marker.Device, SHA256: marker.SHA256, ByteSize: marker.Bytes, RemoteOutput: trimForLog(result.Output, 2048)}, nil
	default:
		return PreparedArchive{}, temporalActivityError(fmt.Errorf("unknown TAT archive mode %q", prepared.Mode))
	}
}

func (Activities) SCPArchive(ctx context.Context, req ExportRequest, cfg TencentConfig, instance InstanceInfo, archive PreparedArchive) (SCPResult, error) {
	if archive.ObjectURL != "" {
		outputURL := archive.DownloadURL
		if outputURL == "" {
			outputURL = archive.ObjectURL
		}
		logActivity(ctx, "archive available via COS", "instance_id", req.InstanceID, "region", instance.Region, "object_key", archive.ObjectKey, "object_url", archive.ObjectURL, "download_url_generated", archive.DownloadURL != "")
		return SCPResult{LocalPath: archive.ObjectURL, Command: []string{"cos-signed-put-stream"}, OutputURL: outputURL}, nil
	}
	if req.CommandTransport == "tat" {
		return copyArchiveOverTAT(ctx, req, cfg, instance.Region, archive)
	}
	host := sshHost(req, instance)
	if host == "" {
		return SCPResult{}, temporalActivityError(fmt.Errorf("no SSH host available; pass --ssh-host or ensure the CVM has a public IP"))
	}
	localDir, err := filepath.Abs(req.LocalOutputDir)
	if err != nil {
		return SCPResult{}, err
	}
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return SCPResult{}, err
	}
	localPath := filepath.Join(localDir, fmt.Sprintf("%s-%d%s", req.InstanceID, time.Now().Unix(), archiveSuffix(req)))
	cmd := []string{"ssh-native-copy", fmt.Sprintf("%s@%s:%s", req.SSHUser, host, archive.RemotePath), localPath}
	if !req.Execute {
		fmt.Printf("[dry-run] would run: %s\n", strings.Join(cmd, " "))
		return SCPResult{LocalPath: localPath, Command: cmd}, nil
	}
	fmt.Printf("[rescue] copying archive remote=%s local=%s\n", archive.RemotePath, localPath)
	stderr, err := copyRemoteFile(req, host, archive.RemotePath, localPath)
	if err != nil {
		return SCPResult{}, fmt.Errorf("ssh native copy failed: %w stderr=%s", err, stderr)
	}
	if archive.SHA256 != "" {
		actual, err := fileSHA256(localPath)
		if err != nil {
			return SCPResult{}, err
		}
		if actual != archive.SHA256 {
			return SCPResult{}, fmt.Errorf("sha256 mismatch for %s: remote=%s local=%s", localPath, archive.SHA256, actual)
		}
		fmt.Printf("[rescue] local sha256 verified path=%s sha256=%s\n", localPath, actual)
	}
	return SCPResult{LocalPath: localPath, Command: cmd, Stderr: stderr}, nil
}

func buildRescueUploader() (string, error) {
	if configuredPath := strings.TrimSpace(os.Getenv("RESCUE_UPLOADER_PATH")); configuredPath != "" {
		return existingUploaderPath(configuredPath)
	}
	if executablePath, err := os.Executable(); err == nil {
		siblingPath := filepath.Join(filepath.Dir(executablePath), "rescue-uploader")
		if path, err := existingUploaderPath(siblingPath); err == nil {
			return path, nil
		}
	}

	outDir, err := os.MkdirTemp("", "rescue-uploader-build-*")
	if err != nil {
		return "", err
	}
	out := filepath.Join(outDir, "rescue-uploader")
	cmd := exec.Command("go", "build", "-trimpath", "-ldflags", "-s -w", "-o", out, "./cmd/rescue-uploader")
	cmd.Env = append(os.Environ(), "GOOS=linux", "GOARCH=amd64", "CGO_ENABLED=0")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("build rescue uploader: %w stderr=%s", err, stderr.String())
	}
	return out, nil
}

func existingUploaderPath(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("rescue uploader path %q is a directory", path)
	}
	if info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("rescue uploader path %q is not executable", path)
	}
	return path, nil
}

func putLocalFile(signedURL, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	req, err := http.NewRequest(http.MethodPut, signedURL, file)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("upload rescue uploader failed status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func cosKey(req ExportRequest, category string, name string) string {
	prefix := strings.Trim(req.COSUploadKeyPrefix, "/")
	parts := []string{}
	if prefix != "" {
		parts = append(parts, prefix)
	}
	if category != "" {
		parts = append(parts, category)
	}
	parts = append(parts, name)
	return strings.Join(parts, "/")
}

func (Activities) CleanupRemoteArchive(ctx context.Context, req ExportRequest, cfg TencentConfig, instance InstanceInfo, archive PreparedArchive) error {
	if req.KeepRemoteArchive {
		return nil
	}
	command := "rm -f -- " + shellQuote(archive.RemotePath)
	if !req.Execute {
		fmt.Printf("[dry-run] would remove remote archive: %s\n", archive.RemotePath)
		return nil
	}
	if req.CommandTransport == "tat" {
		client, err := NewTencentClient(cfg, instance.Region)
		if err != nil {
			return temporalActivityError(err)
		}
		_, err = RunTATCommandAndWait(ctx, client, req, "rescue-export-cleanup", command, 60)
		return err
	}
	host := sshHost(req, instance)
	if host == "" {
		return temporalActivityError(fmt.Errorf("no SSH host available; pass --ssh-host or ensure the CVM has a public IP"))
	}
	fmt.Printf("[rescue] cleaning remote archive path=%s\n", archive.RemotePath)
	_, stderr, err := runSSHCommand(req, host, command, "")
	if err != nil {
		return fmt.Errorf("remote archive cleanup failed: %w stderr=%s", err, stderr)
	}
	return nil
}

func copyArchiveOverTAT(ctx context.Context, req ExportRequest, cfg TencentConfig, region string, archive PreparedArchive) (SCPResult, error) {
	localDir, err := filepath.Abs(req.LocalOutputDir)
	if err != nil {
		return SCPResult{}, err
	}
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return SCPResult{}, err
	}
	localPath := filepath.Join(localDir, fmt.Sprintf("%s-%d%s", req.InstanceID, time.Now().Unix(), archiveSuffix(req)))
	cmd := []string{"tat-run-command", req.InstanceID, "base64", archive.RemotePath}
	if !req.Execute {
		fmt.Printf("[dry-run] would run: %s\n", strings.Join(cmd, " "))
		return SCPResult{LocalPath: localPath, Command: cmd}, nil
	}
	client, err := NewTencentClient(cfg, region)
	if err != nil {
		return SCPResult{}, temporalActivityError(err)
	}
	script := "base64 -- " + shellQuote(archive.RemotePath) + " | tr -d '\\n'"
	if req.TATOutputCOSBucketURL != "" {
		result, err := RunTATCommandAndWait(ctx, client, req, "rescue-export-download", script, req.CommandTimeoutSeconds)
		if err != nil {
			return SCPResult{}, err
		}
		if result.OutputURL == "" {
			return SCPResult{}, fmt.Errorf("TAT COS output requested but task returned no OutputUrl; dropped=%d output=%s", result.DroppedBytes, trimForLog(result.Output, 1024))
		}
		fmt.Printf("[rescue] TAT archive output written to COS output_url=%s invocation_id=%s\n", result.OutputURL, result.InvocationID)
		return SCPResult{LocalPath: localPath, Command: cmd, OutputURL: result.OutputURL, Stdout: trimForLog(result.Output, 2048)}, nil
	}
	if archive.ByteSize > maxTATInlineArchiveBytes {
		return SCPResult{}, fmt.Errorf("archive is %d bytes; TAT inline output is limited, pass --tat-output-cos-bucket-url to export via COS", archive.ByteSize)
	}
	result, err := RunTATCommandAndWait(ctx, client, req, "rescue-export-download", script, req.CommandTimeoutSeconds)
	if err != nil {
		return SCPResult{}, err
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(result.Output))
	if err != nil {
		return SCPResult{}, fmt.Errorf("decode TAT archive output: %w output=%s", err, trimForLog(result.Output, 1024))
	}
	if err := os.WriteFile(localPath, data, 0o600); err != nil {
		return SCPResult{}, err
	}
	if archive.SHA256 != "" {
		actual, err := fileSHA256(localPath)
		if err != nil {
			return SCPResult{}, err
		}
		if actual != archive.SHA256 {
			return SCPResult{}, fmt.Errorf("sha256 mismatch for %s: remote=%s local=%s", localPath, archive.SHA256, actual)
		}
	}
	return SCPResult{LocalPath: localPath, Command: cmd, Stdout: trimForLog(result.Output, 2048)}, nil
}

func (Activities) ExitRescueMode(ctx context.Context, req ExportRequest, cfg TencentConfig, region string) (bool, error) {
	logActivity(ctx, "exiting rescue mode", "instance_id", req.InstanceID, "region", region)
	client, err := NewTencentClient(cfg, region)
	if err != nil {
		return false, temporalActivityError(err)
	}
	if err := ExitRescue(ctx, client, req); err != nil {
		return false, temporalActivityError(err)
	}
	logActivity(ctx, "exit rescue mode requested", "instance_id", req.InstanceID, "region", region)
	return true, nil
}

func (Activities) SendExportNotificationEmail(ctx context.Context, req ExportRequest, downloadURL string, ttlSeconds int) (EmailNotificationResult, error) {
	toEmail := notificationEmail(req)
	logActivity(ctx, "sending export notification email", "instance_id", req.InstanceID, "to", toEmail, "ttl_seconds", ttlSeconds)
	subject, htmlBody, textBody := buildExportNotificationContent(req, downloadURL, ttlSeconds)
	result, err := deliverExportNotificationEmail(ctx, TencentConfig{}, LoadSESConfig(), toEmail, subject, htmlBody, textBody, !req.Execute)
	if err != nil {
		return EmailNotificationResult{}, err
	}
	logActivity(ctx, "export notification email sent", "instance_id", req.InstanceID, "to", toEmail, "message_id", result.MessageID, "dry_run", result.DryRun)
	return result, nil
}

func (Activities) SendImportNotificationEmail(ctx context.Context, req ImportRequest) (EmailNotificationResult, error) {
	exportReq := req.exportRequest()
	toEmail := notificationEmail(exportReq)
	logActivity(ctx, "sending import notification email", "instance_id", req.InstanceID, "to", toEmail)
	subject, htmlBody, textBody := buildImportNotificationContent(req)
	result, err := deliverExportNotificationEmail(ctx, TencentConfig{}, LoadSESConfig(), toEmail, subject, htmlBody, textBody, !req.Execute)
	if err != nil {
		return EmailNotificationResult{}, err
	}
	logActivity(ctx, "import notification email sent", "instance_id", req.InstanceID, "to", toEmail, "message_id", result.MessageID, "dry_run", result.DryRun)
	return result, nil
}

func (Activities) ConfirmExportNotificationDelivered(ctx context.Context, req ExportRequest, sent EmailNotificationResult) (EmailNotificationResult, error) {
	logActivity(ctx, "confirming export notification delivery", "instance_id", req.InstanceID, "to", sent.ToEmail, "message_id", sent.MessageID)
	result, err := confirmExportNotificationDelivered(ctx, TencentConfig{}, LoadSESConfig(), sent, !req.Execute)
	if err != nil {
		return EmailNotificationResult{}, err
	}
	logActivity(ctx, "export notification delivery confirmed", "instance_id", req.InstanceID, "to", result.ToEmail, "message_id", result.MessageID,
		"deliver_status", result.DeliverStatus, "delivered", result.EmailDelivered)
	return result, nil
}

func (Activities) DeleteCOSObject(ctx context.Context, req COSDeleteRequest, cfg TencentConfig) (COSDeleteResult, error) {
	logActivity(ctx, "deleting COS rescue object", "instance_id", req.InstanceID, "object_key", req.ObjectKey, "object_url", req.ObjectURL)
	result, err := DeleteCOSObject(ctx, cfg, req, false)
	if err != nil {
		return COSDeleteResult{}, err
	}
	logActivity(ctx, "COS rescue object delete complete", "instance_id", req.InstanceID, "object_key", result.ObjectKey, "deleted", result.Deleted)
	return result, nil
}

func BuildSCPCommand(req ExportRequest, host, remotePath, localPath string) []string {
	return []string{"ssh-native-copy", "-P", fmt.Sprintf("%d", req.SSHPort), fmt.Sprintf("%s@%s:%s", req.SSHUser, host, remotePath), localPath}
}

func BuildSSHCommand(req ExportRequest, host, remoteCommand string) []string {
	return []string{"ssh-native", "-p", fmt.Sprintf("%d", req.SSHPort), fmt.Sprintf("%s@%s", req.SSHUser, host), remoteCommand}
}

func runSSHCommand(req ExportRequest, host string, remoteCommand string, stdin string) (string, string, error) {
	client, err := dialSSH(req, host)
	if err != nil {
		return "", "", err
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		return "", "", err
	}
	defer session.Close()

	if stdin != "" {
		session.Stdin = strings.NewReader(stdin)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	err = session.Run(remoteCommand)
	return stdout.String(), stderr.String(), err
}

func copyRemoteFile(req ExportRequest, host string, remotePath string, localPath string) (string, error) {
	client, err := dialSSH(req, host)
	if err != nil {
		return "", err
	}
	defer client.Close()

	tmpPath := localPath + ".tmp"
	file, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}

	session, err := client.NewSession()
	if err != nil {
		file.Close()
		os.Remove(tmpPath)
		return "", err
	}
	defer session.Close()

	var stderr bytes.Buffer
	session.Stdout = file
	session.Stderr = &stderr
	runErr := session.Run("cat -- " + shellQuote(remotePath))
	closeErr := file.Close()
	if runErr != nil {
		os.Remove(tmpPath)
		return stderr.String(), runErr
	}
	if closeErr != nil {
		os.Remove(tmpPath)
		return stderr.String(), closeErr
	}
	return stderr.String(), os.Rename(tmpPath, localPath)
}

func dialSSH(req ExportRequest, host string) (*ssh.Client, error) {
	if req.StrictHostKeyChecking {
		return nil, fmt.Errorf("strict host key checking is not implemented for native SSH; omit --strict-host-key-checking")
	}
	auth, err := sshAuthMethods(req)
	if err != nil {
		return nil, err
	}
	config := &ssh.ClientConfig{
		User:            req.SSHUser,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}
	address := net.JoinHostPort(host, fmt.Sprintf("%d", req.SSHPort))
	return ssh.Dial("tcp", address, config)
}

func sshAuthMethods(req ExportRequest) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod
	if req.SSHPasswordEnv != "" {
		password := os.Getenv(req.SSHPasswordEnv)
		if password == "" {
			return nil, fmt.Errorf("%s is not set for SSH password auth", req.SSHPasswordEnv)
		}
		methods = append(methods, ssh.Password(password), ssh.KeyboardInteractive(passwordKeyboardInteractive(password)))
	}
	if req.SSHIdentityFile != "" {
		keyPath, err := expandLocalPath(req.SSHIdentityFile)
		if err != nil {
			return nil, err
		}
		key, err := os.ReadFile(keyPath)
		if err != nil {
			return nil, err
		}
		signer, err := ssh.ParsePrivateKey(key)
		if err != nil {
			return nil, err
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if len(methods) == 0 {
		return nil, fmt.Errorf("no SSH auth configured; set --ssh-password-env or --ssh-identity-file")
	}
	return methods, nil
}

func sshAuthDebug(req ExportRequest) string {
	parts := []string{}
	if req.SSHPasswordEnv != "" {
		password := os.Getenv(req.SSHPasswordEnv)
		parts = append(parts, fmt.Sprintf("password_env=%s password_len=%d password_sha256=%s", req.SSHPasswordEnv, len(password), shortSecretSHA256(password)))
	}
	if req.SSHIdentityFile != "" {
		parts = append(parts, fmt.Sprintf("identity_file=%s", req.SSHIdentityFile))
	}
	if len(parts) == 0 {
		return "auth=none"
	}
	return "auth=" + strings.Join(parts, " ")
}

func expandLocalPath(path string) (string, error) {
	if path == "~" {
		return os.UserHomeDir()
	}
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, path[2:]), nil
	}
	return filepath.Clean(path), nil
}

func passwordKeyboardInteractive(password string) ssh.KeyboardInteractiveChallenge {
	return func(_ string, _ string, questions []string, _ []bool) ([]string, error) {
		answers := make([]string, len(questions))
		for i := range answers {
			answers[i] = password
		}
		return answers, nil
	}
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func sshHost(req ExportRequest, instance InstanceInfo) string {
	if req.SSHHost != "" {
		return req.SSHHost
	}
	return instance.PublicIP
}

func trimForLog(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max] + "...<truncated>"
}
