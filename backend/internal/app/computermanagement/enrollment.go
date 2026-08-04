package computermanagement

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/url"
	"path"
	"regexp"
	"strconv"
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
	ReplacementKey    []byte
	ReplacementTTL    time.Duration
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
	ReplacementGrant string
}

type ClaimResult struct {
	ServerID          string
	ComputerID        string
	CredentialID      string
	CredentialVersion uint64
	ExpiresAt         time.Time
}

type PreflightCommand struct {
	Credential  string
	Replacement *ReplacementRequest
}

type ReplacementRequest struct {
	EnrollmentToken string
	TATRegion       string
	TATInstanceID   string
}

type PreflightResult struct {
	Status           string
	ReplacementGrant string
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
	var replacement *computerport.ReplacementClaim
	if command.ReplacementGrant != "" {
		replacement, err = service.verifyReplacementGrant(
			command.ReplacementGrant, command.Token, route, now,
		)
		if err != nil {
			return ClaimResult{}, err
		}
	}
	stored, err := service.repository.ClaimEnrollment(
		ctx,
		computerport.ClaimEnrollmentCommand{
			ServerID: route.ServerID, ComputerID: route.ComputerID,
			Generation: route.Generation, TokenHash: sha256.Sum256([]byte(command.Token)),
			OSType: command.OSType, Architecture: command.Architecture,
			InstallerVersion: command.InstallerVersion,
			CredentialID:     credentialID, CredentialDigest: command.CredentialDigest,
			CredentialExpiresAt: now.Add(service.config.CredentialTTL), ClaimedAt: now,
			Replacement: replacement,
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

func (service *EnrollmentService) verifyReplacementGrant(
	raw string,
	enrollmentToken string,
	route enrollmentTokenRoute,
	now time.Time,
) (*computerport.ReplacementClaim, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 || parts[0] != "rpg1" || len(service.config.ReplacementKey) < sha256.Size {
		return nil, invalidReplacementGrant(nil)
	}
	actual, err := base64.RawURLEncoding.Strict().DecodeString(parts[2])
	if err != nil {
		return nil, invalidReplacementGrant(err)
	}
	mac := hmac.New(sha256.New, service.config.ReplacementKey)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(actual, mac.Sum(nil)) {
		return nil, invalidReplacementGrant(nil)
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if err != nil || len(payload) > 4096 {
		return nil, invalidReplacementGrant(err)
	}
	var claims replacementGrantClaims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return nil, invalidReplacementGrant(err)
	}
	newTokenHash := sha256.Sum256([]byte(enrollmentToken))
	newTokenHashHex := hex.EncodeToString(newTokenHash[:])
	programHex := hex.EncodeToString(service.config.Release.Program.SHA256[:])
	expiresAt := time.Unix(claims.ExpiresAt, 0).UTC()
	issuedAt := time.Unix(claims.IssuedAt, 0).UTC()
	if claims.Type != "computer-replacement" || claims.OldServerID != route.ServerID ||
		claims.NewServerID != route.ServerID || claims.NewComputerID != route.ComputerID ||
		claims.NewGeneration != route.Generation || claims.NewTokenHash != newTokenHashHex ||
		claims.ReleaseVersion != service.config.Release.Version || claims.Target != service.config.Release.Target ||
		claims.ProgramSHA256 != programHex || claims.OldComputerID == "" ||
		claims.OldCredentialVersion == 0 || claims.OldComputerRevision < 1 ||
		len(claims.BindingHash) != 64 || claims.TATRegion == "" ||
		!strings.HasPrefix(claims.TATInstanceID, "rins-") ||
		claims.IssuedAt <= 0 || claims.ExpiresAt <= claims.IssuedAt || issuedAt.After(now.Add(time.Minute)) ||
		!validEnrollmentUUID(claims.OldServerID) || !validEnrollmentUUID(claims.OldComputerID) {
		return nil, invalidReplacementGrant(nil)
	}
	tokenHashBytes, err := hex.DecodeString(claims.NewTokenHash)
	if err != nil || len(tokenHashBytes) != sha256.Size {
		return nil, invalidReplacementGrant(err)
	}
	programBytes, err := hex.DecodeString(claims.ProgramSHA256)
	if err != nil || len(programBytes) != sha256.Size {
		return nil, invalidReplacementGrant(err)
	}
	var tokenHash [32]byte
	copy(tokenHash[:], tokenHashBytes)
	var programSHA256 [32]byte
	copy(programSHA256[:], programBytes)
	return &computerport.ReplacementClaim{
		OldServerID: claims.OldServerID, OldComputerID: claims.OldComputerID,
		OldCredentialVersion: claims.OldCredentialVersion,
		OldComputerRevision:  claims.OldComputerRevision,
		BindingHash:          claims.BindingHash, TATRegion: claims.TATRegion,
		TATInstanceID: claims.TATInstanceID,
		NewServerID:   claims.NewServerID, NewComputerID: claims.NewComputerID,
		NewGeneration: claims.NewGeneration, NewTokenHash: tokenHash,
		ReleaseVersion: claims.ReleaseVersion, Target: claims.Target,
		ProgramSHA256: programSHA256, GrantExpired: !now.Before(expiresAt),
	}, nil
}

func invalidReplacementGrant(cause error) error {
	return apperror.New(
		"computer_replacement_identity_mismatch", "Computer replacement grant 无效", cause,
	)
}

// Preflight 只读取长期 credential 与 Computer 墓碑，不恢复普通鉴权 currentness。
func (service *EnrollmentService) Preflight(
	ctx context.Context,
	command PreflightCommand,
) (PreflightResult, error) {
	route, secretPart, err := parsePreflightCredential(command.Credential)
	if err != nil {
		return PreflightResult{}, apperror.New(
			"computer_credential_invalid", "Computer credential 无效", err,
		)
	}
	inspection, err := service.repository.InspectCredential(
		ctx,
		computerport.InspectCredentialCommand{
			ServerID: route.ServerID, ComputerID: route.ComputerID, Version: route.Version,
		},
	)
	if errors.Is(err, computerport.ErrCredentialInspectionNotFound) {
		return PreflightResult{}, apperror.New(
			"computer_credential_invalid", "Computer credential 无效", err,
		)
	}
	if err != nil {
		return PreflightResult{}, apperror.New(
			"internal_error", "暂时无法检查 Computer credential", err,
		)
	}
	actual := sha256.Sum256([]byte(secretPart))
	if inspection.ServerID != route.ServerID || inspection.ComputerID != route.ComputerID ||
		inspection.Version != route.Version ||
		subtle.ConstantTimeCompare(actual[:], inspection.SecretDigest[:]) != 1 {
		return PreflightResult{}, apperror.New(
			"computer_credential_invalid", "Computer credential 无效", nil,
		)
	}
	if inspection.ComputerState == "removed" {
		if command.Replacement == nil {
			return PreflightResult{Status: "removed"}, nil
		}
		return service.authorizeReplacement(
			ctx, route, inspection, *command.Replacement,
		)
	}
	if inspection.ComputerState != "active" {
		return PreflightResult{}, apperror.New(
			"computer_credential_not_current", "Computer credential 已不再有效", nil,
		)
	}
	now := service.clock.Now().UTC()
	current := inspection.RevokedAt == nil &&
		((inspection.CredentialState == "active" && inspection.ExpiresAt.After(now)) ||
			(inspection.CredentialState == "grace" && inspection.GraceExpiresAt != nil &&
				inspection.GraceExpiresAt.After(now)))
	if !current {
		return PreflightResult{}, apperror.New(
			"computer_credential_not_current", "Computer credential 已不再有效", nil,
		)
	}
	return PreflightResult{Status: "active"}, nil
}

func (service *EnrollmentService) authorizeReplacement(
	ctx context.Context,
	oldRoute preflightCredentialRoute,
	inspection computerport.CredentialInspection,
	replacement ReplacementRequest,
) (PreflightResult, error) {
	newRoute, err := parseEnrollmentToken(replacement.EnrollmentToken)
	if err != nil || replacement.TATRegion == "" || replacement.TATInstanceID == "" ||
		newRoute.ServerID != oldRoute.ServerID || len(service.config.ReplacementKey) < sha256.Size ||
		service.config.ReplacementTTL <= 0 || service.config.ReplacementTTL > 15*time.Minute {
		return PreflightResult{}, apperror.New(
			"computer_replacement_identity_mismatch", "Computer replacement identity 不匹配", err,
		)
	}
	command := computerport.AuthorizeReplacementCommand{
		OldServerID: oldRoute.ServerID, OldComputerID: oldRoute.ComputerID,
		OldCredentialVersion: oldRoute.Version,
		NewServerID:          newRoute.ServerID, NewComputerID: newRoute.ComputerID,
		NewGeneration: newRoute.Generation,
		NewTokenHash:  sha256.Sum256([]byte(replacement.EnrollmentToken)),
		TATRegion:     replacement.TATRegion, TATInstanceID: replacement.TATInstanceID,
		ReleaseVersion: service.config.Release.Version, Target: service.config.Release.Target,
		ProgramSHA256: service.config.Release.Program.SHA256,
		RequestedAt:   service.clock.Now().UTC(),
	}
	authorization, err := service.repository.AuthorizeReplacement(ctx, command)
	switch {
	case errors.Is(err, computerport.ErrProviderIdentityGone):
		return PreflightResult{Status: "provider_identity_gone"}, nil
	case errors.Is(err, computerport.ErrReplacementReleaseMismatch):
		return PreflightResult{}, apperror.New(
			"replacement_release_mismatch", "Vela Computer 版本不匹配", err,
		)
	case errors.Is(err, computerport.ErrReplacementIdentityMismatch),
		errors.Is(err, computerport.ErrEnrollmentInvalid):
		return PreflightResult{}, apperror.New(
			"computer_replacement_identity_mismatch", "Computer replacement identity 不匹配", err,
		)
	case err != nil:
		return PreflightResult{}, apperror.New("internal_error", "暂时无法检查 Computer replacement", err)
	}
	if authorization.OldComputerRevision != inspection.ComputerRevision ||
		len(authorization.BindingHash) != 64 {
		return PreflightResult{}, apperror.New("internal_error", "Computer replacement 数据无效", nil)
	}
	grant, err := service.signReplacementGrant(command, authorization)
	if err != nil {
		return PreflightResult{}, apperror.New("internal_error", "暂时无法签发 Computer replacement", err)
	}
	return PreflightResult{Status: "removed", ReplacementGrant: grant}, nil
}

type replacementGrantClaims struct {
	Type                 string `json:"typ"`
	OldServerID          string `json:"osv"`
	OldComputerID        string `json:"ocp"`
	OldCredentialVersion uint64 `json:"ocv"`
	OldComputerRevision  int64  `json:"orv"`
	NewServerID          string `json:"nsv"`
	NewComputerID        string `json:"ncp"`
	NewGeneration        uint64 `json:"ngn"`
	NewTokenHash         string `json:"nth"`
	BindingHash          string `json:"bnd"`
	TATRegion            string `json:"trg"`
	TATInstanceID        string `json:"tid"`
	ReleaseVersion       string `json:"rel"`
	Target               string `json:"tgt"`
	ProgramSHA256        string `json:"prg"`
	IssuedAt             int64  `json:"iat"`
	ExpiresAt            int64  `json:"exp"`
}

func (service *EnrollmentService) signReplacementGrant(
	command computerport.AuthorizeReplacementCommand,
	authorization computerport.ReplacementAuthorization,
) (string, error) {
	issuedAt := service.clock.Now().UTC()
	claims := replacementGrantClaims{
		Type: "computer-replacement", OldServerID: command.OldServerID,
		OldComputerID: command.OldComputerID, OldCredentialVersion: command.OldCredentialVersion,
		OldComputerRevision: authorization.OldComputerRevision,
		NewServerID:         command.NewServerID, NewComputerID: command.NewComputerID,
		NewGeneration: command.NewGeneration, NewTokenHash: hex.EncodeToString(command.NewTokenHash[:]),
		BindingHash: authorization.BindingHash, TATRegion: command.TATRegion,
		TATInstanceID: command.TATInstanceID, ReleaseVersion: command.ReleaseVersion,
		Target: command.Target, ProgramSHA256: hex.EncodeToString(command.ProgramSHA256[:]),
		IssuedAt: issuedAt.Unix(), ExpiresAt: issuedAt.Add(service.config.ReplacementTTL).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	input := "rpg1." + encoded
	mac := hmac.New(sha256.New, service.config.ReplacementKey)
	_, _ = mac.Write([]byte(input))
	return input + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

type preflightCredentialRoute struct {
	ServerID   string
	ComputerID string
	Version    uint64
}

func parsePreflightCredential(raw string) (preflightCredentialRoute, string, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 4 || !strings.HasPrefix(parts[0], "crc_") {
		return preflightCredentialRoute{}, "", errors.New("Computer credential 路由无效")
	}
	serverID := strings.TrimPrefix(parts[0], "crc_")
	version, err := strconv.ParseUint(parts[2], 10, 64)
	secret, secretErr := base64.RawURLEncoding.Strict().DecodeString(parts[3])
	if !validEnrollmentUUID(serverID) || !validEnrollmentUUID(parts[1]) ||
		err != nil || version == 0 || strconv.FormatUint(version, 10) != parts[2] ||
		secretErr != nil || len(secret) != 32 {
		return preflightCredentialRoute{}, "", errors.New("Computer credential 路由无效")
	}
	return preflightCredentialRoute{
		ServerID: serverID, ComputerID: parts[1], Version: version,
	}, parts[3], nil
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
	case errors.Is(err, computerport.ErrReplacementIdentityMismatch):
		return apperror.New("computer_replacement_identity_mismatch", "Computer replacement identity 不匹配", err)
	case errors.Is(err, computerport.ErrReplacementReleaseMismatch):
		return apperror.New("replacement_release_mismatch", "Vela Computer 版本不匹配", err)
	default:
		return apperror.New("internal_error", "暂时无法处理 Computer enrollment", err)
	}
}
