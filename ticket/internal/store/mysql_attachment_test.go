package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

var registerAttachmentDriver sync.Once

type attachmentDriver struct{}

func (attachmentDriver) Open(string) (driver.Conn, error) { return attachmentConn{}, nil }

type attachmentConn struct{}

func (attachmentConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not implemented") }
func (attachmentConn) Close() error                        { return nil }
func (attachmentConn) Begin() (driver.Tx, error)           { return nil, errors.New("not implemented") }
func (attachmentConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return &attachmentRows{}, nil
}

type attachmentRows struct{ read bool }

func (*attachmentRows) Columns() []string {
	return []string{"id", "feedback_id", "file_name", "content_type", "size_bytes", "content", "created_at"}
}
func (*attachmentRows) Close() error { return nil }
func (r *attachmentRows) Next(dest []driver.Value) error {
	if r.read {
		return io.EOF
	}
	r.read = true
	values := []driver.Value{"fba_test", "fb_test", "smoke.txt", "text/plain", int64(5), []byte("hello"), time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC)}
	copy(dest, values)
	return nil
}

func TestGetSupportFeedbackAttachmentReadsBlobFromSingleRow(t *testing.T) {
	registerAttachmentDriver.Do(func() { sql.Register("ticket_attachment_test", attachmentDriver{}) })
	db, err := sql.Open("ticket_attachment_test", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := &MySQLStore{db: db}
	got, err := s.GetSupportFeedbackAttachment(context.Background(), "fba_test")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "fba_test" || string(got.Content) != "hello" {
		t.Fatalf("unexpected attachment: id=%q content=%q", got.ID, got.Content)
	}
}
