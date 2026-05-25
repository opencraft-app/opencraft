package gateway

import "fmt"

type AppError struct {
	Code    string `json:"code"`
	Kind    string `json:"kind"`
	Message string `json:"message,omitempty"`
}

func (e AppError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%s/%s: %s", e.Code, e.Kind, e.Message)
	}
	return fmt.Sprintf("%s/%s", e.Code, e.Kind)
}

type ErrorEnvelope struct {
	Type  string   `json:"type"`
	Error AppError `json:"error"`
}
