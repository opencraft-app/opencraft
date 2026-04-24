package redis

import (
	"context"
	"fmt"

	goredis "github.com/redis/go-redis/v9"

	"ctl/pkg/mq"
)

type ProducerConfig struct {
	StreamKey string
	MaxLen    int
}

type producer struct {
	client *goredis.Client
	config *ProducerConfig
}

func NewProducer(client *goredis.Client, config *ProducerConfig) *producer {
	return &producer{
		client: client,
		config: config,
	}
}

func (p *producer) Send(message *mq.Message) error {
	mid := "*"
	if message.Id != "" {
		mid = message.Id
	}

	ctx := context.Background()
	result, err := p.client.XAdd(ctx, &goredis.XAddArgs{
		Stream: p.config.StreamKey,
		MaxLen: int64(p.config.MaxLen),
		Approx: true,
		ID:     mid,
		Values: map[string]interface{}{"data": string(message.Data)},
	}).Result()
	if err != nil {
		return fmt.Errorf("client.XAdd error: %w", err)
	}

	if message.Id == "" {
		message.Id = result
	}

	return nil
}
