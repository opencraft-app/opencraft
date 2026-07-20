package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	regression "git.woa.com/wisp/mono2/llmgateway/test/regression/runner"
)

const maxTerminationSummaryBytes = 4000

func main() {
	os.Exit(run())
}

func run() (exitCode int) {
	var configPath, runID, cleanupRunID, jsonPath, junitPath string
	flag.StringVar(&configPath, "config", "/etc/llmgateway-regression/config.yaml", "regression YAML config")
	flag.StringVar(&runID, "run-id", "", "unique regression run ID")
	flag.StringVar(&cleanupRunID, "cleanup-run-id", "", "delete business resources retained by a failed run")
	flag.StringVar(&jsonPath, "json-report", "", "optional local JSON report path")
	flag.StringVar(&junitPath, "junit-report", "", "optional local JUnit report path")
	flag.Parse()

	sanitizerMessage := func(value string) string { return value }
	defer func() {
		if recovered := recover(); recovered != nil {
			fmt.Fprintf(os.Stderr, "REGRESSION_RESULT status=failed error=%s\n", sanitizerMessage(fmt.Sprintf("panic: %v", recovered)))
			exitCode = 1
		}
	}()
	file, err := os.Open(configPath)
	if err != nil {
		return fail(err)
	}
	cfg, err := regression.ParseConfig(file)
	_ = file.Close()
	if err != nil {
		return fail(err)
	}
	credentials, err := regression.CredentialsFromEnvironment()
	if err != nil {
		return fail(err)
	}
	secrets := []string{credentials.AdminToken, credentials.InternalToken}
	sanitizerMessage = func(value string) string {
		for _, secret := range secrets {
			value = strings.ReplaceAll(value, secret, "[REDACTED]")
		}
		return value
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if cleanupRunID != "" {
		userID, cleanupErr := regression.Cleanup(ctx, cfg, credentials, cleanupRunID)
		if cleanupErr != nil {
			fmt.Fprintf(os.Stderr, "REGRESSION_CLEANUP run_id=%s user_id=%s status=failed error=%s\n", cleanupRunID, userID, sanitizerMessage(cleanupErr.Error()))
			return 1
		}
		fmt.Printf("REGRESSION_CLEANUP run_id=%s user_id=%s status=passed\n", cleanupRunID, userID)
		return 0
	}
	if runID == "" {
		runID, err = newRunID()
		if err != nil {
			return fail(err)
		}
	}

	var kube *clients.KubernetesClient
	if strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST")) != "" {
		kube, err = clients.NewInClusterKubernetesClient(nil)
		if err != nil {
			return fail(err)
		}
	}
	fmt.Printf("REGRESSION_TARGET run_id=%s scenario=%s namespace=%s control=%s traffic=%s deployment=%s sets=%s\n",
		runID, cfg.Scenario, cfg.Target.Namespace, cfg.Target.ControlURL, cfg.Target.TrafficURL,
		cfg.Target.TrafficDeployment, strings.Join(cfg.Target.TargetSets, ","))
	execution, runErr := regression.Execute(ctx, cfg, credentials, kube, runID)
	if len(execution.JSON) > 0 {
		fmt.Printf("REGRESSION_REPORT_BEGIN\n%s\nREGRESSION_REPORT_END\n", execution.JSON)
	}
	if err := writeOptional(jsonPath, execution.JSON); err != nil {
		runErr = errors.Join(runErr, err)
	}
	if err := writeOptional(junitPath, execution.JUnit); err != nil {
		runErr = errors.Join(runErr, err)
	}
	if kube != nil {
		summary := fmt.Sprintf("run_id=%s scenario=%s status=%s report_stored=%t", runID, cfg.Scenario, execution.Report.Status, execution.ReportStored)
		if runErr != nil {
			summary += " error=" + sanitizerMessage(runErr.Error())
		}
		terminationPath := strings.TrimSpace(os.Getenv("LLMGATEWAY_REGRESSION_TERMINATION_LOG"))
		if terminationPath == "" {
			terminationPath = "/dev/termination-log"
		}
		if err := writeTerminationSummary(terminationPath, summary); err != nil {
			fmt.Fprintf(os.Stderr, "REGRESSION_TERMINATION_MESSAGE status=failed error=%s\n", sanitizerMessage(err.Error()))
		}
	}
	if runErr != nil {
		fmt.Fprintf(os.Stderr, "REGRESSION_RESULT run_id=%s status=%s report_stored=%t error=%s\n", runID, execution.Report.Status, execution.ReportStored, sanitizerMessage(runErr.Error()))
		return 1
	}
	fmt.Printf("REGRESSION_RESULT run_id=%s status=%s report_stored=%t report_sha256=%s\n", runID, execution.Report.Status, execution.ReportStored, execution.ReportHash)
	return 0
}

func newRunID() (string, error) {
	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%s", time.Now().UTC().Format("20060102t150405z"), hex.EncodeToString(random)), nil
}

func writeOptional(path string, data []byte) error {
	if strings.TrimSpace(path) == "" || len(data) == 0 {
		return nil
	}
	return os.WriteFile(path, data, 0o600)
}

func writeTerminationSummary(path, value string) error {
	value = strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
	value = strings.Join(strings.Fields(value), " ")
	if len(value) > maxTerminationSummaryBytes {
		value = value[:maxTerminationSummaryBytes]
		for !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
	}
	return os.WriteFile(path, []byte(value), 0o600)
}

func fail(err error) int {
	fmt.Fprintf(os.Stderr, "REGRESSION_RESULT status=failed error=%s\n", err)
	return 1
}
