package service

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestEmailBindMagicLinkFlow(t *testing.T) {
	store := NewMemoryStore(StoreOptions{})
	sender := &recordingEmailSender{}
	svc := NewWithStore(store, Options{
		SessionTTL: time.Hour,
		EmailBind: EmailBindConfig{
			Enabled:         true,
			TokenTTL:        30 * time.Minute,
			Cooldown:        time.Minute,
			PublicBaseURL:   "https://api.lightvela.com",
			FrontendBaseURL: "https://lightvela.com",
			Sender:          sender,
		},
	})

	session, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "wechat",
		ProviderSubject: "wx-bind-test",
		Name:            "微信用户",
	})
	if err != nil {
		t.Fatalf("sign in with oauth: %v", err)
	}

	if _, err := svc.RequestEmailBind(context.Background(), session.Token, "bind-me@example.com"); err != nil {
		t.Fatalf("request email bind: %v", err)
	}
	if len(sender.messages) != 1 {
		t.Fatalf("expected one email, got %d", len(sender.messages))
	}
	if !strings.HasPrefix(sender.messages[0].confirmURL, "https://api.lightvela.com/auth/email/bind/confirm?token=") {
		t.Fatalf("unexpected confirm url: %s", sender.messages[0].confirmURL)
	}

	token := strings.TrimPrefix(sender.messages[0].confirmURL, "https://api.lightvela.com/auth/email/bind/confirm?token=")
	user, err := svc.ConfirmEmailBind(context.Background(), token)
	if err != nil {
		t.Fatalf("confirm email bind: %v", err)
	}
	if user.Email != "bind-me@example.com" {
		t.Fatalf("unexpected email: %s", user.Email)
	}
	if !user.EmailVerified {
		t.Fatal("expected email to be verified")
	}
}

func TestEmailBindRejectsAlreadyBoundUser(t *testing.T) {
	store := NewMemoryStore(StoreOptions{})
	svc := NewWithStore(store, Options{
		SessionTTL: time.Hour,
		EmailBind: EmailBindConfig{
			Enabled:       true,
			PublicBaseURL: "https://api.lightvela.com",
			Sender:        &LogEmailSender{},
		},
	})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:     "Alice",
		Email:    "alice@example.com",
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("sign up: %v", err)
	}

	_, err = svc.RequestEmailBind(context.Background(), session.Token, "another@example.com")
	authErr, ok := err.(*Error)
	if !ok || authErr.Code != "email_already_bound" {
		t.Fatalf("expected email_already_bound, got %v", err)
	}
}

type recordingEmailSender struct {
	messages []recordedEmailMessage
}

type recordedEmailMessage struct {
	to         string
	confirmURL string
}

func (s *recordingEmailSender) SendEmailBindMagicLink(_ context.Context, to string, confirmURL string) error {
	s.messages = append(s.messages, recordedEmailMessage{to: to, confirmURL: confirmURL})
	return nil
}
