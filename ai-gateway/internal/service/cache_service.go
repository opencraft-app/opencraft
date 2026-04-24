package service

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"github.com/coder/hnsw"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const cacheVectorBroadcastChannel = "cache:vector:broadcast"

type cacheVectorBroadcastEvent struct {
	Source    string    `json:"source"`
	ID        string    `json:"id"`
	Embedding []float32 `json:"embedding"`
}

type CachedResponse struct {
	ID               uuid.UUID
	Response         []byte
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	Similarity       float64
}

type StoreParams struct {
	Model            string
	ScopeKey         string
	ContentHash      string
	Embedding        []float32
	Response         []byte
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	TTLSeconds       int
}

type CacheStats struct {
	TotalHits    int64   `json:"total_hits"`
	TotalMisses  int64   `json:"total_misses"`
	HitRate      float64 `json:"hit_rate"`
	TokensSaved  int64   `json:"tokens_saved"`
	CacheEntries int64   `json:"cache_entries"`
	TodayHits    int64   `json:"today_hits"`
	TodayMisses  int64   `json:"today_misses"`
}

type CacheService struct {
	db           *gorm.DB
	redis        *redisclient.Client
	configStore  *CacheConfigStore
	vectorIndex  *VectorIndex
	activeWrites atomic.Int64

	instanceID string
	subCtx     context.Context
	subCancel  context.CancelFunc
}

func NewCacheService(db *gorm.DB, redis *redisclient.Client, configStore *CacheConfigStore, dims int) *CacheService {
	if dims <= 0 {
		dims = 1536
	}
	ctx, cancel := context.WithCancel(context.Background())
	svc := &CacheService{
		db:          db,
		redis:       redis,
		configStore: configStore,
		vectorIndex: NewVectorIndex(dims),
		instanceID:  uuid.NewString(),
		subCtx:      ctx,
		subCancel:   cancel,
	}

	if redis != nil {
		go svc.subscribeVectorBroadcast()
	}
	return svc
}

func (s *CacheService) LoadIndex(ctx context.Context) {
	if err := s.vectorIndex.LoadFromDB(ctx, s.db); err != nil {
		slog.Error("启动时加载向量索引失败，缓存搜索将降级", "error", err)
	}
}

func (s *CacheService) subscribeVectorBroadcast() {
	pubsub := s.redis.Subscribe(s.subCtx, cacheVectorBroadcastChannel)
	defer pubsub.Close()

	ch := pubsub.Channel()
	for {
		select {
		case <-s.subCtx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			var ev cacheVectorBroadcastEvent
			if err := json.Unmarshal([]byte(msg.Payload), &ev); err != nil {
				continue
			}
			if ev.Source == s.instanceID || ev.ID == "" || len(ev.Embedding) == 0 {
				continue
			}
			s.vectorIndex.Add(ev.ID, ev.Embedding)
		}
	}
}

func (s *CacheService) IsEnabled() bool        { return s.configStore.Get().Enabled }
func (s *CacheService) GetConfig() CacheConfig { return s.configStore.Get() }

func (s *CacheService) SearchSimilar(ctx context.Context, model, scopeKey string, embedding []float32, threshold float64) (*CachedResponse, float64, error) {
	const topK = 10
	candidates := s.vectorIndex.Search(embedding, topK)
	if len(candidates) == 0 {
		return nil, 0, nil
	}

	candidateIDs := make([]string, len(candidates))
	for i, node := range candidates {
		candidateIDs[i] = node.Key
	}

	type dbResult struct {
		ID               string `gorm:"column:id"`
		Response         []byte `gorm:"column:response"`
		PromptTokens     int    `gorm:"column:prompt_tokens"`
		CompletionTokens int    `gorm:"column:completion_tokens"`
		TotalTokens      int    `gorm:"column:total_tokens"`
	}
	var dbRows []dbResult
	err := s.db.WithContext(ctx).Raw(`
        SELECT CAST(id AS CHAR) AS id, response, prompt_tokens, completion_tokens, total_tokens
        FROM response_cache
        WHERE CAST(id AS CHAR) IN ?
          AND model = ?
          AND scope_key = ?
          AND expires_at > NOW()
    `, candidateIDs, model, scopeKey).Scan(&dbRows).Error
	if err != nil {
		return nil, 0, fmt.Errorf("批量查询缓存数据失败: %w", err)
	}
	if len(dbRows) == 0 {
		return nil, 0, nil
	}

	idToVec := make(map[string][]float32, len(candidates))
	for _, node := range candidates {
		idToVec[node.Key] = node.Value
	}

	var bestResult *CachedResponse
	var bestSimilarity float64
	for _, row := range dbRows {
		vec, ok := idToVec[row.ID]
		if !ok {
			continue
		}
		similarity := 1.0 - float64(hnsw.CosineDistance(embedding, vec))
		if similarity < threshold || similarity <= bestSimilarity {
			continue
		}
		decompressed, err := gzipDecompress(row.Response)
		if err != nil {
			continue
		}
		id, _ := uuid.Parse(row.ID)
		bestResult = &CachedResponse{ID: id, Response: decompressed, PromptTokens: row.PromptTokens, CompletionTokens: row.CompletionTokens, TotalTokens: row.TotalTokens, Similarity: similarity}
		bestSimilarity = similarity
	}
	if bestResult == nil {
		return nil, 0, nil
	}

	go func(id uuid.UUID) { s.db.Exec("UPDATE response_cache SET hit_count = hit_count + 1 WHERE id = ?", id) }(bestResult.ID)
	return bestResult, bestSimilarity, nil
}

func (s *CacheService) Store(ctx context.Context, params StoreParams) error {
	s.activeWrites.Add(1)
	defer s.activeWrites.Add(-1)

	cfg := s.configStore.Get()
	if len(params.Response) > cfg.MaxResponseBytes {
		return nil
	}

	compressed, err := gzipCompress(params.Response)
	if err != nil {
		return fmt.Errorf("gzip 压缩失败: %w", err)
	}

	embeddingArr := float32SliceToJSONArray(params.Embedding)
	ttl := params.TTLSeconds
	if ttl == 0 {
		ttl = cfg.TTLSeconds
	}
	expiresAt := time.Now().Add(time.Duration(ttl) * time.Second)

	recordID := uuid.NewString()
	err = s.db.WithContext(ctx).Raw(`
        INSERT INTO response_cache
            (id, model, scope_key, content_hash, embedding, response, prompt_tokens, completion_tokens, total_tokens, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            embedding = VALUES(embedding), response = VALUES(response),
            prompt_tokens = VALUES(prompt_tokens), completion_tokens = VALUES(completion_tokens),
            total_tokens = VALUES(total_tokens), expires_at = VALUES(expires_at)
    `, recordID, params.Model, params.ScopeKey, params.ContentHash, embeddingArr, compressed,
		params.PromptTokens, params.CompletionTokens, params.TotalTokens, expiresAt,
	).Error
	if err != nil {
		var row struct{ ID string }
		if err2 := s.db.WithContext(ctx).Raw(`
            SELECT CAST(id AS CHAR) AS id FROM response_cache
            WHERE model = ? AND scope_key = ? AND content_hash = ?
		`, params.Model, params.ScopeKey, params.ContentHash).Scan(&row).Error; err2 != nil {
			return fmt.Errorf("缓存写入失败: %w", err)
		}
		recordID = row.ID
	}

	if strings.TrimSpace(recordID) == "" {
		return fmt.Errorf("缓存写入失败: empty record id")
	}

	defer func() {
		if r := recover(); r != nil {
			slog.Error("向量索引写入失败", "panic", r, "cache_id", recordID)
		}
	}()
	s.vectorIndex.Add(recordID, params.Embedding)
	if s.redis != nil {
		ev := cacheVectorBroadcastEvent{Source: s.instanceID, ID: recordID, Embedding: params.Embedding}
		if data, mErr := json.Marshal(ev); mErr == nil {
			_ = s.redis.Publish(context.Background(), cacheVectorBroadcastChannel, data).Err()
		}
	}

	go s.evictIfNeeded(cfg.MaxCacheEntries)
	return nil
}

func (s *CacheService) evictIfNeeded(maxEntries int) {
	var count int64
	s.db.Raw("SELECT COUNT(*) FROM response_cache").Scan(&count)
	if count <= int64(maxEntries) {
		return
	}

	evictCount := int64(maxEntries) / 10
	if evictCount < 1 {
		evictCount = 1
	}

	var idsToDelete []struct{ ID string }
	s.db.Raw(`
        SELECT CAST(id AS CHAR) AS id FROM response_cache
        ORDER BY hit_count ASC, created_at ASC
        LIMIT ?
    `, evictCount).Scan(&idsToDelete)
	if len(idsToDelete) == 0 {
		return
	}

	idList := make([]string, len(idsToDelete))
	for i, row := range idsToDelete {
		idList[i] = row.ID
	}
	s.db.Exec("DELETE FROM response_cache WHERE id IN ?", idList)
	for _, id := range idList {
		s.vectorIndex.Delete(id)
	}
}

func (s *CacheService) CleanExpired() {
	var idsToDelete []struct{ ID string }
	s.db.Raw(`
        SELECT CAST(id AS CHAR) AS id FROM response_cache
        WHERE expires_at < NOW()
    `).Scan(&idsToDelete)
	if len(idsToDelete) == 0 {
		return
	}

	idList := make([]string, len(idsToDelete))
	for i, row := range idsToDelete {
		idList[i] = row.ID
	}
	s.db.Exec("DELETE FROM response_cache WHERE id IN ?", idList)
	for _, id := range idList {
		s.vectorIndex.Delete(id)
	}
}

func (s *CacheService) ClearAll(ctx context.Context) error {
	if err := s.db.WithContext(ctx).Exec("TRUNCATE TABLE response_cache").Error; err != nil {
		return err
	}
	s.vectorIndex.Reset()
	return nil
}

func (s *CacheService) GetScopeKey(userID string, requestBody []byte) string {
	cfg := s.configStore.Get()
	switch cfg.ScopeMode {
	case CacheScopeUser:
		if userID != "" {
			return userID
		}
		return "anonymous"
	case CacheScopeSystemPrompt:
		systemPrompt := extractSystemPrompt(requestBody)
		if systemPrompt != "" {
			hash := sha256.Sum256([]byte(systemPrompt))
			return fmt.Sprintf("%x", hash[:16])
		}
		return "no-system-prompt"
	case CacheScopeGlobal:
		return "global"
	default:
		if userID != "" {
			return userID
		}
		return "anonymous"
	}
}

func (s *CacheService) RecordHit(tokensSaved int) {
	ctx := context.Background()
	today := time.Now().UTC().Format("2006-01-02")
	s.redis.IncrBy(ctx, "cache:stats:hits", 1)
	s.redis.IncrWithTTL(ctx, "cache:stats:hits:"+today, 48*time.Hour)
	s.incrBy(ctx, "cache:stats:tokens_saved", int64(tokensSaved))
}

func (s *CacheService) RecordMiss() {
	ctx := context.Background()
	today := time.Now().UTC().Format("2006-01-02")
	s.redis.IncrBy(ctx, "cache:stats:misses", 1)
	s.redis.IncrWithTTL(ctx, "cache:stats:misses:"+today, 48*time.Hour)
}

func (s *CacheService) Stats(ctx context.Context) (*CacheStats, error) {
	stats := &CacheStats{}
	stats.TotalHits = s.getCounter(ctx, "cache:stats:hits")
	stats.TotalMisses = s.getCounter(ctx, "cache:stats:misses")
	stats.TokensSaved = s.getCounter(ctx, "cache:stats:tokens_saved")

	today := time.Now().UTC().Format("2006-01-02")
	stats.TodayHits = s.getCounter(ctx, "cache:stats:hits:"+today)
	stats.TodayMisses = s.getCounter(ctx, "cache:stats:misses:"+today)

	total := stats.TotalHits + stats.TotalMisses
	if total > 0 {
		stats.HitRate = float64(stats.TotalHits) / float64(total) * 100
	}

	s.db.WithContext(ctx).Raw("SELECT COUNT(*) FROM response_cache").Scan(&stats.CacheEntries)
	return stats, nil
}

func (s *CacheService) incrBy(ctx context.Context, key string, delta int64) {
	s.redis.IncrBy(ctx, key, delta)
}

func (s *CacheService) getCounter(ctx context.Context, key string) int64 {
	val, err := s.redis.Get(ctx, key)
	if err != nil {
		return 0
	}
	n, _ := strconv.ParseInt(val, 10, 64)
	return n
}

func extractSystemPrompt(body []byte) string {
	var req struct {
		Messages []struct {
			Role    string      `json:"role"`
			Content interface{} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return ""
	}
	for _, msg := range req.Messages {
		if msg.Role == "system" {
			return extractTextFromContent(msg.Content)
		}
	}
	return ""
}

func ExtractCacheText(body []byte) string {
	var req struct {
		Messages []struct {
			Role    string      `json:"role"`
			Content interface{} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return ""
	}

	var systemPrompt, lastUserMsg string
	for _, msg := range req.Messages {
		switch msg.Role {
		case "system":
			systemPrompt = extractTextFromContent(msg.Content)
		case "user":
			lastUserMsg = extractTextFromContent(msg.Content)
		}
	}

	if systemPrompt != "" && lastUserMsg != "" {
		return systemPrompt + "\n" + lastUserMsg
	}
	if lastUserMsg != "" {
		return lastUserMsg
	}
	return systemPrompt
}

func extractTextFromContent(content interface{}) string {
	switch v := content.(type) {
	case string:
		return v
	case []interface{}:
		return extractTextFromBlocks(v)
	default:
		return ""
	}
}

func extractTextFromBlocks(blocks []interface{}) string {
	var parts []string
	for _, item := range blocks {
		block, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if block["type"] == "text" {
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "")
}

func ContentHash(model, scopeKey, cacheText string) string {
	data := model + "|" + scopeKey + "|" + cacheText
	hash := sha256.Sum256([]byte(data))
	return fmt.Sprintf("%x", hash)
}

func gzipCompress(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(data); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func gzipDecompress(data []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}

func (s *CacheService) Shutdown(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for s.activeWrites.Load() > 0 && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if s.subCancel != nil {
		s.subCancel()
	}
}
