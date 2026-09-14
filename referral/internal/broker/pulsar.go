package broker

import (
	"context"
	"fmt"
	"strings"

	"github.com/apache/pulsar-client-go/pulsar"
)

type Message interface {
	Payload() []byte
}

type Consumer interface {
	Receive(context.Context) (Message, error)
	Ack(Message) error
	Nack(Message)
	Close()
}

type PulsarConsumer struct {
	client   pulsar.Client
	consumer pulsar.Consumer
}

type pulsarMessage struct {
	pulsar.Message
}

func (m pulsarMessage) Payload() []byte { return m.Message.Payload() }

func NewPulsarConsumer(url, token, topic, subscription, deadLetterTopic string) (*PulsarConsumer, error) {
	client, err := pulsar.NewClient(pulsar.ClientOptions{
		URL:            strings.TrimSpace(url),
		Authentication: pulsar.NewAuthenticationToken(strings.TrimSpace(token)),
	})
	if err != nil {
		return nil, fmt.Errorf("create Pulsar client: %w", err)
	}
	options := pulsar.ConsumerOptions{
		Topic:            strings.TrimSpace(topic),
		SubscriptionName: strings.TrimSpace(subscription),
		Type:             pulsar.Shared,
	}
	if dlq := strings.TrimSpace(deadLetterTopic); dlq != "" {
		options.DLQ = &pulsar.DLQPolicy{MaxDeliveries: 10, DeadLetterTopic: dlq}
	}
	consumer, err := client.Subscribe(options)
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("subscribe Pulsar topic: %w", err)
	}
	return &PulsarConsumer{client: client, consumer: consumer}, nil
}

func (c *PulsarConsumer) Receive(ctx context.Context) (Message, error) {
	message, err := c.consumer.Receive(ctx)
	if err != nil {
		return nil, err
	}
	return pulsarMessage{Message: message}, nil
}

func (c *PulsarConsumer) Ack(message Message) error {
	wrapped, ok := message.(pulsarMessage)
	if !ok {
		return fmt.Errorf("unexpected Pulsar message type %T", message)
	}
	return c.consumer.Ack(wrapped.Message)
}

func (c *PulsarConsumer) Nack(message Message) {
	if wrapped, ok := message.(pulsarMessage); ok {
		c.consumer.Nack(wrapped.Message)
	}
}

func (c *PulsarConsumer) Close() {
	if c == nil {
		return
	}
	if c.consumer != nil {
		c.consumer.Close()
	}
	if c.client != nil {
		c.client.Close()
	}
}
