// Package messageindex persists only bounded Tencent IM routing references.
// It deliberately never accepts or stores message bodies.
package messageindex

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	rootstate "velachat/agent/internal/state"
	"velachat/agent/internal/vela/im"
)

const indexRelativePath = "im/message-refs-v1.json"

var (
	ErrInvalidConfig = errors.New("消息引用索引配置无效")
	ErrInvalidEntry  = errors.New("消息引用无效")
	ErrNotFound      = errors.New("消息引用不存在")
	ErrAmbiguous     = errors.New("消息引用前缀不唯一")
)

type Entry struct {
	Target string
	Ref    im.MessageRef
}

type persistedIndex struct {
	Version int              `json:"version"`
	Entries []persistedEntry `json:"entries"`
}

type persistedEntry struct {
	Target      string `json:"target"`
	Kind        string `json:"kind"`
	PeerUserID  string `json:"peerUserId,omitempty"`
	GroupID     string `json:"groupId,omitempty"`
	TopicID     string `json:"topicId,omitempty"`
	MessageID   string `json:"messageId"`
	Sequence    int64  `json:"sequence"`
	TimestampMS int64  `json:"timestampMs"`
}

type Index struct {
	mu      sync.RWMutex
	store   *rootstate.Store
	maximum int
	entries []Entry
}

func New(root string, maximum int) (*Index, error) {
	if !filepath.IsAbs(root) || maximum <= 0 || maximum > 100_000 {
		return nil, ErrInvalidConfig
	}
	index := &Index{
		store: rootstate.New(filepath.Clean(root)), maximum: maximum,
	}
	var value persistedIndex
	if err := index.store.Read(indexRelativePath, &value); err != nil {
		if os.IsNotExist(err) {
			return index, nil
		}
		return nil, err
	}
	if value.Version != 1 || len(value.Entries) > maximum {
		return nil, ErrInvalidEntry
	}
	index.entries = make([]Entry, 0, len(value.Entries))
	for _, persisted := range value.Entries {
		entry, err := decodeEntry(persisted)
		if err != nil {
			return nil, err
		}
		index.entries = append(index.entries, entry)
	}
	return index, nil
}

func (index *Index) Add(target string, reference im.MessageRef) error {
	if index == nil {
		return ErrInvalidConfig
	}
	target = strings.TrimSpace(target)
	if !validTarget(target) || !reference.Conversation().Valid() ||
		strings.TrimSpace(reference.MessageID()) == "" {
		return ErrInvalidEntry
	}
	entry := Entry{Target: target, Ref: reference}
	index.mu.Lock()
	defer index.mu.Unlock()
	next := make([]Entry, 0, min(index.maximum, len(index.entries)+1))
	for _, existing := range index.entries {
		if existing.Target == target &&
			existing.Ref.MessageID() == reference.MessageID() {
			continue
		}
		next = append(next, existing)
	}
	next = append(next, entry)
	if len(next) > index.maximum {
		next = next[len(next)-index.maximum:]
	}
	if err := index.persist(next); err != nil {
		return err
	}
	index.entries = next
	return nil
}

func (index *Index) Resolve(messageIDOrPrefix, target string) (Entry, error) {
	if index == nil {
		return Entry{}, ErrInvalidConfig
	}
	messageIDOrPrefix = strings.TrimSpace(messageIDOrPrefix)
	target = strings.TrimSpace(target)
	if len(messageIDOrPrefix) < 8 || target != "" && !validTarget(target) {
		return Entry{}, ErrInvalidEntry
	}
	index.mu.RLock()
	defer index.mu.RUnlock()
	var (
		matched Entry
		found   bool
	)
	for _, candidate := range index.entries {
		if target != "" && candidate.Target != target ||
			!strings.HasPrefix(candidate.Ref.MessageID(), messageIDOrPrefix) {
			continue
		}
		if found && (matched.Target != candidate.Target ||
			matched.Ref.MessageID() != candidate.Ref.MessageID()) {
			return Entry{}, ErrAmbiguous
		}
		matched, found = candidate, true
	}
	if !found {
		return Entry{}, ErrNotFound
	}
	return matched, nil
}

func (index *Index) persist(entries []Entry) error {
	value := persistedIndex{Version: 1, Entries: make([]persistedEntry, 0, len(entries))}
	for _, entry := range entries {
		value.Entries = append(value.Entries, encodeEntry(entry))
	}
	return index.store.Write(indexRelativePath, value)
}

func encodeEntry(entry Entry) persistedEntry {
	conversation := entry.Ref.Conversation()
	return persistedEntry{
		Target: entry.Target, Kind: string(conversation.Kind()),
		PeerUserID: conversation.PeerUserID(), GroupID: conversation.GroupID(),
		TopicID: conversation.TopicID(), MessageID: entry.Ref.MessageID(),
		Sequence: entry.Ref.Sequence(), TimestampMS: entry.Ref.TimestampMS(),
	}
}

func decodeEntry(value persistedEntry) (Entry, error) {
	var (
		conversation im.Conversation
		err          error
	)
	switch im.ConversationType(value.Kind) {
	case im.ConversationC2C:
		conversation, err = im.NewC2CConversation(value.PeerUserID)
	case im.ConversationGroup:
		conversation, err = im.NewGroupConversation(value.GroupID)
	case im.ConversationTopic:
		conversation, err = im.NewTopicConversation(value.GroupID, value.TopicID)
	default:
		err = im.ErrInvalidConversation
	}
	if err != nil || !validTarget(value.Target) {
		return Entry{}, ErrInvalidEntry
	}
	reference, err := im.NewMessageRef(
		conversation, value.MessageID, value.Sequence, value.TimestampMS,
	)
	if err != nil {
		return Entry{}, ErrInvalidEntry
	}
	return Entry{Target: value.Target, Ref: reference}, nil
}

func validTarget(value string) bool {
	if len(value) <= 1 || strings.TrimSpace(value) != value {
		return false
	}
	if value[0] == '#' || value[0] == '@' {
		return true
	}
	// Legacy targets are accepted only so existing Vela-mode state remains
	// readable. A directory-backed Vela Gateway never issues these aliases.
	return strings.HasPrefix(value, "c2c:") ||
		strings.HasPrefix(value, "group:") ||
		strings.HasPrefix(value, "topic:")
}
