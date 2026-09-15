package store

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

type Event struct {
	ID           int64
	At           string
	ConnectionID string
	SessionID    string
	Type         string
	Payload      string
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// SQLite serializes writers. Keeping one pooled connection also makes
	// connection-scoped PRAGMAs and synchronous QuickJS policy calls deterministic.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	for _, statement := range []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS connections (
			id TEXT PRIMARY KEY,
			opened_at TEXT NOT NULL,
			closed_at TEXT,
			remote_addr TEXT NOT NULL,
			client_version TEXT,
			username TEXT,
			authenticated INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL,
			connection_id TEXT NOT NULL,
			session_id TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL,
			payload TEXT NOT NULL,
			FOREIGN KEY(connection_id) REFERENCES connections(id)
		)`,
		`CREATE INDEX IF NOT EXISTS events_connection_id_id ON events(connection_id, id)`,
		`CREATE TABLE IF NOT EXISTS policy_kv (
			namespace TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(namespace, key)
		)`,
		`CREATE TABLE IF NOT EXISTS node_identities (
			kind TEXT PRIMARY KEY,
			private_material BLOB NOT NULL,
			created_at TEXT NOT NULL
		)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			return nil, fmt.Errorf("initialize store: %w", err)
		}
	}
	// The database contains credential material such as the SSH host identity.
	// SQLite sidecars are created before this point when WAL mode is enabled.
	for _, privatePath := range []string{path, path + "-wal", path + "-shm"} {
		if err := os.Chmod(privatePath, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
			db.Close()
			return nil, fmt.Errorf("secure store %s: %w", privatePath, err)
		}
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Get(namespace, key string) (string, bool, error) {
	if err := validateKV(namespace, key, ""); err != nil {
		return "", false, err
	}
	var value string
	err := s.db.QueryRow(`SELECT value FROM policy_kv WHERE namespace=? AND key=?`, namespace, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return value, err == nil, err
}

func (s *Store) Set(namespace, key, value string) error {
	if err := validateKV(namespace, key, value); err != nil {
		return err
	}
	_, err := s.db.Exec(`INSERT INTO policy_kv(namespace, key, value, updated_at) VALUES(?,?,?,?)
		ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		namespace, key, value, now())
	return err
}

func (s *Store) Delete(namespace, key string) (bool, error) {
	if err := validateKV(namespace, key, ""); err != nil {
		return false, err
	}
	result, err := s.db.Exec(`DELETE FROM policy_kv WHERE namespace=? AND key=?`, namespace, key)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count > 0, err
}

func (s *Store) GetOrInsert(namespace, key, value string) (string, error) {
	if err := validateKV(namespace, key, value); err != nil {
		return "", err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO policy_kv(namespace, key, value, updated_at) VALUES(?,?,?,?)
		ON CONFLICT(namespace, key) DO NOTHING`, namespace, key, value, now()); err != nil {
		return "", err
	}
	var stored string
	if err := tx.QueryRow(`SELECT value FROM policy_kv WHERE namespace=? AND key=?`, namespace, key).Scan(&stored); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return stored, nil
}

// GetOrInsertNodeIdentity atomically persists private node identity material.
// It is deliberately separate from policy_kv so application policy cannot
// accidentally enumerate or overwrite transport identities through that API.
func (s *Store) GetOrInsertNodeIdentity(kind string, candidate []byte) ([]byte, error) {
	if kind == "" || len(kind) > 128 {
		return nil, fmt.Errorf("node identity kind must contain 1-128 bytes")
	}
	if len(candidate) == 0 || len(candidate) > 1024*1024 {
		return nil, fmt.Errorf("node identity material must contain 1 byte-1 MiB")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO node_identities(kind, private_material, created_at) VALUES(?,?,?)
		ON CONFLICT(kind) DO NOTHING`, kind, candidate, now()); err != nil {
		return nil, err
	}
	var stored []byte
	if err := tx.QueryRow(`SELECT private_material FROM node_identities WHERE kind=?`, kind).Scan(&stored); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return append([]byte(nil), stored...), nil
}

func (s *Store) NodeIdentity(kind string) ([]byte, bool, error) {
	if kind == "" || len(kind) > 128 {
		return nil, false, fmt.Errorf("node identity kind must contain 1-128 bytes")
	}
	var stored []byte
	err := s.db.QueryRow(`SELECT private_material FROM node_identities WHERE kind=?`, kind).Scan(&stored)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return append([]byte(nil), stored...), true, nil
}

func validateKV(namespace, key, value string) error {
	if namespace == "" || len(namespace) > 256 {
		return fmt.Errorf("policy KV namespace must contain 1-256 bytes")
	}
	if key == "" || len(key) > 256 {
		return fmt.Errorf("policy KV key must contain 1-256 bytes")
	}
	if len(value) > 1024*1024 {
		return fmt.Errorf("policy KV value exceeds 1 MiB")
	}
	return nil
}

func (s *Store) OpenConnection(id, remote, clientVersion string) error {
	log.Printf("honeypot connection.open connection=%s remote=%q client=%q", id, remote, clientVersion)
	_, err := s.db.Exec(`INSERT INTO connections(id, opened_at, remote_addr, client_version) VALUES(?,?,?,?)`, id, now(), remote, clientVersion)
	return err
}

func (s *Store) Authenticate(id, username string, accepted bool) error {
	log.Printf("honeypot auth.result connection=%s username=%q accepted=%t", id, username, accepted)
	_, err := s.db.Exec(`UPDATE connections SET username=?, authenticated=? WHERE id=?`, username, boolInt(accepted), id)
	return err
}

func (s *Store) SetClientVersion(id, clientVersion string) error {
	_, err := s.db.Exec(`UPDATE connections SET client_version=? WHERE id=?`, clientVersion, id)
	return err
}

func (s *Store) CloseConnection(id string) error {
	log.Printf("honeypot connection.close connection=%s", id)
	_, err := s.db.Exec(`UPDATE connections SET closed_at=? WHERE id=?`, now(), id)
	return err
}

func (s *Store) Record(connectionID, sessionID, eventType string, payload any) error {
	// Detailed SSH/protocol capture is disabled. Record used to synchronously
	// encode and insert every channel, stream and payload event into the same
	// single-connection SQLite store used by policy state. A busy Codex Desktop
	// connection could therefore hold up an unrelated turn/start for seconds.
	// Keep the method as a compatibility no-op for both SSH stacks and for the
	// historical `events` reader; connection lifecycle state is stored by the
	// dedicated Open/Authenticate/Close methods instead.
	return nil
}

func sanitize(value any) any {
	switch value := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(value))
		for key, item := range value {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "password") && lower != "passwordsha256" ||
				strings.Contains(lower, "token") || strings.Contains(lower, "secret") ||
				strings.Contains(lower, "authorization") || strings.Contains(lower, "cookie") {
				result[key] = "[REDACTED]"
				continue
			}
			result[key] = sanitize(item)
		}
		return result
	case []any:
		result := make([]any, len(value))
		for index, item := range value {
			result[index] = sanitize(item)
		}
		return result
	default:
		return value
	}
}

func (s *Store) Events(connectionID string, limit int) ([]Event, error) {
	if limit < 1 || limit > 10_000 {
		limit = 100
	}
	query := `SELECT id, at, connection_id, session_id, type, payload FROM events`
	args := []any{}
	if connectionID != "" {
		query += ` WHERE connection_id=?`
		args = append(args, connectionID)
	}
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Event
	for rows.Next() {
		var event Event
		if err := rows.Scan(&event.ID, &event.At, &event.ConnectionID, &event.SessionID, &event.Type, &event.Payload); err != nil {
			return nil, err
		}
		result = append(result, event)
	}
	return result, rows.Err()
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
