package processor

import (
	"os"
	"path/filepath"
	"testing"

	"ctl/pkg/mq"
	"ctl/pkg/resource"
	"ctl/pkg/taskruntime/common"
	"ctl/test"
)

func init() {
	dir, _ := os.Getwd()
	for i := 0; i < 4; i++ {
		dir = filepath.Dir(dir)
	}
	test.InitTestResource()

	pfMap[taskNameDemo] = prepareDemoTask
}

func TestProcessor(t *testing.T) {
	data, _ := common.GenerateMessageData(test.Context(), taskNameDemo, "task-abcd1234",
		&demoTaskIn{
			Name:         "test processor",
			SleepSeconds: 3,
		})
	p := NewProcessor(resource.ZapLogger)
	err := p.Process(&mq.Message{
		Id:   "demo-id",
		Data: data,
	})
	t.Log(err)

	_ = p.Wait()
}
