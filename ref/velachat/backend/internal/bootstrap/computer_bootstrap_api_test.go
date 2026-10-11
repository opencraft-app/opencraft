package bootstrap

import (
	"bytes"
	"crypto/rand"
	"testing"
	"time"
)

func TestComputerBootstrapAPIExposesHandlerAndDedicatedProcessor(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	subsystem, err := NewComputerBootstrapAPI(ComputerBootstrapAPIConfig{
		Database: handle, Registrar: platformTATRegistrar{}, Region: "ap-beijing",
		EncryptionKey: bytes.Repeat([]byte{0x44}, 32), Random: rand.Reader,
		RequestTimeout: time.Second, MaxBodyBytes: 4096,
	})
	if err != nil {
		t.Fatal(err)
	}
	if subsystem == nil || subsystem.Handler == nil || subsystem.Processor == nil {
		t.Fatalf("subsystem = %#v", subsystem)
	}
}
