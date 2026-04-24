package util

import (
	"flag"
	"testing"
)

// TestCipherEncrypt: go test -v -test.run=TestCipherEncrypt -args a b c
func TestCipherEncrypt(t *testing.T) {
	if !flag.Parsed() {
		flag.Parse()
	}

	argList := flag.Args()
	if len(argList) == 0 {
		t.Skip("manual utility test: provide args to run")
	}

	for _, arg := range argList {
		crypted := EncryptString(arg)
		t.Log("crypted", arg, crypted)
	}
}

// TestCipherDecrypt: go test -v -test.run=TestCipherDecrypt -args a b c
func TestCipherDecrypt(t *testing.T) {
	if !flag.Parsed() {
		flag.Parse()
	}

	argList := flag.Args()
	if len(argList) == 0 {
		t.Skip("manual utility test: provide args to run")
	}

	for _, arg := range argList {
		uncrypted := DecryptString(arg)
		t.Log("uncrypted", uncrypted)
	}
}
