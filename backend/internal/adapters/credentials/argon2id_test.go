package credentials

import (
	"context"
	"strings"
	"testing"
)

func TestArgon2idHashesAndVerifiesPassword(t *testing.T) {
	hasher, err := NewArgon2id(Argon2idConfig{
		MemoryKiB:   8 * 1024,
		Iterations:  1,
		Parallelism: 1,
		SaltLength:  16,
		KeyLength:   32,
	})
	if err != nil {
		t.Fatal(err)
	}

	first, err := hasher.Hash(context.Background(), "正确的密码-123")
	if err != nil {
		t.Fatalf("Hash() error = %v", err)
	}
	second, err := hasher.Hash(context.Background(), "正确的密码-123")
	if err != nil {
		t.Fatalf("Hash() second error = %v", err)
	}
	if !strings.HasPrefix(first, "$argon2id$v=19$") {
		t.Fatalf("Hash() = %q", first)
	}
	if first == second {
		t.Fatal("相同密码使用了相同 salt")
	}
	if strings.Contains(first, "正确的密码") {
		t.Fatal("摘要泄漏密码明文")
	}
	ok, err := hasher.Verify(context.Background(), first, "正确的密码-123")
	if err != nil || !ok {
		t.Fatalf("Verify(correct) = %v, %v", ok, err)
	}
	ok, err = hasher.Verify(context.Background(), first, "错误密码")
	if err != nil || ok {
		t.Fatalf("Verify(wrong) = %v, %v", ok, err)
	}
}

func TestArgon2idRejectsMalformedHashAndCanceledContext(t *testing.T) {
	hasher, err := NewArgon2id(TestArgon2idConfig())
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := hasher.Verify(context.Background(), "not-phc", "password"); err == nil || ok {
		t.Fatalf("Verify(malformed) = %v, %v", ok, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := hasher.Hash(ctx, "password-123"); err == nil {
		t.Fatal("Hash(canceled) returned nil")
	}
	if err := hasher.DummyVerify(ctx, "password-123"); err == nil {
		t.Fatal("DummyVerify(canceled) returned nil")
	}
}

func TestArgon2idRejectsUnsafeConfig(t *testing.T) {
	if _, err := NewArgon2id(Argon2idConfig{}); err == nil {
		t.Fatal("NewArgon2id(empty config) returned nil")
	}
}
