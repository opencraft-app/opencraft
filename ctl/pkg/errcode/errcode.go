// Package errcode 提供统一的业务错误码定义
package errcode

import "fmt"

// Error 是业务错误，Code 使用全局唯一字符串作为机器可读标识。
type Error struct {
	Code       string // 机器可读错误码（如 "INSTANCE_NOT_FOUND"）
	Message    string // 人类可读描述
	HTTPStatus int    // HTTP 状态码（如 403）
}

// Error 实现 error 接口
func (e *Error) Error() string {
	return e.Message
}

// Is 支持 errors.Is 判断
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	if !ok {
		return false
	}
	return e.Code == t.Code
}

var registeredErrors = map[string]*Error{}

// New 创建业务错误
func New(code string, httpStatus int, message string) *Error {
	return &Error{
		Code:       code,
		Message:    message,
		HTTPStatus: httpStatus,
	}
}

// Register 注册全局业务错误，要求 code 唯一。
func Register(err *Error) *Error {
	if err == nil {
		panic("errcode: cannot register nil error")
	}
	if err.Code == "" {
		panic("errcode: cannot register empty code")
	}
	if existing, ok := registeredErrors[err.Code]; ok {
		panic(fmt.Sprintf("errcode: duplicate code %s (%q vs %q)", err.Code, existing.Message, err.Message))
	}
	registeredErrors[err.Code] = err
	return err
}

// RegisteredErrors returns all registered sentinel errors.
func RegisteredErrors() []*Error {
	result := make([]*Error, 0, len(registeredErrors))
	for _, err := range registeredErrors {
		result = append(result, err)
	}
	return result
}

// Wrap 包装业务错误并附加上下文
func Wrap(err *Error, format string, args ...interface{}) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), err)
}

// 通用错误
var (
	ErrInternalServer   = Register(New("INTERNAL_SERVER_ERROR", 500, "internal server error"))
	ErrInvalidParam     = Register(New("INVALID_PARAMETER", 400, "invalid parameter"))
	ErrUnauthorized     = Register(New("UNAUTHORIZED", 401, "unauthorized"))
	ErrForbidden        = Register(New("FORBIDDEN", 403, "forbidden"))
	ErrNotFound         = Register(New("NOT_FOUND", 404, "resource not found"))
	ErrMethodNotAllowed = Register(New("METHOD_NOT_ALLOWED", 405, "method not allowed"))
	ErrFailedOperation  = Register(New("FAILED_OPERATION", 500, "operation failed"))
)
