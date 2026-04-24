package service

import (
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	"github.com/google/uuid"
)

var testUserEncKey = []byte("01234567890123456789012345678901")

func TestUserService_CRUD(t *testing.T) {
	repo := newMockUserRepo()
	svc := NewUserService(repo, nil, testUserEncKey)

	// Create
	user := &model.User{
		UserID:   "usr_test_123",
		Nickname: "test",
		Status:   model.UserStatusActive,
	}
	if err := svc.SetPhoneFields(user, "13800138000"); err != nil {
		t.Fatalf("set phone fields: %v", err)
	}
	err := svc.Create(user)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if user.ID == uuid.Nil {
		t.Error("expected user ID to be set")
	}

	// GetByID
	got, err := svc.GetByID(user.ID)
	if err != nil {
		t.Fatalf("get by id: %v", err)
	}
	if got.PhoneMasked != "138****8000" {
		t.Errorf("wrong phone masked, got %s", got.PhoneMasked)
	}
	if got.PhoneHash != crypto.HashPhone("13800138000") {
		t.Error("wrong phone hash")
	}

	// GetByPhone
	got, err = svc.GetByPhone("13800138000")
	if err != nil {
		t.Fatalf("get by phone: %v", err)
	}
	if got.ID != user.ID {
		t.Error("wrong user")
	}

	// GetByUserID
	got, err = svc.GetByUserID("usr_test_123")
	if err != nil {
		t.Fatalf("get by user_id: %v", err)
	}
	if got.ID != user.ID {
		t.Error("wrong user")
	}

	// Update
	user.Nickname = "updated"
	err = svc.Update(user)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	got, _ = svc.GetByID(user.ID)
	if got.Nickname != "updated" {
		t.Error("nickname not updated")
	}

	// SoftDelete
	err = svc.SoftDelete(user.ID)
	if err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	got, _ = svc.GetByID(user.ID)
	if got.Status != model.UserStatusDeleted {
		t.Error("user should be deleted")
	}
}

func TestUserService_NotFound(t *testing.T) {
	repo := newMockUserRepo()
	svc := NewUserService(repo, nil, testUserEncKey)

	_, err := svc.GetByID(uuid.New())
	if err != model.ErrUserNotFound {
		t.Errorf("expected ErrUserNotFound, got %v", err)
	}
}

func TestUserService_EnsureUserCreatesSyntheticUser(t *testing.T) {
	repo := newMockUserRepo()
	svc := NewUserService(repo, nil, testUserEncKey)

	user, result, err := svc.EnsureUser("usr_new_pass_holder", "")
	if err != nil {
		t.Fatalf("ensure user: %v", err)
	}
	if result != EnsureUserResultCreated {
		t.Fatalf("expected result %q, got %q", EnsureUserResultCreated, result)
	}
	if user.UserID != "usr_new_pass_holder" {
		t.Fatalf("expected user_id to be preserved, got %q", user.UserID)
	}
	if user.Nickname != "usr_new_pass_holder" {
		t.Fatalf("expected default nickname to fallback to user_id, got %q", user.Nickname)
	}
	if user.PhoneMasked == "" {
		t.Fatal("expected synthetic phone fields to be populated")
	}
}

func TestUserService_EnsureUserIsIdempotentByUserID(t *testing.T) {
	repo := newMockUserRepo()
	svc := NewUserService(repo, nil, testUserEncKey)

	created, result, err := svc.EnsureUser("usr_same_user", "Nick")
	if err != nil {
		t.Fatalf("first ensure user: %v", err)
	}
	if result != EnsureUserResultCreated {
		t.Fatalf("expected first result %q, got %q", EnsureUserResultCreated, result)
	}

	existing, result, err := svc.EnsureUser("usr_same_user", "Ignored")
	if err != nil {
		t.Fatalf("second ensure user: %v", err)
	}
	if result != EnsureUserResultAlreadyExists {
		t.Fatalf("expected second result %q, got %q", EnsureUserResultAlreadyExists, result)
	}
	if existing.ID != created.ID {
		t.Fatalf("expected same user ID on idempotent path, got %s vs %s", existing.ID, created.ID)
	}
	if len(repo.users) != 1 {
		t.Fatalf("expected exactly one stored user, got %d", len(repo.users))
	}
}
