package oidc

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type AuthorizationCodeRecord struct {
	ClientID      string
	UserID        string
	RedirectURI   string
	Scope         string
	CodeChallenge string
	Nonce         string
	ExpiresAt     time.Time
	ConsumedAt    *time.Time
	CreatedAt     time.Time
}

type CreateAuthorizationCodeInput struct {
	Code          string
	ClientID      string
	UserID        string
	RedirectURI   string
	Scope         string
	CodeChallenge string
	Nonce         string
	ExpiresAt     time.Time
	CreatedAt     time.Time
}

type ConsumeAuthorizationCodeInput struct {
	Code        string
	ClientID    string
	RedirectURI string
	Verifier    string
	Now         time.Time
}

type CodeStore interface {
	CreateAuthorizationCode(ctx context.Context, input CreateAuthorizationCodeInput) error
	ConsumeAuthorizationCode(ctx context.Context, input ConsumeAuthorizationCodeInput) (*AuthorizationCodeRecord, error)
}

func S256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func codeHash(raw string) [32]byte {
	return sha256.Sum256([]byte(raw))
}

type MemoryCodeStore struct {
	mu   sync.Mutex
	now  func() time.Time
	data map[[32]byte]AuthorizationCodeRecord
}

func NewMemoryCodeStore(now func() time.Time) *MemoryCodeStore {
	if now == nil {
		now = time.Now
	}
	return &MemoryCodeStore{
		now:  now,
		data: make(map[[32]byte]AuthorizationCodeRecord),
	}
}

func (s *MemoryCodeStore) CreateAuthorizationCode(_ context.Context, input CreateAuthorizationCodeInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := AuthorizationCodeRecord{
		ClientID:      strings.TrimSpace(input.ClientID),
		UserID:        strings.TrimSpace(input.UserID),
		RedirectURI:   strings.TrimSpace(input.RedirectURI),
		Scope:         strings.TrimSpace(input.Scope),
		CodeChallenge: strings.TrimSpace(input.CodeChallenge),
		Nonce:         strings.TrimSpace(input.Nonce),
		ExpiresAt:     input.ExpiresAt.UTC(),
		CreatedAt:     input.CreatedAt.UTC(),
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = s.now().UTC()
	}
	s.data[codeHash(input.Code)] = record
	return nil
}

func (s *MemoryCodeStore) ConsumeAuthorizationCode(_ context.Context, input ConsumeAuthorizationCodeInput) (*AuthorizationCodeRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, ok := s.data[codeHash(input.Code)]
	if !ok {
		return nil, ErrInvalidGrant
	}
	if record.ConsumedAt != nil || !record.ExpiresAt.After(input.Now.UTC()) {
		return nil, ErrInvalidGrant
	}
	if record.ClientID != strings.TrimSpace(input.ClientID) || record.RedirectURI != strings.TrimSpace(input.RedirectURI) {
		return nil, ErrInvalidGrant
	}
	if record.CodeChallenge != S256Challenge(input.Verifier) {
		return nil, ErrInvalidGrant
	}
	now := input.Now.UTC()
	record.ConsumedAt = &now
	s.data[codeHash(input.Code)] = record
	return &record, nil
}

type MySQLCodeStore struct {
	db           *sql.DB
	now          func() time.Time
	cleanupAfter atomic.Int64
}

func NewMySQLCodeStore(db *sql.DB) *MySQLCodeStore {
	if db == nil {
		return nil
	}
	return &MySQLCodeStore{db: db, now: time.Now}
}

func (s *MySQLCodeStore) CreateAuthorizationCode(ctx context.Context, input CreateAuthorizationCodeInput) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("mysql code store is not configured")
	}
	createdAt := input.CreatedAt.UTC()
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	hash := codeHash(input.Code)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO oidc_authorization_codes (
			code_hash, client_id, user_id, redirect_uri, scope, code_challenge, nonce, expires_at, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, hash[:], strings.TrimSpace(input.ClientID), strings.TrimSpace(input.UserID), strings.TrimSpace(input.RedirectURI), strings.TrimSpace(input.Scope), strings.TrimSpace(input.CodeChallenge), strings.TrimSpace(input.Nonce), input.ExpiresAt.UTC(), createdAt)
	if err != nil {
		return fmt.Errorf("insert oidc authorization code: %w", err)
	}
	s.cleanupExpiredAuthorizationCodes(ctx, createdAt)
	return nil
}

func (s *MySQLCodeStore) ConsumeAuthorizationCode(ctx context.Context, input ConsumeAuthorizationCodeInput) (*AuthorizationCodeRecord, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("mysql code store is not configured")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin oidc code tx: %w", err)
	}
	defer rollbackTx(tx)

	hash := codeHash(input.Code)
	record := AuthorizationCodeRecord{}
	var consumedAt sql.NullTime
	if err := tx.QueryRowContext(ctx, `
		SELECT client_id, user_id, redirect_uri, scope, code_challenge, nonce, expires_at, consumed_at, created_at
		FROM oidc_authorization_codes
		WHERE code_hash = ?
		FOR UPDATE
	`, hash[:]).Scan(&record.ClientID, &record.UserID, &record.RedirectURI, &record.Scope, &record.CodeChallenge, &record.Nonce, &record.ExpiresAt, &consumedAt, &record.CreatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrInvalidGrant
		}
		return nil, fmt.Errorf("select oidc authorization code: %w", err)
	}
	if consumedAt.Valid {
		record.ConsumedAt = &consumedAt.Time
	}
	now := input.Now.UTC()
	if record.ConsumedAt != nil || !record.ExpiresAt.After(now) {
		return nil, ErrInvalidGrant
	}
	if record.ClientID != strings.TrimSpace(input.ClientID) || record.RedirectURI != strings.TrimSpace(input.RedirectURI) {
		return nil, ErrInvalidGrant
	}
	if record.CodeChallenge != S256Challenge(input.Verifier) {
		return nil, ErrInvalidGrant
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE oidc_authorization_codes
		SET consumed_at = ?
		WHERE code_hash = ? AND consumed_at IS NULL
	`, now, hash[:]); err != nil {
		return nil, fmt.Errorf("consume oidc authorization code: %w", err)
	}
	record.ConsumedAt = &now
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit oidc authorization code tx: %w", err)
	}
	return &record, nil
}

func rollbackTx(tx *sql.Tx) {
	if tx != nil {
		_ = tx.Rollback()
	}
}

const (
	authorizationCodeCleanupInterval = 5 * time.Minute
	authorizationCodeCleanupLookback = 10 * time.Minute
	authorizationCodeCleanupBatch    = 1000
)

func (s *MySQLCodeStore) cleanupExpiredAuthorizationCodes(ctx context.Context, now time.Time) {
	if s == nil || s.db == nil || !s.shouldCleanup(now) {
		return
	}
	cutoff := now.Add(-authorizationCodeCleanupLookback).UTC()
	_, _ = s.db.ExecContext(ctx, `
		DELETE FROM oidc_authorization_codes
		WHERE expires_at < ?
		LIMIT ?
	`, cutoff, authorizationCodeCleanupBatch)
}

func (s *MySQLCodeStore) shouldCleanup(now time.Time) bool {
	if s == nil {
		return false
	}
	current := now.UTC().Unix()
	nextCleanup := s.cleanupAfter.Load()
	if current < nextCleanup {
		return false
	}
	return s.cleanupAfter.CompareAndSwap(nextCleanup, now.Add(authorizationCodeCleanupInterval).UTC().Unix())
}
