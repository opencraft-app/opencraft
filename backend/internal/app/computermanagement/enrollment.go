package computermanagement

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	computerport "chatserver/internal/ports/computer"
	idport "chatserver/internal/ports/id"
)

var releaseComponent = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type EnrollmentConfig struct {
	Release           computerport.ReleaseBinding
	PlatformBaseURL   string
	AllowInsecureHTTP bool
	TokenTTL          time.Duration
	CredentialTTL     time.Duration
	Random            io.Reader
}

type EnrollmentService struct {
	repository computerport.EnrollmentRepository
	ids        idport.Generator
	clock      clockport.Clock
	config     EnrollmentConfig
}

type SetupCommand struct {
	ComputerID string
	Generation uint64
	Command    string
	ExpiresAt  time.Time
	Revision   int64
}

type SetupCodeScript struct {
	Script    string
	ExpiresAt time.Time
}

type ClaimCommand struct {
	Token            string
	OSType           string
	Architecture     string
	InstallerVersion string
	CredentialDigest [32]byte
}

type ClaimResult struct {
	ServerID          string
	ComputerID        string
	CredentialID      string
	CredentialVersion uint64
	ExpiresAt         time.Time
}

type InstallationPlatform struct {
	OSType        string
	Architectures []string
}

type InstallationOptions struct {
	ReleaseVersion string
	Platforms      []InstallationPlatform
}

func NewEnrollmentService(
	repository computerport.EnrollmentRepository,
	ids idport.Generator,
	clock clockport.Clock,
	config EnrollmentConfig,
) (*EnrollmentService, error) {
	platformBaseURL, urlErr := normalizeInstallBaseURL(
		config.PlatformBaseURL,
		config.AllowInsecureHTTP,
	)
	if repository == nil || ids == nil || clock == nil || config.Random == nil ||
		config.TokenTTL <= 0 || config.TokenTTL > 24*time.Hour ||
		config.CredentialTTL <= 0 || !validRelease(config.Release) ||
		urlErr != nil {
		return nil, errors.New("Computer enrollment 服务配置无效")
	}
	config.PlatformBaseURL = platformBaseURL
	return &EnrollmentService{
		repository: repository, ids: ids, clock: clock, config: config,
	}, nil
}

// InstallationOptions 返回与 setup/claim 共用的固定发布目录。
func (service *EnrollmentService) InstallationOptions() InstallationOptions {
	return InstallationOptions{
		ReleaseVersion: service.config.Release.Version,
		Platforms: []InstallationPlatform{{
			OSType: service.config.Release.OSType,
			Architectures: []string{
				service.config.Release.Architecture,
			},
		}},
	}
}

func (service *EnrollmentService) CreateSetupCommand(
	ctx context.Context,
	accountID string,
	serverID string,
	computerID string,
	expectedRevision int64,
) (SetupCommand, error) {
	if !validEnrollmentUUID(accountID) || !validEnrollmentUUID(serverID) ||
		!validEnrollmentUUID(computerID) || expectedRevision < 1 {
		return SetupCommand{}, apperror.New("invalid_request", "安装命令参数无效", nil)
	}
	computer, err := service.repository.GetForAdmin(
		ctx, accountID, serverID, computerID,
	)
	if err != nil {
		return SetupCommand{}, mapRepositoryError(err)
	}
	if computer.ServerID != serverID || computer.ID != computerID ||
		computer.Revision != expectedRevision {
		return SetupCommand{}, apperror.New(
			"revision_conflict", "Computer 已被其他操作修改", computerport.ErrEnrollmentRevisionConflict,
		)
	}
	if computer.EnrollmentClaimedAt != nil {
		return SetupCommand{}, apperror.New(
			"computer_already_claimed", "Computer 已完成连接", computerport.ErrComputerAlreadyClaimed,
		)
	}
	if computer.LifecycleState == "removed" || computer.OSType != service.config.Release.OSType ||
		computer.EnrollmentGeneration >= math.MaxInt64 {
		return SetupCommand{}, apperror.New("computer_not_ready", "Computer 当前不能生成安装命令", nil)
	}
	generation := computer.EnrollmentGeneration + 1
	displayCode, canonicalCode, err := generateSetupCode(service.config.Random)
	if err != nil {
		return SetupCommand{}, apperror.New("internal_error", "暂时无法生成安装命令", err)
	}
	secret := deriveEnrollmentSecret(canonicalCode, serverID, computerID, generation)
	token, err := newEnrollmentToken(serverID, computerID, generation, secret[:])
	if err != nil {
		return SetupCommand{}, apperror.New("internal_error", "暂时无法生成安装命令", err)
	}
	setupCodeID, err := service.ids.New()
	if err != nil || !validEnrollmentUUID(setupCodeID) {
		return SetupCommand{}, apperror.New("internal_error", "暂时无法生成安装命令", err)
	}
	now := service.clock.Now().UTC()
	expiresAt := now.Add(service.config.TokenTTL)
	stored, err := service.repository.BeginEnrollment(
		ctx,
		computerport.BeginEnrollmentCommand{
			AccountID: accountID, ServerID: serverID, ComputerID: computerID,
			ExpectedRevision:   expectedRevision,
			ExpectedGeneration: computer.EnrollmentGeneration,
			Generation:         generation, TokenHash: sha256.Sum256([]byte(token)),
			ExpiresAt: expiresAt, Release: service.config.Release, CreatedAt: now,
		},
	)
	if err != nil {
		return SetupCommand{}, mapEnrollmentError(err)
	}
	if stored.ID != computerID || stored.ServerID != serverID ||
		stored.EnrollmentGeneration != generation || stored.Revision != expectedRevision+1 {
		return SetupCommand{}, apperror.New("internal_error", "Computer enrollment 数据无效", nil)
	}
	if err := service.repository.StoreSetupCode(ctx, computerport.StoreSetupCodeCommand{
		ID: setupCodeID, CodeHash: setupCodeHash(canonicalCode),
		ServerID: serverID, ComputerID: computerID, Generation: generation,
		ExpiresAt: expiresAt, CreatedAt: now,
	}); err != nil {
		return SetupCommand{}, apperror.New("internal_error", "暂时无法生成安装命令", err)
	}
	return SetupCommand{
		ComputerID: computerID, Generation: generation,
		Command: service.shortSetupCommand(displayCode), ExpiresAt: expiresAt,
		Revision: stored.Revision,
	}, nil
}

func (service *EnrollmentService) shortSetupCommand(displayCode string) string {
	options := "-fsSL"
	if service.config.AllowInsecureHTTP {
		options = "-fsS"
	}
	return "curl " + options + " " + service.config.PlatformBaseURL +
		"/install | sh -s -- " + displayCode
}

func (service *EnrollmentService) RedeemSetupCode(
	ctx context.Context,
	code string,
) (SetupCodeScript, error) {
	canonicalCode, err := normalizeSetupCode(code)
	if err != nil {
		return SetupCodeScript{}, invalidSetupCode(err)
	}
	now := service.clock.Now().UTC()
	route, err := service.repository.ResolveSetupCode(ctx, computerport.ResolveSetupCodeCommand{
		CodeHash: setupCodeHash(canonicalCode), RequestedAt: now,
	})
	if err != nil || !validEnrollmentUUID(route.ServerID) ||
		!validEnrollmentUUID(route.ComputerID) || route.Generation == 0 ||
		!route.ExpiresAt.After(now) {
		return SetupCodeScript{}, invalidSetupCode(err)
	}
	secret := deriveEnrollmentSecret(
		canonicalCode, route.ServerID, route.ComputerID, route.Generation,
	)
	token, err := newEnrollmentToken(
		route.ServerID, route.ComputerID, route.Generation, secret[:],
	)
	if err != nil {
		return SetupCodeScript{}, invalidSetupCode(err)
	}
	redemption, err := service.repository.ValidateSetupCode(
		ctx,
		computerport.ValidateSetupCodeCommand{
			ServerID: route.ServerID, ComputerID: route.ComputerID,
			Generation: route.Generation, TokenHash: sha256.Sum256([]byte(token)),
			RequestedAt: now,
		},
	)
	if err != nil || redemption.ServerID != route.ServerID ||
		redemption.ComputerID != route.ComputerID ||
		redemption.Generation != route.Generation ||
		!redemption.ExpiresAt.After(now) ||
		!validSetupCodeRelease(redemption.Release) {
		return SetupCodeScript{}, invalidSetupCode(err)
	}
	return SetupCodeScript{
		Script:    service.setupShellCommand(token, redemption.Release),
		ExpiresAt: redemption.ExpiresAt.UTC(),
	}, nil
}

func invalidSetupCode(cause error) error {
	return apperror.New("setup_code_invalid", "安装码无效或已过期", cause)
}

func (service *EnrollmentService) Claim(
	ctx context.Context,
	command ClaimCommand,
) (ClaimResult, error) {
	route, err := parseEnrollmentToken(command.Token)
	if err != nil || command.OSType == "" || command.Architecture == "" ||
		!releaseComponent.MatchString(command.InstallerVersion) || zeroDigest(command.CredentialDigest) {
		return ClaimResult{}, apperror.New("enrollment_invalid", "Computer 接入凭证无效", err)
	}
	credentialID, err := service.ids.New()
	if err != nil || !validEnrollmentUUID(credentialID) {
		return ClaimResult{}, apperror.New("internal_error", "暂时无法登记 Computer credential", err)
	}
	now := service.clock.Now().UTC()
	stored, err := service.repository.ClaimEnrollment(
		ctx,
		computerport.ClaimEnrollmentCommand{
			ServerID: route.ServerID, ComputerID: route.ComputerID,
			Generation: route.Generation, TokenHash: sha256.Sum256([]byte(command.Token)),
			OSType: command.OSType, Architecture: command.Architecture,
			InstallerVersion: command.InstallerVersion,
			CredentialID:     credentialID, CredentialDigest: command.CredentialDigest,
			CredentialExpiresAt: now.Add(service.config.CredentialTTL), ClaimedAt: now,
		},
	)
	if err != nil {
		return ClaimResult{}, mapEnrollmentError(err)
	}
	if stored.ServerID != route.ServerID || stored.ComputerID != route.ComputerID ||
		!validEnrollmentUUID(stored.CredentialID) || stored.CredentialVersion == 0 ||
		!stored.ExpiresAt.After(now) {
		return ClaimResult{}, apperror.New("internal_error", "Computer claim 数据无效", nil)
	}
	return ClaimResult{
		ServerID: stored.ServerID, ComputerID: stored.ComputerID,
		CredentialID:      stored.CredentialID,
		CredentialVersion: stored.CredentialVersion,
		ExpiresAt:         stored.ExpiresAt.UTC(),
	}, nil
}

func (service *EnrollmentService) setupShellCommand(
	token string,
	release computerport.SetupCodeRelease,
) string {
	artifactURL := service.config.PlatformBaseURL + "/v1/computer-artifacts/" +
		url.PathEscape(release.Version) + "/" + url.PathEscape(release.Target) + "/install.sh"
	installerHash := hex.EncodeToString(release.InstallerSHA256[:])
	allowedProtocols := "=https"
	installHTTPFlag := ""
	if service.config.AllowInsecureHTTP {
		allowedProtocols = "=http,https"
		installHTTPFlag = " --allow-insecure-platform-http"
	}
	curlConfig := strings.Join([]string{
		"fail", "silent", "show-error", "location", "max-redirs = 1",
		`proto = "` + allowedProtocols + `"`, `proto-redir = "=https"`,
		`header = "Authorization: Enrollment ` + token + `"`,
		`url = "` + artifactURL + `"`,
	}, "\\n") + "\\n"
	return "umask 077; tmp_root=${TMPDIR:-/tmp}; tmp_root=${tmp_root%/}; " +
		"[ -n \"$tmp_root\" ] || tmp_root=/tmp; " +
		"d=$(/usr/bin/mktemp -d \"$tmp_root/an-computer.XXXXXX\") || exit 1; " +
		"trap '/bin/rm -rf \"$d\"' EXIT HUP INT TERM; " +
		"/usr/bin/printf '%s' " + shellQuote(token) + " >\"$d/token\"; " +
		"/usr/bin/printf '%b' " + shellQuote(curlConfig) + " >\"$d/curl.conf\"; " +
		"/usr/bin/env -i PATH=/usr/bin:/bin HTTPS_PROXY=\"${HTTPS_PROXY-}\" NO_PROXY=\"${NO_PROXY-}\" " +
		"/usr/bin/curl -q --config \"$d/curl.conf\" --output \"$d/install.sh\"; " +
		"/usr/bin/printf '%s  %s\\n' " + shellQuote(installerHash) + " \"$d/install.sh\" | /usr/bin/shasum -a 256 -c -; " +
		"/bin/sh \"$d/install.sh\" --token-file \"$d/token\" --platform-url " +
		shellQuote(service.config.PlatformBaseURL) + installHTTPFlag
}

func validSetupCodeRelease(value computerport.SetupCodeRelease) bool {
	return releaseComponent.MatchString(value.Version) &&
		releaseComponent.MatchString(value.Target) && value.InstallerSHA256 != [32]byte{}
}

func validRelease(value computerport.ReleaseBinding) bool {
	if !releaseComponent.MatchString(value.Version) ||
		!releaseComponent.MatchString(value.Target) ||
		!releaseComponent.MatchString(value.OSType) ||
		!releaseComponent.MatchString(value.Architecture) ||
		!releaseComponent.MatchString(value.SigningKeyID) {
		return false
	}
	for _, artifact := range []computerport.ArtifactBinding{
		value.Manifest, value.Signature, value.Installer, value.Program,
	} {
		if artifact.Size <= 0 || zeroDigest(artifact.SHA256) ||
			artifact.ObjectKey == "" || path.IsAbs(artifact.ObjectKey) ||
			strings.Contains(artifact.ObjectKey, "..") || strings.ContainsAny(artifact.ObjectKey, "\r\n\x00") {
			return false
		}
	}
	return true
}

func normalizeInstallBaseURL(value string, allowInsecureHTTP bool) (string, error) {
	trimmed := strings.TrimSpace(value)
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" || parsed.Hostname() == "" || parsed.Opaque != "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery ||
		(parsed.Path != "" && parsed.Path != "/") ||
		(parsed.RawPath != "" && parsed.RawPath != "/") ||
		strings.ContainsAny(trimmed, "'\"$ \t\r\n\x00") {
		return "", errors.New("Computer 安装平台地址无效")
	}
	if parsed.Scheme == "https" {
		if allowInsecureHTTP {
			return "", errors.New("Computer 安装 HTTP 许可与平台地址不一致")
		}
	} else if parsed.Scheme != "http" || !allowInsecureHTTP {
		return "", errors.New("Computer 安装平台地址无效")
	}
	parsed.Path = ""
	parsed.RawPath = ""
	return parsed.String(), nil
}

func zeroDigest(value [32]byte) bool { return value == [32]byte{} }

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func mapEnrollmentError(err error) error {
	switch {
	case errors.Is(err, computerport.ErrEnrollmentRevisionConflict):
		return apperror.New("revision_conflict", "Computer 已被其他操作修改", err)
	case errors.Is(err, computerport.ErrComputerAlreadyClaimed):
		return apperror.New("computer_already_claimed", "Computer 已完成连接", err)
	case errors.Is(err, computerport.ErrEnrollmentExpired):
		return apperror.New("setup_expired", "安装命令已过期", err)
	case errors.Is(err, computerport.ErrEnrollmentClaimConflict):
		return apperror.New("enrollment_claim_conflict", "Computer credential 不一致", err)
	case errors.Is(err, computerport.ErrEnrollmentInvalid):
		return apperror.New("enrollment_invalid", "Computer 接入凭证无效", err)
	default:
		return apperror.New("internal_error", "暂时无法处理 Computer enrollment", err)
	}
}
