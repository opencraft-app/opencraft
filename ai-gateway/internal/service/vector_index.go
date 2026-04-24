package service

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/coder/hnsw"
	"gorm.io/gorm"
)

// VectorIndex 是进程内 HNSW 向量索引，用于语义缓存相似度搜索。
// 使用 CosineDistance 作为距离函数，key 为 UUID 字符串。
type VectorIndex struct {
	mu    sync.RWMutex
	graph *hnsw.Graph[string]
	dims  int // embedding 维度（通常为 1536）
}

// NewVectorIndex 创建一个新的向量索引，使用 CosineDistance。
func NewVectorIndex(dims int) *VectorIndex {
	g := hnsw.NewGraph[string]()
	// NewGraph 已默认设置 CosineDistance，此处显式确认
	g.Distance = hnsw.CosineDistance
	return &VectorIndex{
		graph: g,
		dims:  dims,
	}
}

// Add 线程安全地向索引添加或更新一个节点。
// 若已存在相同 id 的节点，hnsw.Graph.Add 内部会先删除再插入。
func (vi *VectorIndex) Add(id string, vec []float32) {
	vi.mu.Lock()
	defer vi.mu.Unlock()
	if strings.TrimSpace(id) == "" || len(vec) == 0 {
		return
	}
	vi.graph.Add(hnsw.MakeNode(id, vec))
}

// Delete 线程安全地从索引删除指定节点，返回是否实际删除了节点。
func (vi *VectorIndex) Delete(id string) bool {
	vi.mu.Lock()
	defer vi.mu.Unlock()
	return vi.graph.Delete(id)
}

// Search 线程安全地在索引中搜索最近邻，返回最多 topK 个候选节点（含向量值）。
// 若索引为空则返回 nil。
func (vi *VectorIndex) Search(vec []float32, topK int) []hnsw.Node[string] {
	vi.mu.RLock()
	defer vi.mu.RUnlock()
	if vi.graph.Len() == 0 {
		return nil
	}
	return vi.graph.Search(vec, topK)
}

// Len 返回索引中当前节点数。
func (vi *VectorIndex) Len() int {
	vi.mu.RLock()
	defer vi.mu.RUnlock()
	return vi.graph.Len()
}

// Reset 清空并重建一个空图，保留原有维度配置。
func (vi *VectorIndex) Reset() {
	vi.mu.Lock()
	defer vi.mu.Unlock()
	g := hnsw.NewGraph[string]()
	g.Distance = hnsw.CosineDistance
	vi.graph = g
}

// dbVectorRow 是从数据库查询返回的中间结构。
type dbVectorRow struct {
	ID           string `gorm:"column:id"`
	EmbeddingStr string `gorm:"column:embedding_str"`
}

// LoadFromDB 从数据库加载所有未过期的缓存向量，重建内存索引。
// 若加载过程中解析某行失败，该行会被跳过（记录错误但不中断）。
func (vi *VectorIndex) LoadFromDB(ctx context.Context, db *gorm.DB) error {
	// MySQL: embedding 存储为 JSON 数组，使用 JSON_UNQUOTE(JSON_EXTRACT()) 提取
	const query = `
		SELECT CAST(id AS CHAR) AS id,
		       JSON_UNQUOTE(JSON_EXTRACT(embedding, '$')) AS embedding_str
		FROM response_cache
		WHERE expires_at > NOW()`

	var rows []dbVectorRow
	if err := db.WithContext(ctx).Raw(query).Scan(&rows).Error; err != nil {
		return fmt.Errorf("vector_index: 查询 response_cache 失败: %w", err)
	}

	// 重建图
	vi.mu.Lock()
	defer vi.mu.Unlock()

	g := hnsw.NewGraph[string]()
	g.Distance = hnsw.CosineDistance
	vi.graph = g

	for _, row := range rows {
		if row.EmbeddingStr == "" || row.EmbeddingStr == "null" {
			continue
		}
		vec, err := parseFloat4ArrayStr(row.EmbeddingStr, vi.dims)
		if err != nil {
			// 跳过无效行，不中断整个加载流程
			continue
		}
		vi.graph.Add(hnsw.MakeNode(row.ID, vec))
	}

	return nil
}

// parseFloat4ArrayStr 将逗号分隔的浮点数字符串（如 "0.1,0.2,0.3"）解析为 []float32。
// dims 用于预分配切片容量；若实际元素数量与 dims 不符，仍正常返回（不强制校验）。
func parseFloat4ArrayStr(s string, dims int) ([]float32, error) {
	if s == "" {
		return nil, fmt.Errorf("parseFloat4ArrayStr: 输入字符串为空")
	}
	parts := strings.Split(s, ",")
	result := make([]float32, 0, dims)
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		v, err := strconv.ParseFloat(p, 32)
		if err != nil {
			return nil, fmt.Errorf("parseFloat4ArrayStr: 无法解析 %q: %w", p, err)
		}
		result = append(result, float32(v))
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("parseFloat4ArrayStr: 解析结果为空")
	}
	return result, nil
}

// float32SliceToJSONArray 将 []float32 转为 MySQL JSON 数组字符串，
// 例如："[0.1,0.2,0.3]"
func float32SliceToJSONArray(v []float32) string {
	if len(v) == 0 {
		return "[]"
	}
	var sb strings.Builder
	sb.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(strconv.FormatFloat(float64(f), 'f', -1, 32))
	}
	sb.WriteByte(']')
	return sb.String()
}
