package policy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	hotUpgradeManifestName   = "active.json"
	runtimePluginCatalogName = "catalog.json"
	runtimePluginCatalogAPI  = "hypernode.runtime-plugins/v1"
	runtimePluginAPI         = "hypernode.runtime-plugin/v1"
)

type HotUpgradeManifest struct {
	Version  int    `json:"version"`
	Slot     string `json:"slot"`
	Revision string `json:"revision"`
	Bundle   string `json:"bundle"`
	SHA256   string `json:"sha256"`
}

type RuntimePluginCatalog struct {
	APIVersion string                  `json:"apiVersion"`
	Generation int64                   `json:"generation"`
	Plugins    []RuntimePluginManifest `json:"plugins"`
}

type RuntimePluginManifest struct {
	APIVersion   string   `json:"apiVersion"`
	ID           string   `json:"id"`
	Name         string   `json:"name,omitempty"`
	Description  string   `json:"description,omitempty"`
	Version      string   `json:"version"`
	Revision     string   `json:"revision"`
	Bundle       string   `json:"bundle"`
	SHA256       string   `json:"sha256"`
	Capabilities []string `json:"capabilities,omitempty"`
	Enabled      bool     `json:"enabled"`
}

type hotUpgradeActivator interface {
	ActivateRuntimePlugin(source []byte, id, revision, sourceDigest string) error
}

type HotUpgradeWatcher struct {
	Directory string
	Interval  time.Duration
	Engine    hotUpgradeActivator
	attempted string
}

func (w *HotUpgradeWatcher) Run(ctx context.Context) error {
	if w.Engine == nil {
		return fmt.Errorf("runtime plugin engine is required")
	}
	if w.Interval <= 0 {
		w.Interval = time.Second
	}
	if err := os.MkdirAll(w.Directory, 0o750); err != nil {
		return err
	}
	w.poll()
	ticker := time.NewTicker(w.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			w.poll()
		}
	}
}

func (w *HotUpgradeWatcher) poll() {
	catalogPath := filepath.Join(w.Directory, runtimePluginCatalogName)
	encoded, err := os.ReadFile(catalogPath)
	if err == nil {
		w.applyEncodedCatalog(encoded)
		return
	}
	if !errors.Is(err, os.ErrNotExist) {
		log.Printf("runtime plugin catalog read failed: %v", err)
		return
	}
	// Backward-compatible bootstrap until the first v1 catalog is promoted.
	legacyPath := filepath.Join(w.Directory, hotUpgradeManifestName)
	encoded, err = os.ReadFile(legacyPath)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		log.Printf("hot-upgrade manifest read failed: %v", err)
		return
	}
	attempt := digestText(encoded)
	if attempt == w.attempted {
		return
	}
	w.attempted = attempt
	var manifest HotUpgradeManifest
	if err := json.Unmarshal(encoded, &manifest); err != nil {
		log.Printf("hot-upgrade manifest invalid: %v", err)
		return
	}
	if err := w.activate(manifest); err != nil {
		log.Printf("hot-upgrade activation failed revision=%s: %v", manifest.Revision, err)
		return
	}
	log.Printf("runtime plugin activated id=%s revision=%s sha256=%s", manifest.Slot, manifest.Revision, manifest.SHA256)
}

func (w *HotUpgradeWatcher) applyEncodedCatalog(encoded []byte) {
	attempt := digestText(encoded)
	if attempt == w.attempted {
		return
	}
	w.attempted = attempt
	var catalog RuntimePluginCatalog
	if err := json.Unmarshal(encoded, &catalog); err != nil {
		log.Printf("runtime plugin catalog invalid: %v", err)
		return
	}
	if err := w.applyCatalog(catalog); err != nil {
		log.Printf("runtime plugin catalog activation failed generation=%d: %v", catalog.Generation, err)
		return
	}
	log.Printf("runtime plugin catalog activated generation=%d plugins=%d", catalog.Generation, len(catalog.Plugins))
}

func digestText(encoded []byte) string {
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func (w *HotUpgradeWatcher) applyCatalog(catalog RuntimePluginCatalog) error {
	if catalog.APIVersion != runtimePluginCatalogAPI {
		return fmt.Errorf("unsupported runtime plugin catalog API: %s", catalog.APIVersion)
	}
	if catalog.Generation < 1 {
		return fmt.Errorf("runtime plugin catalog generation must be positive")
	}
	seen := make(map[string]bool)
	for _, plugin := range catalog.Plugins {
		if seen[plugin.ID] {
			return fmt.Errorf("duplicate runtime plugin id: %s", plugin.ID)
		}
		seen[plugin.ID] = true
		if !plugin.Enabled {
			continue
		}
		if err := w.activatePlugin(plugin); err != nil {
			return fmt.Errorf("activate %s: %w", plugin.ID, err)
		}
	}
	return nil
}

func (w *HotUpgradeWatcher) activate(manifest HotUpgradeManifest) error {
	if manifest.Version != 1 {
		return fmt.Errorf("unsupported manifest version: %d", manifest.Version)
	}
	if manifest.Slot != "evolution" {
		return fmt.Errorf("legacy slot is not reloadable: %s", manifest.Slot)
	}
	return w.activatePlugin(RuntimePluginManifest{
		APIVersion: runtimePluginAPI, ID: manifest.Slot, Name: manifest.Slot,
		Version: manifest.Revision, Revision: manifest.Revision, Bundle: manifest.Bundle,
		SHA256: manifest.SHA256, Enabled: true,
	})
}

func (w *HotUpgradeWatcher) activatePlugin(manifest RuntimePluginManifest) error {
	if manifest.APIVersion != runtimePluginAPI {
		return fmt.Errorf("unsupported runtime plugin API: %s", manifest.APIVersion)
	}
	if !safePluginID(manifest.ID) {
		return fmt.Errorf("invalid runtime plugin id: %s", manifest.ID)
	}
	if manifest.Version == "" || manifest.Revision == "" || manifest.Bundle == "" {
		return fmt.Errorf("version, revision and bundle are required")
	}
	if filepath.Base(manifest.Bundle) != manifest.Bundle || manifest.Bundle == "." {
		return fmt.Errorf("bundle must be a file directly inside the release directory")
	}
	if len(manifest.SHA256) != sha256.Size*2 {
		return fmt.Errorf("sha256 must be a lowercase hexadecimal digest")
	}
	if _, err := hex.DecodeString(manifest.SHA256); err != nil || strings.ToLower(manifest.SHA256) != manifest.SHA256 {
		return fmt.Errorf("sha256 must be a lowercase hexadecimal digest")
	}
	bundlePath := filepath.Join(w.Directory, manifest.Bundle)
	info, err := os.Lstat(bundlePath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("runtime plugin bundle must be a regular non-symlink file")
	}
	source, err := os.ReadFile(bundlePath)
	if err != nil {
		return err
	}
	if len(source) == 0 || len(source) > maxHotUpgradeBundleSize {
		return fmt.Errorf("runtime plugin bundle size is invalid: %d", len(source))
	}
	digest := sha256.Sum256(source)
	actual := hex.EncodeToString(digest[:])
	if actual != manifest.SHA256 {
		return fmt.Errorf("bundle digest mismatch: expected %s got %s", manifest.SHA256, actual)
	}
	return w.Engine.ActivateRuntimePlugin(source, manifest.ID, manifest.Revision, "sha256:"+actual)
}

func safePluginID(id string) bool {
	if len(id) < 1 || len(id) > 64 || id[0] < 'a' || id[0] > 'z' {
		return false
	}
	for _, character := range id {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '.' || character == '-' {
			continue
		}
		return false
	}
	return true
}
