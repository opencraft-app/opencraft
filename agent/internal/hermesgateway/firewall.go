package hermesgateway

import (
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

// piControlledEnvironmentKeysV1 is the credential surface owned by the
// temporary Pi wire contract. These values must never cross into Hermes.
var piControlledEnvironmentKeysV1 = map[string]struct{}{
	"DEEPSEEK_API_KEY": {},
}

func sanitizeProcessEnvironment(environment map[string]string) map[string]string {
	sanitized := make(map[string]string, len(environment))
	for key, value := range environment {
		if _, controlled := piControlledEnvironmentKeysV1[key]; controlled {
			continue
		}
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
