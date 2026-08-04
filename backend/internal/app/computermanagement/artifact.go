package computermanagement

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/url"
	"strings"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	computerport "chatserver/internal/ports/computer"
)

type ArtifactService struct {
	repository computerport.ArtifactRepository
	signer     computerport.ArtifactURLSigner
	clock      clockport.Clock
	maxTTL     time.Duration
}

type ArtifactRedirect struct {
	URL       string
	ExpiresAt time.Time
}

func NewArtifactService(
	repository computerport.ArtifactRepository,
	signer computerport.ArtifactURLSigner,
	clock clockport.Clock,
	maxTTL time.Duration,
) (*ArtifactService, error) {
	if repository == nil || signer == nil || clock == nil ||
		maxTTL <= 0 || maxTTL > 5*time.Minute {
		return nil, errors.New("Computer artifact 服务配置无效")
	}
	return &ArtifactService{
		repository: repository, signer: signer, clock: clock, maxTTL: maxTTL,
	}, nil
}

func (service *ArtifactService) Resolve(
	ctx context.Context,
	token string,
	version string,
	target string,
	file string,
) (ArtifactRedirect, error) {
	route, err := parseEnrollmentToken(token)
	if err != nil || !releaseComponent.MatchString(version) ||
		!releaseComponent.MatchString(target) || !validArtifactFile(file) {
		return ArtifactRedirect{}, apperror.New(
			"enrollment_invalid", "Computer 接入凭证无效", err,
		)
	}
	now := service.clock.Now().UTC()
	access, err := service.repository.ResolveEnrollmentArtifact(
		ctx,
		computerport.ResolveArtifactCommand{
			ServerID: route.ServerID, ComputerID: route.ComputerID,
			Generation: route.Generation, TokenHash: sha256.Sum256([]byte(token)),
			Version: version, Target: target, File: file, RequestedAt: now,
		},
	)
	if err != nil {
		return ArtifactRedirect{}, mapEnrollmentError(err)
	}
	ttl := access.ExpiresAt.UTC().Sub(now)
	if ttl <= 0 {
		return ArtifactRedirect{}, apperror.New(
			"setup_expired", "安装命令已过期", computerport.ErrEnrollmentExpired,
		)
	}
	if ttl > service.maxTTL {
		ttl = service.maxTTL
	}
	signedURL, err := service.signer.PresignGet(ctx, access.ObjectKey, ttl)
	if err != nil {
		return ArtifactRedirect{}, apperror.New(
			"internal_error", "暂时无法取得安装文件", err,
		)
	}
	parsed, err := url.Parse(signedURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return ArtifactRedirect{}, apperror.New(
			"internal_error", "安装文件地址无效", err,
		)
	}
	return ArtifactRedirect{URL: signedURL, ExpiresAt: now.Add(ttl)}, nil
}

func validArtifactFile(file string) bool {
	switch strings.TrimSpace(file) {
	case "manifest.json", "manifest.sig", "install.sh", "vela-computer":
		return true
	default:
		return false
	}
}
