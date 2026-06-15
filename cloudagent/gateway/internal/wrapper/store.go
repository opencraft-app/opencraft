package wrapper

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

const (
	storeDialectSQLite = "sqlite"
	storeDialectMySQL  = "mysql"
)

type Store struct {
	mu                  sync.Mutex
	root                string
	db                  *sql.DB
	dialect             string
	failArtifactPersist bool
}

func NewStore(root string) (*Store, error) {
	return NewStoreWithConfig(StoreConfig{Root: root})
}

type StoreConfig struct {
	Root   string
	Driver string
	DSN    string
}

func NewStoreFromEnv(root string) (*Store, error) {
	return NewStoreWithConfig(StoreConfig{
		Root:   root,
		Driver: os.Getenv("GATEWAY_DB_DRIVER"),
		DSN:    firstNonEmptyStoreEnv(os.Getenv("GATEWAY_DB_DSN"), os.Getenv("GATEWAY_DB_PATH")),
	})
}

func NewStoreWithConfig(cfg StoreConfig) (*Store, error) {
	root := cfg.Root
	if root == "" {
		root = filepath.Join(os.TempDir(), "gateway-data")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	_ = os.Chmod(root, 0o700)
	if err := os.MkdirAll(filepath.Join(root, "objects"), 0o700); err != nil {
		return nil, err
	}

	driver := strings.ToLower(strings.TrimSpace(cfg.Driver))
	if driver == "" {
		driver = storeDialectSQLite
	}
	var db *sql.DB
	var err error
	switch driver {
	case storeDialectSQLite, "sqlite3":
		driver = storeDialectSQLite
		db, err = sql.Open("sqlite", filepath.Join(root, "wrapper.db"))
	case storeDialectMySQL:
		dsn := strings.TrimSpace(cfg.DSN)
		if dsn == "" {
			return nil, errors.New("GATEWAY_DB_DSN is required when GATEWAY_DB_DRIVER=mysql")
		}
		if strings.HasPrefix(dsn, "mysql://") {
			if converted, convertErr := mysqlURLToDSN(dsn); convertErr == nil {
				dsn = converted
			}
		}
		db, err = sql.Open("mysql", dsn)
	default:
		return nil, fmt.Errorf("unsupported gateway store driver %q", cfg.Driver)
	}
	if err != nil {
		return nil, err
	}
	if driver == storeDialectSQLite {
		db.SetMaxOpenConns(1)
		if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
			_ = db.Close()
			return nil, err
		}
	} else {
		db.SetMaxOpenConns(20)
		db.SetMaxIdleConns(5)
		db.SetConnMaxLifetime(30 * time.Minute)
	}
	if err := migrateStoreForDialect(db, driver); err != nil {
		_ = db.Close()
		return nil, err
	}
	_ = os.Chmod(filepath.Join(root, "wrapper.db"), 0o600)
	return &Store{root: root, db: db, dialect: driver}, nil
}

func firstNonEmptyStoreEnv(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func (s *Store) isMySQL() bool {
	return s != nil && s.dialect == storeDialectMySQL
}

func (s *Store) SetFailArtifactPersist(value bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failArtifactPersist = value
}

func (s *Store) PutFile(scope Scope, filename, purpose, contentType, kind, sourceResponseID string, content []byte) (FileRecord, error) {
	id := "file_" + randomHex(18)
	sum := sha256.Sum256(content)
	path := filepath.Join(s.root, "objects", id)
	if kind == "artifact" {
		s.mu.Lock()
		fail := s.failArtifactPersist
		s.mu.Unlock()
		if fail {
			return FileRecord{}, errors.New("artifact persistence disabled by test hook")
		}
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		return FileRecord{}, err
	}
	now := time.Now().UTC()
	rec := FileRecord{
		ID:               id,
		Object:           "file",
		Bytes:            int64(len(content)),
		CreatedAt:        now.Unix(),
		Filename:         filename,
		Purpose:          purpose,
		ContentType:      contentType,
		SHA256:           hex.EncodeToString(sum[:]),
		Kind:             kind,
		SourceResponseID: sourceResponseID,
		Scope:            scope,
		ExpiresAt:        now.Add(24 * time.Hour),
		StoragePath:      path,
		StorageURI:       "file://" + id,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
INSERT INTO files (
	id, scope_tenant, scope_project, scope_sandbox, kind, purpose, filename,
	content_type, bytes, sha256, storage_uri, source_response_id, created_at, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.ID, rec.Scope.TenantID, rec.Scope.ProjectID, rec.Scope.SandboxScope, rec.Kind,
		rec.Purpose, rec.Filename, rec.ContentType, rec.Bytes, rec.SHA256, rec.StorageURI,
		rec.SourceResponseID, rec.CreatedAt, rec.ExpiresAt.Format(time.RFC3339Nano))
	if err != nil {
		_ = os.Remove(path)
		return FileRecord{}, err
	}
	return rec, nil
}

func (s *Store) GetFileRecord(scope Scope, id string) (FileRecord, *APIError) {
	s.mu.Lock()
	rec, ok, err := s.getFileRecordLocked(id)
	s.mu.Unlock()
	if err != nil {
		return FileRecord{}, apiErr("file_read_failed", err.Error())
	}
	if !ok {
		return FileRecord{}, apiErr("file_not_found", "file not found")
	}
	if !sameScope(scope, rec.Scope) {
		s.AddAudit("file_read_denied", scope, "", id, "cross-scope access denied")
		return FileRecord{}, apiErr("scope_denied", "file is outside caller scope")
	}
	if time.Now().UTC().After(rec.ExpiresAt) {
		s.AddAudit("file_read_denied", scope, "", id, "file expired")
		return FileRecord{}, apiErr("file_expired", "file has expired")
	}
	return rec, nil
}

func (s *Store) GetFile(scope Scope, id string) (FileRecord, []byte, *APIError) {
	rec, getErr := s.GetFileRecord(scope, id)
	if getErr != nil {
		return FileRecord{}, nil, getErr
	}
	content, err := os.ReadFile(rec.StoragePath)
	if err != nil {
		return FileRecord{}, nil, apiErr("file_read_failed", err.Error())
	}
	s.AddAudit("file_read", scope, "", id, "")
	return rec, content, nil
}

func (s *Store) MaterializeFiles(scope Scope, ids []string) ([]materializedFile, *APIError) {
	files := make([]materializedFile, 0, len(ids))
	for _, id := range ids {
		rec, _, err := s.GetFile(scope, id)
		if err != nil {
			return nil, err
		}
		files = append(files, materializedFile{
			FileID:      rec.ID,
			Filename:    rec.Filename,
			ContentType: rec.ContentType,
			Bytes:       rec.Bytes,
			SHA256:      rec.SHA256,
			Path:        rec.StoragePath,
		})
	}
	return files, nil
}

func (s *Store) ExpireFile(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.db.Exec(`UPDATE files SET expires_at = ? WHERE id = ?`, time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), id)
}

func (s *Store) CreateResponse(scope Scope, model string) ResponseRecord {
	now := time.Now().UTC()
	rec := ResponseRecord{
		ID:        "resp_" + randomHex(18),
		Object:    "response",
		CreatedAt: now.Unix(),
		Status:    "in_progress",
		Model:     model,
		Scope:     scope,
	}
	s.mu.Lock()
	_, _ = s.db.Exec(`
INSERT INTO responses (
	id, scope_tenant, scope_project, scope_sandbox, model, status, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.ID, scope.TenantID, scope.ProjectID, scope.SandboxScope, rec.Model, rec.Status, rec.CreatedAt, rec.CreatedAt)
	s.mu.Unlock()
	s.AddAudit("response_created", scope, rec.ID, "", "")
	return rec
}

func (s *Store) CompleteResponse(id, output string, artifacts []string) ResponseRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok, _ := s.getResponseLocked(id)
	if !ok {
		return ResponseRecord{ID: id, Status: "completed", OutputText: output, ArtifactFileIDs: artifacts}
	}
	rec.Status = "completed"
	rec.OutputText = output
	rec.Output = []OutputItem{
		{
			ID:     "msg_" + randomHex(12),
			Type:   "message",
			Status: "completed",
			Role:   "assistant",
			Content: []OutputContent{
				{
					Type:        "output_text",
					Text:        output,
					Annotations: []any{},
				},
			},
		},
	}
	rec.ArtifactFileIDs = artifacts
	now := time.Now().UTC()
	outputJSON, _ := json.Marshal(rec.Output)
	artifactsJSON, _ := json.Marshal(artifacts)
	_, _ = s.db.Exec(`UPDATE responses SET status = ?, output_text = ?, output_json = ?, artifact_file_ids_json = ?, updated_at = ? WHERE id = ?`,
		rec.Status, rec.OutputText, string(outputJSON), string(artifactsJSON), now.Unix(), id)
	_, _ = s.db.Exec(`INSERT INTO audit_events (type, response_id, scope_tenant, scope_project, scope_sandbox, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		"response_completed", id, rec.Scope.TenantID, rec.Scope.ProjectID, rec.Scope.SandboxScope, now.Format(time.RFC3339Nano))
	rec.AuditSummary = s.auditForResponseLocked(id)
	return rec
}

func (s *Store) FailResponse(id string, err *APIError) ResponseRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok, _ := s.getResponseLocked(id)
	if !ok {
		return ResponseRecord{ID: id, Status: "failed", Error: err}
	}
	rec.Status = "failed"
	rec.Error = err
	detail := ""
	if err != nil {
		detail = err.Code
	}
	now := time.Now().UTC()
	errCode := ""
	errMessage := ""
	if err != nil {
		errCode = err.Code
		errMessage = err.Message
	}
	_, _ = s.db.Exec(`UPDATE responses SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`,
		rec.Status, errCode, errMessage, now.Unix(), id)
	_, _ = s.db.Exec(`INSERT INTO audit_events (type, response_id, scope_tenant, scope_project, scope_sandbox, created_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"response_failed", id, rec.Scope.TenantID, rec.Scope.ProjectID, rec.Scope.SandboxScope, now.Format(time.RFC3339Nano), detail)
	rec.AuditSummary = s.auditForResponseLocked(id)
	return rec
}

func (s *Store) GetResponse(scope Scope, id string) (ResponseRecord, *APIError) {
	s.mu.Lock()
	rec, ok, err := s.getResponseLocked(id)
	if ok {
		rec.AuditSummary = s.auditForResponseLocked(id)
	}
	s.mu.Unlock()
	if err != nil {
		return ResponseRecord{}, apiErr("response_read_failed", err.Error())
	}
	if !ok {
		return ResponseRecord{}, apiErr("response_not_found", "response not found")
	}
	if !sameScope(scope, rec.Scope) {
		s.AddAudit("response_read_denied", scope, id, "", "cross-scope access denied")
		return ResponseRecord{}, apiErr("scope_denied", "response is outside caller scope")
	}
	return rec, nil
}

func (s *Store) AddAudit(kind string, scope Scope, responseID, fileID, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.db.Exec(`
INSERT INTO audit_events (type, response_id, file_id, scope_tenant, scope_project, scope_sandbox, created_at, detail)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		kind, responseID, fileID, scope.TenantID, scope.ProjectID, scope.SandboxScope, time.Now().UTC().Format(time.RFC3339Nano), detail)
}

func (s *Store) auditForResponseLocked(responseID string) []AuditEvent {
	rows, err := s.db.Query(`
SELECT type, COALESCE(response_id, ''), COALESCE(file_id, ''), scope_tenant, scope_project, scope_sandbox, created_at, COALESCE(detail, '')
FROM audit_events WHERE response_id = ? ORDER BY id`, responseID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []AuditEvent
	for rows.Next() {
		var ev AuditEvent
		var created string
		if err := rows.Scan(&ev.Type, &ev.ResponseID, &ev.FileID, &ev.Scope.TenantID, &ev.Scope.ProjectID, &ev.Scope.SandboxScope, &created, &ev.Detail); err != nil {
			return out
		}
		if t, err := time.Parse(time.RFC3339Nano, created); err == nil {
			ev.CreatedAt = t
		}
		out = append(out, ev)
	}
	return out
}

func (s *Store) getFileRecordLocked(id string) (FileRecord, bool, error) {
	var rec FileRecord
	var expiresAt string
	var deletedAt sql.NullString
	err := s.db.QueryRow(`
SELECT id, bytes, created_at, filename, purpose, content_type, sha256, kind, COALESCE(source_response_id, ''),
       scope_tenant, scope_project, scope_sandbox, expires_at, storage_uri, deleted_at
FROM files WHERE id = ?`, id).Scan(
		&rec.ID, &rec.Bytes, &rec.CreatedAt, &rec.Filename, &rec.Purpose, &rec.ContentType, &rec.SHA256,
		&rec.Kind, &rec.SourceResponseID, &rec.Scope.TenantID, &rec.Scope.ProjectID, &rec.Scope.SandboxScope,
		&expiresAt, &rec.StorageURI, &deletedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return FileRecord{}, false, nil
	}
	if err != nil {
		return FileRecord{}, false, err
	}
	if deletedAt.Valid && deletedAt.String != "" {
		return FileRecord{}, false, nil
	}
	rec.Object = "file"
	rec.StoragePath = filepath.Join(s.root, "objects", rec.ID)
	if rec.StorageURI == "" {
		rec.StorageURI = "file://" + rec.ID
	}
	if t, err := time.Parse(time.RFC3339Nano, expiresAt); err == nil {
		rec.ExpiresAt = t
	}
	return rec, true, nil
}

func (s *Store) getResponseLocked(id string) (ResponseRecord, bool, error) {
	var rec ResponseRecord
	var outputJSON, artifactsJSON sql.NullString
	var errCode, errMessage sql.NullString
	var scopeSandbox string
	err := s.db.QueryRow(`
SELECT id, created_at, status, model, COALESCE(output_text, ''), output_json, artifact_file_ids_json,
       error_code, error_message, scope_tenant, scope_project, scope_sandbox
FROM responses WHERE id = ?`, id).Scan(
		&rec.ID, &rec.CreatedAt, &rec.Status, &rec.Model, &rec.OutputText, &outputJSON, &artifactsJSON,
		&errCode, &errMessage, &rec.Scope.TenantID, &rec.Scope.ProjectID, &scopeSandbox,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ResponseRecord{}, false, nil
	}
	if err != nil {
		return ResponseRecord{}, false, err
	}
	rec.Object = "response"
	rec.Scope.SandboxScope = scopeSandbox
	if outputJSON.Valid && outputJSON.String != "" {
		_ = json.Unmarshal([]byte(outputJSON.String), &rec.Output)
	}
	if artifactsJSON.Valid && artifactsJSON.String != "" {
		_ = json.Unmarshal([]byte(artifactsJSON.String), &rec.ArtifactFileIDs)
	}
	if errCode.Valid && errCode.String != "" {
		rec.Error = &APIError{Type: "wrapper_error", Code: errCode.String, Message: errMessage.String}
	}
	return rec, true, nil
}

func randomHex(bytes int) string {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("random id failed: %v", err))
	}
	return hex.EncodeToString(buf)
}
