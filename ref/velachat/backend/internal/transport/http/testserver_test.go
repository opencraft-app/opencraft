package httptransport

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
)

type contractResponse struct {
	status int
	header http.Header
	body   []byte
}

func buildContractResponse(operation *openapi3.Operation) (contractResponse, error) {
	if operation == nil || operation.Responses == nil {
		return contractResponse{}, errors.New("operation 缺少 responses")
	}
	statuses := make([]int, 0)
	for key := range operation.Responses.Map() {
		status, err := strconv.Atoi(key)
		if err == nil && status >= 200 && status < 400 {
			statuses = append(statuses, status)
		}
	}
	if len(statuses) == 0 {
		return contractResponse{}, errors.New("operation 缺少 2xx/3xx success response")
	}
	sort.Ints(statuses)
	status := statuses[0]
	responseRef := operation.Responses.Status(status)
	if responseRef == nil || responseRef.Value == nil {
		return contractResponse{}, errors.New("success response 未解析")
	}

	result := contractResponse{
		status: status,
		header: make(http.Header),
	}
	for name, headerRef := range responseRef.Value.Headers {
		if headerRef == nil || headerRef.Value == nil ||
			headerRef.Value.Schema == nil ||
			headerRef.Value.Schema.Value == nil {
			continue
		}
		schema := headerRef.Value.Schema.Value
		if len(schema.Enum) > 0 {
			result.header.Set(name, asString(schema.Enum[0]))
			continue
		}
		value, err := synthesizeSchema(headerRef.Value.Schema)
		if err == nil {
			result.header.Set(name, asString(value))
		}
	}

	mediaType := responseRef.Value.Content["application/json"]
	contentType := "application/json"
	if mediaType == nil {
		mediaType = responseRef.Value.Content["text/plain"]
		contentType = "text/plain"
	}
	if mediaType == nil || mediaType.Schema == nil {
		return result, nil
	}
	value, err := synthesizeSchema(mediaType.Schema)
	if err != nil {
		return contractResponse{}, err
	}
	if contentType == "text/plain" {
		result.body = []byte(asString(value))
	} else {
		result.body, err = json.Marshal(value)
		if err != nil {
			return contractResponse{}, err
		}
	}
	result.header.Set("Content-Type", contentType)
	return result, nil
}

func synthesizeSchema(ref *openapi3.SchemaRef) (any, error) {
	if ref == nil || ref.Value == nil {
		return nil, errors.New("SchemaRef 未解析")
	}
	schema := ref.Value
	if schema.Default != nil {
		return schema.Default, nil
	}
	if schema.Example != nil {
		return schema.Example, nil
	}
	if len(schema.Enum) > 0 {
		return schema.Enum[0], nil
	}
	if len(schema.AllOf) > 0 {
		merged := map[string]any{}
		for _, item := range schema.AllOf {
			value, err := synthesizeSchema(item)
			if err != nil {
				return nil, err
			}
			object, ok := value.(map[string]any)
			if !ok {
				return nil, errors.New("allOf contract value 不是 object")
			}
			for key, field := range object {
				merged[key] = field
			}
		}
		return merged, nil
	}
	if len(schema.OneOf) > 0 {
		return synthesizeSchema(schema.OneOf[0])
	}
	if len(schema.AnyOf) > 0 {
		return synthesizeSchema(schema.AnyOf[0])
	}

	switch {
	case schema.Type.Is("object"):
		result := make(map[string]any, len(schema.Required))
		for _, name := range schema.Required {
			property := schema.Properties[name]
			value, err := synthesizeSchema(property)
			if err != nil {
				return nil, err
			}
			result[name] = value
		}
		return result, nil
	case schema.Type.Is("array"):
		count := int(schema.MinItems)
		result := make([]any, 0, count)
		for range count {
			value, err := synthesizeSchema(schema.Items)
			if err != nil {
				return nil, err
			}
			result = append(result, value)
		}
		return result, nil
	case schema.Type.Is("string"):
		return synthesizeString(schema), nil
	case schema.Type.Is("integer"):
		value := int64(0)
		if schema.Min != nil {
			value = int64(*schema.Min)
			if schema.ExclusiveMin {
				value++
			}
		}
		return value, nil
	case schema.Type.Is("number"):
		value := float64(0)
		if schema.Min != nil {
			value = *schema.Min
			if schema.ExclusiveMin {
				value++
			}
		}
		return value, nil
	case schema.Type.Is("boolean"):
		return false, nil
	default:
		if schema.Nullable {
			return nil, nil
		}
		return nil, errors.New("不支持的 contract Schema 类型")
	}
}

func synthesizeString(schema *openapi3.Schema) string {
	switch schema.Format {
	case "uuid":
		return "01989c24-7540-7f12-a27b-c83243215dd1"
	case "date-time":
		return "2026-07-30T12:00:00Z"
	case "email":
		return "contract@example.cn"
	case "uri":
		return "https://example.cn/contract"
	}
	if matches := fixedContractStringPattern.FindStringSubmatch(schema.Pattern); len(matches) == 2 {
		length, err := strconv.Atoi(matches[1])
		if err == nil && length > 0 {
			return strings.Repeat("x", length)
		}
	}
	length := int(schema.MinLength)
	if length < 1 {
		length = 1
	}
	return strings.Repeat("x", length)
}

var fixedContractStringPattern = regexp.MustCompile(`^\^\[A-Za-z0-9_-\]\{([0-9]+)\}\$$`)

func asString(value any) string {
	if stringValue, ok := value.(string); ok {
		return stringValue
	}
	return fmt.Sprint(value)
}
