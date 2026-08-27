package shardmanager

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono2/llmgateway/internal/setmanager"
)

type ShardProjection struct {
	ID                           string `json:"id"`
	Name                         string `json:"name"`
	Kind                         string `json:"kind"`
	Endpoint                     string `json:"endpoint,omitempty"`
	RedisEndpoint                string `json:"redis_endpoint,omitempty"`
	SecretName                   string `json:"secret_name,omitempty"`
	RedisDBStart                 int    `json:"redis_db_start"`
	RedisDBLimit                 int    `json:"redis_db_limit"`
	Status                       string `json:"status"`
	MaxSets                      int    `json:"max_sets"`
	AdminSQLMaxOpenConns         int    `json:"admin_sql_max_open_conns"`
	AdminSQLMaxIdleConns         int    `json:"admin_sql_max_idle_conns"`
	AdminSQLMaxLifetimeSeconds   int    `json:"admin_sql_max_lifetime_seconds"`
	TrafficSQLMaxOpenConns       int    `json:"traffic_sql_max_open_conns"`
	TrafficSQLMaxIdleConns       int    `json:"traffic_sql_max_idle_conns"`
	TrafficSQLMaxLifetimeSeconds int    `json:"traffic_sql_max_lifetime_seconds"`
	SubscriptionWriteConcurrency int    `json:"subscription_write_concurrency"`
}

type Control interface {
	ObserveShard(context.Context, ShardProjection) error
}

func ProjectFleetShards(ctx context.Context, control Control, fleet setmanager.LLMFleet) error {
	var projectionErrors []error
	for _, shard := range fleet.Spec.Shards {
		config, err := setmanager.ResolveSetRuntimeConfig(fleet, shard.Name)
		if err != nil {
			projectionErrors = append(projectionErrors, fmt.Errorf("resolve shard %s runtime config: %w", shard.Name, err))
			continue
		}
		status := strings.TrimSpace(shard.Status)
		if status == "" {
			status = "active"
		}
		if err := control.ObserveShard(ctx, ShardProjection{
			ID: shard.Name, Name: shard.Name, Kind: "mysql",
			Endpoint: endpoint(shard.MySQLHost, shard.MySQLPort), RedisEndpoint: endpoint(shard.RedisHost, shard.RedisPort),
			SecretName: shard.SecretName, RedisDBStart: shard.RedisDBStart, RedisDBLimit: shard.RedisDBLimit,
			Status: status, MaxSets: shard.MaxSets,
			AdminSQLMaxOpenConns: config.Admin.MaxOpenConns, AdminSQLMaxIdleConns: config.Admin.MaxIdleConns,
			AdminSQLMaxLifetimeSeconds: config.Admin.MaxLifetimeSeconds,
			TrafficSQLMaxOpenConns:     config.Traffic.MaxOpenConns, TrafficSQLMaxIdleConns: config.Traffic.MaxIdleConns,
			TrafficSQLMaxLifetimeSeconds: config.Traffic.MaxLifetimeSeconds,
			SubscriptionWriteConcurrency: config.SubscriptionWriteConcurrency,
		}); err != nil {
			projectionErrors = append(projectionErrors, fmt.Errorf("observe shard %s: %w", shard.Name, err))
		}
	}
	return errors.Join(projectionErrors...)
}

func endpoint(host, port string) string {
	host = strings.TrimSpace(host)
	port = strings.TrimSpace(port)
	if host == "" || port == "" {
		return host
	}
	return host + ":" + port
}
