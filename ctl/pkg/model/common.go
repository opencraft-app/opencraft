// Package model ...
package model

import (
	"reflect"
	"strings"
)

const (
	gormColumnTag = "gorm"
)

// GetGormColumnName extracts the column name from the gorm struct tag.
func GetGormColumnName(field *reflect.StructField) string {
	tag := field.Tag.Get(gormColumnTag)
	if tag == "" {
		return ""
	}
	for _, part := range strings.Split(tag, ";") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "column:") {
			return strings.TrimPrefix(part, "column:")
		}
	}
	return ""
}

// MakeGormUpdateMap builds a map[string]interface{} from a params struct.
// Nil pointer fields are skipped, non-nil pointer fields are dereferenced.
// Uses the "gorm" column tag for map keys.
func MakeGormUpdateMap(params interface{}) map[string]interface{} {
	result := make(map[string]interface{})

	rev := reflect.ValueOf(params).Elem()
	ret := rev.Type()
	for i := 0; i < rev.NumField(); i++ {
		revf := rev.Field(i)
		if revf.Kind() == reflect.Ptr {
			if revf.IsNil() {
				continue
			}
			revf = revf.Elem()
		}
		retf := ret.Field(i)
		colName := GetGormColumnName(&retf)
		if colName == "" {
			continue
		}
		result[colName] = revf.Interface()
	}

	return result
}
