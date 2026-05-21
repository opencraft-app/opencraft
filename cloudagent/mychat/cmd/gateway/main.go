package main

import (
	"flag"
	"log"
	"os"
	"strings"

	"mychat/internal/gateway"
)

func main() {
	addr := flag.String("addr", envOr("MYCHAT_ADDR", "127.0.0.1:8765"), "HTTP listen address")
	staticDir := flag.String("static", envOr("MYCHAT_STATIC_DIR", "dist"), "static frontend directory")
	command := flag.String("command", envOr("MYCHAT_ACP_COMMAND", "hermes acp"), "ACP agent command")
	token := flag.String("token", os.Getenv("MYCHAT_TOKEN"), "token required for non-loopback binds")
	fileAPIBaseURL := flag.String("file-api", os.Getenv("MYCHAT_FILE_API_BASE_URL"), "optional HTTP base URL that serves OpenAI-compatible /v1/files")
	flag.Parse()

	cfg := gateway.Config{
		Addr:           *addr,
		StaticDir:      *staticDir,
		Command:        splitCommand(*command),
		Token:          *token,
		FileAPIBaseURL: *fileAPIBaseURL,
	}
	if err := gateway.Run(cfg); err != nil {
		log.Fatal(err)
	}
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func splitCommand(command string) []string {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return []string{"hermes", "acp"}
	}
	return fields
}
