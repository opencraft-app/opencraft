package wrapper

import (
	"encoding/json"
	"net/http"
)

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": APIError{
			Message: message,
			Type:    "invalid_request_error",
			Code:    code,
		},
	})
}

func apiErr(code, message string) *APIError {
	return &APIError{
		Message: message,
		Type:    "invalid_request_error",
		Code:    code,
	}
}
