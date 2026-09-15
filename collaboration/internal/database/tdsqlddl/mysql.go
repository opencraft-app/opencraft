package tdsqlddl

import (
	"fmt"
	"strings"

	"git.woa.com/wisp/mono2/collaboration/internal/database/physicalschema"
)

// WithoutPhysicalSharding preserves the statement body and only removes the
// table storage option. Defaults and comments containing the word are untouched.
func WithoutPhysicalSharding(statement string) (string, error) {
	table, err := ParseCreateTable(statement)
	if err != nil {
		return "", err
	}
	if table.ShardKey == "" {
		return statement, nil
	}
	index := strings.LastIndex(statement, table.Options)
	if index < 0 || table.Options == "" {
		return "", fmt.Errorf("table storage options not found")
	}
	options := strings.TrimSpace(shardKeyOption.ReplaceAllString(table.Options, ""))
	return statement[:index] + options + statement[index+len(table.Options):], nil
}

// CompareMySQL checks the same PK/index/route character contract without
// claiming that a single MySQL instance has a physical shardkey option.
func CompareMySQL(table *Table, spec physicalschema.TableSpec) []Violation {
	if table.ShardKey != "" {
		return []Violation{{Message: "ordinary MySQL table declares physical sharding"}}
	}
	copy := *table
	copy.ShardKey = spec.ShardKey
	return ComparePhysical(&copy, spec)
}
