package hermesgateway

import (
	"errors"
	"strings"

	"velachat/agent/internal/runtimeapi"
)

func sanitizeProcessEnvironment(environment map[string]string) map[string]string {
	sanitized := make(map[string]string, len(environment))
	for key, value := range environment {
		sanitized[key] = value
	}
	return sanitized
}

func validateModelSelection(
	requested string,
	models runtimeapi.ModelResult,
) error {
	requested = strings.TrimSpace(requested)
	if requested == "" || requested == "default" {
		return nil
	}
	for _, model := range models.Models {
		if strings.TrimSpace(model.ID) == requested {
			return nil
		}
	}
	return errors.New(
		"Hermes Gateway model selection is not available in detected models",
	)
}
