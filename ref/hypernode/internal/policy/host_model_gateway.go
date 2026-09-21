package policy

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	goja "hypernode/internal/policy/jsvm"
)

func (h *hostRuntime) installModelGateway(vm *goja.Runtime) error {
	object := vm.NewObject()
	if err := object.Set("available", h.modelGateway != nil); err != nil {
		return err
	}
	if err := object.Set("registerProvider", func(id, endpoint string) (map[string]string, error) {
		if h.modelGateway == nil {
			return nil, fmt.Errorf("model gateway is unavailable")
		}
		provider, err := h.modelGateway.Register(id, endpoint)
		if err != nil {
			return nil, err
		}
		return map[string]string{
			"id": provider.ID, "endpoint": provider.Endpoint,
			"responsesBaseURL": h.modelGatewayBaseURL + "/providers/" + provider.ID + "/v1",
		}, nil
	}); err != nil {
		return err
	}
	if err := object.Set("unregisterProvider", func(id string) {
		if h.modelGateway != nil {
			h.modelGateway.Unregister(strings.TrimSpace(id))
		}
	}); err != nil {
		return err
	}
	if err := object.Set("configureUser", func(
		username string, uid, gid uint32, installationID, id, endpoint, apiKey, model, displayName string,
	) (map[string]string, error) {
		if h.modelGateway == nil {
			return nil, fmt.Errorf("model gateway is unavailable")
		}
		provider, err := h.modelGateway.Register(id, endpoint)
		if err != nil {
			return nil, err
		}
		paths, err := h.ensureUser(username, uid, gid, installationID)
		if err != nil {
			return nil, err
		}
		codexHome := paths["codexHome"].(string)
		profilePath := filepath.Join(codexHome, "hypernode.config.toml")
		baseURL := h.modelGatewayBaseURL + "/providers/" + provider.ID + "/v1"
		if strings.TrimSpace(displayName) == "" {
			displayName = "HyperNode " + provider.ID
		}
		// Custom/public providers are DSH execution profiles. Remove the legacy
		// Codex profile if it exists, but keep the credential in the generic
		// host registry for the DSH adapter. Codex processes must never inherit
		// this endpoint or secret.
		if err := os.Remove(profilePath); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("remove legacy HyperNode Codex profile: %w", err)
		}
		if strings.TrimSpace(apiKey) != "" {
			if err := h.modelGateway.SetUserCredential(username, provider.ID, apiKey, model, displayName); err != nil {
				return nil, err
			}
		}
		return map[string]string{
			"id": provider.ID, "endpoint": provider.Endpoint,
			"responsesBaseURL": baseURL, "profilePath": "",
			"credentialLoaded": fmt.Sprint(h.modelGateway.UserCredentialLoaded(username, provider.ID)),
		}, nil
	}); err != nil {
		return err
	}
	if err := object.Set("credentialLoaded", func(username, providerID string) bool {
		return h.modelGateway != nil && h.modelGateway.UserCredentialLoaded(username, providerID)
	}); err != nil {
		return err
	}
	if err := object.Set("runtimeRoute", func(username, providerID string) (map[string]any, error) {
		if h.modelGateway == nil {
			return nil, fmt.Errorf("model gateway is unavailable")
		}
		runtime, ok := h.modelGateway.UserRuntimeConfigForProvider(username, providerID)
		if !ok {
			return nil, fmt.Errorf("model provider %s is not configured for SSH user %s", providerID, username)
		}
		return map[string]any{
			"providerId":       runtime.ProviderID,
			"model":            runtime.Model,
			"displayName":      runtime.DisplayName,
			"responsesBaseURL": h.modelGatewayBaseURL + "/providers/" + runtime.ProviderID + "/v1",
			"gatewayBaseURL":   h.modelGatewayBaseURL + "/providers/" + runtime.ProviderID + "/v1",
		}, nil
	}); err != nil {
		return err
	}
	if err := object.Set("activateUser", func(username, providerID string) error {
		if h.modelGateway == nil {
			return fmt.Errorf("model gateway is unavailable")
		}
		return h.modelGateway.ActivateUserCredential(username, providerID)
	}); err != nil {
		return err
	}
	if err := object.Set("deactivateUser", func(username string) {
		if h.modelGateway != nil {
			h.modelGateway.DeactivateUserCredential(username)
		}
	}); err != nil {
		return err
	}
	if err := object.Set("removeUserProvider", func(username, providerID string) {
		if h.modelGateway != nil {
			h.modelGateway.RemoveUserCredential(username, providerID)
		}
	}); err != nil {
		return err
	}
	if err := object.Set("clearUser", func(username string, uid, gid uint32, installationID string) error {
		paths, err := h.ensureUser(username, uid, gid, installationID)
		if err != nil {
			return err
		}
		if h.modelGateway != nil {
			h.modelGateway.ClearUserCredential(username)
		}
		err = os.Remove(filepath.Join(paths["codexHome"].(string), "hypernode.config.toml"))
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}); err != nil {
		return err
	}
	return vm.Set("hostModelGateway", object)
}

func (h *hostRuntime) codexAppServerArguments(username, executable string) []string {
	return []string{executable, "app-server", "--listen", "stdio://"}
}

func (h *hostRuntime) codexAppServerArgumentsForProvider(username, providerID, executable string) []string {
	// Kept as a call-site-compatible native Codex launcher while the DSH
	// adapter is introduced. providerID is intentionally ignored: provider
	// routes are not a Codex capability anymore.
	return h.codexAppServerArguments(username, executable)
}
