package eventbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"cloudagent/channelgateway/internal/channel"
)

const inboundMessageField = "message_json"

type RedisStreamsConfig struct {
	Addr          string
	Password      string
	DB            int
	StreamPrefix  string
	ConsumerGroup string
	ConsumerName  string
	ClaimIdle     time.Duration
	ReadBlock     time.Duration
}

type RedisStreamsBus struct {
	client        *redis.Client
	streamPrefix  string
	consumerGroup string
	consumerName  string
	claimIdle     time.Duration
	readBlock     time.Duration
}

func NewRedisStreamsBus(cfg RedisStreamsConfig) (*RedisStreamsBus, error) {
	if strings.TrimSpace(cfg.Addr) == "" {
		return nil, errors.New("redis addr is required")
	}
	streamPrefix := strings.Trim(strings.TrimSpace(cfg.StreamPrefix), ":")
	if streamPrefix == "" {
		streamPrefix = "channelgateway"
	}
	group := strings.TrimSpace(cfg.ConsumerGroup)
	if group == "" {
		group = "channelgateway"
	}
	consumer := strings.TrimSpace(cfg.ConsumerName)
	if consumer == "" {
		consumer = "channelgateway"
	}
	claimIdle := cfg.ClaimIdle
	if claimIdle <= 0 {
		claimIdle = 30 * time.Second
	}
	readBlock := cfg.ReadBlock
	if readBlock <= 0 {
		readBlock = 2 * time.Second
	}
	client := redis.NewClient(&redis.Options{
		Addr:     cfg.Addr,
		Password: cfg.Password,
		DB:       cfg.DB,
	})
	return &RedisStreamsBus{
		client:        client,
		streamPrefix:  streamPrefix,
		consumerGroup: group,
		consumerName:  consumer,
		claimIdle:     claimIdle,
		readBlock:     readBlock,
	}, nil
}

func (b *RedisStreamsBus) Close() error {
	if b == nil || b.client == nil {
		return nil
	}
	return b.client.Close()
}

func (b *RedisStreamsBus) PublishInbound(ctx context.Context, msg channel.Message) (string, error) {
	if b == nil || b.client == nil {
		return "", errors.New("redis streams bus is nil")
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return "", err
	}
	stream := b.inboundStream(msg.ChannelAccountID)
	id, err := b.client.XAdd(ctx, &redis.XAddArgs{
		Stream: stream,
		Values: map[string]any{inboundMessageField: string(payload)},
	}).Result()
	if err != nil {
		return "", err
	}
	log.Printf("channelgateway eventbus_trace action=inbound_published stream=%s event_id=%s account_id=%s external_message_id=%s",
		logValue(stream), logValue(id), logValue(msg.ChannelAccountID), logValue(msg.ExternalMessageID))
	return id, nil
}

func (b *RedisStreamsBus) RunInboundConsumers(ctx context.Context, accountID string, workers int, handler channel.InboundHandler) error {
	if b == nil || b.client == nil {
		return errors.New("redis streams bus is nil")
	}
	if handler == nil {
		return errors.New("inbound handler is nil")
	}
	if workers <= 0 {
		workers = 1
	}
	stream := b.inboundStream(accountID)
	if err := b.ensureGroup(ctx, stream); err != nil {
		return err
	}
	errCh := make(chan error, workers)
	for i := 0; i < workers; i++ {
		consumer := fmt.Sprintf("%s-%d", b.consumerName, i)
		go func() {
			errCh <- b.runInboundConsumer(ctx, stream, consumer, handler)
		}()
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errCh:
		return err
	}
}

func (b *RedisStreamsBus) runInboundConsumer(ctx context.Context, stream, consumer string, handler channel.InboundHandler) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		claimed, nextID, err := b.client.XAutoClaim(ctx, &redis.XAutoClaimArgs{
			Stream:   stream,
			Group:    b.consumerGroup,
			Consumer: consumer,
			MinIdle:  b.claimIdle,
			Start:    "0-0",
			Count:    16,
		}).Result()
		if err != nil && !isRedisNoGroup(err) {
			return err
		}
		_ = nextID
		if len(claimed) > 0 {
			b.handleInboundMessages(ctx, stream, consumer, handler, claimed)
			continue
		}
		items, err := b.client.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    b.consumerGroup,
			Consumer: consumer,
			Streams:  []string{stream, ">"},
			Count:    16,
			Block:    b.readBlock,
		}).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) {
				continue
			}
			if isRedisNoGroup(err) {
				if ensureErr := b.ensureGroup(ctx, stream); ensureErr != nil {
					return ensureErr
				}
				continue
			}
			return err
		}
		for _, item := range items {
			b.handleInboundMessages(ctx, stream, consumer, handler, item.Messages)
		}
	}
}

func (b *RedisStreamsBus) handleInboundMessages(ctx context.Context, stream, consumer string, handler channel.InboundHandler, messages []redis.XMessage) {
	for _, raw := range messages {
		var msg channel.Message
		value, ok := raw.Values[inboundMessageField]
		if !ok {
			log.Printf("channelgateway eventbus_trace action=inbound_decode_failed stream=%s event_id=%s consumer=%s error=missing_message_json",
				logValue(stream), logValue(raw.ID), logValue(consumer))
			continue
		}
		if err := json.Unmarshal([]byte(fmt.Sprint(value)), &msg); err != nil {
			log.Printf("channelgateway eventbus_trace action=inbound_decode_failed stream=%s event_id=%s consumer=%s error=%s",
				logValue(stream), logValue(raw.ID), logValue(consumer), logValue(err.Error()))
			continue
		}
		if err := handler.HandleInbound(ctx, msg); err != nil {
			log.Printf("channelgateway eventbus_trace action=inbound_handle_failed stream=%s event_id=%s consumer=%s account_id=%s external_message_id=%s error=%s",
				logValue(stream), logValue(raw.ID), logValue(consumer), logValue(msg.ChannelAccountID), logValue(msg.ExternalMessageID), logValue(err.Error()))
			continue
		}
		if err := b.client.XAck(ctx, stream, b.consumerGroup, raw.ID).Err(); err != nil {
			log.Printf("channelgateway eventbus_trace action=inbound_ack_failed stream=%s event_id=%s consumer=%s error=%s",
				logValue(stream), logValue(raw.ID), logValue(consumer), logValue(err.Error()))
			continue
		}
		log.Printf("channelgateway eventbus_trace action=inbound_acked stream=%s event_id=%s consumer=%s account_id=%s external_message_id=%s",
			logValue(stream), logValue(raw.ID), logValue(consumer), logValue(msg.ChannelAccountID), logValue(msg.ExternalMessageID))
	}
}

func (b *RedisStreamsBus) ensureGroup(ctx context.Context, stream string) error {
	err := b.client.XGroupCreateMkStream(ctx, stream, b.consumerGroup, "0").Err()
	if err == nil || strings.Contains(strings.ToUpper(err.Error()), "BUSYGROUP") {
		return nil
	}
	return err
}

func (b *RedisStreamsBus) inboundStream(accountID string) string {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		accountID = "default"
	}
	return b.streamPrefix + ":channel.inbound:" + accountID
}

func isRedisNoGroup(err error) bool {
	return err != nil && strings.Contains(strings.ToUpper(err.Error()), "NOGROUP")
}

func logValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "-"
	}
	value = strings.NewReplacer("\n", "\\n", "\r", "\\r", "\t", "\\t").Replace(value)
	if len(value) > 160 {
		return value[:160] + "...[truncated]"
	}
	return value
}
