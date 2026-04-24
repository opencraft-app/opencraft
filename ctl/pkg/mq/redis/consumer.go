package redis

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"

	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"ctl/pkg/mq"
	"ctl/pkg/resource"
)

type ConsumerConfig struct {
	StreamKey    string
	GroupName    string
	ConsumerName string
}

type consumer struct {
	client *goredis.Client
	config *ConsumerConfig

	processor mq.MessageProcessor

	waitExit atomic.Bool
	waitCh   chan bool
}

func NewConsumer(client *goredis.Client, config *ConsumerConfig) *consumer {
	return &consumer{
		client: client,
		config: config,
		waitCh: make(chan bool),
	}
}

func (c *consumer) SetMessageProcessor(processor mq.MessageProcessor) {
	c.processor = processor
}

func (c *consumer) Start() error {
	err := c.createConsumerGroup()
	if err != nil {
		return fmt.Errorf("createConsumerGroup error: %w", err)
	}

	logger := resource.ZapLogger
	logger.Info("run consumeLoopRoutine")
	go func() {
		c.consumeLoopRoutine()
	}()

	<-c.waitCh
	logger.Info("consumer exit")

	return nil
}

func (c *consumer) Stop() error {
	c.waitExit.Store(true)
	_ = c.client.Close()
	return nil
}

func (c *consumer) createConsumerGroup() error {
	ctx := context.Background()
	_, err := c.client.XGroupCreateMkStream(ctx, c.config.StreamKey, c.config.GroupName, "0").Result()
	if err != nil {
		// BUSYGROUP means the group already exists — safe to ignore.
		if strings.Contains(err.Error(), "BUSYGROUP") {
			return nil
		}
		return fmt.Errorf("XGroupCreateMkStream error: %w", err)
	}
	return nil
}

func (c *consumer) consumeLoopRoutine() {
	logger := resource.ZapLogger
	for {
		message, err := c.readMessage()
		if err != nil {
			logger.Error("readMessage error", zap.Error(err))
			if c.waitExit.Load() {
				logger.Info("wait processor exit")
				_ = c.processor.Wait()
				c.waitCh <- true
				return
			}
		} else {
			logger.Info("process message",
				zap.String("MessageId", message.Id),
				zap.String("Data", string(message.Data)),
			)
			err = c.processor.Process(message)
			if err != nil {
				logger.Error("process message failed, will not ack",
					zap.String("MessageId", message.Id),
					zap.Error(err),
				)
			} else {
				_ = c.ack(message)
			}
		}
	}
}

func (c *consumer) readMessage() (*mq.Message, error) {
	ctx := context.Background()
	streams, err := c.client.XReadGroup(ctx, &goredis.XReadGroupArgs{
		Group:    c.config.GroupName,
		Consumer: c.config.ConsumerName,
		Streams:  []string{c.config.StreamKey, ">"},
		Count:    1,
		Block:    0,
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("client.XReadGroup error: %w", err)
	}

	if len(streams) == 0 || len(streams[0].Messages) == 0 {
		return nil, errors.New("no messages")
	}

	msg := streams[0].Messages[0]
	data, ok := msg.Values["data"]
	if !ok {
		return nil, errors.New("message has no data field")
	}

	return &mq.Message{
		Id:   msg.ID,
		Data: []byte(fmt.Sprint(data)),
	}, nil
}

func (c *consumer) ack(message *mq.Message) error {
	logger := resource.ZapLogger
	logger.Info("ack message",
		zap.String("MessageId", message.Id),
		zap.String("Data", string(message.Data)),
	)

	ctx := context.Background()
	v, err := c.client.XAck(ctx, c.config.StreamKey, c.config.GroupName, message.Id).Result()
	if err != nil {
		logger.Error("ack error", zap.Error(err))
	}
	logger.Info("ack message return",
		zap.String("MessageId", message.Id),
		zap.Int64("Return", v),
	)

	return nil
}
