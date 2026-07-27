package releasebootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

type Config struct {
	ControlURL string
	AdminToken string
	Release    gateway.CreateNewAPIReleaseInput
	Rings      []Ring
}

type Ring struct {
	Input       gateway.UpsertReleaseRingInput
	SoakSeconds int
}

type response[T any] struct {
	Success bool `json:"success"`
	Data    T    `json:"data"`
}

func Ensure(ctx context.Context, client *http.Client, cfg Config) error {
	if client == nil {
		client = http.DefaultClient
	}
	cfg.ControlURL = strings.TrimRight(strings.TrimSpace(cfg.ControlURL), "/")
	if cfg.ControlURL == "" || strings.TrimSpace(cfg.AdminToken) == "" {
		return fmt.Errorf("control URL and admin token are required")
	}

	var releases response[[]gateway.NewAPIRelease]
	if err := requestJSON(ctx, client, cfg, http.MethodGet, "/api/admin/newapi-releases", nil, &releases); err != nil {
		return err
	}
	foundRelease := false
	for _, release := range releases.Data {
		if release.ID != cfg.Release.ID {
			continue
		}
		foundRelease = true
		if !releaseMatches(release, cfg.Release) {
			return fmt.Errorf("release %q drift: existing definition differs from bootstrap", release.ID)
		}
		break
	}
	if !foundRelease {
		if err := requestJSON(ctx, client, cfg, http.MethodPost, "/api/admin/newapi-releases", cfg.Release, nil); err != nil {
			return err
		}
	}

	var rings response[[]gateway.ReleaseRing]
	if err := requestJSON(ctx, client, cfg, http.MethodGet, "/api/admin/release-rings", nil, &rings); err != nil {
		return err
	}
	for _, desired := range cfg.Rings {
		found := false
		for _, existing := range rings.Data {
			if existing.ID != desired.Input.ID {
				continue
			}
			found = true
			if !ringMatches(existing, desired) {
				return fmt.Errorf("release ring %q drift: existing definition differs from bootstrap", existing.ID)
			}
			break
		}
		if found {
			continue
		}
		payload := struct {
			gateway.UpsertReleaseRingInput
			SoakSeconds int `json:"soak_seconds"`
		}{UpsertReleaseRingInput: desired.Input, SoakSeconds: desired.SoakSeconds}
		if err := requestJSON(ctx, client, cfg, http.MethodPost, "/api/admin/release-rings", payload, nil); err != nil {
			return err
		}
	}
	return nil
}

func requestJSON(ctx context.Context, client *http.Client, cfg Config, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, cfg.ControlURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.AdminToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("%s %s returned %d: %s", method, path, res.StatusCode, strings.TrimSpace(string(message)))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}

func releaseMatches(existing gateway.NewAPIRelease, desired gateway.CreateNewAPIReleaseInput) bool {
	return existing.Source == desired.Source && existing.Namespace == desired.Namespace && existing.Fleet == desired.Fleet &&
		existing.Version == desired.Version && existing.Image == desired.Image && existing.Compatibility == desired.Compatibility && existing.Status == desired.Status
}

func ringMatches(existing gateway.ReleaseRing, desired Ring) bool {
	input := desired.Input
	return existing.Source == input.Source && existing.Namespace == input.Namespace && existing.Fleet == input.Fleet &&
		existing.Ordinal == input.Ordinal && existing.AdmissionEnabled == input.AdmissionEnabled &&
		existing.MaxParallel == input.MaxParallel && existing.SoakSeconds == desired.SoakSeconds
}
