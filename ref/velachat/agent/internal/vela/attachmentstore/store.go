// Package attachmentstore persists only launch-safe attachment staging data
// and Tencent IM file references. Chatserver never receives attachment bytes.
package attachmentstore

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	rootstate "velachat/agent/internal/state"
	"velachat/agent/internal/vela/im"
)

const MaxAttachmentBytes = 50 << 20

const (
	StatePending = "pending"
	StateRemote  = "remote"

	DirectionOutgoing = "outgoing"
	DirectionIncoming = "incoming"
)

var (
	ErrInvalidConfig      = errors.New("附件存储配置无效")
	ErrInvalidAttachment  = errors.New("附件参数无效")
	ErrAttachmentTooLarge = errors.New("附件超过 50 MiB")
	ErrNotFound           = errors.New("附件不存在")
	ErrNotPending         = errors.New("附件不在待发送状态")
	ErrNotSent            = errors.New("附件不是本次 Agent 已发送的附件")
	ErrConflict           = errors.New("附件引用冲突")
)

type Record struct {
	ID            string `json:"id"`
	State         string `json:"state"`
	Direction     string `json:"direction"`
	ChannelID     string `json:"channel_id"`
	Target        string `json:"target"`
	Filename      string `json:"filename"`
	MIMEType      string `json:"mime_type"`
	SizeBytes     int64  `json:"size_bytes"`
	MessageID     string `json:"message_id,omitempty"`
	TencentFileID string `json:"tencent_file_id,omitempty"`
	URL           string `json:"url,omitempty"`
}

type Store struct {
	state *rootstate.Store
}

func New(root string) (*Store, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) == string(filepath.Separator) {
		return nil, ErrInvalidConfig
	}
	return &Store{state: rootstate.New(filepath.Clean(root))}, nil
}

func (s *Store) Stage(
	channelID string,
	target string,
	filename string,
	mimeType string,
	data []byte,
) (Record, error) {
	channelID = strings.TrimSpace(channelID)
	target = strings.TrimSpace(target)
	filename = strings.TrimSpace(filename)
	mimeType = strings.TrimSpace(mimeType)
	if channelID == "" || target == "" || !validFilename(filename) ||
		mimeType == "" || len(data) == 0 {
		return Record{}, ErrInvalidAttachment
	}
	if len(data) > MaxAttachmentBytes {
		return Record{}, ErrAttachmentTooLarge
	}
	idValue, err := uuid.NewV7()
	if err != nil {
		return Record{}, err
	}
	record := Record{
		ID:        "att_" + strings.ReplaceAll(idValue.String(), "-", ""),
		State:     StatePending,
		Direction: DirectionOutgoing, ChannelID: channelID, Target: target,
		Filename: filename, MIMEType: mimeType, SizeBytes: int64(len(data)),
	}
	if err := s.state.WriteFile(pendingPath(record.ID), data, 0o600); err != nil {
		return Record{}, err
	}
	if err := s.state.Write(recordPath(record.ID), record); err != nil {
		_ = s.state.Remove(pendingPath(record.ID))
		return Record{}, err
	}
	return record, nil
}

func (s *Store) Pending(id string) (Record, []byte, error) {
	record, err := s.record(id)
	if err != nil {
		return Record{}, nil, err
	}
	if record.State != StatePending {
		return Record{}, nil, ErrNotPending
	}
	data, err := os.ReadFile(filepath.Join(s.state.Root(), pendingPath(record.ID)))
	if os.IsNotExist(err) {
		return Record{}, nil, ErrNotPending
	}
	if err != nil {
		return Record{}, nil, err
	}
	if len(data) == 0 || len(data) > MaxAttachmentBytes || int64(len(data)) != record.SizeBytes {
		return Record{}, nil, ErrInvalidAttachment
	}
	return record, data, nil
}

func (s *Store) Complete(
	id string,
	messageID string,
	attachment im.Attachment,
) (Record, error) {
	record, _, err := s.Pending(id)
	if err != nil {
		return Record{}, err
	}
	messageID = strings.TrimSpace(messageID)
	attachment = normalizedAttachment(attachment)
	if messageID == "" || !validRemoteAttachment(attachment) ||
		attachment.SizeBytes != record.SizeBytes {
		return Record{}, ErrInvalidAttachment
	}
	record.State = StateRemote
	record.MessageID = messageID
	record.TencentFileID = attachment.ID
	record.Filename = attachment.Filename
	record.MIMEType = attachment.MIMEType
	record.SizeBytes = attachment.SizeBytes
	record.URL = attachment.URL
	if err := s.state.Write(recordPath(record.ID), record); err != nil {
		return Record{}, err
	}
	if err := s.state.Remove(pendingPath(record.ID)); err != nil {
		return Record{}, err
	}
	return record, nil
}

func (s *Store) Remember(
	channelID string,
	target string,
	messageID string,
	attachment im.Attachment,
) (Record, error) {
	channelID = strings.TrimSpace(channelID)
	target = strings.TrimSpace(target)
	messageID = strings.TrimSpace(messageID)
	attachment = normalizedAttachment(attachment)
	if channelID == "" || target == "" || messageID == "" ||
		!validRemoteAttachment(attachment) {
		return Record{}, ErrInvalidAttachment
	}
	hash := sha256.Sum256([]byte(messageID + "\x00" + attachment.ID))
	record := Record{
		ID: fmt.Sprintf("att_%x", hash[:16]), State: StateRemote,
		Direction: DirectionIncoming,
		ChannelID: channelID, Target: target, MessageID: messageID,
		TencentFileID: attachment.ID, Filename: attachment.Filename,
		MIMEType: attachment.MIMEType, SizeBytes: attachment.SizeBytes,
		URL: attachment.URL,
	}
	if existing, err := s.record(record.ID); err == nil {
		if !sameRemoteAttachmentIdentity(existing, record) {
			return Record{}, ErrConflict
		}
		if existing.URL != record.URL || existing.MIMEType != record.MIMEType {
			existing.URL = record.URL
			existing.MIMEType = record.MIMEType
			if err := s.state.Write(recordPath(existing.ID), existing); err != nil {
				return Record{}, err
			}
		}
		return existing, nil
	} else if !errors.Is(err, ErrNotFound) {
		return Record{}, err
	}
	if err := s.state.Write(recordPath(record.ID), record); err != nil {
		return Record{}, err
	}
	return record, nil
}

func sameRemoteAttachmentIdentity(left Record, right Record) bool {
	return left.ID == right.ID && left.State == right.State &&
		left.Direction == right.Direction && left.ChannelID == right.ChannelID &&
		left.Target == right.Target && left.Filename == right.Filename &&
		left.SizeBytes == right.SizeBytes && left.MessageID == right.MessageID &&
		left.TencentFileID == right.TencentFileID
}

func (s *Store) Remote(id string) (Record, error) {
	record, err := s.record(id)
	if err != nil {
		return Record{}, err
	}
	if record.State != StateRemote || record.URL == "" {
		return Record{}, ErrNotFound
	}
	return record, nil
}

// Sent returns an already completed outgoing attachment. It exists only for
// retry convergence after Tencent accepted a file but the local caller did not
// receive the response. Incoming attachments must never be reused as if the
// Agent had sent them.
func (s *Store) Sent(id string) (Record, error) {
	record, err := s.Remote(id)
	if err != nil {
		return Record{}, err
	}
	if record.Direction != DirectionOutgoing {
		return Record{}, ErrNotSent
	}
	return record, nil
}

func (s *Store) record(id string) (Record, error) {
	if !validID(id) {
		return Record{}, ErrNotFound
	}
	var record Record
	if err := s.state.Read(recordPath(id), &record); err != nil {
		if os.IsNotExist(err) {
			return Record{}, ErrNotFound
		}
		return Record{}, err
	}
	if record.ID != id || (record.State != StatePending && record.State != StateRemote) ||
		(record.Direction != DirectionOutgoing && record.Direction != DirectionIncoming) ||
		record.State == StatePending && record.Direction != DirectionOutgoing {
		return Record{}, ErrInvalidAttachment
	}
	return record, nil
}

func normalizedAttachment(value im.Attachment) im.Attachment {
	value.ID = strings.TrimSpace(value.ID)
	value.Filename = strings.TrimSpace(value.Filename)
	value.MIMEType = strings.TrimSpace(value.MIMEType)
	value.URL = strings.TrimSpace(value.URL)
	if value.MIMEType == "" {
		value.MIMEType = "application/octet-stream"
	}
	return value
}

func validRemoteAttachment(value im.Attachment) bool {
	return value.ID != "" && validFilename(value.Filename) &&
		value.MIMEType != "" && value.SizeBytes >= 0 && value.URL != ""
}

func validFilename(value string) bool {
	return value != "" && len([]byte(value)) <= 255 &&
		!strings.ContainsAny(value, "\x00\r\n")
}

func validID(value string) bool {
	if !strings.HasPrefix(value, "att_") || len(value) < 20 || len(value) > 80 {
		return false
	}
	for _, character := range value[4:] {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func recordPath(id string) string {
	return filepath.Join("attachments", "records", id+".json")
}

func pendingPath(id string) string {
	return filepath.Join("attachments", "pending", id+".bin")
}
