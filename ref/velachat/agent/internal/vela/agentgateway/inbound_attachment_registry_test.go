package agentgateway

import (
	"bytes"
	"testing"
	"time"

	"velachat/agent/internal/vela/im"
)

func TestInboundAttachmentRegistryReusesHandlesAndBoundsLifetime(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 17, 15, 0, 0, 0, time.UTC)
	random := bytes.NewReader(append(
		bytes.Repeat([]byte{0x11}, 16),
		append(bytes.Repeat([]byte{0x22}, 16), bytes.Repeat([]byte{0x33}, 16)...)...,
	))
	registry := newInboundAttachmentRegistry(
		"launch-1", func() time.Time { return now }, time.Hour, 2, random,
	)
	conversation, err := im.NewTopicConversation("group-1", "topic-1")
	if err != nil {
		t.Fatal(err)
	}
	firstRef, err := im.NewMessageRef(conversation, "message-1", 1, now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	first, err := registry.Remember(
		"channel-1", "#general", firstRef,
		im.Attachment{
			ID: "provider-image-1", Filename: "image.png", MIMEType: "image/png",
			SizeBytes: 3, URL: "https://image.rich.my-imcloud.com/one.png?token=old",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	secondRef, err := im.NewMessageRef(conversation, "message-2", 2, now.Add(time.Second).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	second, err := registry.Remember(
		"channel-1", "#general", secondRef,
		im.Attachment{
			ID: "provider-image-2", Filename: "image-2.png", MIMEType: "image/png",
			SizeBytes: 3, URL: "https://image.rich.my-imcloud.com/two.png",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Minute)
	rotated, err := registry.Remember(
		"channel-1", "#general", firstRef,
		im.Attachment{
			ID: "provider-image-1", Filename: "image.png", MIMEType: "image/png",
			SizeBytes: 3, URL: "https://image.rich.my-imcloud.com/one.png?token=new",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if first.View.ID == "" || first.View.ID[:5] != "attc_" || rotated.View.ID != first.View.ID {
		t.Fatalf("same attachment handles = %#v %#v", first.View, rotated.View)
	}
	if want := now.Add(time.Hour); !rotated.ExpiresAt.Equal(want) {
		t.Fatalf("refreshed capability expiry = %v, want %v", rotated.ExpiresAt, want)
	}
	resolved, ok := registry.Lookup(first.View.ID, "launch-1")
	if !ok || resolved.Attachment.URL != "https://image.rich.my-imcloud.com/one.png?token=new" {
		t.Fatalf("rotated capability = (%#v, %v)", resolved, ok)
	}
	if _, ok := registry.Lookup(first.View.ID, "launch-2"); ok {
		t.Fatal("capability crossed runtime epoch")
	}

	thirdRef, err := im.NewMessageRef(conversation, "message-3", 3, now.Add(2*time.Second).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Remember(
		"channel-1", "#general", thirdRef,
		im.Attachment{
			ID: "provider-image-3", Filename: "image-3.png", MIMEType: "image/png",
			SizeBytes: 3, URL: "https://image.rich.my-imcloud.com/three.png",
		},
	); err != nil {
		t.Fatal(err)
	}
	if _, ok := registry.Lookup(second.View.ID, "launch-1"); ok {
		t.Fatal("least recently observed capability survived capacity eviction")
	}
	if _, ok := registry.Lookup(first.View.ID, "launch-1"); !ok {
		t.Fatal("refreshed capability was evicted as stale")
	}
	now = now.Add(2 * time.Hour)
	if registry.Len() != 0 {
		t.Fatalf("expired capability count = %d", registry.Len())
	}
}
