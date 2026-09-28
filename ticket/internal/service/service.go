package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono/ticket/internal/store"
)

var (
	ErrInvalidInput = errors.New("invalid input")
	ErrForbidden    = errors.New("forbidden")
	ErrNotFound     = errors.New("not found")
)

type Store interface {
	CreateTicket(ctx context.Context, userID, realm, subject, category, body string) (*store.Ticket, error)
	GetTicket(ctx context.Context, id string) (*store.Ticket, error)
	ListTicketsByUser(ctx context.Context, userID string) ([]store.Ticket, error)
	ListTicketsByRealm(ctx context.Context, realm, status, assignee string) ([]store.Ticket, error)
	UpdateTicketStatus(ctx context.Context, id, status, actorID, note string) (*store.Ticket, error)
	AppendMessage(ctx context.Context, ticketID, authorType, authorID, body string) (*store.TicketMessage, error)
	ListMessages(ctx context.Context, ticketID string) ([]store.TicketMessage, error)
	CreateSupportFeedback(ctx context.Context, in store.CreateSupportFeedbackInput) (*store.SupportFeedback, error)
	ListSupportFeedback(ctx context.Context, site string) ([]store.SupportFeedback, error)
	GetSupportFeedbackAttachment(ctx context.Context, id string) (*store.SupportFeedbackAttachment, error)
}

type Service struct {
	store Store
}

func New(s Store) *Service {
	return &Service{store: s}
}

// loadTicket 统一处理"查单"错误：记录不存在映射为 ErrNotFound，
// 其余（DB 连接、扫描等）错误保留原始信息向上包装，避免掩盖真实原因。
func (s *Service) loadTicket(ctx context.Context, id string) (*store.Ticket, error) {
	t, err := s.store.GetTicket(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("load ticket %q: %w", id, err)
	}
	return t, nil
}

// --- User ---

func (s *Service) CreateTicket(ctx context.Context, userID, realm, subject, category, body string) (*store.Ticket, error) {
	subject = strings.TrimSpace(subject)
	body = strings.TrimSpace(body)
	if subject == "" || body == "" {
		return nil, ErrInvalidInput
	}
	if !validCategory(category) {
		return nil, ErrInvalidInput
	}
	return s.store.CreateTicket(ctx, userID, realm, subject, category, body)
}

func (s *Service) ListMyTickets(ctx context.Context, userID string) ([]store.Ticket, error) {
	return s.store.ListTicketsByUser(ctx, userID)
}

func (s *Service) GetMyTicketDetail(ctx context.Context, userID, id string) (*store.Ticket, []store.TicketMessage, error) {
	t, err := s.loadTicket(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if t.UserID != userID {
		return nil, nil, ErrForbidden
	}
	msgs, err := s.store.ListMessages(ctx, id)
	if err != nil {
		return nil, nil, fmt.Errorf("list messages: %w", err)
	}
	return t, msgs, nil
}

func (s *Service) AppendUserMessage(ctx context.Context, userID, ticketID, body string) (*store.TicketMessage, error) {
	body = strings.TrimSpace(body)
	if body == "" {
		return nil, ErrInvalidInput
	}
	t, err := s.loadTicket(ctx, ticketID)
	if err != nil {
		return nil, err
	}
	if t.UserID != userID {
		return nil, ErrForbidden
	}
	return s.store.AppendMessage(ctx, ticketID, "user", userID, body)
}

// --- Admin ---

func (s *Service) AdminListTickets(ctx context.Context, realm, status, assignee string) ([]store.Ticket, error) {
	return s.store.ListTicketsByRealm(ctx, realm, status, assignee)
}

func (s *Service) AdminGetTicketDetail(ctx context.Context, realm, id string) (*store.Ticket, []store.TicketMessage, error) {
	t, err := s.loadTicket(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if t.Realm != realm {
		return nil, nil, ErrForbidden
	}
	msgs, err := s.store.ListMessages(ctx, id)
	if err != nil {
		return nil, nil, fmt.Errorf("list messages: %w", err)
	}
	return t, msgs, nil
}

func (s *Service) AdminReply(ctx context.Context, realm, agentID, ticketID, body string) (*store.TicketMessage, error) {
	body = strings.TrimSpace(body)
	if body == "" {
		return nil, ErrInvalidInput
	}
	t, err := s.loadTicket(ctx, ticketID)
	if err != nil {
		return nil, err
	}
	if t.Realm != realm {
		return nil, ErrForbidden
	}
	return s.store.AppendMessage(ctx, ticketID, "agent", agentID, body)
}

func (s *Service) AdminUpdateStatus(ctx context.Context, realm, agentID, ticketID, status, note string) (*store.Ticket, error) {
	if !validStatus(status) {
		return nil, ErrInvalidInput
	}
	t, err := s.loadTicket(ctx, ticketID)
	if err != nil {
		return nil, err
	}
	if t.Realm != realm {
		return nil, ErrForbidden
	}
	return s.store.UpdateTicketStatus(ctx, ticketID, status, agentID, note)
}

func validCategory(c string) bool {
	switch c {
	case "bug", "feature", "billing", "other":
		return true
	}
	return false
}

func validStatus(s string) bool {
	switch s {
	case "open", "pending", "resolved", "closed":
		return true
	}
	return false
}

// --- Support feedback ---

func (s *Service) CreateSupportFeedback(ctx context.Context, in store.CreateSupportFeedbackInput) (*store.SupportFeedback, error) {
	if strings.TrimSpace(in.AccountID) == "" ||
		strings.TrimSpace(in.Site) == "" ||
		strings.TrimSpace(in.Category) == "" ||
		strings.TrimSpace(in.FeedbackType) == "" ||
		strings.TrimSpace(in.Subject) == "" ||
		strings.TrimSpace(in.Description) == "" {
		return nil, ErrInvalidInput
	}
	if in.Site != "cn" && in.Site != "global" {
		return nil, ErrInvalidInput
	}
	if in.Category != "suggestion" && in.Category != "bug" {
		return nil, ErrInvalidInput
	}
	return s.store.CreateSupportFeedback(ctx, in)
}

func (s *Service) ListSupportFeedback(ctx context.Context, site string) ([]store.SupportFeedback, error) {
	if site != "" && site != "cn" && site != "global" {
		return nil, ErrInvalidInput
	}
	return s.store.ListSupportFeedback(ctx, site)
}

func (s *Service) GetSupportFeedbackAttachment(ctx context.Context, id string) (*store.SupportFeedbackAttachment, error) {
	attachment, err := s.store.GetSupportFeedbackAttachment(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("load support feedback attachment %q: %w", id, err)
	}
	return attachment, nil
}
