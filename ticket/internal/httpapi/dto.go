package httpapi

import (
	"time"

	"git.woa.com/wisp/mono/ticket/internal/store"
)

// ticketDTO 是 /tickets 与 /admin/tickets 接口对外暴露的工单载荷。
// 与 store.Ticket 解耦：sql.NullString 展平为 *string，避免 JSON `{"Valid":..,"String":..}`。
type ticketDTO struct {
	ID        string    `json:"id"`
	Subject   string    `json:"subject"`
	Status    string    `json:"status"`
	Category  string    `json:"category"`
	Realm     string    `json:"realm"`
	Assignee  *string   `json:"assignee"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// messageDTO 是工单会话消息的对外载荷。
type messageDTO struct {
	ID         string    `json:"id"`
	TicketID   string    `json:"ticket_id"`
	AuthorType string    `json:"author_type"`
	AuthorID   *string   `json:"author_id"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
}

// toTicketDTO 将 store 层实体映射为可 JSON 序列化的 DTO。
func toTicketDTO(t store.Ticket) ticketDTO {
	dto := ticketDTO{
		ID:        t.ID,
		Subject:   t.Subject,
		Status:    t.Status,
		Category:  t.Category,
		Realm:     t.Realm,
		CreatedAt: t.CreatedAt,
		UpdatedAt: t.UpdatedAt,
	}
	if t.Assignee.Valid {
		v := t.Assignee.String
		dto.Assignee = &v
	}
	return dto
}

// toTicketDTOs 批量映射工单列表。
func toTicketDTOs(items []store.Ticket) []ticketDTO {
	out := make([]ticketDTO, 0, len(items))
	for _, t := range items {
		out = append(out, toTicketDTO(t))
	}
	return out
}

// toMessageDTO 将 store 层消息实体映射为对外 DTO。
func toMessageDTO(m store.TicketMessage) messageDTO {
	dto := messageDTO{
		ID:         m.ID,
		TicketID:   m.TicketID,
		AuthorType: m.AuthorType,
		Body:       m.Body,
		CreatedAt:  m.CreatedAt,
	}
	if m.AuthorID.Valid {
		v := m.AuthorID.String
		dto.AuthorID = &v
	}
	return dto
}

// toMessageDTOs 批量映射消息列表。
func toMessageDTOs(items []store.TicketMessage) []messageDTO {
	out := make([]messageDTO, 0, len(items))
	for _, m := range items {
		out = append(out, toMessageDTO(m))
	}
	return out
}
