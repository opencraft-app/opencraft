package wrapper

import "strings"

type CloudAgentRunEndpoint struct {
	Method      string
	Path        string
	OperationID string
	Summary     string
	Description string
}

type CloudAgentRunProtocolSpec struct {
	Object    string
	Protocol  string
	Version   string
	Features  []string
	Endpoints []CloudAgentRunEndpoint
}

func CloudAgentRunSpec() CloudAgentRunProtocolSpec {
	return CloudAgentRunProtocolSpec{
		Object:   "cloudagent.capabilities",
		Protocol: "cloudagent.session_events",
		Version:  "v1",
		Features: []string{
			"session_create",
			"session_load",
			"session_list",
			"session_event_submit",
			"session_event_replay",
			"session_event_stream",
			"session_close",
			"idempotency_key",
			"client_event_id",
			"last_event_id_replay",
			"after_id_replay",
			"sse_event_stream",
			"internal_run_ledger",
			"cancel",
		},
		Endpoints: []CloudAgentRunEndpoint{
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/capabilities",
				OperationID: "getCloudAgentCapabilities",
				Summary:     "Get CloudAgent capabilities",
				Description: "Probe CloudAgent HTTP session-event protocol support and feature flags. 探测 CloudAgent HTTP 会话事件协议支持和功能开关。",
			},
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/sessions",
				OperationID: "listCloudAgentSessions",
				Summary:     "List CloudAgent sessions",
				Description: "List caller-scoped CloudAgent sessions. 列出调用方作用域内的 CloudAgent 会话。",
			},
			{
				Method:      "POST",
				Path:        "/v1/cloudagent/sessions",
				OperationID: "createCloudAgentSession",
				Summary:     "Create CloudAgent session",
				Description: "Create a CloudAgent session in the caller scope. 在调用方作用域内创建 CloudAgent 会话。",
			},
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/sessions/{session_id}",
				OperationID: "loadCloudAgentSession",
				Summary:     "Load CloudAgent session",
				Description: "Load a caller-scoped CloudAgent session. 加载调用方作用域内的 CloudAgent 会话。",
			},
			{
				Method:      "POST",
				Path:        "/v1/cloudagent/sessions/{session_id}/close",
				OperationID: "closeCloudAgentSession",
				Summary:     "Close CloudAgent session runtime",
				Description: "Persist and release the runtime for a caller-scoped CloudAgent session without deleting the session identity. 贮藏并释放调用方作用域内 CloudAgent 会话的运行时，但不删除会话身份。",
			},
			{
				Method:      "POST",
				Path:        "/v1/cloudagent/sessions/{session_id}/events",
				OperationID: "submitCloudAgentSessionEvents",
				Summary:     "Submit CloudAgent session events",
				Description: "Append public events, currently `user.message`, to a CloudAgent session. The gateway creates an internal run ledger entry. 向 CloudAgent 会话追加公开事件，目前支持 `user.message`；Gateway 会创建内部 run ledger。",
			},
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/sessions/{session_id}/events",
				OperationID: "listCloudAgentSessionEvents",
				Summary:     "List CloudAgent session events",
				Description: "Replay public session events after a committed cursor. 按游标回放公开会话事件。",
			},
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/sessions/{session_id}/events/stream",
				OperationID: "streamCloudAgentSessionEvents",
				Summary:     "Stream CloudAgent session events",
				Description: "Stream public session events with Server-Sent Events. 使用 Server-Sent Events 读取公开会话事件流。",
			},
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/runs",
				OperationID: "listCloudAgentRuns",
				Summary:     "List CloudAgent runs",
				Description: "List caller-scoped durable runs, optionally filtered by session. 列出调用方作用域内的持久化运行，可按会话过滤。",
			},
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/runs/{run_id}",
				OperationID: "getCloudAgentRun",
				Summary:     "Get CloudAgent run",
				Description: "Read durable run status. 读取持久化运行状态。",
			},
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/runs/{run_id}/events",
				OperationID: "getCloudAgentRunEvents",
				Summary:     "Replay or stream CloudAgent run events",
				Description: "Replay run events after a committed sequence number. When `stream=true`, responses are Server-Sent Events with public CloudAgent event payloads. 在已提交序号之后回放运行事件；`stream=true` 时响应为 Server-Sent Events，并承载 CloudAgent 公开事件。",
			},
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/runs/{run_id}/result",
				OperationID: "getCloudAgentRunResult",
				Summary:     "Get CloudAgent run result",
				Description: "Read the final durable run result. 读取最终持久化运行结果。",
			},
			{
				Method:      "POST",
				Path:        "/v1/cloudagent/runs/{run_id}/cancel",
				OperationID: "cancelCloudAgentRun",
				Summary:     "Cancel CloudAgent run",
				Description: "Request cancellation for a durable run. 请求取消持久化运行。",
			},
		},
	}
}

func (spec CloudAgentRunProtocolSpec) EndpointStrings() []string {
	out := make([]string, 0, len(spec.Endpoints)+1)
	for _, endpoint := range spec.Endpoints {
		out = append(out, endpoint.Method+" "+endpoint.Path)
		if endpoint.Path == "/v1/cloudagent/sessions/{session_id}/events" {
			out = append(out,
				"GET /v1/cloudagent/sessions/{session_id}/events?after_seq=N",
				"GET /v1/cloudagent/sessions/{session_id}/events?after_id=evt_x",
			)
		}
	}
	return out
}

func CloudAgentOpenAPISpec() map[string]any {
	spec := CloudAgentRunSpec()
	paths := map[string]any{}
	for _, endpoint := range spec.Endpoints {
		method := strings.ToLower(endpoint.Method)
		pathItem, _ := paths[endpoint.Path].(map[string]any)
		if pathItem == nil {
			pathItem = map[string]any{}
			paths[endpoint.Path] = pathItem
		}
		pathItem[method] = cloudAgentOpenAPIOperation(endpoint)
	}
	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "CloudAgent Session Events API",
			"version":     spec.Version,
			"description": "Qoder-like CloudAgent HTTP protocol for sessions, public events, replay, and SSE streaming. 类 Qoder 的 CloudAgent HTTP 协议，用于会话、公开事件、回放和 SSE 流式读取。",
		},
		"servers": []any{
			map[string]any{"url": "http://21.6.84.6", "description": "Devcloud internal endpoint / Devcloud 内网入口"},
			map[string]any{"url": "http://cloudagent-gateway.dep.svc.cluster.local", "description": "Devcloud in-cluster endpoint / Devcloud 集群内入口"},
		},
		"security": []any{
			map[string]any{"bearerAuth": []any{}},
			map[string]any{"tenantProjectScope": []any{}},
		},
		"paths":      paths,
		"components": cloudAgentOpenAPIComponents(),
	}
}

func cloudAgentOpenAPIOperation(endpoint CloudAgentRunEndpoint) map[string]any {
	operation := map[string]any{
		"operationId": endpoint.OperationID,
		"summary":     endpoint.Summary,
		"description": endpoint.Description,
		"tags":        []any{"CloudAgent"},
		"responses":   cloudAgentOpenAPIResponses(endpoint.OperationID),
	}
	params := cloudAgentOpenAPIParameters(endpoint.Path, endpoint.OperationID)
	if len(params) > 0 {
		operation["parameters"] = params
	}
	if endpoint.OperationID == "createCloudAgentSession" {
		operation["requestBody"] = jsonRequestBody("#/components/schemas/CreateSessionRequest", false)
	}
	if endpoint.OperationID == "submitCloudAgentSessionEvents" {
		operation["requestBody"] = jsonRequestBody("#/components/schemas/SubmitSessionEventsRequest", true)
	}
	if endpoint.OperationID == "submitCloudAgentRun" {
		operation["requestBody"] = jsonRequestBody("#/components/schemas/SubmitRunRequest", true)
	}
	return operation
}

func cloudAgentOpenAPIParameters(path string, operationID string) []any {
	params := []any{}
	if strings.Contains(path, "{session_id}") {
		params = append(params, map[string]any{"$ref": "#/components/parameters/SessionID"})
	}
	if strings.Contains(path, "{run_id}") {
		params = append(params, map[string]any{"$ref": "#/components/parameters/RunID"})
	}
	switch operationID {
	case "listCloudAgentSessions", "listCloudAgentRuns":
		if operationID == "listCloudAgentRuns" {
			params = append(params, map[string]any{
				"name":     "session_id",
				"in":       "query",
				"required": false,
				"schema":   map[string]any{"type": "string"},
			})
		}
		params = append(params, map[string]any{
			"name":     "limit",
			"in":       "query",
			"required": false,
			"schema": map[string]any{
				"type":    "integer",
				"minimum": 1,
				"maximum": 200,
				"default": 50,
			},
		})
	case "loadCloudAgentSession":
		params = append(params, map[string]any{
			"name":     "cwd",
			"in":       "query",
			"required": false,
			"schema":   map[string]any{"type": "string", "default": "/workspace"},
		})
	case "submitCloudAgentSessionEvents", "submitCloudAgentRun":
		params = append(params, map[string]any{
			"name":        "Idempotency-Key",
			"in":          "header",
			"required":    false,
			"schema":      map[string]any{"type": "string"},
			"description": "Caller retry key scoped by tenant, project, and session. 调用方重试 key，作用域为租户、项目和会话。",
		})
	case "listCloudAgentSessionEvents", "streamCloudAgentSessionEvents", "getCloudAgentRunEvents":
		params = append(params,
			map[string]any{
				"name":     "after_seq",
				"in":       "query",
				"required": false,
				"schema":   map[string]any{"type": "integer", "minimum": 0, "default": 0},
			},
			map[string]any{
				"name":        "after_id",
				"in":          "query",
				"required":    false,
				"schema":      map[string]any{"type": "string"},
				"description": "SSE event id resume cursor. If present and `after_seq` is absent, the numeric suffix is used as the sequence cursor. SSE 事件 ID 恢复游标；当缺少 `after_seq` 时，使用 ID 的数字后缀作为序号游标。",
			},
			map[string]any{
				"name":        "Last-Event-ID",
				"in":          "header",
				"required":    false,
				"schema":      map[string]any{"type": "string"},
				"description": "Standard SSE resume header used when `after_seq` and `after_id` are absent. 标准 SSE 恢复 header；当 `after_seq` 和 `after_id` 都缺失时使用。",
			},
		)
		if operationID == "getCloudAgentRunEvents" {
			params = append(params, map[string]any{
				"name":     "stream",
				"in":       "query",
				"required": false,
				"schema":   map[string]any{"type": "boolean", "default": false},
			})
		}
	}
	return params
}

func cloudAgentOpenAPIResponses(operationID string) map[string]any {
	schema := "#/components/schemas/Run"
	description := "CloudAgent response. CloudAgent 响应。"
	switch operationID {
	case "getCloudAgentCapabilities":
		schema = "#/components/schemas/Capabilities"
		description = "CloudAgent capability metadata. CloudAgent 能力元数据。"
	case "listCloudAgentSessions":
		schema = "#/components/schemas/SessionList"
		description = "Caller-scoped session list. 调用方作用域内的会话列表。"
	case "createCloudAgentSession", "loadCloudAgentSession", "closeCloudAgentSession":
		schema = "#/components/schemas/Session"
		description = "CloudAgent session. CloudAgent 会话。"
	case "listCloudAgentRuns":
		schema = "#/components/schemas/RunList"
		description = "Caller-scoped run list. 调用方作用域内的运行列表。"
	case "submitCloudAgentSessionEvents", "listCloudAgentSessionEvents":
		schema = "#/components/schemas/EventList"
		description = "Public session events. 公开会话事件。"
	case "streamCloudAgentSessionEvents", "getCloudAgentRunEvents":
		return map[string]any{
			"200": map[string]any{
				"description": "Public events as Server-Sent Events. 以 Server-Sent Events 返回公开事件。",
				"content": map[string]any{
					"text/event-stream": map[string]any{"schema": map[string]any{"type": "string", "description": "Server-Sent Events. Each `data:` payload is a CloudAgent public event JSON object."}},
				},
			},
		}
	case "getCloudAgentRunResult":
		schema = "#/components/schemas/RunResult"
		description = "Final durable run result. 最终持久化运行结果。"
	case "cancelCloudAgentRun":
		schema = "#/components/schemas/CancelRunResponse"
		description = "Cancellation request result. 取消请求结果。"
	}
	return map[string]any{
		"200": map[string]any{
			"description": description,
			"content": map[string]any{
				"application/json": map[string]any{"schema": map[string]any{"$ref": schema}},
			},
		},
	}
}

func jsonRequestBody(schema string, required bool) map[string]any {
	return map[string]any{
		"required": required,
		"content": map[string]any{
			"application/json": map[string]any{
				"schema": map[string]any{"$ref": schema},
			},
		},
	}
}

func cloudAgentOpenAPIComponents() map[string]any {
	return map[string]any{
		"securitySchemes": map[string]any{
			"bearerAuth": map[string]any{"type": "http", "scheme": "bearer"},
			"tenantProjectScope": map[string]any{
				"type":        "apiKey",
				"in":          "header",
				"name":        "X-Tenant-ID",
				"description": "Use together with X-Project-ID.",
			},
		},
		"parameters": map[string]any{
			"SessionID": map[string]any{
				"name": "session_id", "in": "path", "required": true,
				"schema": map[string]any{"type": "string"},
			},
			"RunID": map[string]any{
				"name": "run_id", "in": "path", "required": true,
				"schema": map[string]any{"type": "string"},
			},
		},
		"schemas": map[string]any{
			"Capabilities": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"object":                 map[string]any{"type": "string", "const": "cloudagent.capabilities"},
					"protocol":               map[string]any{"type": "string", "const": "cloudagent.session_events"},
					"version":                map[string]any{"type": "string"},
					"run_protocol":           map[string]any{"type": "boolean"},
					"session_event_protocol": map[string]any{"type": "boolean"},
					"features":               map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
					"endpoints":              map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				},
				"required": []any{"object", "protocol", "version", "features", "endpoints"},
			},
			"CreateSessionRequest": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"cwd":               map[string]any{"type": "string", "default": "/workspace"},
					"agent_version":     map[string]any{"type": "string", "default": "builtin.v1"},
					"workspace_version": map[string]any{"type": "string", "default": "builtin.v1"},
				},
			},
			"Session": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"session_id":         map[string]any{"type": "string"},
					"state":              map[string]any{"type": "string"},
					"runtime_generation": map[string]any{"type": "integer"},
					"cwd":                map[string]any{"type": "string"},
					"closed":             map[string]any{"type": "boolean"},
				},
				"required": []any{"session_id"},
			},
			"SessionList": objectListSchema("#/components/schemas/Session"),
			"SubmitSessionEventsRequest": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"events": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"type":            map[string]any{"type": "string", "enum": []any{"user.message"}},
								"client_event_id": map[string]any{"type": "string"},
								"content": map[string]any{
									"type": "array",
									"items": map[string]any{
										"type": "object",
										"properties": map[string]any{
											"type": map[string]any{"type": "string", "enum": []any{"text"}},
											"text": map[string]any{"type": "string"},
										},
										"required": []any{"type", "text"},
									},
								},
							},
							"required": []any{"type", "content"},
						},
					},
				},
				"required": []any{"events"},
			},
			"SubmitRunRequest": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"run_id": map[string]any{
						"type":        "string",
						"description": "Legacy idempotency key field. The server still returns its own durable `run_id`. 兼容旧客户端的幂等 key 字段；服务端仍返回自己的持久化 `run_id`。",
					},
					"text":       map[string]any{"type": "string"},
					"cwd":        map[string]any{"type": "string", "default": "/workspace"},
					"inbox_mode": map[string]any{"type": "string", "enum": []any{"prompt", "steer", "follow_up"}},
				},
				"required": []any{"text"},
			},
			"Run": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"run_id":      map[string]any{"type": "string"},
					"session_id":  map[string]any{"type": "string"},
					"status":      map[string]any{"type": "string"},
					"stop_reason": map[string]any{"type": "string"},
					"error":       map[string]any{"type": "string"},
					"output_text": map[string]any{"type": "string"},
					"last_seq":    map[string]any{"type": "integer"},
					"created_at":  map[string]any{"type": "string"},
					"updated_at":  map[string]any{"type": "string"},
				},
				"required": []any{"run_id", "status"},
			},
			"RunList": objectListSchema("#/components/schemas/Run"),
			"RunEvent": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id":             map[string]any{"type": "string", "description": "Stable SSE event id with numeric sequence suffix."},
					"seq":            map[string]any{"type": "integer"},
					"type":           map[string]any{"type": "string", "enum": []any{"user.message", "agent.thinking", "agent.message", "agent.tool_use", "agent.tool_result", "session.status_idle", "session.error", "heartbeat"}},
					"run_id":         map[string]any{"type": "string"},
					"session_id":     map[string]any{"type": "string"},
					"schema_version": map[string]any{"type": "string"},
					"content":        map[string]any{},
					"thinking":       map[string]any{"type": "string"},
					"tool_use_id":    map[string]any{"type": "string"},
					"name":           map[string]any{"type": "string"},
					"input":          map[string]any{},
					"is_error":       map[string]any{"type": "boolean"},
					"status":         map[string]any{"type": "string"},
					"stop_reason":    map[string]any{},
					"error":          map[string]any{},
				},
				"required": []any{"seq", "type", "run_id"},
			},
			"EventList": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"run":    map[string]any{"$ref": "#/components/schemas/Run"},
					"object": map[string]any{"type": "string", "const": "list"},
					"data":   map[string]any{"type": "array", "items": map[string]any{"$ref": "#/components/schemas/RunEvent"}},
					"events": map[string]any{"type": "array", "items": map[string]any{"$ref": "#/components/schemas/RunEvent"}},
				},
				"required": []any{"events"},
			},
			"RunResult": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"run_id":      map[string]any{"type": "string"},
					"status":      map[string]any{"type": "string"},
					"output_text": map[string]any{"type": "string"},
					"error":       map[string]any{"type": "string"},
				},
				"required": []any{"run_id", "status"},
			},
			"CancelRunResponse": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"run_id":    map[string]any{"type": "string"},
					"cancelled": map[string]any{"type": "boolean"},
				},
				"required": []any{"run_id", "cancelled"},
			},
		},
	}
}

func objectListSchema(itemRef string) map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"object": map[string]any{"type": "string", "const": "list"},
			"data":   map[string]any{"type": "array", "items": map[string]any{"$ref": itemRef}},
		},
		"required": []any{"object", "data"},
	}
}
