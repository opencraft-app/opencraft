//go:build !linux

package main

func main() {
	panic("rescue-uploader must be built for linux")
}
