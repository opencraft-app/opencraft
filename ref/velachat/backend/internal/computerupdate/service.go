package computerupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"path"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	computerport "chatserver/internal/ports/computer"
	idport "chatserver/internal/ports/id"
)

var (
	ErrReleaseNotFound      = errors.New("Computer Release Set 不存在")
	ErrReleaseIncomplete    = errors.New("Computer Release Set 不完整")
	ErrChannelSigning       = errors.New("Computer Release Channel 无法签名")
	ErrUpdateStorage        = errors.New("Computer Update storage 不可用")
	ErrInvalidServiceConfig = errors.New("Computer Update service 配置无效")
)

type ReleaseBundle struct {
	Version  string
	Catalog  computerport.ArtifactBinding
	Releases []computerport.ReleaseBinding
}

type ReleaseSource interface {
	Open(context.Context, string) (ReleaseBundle, error)
}

type PromoteCommand struct {
	Channel             string
	ExpectedSequence    int64
	Version             string
	OperatorFingerprint []byte
}

type ChannelDownloads struct {
	CatalogURL           string
	ManifestURL          string
	ManifestSignatureURL string
	ProgramURL           string
	ExpiresAt            time.Time
}

type ChannelEnvelope struct {
	Signed    SignedDescriptor
	Downloads ChannelDownloads
	ETag      string
}

type ServiceConfig struct {
	Store             *Store
	Releases          ReleaseSource
	ChannelKeyID      string
	ChannelPrivateKey ed25519.PrivateKey
	URLs              computerport.ArtifactURLSigner
	URLTTL            time.Duration
	Clock             clockport.Clock
	IDs               idport.Generator
}

type Service struct {
	store      *Store
	releases   ReleaseSource
	keyID      string
	privateKey ed25519.PrivateKey
	urls       computerport.ArtifactURLSigner
	urlTTL     time.Duration
	clock      clockport.Clock
	ids        idport.Generator
}

func NewService(config ServiceConfig) (*Service, error) {
	if config.Store == nil || config.Releases == nil || config.URLs == nil ||
		config.Clock == nil || config.IDs == nil ||
		!keyIDPattern.MatchString(config.ChannelKeyID) ||
		len(config.ChannelPrivateKey) != ed25519.PrivateKeySize ||
		config.URLTTL < 2*time.Minute || config.URLTTL > 15*time.Minute {
		return nil, ErrInvalidServiceConfig
	}
	return &Service{
		store: config.Store, releases: config.Releases,
		keyID:      config.ChannelKeyID,
		privateKey: append(ed25519.PrivateKey(nil), config.ChannelPrivateKey...),
		urls:       config.URLs, urlTTL: config.URLTTL,
		clock: config.Clock, ids: config.IDs,
	}, nil
}

func (service *Service) Promote(
	ctx context.Context,
	command PromoteCommand,
) ([]ChannelView, error) {
	if service == nil || ctx == nil || command.ExpectedSequence < 0 ||
		(command.Channel != "stable" && command.Channel != "canary") ||
		!versionPattern.MatchString(command.Version) ||
		len(command.OperatorFingerprint) != sha256.Size {
		return nil, ErrInvalidDescriptor
	}
	bundle, err := service.releases.Open(ctx, command.Version)
	if err != nil {
		if errors.Is(err, ErrReleaseNotFound) {
			return nil, err
		}
		return nil, ErrUpdateStorage
	}
	releases, err := validateReleaseBundle(bundle, command.Version)
	if err != nil {
		return nil, err
	}
	now := service.clock.Now().UTC()
	sequence := command.ExpectedSequence + 1
	signed := make(map[string]SignedDescriptor, len(releases))
	for _, target := range []string{"darwin-arm64", "linux-amd64"} {
		descriptor := ChannelDescriptor{
			SchemaVersion: 1,
			Channel:       command.Channel, Target: target,
			Sequence: sequence, ExpectedVersion: command.Version,
			CatalogSHA256: append([]byte(nil), bundle.Catalog.SHA256[:]...),
			IssuedAt:      now,
		}
		value, err := SignDescriptor(descriptor, service.keyID, service.privateKey)
		if err != nil {
			return nil, ErrChannelSigning
		}
		signed[target] = value
	}
	auditID, err := service.ids.New()
	if err != nil {
		return nil, ErrUpdateStorage
	}
	views, err := service.store.Commit(ChannelCommit{
		Channel: command.Channel, ExpectedSequence: command.ExpectedSequence,
		Version:       command.Version,
		CatalogSHA256: append([]byte(nil), bundle.Catalog.SHA256[:]...),
		IssuedAt:      now, Signed: signed,
		AuditID:             auditID,
		OperatorFingerprint: append([]byte(nil), command.OperatorFingerprint...),
	})
	if err != nil {
		return nil, err
	}
	return views, nil
}

func (service *Service) GetChannel(
	ctx context.Context,
	channel string,
	target string,
) (ChannelEnvelope, error) {
	if service == nil || ctx == nil ||
		(channel != "stable" && channel != "canary") ||
		(target != "darwin-arm64" && target != "linux-amd64") {
		return ChannelEnvelope{}, ErrInvalidDescriptor
	}
	snapshot, err := service.store.Snapshot()
	if err != nil {
		return ChannelEnvelope{}, ErrUpdateStorage
	}
	view, ok := snapshot.Channels[channel][target]
	if !ok {
		return ChannelEnvelope{}, ErrReleaseNotFound
	}
	bundle, err := service.releases.Open(ctx, view.ExpectedVersion)
	if err != nil {
		if errors.Is(err, ErrReleaseNotFound) {
			return ChannelEnvelope{}, err
		}
		return ChannelEnvelope{}, ErrUpdateStorage
	}
	releases, err := validateReleaseBundle(bundle, view.ExpectedVersion)
	if err != nil || hex.EncodeToString(bundle.Catalog.SHA256[:]) != view.CatalogSHA256 {
		return ChannelEnvelope{}, ErrReleaseIncomplete
	}
	release := releases[target]
	keys := []string{
		bundle.Catalog.ObjectKey,
		release.Manifest.ObjectKey,
		release.Signature.ObjectKey,
		release.Program.ObjectKey,
	}
	locations := make([]string, 0, len(keys))
	for _, key := range keys {
		location, err := service.urls.PresignGet(ctx, key, service.urlTTL)
		if err != nil || !validDownloadURL(location) {
			return ChannelEnvelope{}, ErrUpdateStorage
		}
		locations = append(locations, location)
	}
	return ChannelEnvelope{
		Signed: view.Signed,
		Downloads: ChannelDownloads{
			CatalogURL: locations[0], ManifestURL: locations[1],
			ManifestSignatureURL: locations[2], ProgramURL: locations[3],
			ExpiresAt: service.clock.Now().UTC().Add(service.urlTTL),
		},
		ETag: `"sha256:` + view.DescriptorSHA256 + `"`,
	}, nil
}

func (service *Service) ListChannels() ([]ChannelView, error) {
	if service == nil {
		return nil, ErrUpdateStorage
	}
	snapshot, err := service.store.Snapshot()
	if err != nil {
		return nil, ErrUpdateStorage
	}
	result := make([]ChannelView, 0, 4)
	for _, channel := range []string{"canary", "stable"} {
		for _, target := range []string{"darwin-arm64", "linux-amd64"} {
			if value, ok := snapshot.Channels[channel][target]; ok {
				result = append(result, value)
			}
		}
	}
	return result, nil
}

func (service *Service) ListAudit(limit int) ([]AuditEntry, error) {
	if service == nil || limit < 1 || limit > 200 {
		return nil, ErrInvalidDescriptor
	}
	snapshot, err := service.store.Snapshot()
	if err != nil {
		return nil, ErrUpdateStorage
	}
	start := len(snapshot.Audit) - limit
	if start < 0 {
		start = 0
	}
	result := append([]AuditEntry(nil), snapshot.Audit[start:]...)
	for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
		result[left], result[right] = result[right], result[left]
	}
	return result, nil
}

func validateReleaseBundle(
	bundle ReleaseBundle,
	expectedVersion string,
) (map[string]computerport.ReleaseBinding, error) {
	if bundle.Version != expectedVersion || len(bundle.Releases) != 2 ||
		bundle.Catalog.ObjectKey !=
			"computer/releases/"+expectedVersion+"/release.catalog.json" ||
		bundle.Catalog.Size <= 0 {
		return nil, ErrReleaseIncomplete
	}
	result := make(map[string]computerport.ReleaseBinding, 2)
	for _, release := range bundle.Releases {
		if release.Version != expectedVersion ||
			(release.Target != "darwin-arm64" && release.Target != "linux-amd64") ||
			release.Program.Size <= 0 || release.Manifest.Size <= 0 ||
			release.Signature.Size != ed25519.SignatureSize ||
			!validReleaseObject(release.Manifest.ObjectKey, expectedVersion, release.Target, "manifest.json") ||
			!validReleaseObject(release.Signature.ObjectKey, expectedVersion, release.Target, "manifest.sig") ||
			!validReleaseObject(release.Program.ObjectKey, expectedVersion, release.Target, "vela-computer") {
			return nil, ErrReleaseIncomplete
		}
		if _, duplicate := result[release.Target]; duplicate {
			return nil, ErrReleaseIncomplete
		}
		result[release.Target] = release
	}
	if len(result) != 2 {
		return nil, ErrReleaseIncomplete
	}
	return result, nil
}

func validReleaseObject(key, version, target, filename string) bool {
	want := "computer/releases/" + version + "/" + target + "/" + filename
	return key == want && !path.IsAbs(key) && path.Clean(key) == key &&
		!strings.Contains(key, "..") && !strings.ContainsAny(key, "\r\n\x00")
}

func validDownloadURL(raw string) bool {
	parsed, err := url.Parse(raw)
	host := strings.ToLower(parsed.Hostname())
	return err == nil && parsed.Scheme == "https" && parsed.User == nil &&
		host != "" && (strings.HasSuffix(host, ".myqcloud.com") ||
		strings.HasSuffix(host, ".tencentcloudapi.com")) &&
		len(raw) <= 4096 && !strings.ContainsAny(raw, "\r\n")
}
