package tdsqlddl

import (
	"fmt"
	"strings"
	"unicode"
)

// ParseDocument 只接受注释和 CREATE TABLE 语句。
func ParseDocument(source string) ([]*Table, error) {
	statements, err := splitStatements(source)
	if err != nil {
		return nil, err
	}
	tables := make([]*Table, 0, len(statements))
	for _, statement := range statements {
		table, err := ParseCreateTable(statement)
		if err != nil {
			return nil, err
		}
		tables = append(tables, table)
	}
	return tables, nil
}

// ParseCreateTable 解析一条受支持的 MySQL CREATE TABLE。
func ParseCreateTable(statement string) (*Table, error) {
	statement = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(statement), ";"))
	position := 0
	if !consumeKeyword(statement, &position, "CREATE") ||
		!consumeKeyword(statement, &position, "TABLE") {
		return nil, fmt.Errorf("only CREATE TABLE statements are allowed")
	}
	name, next, err := readIdentifier(statement, position)
	if err != nil {
		return nil, fmt.Errorf("read table name: %w", err)
	}
	position = skipSpaces(statement, next)
	if position >= len(statement) || statement[position] != '(' {
		return nil, fmt.Errorf("table %s has no column list", name)
	}
	close, err := matchingParen(statement, position)
	if err != nil {
		return nil, fmt.Errorf("table %s: %w", name, err)
	}
	table := &Table{Name: name, Options: strings.TrimSpace(statement[close+1:])}
	elements, err := splitTopLevel(statement[position+1:close], ',')
	if err != nil {
		return nil, fmt.Errorf("table %s: %w", name, err)
	}
	for _, raw := range elements {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return nil, fmt.Errorf("table %s has empty element", name)
		}
		upper := strings.ToUpper(raw)
		switch {
		case strings.HasPrefix(upper, "PRIMARY KEY"):
			if len(table.PrimaryKey) != 0 {
				return nil, fmt.Errorf("table %s has duplicate primary key", name)
			}
			columns, err := parseIndexColumns(raw)
			if err != nil {
				return nil, err
			}
			table.PrimaryKey = columns
		case strings.HasPrefix(upper, "UNIQUE INDEX") ||
			strings.HasPrefix(upper, "UNIQUE KEY"):
			index, err := parseIndex(raw, true)
			if err != nil {
				return nil, err
			}
			table.Indexes = append(table.Indexes, index)
		case strings.HasPrefix(upper, "INDEX") || strings.HasPrefix(upper, "KEY"):
			index, err := parseIndex(raw, false)
			if err != nil {
				return nil, err
			}
			table.Indexes = append(table.Indexes, index)
		case strings.HasPrefix(upper, "CONSTRAINT") ||
			strings.HasPrefix(upper, "FOREIGN KEY") ||
			strings.HasPrefix(upper, "CHECK"):
			return nil, fmt.Errorf("table %s contains a forbidden constraint", name)
		default:
			column, err := parseColumn(raw)
			if err != nil {
				return nil, fmt.Errorf("table %s: %w", name, err)
			}
			table.Columns = append(table.Columns, column)
		}
	}
	if len(table.Columns) == 0 || len(table.PrimaryKey) == 0 {
		return nil, fmt.Errorf("table %s is missing columns or primary key", name)
	}
	shardKey, count, err := parseShardKey(table.Options)
	if err != nil {
		return nil, fmt.Errorf("table %s: %w", name, err)
	}
	if count > 1 {
		return nil, fmt.Errorf("table %s has duplicate shardkey options", name)
	}
	table.ShardKey = shardKey
	return table, nil
}

func parseColumn(raw string) (Column, error) {
	name, next, err := readIdentifier(raw, 0)
	if err != nil {
		return Column{}, fmt.Errorf("read column name: %w", err)
	}
	start := skipSpaces(raw, next)
	if start >= len(raw) {
		return Column{}, fmt.Errorf("column %s has no type", name)
	}
	depth := 0
	quote := byte(0)
	typeEnd := len(raw)
	for i := start; i < len(raw); i++ {
		current := raw[i]
		if quote != 0 {
			if current == '\\' {
				i++
				continue
			}
			if current == quote {
				if i+1 < len(raw) && raw[i+1] == quote {
					i++
					continue
				}
				quote = 0
			}
			continue
		}
		if current == '\'' || current == '"' || current == '`' {
			quote = current
			continue
		}
		switch current {
		case '(':
			depth++
		case ')':
			depth--
		default:
			if depth == 0 && unicode.IsSpace(rune(current)) {
				typeEnd = i
				i = len(raw)
			}
		}
	}
	typeName := strings.ToLower(strings.TrimSpace(raw[start:typeEnd]))
	if typeName == "" {
		return Column{}, fmt.Errorf("column %s has no type", name)
	}
	tail := strings.ToUpper(raw[typeEnd:])
	return Column{
		Name:     name,
		Type:     typeName,
		Nullable: !strings.Contains(tail, "NOT NULL"),
		Raw:      raw,
		typeEnd:  typeEnd,
	}, nil
}

func parseIndex(raw string, unique bool) (Index, error) {
	position := 0
	if unique && !consumeKeyword(raw, &position, "UNIQUE") {
		return Index{}, fmt.Errorf("invalid unique index")
	}
	if !consumeKeyword(raw, &position, "INDEX") && !consumeKeyword(raw, &position, "KEY") {
		return Index{}, fmt.Errorf("invalid index")
	}
	name, _, err := readIdentifier(raw, position)
	if err != nil {
		return Index{}, fmt.Errorf("read index name: %w", err)
	}
	columns, err := parseIndexColumns(raw)
	if err != nil {
		return Index{}, err
	}
	return Index{Name: name, Unique: unique, Columns: columns, Raw: raw}, nil
}

func parseIndexColumns(raw string) ([]string, error) {
	open := firstParen(raw)
	if open < 0 {
		return nil, fmt.Errorf("index has no column list")
	}
	close, err := matchingParen(raw, open)
	if err != nil {
		return nil, err
	}
	parts, err := splitTopLevel(raw[open+1:close], ',')
	if err != nil {
		return nil, err
	}
	columns := make([]string, 0, len(parts))
	for _, part := range parts {
		name, _, err := readIdentifier(strings.TrimSpace(part), 0)
		if err != nil {
			return nil, fmt.Errorf("read index column: %w", err)
		}
		columns = append(columns, name)
	}
	return columns, nil
}

func splitStatements(source string) ([]string, error) {
	cleaned, err := stripComments(source)
	if err != nil {
		return nil, err
	}
	parts, err := splitTopLevel(cleaned, ';')
	if err != nil {
		return nil, err
	}
	statements := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			statements = append(statements, value)
		}
	}
	return statements, nil
}

func stripComments(source string) (string, error) {
	var output strings.Builder
	quote := byte(0)
	for i := 0; i < len(source); i++ {
		current := source[i]
		if quote != 0 {
			output.WriteByte(current)
			if current == '\\' && i+1 < len(source) {
				i++
				output.WriteByte(source[i])
				continue
			}
			if current == quote {
				if i+1 < len(source) && source[i+1] == quote {
					i++
					output.WriteByte(source[i])
					continue
				}
				quote = 0
			}
			continue
		}
		if current == '\'' || current == '"' || current == '`' {
			quote = current
			output.WriteByte(current)
			continue
		}
		if current == '#' || (current == '-' && i+1 < len(source) && source[i+1] == '-') {
			if current == '-' {
				i++
			}
			for i+1 < len(source) && source[i+1] != '\n' {
				i++
			}
			output.WriteByte('\n')
			continue
		}
		if current == '/' && i+1 < len(source) && source[i+1] == '*' {
			i += 2
			for i+1 < len(source) && !(source[i] == '*' && source[i+1] == '/') {
				i++
			}
			if i+1 >= len(source) {
				return "", fmt.Errorf("unterminated block comment")
			}
			i++
			output.WriteByte(' ')
			continue
		}
		output.WriteByte(current)
	}
	if quote != 0 {
		return "", fmt.Errorf("unterminated quoted value")
	}
	return output.String(), nil
}

func splitTopLevel(value string, separator byte) ([]string, error) {
	var parts []string
	start, depth := 0, 0
	quote := byte(0)
	for i := 0; i < len(value); i++ {
		current := value[i]
		if quote != 0 {
			if current == '\\' && i+1 < len(value) {
				i++
				continue
			}
			if current == quote {
				if i+1 < len(value) && value[i+1] == quote {
					i++
					continue
				}
				quote = 0
			}
			continue
		}
		if current == '\'' || current == '"' || current == '`' {
			quote = current
			continue
		}
		switch current {
		case '(':
			depth++
		case ')':
			depth--
			if depth < 0 {
				return nil, fmt.Errorf("unbalanced parentheses")
			}
		default:
			if current == separator && depth == 0 {
				parts = append(parts, value[start:i])
				start = i + 1
			}
		}
	}
	if quote != 0 || depth != 0 {
		return nil, fmt.Errorf("unterminated quote or parentheses")
	}
	parts = append(parts, value[start:])
	return parts, nil
}

func matchingParen(value string, open int) (int, error) {
	depth := 0
	quote := byte(0)
	for i := open; i < len(value); i++ {
		current := value[i]
		if quote != 0 {
			if current == '\\' && i+1 < len(value) {
				i++
				continue
			}
			if current == quote {
				if i+1 < len(value) && value[i+1] == quote {
					i++
					continue
				}
				quote = 0
			}
			continue
		}
		if current == '\'' || current == '"' || current == '`' {
			quote = current
			continue
		}
		if current == '(' {
			depth++
		} else if current == ')' {
			depth--
			if depth == 0 {
				return i, nil
			}
		}
	}
	return -1, fmt.Errorf("unclosed parentheses")
}

func firstParen(value string) int {
	quote := byte(0)
	for i := 0; i < len(value); i++ {
		current := value[i]
		if quote != 0 {
			if current == quote {
				quote = 0
			}
			continue
		}
		if current == '`' || current == '\'' || current == '"' {
			quote = current
		} else if current == '(' {
			return i
		}
	}
	return -1
}

func consumeKeyword(value string, position *int, keyword string) bool {
	start := skipSpaces(value, *position)
	end := start + len(keyword)
	if end > len(value) || !strings.EqualFold(value[start:end], keyword) ||
		(end < len(value) && (unicode.IsLetter(rune(value[end])) || value[end] == '_')) {
		return false
	}
	*position = end
	return true
}

func readIdentifier(value string, position int) (string, int, error) {
	position = skipSpaces(value, position)
	if position >= len(value) {
		return "", position, fmt.Errorf("missing identifier")
	}
	if value[position] == '`' {
		var name strings.Builder
		for i := position + 1; i < len(value); i++ {
			if value[i] == '`' {
				if i+1 < len(value) && value[i+1] == '`' {
					name.WriteByte('`')
					i++
					continue
				}
				if name.Len() == 0 {
					return "", i + 1, fmt.Errorf("empty identifier")
				}
				return name.String(), i + 1, nil
			}
			name.WriteByte(value[i])
		}
		return "", len(value), fmt.Errorf("unterminated identifier")
	}
	end := position
	for end < len(value) && (unicode.IsLetter(rune(value[end])) ||
		unicode.IsDigit(rune(value[end])) || value[end] == '_') {
		end++
	}
	if end == position {
		return "", position, fmt.Errorf("invalid identifier")
	}
	return value[position:end], end, nil
}

func skipSpaces(value string, position int) int {
	for position < len(value) && unicode.IsSpace(rune(value[position])) {
		position++
	}
	return position
}
