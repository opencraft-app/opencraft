package hermes

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type profileSelection struct {
	Name     string
	Home     string
	Args     []string
	Explicit bool
}

func managedProfileName(agentID string) (string, error) {
	if strings.TrimSpace(agentID) == "" {
		return "", errors.New("Hermes managed Profile requires an Agent ID")
	}
	digest := sha256.Sum256([]byte(agentID))
	return "raft-" + hex.EncodeToString(digest[:16]), nil
}

func managedProfileSelection(
	trustedHome string,
	agentID string,
) (profileSelection, error) {
	trustedHome = strings.TrimSpace(trustedHome)
	if trustedHome == "" || !filepath.IsAbs(trustedHome) {
		return profileSelection{}, errors.New(
			"Hermes managed Profile requires an absolute trusted home",
		)
	}
	name, err := managedProfileName(agentID)
	if err != nil {
		return profileSelection{}, err
	}
	return profileSelection{
		Name: name,
		Home: filepath.Join(
			filepath.Clean(trustedHome),
			".hermes",
			"profiles",
			name,
		),
		Args:     []string{"--profile", name},
		Explicit: true,
	}, nil
}

func requireDirectory(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("Hermes profile home is not a directory")
	}
	return nil
}
