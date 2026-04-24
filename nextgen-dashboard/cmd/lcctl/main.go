package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/command"
)

func main() {
	commandLine, err := resolveCommand(os.Args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	proxyURL := strings.TrimSpace(os.Getenv("NEXTGEN_PROXY_URL"))
	proxyToken := strings.TrimSpace(os.Getenv("NEXTGEN_PROXY_TOKEN"))
	if proxyURL == "" || proxyToken == "" {
		fmt.Fprintln(os.Stderr, "nextgen proxy environment is not configured")
		os.Exit(1)
	}

	body, err := json.Marshal(map[string]string{"command": commandLine})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	req, err := http.NewRequest(http.MethodPost, proxyURL, bytes.NewReader(body))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	req.Header.Set("Authorization", "Bearer "+proxyToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, resp.Status)
		os.Exit(1)
	}

	var result command.Result
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(result.Output)
}

func resolveCommand(args []string) (string, error) {
	exe := filepath.Base(args[0])
	switch exe {
	case "users", "subscriptions", "sandboxes":
		return strings.TrimSpace(strings.Join(append([]string{exe}, args[1:]...), " ")), nil
	}
	if len(args) < 2 {
		return "", fmt.Errorf("usage: lcctl <command...>")
	}
	return strings.TrimSpace(strings.Join(args[1:], " ")), nil
}
