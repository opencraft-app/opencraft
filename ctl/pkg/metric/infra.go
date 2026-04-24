// Package metric 提供基础设施层（DB/Redis 连接池）的 Prometheus 指标
package metric

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

// DBPoolCollector 通过 GORM 的 sql.DB Stats() 暴露 DB 连接池指标
type DBPoolCollector struct {
	db *gorm.DB

	maxOpen      *prometheus.Desc
	open         *prometheus.Desc
	inUse        *prometheus.Desc
	idle         *prometheus.Desc
	waitTotal    *prometheus.Desc
	waitDuration *prometheus.Desc
}

// NewDBPoolCollector 创建 DB 连接池 Collector
func NewDBPoolCollector(db *gorm.DB) *DBPoolCollector {
	if db == nil {
		panic("NewDBPoolCollector: db cannot be nil")
	}
	return &DBPoolCollector{
		db: db,
		maxOpen: prometheus.NewDesc(
			"openclaw_db_pool_max_open",
			"Maximum number of open connections to the database",
			nil, nil,
		),
		open: prometheus.NewDesc(
			"openclaw_db_pool_open",
			"Number of established connections (in-use + idle)",
			nil, nil,
		),
		inUse: prometheus.NewDesc(
			"openclaw_db_pool_in_use",
			"Number of connections currently in use",
			nil, nil,
		),
		idle: prometheus.NewDesc(
			"openclaw_db_pool_idle",
			"Number of idle connections",
			nil, nil,
		),
		waitTotal: prometheus.NewDesc(
			"openclaw_db_pool_wait_total",
			"Total number of connections waited for",
			nil, nil,
		),
		waitDuration: prometheus.NewDesc(
			"openclaw_db_pool_wait_duration_seconds_total",
			"Total time blocked waiting for a new connection",
			nil, nil,
		),
	}
}

// Describe 实现 prometheus.Collector 接口
func (c *DBPoolCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.maxOpen
	ch <- c.open
	ch <- c.inUse
	ch <- c.idle
	ch <- c.waitTotal
	ch <- c.waitDuration
}

// Collect 实现 prometheus.Collector 接口，零 SQL 查询开销
func (c *DBPoolCollector) Collect(ch chan<- prometheus.Metric) {
	sqlDB, err := c.db.DB()
	if err != nil {
		ch <- prometheus.NewInvalidMetric(c.maxOpen, err)
		return
	}

	stats := sqlDB.Stats()
	ch <- prometheus.MustNewConstMetric(c.maxOpen, prometheus.GaugeValue, float64(stats.MaxOpenConnections))
	ch <- prometheus.MustNewConstMetric(c.open, prometheus.GaugeValue, float64(stats.OpenConnections))
	ch <- prometheus.MustNewConstMetric(c.inUse, prometheus.GaugeValue, float64(stats.InUse))
	ch <- prometheus.MustNewConstMetric(c.idle, prometheus.GaugeValue, float64(stats.Idle))
	ch <- prometheus.MustNewConstMetric(c.waitTotal, prometheus.CounterValue, float64(stats.WaitCount))
	ch <- prometheus.MustNewConstMetric(c.waitDuration, prometheus.CounterValue, stats.WaitDuration.Seconds())
}

// RedisPoolCollector 通过 go-redis 的 PoolStats() 暴露 Redis 连接池指标
type RedisPoolCollector struct {
	clients map[string]*redis.Client // key: client 名称（如 "main"、"mq"）

	hitsTotal     *prometheus.Desc
	missesTotal   *prometheus.Desc
	timeoutsTotal *prometheus.Desc
	totalConns    *prometheus.Desc
	idleConns     *prometheus.Desc
	staleConns    *prometheus.Desc
}

// NewRedisPoolCollector 创建 Redis 连接池 Collector
// clients 为 map[string]*redis.Client，key 用于标签区分（如 main/mq）
func NewRedisPoolCollector(clients map[string]*redis.Client) *RedisPoolCollector {
	return &RedisPoolCollector{
		clients: clients,
		hitsTotal: prometheus.NewDesc(
			"openclaw_redis_pool_hits_total",
			"Total number of times a free connection was found in the pool",
			[]string{"client"}, nil,
		),
		missesTotal: prometheus.NewDesc(
			"openclaw_redis_pool_misses_total",
			"Total number of times a free connection was NOT found in the pool",
			[]string{"client"}, nil,
		),
		timeoutsTotal: prometheus.NewDesc(
			"openclaw_redis_pool_timeouts_total",
			"Total number of times a wait timeout occurred",
			[]string{"client"}, nil,
		),
		totalConns: prometheus.NewDesc(
			"openclaw_redis_pool_total_conns",
			"Total number of connections in the pool",
			[]string{"client"}, nil,
		),
		idleConns: prometheus.NewDesc(
			"openclaw_redis_pool_idle_conns",
			"Total number of idle connections in the pool",
			[]string{"client"}, nil,
		),
		staleConns: prometheus.NewDesc(
			"openclaw_redis_pool_stale_conns",
			"Total number of stale connections removed from the pool",
			[]string{"client"}, nil,
		),
	}
}

// Describe 实现 prometheus.Collector 接口
func (c *RedisPoolCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.hitsTotal
	ch <- c.missesTotal
	ch <- c.timeoutsTotal
	ch <- c.totalConns
	ch <- c.idleConns
	ch <- c.staleConns
}

// Collect 实现 prometheus.Collector 接口
func (c *RedisPoolCollector) Collect(ch chan<- prometheus.Metric) {
	for name, client := range c.clients {
		if client == nil {
			continue
		}
		stats := client.PoolStats()
		ch <- prometheus.MustNewConstMetric(c.hitsTotal, prometheus.CounterValue, float64(stats.Hits), name)
		ch <- prometheus.MustNewConstMetric(c.missesTotal, prometheus.CounterValue, float64(stats.Misses), name)
		ch <- prometheus.MustNewConstMetric(c.timeoutsTotal, prometheus.CounterValue, float64(stats.Timeouts), name)
		ch <- prometheus.MustNewConstMetric(c.totalConns, prometheus.GaugeValue, float64(stats.TotalConns), name)
		ch <- prometheus.MustNewConstMetric(c.idleConns, prometheus.GaugeValue, float64(stats.IdleConns), name)
		ch <- prometheus.MustNewConstMetric(c.staleConns, prometheus.CounterValue, float64(stats.StaleConns), name)
	}
}

// 确保接口实现
var _ prometheus.Collector = (*DBPoolCollector)(nil)
var _ prometheus.Collector = (*RedisPoolCollector)(nil)
