package eventbus

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"cloudagent/channelgateway/internal/store"
)

const (
	DriverDatabase = "database"
	DriverRedis    = "redis"
)

type Options struct {
	Driver string

	Store InboundStore
	Lease store.ChannelLease

	RedisAddr          string
	RedisPassword      string
	RedisDB            int
	RedisStreamPrefix  string
	RedisConsumerGroup string
	RedisConsumerName  string
	RedisClaimIdle     time.Duration
	RedisReadBlock     time.Duration

	DatabasePollInterval time.Duration
	InboundStaleAfter    time.Duration
}

func NormalizeDriver(driver string) string {
	switch strings.ToLower(strings.TrimSpace(driver)) {
	case "", "database", "db", "mysql":
		return DriverDatabase
	case "redis", "redis-streams", "redis_streams":
		return DriverRedis
	default:
		return strings.ToLower(strings.TrimSpace(driver))
	}
}

func NewInboundBus(opts Options) (InboundBus, string, error) {
	driver := NormalizeDriver(opts.Driver)
	switch driver {
	case DriverDatabase:
		bus, err := NewDatabaseBus(DatabaseBusConfig{
			Store:        opts.Store,
			Lease:        opts.Lease,
			PollInterval: opts.DatabasePollInterval,
			StaleAfter:   opts.InboundStaleAfter,
		})
		return bus, driver, err
	case DriverRedis:
		bus, err := NewRedisStreamsBus(RedisStreamsConfig{
			Addr:          opts.RedisAddr,
			Password:      opts.RedisPassword,
			DB:            opts.RedisDB,
			StreamPrefix:  opts.RedisStreamPrefix,
			ConsumerGroup: opts.RedisConsumerGroup,
			ConsumerName:  opts.RedisConsumerName,
			ClaimIdle:     opts.RedisClaimIdle,
			ReadBlock:     opts.RedisReadBlock,
		})
		return bus, driver, err
	default:
		return nil, driver, fmt.Errorf("%w: %s", ErrUnsupportedDriver, driver)
	}
}

var ErrUnsupportedDriver = errors.New("unsupported channelgateway event bus driver")
