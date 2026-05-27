package runtime

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"wisp/internal/config"
	"wisp/internal/smh"
)

const (
	remoteBackendCOS = "cos"
	remoteBackendSMH = "smh"
)

func normalizeRemoteBackend(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", remoteBackendCOS:
		return remoteBackendCOS
	case remoteBackendSMH:
		return remoteBackendSMH
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func ensureWorkspaceBackendProvisioned(ctx context.Context, configPath string, cfg config.Config, name string) (config.Config, error) {
	if err := validateRemoteBackendConfig(cfg); err != nil {
		return cfg, err
	}
	backend := normalizeRemoteBackend(cfg.RemoteBackend)
	if backend == remoteBackendCOS {
		return cfg, nil
	}
	if backend != remoteBackendSMH {
		return cfg, fmt.Errorf("unsupported remote backend %q", cfg.RemoteBackend)
	}
	if strings.TrimSpace(cfg.SMHSpaceID) != "" {
		return cfg, persistWorkspaceBackendIdentity(configPath, name, cfg, cfg.SMHSpaceID)
	}
	client, err := smh.NewClient(cfg.SMHAccessDomain, cfg.SMHLibraryID, cfg.SMHLibrarySecret, &http.Client{Timeout: 30 * time.Second})
	if err != nil {
		return cfg, err
	}
	token, err := client.IssueToken(ctx, smh.TokenRequest{
		Grant:         []string{"create_space"},
		PeriodSeconds: cfg.SMHTokenTTLSeconds,
	})
	if err != nil {
		return cfg, fmt.Errorf("issue SMH create_space token: %w", err)
	}
	space, err := client.CreateSpace(ctx, token.AccessToken, smh.CreateSpaceRequest{SpaceTag: name})
	if err != nil {
		return cfg, fmt.Errorf("create SMH space for %s: %w", name, err)
	}
	if err := persistWorkspaceBackendIdentity(configPath, name, cfg, space.SpaceID); err != nil {
		return cfg, err
	}
	return config.LoadContainer(configPath, name)
}

func persistWorkspaceBackendIdentity(configPath, name string, cfg config.Config, spaceID string) error {
	updates := map[string]string{
		"REMOTE_BACKEND":    normalizeRemoteBackend(cfg.RemoteBackend),
		"SMH_LIBRARY_ID":    cfg.SMHLibraryID,
		"SMH_ACCESS_DOMAIN": cfg.SMHAccessDomain,
		"SMH_SPACE_ID":      spaceID,
	}
	if cfg.SMHEnabled || normalizeRemoteBackend(cfg.RemoteBackend) == remoteBackendSMH {
		updates["SMH_ENABLED"] = "true"
	}
	for key, value := range updates {
		if strings.TrimSpace(value) == "" {
			continue
		}
		if err := config.SetContainerEnvValue(configPath, name, key, value); err != nil {
			return err
		}
	}
	return nil
}

func ensureWorkspaceBackendMounted(ctx context.Context, r *Runtime) error {
	if err := validateRemoteBackendConfig(r.cfg); err != nil {
		return err
	}
	switch normalizeRemoteBackend(r.cfg.RemoteBackend) {
	case remoteBackendCOS:
		return r.ensureCOSRootMounted(ctx)
	case remoteBackendSMH:
		// Phase 1 preserves the same local POSIX mount contract and delegates
		// backend-specific target resolution to the smount layer.
		return r.ensureCOSRootMounted(ctx)
	default:
		return fmt.Errorf("unsupported remote backend %q", r.cfg.RemoteBackend)
	}
}

func validateRemoteBackendConfig(cfg config.Config) error {
	switch normalizeRemoteBackend(cfg.RemoteBackend) {
	case remoteBackendCOS:
		return nil
	case remoteBackendSMH:
		if strings.TrimSpace(cfg.SMHLibraryID) == "" {
			return fmt.Errorf("SMH_LIBRARY_ID is required for REMOTE_BACKEND=smh")
		}
		if strings.TrimSpace(cfg.SMHAccessDomain) == "" {
			return fmt.Errorf("SMH_ACCESS_DOMAIN is required for REMOTE_BACKEND=smh")
		}
		return nil
	default:
		return fmt.Errorf("unsupported remote backend %q", cfg.RemoteBackend)
	}
}
