package schema

// ShardKey 描述未来 TDSQL 物理路由字段。
// SQLite 迁移会保留该元数据，但不会把它转换成 DDL。
type ShardKey struct {
	Field string `json:"field"`
}

// Name 实现 Ent schema.Annotation。
func (ShardKey) Name() string {
	return "ChatserverShardKey"
}
