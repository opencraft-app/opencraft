package client

import (
	"net/http"
	"testing"

	"ctl/pkg/adapter/client"
	"ctl/test"
)

func init() {
	test.InitTestResource()
}

func TestDo(t *testing.T) {
	c := client.NewClient(client.NewConfig())
	req := &client.Request{
		Method: http.MethodGet,
		Url:    "http://127.0.0.1",
	}

	resp, err := c.Do(test.Context(), req)
	t.Log(err, resp)
}
