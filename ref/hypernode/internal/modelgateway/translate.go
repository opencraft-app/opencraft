package modelgateway

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type responseTool struct {
	Name      string
	Namespace string
	Kind      string
}

type toolCodec struct {
	byChatName map[string]responseTool
	byResponse map[string]string
}

func newToolCodec() *toolCodec {
	return &toolCodec{byChatName: make(map[string]responseTool), byResponse: make(map[string]string)}
}

func (codec *toolCodec) responseKey(tool responseTool) string {
	return tool.Namespace + "\x00" + tool.Name + "\x00" + tool.Kind
}

func (codec *toolCodec) register(tool responseTool) string {
	key := codec.responseKey(tool)
	if existing := codec.byResponse[key]; existing != "" {
		return existing
	}
	base := tool.Name
	if tool.Namespace != "" && tool.Namespace != "functions" {
		base = tool.Namespace + "__" + tool.Name
	}
	base = sanitizeChatToolName(base)
	if base == "" {
		base = "hypernode_tool"
	}
	if len(base) > 55 {
		digest := fmt.Sprintf("%x", sha256.Sum256([]byte(key)))[:8]
		base = base[:55] + "_" + digest
	}
	name := base
	for suffix := 2; ; suffix++ {
		if existing, found := codec.byChatName[name]; !found || existing == tool {
			break
		}
		name = fmt.Sprintf("%s_%d", base, suffix)
	}
	codec.byChatName[name] = tool
	codec.byResponse[key] = name
	return name
}

func (codec *toolCodec) chatName(tool responseTool) string {
	if name := codec.byResponse[codec.responseKey(tool)]; name != "" {
		return name
	}
	return codec.register(tool)
}

func sanitizeChatToolName(value string) string {
	var output strings.Builder
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '-' {
			output.WriteRune(char)
		} else {
			output.WriteByte('_')
		}
	}
	return output.String()
}

func responsesToChat(body []byte) ([]byte, bool, *toolCodec, error) {
	var input map[string]any
	if err := json.Unmarshal(body, &input); err != nil {
		return nil, false, nil, fmt.Errorf("invalid JSON body")
	}
	codec := newToolCodec()
	output := make(map[string]any)
	for _, key := range []string{"model", "temperature", "top_p", "parallel_tool_calls", "tool_choice", "user"} {
		if value, found := input[key]; found {
			output[key] = value
		}
	}
	stream, _ := input["stream"].(bool)
	output["stream"] = stream
	if stream {
		output["stream_options"] = map[string]any{"include_usage": true}
	}
	if value, found := input["max_output_tokens"]; found {
		output["max_completion_tokens"] = value
	}
	messages := make([]any, 0)
	if instructions, ok := input["instructions"].(string); ok && instructions != "" {
		// "system" is accepted by substantially more OpenAI-compatible Chat
		// Completions providers than the newer "developer" role.
		messages = append(messages, map[string]any{"role": "system", "content": instructions})
	}
	convertedTools, err := responseToolsToChat(input, codec)
	if err != nil {
		return nil, false, nil, err
	}
	converted, err := responseInputToMessages(input["input"], codec)
	if err != nil {
		return nil, false, nil, err
	}
	messages = append(messages, converted...)
	output["messages"] = messages
	if len(convertedTools) > 0 {
		output["tools"] = convertedTools
	}
	encoded, err := json.Marshal(output)
	return encoded, stream, codec, err
}

func responseToolsToChat(input map[string]any, codec *toolCodec) ([]any, error) {
	converted := make([]any, 0)
	seen := make(map[string]bool)
	appendSpecs := func(value any) error {
		specs, _ := value.([]any)
		for _, raw := range specs {
			items, err := responseToolToChat(raw, "", codec)
			if err != nil {
				return err
			}
			for _, item := range items {
				function, _ := item.(map[string]any)["function"].(map[string]any)
				name, _ := function["name"].(string)
				if name == "" || seen[name] {
					continue
				}
				seen[name] = true
				converted = append(converted, item)
			}
		}
		return nil
	}
	if err := appendSpecs(input["tools"]); err != nil {
		return nil, err
	}
	items, _ := input["input"].([]any)
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		if item["type"] == "additional_tools" {
			if err := appendSpecs(item["tools"]); err != nil {
				return nil, err
			}
		}
	}
	return converted, nil
}

func responseToolToChat(value any, namespace string, codec *toolCodec) ([]any, error) {
	tool, ok := value.(map[string]any)
	if !ok {
		return nil, nil
	}
	typeName, _ := tool["type"].(string)
	if typeName == "namespace" {
		name, _ := tool["name"].(string)
		children, _ := tool["tools"].([]any)
		converted := make([]any, 0, len(children))
		for _, child := range children {
			items, err := responseToolToChat(child, name, codec)
			if err != nil {
				return nil, err
			}
			converted = append(converted, items...)
		}
		return converted, nil
	}
	// Hosted Responses tools have no Chat Completions counterpart. They are a
	// capability downgrade, not a malformed request, so retain the callable
	// tools in the same request instead of rejecting the entire turn.
	if typeName == "tool_search" || typeName == "web_search" {
		return nil, nil
	}
	if typeName != "function" && typeName != "custom" {
		return nil, fmt.Errorf("unsupported Responses tool type %q", typeName)
	}
	name, _ := tool["name"].(string)
	if name == "" {
		return nil, fmt.Errorf("Responses %s tool has no name", typeName)
	}
	chatName := codec.register(responseTool{Name: name, Namespace: namespace, Kind: typeName})
	parameters := tool["parameters"]
	if typeName == "custom" {
		parameters = map[string]any{
			"type":                 "object",
			"properties":           map[string]any{"input": map[string]any{"type": "string", "description": "Raw input for the custom tool."}},
			"required":             []any{"input"},
			"additionalProperties": false,
		}
	}
	description, _ := tool["description"].(string)
	if namespace != "" && namespace != "functions" {
		description = fmt.Sprintf("[%s.%s] %s", namespace, name, description)
	}
	return []any{map[string]any{"type": "function", "function": map[string]any{
		"name": chatName, "description": description, "parameters": parameters,
	}}}, nil
}

func responseInputToMessages(value any, codec *toolCodec) ([]any, error) {
	if text, ok := value.(string); ok {
		return []any{map[string]any{"role": "user", "content": text}}, nil
	}
	items, ok := value.([]any)
	if !ok && value != nil {
		return nil, fmt.Errorf("unsupported Responses input")
	}
	messages := make([]any, 0, len(items))
	for _, value := range items {
		item, ok := value.(map[string]any)
		if !ok {
			continue
		}
		typeName, _ := item["type"].(string)
		switch typeName {
		case "additional_tools":
			// Tool declarations were lifted into Chat Completions' top-level tools.
		case "message", "":
			role, _ := item["role"].(string)
			if role == "developer" {
				role = "system"
			}
			content, err := responseContent(item["content"])
			if err != nil {
				return nil, err
			}
			messages = append(messages, map[string]any{"role": role, "content": content})
		case "function_call":
			name, _ := item["name"].(string)
			namespace, _ := item["namespace"].(string)
			name = codec.chatName(responseTool{Name: name, Namespace: namespace, Kind: "function"})
			messages = append(messages, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
				"id": item["call_id"], "type": "function", "function": map[string]any{"name": name, "arguments": item["arguments"]},
			}}})
		case "function_call_output":
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": item["call_id"], "content": item["output"]})
		case "custom_tool_call":
			name, _ := item["name"].(string)
			namespace, _ := item["namespace"].(string)
			name = codec.chatName(responseTool{Name: name, Namespace: namespace, Kind: "custom"})
			arguments, _ := json.Marshal(map[string]any{"input": item["input"]})
			messages = append(messages, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
				"id": item["call_id"], "type": "function", "function": map[string]any{"name": name, "arguments": string(arguments)},
			}}})
		case "custom_tool_call_output":
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": item["call_id"], "content": item["output"]})
		case "reasoning":
			// Reasoning summaries are context metadata and have no Chat Completions equivalent.
		default:
			return nil, fmt.Errorf("unsupported Responses input item type %q", typeName)
		}
	}
	return messages, nil
}

func responseContent(value any) (any, error) {
	if text, ok := value.(string); ok {
		return text, nil
	}
	parts, ok := value.([]any)
	if !ok {
		return "", nil
	}
	converted := make([]any, 0, len(parts))
	for _, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			continue
		}
		typeName, _ := part["type"].(string)
		switch typeName {
		case "input_text", "output_text", "text":
			converted = append(converted, map[string]any{"type": "text", "text": part["text"]})
		case "input_image":
			url := part["image_url"]
			converted = append(converted, map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}})
		default:
			return nil, fmt.Errorf("unsupported Responses content type %q", typeName)
		}
	}
	return converted, nil
}

type chatAccumulator struct {
	id      string
	model   string
	created int64
	text    strings.Builder
	tools   map[int]*toolAccumulator
	usage   any
}

type toolAccumulator struct {
	id, name  string
	arguments strings.Builder
	announced bool
}

func newAccumulator() *chatAccumulator {
	return &chatAccumulator{created: time.Now().Unix(), tools: make(map[int]*toolAccumulator)}
}

func responseID(acc *chatAccumulator) string {
	if strings.HasPrefix(acc.id, "resp_") {
		return acc.id
	}
	if acc.id != "" {
		return "resp_" + acc.id
	}
	return "resp_hypernode_" + strconv.FormatInt(time.Now().UnixNano(), 36)
}

func responseEnvelope(acc *chatAccumulator, status string, output []any) map[string]any {
	return map[string]any{"id": responseID(acc), "object": "response", "created_at": acc.created, "status": status,
		"model": acc.model, "output": output, "error": nil, "incomplete_details": nil, "usage": acc.usage}
}

func translateChatStream(_ interface{ Done() <-chan struct{} }, writer http.ResponseWriter, reader io.Reader, codec *toolCodec) error {
	acc := newAccumulator()
	flusher, _ := writer.(http.Flusher)
	started := false
	textItemID := "msg_hypernode"
	finish := ""
	err := scanSSE(reader, func(data []byte) error {
		var chunk map[string]any
		if err := json.Unmarshal(data, &chunk); err != nil {
			return err
		}
		if id, ok := chunk["id"].(string); ok {
			acc.id = id
		}
		if model, ok := chunk["model"].(string); ok {
			acc.model = model
		}
		if created, ok := chunk["created"].(float64); ok {
			acc.created = int64(created)
		}
		if usage, found := chunk["usage"]; found && usage != nil {
			acc.usage = translateUsage(usage)
		}
		if !started {
			started = true
			_ = writeSSE(writer, "response.created", map[string]any{"type": "response.created", "response": responseEnvelope(acc, "in_progress", []any{})})
			_ = writeSSE(writer, "response.in_progress", map[string]any{"type": "response.in_progress", "response": responseEnvelope(acc, "in_progress", []any{})})
		}
		choices, _ := chunk["choices"].([]any)
		for _, value := range choices {
			choice, _ := value.(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			if reason, ok := choice["finish_reason"].(string); ok {
				finish = reason
			}
			if content, ok := delta["content"].(string); ok && content != "" {
				if acc.text.Len() == 0 {
					item := map[string]any{"id": textItemID, "type": "message", "status": "in_progress", "role": "assistant", "content": []any{}}
					_ = writeSSE(writer, "response.output_item.added", map[string]any{"type": "response.output_item.added", "output_index": 0, "item": item})
					_ = writeSSE(writer, "response.content_part.added", map[string]any{"type": "response.content_part.added", "item_id": textItemID, "output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})
				}
				acc.text.WriteString(content)
				_ = writeSSE(writer, "response.output_text.delta", map[string]any{"type": "response.output_text.delta", "item_id": textItemID, "output_index": 0, "content_index": 0, "delta": content})
			}
			if toolCalls, ok := delta["tool_calls"].([]any); ok {
				for _, raw := range toolCalls {
					call, _ := raw.(map[string]any)
					index := int(number(call["index"]))
					tool := acc.tools[index]
					if tool == nil {
						tool = &toolAccumulator{}
						acc.tools[index] = tool
					}
					if id, ok := call["id"].(string); ok {
						tool.id = id
					}
					function, _ := call["function"].(map[string]any)
					if name, ok := function["name"].(string); ok {
						tool.name = name
					}
					if !tool.announced && tool.id != "" && tool.name != "" {
						tool.announced = true
						_ = writeSSE(writer, "response.output_item.added", map[string]any{"type": "response.output_item.added", "output_index": index, "item": responseToolCall(codec, tool.id, tool.name, "", "in_progress")})
					}
					if args, ok := function["arguments"].(string); ok && args != "" {
						tool.arguments.WriteString(args)
						if codec.byChatName[tool.name].Kind != "custom" {
							_ = writeSSE(writer, "response.function_call_arguments.delta", map[string]any{"type": "response.function_call_arguments.delta", "item_id": tool.id, "output_index": index, "delta": args})
						}
					}
				}
			}
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	})
	if err != nil {
		return err
	}
	output := make([]any, 0)
	if acc.text.Len() > 0 {
		text := acc.text.String()
		item := map[string]any{"id": textItemID, "type": "message", "status": "completed", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}}
		_ = writeSSE(writer, "response.output_text.done", map[string]any{"type": "response.output_text.done", "item_id": textItemID, "output_index": 0, "content_index": 0, "text": text})
		_ = writeSSE(writer, "response.content_part.done", map[string]any{"type": "response.content_part.done", "item_id": textItemID, "output_index": 0, "content_index": 0, "part": item["content"].([]any)[0]})
		_ = writeSSE(writer, "response.output_item.done", map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item})
		output = append(output, item)
	}
	for index := 0; index < len(acc.tools); index++ {
		tool := acc.tools[index]
		if tool == nil {
			continue
		}
		args := tool.arguments.String()
		item := responseToolCall(codec, tool.id, tool.name, args, "completed")
		if codec.byChatName[tool.name].Kind != "custom" {
			_ = writeSSE(writer, "response.function_call_arguments.done", map[string]any{"type": "response.function_call_arguments.done", "item_id": tool.id, "output_index": index, "arguments": args})
		}
		_ = writeSSE(writer, "response.output_item.done", map[string]any{"type": "response.output_item.done", "output_index": index, "item": item})
		output = append(output, item)
	}
	_ = finish
	_ = writeSSE(writer, "response.completed", map[string]any{"type": "response.completed", "response": responseEnvelope(acc, "completed", output)})
	if flusher != nil {
		flusher.Flush()
	}
	return nil
}

func translateChatResponse(reader io.Reader, codec *toolCodec) ([]byte, error) {
	var chat map[string]any
	if err := json.NewDecoder(reader).Decode(&chat); err != nil {
		return nil, err
	}
	acc := newAccumulator()
	acc.id, _ = chat["id"].(string)
	acc.model, _ = chat["model"].(string)
	acc.usage = translateUsage(chat["usage"])
	output := make([]any, 0)
	choices, _ := chat["choices"].([]any)
	if len(choices) > 0 {
		choice, _ := choices[0].(map[string]any)
		message, _ := choice["message"].(map[string]any)
		if content, ok := message["content"].(string); ok && content != "" {
			output = append(output, map[string]any{"id": "msg_hypernode", "type": "message", "status": "completed", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": content, "annotations": []any{}}}})
		}
		if calls, ok := message["tool_calls"].([]any); ok {
			for _, raw := range calls {
				call, _ := raw.(map[string]any)
				function, _ := call["function"].(map[string]any)
				name, _ := function["name"].(string)
				arguments, _ := function["arguments"].(string)
				output = append(output, responseToolCall(codec, call["id"], name, arguments, "completed"))
			}
		}
	}
	return json.Marshal(responseEnvelope(acc, "completed", output))
}

func responseToolCall(codec *toolCodec, id any, chatName, arguments, status string) map[string]any {
	tool, found := codec.byChatName[chatName]
	if !found {
		tool = responseTool{Name: chatName, Kind: "function"}
	}
	item := map[string]any{
		"id": id, "status": status, "call_id": id, "name": tool.Name,
	}
	if tool.Namespace != "" {
		item["namespace"] = tool.Namespace
	}
	if tool.Kind == "custom" {
		item["type"] = "custom_tool_call"
		item["input"] = customToolInput(arguments)
	} else {
		item["type"] = "function_call"
		item["arguments"] = arguments
	}
	return item
}

func customToolInput(arguments string) string {
	var decoded map[string]any
	if json.Unmarshal([]byte(arguments), &decoded) == nil {
		if input, ok := decoded["input"].(string); ok {
			return input
		}
	}
	return arguments
}

func number(value any) float64 {
	value, _ = value.(float64)
	if value == nil {
		return 0
	}
	return value.(float64)
}

func translateUsage(value any) any {
	usage, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	prompt := int64(number(usage["prompt_tokens"]))
	completion := int64(number(usage["completion_tokens"]))
	total := int64(number(usage["total_tokens"]))
	if total == 0 {
		total = prompt + completion
	}
	cached := int64(0)
	if details, ok := usage["prompt_tokens_details"].(map[string]any); ok {
		cached = int64(number(details["cached_tokens"]))
	}
	reasoning := int64(0)
	if details, ok := usage["completion_tokens_details"].(map[string]any); ok {
		reasoning = int64(number(details["reasoning_tokens"]))
	}
	return map[string]any{
		"input_tokens":          prompt,
		"input_tokens_details":  map[string]any{"cached_tokens": cached},
		"output_tokens":         completion,
		"output_tokens_details": map[string]any{"reasoning_tokens": reasoning},
		"total_tokens":          total,
	}
}
