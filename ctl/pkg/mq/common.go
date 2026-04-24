// Package mq ...
package mq

// Message ...
type Message struct {
	Id   string
	Data []byte
}

// Producer ...
type Producer interface {
	Send(message *Message) error
}

// MessageProcessor ...
type MessageProcessor interface {
	Process(message *Message) error
	Wait() error
}

// Consumer ...
type Consumer interface {
	Start() error
	Stop() error
	SetMessageProcessor(processor MessageProcessor)
}
