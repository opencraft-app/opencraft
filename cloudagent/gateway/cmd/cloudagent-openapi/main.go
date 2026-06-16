package main

import (
	"encoding/json"
	"fmt"
	"os"

	"cloudagent/gateway/internal/wrapper"
)

func main() {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(wrapper.CloudAgentOpenAPISpec()); err != nil {
		fmt.Fprintf(os.Stderr, "encode cloudagent openapi: %v\n", err)
		os.Exit(1)
	}
}
