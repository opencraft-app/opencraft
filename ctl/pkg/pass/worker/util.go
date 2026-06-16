package pass

import (
	"encoding/json"
	"fmt"
)

// parseMessageData 解码 MQ payload，与 instance worker 同语义
func parseMessageData(data []byte, in interface{}) error {
	if in == nil {
		return fmt.Errorf("task input is nil")
	}
	if err := json.Unmarshal(data, in); err != nil {
		return fmt.Errorf("json.Unmarshal error: %w", err)
	}
	return nil
}

// jsonUnmarshal 解析 task_params 字符串成 payload
func jsonUnmarshal(s string, v interface{}) error {
	if s == "" {
		return fmt.Errorf("empty json string")
	}
	return json.Unmarshal([]byte(s), v)
}
