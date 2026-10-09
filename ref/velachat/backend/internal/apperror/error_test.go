package apperror

import (
	"errors"
	"testing"
)

func TestError保留稳定错误码中文消息和Cause(t *testing.T) {
	cause := errors.New("底层错误")
	err := New("DATABASE_OPEN_FAILED", "无法打开数据库", cause)

	if got := CodeOf(err); got != "DATABASE_OPEN_FAILED" {
		t.Fatalf("CodeOf() = %q，期望 DATABASE_OPEN_FAILED", got)
	}
	if got := err.Error(); got != "无法打开数据库" {
		t.Fatalf("Error() = %q，期望只暴露中文消息", got)
	}
	if !errors.Is(err, cause) {
		t.Fatal("errors.Is() 无法找到底层 cause")
	}
}

func TestCodeOf未知错误返回空字符串(t *testing.T) {
	if got := CodeOf(errors.New("普通错误")); got != "" {
		t.Fatalf("CodeOf() = %q，期望空字符串", got)
	}
}

func TestNew拒绝空错误码和空消息(t *testing.T) {
	tests := []struct {
		name    string
		code    string
		message string
	}{
		{name: "空错误码", message: "消息"},
		{name: "空消息", code: "TEST_ERROR"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := New(tt.code, tt.message, nil); err != nil {
				t.Fatalf("New() = %#v，期望 nil", err)
			}
		})
	}
}
