package token

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	clockport "chatserver/internal/ports/clock"
	tokenport "chatserver/internal/ports/token"
)

var jwtHeader = base64.RawURLEncoding.EncodeToString(
	[]byte(`{"alg":"HS256","typ":"JWT"}`),
)

type jwtPayload struct {
	Type             string `json:"typ"`
	Subject          string `json:"sub,omitempty"`
	SessionID        string `json:"sid,omitempty"`
	ServerID         string `json:"srv,omitempty"`
	AgentID          string `json:"agt,omitempty"`
	ComputerID       string `json:"cmp,omitempty"`
	LaunchID         string `json:"lch,omitempty"`
	AssignmentEpoch  string `json:"aep,omitempty"`
	ConfigGeneration int64  `json:"gen,omitempty"`
	Attempt          int64  `json:"att,omitempty"`
	Version          uint64 `json:"ver"`
	IssuedAt         int64  `json:"iat"`
	ExpiresAt        int64  `json:"exp"`
}

// HMACJWT 使用部署级 HS256 密钥签发短期 access token。
type HMACJWT struct {
	key   []byte
	clock clockport.Clock
}

// NewHMACJWT 创建签名器；密钥至少 256 bit。
func NewHMACJWT(key []byte, clock clockport.Clock) (*HMACJWT, error) {
	if len(key) < sha256.Size || clock == nil {
		return nil, errors.New("HMAC JWT 配置无效")
	}
	return &HMACJWT{
		key:   append([]byte(nil), key...),
		clock: clock,
	}, nil
}

// Sign 签发严格用途的 compact JWT。
func (s *HMACJWT) Sign(
	ctx context.Context,
	claims tokenport.Claims,
) (string, error) {
	if err := contextErr(ctx); err != nil {
		return "", err
	}
	payload := jwtPayload{
		Type:      string(claims.Kind()),
		Version:   claims.Version(),
		IssuedAt:  claims.IssuedAt().Unix(),
		ExpiresAt: claims.ExpiresAt().Unix(),
	}
	switch claims.Kind() {
	case tokenport.ClaimsHumanAccess:
		payload.Subject = claims.AccountID()
		payload.SessionID = claims.SessionID()
	case tokenport.ClaimsRuntimeAccess:
		payload.ServerID = claims.ServerID()
		payload.AgentID = claims.AgentID()
		if claims.HasLaunchFence() {
			payload.ComputerID = claims.ComputerID()
			payload.LaunchID = claims.LaunchID()
			payload.AssignmentEpoch = claims.AssignmentEpoch()
			payload.ConfigGeneration = claims.ConfigGeneration()
			payload.Attempt = claims.Attempt()
		}
	case tokenport.ClaimsComputerAccess:
		payload.ServerID = claims.ServerID()
		payload.ComputerID = claims.ComputerID()
	default:
		return "", tokenport.ErrInvalidClaims
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(data)
	signingInput := jwtHeader + "." + encoded
	return signingInput + "." + s.signature(signingInput), nil
}

// Verify 验证算法、签名、用途、结构和到期时间。
func (s *HMACJWT) Verify(
	ctx context.Context,
	raw string,
) (tokenport.Claims, error) {
	if err := contextErr(ctx); err != nil {
		return tokenport.Claims{}, err
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 || parts[0] != jwtHeader {
		return tokenport.Claims{}, tokenport.ErrInvalidToken
	}
	signingInput := parts[0] + "." + parts[1]
	expected, err := base64.RawURLEncoding.Strict().DecodeString(
		s.signature(signingInput),
	)
	if err != nil {
		return tokenport.Claims{}, tokenport.ErrInvalidToken
	}
	actual, err := base64.RawURLEncoding.Strict().DecodeString(parts[2])
	if err != nil || !hmac.Equal(actual, expected) {
		return tokenport.Claims{}, tokenport.ErrInvalidToken
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if err != nil {
		return tokenport.Claims{}, tokenport.ErrInvalidToken
	}
	var payload jwtPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return tokenport.Claims{}, tokenport.ErrInvalidToken
	}
	if payload.IssuedAt <= 0 || payload.ExpiresAt <= payload.IssuedAt {
		return tokenport.Claims{}, tokenport.ErrInvalidToken
	}
	issuedAt := time.Unix(payload.IssuedAt, 0).UTC()
	expiresAt := time.Unix(payload.ExpiresAt, 0).UTC()
	if !s.clock.Now().UTC().Before(expiresAt) {
		return tokenport.Claims{}, tokenport.ErrExpiredToken
	}
	switch tokenport.ClaimsKind(payload.Type) {
	case tokenport.ClaimsHumanAccess:
		claims, err := tokenport.NewHumanClaims(
			payload.Subject,
			payload.SessionID,
			payload.Version,
			issuedAt,
			expiresAt,
		)
		if err != nil {
			return tokenport.Claims{}, tokenport.ErrInvalidToken
		}
		return claims, nil
	case tokenport.ClaimsRuntimeAccess:
		var claims tokenport.Claims
		var err error
		if payload.ComputerID != "" || payload.LaunchID != "" ||
			payload.AssignmentEpoch != "" || payload.ConfigGeneration != 0 || payload.Attempt != 0 {
			claims, err = tokenport.NewRuntimeLaunchClaims(
				payload.ServerID, payload.ComputerID, payload.AgentID,
				payload.LaunchID, payload.AssignmentEpoch, payload.ConfigGeneration,
				payload.Version, payload.Attempt, issuedAt, expiresAt,
			)
		} else {
			claims, err = tokenport.NewRuntimeClaims(
				payload.ServerID, payload.AgentID, payload.Version, issuedAt, expiresAt,
			)
		}
		if err != nil {
			return tokenport.Claims{}, tokenport.ErrInvalidToken
		}
		return claims, nil
	case tokenport.ClaimsComputerAccess:
		claims, err := tokenport.NewComputerClaims(
			payload.ServerID,
			payload.ComputerID,
			payload.Version,
			issuedAt,
			expiresAt,
		)
		if err != nil {
			return tokenport.Claims{}, tokenport.ErrInvalidToken
		}
		return claims, nil
	default:
		return tokenport.Claims{}, tokenport.ErrInvalidToken
	}
}

func (s *HMACJWT) signature(signingInput string) string {
	mac := hmac.New(sha256.New, s.key)
	_, _ = mac.Write([]byte(signingInput))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return errors.New("context 不能为空")
	}
	return ctx.Err()
}

// String 故意不暴露密钥，仅提供不含状态的诊断标签。
func (*HMACJWT) String() string {
	return "HMACJWT(HS256)"
}
