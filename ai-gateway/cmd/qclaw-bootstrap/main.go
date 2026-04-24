package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/qclawbootstrap"
	"github.com/joho/godotenv"
)

func main() {
	var (
		qclawConfigPath = flag.String("qclaw-config", defaultQClawConfigPath(), "Path to the QClaw/OpenClaw config JSON")
		aiGatewayBase   = flag.String("ai-gateway-base-url", "http://127.0.0.1:18080", "Base URL for ai-gateway admin API")
		aiGatewayEnv    = flag.String("ai-gateway-env", ".env", "Path to ai-gateway env file used to discover ADMIN_TOKEN")
		adminToken      = flag.String("admin-token", "", "Admin token for ai-gateway; falls back to ADMIN_TOKEN or .env")
		providerName    = flag.String("provider-name", "qclaw-local", "Provider name to create or update in ai-gateway")
		targetModel     = flag.String("target-model", "openclaw:main", "Model exposed by the local QClaw gateway")
		aliasModel      = flag.String("alias-model", "", "Optional model alias to map to the QClaw provider")
		dryRun          = flag.Bool("dry-run", false, "Preview changes without writing config or calling ai-gateway")
	)
	flag.Parse()

	token := strings.TrimSpace(*adminToken)
	if token == "" {
		token = strings.TrimSpace(os.Getenv("ADMIN_TOKEN"))
	}
	if token == "" && *aiGatewayEnv != "" {
		if envMap, err := godotenv.Read(*aiGatewayEnv); err == nil {
			token = strings.TrimSpace(envMap["ADMIN_TOKEN"])
		}
	}
	if token == "" && !*dryRun {
		fail("missing ai-gateway admin token; pass --admin-token, set ADMIN_TOKEN, or point --ai-gateway-env at a valid .env")
	}

	original, err := os.ReadFile(*qclawConfigPath)
	if err != nil {
		fail("read qclaw config: %v", err)
	}

	updated, state, changed, err := qclawbootstrap.EnsureChatCompletionsEnabled(original)
	if err != nil {
		fail("validate qclaw config: %v", err)
	}

	if !*dryRun && changed {
		if err := os.WriteFile(*qclawConfigPath, updated, 0o600); err != nil {
			fail("write qclaw config: %v", err)
		}
	}

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", state.Port)
	providerPayload := qclawbootstrap.BuildProviderPayload(*providerName, baseURL, state.Token, *targetModel)

	fmt.Printf("QClaw config: %s\n", *qclawConfigPath)
	fmt.Printf("QClaw gateway base URL: %s\n", baseURL)
	if changed {
		fmt.Println("QClaw config updated: enabled gateway.http.endpoints.chatCompletions.enabled and enforced loopback bind")
	} else {
		fmt.Println("QClaw config already enabled for chat completions on loopback")
	}

	if err := probeQClaw(baseURL, state.Token, *targetModel); err != nil {
		fmt.Printf("QClaw probe warning: %v\n", err)
		fmt.Println("If you just changed the config, restart QClaw or the OpenClaw gateway before using the provider.")
	} else {
		fmt.Println("QClaw probe: chat completions endpoint responded successfully")
	}

	if *dryRun {
		fmt.Println("Dry run: skipped ai-gateway provider registration")
		return
	}

	client := qclawbootstrap.NewClient(*aiGatewayBase, token)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	providerID, err := client.UpsertProvider(ctx, providerPayload)
	if err != nil {
		fail("upsert ai-gateway provider: %v", err)
	}
	fmt.Printf("ai-gateway provider ready: %s (%s)\n", *providerName, providerID)

	if alias := strings.TrimSpace(*aliasModel); alias != "" {
		if err := client.UpsertModelMapping(ctx, qclawbootstrap.BuildMappingPayload(alias, providerID)); err != nil {
			fail("upsert model mapping: %v", err)
		}
		fmt.Printf("ai-gateway model mapping ready: %s -> %s\n", alias, *targetModel)
	}
}

func probeQClaw(baseURL, token, model string) error {
	body := strings.NewReader(fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"reply with ok"}]}`, model))
	req, err := http.NewRequest(http.MethodPost, baseURL+"/v1/chat/completions", body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("status=%d", resp.StatusCode)
	}
	return nil
}

func defaultQClawConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".qclaw/openclaw.json"
	}
	return filepath.Join(home, ".qclaw", "openclaw.json")
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
