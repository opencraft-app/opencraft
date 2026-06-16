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
		Protocol: "cloudagent.run",
		Version:  "v1",
		Features: []string{
			"session_create",
			"session_load",
			"session_list",
			"run_submit",
			"run_list",
			"idempotent_run_id",
			"after_seq_replay",
			"ndjson_event_stream",
			"durable_result",
			"cancel",
		},
		Endpoints: []CloudAgentRunEndpoint{
			{
				Method:      "GET",
				Path:        "/v1/cloudagent/capabilities",
				OperationID: "getCloudAgentCapabilities",
				Summary:     "Get CloudAgent capabilities",
				Description: "Probe CloudAgent HTTP Run protocol support and feature flags. 探测 CloudAgent HTTP Run 协议支持和功能开关。",
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
				Path:        "/v1/cloudagent/sessions/{session_id}/runs",
				OperationID: "submitCloudAgentRun",
				Summary:     "Submit CloudAgent run",
				Description: "Submit an idempotent durable run to a CloudAgent session. 向 CloudAgent 会话提交幂等的持久化运行。",
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
				Description: "Replay run events after a committed sequence number. When `stream=true`, responses are newline-delimited JSON. 在已提交序号之后回放运行事件；`stream=true` 时响应为 NDJSON。",
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
		if endpoint.Path == "/v1/cloudagent/runs/{run_id}/events" {
			out = append(out,
				"GET /v1/cloudagent/runs/{run_id}/events?after_seq=N",
				"GET /v1/cloudagent/runs/{run_id}/events?after_seq=N&stream=true",
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
			"title":       "CloudAgent HTTP Run API",
			"version":     spec.Version,
			"description": "Durable CloudAgent HTTP protocol for sessions, runs, replay, and results. 用于会话、运行、回放和结果读取的 CloudAgent 持久化 HTTP 协议。",
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
	case "getCloudAgentRunEvents":
		params = append(params,
			map[string]any{
				"name":     "after_seq",
				"in":       "query",
				"required": false,
				"schema":   map[string]any{"type": "integer", "minimum": 0, "default": 0},
			},
			map[string]any{
				"name":     "stream",
				"in":       "query",
				"required": false,
				"schema":   map[string]any{"type": "boolean", "default": false},
			},
		)
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
	case "createCloudAgentSession", "loadCloudAgentSession":
		schema = "#/components/schemas/Session"
		description = "CloudAgent session. CloudAgent 会话。"
	case "listCloudAgentRuns":
		schema = "#/components/schemas/RunList"
		description = "Caller-scoped run list. 调用方作用域内的运行列表。"
	case "getCloudAgentRunEvents":
		return map[string]any{
			"200": map[string]any{
				"description": "Run events as JSON or NDJSON depending on `stream`. 根据 `stream` 返回 JSON 或 NDJSON 运行事件。",
				"content": map[string]any{
					"application/json":     map[string]any{"schema": map[string]any{"$ref": "#/components/schemas/EventList"}},
					"application/x-ndjson": map[string]any{"schema": map[string]any{"$ref": "#/components/schemas/RunEvent"}},
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
					"object":       map[string]any{"type": "string", "const": "cloudagent.capabilities"},
					"protocol":     map[string]any{"type": "string", "const": "cloudagent.run"},
					"version":      map[string]any{"type": "string"},
					"run_protocol": map[string]any{"type": "boolean"},
					"features":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
					"endpoints":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				},
				"required": []any{"object", "protocol", "version", "run_protocol", "features", "endpoints"},
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
			"SubmitRunRequest": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"run_id":     map[string]any{"type": "string"},
					"text":       map[string]any{"type": "string"},
					"cwd":        map[string]any{"type": "string", "default": "/workspace"},
					"inbox_mode": map[string]any{"type": "string", "enum": []any{"prompt", "steer", "follow_up"}},
				},
				"required": []any{"run_id", "text"},
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
					"seq":  map[string]any{"type": "integer"},
					"kind": map[string]any{"type": "string"},
					"data": map[string]any{"type": "object"},
				},
				"required": []any{"seq", "kind"},
			},
			"EventList": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"run":    map[string]any{"$ref": "#/components/schemas/Run"},
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
