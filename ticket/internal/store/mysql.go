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
		return nil, err
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
		return nil, err
	}
	return t, nil
}

func (s *MySQLStore) GetTicket(ctx context.Context, id string) (*Ticket, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, user_id, realm, subject, category, status, assignee, created_at, updated_at
		 FROM ticket WHERE id = ?`, id)
	t := &Ticket{}
	if err := row.Scan(&t.ID, &t.UserID, &t.Realm, &t.Subject, &t.Category, &t.Status, &t.Assignee, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	return t, nil
}

func (s *MySQLStore) ListTicketsByUser(ctx context.Context, userID string) ([]Ticket, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, realm, subject, category, status, assignee, created_at, updated_at
		 FROM ticket WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`, userID)
	if err != nil {
		return nil, err
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
		return nil, err
	}
	defer rows.Close()
	return scanTickets(rows)
}

func scanTickets(rows *sql.Rows) ([]Ticket, error) {
	out := make([]Ticket, 0, 32)
	for rows.Next() {
		var t Ticket
		if err := rows.Scan(&t.ID, &t.UserID, &t.Realm, &t.Subject, &t.Category, &t.Status, &t.Assignee, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *MySQLStore) UpdateTicketStatus(ctx context.Context, id, status, actorID, note string) (*Ticket, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx,
		`UPDATE ticket SET status = ?, updated_at = ? WHERE id = ?`,
		status, now, id,
	); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO ticket_audit_log (id, ticket_id, actor_id, action, detail, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		uuid.NewString(), id, actorID, "status:"+status, note, now,
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
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
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO ticket_message (id, ticket_id, author_type, author_id, body, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		m.ID, m.TicketID, m.AuthorType, m.AuthorID, m.Body, m.CreatedAt,
	); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE ticket SET updated_at = ? WHERE id = ?`, now, ticketID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return m, nil
}

func (s *MySQLStore) ListMessages(ctx context.Context, ticketID string) ([]TicketMessage, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, ticket_id, author_type, author_id, body, created_at
		 FROM ticket_message WHERE ticket_id = ? ORDER BY created_at ASC`, ticketID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]TicketMessage, 0, 8)
	for rows.Next() {
		var m TicketMessage
		if err := rows.Scan(&m.ID, &m.TicketID, &m.AuthorType, &m.AuthorID, &m.Body, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
