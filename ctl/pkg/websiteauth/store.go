// Package websiteauth stores permanent, per-instance credentials for the
// static website API. Plaintext credentials are returned only when issued.
package websiteauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	tokenPrefix         = "vwk"
	credentialKeyPrefix = "website:{website-instance-keys}:credential:"
	instanceIndexPrefix = "website:{website-instance-keys}:instance:"
	keyIDBytes          = 16
	secretBytes         = 32
	saltBytes           = 32
)

var ErrInvalidCredential = errors.New("websiteauth: invalid credential")

type Binding struct {
	KeyID      string    `json:"key_id"`
	UserID     string    `json:"user_id"`
	InstanceID string    `json:"instance_id"`
	CreatedAt  time.Time `json:"created_at"`
}

type Store interface {
	Issue(ctx context.Context, userID, instanceID string) (plainToken string, binding Binding, err error)
	Validate(ctx context.Context, plainToken string) (*Binding, error)
	Revoke(ctx context.Context, instanceID, keyID string) error
	RevokeInstance(ctx context.Context, instanceID string) error
}

type store struct {
	client *redis.Client
}

func New(client *redis.Client) Store {
	return &store{client: client}
}

func (s *store) Issue(ctx context.Context, userID, instanceID string) (string, Binding, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(instanceID) == "" {
		return "", Binding{}, errors.New("websiteauth: user_id and instance_id are required")
	}
	if s.client == nil {
		return "", Binding{}, errors.New("websiteauth: Redis client is not configured")
	}

	keyIDRaw, err := randomBytes(keyIDBytes)
	if err != nil {
		return "", Binding{}, fmt.Errorf("websiteauth generate key id: %w", err)
	}
	secret, err := randomBytes(secretBytes)
	if err != nil {
		return "", Binding{}, fmt.Errorf("websiteauth generate secret: %w", err)
	}
	salt, err := randomBytes(saltBytes)
	if err != nil {
		return "", Binding{}, fmt.Errorf("websiteauth generate salt: %w", err)
	}

	keyID := base64.RawURLEncoding.EncodeToString(keyIDRaw)
	secretEncoded := base64.RawURLEncoding.EncodeToString(secret)
	digest := hashSecret(salt, secret)
	createdAt := time.Now().UTC().Truncate(time.Second)
	binding := Binding{
		KeyID:      keyID,
		UserID:     userID,
		InstanceID: instanceID,
		CreatedAt:  createdAt,
	}

	_, err = s.client.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.HSet(ctx, credentialKeyPrefix+keyID, map[string]any{
			"salt":        base64.RawURLEncoding.EncodeToString(salt),
			"secret_hash": base64.RawURLEncoding.EncodeToString(digest[:]),
			"user_id":     userID,
			"instance_id": instanceID,
			"created_at":  createdAt.Unix(),
		})
		pipe.SAdd(ctx, instanceIndexPrefix+instanceID, keyID)
		return nil
	})
	if err != nil {
		return "", Binding{}, fmt.Errorf("websiteauth persist credential: %w", err)
	}

	token := tokenPrefix + "_" + keyID + "_" + secretEncoded
	return token, binding, nil
}

func (s *store) Validate(ctx context.Context, plainToken string) (*Binding, error) {
	keyID, secret, ok := parseToken(plainToken)
	if !ok {
		return nil, ErrInvalidCredential
	}
	if s.client == nil {
		return nil, errors.New("websiteauth: Redis client is not configured")
	}

	fields, err := s.client.HGetAll(ctx, credentialKeyPrefix+keyID).Result()
	if err != nil {
		return nil, fmt.Errorf("websiteauth load credential: %w", err)
	}
	if len(fields) == 0 {
		return nil, ErrInvalidCredential
	}
	salt, err := base64.RawURLEncoding.DecodeString(fields["salt"])
	if err != nil || len(salt) != saltBytes {
		return nil, ErrInvalidCredential
	}
	wantHash, err := base64.RawURLEncoding.DecodeString(fields["secret_hash"])
	if err != nil || len(wantHash) != sha256.Size {
		return nil, ErrInvalidCredential
	}
	gotHash := hashSecret(salt, secret)
	if subtle.ConstantTimeCompare(gotHash[:], wantHash) != 1 {
		return nil, ErrInvalidCredential
	}

	createdAtUnix, err := strconv.ParseInt(fields["created_at"], 10, 64)
	if err != nil || fields["user_id"] == "" || fields["instance_id"] == "" {
		return nil, ErrInvalidCredential
	}
	return &Binding{
		KeyID:      keyID,
		UserID:     fields["user_id"],
		InstanceID: fields["instance_id"],
		CreatedAt:  time.Unix(createdAtUnix, 0).UTC(),
	}, nil
}

func (s *store) Revoke(ctx context.Context, instanceID, keyID string) error {
	expectedInstanceID := strings.TrimSpace(instanceID)
	if expectedInstanceID == "" || keyID == "" {
		return nil
	}
	if s.client == nil {
		return errors.New("websiteauth: Redis client is not configured")
	}

	key := credentialKeyPrefix + keyID
	storedInstanceID, err := s.client.HGet(ctx, key, "instance_id").Result()
	if errors.Is(err, redis.Nil) {
		return ErrInvalidCredential
	}
	if err != nil {
		return fmt.Errorf("websiteauth load credential for revoke: %w", err)
	}
	if storedInstanceID == "" {
		return ErrInvalidCredential
	}
	if storedInstanceID != expectedInstanceID {
		return ErrInvalidCredential
	}
	_, err = s.client.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.Del(ctx, key)
		pipe.SRem(ctx, instanceIndexPrefix+expectedInstanceID, keyID)
		return nil
	})
	if err != nil {
		return fmt.Errorf("websiteauth revoke credential: %w", err)
	}
	return nil
}

func (s *store) RevokeInstance(ctx context.Context, instanceID string) error {
	if instanceID == "" {
		return nil
	}
	if s.client == nil {
		return errors.New("websiteauth: Redis client is not configured")
	}

	indexKey := instanceIndexPrefix + instanceID
	keyIDs, err := s.client.SMembers(ctx, indexKey).Result()
	if err != nil {
		return fmt.Errorf("websiteauth load instance credentials: %w", err)
	}
	_, err = s.client.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		for _, keyID := range keyIDs {
			pipe.Del(ctx, credentialKeyPrefix+keyID)
		}
		pipe.Del(ctx, indexKey)
		return nil
	})
	if err != nil {
		return fmt.Errorf("websiteauth revoke instance credentials: %w", err)
	}
	return nil
}

func randomBytes(size int) ([]byte, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func hashSecret(salt, secret []byte) [sha256.Size]byte {
	input := make([]byte, 0, len(salt)+len(secret))
	input = append(input, salt...)
	input = append(input, secret...)
	return sha256.Sum256(input)
}

func parseToken(token string) (string, []byte, bool) {
	keyIDLength := base64.RawURLEncoding.EncodedLen(keyIDBytes)
	secretLength := base64.RawURLEncoding.EncodedLen(secretBytes)
	prefix := tokenPrefix + "_"
	wantLength := len(prefix) + keyIDLength + 1 + secretLength
	if len(token) != wantLength || !strings.HasPrefix(token, prefix) {
		return "", nil, false
	}
	keyID := token[len(prefix) : len(prefix)+keyIDLength]
	if token[len(prefix)+keyIDLength] != '_' {
		return "", nil, false
	}
	secretEncoded := token[len(prefix)+keyIDLength+1:]
	keyIDRaw, err := base64.RawURLEncoding.DecodeString(keyID)
	if err != nil || len(keyIDRaw) != keyIDBytes {
		return "", nil, false
	}
	secret, err := base64.RawURLEncoding.DecodeString(secretEncoded)
	if err != nil || len(secret) != secretBytes {
		return "", nil, false
	}
	return keyID, secret, true
}
