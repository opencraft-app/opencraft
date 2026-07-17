package e2e

type transparentTrafficGoldenCase struct {
	Name        string
	Description string
}

func transparentTrafficGoldenCases() []transparentTrafficGoldenCase {
	return []transparentTrafficGoldenCase{
		{
			Name:        "openai_non_stream_chat",
			Description: "OpenAI-compatible non-streaming chat is proxied without body or status mutation.",
		},
		{
			Name:        "openai_stream_chat",
			Description: "OpenAI-compatible streaming chat stays as SSE and is flushed through the gateway.",
		},
		{
			Name:        "upstream_error_shape",
			Description: "new-api or upstream error status/body is returned through the gateway without being wrapped.",
		},
		{
			Name:        "large_request_body",
			Description: "Large JSON request bodies are passed to new-api, which remains responsible for request limits.",
		},
		{
			Name:        "byok_first_private_key",
			Description: "BYOK-first users route through their private new-api channels and do not spend paid balance.",
		},
		{
			Name:        "platform_first_key",
			Description: "Platform-first users route through platform new-api channels even when BYOK providers exist.",
		},
		{
			Name:        "split_traffic_process",
			Description: "The traffic process serves /v1 traffic from Redis route snapshots without exposing control APIs.",
		},
	}
}
