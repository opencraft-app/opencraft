package install

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"velachat/agent/internal/filelock"
	rootstate "velachat/agent/internal/state"
	"velachat/agent/internal/vela/tat"
)

var (
	ErrServiceInvalid  = errors.New("Computer 首次安装配置无效")
	ErrInstallConflict = errors.New("Computer 首次安装状态冲突")
)

const (
	installJournalName = "install.journal.json"
	installTokenName   = "install.token"
	installSecretName  = "install.secret"
	credentialName     = "computer.credential"
	configName         = "config.json"
	launchAgentLabel   = "com.agentnetwork.vela.computer"
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
	Provider(context.Context, string) (ProviderResult, error)
}

type ClientFactory func(ClientConfig) (InstallClient, error)
type VerifyFunc func(VerifyConfig) (VerifiedRelease, error)

type LaunchSpec struct {
	Label            string
	ProgramPath      string
	InstallationRoot string
	StateDirectory   string
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
}

type Service struct{ config ServiceConfig }

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
	return &Service{config: config}, nil
}

func (service *Service) Install(ctx context.Context, options Options) error {
	if service == nil || ctx == nil || !validOptions(options) {
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
	if !exists {
		journal, err = service.stageInstall(store, options, release)
		if err != nil {
			return err
		}
	} else if !journalMatches(journal, options, release) {
		return ErrInstallConflict
	}
	programPath, err := installProgram(options.ProgramFile, options.InstallationRoot, release)
	if err != nil {
		return err
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
			Token: token, SecretPart: secretPart, OSType: "macos",
			Architecture: "arm64", InstallerVersion: options.ReleaseVersion,
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
		if err := service.config.Launcher.Start(ctx, LaunchSpec{
			Label: launchAgentLabel, ProgramPath: programPath,
			InstallationRoot: options.InstallationRoot,
			StateDirectory:   options.StateDirectory,
		}); err != nil {
			return err
		}
		journal.Stage = "complete"
		if err := store.Write(installJournalName, journal); err != nil {
			return err
		}
	}
	_, err = io.WriteString(service.config.Stdout, "Computer installed and started.\n")
	return err
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
		SchemaVersion int    `json:"schemaVersion"`
		PlatformURL   string `json:"platformUrl"`
		ServerID      string `json:"serverId"`
		ComputerID    string `json:"computerId"`
		Name          string `json:"name"`
		Region        string `json:"region"`
	}{
		SchemaVersion: 1, PlatformURL: options.PlatformURL,
		ServerID: journal.ServerID, ComputerID: journal.ComputerID,
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

func validOptions(options Options) bool {
	if options.StateDirectory != filepath.Join(options.InstallationRoot, "state") ||
		!validComponent(options.ReleaseVersion) || options.Target != "darwin-arm64" {
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
