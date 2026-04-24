// Package util ...
package util

import (
	"database/sql"
	"strings"
)

// SanitizeCommentValue ...
func SanitizeCommentValue(value string) string {
	return strings.NewReplacer(
		"*/", "",
		"/*", "",
		";", "",
		"--", "",
		"'", "",
		"\"", "",
	).Replace(value)
}

// NullStringToPointer 将 sql.NullString 转换为 *string
// 如果 NullString 有效，返回指向其值的指针；否则返回 nil
func NullStringToPointer(ns sql.NullString) *string {
	if ns.Valid {
		value := ns.String
		return &value
	}
	return nil
}
