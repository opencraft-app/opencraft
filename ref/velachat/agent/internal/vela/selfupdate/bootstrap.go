package selfupdate

import (
	"crypto/ed25519"
	"encoding/base64"
	"strings"
)

type BootstrapConfig struct {
	ChannelURL        string
	Channel           string
	ChannelKeyID      string
	ChannelPublicKey  string
	ReleaseKeyID      string
	ReleasePublicKey  string
	AllowInsecureHTTP bool
}

type ResolvedBootstrap struct {
	ChannelURL        string
	Channel           string
	ChannelKeyID      string
	ChannelPublicKey  ed25519.PublicKey
	ReleasePublicKeys map[string]ed25519.PublicKey
	AllowInsecureHTTP bool
}

func ResolveBootstrap(config BootstrapConfig) (ResolvedBootstrap, bool, error) {
	values := []string{
		config.ChannelURL, config.Channel, config.ChannelKeyID,
		config.ChannelPublicKey, config.ReleaseKeyID, config.ReleasePublicKey,
	}
	nonempty := 0
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			nonempty++
		}
	}
	if nonempty == 0 {
		if config.AllowInsecureHTTP {
			return ResolvedBootstrap{}, false, ErrPollerInvalid
		}
		return ResolvedBootstrap{}, false, nil
	}
	if nonempty != len(values) || (config.Channel != "stable" && config.Channel != "canary") ||
		!keyIDPattern.MatchString(config.ChannelKeyID) || !keyIDPattern.MatchString(config.ReleaseKeyID) {
		return ResolvedBootstrap{}, false, ErrPollerInvalid
	}
	baseURL, ok := normalizeChannelBaseURL(config.ChannelURL, false, config.AllowInsecureHTTP)
	if !ok {
		return ResolvedBootstrap{}, false, ErrPollerInvalid
	}
	channelKey, err := base64.RawStdEncoding.Strict().DecodeString(config.ChannelPublicKey)
	if err != nil || len(channelKey) != ed25519.PublicKeySize {
		return ResolvedBootstrap{}, false, ErrPollerInvalid
	}
	releaseKey, err := base64.RawStdEncoding.Strict().DecodeString(config.ReleasePublicKey)
	if err != nil || len(releaseKey) != ed25519.PublicKeySize {
		return ResolvedBootstrap{}, false, ErrPollerInvalid
	}
	return ResolvedBootstrap{
		ChannelURL: baseURL, Channel: config.Channel, ChannelKeyID: config.ChannelKeyID,
		ChannelPublicKey: append(ed25519.PublicKey(nil), channelKey...),
		ReleasePublicKeys: map[string]ed25519.PublicKey{
			config.ReleaseKeyID: append(ed25519.PublicKey(nil), releaseKey...),
		},
		AllowInsecureHTTP: config.AllowInsecureHTTP,
	}, true, nil
}
