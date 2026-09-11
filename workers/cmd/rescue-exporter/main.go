package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	stdlog "log"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/lightclaw/tencent-rescue-exporter/internal/rescue"
	"go.temporal.io/sdk/client"
	sdklog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"
	sdkworkflow "go.temporal.io/sdk/workflow"
)

const defaultTaskQueue = "tencent-cvm-rescue-export"

func main() {
	if len(os.Args) < 2 {
		usageAndExit()
	}

	switch os.Args[1] {
	case "worker":
		if err := runWorker(os.Args[2:]); err != nil {
			stdlog.Fatal(err)
		}
	case "start":
		if err := startWorkflow(os.Args[2:]); err != nil {
			stdlog.Fatal(err)
		}
	case "status":
		if err := queryWorkflowStatus(os.Args[2:]); err != nil {
			stdlog.Fatal(err)
		}
	case "cancel":
		if err := cancelWorkflow(os.Args[2:]); err != nil {
			stdlog.Fatal(err)
		}
	case "terminate":
		if err := terminateWorkflow(os.Args[2:]); err != nil {
			stdlog.Fatal(err)
		}
	default:
		usageAndExit()
	}
}

func usageAndExit() {
	fmt.Fprintf(os.Stderr, "usage: rescue-exporter <worker|start|status|cancel|terminate> [options]\n")
	os.Exit(2)
}

func cancelWorkflow(argv []string) error {
	fs := flag.NewFlagSet("cancel", flag.ExitOnError)
	temporal := addTemporalFlags(fs)
	workflowID := fs.String("workflow-id", "", "Workflow ID to cancel")
	runID := fs.String("run-id", "", "Optional run ID")
	fs.Parse(argv)
	if *workflowID == "" {
		return fmt.Errorf("--workflow-id is required")
	}
	tc, err := dialTemporal(*temporal)
	if err != nil {
		return err
	}
	defer tc.Close()
	return tc.CancelWorkflow(context.Background(), *workflowID, *runID)
}

func terminateWorkflow(argv []string) error {
	fs := flag.NewFlagSet("terminate", flag.ExitOnError)
	temporal := addTemporalFlags(fs)
	workflowID := fs.String("workflow-id", "", "Workflow ID to terminate")
	runID := fs.String("run-id", "", "Optional run ID")
	reason := fs.String("reason", "terminated by rescue-exporter operator", "Termination reason")
	fs.Parse(argv)
	if *workflowID == "" {
		return fmt.Errorf("--workflow-id is required")
	}
	tc, err := dialTemporal(*temporal)
	if err != nil {
		return err
	}
	defer tc.Close()
	return tc.TerminateWorkflow(context.Background(), *workflowID, *runID, *reason)
}

func runWorker(argv []string) error {
	fs := flag.NewFlagSet("worker", flag.ExitOnError)
	temporal := addTemporalFlags(fs)
	healthAddr := fs.String("health-addr", envDefault("WORKERS_HEALTH_ADDR", ":9090"), "HTTP health address for Kubernetes probes; empty disables")
	mode := fs.String("mode", envDefault("WORKER_MODE", "all"), "Workflow registration mode: all, rescue-export, or hermes-import")
	fs.Parse(argv)

	tc, err := dialTemporal(*temporal)
	if err != nil {
		return err
	}
	defer tc.Close()

	acts := rescue.Activities{}
	workerOptions, err := buildWorkerOptions()
	if err != nil {
		return err
	}
	w := worker.New(tc, temporal.TaskQueue, workerOptions)
	workerMode := strings.ToLower(strings.TrimSpace(*mode))
	if workerMode == "" {
		workerMode = "all"
	}
	registerExport := workerMode == "all" || workerMode == "rescue-export"
	registerImport := workerMode == "all" || workerMode == "hermes-import"
	if !registerExport && !registerImport {
		return fmt.Errorf("--mode must be all, rescue-export, or hermes-import")
	}
	if registerExport {
		w.RegisterWorkflow(rescue.ExportWorkflow)
		w.RegisterWorkflow(rescue.DeleteCOSObjectWorkflow)
	}
	if registerImport {
		w.RegisterWorkflow(rescue.ImportWorkflow)
	}
	w.RegisterActivityWithOptions(acts.LocateInstance, rescue.ActivityOptions("LocateInstance"))
	w.RegisterActivityWithOptions(acts.WaitInstanceRunning, rescue.ActivityOptions("WaitInstanceRunning"))
	w.RegisterActivityWithOptions(acts.WaitRescueTAT, rescue.ActivityOptions("WaitRescueTAT"))
	w.RegisterActivityWithOptions(acts.StartTATCommand, rescue.ActivityOptions("StartTATCommand"))
	w.RegisterActivityWithOptions(acts.WaitTATCommand, rescue.ActivityOptions("WaitTATCommand"))
	w.RegisterActivityWithOptions(acts.DeleteCOSObject, rescue.ActivityOptions("DeleteCOSObject"))
	if registerExport {
		w.RegisterActivityWithOptions(acts.EnterRescueMode, rescue.ActivityOptions("EnterRescueMode"))
		w.RegisterActivityWithOptions(acts.WaitRescueRunning, rescue.ActivityOptions("WaitRescueRunning"))
		w.RegisterActivityWithOptions(acts.WaitRescueSSH, rescue.ActivityOptions("WaitRescueSSH"))
		w.RegisterActivityWithOptions(acts.PrepareArchiveOverSSH, rescue.ActivityOptions("PrepareArchiveOverSSH"))
		w.RegisterActivityWithOptions(acts.PrepareArchiveOverTAT, rescue.ActivityOptions("PrepareArchiveOverTAT"))
		w.RegisterActivityWithOptions(acts.PrepareArchiveTATCommand, rescue.ActivityOptions("PrepareArchiveTATCommand"))
		w.RegisterActivityWithOptions(acts.PrepareMultipartArchive, rescue.ActivityOptions("PrepareMultipartArchive"))
		w.RegisterActivityWithOptions(acts.StartMultipartTATCommand, rescue.ActivityOptions("StartMultipartTATCommand"))
		w.RegisterActivityWithOptions(acts.AbortMultipartArchive, rescue.ActivityOptions("AbortMultipartArchive"))
		w.RegisterActivityWithOptions(acts.FinalizeArchiveOverTAT, rescue.ActivityOptions("FinalizeArchiveOverTAT"))
		w.RegisterActivityWithOptions(acts.SCPArchive, rescue.ActivityOptions("SCPArchive"))
		w.RegisterActivityWithOptions(acts.CleanupRemoteArchive, rescue.ActivityOptions("CleanupRemoteArchive"))
		w.RegisterActivityWithOptions(acts.ExitRescueMode, rescue.ActivityOptions("ExitRescueMode"))
		w.RegisterActivityWithOptions(acts.SendExportNotificationEmail, rescue.ActivityOptions("SendExportNotificationEmail"))
		w.RegisterActivityWithOptions(acts.ConfirmExportNotificationDelivered, rescue.ActivityOptions("ConfirmExportNotificationDelivered"))
		w.RegisterActivityWithOptions(acts.SendFailureNotification, rescue.ActivityOptions("SendFailureNotification"))
	}
	if registerImport {
		w.RegisterActivityWithOptions(acts.PrepareImportTATCommand, rescue.ActivityOptions("PrepareImportTATCommand"))
		w.RegisterActivityWithOptions(acts.FinalizeImportOverTAT, rescue.ActivityOptions("FinalizeImportOverTAT"))
		w.RegisterActivityWithOptions(acts.SendImportNotificationEmail, rescue.ActivityOptions("SendImportNotificationEmail"))
		if !registerExport {
			w.RegisterActivityWithOptions(acts.ConfirmExportNotificationDelivered, rescue.ActivityOptions("ConfirmExportNotificationDelivered"))
			w.RegisterActivityWithOptions(acts.SendFailureNotification, rescue.ActivityOptions("SendFailureNotification"))
		}
	}

	if *healthAddr != "" {
		stopHealth := startHealthServer(*healthAddr)
		defer stopHealth()
	}
	stdlog.Printf("worker listening on task_queue=%s mode=%s", temporal.TaskQueue, workerMode)
	return w.Run(worker.InterruptCh())
}

func buildWorkerOptions() (worker.Options, error) {
	deploymentName := strings.TrimSpace(os.Getenv("TEMPORAL_DEPLOYMENT_NAME"))
	buildID := strings.TrimSpace(os.Getenv("TEMPORAL_WORKER_BUILD_ID"))
	if deploymentName == "" && buildID == "" {
		return worker.Options{}, nil
	}
	if deploymentName == "" || buildID == "" {
		return worker.Options{}, fmt.Errorf("TEMPORAL_DEPLOYMENT_NAME and TEMPORAL_WORKER_BUILD_ID must be set together")
	}
	return worker.Options{
		DeploymentOptions: worker.DeploymentOptions{
			UseVersioning: true,
			Version: worker.WorkerDeploymentVersion{
				DeploymentName: deploymentName,
				BuildID:        buildID,
			},
			DefaultVersioningBehavior: sdkworkflow.VersioningBehaviorPinned,
		},
	}, nil
}

func startHealthServer(addr string) func() {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", writeOK)
	mux.HandleFunc("/readyz", writeOK)
	server := &http.Server{Addr: addr, Handler: mux}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			stdlog.Printf("health server stopped unexpectedly: %v", err)
		}
	}()
	stdlog.Printf("health server listening on %s", addr)
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}
}

func writeOK(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

func startWorkflow(argv []string) error {
	fs := flag.NewFlagSet("start", flag.ExitOnError)
	temporal := addTemporalFlags(fs)
	req, cfg := addStartFlags(fs)
	fs.Parse(argv)

	userProvidedRemotePaths := len(req.RemotePaths) > 0
	req.DeviceGlobs = splitRepeated(req.DeviceGlobs, []string{"/dev/vda*", "/dev/vdb*"})
	req.ArchiveMode = strings.ToLower(strings.TrimSpace(req.ArchiveMode))
	if req.ArchiveMode == "" {
		req.ArchiveMode = rescue.ArchiveModeHermes
	}
	if req.ArchiveMode != rescue.ArchiveModeHermes && req.ArchiveMode != rescue.ArchiveModeGeneric {
		return fmt.Errorf("--archive-mode must be hermes or generic")
	}
	defaultRemotePaths := []string{"/home/agentuser/.hermes"}
	if req.ArchiveMode == rescue.ArchiveModeGeneric {
		defaultRemotePaths = []string{"/"}
	}
	req.RemotePaths = splitRepeated(req.RemotePaths, defaultRemotePaths)
	cfg.RegionCandidates = splitRepeated(cfg.RegionCandidates, rescue.CommonRegions)
	if req.Execute && !req.Confirmed {
		return fmt.Errorf("--execute requires --i-understand-this-enters-rescue-mode-and-copies-data")
	}
	if req.Execute && req.ArchiveMode == rescue.ArchiveModeGeneric && !userProvidedRemotePaths {
		return fmt.Errorf("--execute requires at least one explicit --remote-path; refusing to export / by default")
	}
	if req.ArchiveMode == rescue.ArchiveModeHermes && len(req.RemotePaths) != 1 {
		return fmt.Errorf("--archive-mode hermes requires exactly one --remote-path")
	}
	req.CommandTransport = strings.ToLower(strings.TrimSpace(req.CommandTransport))
	if req.CommandTransport == "" {
		req.CommandTransport = "tat"
	}
	if req.CommandTransport != "tat" && req.CommandTransport != "ssh" {
		return fmt.Errorf("--command-transport must be tat or ssh")
	}
	if req.Execute && req.CommandTransport == "tat" && req.COSUploadBucket == "" {
		return fmt.Errorf("--command-transport tat requires --cos-upload-bucket-url; bucket creation is outside this workflow")
	}

	tc, err := dialTemporal(*temporal)
	if err != nil {
		return err
	}
	defer tc.Close()

	req.SearchAttributes = discoverRescueSearchAttributes(context.Background(), tc)
	workflowID := fmt.Sprintf("rescue-export-%s-%d", req.InstanceID, time.Now().Unix())
	opts := client.StartWorkflowOptions{
		ID:               workflowID,
		TaskQueue:        temporal.TaskQueue,
		SearchAttributes: initialRescueSearchAttributes(*req),
	}
	run, err := tc.ExecuteWorkflow(context.Background(), opts, rescue.ExportWorkflow, *req, *cfg)
	if err != nil {
		return err
	}
	var result rescue.ExportResult
	if err := run.Get(context.Background(), &result); err != nil {
		return err
	}
	fmt.Printf("workflow_id=%s run_id=%s\n", run.GetID(), run.GetRunID())
	fmt.Printf("result=%+v\n", result)
	return nil
}

func queryWorkflowStatus(argv []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	temporal := addTemporalFlags(fs)
	workflowID := fs.String("workflow-id", "", "Workflow ID to query")
	runID := fs.String("run-id", "", "Optional run ID")
	fs.Parse(argv)
	if *workflowID == "" {
		return fmt.Errorf("--workflow-id is required")
	}
	tc, err := dialTemporal(*temporal)
	if err != nil {
		return err
	}
	defer tc.Close()
	encoded, err := tc.QueryWorkflow(context.Background(), *workflowID, *runID, rescue.ExportStatusQuery)
	if err != nil {
		return err
	}
	var status rescue.ExportStatus
	if err := encoded.Get(&status); err != nil {
		return err
	}
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

func discoverRescueSearchAttributes(ctx context.Context, tc client.Client) []string {
	resp, err := tc.GetSearchAttributes(ctx)
	if err != nil {
		stdlog.Printf("warning: cannot discover Temporal search attributes; visibility upserts disabled: %v", err)
		return nil
	}
	available := map[string]bool{}
	for key := range resp.Keys {
		available[key] = true
	}
	enabled := []string{}
	missing := []string{}
	for _, key := range rescue.RescueSearchAttributeNames() {
		if available[key] {
			enabled = append(enabled, key)
		} else {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		stdlog.Printf("warning: Temporal search attributes not registered; skipping: %s", strings.Join(missing, ","))
	}
	return enabled
}

func initialRescueSearchAttributes(req rescue.ExportRequest) map[string]interface{} {
	attrs := map[string]interface{}{}
	if searchAttributeEnabled(req, rescue.SearchAttrInstanceID) {
		attrs[rescue.SearchAttrInstanceID] = req.InstanceID
	}
	if searchAttributeEnabled(req, rescue.SearchAttrRegion) && req.Region != "" {
		attrs[rescue.SearchAttrRegion] = req.Region
	}
	if searchAttributeEnabled(req, rescue.SearchAttrPhase) {
		attrs[rescue.SearchAttrPhase] = rescue.PhaseLocating
	}
	if len(attrs) == 0 {
		return nil
	}
	return attrs
}

func searchAttributeEnabled(req rescue.ExportRequest, key string) bool {
	for _, enabled := range req.SearchAttributes {
		if enabled == key {
			return true
		}
	}
	return false
}

func addTemporalFlags(fs *flag.FlagSet) *rescue.TemporalConfig {
	cfg := &rescue.TemporalConfig{}
	fs.StringVar(&cfg.Address, "temporal-address", envDefault("TEMPORAL_ADDRESS", "temporal-frontend.lightclaw.tech:443"), "Temporal frontend address")
	fs.StringVar(&cfg.Namespace, "temporal-namespace", envDefault("TEMPORAL_NAMESPACE", "default"), "Temporal namespace")
	fs.BoolVar(&cfg.TLS, "temporal-tls", envBoolDefault("TEMPORAL_TLS", true), "Enable TLS for Temporal")
	cfg.AuthToken = strings.TrimSpace(envDefault("TEMPORAL_BEARER_TOKEN", os.Getenv("TEMPORAL_AUTH_TOKEN")))
	fs.StringVar(&cfg.TaskQueue, "task-queue", envDefault("TEMPORAL_TASK_QUEUE", defaultTaskQueue), "Temporal task queue")
	return cfg
}

func addStartFlags(fs *flag.FlagSet) (*rescue.ExportRequest, *rescue.TencentConfig) {
	req := &rescue.ExportRequest{InstanceID: "ins-0fverxpd", RescueUsername: "root", RescuePasswordEnv: "RESCUE_PASSWORD", StopType: rescue.DefaultRescueStopType, CommandTransport: "tat", SSHUser: "root", SSHPort: 22, TATUsername: "root", TATWorkingDirectory: "/root", TATWaitTimeoutSeconds: 180, COSUploadRegion: "ap-beijing", COSUploadKeyPrefix: "rescue-exports", COSUploadURLTTLSeconds: 28800, LocalOutputDir: "./exports", MountRoot: "/mnt/rescue-root", RemoteWorkDir: "/root", ArchiveMode: rescue.ArchiveModeHermes, WaitTimeoutSeconds: rescue.DefaultRescueWaitTimeoutSeconds, CommandTimeoutSeconds: 1800}
	cfg := &rescue.TencentConfig{}
	fs.StringVar(&cfg.CredentialFile, "credential-file", "", "Optional Tencent credential JSON; env vars take precedence")
	fs.StringVar(&req.InstanceID, "instance-id", req.InstanceID, "Tencent CVM instance ID")
	fs.StringVar(&req.Region, "region", "", "Tencent region. If empty, common regions are probed")
	fs.Var((*appendFlag)(&cfg.RegionCandidates), "region-candidate", "Region candidate for probing; repeatable or comma-separated")
	fs.StringVar(&req.RescueUsername, "rescue-username", req.RescueUsername, "Rescue-mode username")
	fs.StringVar(&req.RescuePasswordEnv, "rescue-password-env", req.RescuePasswordEnv, "Env var holding rescue-mode password")
	fs.StringVar(&req.StopType, "stop-type", req.StopType, "Tencent rescue stop type: SOFT, HARD, SOFT_FIRST")
	fs.BoolVar(&req.ReenterRescue, "reenter-rescue", false, "If already in rescue mode, exit and re-enter to reset rescue password")
	fs.Var((*appendFlag)(&req.DeviceGlobs), "device-glob", "Block device glob to mount; repeatable or comma-separated")
	fs.StringVar(&req.ArchiveMode, "archive-mode", req.ArchiveMode, "Archive mode: hermes creates a hermes import-compatible zip; generic creates the legacy tar.gz")
	fs.Var((*appendFlag)(&req.RemotePaths), "remote-path", "Path on rescued disk to archive. In hermes mode defaults to /home/agentuser/.hermes and must resolve to one Hermes home; in generic mode repeatable or comma-separated")
	fs.StringVar(&req.MountRoot, "mount-root", req.MountRoot, "Mount path inside rescue OS")
	fs.StringVar(&req.RemoteWorkDir, "remote-work-dir", req.RemoteWorkDir, "Remote directory for temporary archive")
	fs.StringVar(&req.LocalOutputDir, "local-output-dir", req.LocalOutputDir, "Local directory for copied archive")
	fs.StringVar(&req.CommandTransport, "command-transport", req.CommandTransport, "Remote command transport: tat or ssh")
	fs.StringVar(&req.SSHHost, "ssh-host", "", "Host/IP for scp. Defaults to instance public IP")
	fs.StringVar(&req.SSHUser, "ssh-user", req.SSHUser, "SSH user for scp")
	fs.IntVar(&req.SSHPort, "ssh-port", req.SSHPort, "SSH port for scp")
	fs.StringVar(&req.SSHIdentityFile, "ssh-identity-file", "", "SSH private key for scp")
	fs.StringVar(&req.SSHPasswordEnv, "ssh-password-env", "", "Use sshpass with this env var for scp password auth")
	fs.BoolVar(&req.StrictHostKeyChecking, "strict-host-key-checking", false, "Enable strict SSH host-key checking")
	fs.Var((*appendFlag)(&req.SCPExtraOptions), "scp-option", "Extra scp -o option; repeatable or comma-separated")
	fs.StringVar(&req.TATUsername, "tat-username", req.TATUsername, "TAT command execution user")
	fs.StringVar(&req.TATWorkingDirectory, "tat-working-directory", req.TATWorkingDirectory, "TAT command working directory")
	fs.IntVar(&req.TATWaitTimeoutSeconds, "tat-wait-timeout-seconds", req.TATWaitTimeoutSeconds, "Timeout for TAT agent to become online")
	fs.StringVar(&req.TATOutputCOSBucketURL, "tat-output-cos-bucket-url", "", "Optional COS bucket URL for full TAT command output")
	fs.StringVar(&req.TATOutputCOSKeyPrefix, "tat-output-cos-key-prefix", "", "Optional COS key prefix for full TAT command output")
	fs.StringVar(&req.COSUploadBucket, "cos-upload-bucket-url", "", "Existing COS bucket URL for signed archive upload")
	fs.StringVar(&req.COSUploadRegion, "cos-upload-region", req.COSUploadRegion, "COS upload bucket region")
	fs.StringVar(&req.COSUploadKeyPrefix, "cos-upload-key-prefix", req.COSUploadKeyPrefix, "COS object key prefix for rescue archive upload")
	fs.IntVar(&req.COSUploadURLTTLSeconds, "cos-upload-url-ttl-seconds", req.COSUploadURLTTLSeconds, "TTL for signed COS upload URL")
	fs.BoolVar(&req.KeepRemoteArchive, "keep-remote-archive", false, "Do not delete the temporary archive from rescue OS")
	fs.BoolVar(&req.DisableCOSAutoDelete, "disable-cos-auto-delete", false, "Do not schedule automatic COS object deletion after signed URL TTL")
	fs.StringVar(&req.NotificationEmail, "notification-email", "", "Email address to notify when export succeeds with COS download link")
	fs.IntVar(&req.WaitTimeoutSeconds, "wait-timeout-seconds", req.WaitTimeoutSeconds, "Timeout for rescue boot wait")
	fs.IntVar(&req.CommandTimeoutSeconds, "command-timeout-seconds", req.CommandTimeoutSeconds, "Timeout for SSH/scp commands")
	fs.BoolVar(&req.Execute, "execute", false, "Actually enter rescue mode and copy data. Default is dry-run")
	fs.BoolVar(&req.Confirmed, "i-understand-this-enters-rescue-mode-and-copies-data", false, "Required with --execute")
	return req, cfg
}

func dialTemporal(cfg rescue.TemporalConfig) (client.Client, error) {
	options := client.Options{
		HostPort:  cfg.Address,
		Namespace: cfg.Namespace,
		Logger:    sdklog.NewStructuredLogger(slog.New(slog.NewTextHandler(os.Stderr, nil))),
	}
	if cfg.TLS {
		options.ConnectionOptions.TLS = &tls.Config{ServerName: strings.Split(cfg.Address, ":")[0]}
	}
	options.ConnectionOptions.GetSystemInfoTimeout = 30 * time.Second
	if cfg.AuthToken != "" {
		options.HeadersProvider = bearerHeadersProvider{token: cfg.AuthToken}
	}
	return client.Dial(options)
}

type bearerHeadersProvider struct {
	token string
}

func (b bearerHeadersProvider) GetHeaders(context.Context) (map[string]string, error) {
	return map[string]string{"authorization": "Bearer " + b.token}, nil
}

type appendFlag []string

func (f *appendFlag) String() string { return strings.Join(*f, ",") }

func (f *appendFlag) Set(value string) error {
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			*f = append(*f, item)
		}
	}
	return nil
}

func splitRepeated(values []string, defaults []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			item = strings.TrimSpace(item)
			if item != "" {
				out = append(out, item)
			}
		}
	}
	if len(out) == 0 {
		return defaults
	}
	return out
}

func envDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envBoolDefault(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes" || value == "on"
}
