// Package apperror 提供可以稳定映射到 CLI 和未来 HTTP 的应用错误。
package apperror

import (
	"errors"
	"strings"
)

// Error 是带稳定机器码、中文消息和可展开 cause 的应用错误。
type Error struct {
	code    string
	message string
	cause   error
}

// New 创建应用错误。错误码或消息为空时返回 nil，避免产生无法识别的半成品错误。
func New(code, message string, cause error) *Error {
	code = strings.TrimSpace(code)
	message = strings.TrimSpace(message)
	if code == "" || message == "" {
		return nil
	}
	return &Error{code: code, message: message, cause: cause}
}

// Error 只返回可安全展示的人类消息，不拼接可能包含敏感信息的底层错误。
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

// Unwrap 允许诊断代码通过 errors.Is/errors.As 访问底层错误。
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// Code 返回稳定机器错误码。
func (e *Error) Code() string {
	if e == nil {
		return ""
	}
	return e.code
}

// CodeOf 从错误链中读取应用错误码；未知错误返回空字符串。
func CodeOf(err error) string {
	var target *Error
	if !errors.As(err, &target) {
		return ""
	}
	return target.Code()
}
