// Package pagination 实现不承担鉴权的稳定 continuation cursor。
package pagination

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const cursorVersion = 1

type payload struct {
	Version   int      `json:"v"`
	Operation string   `json:"op"`
	Filter    string   `json:"filter"`
	Sort      []string `json:"sort"`
}

// Encode 创建与 operation/filter/稳定排序 tuple 绑定的不透明 cursor。
func Encode(operation, filter string, sortValues ...string) (string, error) {
	if strings.TrimSpace(operation) == "" || len(sortValues) == 0 {
		return "", errors.New("cursor operation/sort 不能为空")
	}
	for _, value := range sortValues {
		if value == "" {
			return "", errors.New("cursor sort value 不能为空")
		}
	}
	data, err := json.Marshal(payload{
		Version: cursorVersion, Operation: operation,
		Filter: filterDigest(filter), Sort: append([]string(nil), sortValues...),
	})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

// Decode 严格校验 cursor 结构与查询绑定。Cursor 不是授权凭据。
func Decode(token, operation, filter string, sortArity int) ([]string, error) {
	if token == "" || sortArity < 1 {
		return nil, errors.New("cursor 参数无效")
	}
	data, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return nil, fmt.Errorf("cursor base64: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var value payload
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("cursor JSON: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("cursor 尾部: %w", err)
	} else if err == nil {
		return nil, errors.New("cursor 含多余 JSON value")
	}
	if value.Version != cursorVersion || value.Operation != operation ||
		value.Filter != filterDigest(filter) || len(value.Sort) != sortArity {
		return nil, errors.New("cursor 与当前查询不匹配")
	}
	for _, item := range value.Sort {
		if item == "" {
			return nil, errors.New("cursor sort value 为空")
		}
	}
	return append([]string(nil), value.Sort...), nil
}

func filterDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
