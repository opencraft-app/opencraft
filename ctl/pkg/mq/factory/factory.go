package factory

import (
	"os"

	goredis "github.com/redis/go-redis/v9"

	"ctl/pkg/config"
	"ctl/pkg/context"
	"ctl/pkg/mq"
	redisMQ "ctl/pkg/mq/redis"
	"ctl/pkg/resource"
)

type MQFactory interface {
	Producer(ctx context.Context) mq.Producer
	Consumer(ctx context.Context) mq.Consumer
}

var DefaultMQFactory MQFactory = new(mqFactory)

type mqFactory struct {
}

func (f *mqFactory) redisClient() *goredis.Client {
	return resource.RedisMQClient
}

func (f *mqFactory) Producer(ctx context.Context) mq.Producer {
	return redisMQ.NewProducer(f.redisClient(),
		&redisMQ.ProducerConfig{
			StreamKey: config.ServerConf.MQConfig.StreamKey,
			MaxLen:    config.ServerConf.MQConfig.MaxLen,
		})
}

func (f *mqFactory) Consumer(ctx context.Context) mq.Consumer {
	name := os.Getenv("POD_NAME")
	if name == "" {
		name, _ = os.Hostname()
	}

	return redisMQ.NewConsumer(f.redisClient(),
		&redisMQ.ConsumerConfig{
			StreamKey:    config.ServerConf.MQConfig.StreamKey,
			GroupName:    config.ServerConf.MQConfig.GroupName,
			ConsumerName: name,
		})
}
