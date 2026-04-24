// Package client ...
package client

import (
	"time"
)

const (
	// DefaultTimeout ...
	DefaultTimeout = 10 * time.Second
	// DefaultKeepaliveTime ...
	DefaultKeepaliveTime = 30 * time.Second

	// DefaultMaxIdleConnsPerHost ...
	DefaultMaxIdleConnsPerHost = 10
	// DefaultMaxIdleConns ...
	DefaultMaxIdleConns = 100
	// DefaultIdleConnTimeout ...
	DefaultIdleConnTimeout = 10 * time.Second
)

// Config ...
type Config struct {
	Timeout           time.Duration
	KeepAliveTime     time.Duration
	DisableKeepAlives bool

	MaxIdleConnsPerHost int
	MaxIdleConns        int
	IdleConnTimeout     time.Duration
}

// NewConfig ...
func NewConfig() *Config {
	return &Config{
		Timeout:           DefaultTimeout,
		KeepAliveTime:     DefaultKeepaliveTime,
		DisableKeepAlives: false,

		MaxIdleConnsPerHost: DefaultMaxIdleConnsPerHost,
		MaxIdleConns:        DefaultMaxIdleConns,
		IdleConnTimeout:     DefaultIdleConnTimeout,
	}
}
