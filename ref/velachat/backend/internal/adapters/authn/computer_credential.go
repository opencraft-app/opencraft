package authn

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"

	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
	computerauthport "chatserver/internal/ports/computerauth"
)

const computerCredentialPrefix = "crc_"

type ComputerCredentialAuthenticator struct {
	repository computerauthport.Repository
}

func NewComputerCredentialAuthenticator(
	repository computerauthport.Repository,
) (*ComputerCredentialAuthenticator, error) {
	if repository == nil {
		return nil, errors.New("Computer credential Repository 不能为空")
	}
	return &ComputerCredentialAuthenticator{repository: repository}, nil
}

func (authenticator *ComputerCredentialAuthenticator) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	typed, ok := candidate.(authnport.ComputerCredentialCandidate)
	if !ok || authenticator == nil || authenticator.repository == nil {
		return nil, invalidComputerCredential(nil)
	}
	raw := typed.Credential().Reveal()
	route, err := parseComputerCredentialRoute(raw)
	if err != nil {
		return nil, invalidComputerCredential(err)
	}
	if hint := strings.TrimSpace(typed.RoutePrefix()); hint != "" && hint != route.ServerID {
		return nil, invalidComputerCredential(computerauthport.ErrInvalidRoute)
	}
	stored, err := authenticator.repository.FindCurrent(ctx, route)
	switch {
	case errors.Is(err, computerauthport.ErrCredentialNotCurrent):
		return nil, invalidComputerCredential(err)
	case err != nil:
		return nil, apperror.New("internal_error", "暂时无法验证 Computer credential", err)
	case stored.Route != route:
		return nil, invalidComputerCredential(computerauthport.ErrCredentialNotCurrent)
	}
	// Route fields are authenticated by exact indexed lookup; the stored digest
	// covers only the 32-byte random secret material so issuance can allocate the
	// monotonically increasing version inside the database transaction without
	// persisting a replayable full credential.
	secretPart := raw[strings.LastIndexByte(raw, '.')+1:]
	actual := sha256.Sum256([]byte(secretPart))
	if subtle.ConstantTimeCompare(actual[:], stored.SecretDigest[:]) != 1 {
		return nil, invalidComputerCredential(nil)
	}
	current, err := authenticator.repository.ConfirmCurrent(ctx, route)
	if err != nil {
		return nil, apperror.New("internal_error", "暂时无法确认 Computer credential", err)
	}
	if !current {
		return nil, apperror.New("computer_credential_revoked", "Computer credential 已失效", computerauthport.ErrCredentialNotCurrent)
	}
	principal, err := authnport.NewCurrentComputerPrincipal(
		route.ServerID,
		route.ComputerID,
		route.Version,
	)
	if err != nil {
		return nil, invalidComputerCredential(err)
	}
	return principal, nil
}

func parseComputerCredentialRoute(raw string) (computerauthport.Route, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 4 || !strings.HasPrefix(parts[0], computerCredentialPrefix) {
		return computerauthport.Route{}, computerauthport.ErrInvalidRoute
	}
	serverID := strings.TrimPrefix(parts[0], computerCredentialPrefix)
	if !isUUIDv7(serverID) || !isUUIDv7(parts[1]) {
		return computerauthport.Route{}, computerauthport.ErrInvalidRoute
	}
	version, err := strconv.ParseUint(parts[2], 10, 64)
	if err != nil || version == 0 || strconv.FormatUint(version, 10) != parts[2] {
		return computerauthport.Route{}, computerauthport.ErrInvalidRoute
	}
	secret, err := base64.RawURLEncoding.Strict().DecodeString(parts[3])
	if err != nil || len(secret) != 32 {
		return computerauthport.Route{}, computerauthport.ErrInvalidRoute
	}
	return computerauthport.Route{
		ServerID:   serverID,
		ComputerID: parts[1],
		Version:    version,
	}, nil
}

func invalidComputerCredential(cause error) error {
	return apperror.New("computer_credential_invalid", "Computer credential 无效", cause)
}
