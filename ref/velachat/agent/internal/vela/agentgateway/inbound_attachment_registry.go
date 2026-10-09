package agentgateway

import (
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"velachat/agent/internal/vela/im"
)

var errInvalidInboundAttachment = errors.New("inbound attachment capability invalid")

type inboundAttachmentCapability struct {
	View         attachmentView
	RouteID      string
	Target       string
	RuntimeEpoch string
	Reference    im.MessageRef
	Attachment   im.Attachment
	ExpiresAt    time.Time
	key          string
	sequence     uint64
}

type inboundAttachmentRegistry struct {
	mu           sync.Mutex
	runtimeEpoch string
	now          func() time.Time
	ttl          time.Duration
	maximum      int
	random       io.Reader
	sequence     uint64
	byID         map[string]inboundAttachmentCapability
	byKey        map[string]string
}

func newInboundAttachmentRegistry(
	runtimeEpoch string,
	now func() time.Time,
	ttl time.Duration,
	maximum int,
	random io.Reader,
) *inboundAttachmentRegistry {
	return &inboundAttachmentRegistry{
		runtimeEpoch: strings.TrimSpace(runtimeEpoch),
		now:          now,
		ttl:          ttl,
		maximum:      maximum,
		random:       random,
		byID:         make(map[string]inboundAttachmentCapability),
		byKey:        make(map[string]string),
	}
}

func (r *inboundAttachmentRegistry) Remember(
	routeID string,
	target string,
	reference im.MessageRef,
	attachment im.Attachment,
) (inboundAttachmentCapability, error) {
	if r == nil || r.now == nil || r.random == nil || r.ttl <= 0 || r.maximum <= 0 ||
		r.runtimeEpoch == "" || strings.TrimSpace(routeID) == "" ||
		strings.TrimSpace(target) == "" || strings.TrimSpace(reference.MessageID()) == "" ||
		strings.TrimSpace(attachment.ID) == "" || strings.TrimSpace(attachment.Filename) == "" ||
		strings.TrimSpace(attachment.MIMEType) == "" || attachment.SizeBytes < 0 ||
		strings.TrimSpace(attachment.URL) == "" {
		return inboundAttachmentCapability{}, errInvalidInboundAttachment
	}
	key := inboundAttachmentKey(routeID, target, reference, attachment.ID)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evictExpiredLocked()
	if id := r.byKey[key]; id != "" {
		current, ok := r.byID[id]
		if ok {
			r.sequence++
			current.Attachment = attachment
			current.View = attachmentCapabilityView(id, attachment)
			current.ExpiresAt = r.now().Add(r.ttl)
			current.sequence = r.sequence
			r.byID[id] = current
			return current, nil
		}
		delete(r.byKey, key)
	}
	for len(r.byID) >= r.maximum {
		r.evictOldestLocked()
	}
	id, err := r.newIDLocked()
	if err != nil {
		return inboundAttachmentCapability{}, err
	}
	r.sequence++
	capability := inboundAttachmentCapability{
		View:         attachmentCapabilityView(id, attachment),
		RouteID:      strings.TrimSpace(routeID),
		Target:       strings.TrimSpace(target),
		RuntimeEpoch: r.runtimeEpoch,
		Reference:    reference,
		Attachment:   attachment,
		ExpiresAt:    r.now().Add(r.ttl),
		key:          key,
		sequence:     r.sequence,
	}
	r.byID[id] = capability
	r.byKey[key] = id
	return capability, nil
}

func (r *inboundAttachmentRegistry) Lookup(
	id string,
	runtimeEpoch string,
) (inboundAttachmentCapability, bool) {
	if r == nil || strings.TrimSpace(runtimeEpoch) != r.runtimeEpoch {
		return inboundAttachmentCapability{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evictExpiredLocked()
	capability, ok := r.byID[strings.TrimSpace(id)]
	return capability, ok
}

func (r *inboundAttachmentRegistry) Len() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evictExpiredLocked()
	return len(r.byID)
}

func (r *inboundAttachmentRegistry) newIDLocked() (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		value := make([]byte, 16)
		if _, err := io.ReadFull(r.random, value); err != nil {
			return "", err
		}
		id := "attc_" + hex.EncodeToString(value)
		if _, exists := r.byID[id]; !exists {
			return id, nil
		}
	}
	return "", errInvalidInboundAttachment
}

func (r *inboundAttachmentRegistry) evictExpiredLocked() {
	now := r.now()
	for id, capability := range r.byID {
		if !now.Before(capability.ExpiresAt) {
			r.deleteLocked(id, capability)
		}
	}
}

func (r *inboundAttachmentRegistry) evictOldestLocked() {
	oldestID := ""
	var oldest inboundAttachmentCapability
	for id, capability := range r.byID {
		if oldestID == "" || capability.sequence < oldest.sequence {
			oldestID = id
			oldest = capability
		}
	}
	if oldestID != "" {
		r.deleteLocked(oldestID, oldest)
	}
}

func (r *inboundAttachmentRegistry) deleteLocked(
	id string,
	capability inboundAttachmentCapability,
) {
	delete(r.byID, id)
	if r.byKey[capability.key] == id {
		delete(r.byKey, capability.key)
	}
}

func attachmentCapabilityView(id string, attachment im.Attachment) attachmentView {
	return attachmentView{
		ID: id, Filename: attachment.Filename, MIMEType: attachment.MIMEType,
		SizeBytes: attachment.SizeBytes,
	}
}

func inboundAttachmentKey(
	routeID string,
	target string,
	reference im.MessageRef,
	providerAttachmentID string,
) string {
	conversation := reference.Conversation()
	return strings.Join([]string{
		strings.TrimSpace(routeID),
		strings.TrimSpace(target),
		string(conversation.Kind()),
		conversation.PeerUserID(),
		conversation.GroupID(),
		conversation.TopicID(),
		reference.MessageID(),
		strings.TrimSpace(providerAttachmentID),
	}, "\x00")
}
