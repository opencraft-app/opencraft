package config

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func init() {
	err := Init(os.Getenv("CONF_DIR"))
	if err != nil {
		fmt.Println("Init error: ", err.Error())
	}
}

func TestConf(t *testing.T) {
	pretty, _ := json.MarshalIndent(ServerConf, "", "    ")
	t.Log(string(pretty))
}
