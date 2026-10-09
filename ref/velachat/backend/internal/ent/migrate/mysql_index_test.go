package migrate

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/dialect/sql/schema"
	"entgo.io/ent/schema/field"
)

var mysqlSizedType = regexp.MustCompile(`^(?:var)?char\((\d+)\)$`)

func TestMySQL复合索引不超过InnoDB字节上限(t *testing.T) {
	for _, table := range Tables {
		for _, index := range table.Indexes {
			width := 0
			for _, column := range index.Columns {
				columnWidth, err := mysqlIndexWidth(column)
				if err != nil {
					t.Errorf("%s.%s: %v", table.Name, index.Name, err)
					continue
				}
				width += columnWidth
			}
			if width > 3072 {
				t.Errorf("%s.%s 索引宽度 %d > 3072", table.Name, index.Name, width)
			}
		}
	}
}

func mysqlIndexWidth(column *entschema.Column) (int, error) {
	typeName := strings.ToLower(column.SchemaType[dialect.MySQL])
	if matches := mysqlSizedType.FindStringSubmatch(typeName); len(matches) == 2 {
		size, _ := strconv.Atoi(matches[1])
		return int(size * 4), nil
	}
	switch column.Type {
	case field.TypeString, field.TypeEnum:
		size := column.Size
		if size <= 0 {
			size = 255
		}
		return int(size * 4), nil
	case field.TypeBytes:
		if column.Size > 0 {
			return int(column.Size), nil
		}
		return 0, fmt.Errorf("索引二进制列 %s 没有显式长度", column.Name)
	case field.TypeBool:
		return 1, nil
	case field.TypeTime:
		return 8, nil
	default:
		if column.Type.Integer() || column.Type.Float() {
			return 8, nil
		}
		return 0, fmt.Errorf("无法估算索引列 %s 类型 %s", column.Name, column.Type)
	}
}
