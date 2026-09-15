// Package tdsqlddl 提供 TDSQL baseline 编译与物理审计共享的受限 DDL 模型。
package tdsqlddl

// Table 是一个受支持的 CREATE TABLE 语句。
type Table struct {
	Name       string
	Columns    []Column
	PrimaryKey []string
	Indexes    []Index
	Options    string
	ShardKey   string
}

// Column 保存列的可比较属性和可重放定义。
type Column struct {
	Name     string
	Type     string
	Nullable bool
	Raw      string
	typeEnd  int
}

// Index 保存普通或唯一二级索引。
type Index struct {
	Name    string
	Unique  bool
	Columns []string
	Raw     string
}

// Violation 描述 DDL 与 PhysicalSchema 的一项差异。
type Violation struct {
	Message string
}

func (v Violation) Error() string { return v.Message }
