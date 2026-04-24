// Package util ...
package util

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ListFilesInDir ...
func ListFilesInDir(dir, pattern string) ([]string, error) {
	file, err := os.Open(dir)
	if err != nil {
		return nil, fmt.Errorf("os.Open error: %w", err)
	}
	defer func() {
		_ = file.Close()
	}()

	fis, err := file.Readdir(-1)
	if err != nil {
		return nil, fmt.Errorf("file.Readdir error: %w", err)
	}

	var result []string
	for _, fi := range fis {
		path := dir + "/" + fi.Name()
		if !fi.IsDir() {
			matched, _ := filepath.Match(pattern, filepath.Base(path))
			if matched {
				result = append(result, path)
			}
		}
	}

	return result, nil
}

// Sha256 ...
func Sha256(s string) string {
	b := sha256.Sum256([]byte(s))
	return hex.EncodeToString(b[:])
}

// StringSliceToInterfaceSlice ...
func StringSliceToInterfaceSlice(list []string) []interface{} {
	result := make([]interface{}, len(list))
	for i, v := range list {
		result[i] = v
	}
	return result
}

// Contains ...
func Contains[T comparable](list []T, value T) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}

	return false
}

// Value 返回指针指向的值，如果指针为 nil，则返回类型的零值
func Value[T any](ptr *T) T {
	if ptr == nil {
		var zero T
		return zero
	}

	return *ptr
}

// Pointer 返回指向 value 的指针
func Pointer[T any](value T) *T {
	return &value
}

// RepeatValues 生成重复值的切片
func RepeatValues[T any](value T, count int) []T {
	result := make([]T, count)
	for i := range result {
		result[i] = value
	}
	return result
}

// WhereInPlaceholders 生成 IN 查询的占位符
func WhereInPlaceholders(count int) string {
	return strings.Join(RepeatValues("?", count), ",")
}

// HasDuplicate 检测切片中是否有重复值，第一个返回值表示是否有重复，如果有重复，则第二个返回首次遇到的重复的值
func HasDuplicate[T comparable](slice []T) (bool, *T) {
	if len(slice) == 0 {
		return false, nil
	}

	seen := make(map[T]bool)
	for _, item := range slice {
		if seen[item] {
			return true, &item
		}
		seen[item] = true
	}

	return false, nil
}
