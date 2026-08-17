package httptransport

import (
	"context"
	"encoding/hex"
	"errors"
	"math"
	"strings"

	"chatserver/internal/api/openapi"
	appcomputer "chatserver/internal/app/computermanagement"
	"chatserver/internal/apperror"

	"github.com/google/uuid"
)

type computerEnrollmentService interface {
	InstallationOptions() appcomputer.InstallationOptions
	CreateSetupCommand(context.Context, string, string, string, int64) (appcomputer.SetupCommand, error)
	RedeemSetupCode(context.Context, string, string) (appcomputer.SetupCodeScript, error)
	Claim(context.Context, appcomputer.ClaimCommand) (appcomputer.ClaimResult, error)
	Preflight(context.Context, appcomputer.PreflightCommand) (appcomputer.PreflightResult, error)
}

func (handler *ComputerEnrollmentHandler) RedeemComputerSetupCode(
	ctx context.Context,
	request openapi.RedeemComputerSetupCodeRequestObject,
) (openapi.RedeemComputerSetupCodeResponseObject, error) {
	if request.Body == nil || *request.Body == "" {
		return nil, apperror.New("setup_code_invalid", "安装码无效或已过期", nil)
	}
	target := "darwin-arm64"
	if request.Params.XVelaComputerTarget != nil {
		target = string(*request.Params.XVelaComputerTarget)
	}
	value, err := handler.enrollment.RedeemSetupCode(ctx, string(*request.Body), target)
	if err != nil {
		return nil, err
	}
	if value.Script == "" || value.ExpiresAt.IsZero() {
		return nil, invalidDomainData("Computer 安装脚本数据无效", nil)
	}
	return openapi.RedeemComputerSetupCode200TextResponse{
		Body: value.Script,
		Headers: openapi.RedeemComputerSetupCode200ResponseHeaders{
			CacheControl: "no-store", Pragma: "no-cache",
		},
	}, nil
}

type computerArtifactService interface {
	Resolve(context.Context, string, string, string, string) (appcomputer.ArtifactRedirect, error)
}

// ComputerEnrollmentHandler 隔离 Human 安装入口和 Enrollment token 入口。
type ComputerEnrollmentHandler struct {
	openapi.StrictServerInterface
	enrollment computerEnrollmentService
	artifacts  computerArtifactService
}

var _ openapi.StrictServerInterface = (*ComputerEnrollmentHandler)(nil)

func NewComputerEnrollmentHandler(
	enrollment computerEnrollmentService,
	artifacts computerArtifactService,
) (*ComputerEnrollmentHandler, error) {
	if enrollment == nil || artifacts == nil {
		return nil, errors.New("Computer enrollment 与 artifact 服务不能为空")
	}
	return &ComputerEnrollmentHandler{enrollment: enrollment, artifacts: artifacts}, nil
}

func (handler *ComputerEnrollmentHandler) GetComputerInstallationOptions(
	ctx context.Context,
	_ openapi.GetComputerInstallationOptionsRequestObject,
) (openapi.GetComputerInstallationOptionsResponseObject, error) {
	if _, ok := CurrentHumanPrincipal(ctx); !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	value := handler.enrollment.InstallationOptions()
	if value.ReleaseVersion == "" || len(value.Platforms) == 0 {
		return nil, invalidDomainData("Computer 安装平台数据无效", nil)
	}
	body := openapi.ComputerInstallationOptions{ReleaseVersion: value.ReleaseVersion}
	for _, platform := range value.Platforms {
		if platform.OSType == "" || len(platform.Architectures) == 0 {
			return nil, invalidDomainData("Computer 安装平台数据无效", nil)
		}
		for _, architecture := range platform.Architectures {
			if platform.OSType == "macos" && architecture == "arm64" {
				body.Platforms = append(body.Platforms, struct {
					Architectures []openapi.ComputerInstallationOptionsPlatformsArchitectures `json:"architectures"`
					OsType        openapi.ComputerInstallationOptionsPlatformsOsType          `json:"osType"`
				}{
					Architectures: []openapi.ComputerInstallationOptionsPlatformsArchitectures{"arm64"},
					OsType:        "macos",
				})
			}
		}
	}
	if len(body.Platforms) == 0 {
		return nil, invalidDomainData("Computer 安装平台数据无效", nil)
	}
	return openapi.GetComputerInstallationOptions200JSONResponse(body), nil
}

func (handler *ComputerEnrollmentHandler) GetComputerInstallationTargets(
	ctx context.Context,
	_ openapi.GetComputerInstallationTargetsRequestObject,
) (openapi.GetComputerInstallationTargetsResponseObject, error) {
	if _, ok := CurrentHumanPrincipal(ctx); !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	value := handler.enrollment.InstallationOptions()
	if value.ReleaseVersion == "" || len(value.Platforms) == 0 {
		return nil, invalidDomainData("Computer 安装平台数据无效", nil)
	}
	body := openapi.ComputerInstallationTargets{ReleaseVersion: value.ReleaseVersion}
	for _, platform := range value.Platforms {
		for _, architecture := range platform.Architectures {
			target, ok := installationTarget(platform.OSType, architecture)
			if !ok {
				return nil, invalidDomainData("Computer 安装平台数据无效", nil)
			}
			body.Targets = append(body.Targets, struct {
				Architecture openapi.ComputerInstallationTargetsTargetsArchitecture `json:"architecture"`
				OsType       openapi.ComputerInstallationTargetsTargetsOsType       `json:"osType"`
				Target       openapi.ComputerInstallationTargetsTargetsTarget       `json:"target"`
			}{
				Architecture: openapi.ComputerInstallationTargetsTargetsArchitecture(architecture),
				OsType:       openapi.ComputerInstallationTargetsTargetsOsType(platform.OSType),
				Target:       openapi.ComputerInstallationTargetsTargetsTarget(target),
			})
		}
	}
	if len(body.Targets) == 0 {
		return nil, invalidDomainData("Computer 安装平台数据无效", nil)
	}
	return openapi.GetComputerInstallationTargets200JSONResponse(body), nil
}

func installationTarget(osType string, architecture string) (string, bool) {
	switch osType + "/" + architecture {
	case "macos/arm64":
		return "darwin-arm64", true
	case "linux/amd64":
		return "linux-amd64", true
	default:
		return "", false
	}
}

func (handler *ComputerEnrollmentHandler) CreateComputerSetupCommand(
	ctx context.Context,
	request openapi.CreateComputerSetupCommandRequestObject,
) (openapi.CreateComputerSetupCommandResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	expectedRevision, err := workRevision(request.Params.XResourceRevision)
	if err != nil {
		return nil, err
	}
	value, err := handler.enrollment.CreateSetupCommand(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
		request.ComputerId.String(),
		expectedRevision,
	)
	if err != nil {
		return nil, err
	}
	computerID, err := parseDomainID(value.ComputerID, "Computer")
	if err != nil || value.Revision < 1 || value.ExpiresAt.IsZero() || value.Command == "" {
		return nil, invalidDomainData("Computer 安装命令数据无效", err)
	}
	command := value.Command
	return openapi.CreateComputerSetupCommand201JSONResponse{
		Body: openapi.ComputerSetupCommand{
			ComputerId: computerID, Command: &command,
			ExpiresAt: value.ExpiresAt.UTC(), Revision: value.Revision,
		},
		Headers: openapi.CreateComputerSetupCommand201ResponseHeaders{
			CacheControl: "no-store", Pragma: "no-cache",
			XResourceRevision: value.Revision,
		},
	}, nil
}

func (handler *ComputerEnrollmentHandler) ClaimComputerEnrollment(
	ctx context.Context,
	request openapi.ClaimComputerEnrollmentRequestObject,
) (openapi.ClaimComputerEnrollmentResponseObject, error) {
	token, ok := CurrentEnrollmentToken(ctx)
	if !ok {
		return nil, apperror.New("enrollment_invalid", "Computer 接入凭证无效", nil)
	}
	if request.Body == nil || request.Body.CredentialDigest == nil ||
		!request.Body.OsType.Valid() || !request.Body.Architecture.Valid() {
		return nil, apperror.New("invalid_request", "Computer claim 请求无效", nil)
	}
	digestBytes, err := hex.DecodeString(*request.Body.CredentialDigest)
	if err != nil || len(digestBytes) != 32 ||
		strings.ToLower(*request.Body.CredentialDigest) != *request.Body.CredentialDigest {
		return nil, apperror.New("invalid_request", "credentialDigest 无效", err)
	}
	var digest [32]byte
	copy(digest[:], digestBytes)
	value, err := handler.enrollment.Claim(ctx, appcomputer.ClaimCommand{
		Token: token, OSType: string(request.Body.OsType),
		Architecture:     string(request.Body.Architecture),
		InstallerVersion: request.Body.InstallerVersion, CredentialDigest: digest,
		ReplacementGrant: stringValue(request.Body.ReplacementGrant),
	})
	if err != nil {
		return nil, err
	}
	serverID, err := parseDomainID(value.ServerID, "Server")
	if err != nil {
		return nil, err
	}
	computerID, err := parseDomainID(value.ComputerID, "Computer")
	if err != nil {
		return nil, err
	}
	credentialID, err := parseDomainID(value.CredentialID, "Computer credential")
	if err != nil || value.CredentialVersion == 0 || value.CredentialVersion > math.MaxInt64 ||
		value.ExpiresAt.IsZero() {
		return nil, invalidDomainData("Computer claim 数据无效", err)
	}
	return openapi.ClaimComputerEnrollment201JSONResponse{
		Body: openapi.ComputerEnrollmentClaim{
			ServerId: serverID, ComputerId: computerID, CredentialId: credentialID,
			CredentialVersion: int64(value.CredentialVersion), ExpiresAt: value.ExpiresAt.UTC(),
		},
		Headers: openapi.ClaimComputerEnrollment201ResponseHeaders{
			CacheControl: "no-store", Pragma: "no-cache",
		},
	}, nil
}

func (handler *ComputerEnrollmentHandler) PreflightComputer(
	ctx context.Context,
	request openapi.PreflightComputerRequestObject,
) (openapi.PreflightComputerResponseObject, error) {
	credential, ok := CurrentComputerPreflightCredential(ctx)
	if !ok {
		return nil, apperror.New("computer_credential_invalid", "Computer credential 无效", nil)
	}
	command := appcomputer.PreflightCommand{Credential: credential}
	if request.Body != nil && request.Body.Replacement != nil {
		replacement := request.Body.Replacement
		if replacement.EnrollmentToken == nil || strings.TrimSpace(*replacement.EnrollmentToken) == "" ||
			strings.TrimSpace(replacement.TatRegion) == "" ||
			strings.TrimSpace(replacement.TatInstanceId) == "" {
			return nil, apperror.New("invalid_request", "Computer preflight replacement 无效", nil)
		}
		command.Replacement = &appcomputer.ReplacementRequest{
			EnrollmentToken: *replacement.EnrollmentToken,
			TATRegion:       replacement.TatRegion, TATInstanceID: replacement.TatInstanceId,
		}
	}
	result, err := handler.enrollment.Preflight(
		ctx,
		command,
	)
	if err != nil {
		return nil, err
	}
	headers204 := openapi.PreflightComputer204ResponseHeaders{
		CacheControl: "no-store", Pragma: "no-cache",
	}
	if result.Status == "active" {
		return openapi.PreflightComputer204Response{Headers: headers204}, nil
	}
	if result.Status != "removed" && result.Status != "provider_identity_gone" {
		return nil, invalidDomainData("Computer preflight 数据无效", nil)
	}
	requestID, err := uuid.Parse(RequestID(ctx))
	if err != nil || requestID == uuid.Nil {
		return nil, invalidDomainData("Computer preflight request ID 无效", err)
	}
	code := openapi.ComputerRemoved
	message := "Computer 已解除纳管"
	if result.Status == "provider_identity_gone" {
		code = openapi.ComputerProviderIdentityGone
		message = "Computer provider identity 已销毁"
	}
	body := openapi.ComputerPreflightRemoved{}
	body.Error.Code = code
	body.Error.Message = message
	body.Error.RequestId = requestID
	if result.ReplacementGrant != "" {
		body.Error.ReplacementGrant = &result.ReplacementGrant
	}
	return openapi.PreflightComputer410JSONResponse{
		Body: body,
		Headers: openapi.PreflightComputer410ResponseHeaders{
			CacheControl: "no-store", Pragma: "no-cache",
		},
	}, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (handler *ComputerEnrollmentHandler) GetComputerArtifact(
	ctx context.Context,
	request openapi.GetComputerArtifactRequestObject,
) (openapi.GetComputerArtifactResponseObject, error) {
	token, ok := CurrentEnrollmentToken(ctx)
	if !ok {
		return nil, apperror.New("enrollment_invalid", "Computer 接入凭证无效", nil)
	}
	value, err := handler.artifacts.Resolve(
		ctx, token, request.Version, request.Target, request.File,
	)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(value.URL) == "" {
		return nil, invalidDomainData("Computer artifact 地址无效", nil)
	}
	return openapi.GetComputerArtifact307Response{
		Headers: openapi.GetComputerArtifact307ResponseHeaders{
			Location: value.URL, CacheControl: "no-store", Pragma: "no-cache",
		},
	}, nil
}
