package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
)

// TicketStatus / Category 保持字符串（对齐 openapi）
type Ticket struct {
	ID        string
	UserID    string
	Realm     string
	Subject   string
	Category  string
	Status    string
	Assignee  sql.NullString
	CreatedAt time.Time
	UpdatedAt time.Time
}

type TicketMessage struct {
	ID         string
	TicketID   string
	AuthorType string // user | agent | system
	AuthorID   sql.NullString
	Body       string
	CreatedAt  time.Time
}

type SupportFeedback struct {
	ID           string
	AccountID    string
	Site         string
	Category     string
	FeedbackType string
	OtherText    sql.NullString
	Subject      string
	Description  string
	ContactInfo  sql.NullString
	ProfileJSON  sql.NullString
	BugInfoJSON  sql.NullString
	Status       string
	Source       string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	Attachments  []SupportFeedbackAttachment
}

type SupportFeedbackAttachment struct {
	ID          string
	FeedbackID  string
	FileName    string
	ContentType string
	SizeBytes   int64
	Content     []byte
	CreatedAt   time.Time
}

type CreateSupportFeedbackInput struct {
	ID           string
	AccountID    string
	Site         string
	Category     string
	FeedbackType string
	OtherText    string
	Subject      string
	Description  string
	ContactInfo  string
	ProfileJSON  string
	BugInfoJSON  string
	Attachments  []CreateSupportFeedbackAttachmentInput
}

type CreateSupportFeedbackAttachmentInput struct {
	ID          string
	FileName    string
	ContentType string
	SizeBytes   int64
	Content     []byte
}

type MySQLStore struct {
	db *sql.DB
}

func NewMySQLStore(dsn string) (*MySQLStore, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	if err := db.PingContext(context.Background()); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping mysql: %w", err)
	}
	return &MySQLStore{db: db}, nil
}

func (s *MySQLStore) Close() error {
	return s.db.Close()
}

// --- Ticket ---

func (s *MySQLStore) CreateTicket(ctx context.Context, userID, realm, subject, category, body string) (*Ticket, error) {
	now := time.Now().UTC()
	t := &Ticket{
		ID:        uuid.NewString(),
		UserID:    userID,
		Realm:     realm,
		Subject:   subject,
		Category:  category,
		Status:    "open",
		CreatedAt: now,
		UpdatedAt: now,
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("create ticket: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO ticket (id, user_id, realm, subject, category, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.UserID, t.Realm, t.Subject, t.Category, t.Status, t.CreatedAt, t.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert ticket: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO ticket_message (id, ticket_id, author_type, author_id, body, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		uuid.NewString(), t.ID, "user", userID, body, now,
	); err != nil {
		return nil, fmt.Errorf("insert first message: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("create ticket: commit tx: %w", err)
	}
	return t, nil
}

func (s *MySQLStore) GetTicket(ctx context.Context, id string) (*Ticket, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, user_id, realm, subject, category, status, assignee, created_at, updated_at
		 FROM ticket WHERE id = ?`, id)
	t := &Ticket{}
	if err := row.Scan(&t.ID, &t.UserID, &t.Realm, &t.Subject, &t.Category, &t.Status, &t.Assignee, &t.CreatedAt, &t.UpdatedAt); err != nil {
		// 保留 sql.ErrNoRows 语义（%w 可被上层 errors.Is 穿透判断），其余错误附带上下文
		return nil, fmt.Errorf("get ticket %q: %w", id, err)
	}
	return t, nil
}

func (s *MySQLStore) ListTicketsByUser(ctx context.Context, userID string) ([]Ticket, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, realm, subject, category, status, assignee, created_at, updated_at
		 FROM ticket WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`, userID)
	if err != nil {
		return nil, fmt.Errorf("list tickets by user %q: %w", userID, err)
	}
	defer rows.Close()
	return scanTickets(rows)
}

func (s *MySQLStore) ListTicketsByRealm(ctx context.Context, realm, status, assignee string) ([]Ticket, error) {
	q := `SELECT id, user_id, realm, subject, category, status, assignee, created_at, updated_at
	      FROM ticket WHERE realm = ?`
	args := []any{realm}
	if status != "" {
		q += " AND status = ?"
		args = append(args, status)
	}
	if assignee != "" {
		q += " AND assignee = ?"
		args = append(args, assignee)
	}
	q += " ORDER BY updated_at DESC LIMIT 500"
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list tickets by realm %q: %w", realm, err)
	}
	defer rows.Close()
	return scanTickets(rows)
}

func scanTickets(rows *sql.Rows) ([]Ticket, error) {
	out := make([]Ticket, 0, 32)
	for rows.Next() {
		var t Ticket
		if err := rows.Scan(&t.ID, &t.UserID, &t.Realm, &t.Subject, &t.Category, &t.Status, &t.Assignee, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan ticket row: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ticket rows: %w", err)
	}
	return out, nil
}

func (s *MySQLStore) UpdateTicketStatus(ctx context.Context, id, status, actorID, note string) (*Ticket, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("update ticket status: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx,
		`UPDATE ticket SET status = ?, updated_at = ? WHERE id = ?`,
		status, now, id,
	); err != nil {
		return nil, fmt.Errorf("update ticket %q status: %w", id, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO ticket_audit_log (id, ticket_id, actor_id, action, detail, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		uuid.NewString(), id, actorID, "status:"+status, note, now,
	); err != nil {
		return nil, fmt.Errorf("insert audit log: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("update ticket status: commit tx: %w", err)
	}
	return s.GetTicket(ctx, id)
}

// --- Messages ---

func (s *MySQLStore) AppendMessage(ctx context.Context, ticketID, authorType, authorID, body string) (*TicketMessage, error) {
	now := time.Now().UTC()
	m := &TicketMessage{
		ID:         uuid.NewString(),
		TicketID:   ticketID,
		AuthorType: authorType,
		Body:       body,
		CreatedAt:  now,
	}
	if authorID != "" {
		m.AuthorID = sql.NullString{String: authorID, Valid: true}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("append message: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO ticket_message (id, ticket_id, author_type, author_id, body, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		m.ID, m.TicketID, m.AuthorType, m.AuthorID, m.Body, m.CreatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert message: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE ticket SET updated_at = ? WHERE id = ?`, now, ticketID); err != nil {
		return nil, fmt.Errorf("touch ticket %q updated_at: %w", ticketID, err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("append message: commit tx: %w", err)
	}
	return m, nil
}

func (s *MySQLStore) ListMessages(ctx context.Context, ticketID string) ([]TicketMessage, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, ticket_id, author_type, author_id, body, created_at
		 FROM ticket_message WHERE ticket_id = ? ORDER BY created_at ASC`, ticketID)
	if err != nil {
		return nil, fmt.Errorf("list messages for ticket %q: %w", ticketID, err)
	}
	defer rows.Close()
	out := make([]TicketMessage, 0, 8)
	for rows.Next() {
		var m TicketMessage
		if err := rows.Scan(&m.ID, &m.TicketID, &m.AuthorType, &m.AuthorID, &m.Body, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan message row: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate message rows: %w", err)
	}
	return out, nil
}

// --- Support feedback ---

func (s *MySQLStore) CreateSupportFeedback(ctx context.Context, in CreateSupportFeedbackInput) (*SupportFeedback, error) {
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("create support feedback: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var otherText sql.NullString
	if in.OtherText != "" {
		otherText = sql.NullString{String: in.OtherText, Valid: true}
	}
	var contactInfo sql.NullString
	if in.ContactInfo != "" {
		contactInfo = sql.NullString{String: in.ContactInfo, Valid: true}
	}
	var profileJSON sql.NullString
	if in.ProfileJSON != "" {
		profileJSON = sql.NullString{String: in.ProfileJSON, Valid: true}
	}
	var bugInfoJSON sql.NullString
	if in.BugInfoJSON != "" {
		bugInfoJSON = sql.NullString{String: in.BugInfoJSON, Valid: true}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO support_feedback
		 (id, account_id, site, category, feedback_type, other_text, subject, description, contact_info, profile_json, bug_info_json, status, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		in.ID, in.AccountID, in.Site, in.Category, in.FeedbackType, otherText, in.Subject, in.Description, contactInfo, profileJSON, bugInfoJSON, "open", "support-page", now, now,
	); err != nil {
		return nil, fmt.Errorf("insert support feedback: %w", err)
	}

	for _, a := range in.Attachments {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO support_feedback_attachment
			 (id, feedback_id, file_name, content_type, size_bytes, content, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			a.ID, in.ID, a.FileName, a.ContentType, a.SizeBytes, a.Content, now,
		); err != nil {
			return nil, fmt.Errorf("insert support feedback attachment: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("create support feedback: commit tx: %w", err)
	}
	return s.GetSupportFeedback(ctx, in.ID)
}

func (s *MySQLStore) GetSupportFeedback(ctx context.Context, id string) (*SupportFeedback, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, account_id, site, category, feedback_type, other_text, subject, description, contact_info, profile_json, bug_info_json, status, source, created_at, updated_at
		 FROM support_feedback WHERE id = ?`, id)
	rec, err := scanSupportFeedback(row)
	if err != nil {
		return nil, fmt.Errorf("get support feedback %q: %w", id, err)
	}
	attachments, err := s.ListSupportFeedbackAttachments(ctx, id)
	if err != nil {
		return nil, err
	}
	rec.Attachments = attachments
	return rec, nil
}

func (s *MySQLStore) ListSupportFeedback(ctx context.Context, site string) ([]SupportFeedback, error) {
	q := `SELECT id, account_id, site, category, feedback_type, other_text, subject, description, contact_info, profile_json, bug_info_json, status, source, created_at, updated_at
	      FROM support_feedback`
	args := []any{}
	if site == "cn" || site == "global" {
		q += ` WHERE site = ?`
		args = append(args, site)
	}
	q += ` ORDER BY created_at DESC LIMIT 1000`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list support feedback: %w", err)
	}
	defer rows.Close()

	out := make([]SupportFeedback, 0, 32)
	for rows.Next() {
		rec, err := scanSupportFeedback(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate support feedback rows: %w", err)
	}

	if len(out) == 0 {
		return out, nil
	}
	ids := make([]string, 0, len(out))
	for _, rec := range out {
		ids = append(ids, rec.ID)
	}
	attachments, err := s.listSupportFeedbackAttachmentsByFeedbackIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	byFeedbackID := make(map[string][]SupportFeedbackAttachment, len(out))
	for _, attachment := range attachments {
		byFeedbackID[attachment.FeedbackID] = append(byFeedbackID[attachment.FeedbackID], attachment)
	}
	for i := range out {
		out[i].Attachments = byFeedbackID[out[i].ID]
	}
	return out, nil
}

func (s *MySQLStore) ListSupportFeedbackAttachments(ctx context.Context, feedbackID string) ([]SupportFeedbackAttachment, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, feedback_id, file_name, content_type, size_bytes, NULL, created_at
		 FROM support_feedback_attachment WHERE feedback_id = ? ORDER BY created_at ASC`, feedbackID)
	if err != nil {
		return nil, fmt.Errorf("list support feedback attachments for %q: %w", feedbackID, err)
	}
	defer rows.Close()
	return scanSupportFeedbackAttachments(rows)
}

func (s *MySQLStore) GetSupportFeedbackAttachment(ctx context.Context, id string) (*SupportFeedbackAttachment, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, feedback_id, file_name, content_type, size_bytes, content, created_at
		 FROM support_feedback_attachment WHERE id = ?`, id)
	var content sql.RawBytes
	attachment := &SupportFeedbackAttachment{}
	if err := row.Scan(&attachment.ID, &attachment.FeedbackID, &attachment.FileName, &attachment.ContentType, &attachment.SizeBytes, &content, &attachment.CreatedAt); err != nil {
		return nil, fmt.Errorf("get support feedback attachment %q: %w", id, err)
	}
	attachment.Content = append([]byte(nil), content...)
	return attachment, nil
}

func (s *MySQLStore) listSupportFeedbackAttachmentsByFeedbackIDs(ctx context.Context, feedbackIDs []string) ([]SupportFeedbackAttachment, error) {
	if len(feedbackIDs) == 0 {
		return nil, nil
	}
	placeholders := "?"
	args := make([]any, 0, len(feedbackIDs))
	args = append(args, feedbackIDs[0])
	for _, id := range feedbackIDs[1:] {
		placeholders += ",?"
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, feedback_id, file_name, content_type, size_bytes, NULL, created_at
		 FROM support_feedback_attachment WHERE feedback_id IN (`+placeholders+`) ORDER BY created_at ASC`, args...)
	if err != nil {
		return nil, fmt.Errorf("list support feedback attachments: %w", err)
	}
	defer rows.Close()
	return scanSupportFeedbackAttachments(rows)
}

type supportFeedbackScanner interface {
	Scan(dest ...any) error
}

func scanSupportFeedback(scanner supportFeedbackScanner) (*SupportFeedback, error) {
	rec := &SupportFeedback{}
	if err := scanner.Scan(
		&rec.ID,
		&rec.AccountID,
		&rec.Site,
		&rec.Category,
		&rec.FeedbackType,
		&rec.OtherText,
		&rec.Subject,
		&rec.Description,
		&rec.ContactInfo,
		&rec.ProfileJSON,
		&rec.BugInfoJSON,
		&rec.Status,
		&rec.Source,
		&rec.CreatedAt,
		&rec.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("scan support feedback row: %w", err)
	}
	return rec, nil
}

func scanSupportFeedbackAttachments(rows *sql.Rows) ([]SupportFeedbackAttachment, error) {
	out := make([]SupportFeedbackAttachment, 0, 8)
	for rows.Next() {
		var content sql.RawBytes
		var attachment SupportFeedbackAttachment
		if err := rows.Scan(&attachment.ID, &attachment.FeedbackID, &attachment.FileName, &attachment.ContentType, &attachment.SizeBytes, &content, &attachment.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan support feedback attachment row: %w", err)
		}
		if content != nil {
			attachment.Content = append([]byte(nil), content...)
		}
		out = append(out, attachment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate support feedback attachment rows: %w", err)
	}
	return out, nil
}
