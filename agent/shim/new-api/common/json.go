package common

import (
	"bytes"
	"encoding/json"
	"io"
)

func Unmarshal(data []byte, value any) error {
	return json.Unmarshal(data, value)
}

func UnmarshalJsonStr(data string, value any) error {
	return json.Unmarshal([]byte(data), value)
}

func DecodeJson(reader io.Reader, value any) error {
	return json.NewDecoder(reader).Decode(value)
}

func Marshal(value any) ([]byte, error) {
	return json.Marshal(value)
}

func GetJsonType(data json.RawMessage) string {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return "unknown"
	}
	switch trimmed[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case 'n':
		return "null"
	default:
		return "number"
	}
}
