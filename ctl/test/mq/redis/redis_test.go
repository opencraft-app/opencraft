package redis

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"ctl/pkg/mq"
	"ctl/pkg/mq/factory"
	"ctl/pkg/taskruntime/common"
	"ctl/test"
)

func init() {
	test.InitTestResource()
}

type messageData struct {
	Name  string
	Value int
}

type demoProcessor struct {
}

func (p *demoProcessor) Process(message *mq.Message) error {
	fmt.Println(message.Id, string(message.Data))

	msg := new(common.TaskMessage)
	err := json.Unmarshal(message.Data, msg)
	fmt.Println(err, msg.TraceId, msg.TaskName, string(msg.Data))

	return nil
}

func (p *demoProcessor) Wait() error {
	fmt.Println("demo wait start")
	time.Sleep(time.Second * 3)
	fmt.Println("demo wait end")

	return nil
}

func TestProducer(t *testing.T) {
	producer := factory.DefaultMQFactory.Producer(test.Context())

	msg := new(mq.Message)
	msg.Data, _ = json.Marshal(&messageData{
		Name:  "test-mq",
		Value: 10,
	})
	err := producer.Send(msg)

	t.Log(err, msg.Id)
}

func TestConsumer(t *testing.T) {
	consumer := factory.DefaultMQFactory.Consumer(test.Context())
	consumer.SetMessageProcessor(new(demoProcessor))

	go func() {
		time.Sleep(time.Second * 5)
		err := consumer.Stop()
		t.Log("consumer.Stop", err)
	}()

	err := consumer.Start()
	t.Log("consumer.Start", err)
}
