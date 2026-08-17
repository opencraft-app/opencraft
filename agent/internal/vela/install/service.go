package install

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"velachat/agent/internal/filelock"
	rootstate "velachat/agent/internal/state"
	"velachat/agent/internal/vela/tat"
)

var (
	ErrServiceInvalid             = errors.New("Computer 首次安装配置无效")
	ErrInstallConflict            = errors.New("Computer 首次安装状态冲突")
	ErrAlreadyInstalled           = errors.New("Vela Computer is already installed and active on this machine.")
	ErrDifferentServer            = errors.New("This machine is already connected to another Server. Remove or migrate the existing Computer before installing this setup code.")
	ErrReplacementReleaseMismatch = errors.New("Update Vela Computer before replacing this installation.")
	ErrReplacementProviderGone    = errors.New("The previous Computer provider identity no longer exists. Nothing was changed.")
)

const (
	installJournalName     = "install.journal.json"
	installTokenName       = "install.token"
	installSecretName      = "install.secret"
	replacementJournalName = "replacement.journal.json"
	replacementTokenName   = "replacement.enrollment"
	replacementSecretName  = "replacement.secret"
	replacementGrantName   = "replacement.grant"
	credentialName         = "computer.credential"
	configName             = "config.json"
	launchAgentLabel       = "com.agentnetwork.vela.computer"
)

type Options struct {
	PlatformURL               string
	AllowInsecurePlatformHTTP bool
	TokenFile                 string
	ManifestFile              string
	SignatureFile             string
	SigningPublicKey          string
	ReleaseVersion            string
	Target                    string
	ProgramFile               string
	InstallationRoot          string
	StateDirectory            string
}

type InstallClient interface {
	Claim(context.Context, ClaimRequest) (ClaimResult, error)
	Preflight(context.Context, PreflightRequest) (PreflightResult, error)
	Provider(context.Context, string) (ProviderResult, error)
}

type ClientFactory func(ClientConfig) (InstallClient, error)
type VerifyFunc func(VerifyConfig) (VerifiedRelease, error)

type LaunchSpec struct {
	Label               string
	ProgramPath         string
	ProgramSHA256       string
	RuntimeConfigDigest string
	InstallationRoot    string
	StateDirectory      string
}

type Launcher interface {
	Start(context.Context, LaunchSpec) error
}

type ServiceConfig struct {
	Stdout        io.Writer
	Random        io.Reader
	ClientFactory ClientFactory
	Verify        VerifyFunc
	TAT           tat.Runtime
	Launcher      Launcher
	Platform      *Platform
}

type Platform struct {
	OSType       string
	Architecture string
	Target       string
	ServiceName  string
}

type Service struct {
	config   ServiceConfig
	platform Platform
}

func NewService(config ServiceConfig) (*Service, error) {
	if config.Stdout == nil {
		return nil, ErrServiceInvalid
	}
	if config.Random == nil {
		config.Random = rand.Reader
	}
	if config.ClientFactory == nil {
		config.ClientFactory = func(config ClientConfig) (InstallClient, error) {
			return NewClient(config)
		}
	}
	if config.Verify == nil {
		config.Verify = VerifyRelease
	}
	if config.TAT == nil {
		config.TAT = tat.New()
	}
	if config.Launcher == nil {
		launcher, err := NewUserLaunchAgent()
		if err != nil {
			return nil, err
		}
		config.Launcher = launcher
	}
	platform, err := currentPlatform()
	if config.Platform != nil {
		platform = *config.Platform
	}
	if (err != nil && config.Platform == nil) || !validPlatform(platform) {
		return nil, ErrServiceInvalid
	}
	return &Service{config: config, platform: platform}, nil
}

func (service *Service) Install(ctx context.Context, options Options) error {
	if service == nil || ctx == nil || !validOptions(options, service.platform) {
		return ErrServiceInvalid
	}
	if err := ensurePrivateDirectory(options.InstallationRoot); err != nil {
		return err
	}
	if err := ensurePrivateDirectory(options.StateDirectory); err != nil {
		return err
	}
	lock, err := filelock.AcquireExclusive(filepath.Join(options.StateDirectory, "install.lock"))
	if err != nil {
		return err
	}
	defer lock.Release()

	release, err := service.config.Verify(VerifyConfig{
		ManifestPath: options.ManifestFile, SignaturePath: options.SignatureFile,
		ProgramPath: options.ProgramFile, PublicKey: options.SigningPublicKey,
		Version: options.ReleaseVersion, Target: options.Target,
	})
	if err != nil {
		return err
	}
	store := rootstate.New(options.StateDirectory)
	journal, exists, err := loadInstallJournal(store)
	if err != nil {
		return err
	}
	adoptRelease := false
	if !exists {
		journal, err = service.stageInstall(store, options, release)
		if err != nil {
			return err
		}
	} else if journal.Stage == "complete" {
		return service.replaceComplete(ctx, options, release, store, journal)
	} else if !journalMatches(journal, options, release) {
		if journal.Stage != "provider_registered" ||
			journal.PlatformURL != options.PlatformURL ||
			journal.AllowInsecureHTTP != options.AllowInsecurePlatformHTTP ||
			journal.Target != release.Target ||
			(!installedProgramMatchesJournal(options.InstallationRoot, journal) &&
				!installedProgramMatchesRelease(options.InstallationRoot, release)) {
			return ErrInstallConflict
		}
		adoptRelease = true
	}
	programPath, err := installProgram(options.ProgramFile, options.InstallationRoot, release)
	if err != nil {
		return err
	}
	if adoptRelease {
		journal.Version = release.Version
		journal.ProgramSHA256 = hex.EncodeToString(release.ProgramSHA256[:])
		if err := store.Write(installJournalName, journal); err != nil {
			return err
		}
	}

	claim := ClaimResult{
		ServerID: journal.ServerID, ComputerID: journal.ComputerID,
		CredentialID: journal.CredentialID, Version: journal.CredentialVersion,
		ExpiresAt: journal.CredentialExpiresAt,
	}
	if journal.Stage == "staged" {
		secretPart, err := readPrivateString(
			filepath.Join(options.StateDirectory, installSecretName),
			128,
		)
		if err != nil {
			return err
		}
		token, err := readPrivateString(
			filepath.Join(options.StateDirectory, installTokenName),
			2048,
		)
		if err != nil {
			return err
		}
		client, clientErr := service.config.ClientFactory(ClientConfig{
			BaseURL:           options.PlatformURL,
			AllowInsecureHTTP: options.AllowInsecurePlatformHTTP,
		})
		if clientErr != nil {
			return clientErr
		}
		claim, err = client.Claim(ctx, ClaimRequest{
			Token: token, SecretPart: secretPart, OSType: service.platform.OSType,
			Architecture: service.platform.Architecture, InstallerVersion: options.ReleaseVersion,
		})
		if err != nil {
			return err
		}
		journal.ServerID = claim.ServerID
		journal.ComputerID = claim.ComputerID
		journal.CredentialID = claim.CredentialID
		journal.CredentialVersion = claim.Version
		journal.CredentialExpiresAt = claim.ExpiresAt.UTC()
		journal.Stage = "claimed"
		if err := store.WriteFile(credentialName, []byte(claim.Credential), 0o600); err != nil {
			return err
		}
		if err := store.Write(installJournalName, journal); err != nil {
			return err
		}
	} else {
		credential, err := readPrivateString(
			filepath.Join(options.StateDirectory, credentialName),
			16*1024,
		)
		if err != nil {
			return err
		}
		claim.Credential = credential
	}
	if err := removeInstallSecrets(options.StateDirectory); err != nil {
		return err
	}

	if journal.Stage == "claimed" {
		provider, err := service.waitProvider(ctx, options, claim.Credential)
		if err != nil {
			return err
		}
		if !tatIdentityExists(options.StateDirectory) {
			tags := make([]tat.Tag, 0, len(provider.Registration.Tags))
			for _, tag := range provider.Registration.Tags {
				tags = append(tags, tat.Tag{Key: tag.Key, Value: tag.Value})
			}
			if err := service.config.TAT.Register(ctx, tat.Registration{
				StateRoot:         filepath.Join(options.StateDirectory, "tat"),
				Region:            provider.Registration.Region,
				RegisterCodeID:    provider.Registration.CodeID,
				RegisterCodeValue: provider.Registration.CodeValue,
				Tags:              tags,
			}); err != nil {
				return err
			}
		}
		journal.Region = provider.Registration.Region
		journal.Stage = "provider_registered"
		if err := store.Write(installJournalName, journal); err != nil {
			return err
		}
	}
	if journal.Stage == "provider_registered" {
		if err := writeManagedState(store, options, journal); err != nil {
			return err
		}
		runtimeDigest, err := runtimeConfigDigest(options, journal)
		if err != nil {
			return err
		}
		if err := service.config.Launcher.Start(ctx, LaunchSpec{
			Label:               service.platform.ServiceName,
			ProgramPath:         programPath,
			ProgramSHA256:       hex.EncodeToString(release.ProgramSHA256[:]),
			RuntimeConfigDigest: runtimeDigest,
			InstallationRoot:    options.InstallationRoot,
			StateDirectory:      options.StateDirectory,
		}); err != nil {
			return err
		}
		journal.Stage = "complete"
		if err := store.Write(installJournalName, journal); err != nil {
			return err
		}
	}
	_, err = io.WriteString(service.config.Stdout, "Computer installed and registered.\n")
	return err
}

func (service *Service) replaceComplete(
	ctx context.Context,
	options Options,
	release VerifiedRelease,
	store *rootstate.Store,
	journal installJournal,
) error {
	if journal.PlatformURL != options.PlatformURL ||
		journal.AllowInsecureHTTP != options.AllowInsecurePlatformHTTP ||
		journal.Target != release.Target ||
		!installedProgramMatchesJournal(options.InstallationRoot, journal) {
		return ErrReplacementReleaseMismatch
	}
	token, err := readPrivateString(options.TokenFile, 2048)
	if err != nil || !validEnrollmentToken(token) {
		return ErrServiceInvalid
	}
	newServerID, newComputerID, okToken := enrollmentRoute(token)
	if !okToken {
		return ErrInstallConflict
	}
	client, err := service.config.ClientFactory(ClientConfig{
		BaseURL: options.PlatformURL, AllowInsecureHTTP: options.AllowInsecurePlatformHTTP,
	})
	if err != nil {
		return err
	}
	replacement, exists, err := loadReplacementJournal(store)
	if err != nil {
		return err
	}
	if exists {
		committed, reconcileErr := service.reconcileCommittedReplacement(ctx, options, store, journal, replacement)
		if reconcileErr != nil {
			return reconcileErr
		}
		if committed {
			if replacementMatches(replacement, options, release, token, newServerID, newComputerID) {
				_, writeErr := io.WriteString(service.config.Stdout, "Computer replaced and registered.\n")
				return writeErr
			}
			exists = false
		}
	}
	var identity tat.Identity
	var secretPart, grant string
	if exists {
		if !replacementMatches(replacement, options, release, token, newServerID, newComputerID) {
			return ErrInstallConflict
		}
		identity = tat.Identity{Region: replacement.TATRegion, InstanceID: replacement.TATInstanceID}
		secretPart, err = readPrivateString(filepath.Join(options.StateDirectory, replacementSecretName), 128)
		if err == nil {
			grant, err = readPrivateString(filepath.Join(options.StateDirectory, replacementGrantName), 64*1024)
		}
		if err != nil {
			return err
		}
	} else {
		credential, err := readPrivateString(filepath.Join(options.StateDirectory, credentialName), 16*1024)
		if err != nil {
			return err
		}
		oldServerID, _, ok := credentialRoute(credential)
		if !ok {
			return ErrInstallConflict
		}
		if oldServerID != newServerID {
			return ErrDifferentServer
		}
		identity, err = service.config.TAT.Inspect(ctx, filepath.Join(options.StateDirectory, "tat"))
		if err != nil {
			return err
		}
		preflight, err := client.Preflight(ctx, PreflightRequest{
			Credential: credential, EnrollmentToken: token,
			TATRegion: identity.Region, TATInstanceID: identity.InstanceID,
		})
		if err != nil {
			return err
		}
		switch preflight.Status {
		case PreflightActive:
			return ErrAlreadyInstalled
		case PreflightProviderIdentityGone:
			return ErrReplacementProviderGone
		case PreflightRemoved:
			grant = preflight.ReplacementGrant
		default:
			return ErrInstallConflict
		}
		secret := make([]byte, 32)
		if _, err := io.ReadFull(service.config.Random, secret); err != nil {
			return err
		}
		secretPart = base64.RawURLEncoding.EncodeToString(secret)
		clear(secret)
		replacement = newReplacementJournal(options, release, token, newServerID, newComputerID, identity)
		if err := store.WriteFile(replacementTokenName, []byte(token), 0o600); err != nil {
			return err
		}
		if err := store.WriteFile(replacementSecretName, []byte(secretPart), 0o600); err != nil {
			return err
		}
		if err := store.WriteFile(replacementGrantName, []byte(grant), 0o600); err != nil {
			return err
		}
		if err := store.Write(replacementJournalName, replacement); err != nil {
			return err
		}
	}
	claim, err := client.Claim(ctx, ClaimRequest{
		Token: token, SecretPart: secretPart, OSType: service.platform.OSType,
		Architecture:     service.platform.Architecture,
		InstallerVersion: options.ReleaseVersion, ReplacementGrant: grant,
	})
	if err != nil {
		return err
	}
	if claim.ServerID != newServerID || claim.ComputerID != newComputerID {
		return ErrInstallConflict
	}
	if _, err := installProgram(
		options.ProgramFile,
		options.InstallationRoot,
		release,
	); err != nil {
		return err
	}
	journal.Version = release.Version
	journal.ProgramSHA256 = hex.EncodeToString(release.ProgramSHA256[:])
	journal.ServerID = claim.ServerID
	journal.ComputerID = claim.ComputerID
	journal.CredentialID = claim.CredentialID
	journal.CredentialVersion = claim.Version
	journal.CredentialExpiresAt = claim.ExpiresAt.UTC()
	journal.Region = identity.Region
	if err := store.Write(installJournalName, journal); err != nil {
		return err
	}
	if err := store.WriteFile(credentialName, []byte(claim.Credential), 0o600); err != nil {
		return err
	}
	if err := writeManagedState(store, options, journal); err != nil {
		return err
	}
	runtimeDigest, err := runtimeConfigDigest(options, journal)
	if err != nil {
		return err
	}
	if err := service.config.Launcher.Start(ctx, LaunchSpec{
		Label:               service.platform.ServiceName,
		ProgramPath:         filepath.Join(options.InstallationRoot, "bin", ProgramName),
		ProgramSHA256:       hex.EncodeToString(release.ProgramSHA256[:]),
		RuntimeConfigDigest: runtimeDigest,
		InstallationRoot:    options.InstallationRoot,
		StateDirectory:      options.StateDirectory,
	}); err != nil {
		return err
	}
	if err := removeReplacementSecrets(store); err != nil {
		return err
	}
	_, err = io.WriteString(service.config.Stdout, "Computer replaced and registered.\n")
	return err
}

type replacementJournal struct {
	Schema        int    `json:"schema"`
	Stage         string `json:"stage"`
	PlatformURL   string `json:"platformUrl"`
	Version       string `json:"version"`
	Target        string `json:"target"`
	ProgramSHA256 string `json:"programSha256"`
	TokenSHA256   string `json:"tokenSha256"`
	ServerID      string `json:"serverId"`
	ComputerID    string `json:"computerId"`
	TATRegion     string `json:"tatRegion"`
	TATInstanceID string `json:"tatInstanceId"`
}

func newReplacementJournal(options Options, release VerifiedRelease, token, serverID, computerID string, identity tat.Identity) replacementJournal {
	tokenDigest := sha256.Sum256([]byte(token))
	return replacementJournal{
		Schema: 1, Stage: "grant_issued", PlatformURL: options.PlatformURL,
		Version: options.ReleaseVersion, Target: options.Target,
		ProgramSHA256: hex.EncodeToString(release.ProgramSHA256[:]),
		TokenSHA256:   hex.EncodeToString(tokenDigest[:]), ServerID: serverID, ComputerID: computerID,
		TATRegion: identity.Region, TATInstanceID: identity.InstanceID,
	}
}

func loadReplacementJournal(store *rootstate.Store) (replacementJournal, bool, error) {
	var value replacementJournal
	err := store.Read(replacementJournalName, &value)
	if errors.Is(err, os.ErrNotExist) {
		return replacementJournal{}, false, nil
	}
	if err != nil || value.Schema != 1 || value.Stage != "grant_issued" {
		return replacementJournal{}, false, ErrInstallConflict
	}
	return value, true, nil
}

func replacementMatches(value replacementJournal, options Options, release VerifiedRelease, token, serverID, computerID string) bool {
	tokenDigest := sha256.Sum256([]byte(token))
	return value.PlatformURL == options.PlatformURL && value.Version == options.ReleaseVersion &&
		value.Target == options.Target && value.ProgramSHA256 == hex.EncodeToString(release.ProgramSHA256[:]) &&
		value.TokenSHA256 == hex.EncodeToString(tokenDigest[:]) && value.ServerID == serverID &&
		value.ComputerID == computerID && value.TATRegion != "" && strings.HasPrefix(value.TATInstanceID, "rins-")
}

func removeReplacementSecrets(store *rootstate.Store) error {
	for _, name := range []string{replacementTokenName, replacementSecretName, replacementGrantName, replacementJournalName} {
		if err := store.Remove(name); err != nil {
			return err
		}
	}
	return nil
}

func (service *Service) reconcileCommittedReplacement(
	ctx context.Context,
	options Options,
	store *rootstate.Store,
	journal installJournal,
	replacement replacementJournal,
) (bool, error) {
	if journal.Stage != "complete" || replacement.PlatformURL != journal.PlatformURL ||
		replacement.Version != journal.Version || replacement.Target != journal.Target ||
		replacement.ProgramSHA256 != journal.ProgramSHA256 || replacement.ServerID != journal.ServerID ||
		replacement.ComputerID != journal.ComputerID || replacement.TATRegion != journal.Region ||
		!strings.HasPrefix(replacement.TATInstanceID, "rins-") ||
		!installedProgramMatchesJournal(options.InstallationRoot, journal) {
		return false, nil
	}
	credential, err := readPrivateString(filepath.Join(options.StateDirectory, credentialName), 16*1024)
	if err != nil {
		return false, nil
	}
	serverID, computerID, ok := credentialRoute(credential)
	if !ok || serverID != journal.ServerID || computerID != journal.ComputerID {
		return false, nil
	}
	var config struct {
		PlatformURL       string `json:"platformUrl"`
		AllowInsecureHTTP bool   `json:"allowInsecureHttp"`
		ServerID          string `json:"serverId"`
		ComputerID        string `json:"computerId"`
		Region            string `json:"region"`
	}
	if err := store.Read(configName, &config); err != nil ||
		config.PlatformURL != journal.PlatformURL ||
		config.AllowInsecureHTTP != journal.AllowInsecureHTTP ||
		config.ServerID != journal.ServerID || config.ComputerID != journal.ComputerID ||
		config.Region != journal.Region {
		return false, nil
	}
	var credentialMeta struct {
		CredentialID string `json:"credentialId"`
		Version      uint64 `json:"version"`
	}
	if err := store.Read("computer.credential.meta.json", &credentialMeta); err != nil ||
		credentialMeta.CredentialID != journal.CredentialID ||
		credentialMeta.Version != journal.CredentialVersion {
		return false, nil
	}
	runtimeDigest, err := runtimeConfigDigest(options, journal)
	if err != nil {
		return true, err
	}
	if err := service.config.Launcher.Start(ctx, LaunchSpec{
		Label:               service.platform.ServiceName,
		ProgramPath:         filepath.Join(options.InstallationRoot, "bin", ProgramName),
		ProgramSHA256:       journal.ProgramSHA256,
		RuntimeConfigDigest: runtimeDigest,
		InstallationRoot:    options.InstallationRoot,
		StateDirectory:      options.StateDirectory,
	}); err != nil {
		return true, err
	}
	return true, removeReplacementSecrets(store)
}

func runtimeConfigDigest(options Options, journal installJournal) (string, error) {
	platformURL, ok := normalizeInstallBaseURL(
		options.PlatformURL,
		options.AllowInsecurePlatformHTTP,
	)
	if !ok || !uuidV7(journal.ServerID) || !uuidV7(journal.ComputerID) ||
		!uuidV7(journal.CredentialID) || journal.CredentialVersion == 0 ||
		!filepath.IsAbs(options.StateDirectory) ||
		filepath.Clean(options.StateDirectory) != options.StateDirectory {
		return "", ErrInstallConflict
	}
	digest := sha256.New()
	for _, value := range []string{
		"vela-computer-runtime-config/v1",
		platformURL,
		journal.ServerID,
		journal.ComputerID,
		journal.CredentialID,
		strconv.FormatUint(journal.CredentialVersion, 10),
		options.StateDirectory,
	} {
		var length [8]byte
		binary.BigEndian.PutUint64(length[:], uint64(len(value)))
		_, _ = digest.Write(length[:])
		_, _ = digest.Write([]byte(value))
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func installedProgramMatchesJournal(root string, journal installJournal) bool {
	expected, err := hex.DecodeString(journal.ProgramSHA256)
	if err != nil || len(expected) != sha256.Size {
		return false
	}
	path := filepath.Join(root, "bin", ProgramName)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	digest := sha256.New()
	_, copyErr := io.Copy(digest, file)
	closeErr := file.Close()
	return copyErr == nil && closeErr == nil &&
		subtle.ConstantTimeCompare(digest.Sum(nil), expected) == 1
}

func installedProgramMatchesRelease(root string, release VerifiedRelease) bool {
	path := filepath.Join(root, "bin", ProgramName)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Size() != release.ProgramSize {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	digest := sha256.New()
	_, copyErr := io.Copy(digest, file)
	closeErr := file.Close()
	return copyErr == nil && closeErr == nil &&
		subtle.ConstantTimeCompare(digest.Sum(nil), release.ProgramSHA256[:]) == 1
}

func credentialRoute(value string) (string, string, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 4 || !strings.HasPrefix(parts[0], "crc_") {
		return "", "", false
	}
	return strings.TrimPrefix(parts[0], "crc_"), parts[1], true
}

func enrollmentRoute(value string) (string, string, bool) {
	parts := strings.Split(value, ".")
	if len(parts) < 5 || parts[0] != "cen1" || !uuidV7(parts[1]) || !uuidV7(parts[2]) {
		return "", "", false
	}
	return parts[1], parts[2], true
}

func removeInstallSecrets(stateDirectory string) error {
	for _, name := range []string{installTokenName, installSecretName} {
		err := os.Remove(filepath.Join(stateDirectory, name))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (service *Service) waitProvider(ctx context.Context, options Options, credential string) (ProviderResult, error) {
	client, err := service.config.ClientFactory(ClientConfig{
		BaseURL:           options.PlatformURL,
		AllowInsecureHTTP: options.AllowInsecurePlatformHTTP,
	})
	if err != nil {
		return ProviderResult{}, err
	}
	for {
		result, err := client.Provider(ctx, credential)
		if err != nil || result.Ready {
			return result, err
		}
		timer := time.NewTimer(result.RetryAfter)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ProviderResult{}, ctx.Err()
		case <-timer.C:
		}
	}
}

type installJournal struct {
	Schema              int       `json:"schema"`
	Stage               string    `json:"stage"`
	TransactionID       string    `json:"transactionId"`
	PlatformURL         string    `json:"platformUrl"`
	AllowInsecureHTTP   bool      `json:"allowInsecureHttp"`
	Version             string    `json:"version"`
	Target              string    `json:"target"`
	ProgramSHA256       string    `json:"programSha256"`
	ServerID            string    `json:"serverId,omitempty"`
	ComputerID          string    `json:"computerId,omitempty"`
	CredentialID        string    `json:"credentialId,omitempty"`
	CredentialVersion   uint64    `json:"credentialVersion,omitempty"`
	CredentialExpiresAt time.Time `json:"credentialExpiresAt,omitempty"`
	Region              string    `json:"region,omitempty"`
}

func (service *Service) stageInstall(store *rootstate.Store, options Options, release VerifiedRelease) (installJournal, error) {
	token, err := readPrivateString(options.TokenFile, 2048)
	if err != nil || !validEnrollmentToken(token) {
		return installJournal{}, ErrServiceInvalid
	}
	secret := make([]byte, 32)
	if _, err := io.ReadFull(service.config.Random, secret); err != nil {
		return installJournal{}, err
	}
	defer clear(secret)
	secretPart := base64.RawURLEncoding.EncodeToString(secret)
	transactionID, err := uuid.NewV7()
	if err != nil {
		return installJournal{}, err
	}
	if err := store.WriteFile(installTokenName, []byte(token), 0o600); err != nil {
		return installJournal{}, err
	}
	if err := store.WriteFile(installSecretName, []byte(secretPart), 0o600); err != nil {
		return installJournal{}, err
	}
	journal := installJournal{
		Schema: 1, Stage: "staged", TransactionID: transactionID.String(),
		PlatformURL:       options.PlatformURL,
		AllowInsecureHTTP: options.AllowInsecurePlatformHTTP,
		Version:           options.ReleaseVersion, Target: options.Target,
		ProgramSHA256: hex.EncodeToString(release.ProgramSHA256[:]),
	}
	return journal, store.Write(installJournalName, journal)
}

func loadInstallJournal(store *rootstate.Store) (installJournal, bool, error) {
	var journal installJournal
	err := store.Read(installJournalName, &journal)
	if os.IsNotExist(err) {
		return installJournal{}, false, nil
	}
	if err != nil || journal.Schema != 1 || !validComponent(journal.Version) ||
		!validComponent(journal.Target) || !uuidV7(journal.TransactionID) {
		return installJournal{}, false, ErrInstallConflict
	}
	return journal, true, nil
}

func journalMatches(journal installJournal, options Options, release VerifiedRelease) bool {
	return journal.PlatformURL == options.PlatformURL &&
		journal.AllowInsecureHTTP == options.AllowInsecurePlatformHTTP &&
		journal.Version == options.ReleaseVersion && journal.Target == options.Target &&
		journal.ProgramSHA256 == hex.EncodeToString(release.ProgramSHA256[:])
}

func writeManagedState(store *rootstate.Store, options Options, journal installJournal) error {
	if !uuidV7(journal.ServerID) || !uuidV7(journal.ComputerID) || journal.Region == "" {
		return ErrInstallConflict
	}
	if err := store.Write(configName, struct {
		SchemaVersion     int    `json:"schemaVersion"`
		PlatformURL       string `json:"platformUrl"`
		AllowInsecureHTTP bool   `json:"allowInsecureHttp,omitempty"`
		ServerID          string `json:"serverId"`
		ComputerID        string `json:"computerId"`
		Name              string `json:"name"`
		Region            string `json:"region"`
	}{
		SchemaVersion: 1, PlatformURL: options.PlatformURL,
		AllowInsecureHTTP: options.AllowInsecurePlatformHTTP,
		ServerID:          journal.ServerID, ComputerID: journal.ComputerID,
		Name: "Computer " + journal.ComputerID[:8], Region: journal.Region,
	}); err != nil {
		return err
	}
	return store.Write("computer.credential.meta.json", struct {
		SchemaVersion int       `json:"schemaVersion"`
		CredentialID  string    `json:"credentialId"`
		Version       uint64    `json:"version"`
		ExpiresAt     time.Time `json:"expiresAt"`
	}{
		SchemaVersion: 1, CredentialID: journal.CredentialID,
		Version: journal.CredentialVersion, ExpiresAt: journal.CredentialExpiresAt,
	})
}

func installProgram(source string, root string, release VerifiedRelease) (string, error) {
	bin := filepath.Join(root, "bin")
	if err := ensurePrivateDirectory(bin); err != nil {
		return "", err
	}
	input, err := os.Open(source)
	if err != nil {
		return "", ErrReleaseInvalid
	}
	defer input.Close()
	output, err := os.CreateTemp(bin, ".vela-computer-*.tmp")
	if err != nil {
		return "", err
	}
	temporary := output.Name()
	defer os.Remove(temporary)
	if err := output.Chmod(0o700); err != nil {
		_ = output.Close()
		return "", err
	}
	digest := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(output, digest), input)
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil || written != release.ProgramSize ||
		subtle.ConstantTimeCompare(digest.Sum(nil), release.ProgramSHA256[:]) != 1 {
		return "", ErrReleaseInvalid
	}
	target := filepath.Join(bin, ProgramName)
	if err := os.Rename(temporary, target); err != nil {
		return "", err
	}
	return target, syncDirectory(bin)
}

func validOptions(options Options, platform Platform) bool {
	if options.StateDirectory != filepath.Join(options.InstallationRoot, "state") ||
		!validComponent(options.ReleaseVersion) || options.Target != platform.Target ||
		!validPlatform(platform) {
		return false
	}
	for _, value := range []string{
		options.TokenFile, options.ManifestFile, options.SignatureFile,
		options.ProgramFile, options.InstallationRoot, options.StateDirectory,
	} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return false
		}
	}
	_, ok := normalizeInstallBaseURL(options.PlatformURL, options.AllowInsecurePlatformHTTP)
	return ok
}

func validPlatform(platform Platform) bool {
	switch platform.Target {
	case "darwin-arm64":
		return platform.OSType == "macos" && platform.Architecture == "arm64" &&
			platform.ServiceName == launchAgentLabel
	case "linux-amd64":
		return platform.OSType == "linux" && platform.Architecture == "amd64" &&
			platform.ServiceName == linuxSystemdUnit
	default:
		return false
	}
}

func ensurePrivateDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			return err
		}
		info, err = os.Lstat(directory)
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 {
		return ErrServiceInvalid
	}
	return nil
}

func readPrivateString(filename string, limit int64) (string, error) {
	before, err := os.Lstat(filename)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 ||
		before.Mode().Perm() != 0o600 || before.Size() < 1 || before.Size() > limit {
		return "", ErrServiceInvalid
	}
	file, err := os.Open(filename)
	if err != nil {
		return "", ErrServiceInvalid
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return "", ErrServiceInvalid
	}
	content, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(content)) != before.Size() {
		return "", ErrServiceInvalid
	}
	defer clear(content)
	value := string(content)
	if strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return "", ErrServiceInvalid
	}
	return value, nil
}

func tatIdentityExists(stateDirectory string) bool {
	info, err := os.Lstat(filepath.Join(stateDirectory, "tat", "config.dat"))
	return err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

func syncDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	err = file.Sync()
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}
