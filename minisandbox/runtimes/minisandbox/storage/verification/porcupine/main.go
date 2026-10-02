package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"time"

	"github.com/anishathalye/porcupine"
)

type recordedOperation struct {
	ClientID int    `json:"client_id"`
	Kind     string `json:"kind"`
	Value    uint64 `json:"value"`
	Output   uint64 `json:"output"`
	Call     int64  `json:"call"`
	Return   int64  `json:"return"`
}

type registerInput struct {
	Kind  string
	Value uint64
}

var registerModel = porcupine.Model{
	Init: func() interface{} { return uint64(0) },
	Step: func(state, input, output interface{}) (bool, interface{}) {
		current := state.(uint64)
		operation := input.(registerInput)
		observed := output.(uint64)
		switch operation.Kind {
		case "write":
			return observed == 0, operation.Value
		case "discard":
			return observed == 0, uint64(0)
		case "read":
			return observed == current, current
		case "flush":
			return observed == 0, current
		default:
			return false, current
		}
	},
	Equal: func(first, second interface{}) bool {
		return first.(uint64) == second.(uint64)
	},
	Hash: func(state interface{}) uint64 { return state.(uint64) },
	DescribeOperation: func(input, output interface{}) string {
		operation := input.(registerInput)
		if operation.Kind == "write" {
			return fmt.Sprintf("write(%d)", operation.Value)
		}
		if operation.Kind == "read" {
			return fmt.Sprintf("read() -> %d", output.(uint64))
		}
		return operation.Kind
	},
}

func main() {
	historyPath := flag.String("history", "", "JSON history emitted by the Rust repository test")
	timeout := flag.Duration("timeout", 30*time.Second, "maximum Porcupine decision time")
	flag.Parse()

	if *historyPath == "" {
		fail(errors.New("--history is required"))
	}
	operations, err := readHistory(*historyPath)
	if err != nil {
		fail(err)
	}
	result := porcupine.CheckOperationsTimeout(registerModel, operations, *timeout)
	if result != porcupine.Ok {
		fail(fmt.Errorf("real history result is %s, want %s", result, porcupine.Ok))
	}

	mutated := append([]porcupine.Operation(nil), operations...)
	mutationApplied := false
	for index := len(mutated) - 1; index >= 0; index-- {
		input := mutated[index].Input.(registerInput)
		if input.Kind == "read" {
			mutated[index].Output = uint64(math.MaxUint64)
			mutationApplied = true
			break
		}
	}
	if !mutationApplied {
		fail(errors.New("history has no read to mutate"))
	}
	mutationResult := porcupine.CheckOperationsTimeout(registerModel, mutated, *timeout)
	if mutationResult != porcupine.Illegal {
		fail(fmt.Errorf("mutated history result is %s, want %s", mutationResult, porcupine.Illegal))
	}

	fmt.Printf("MINISANDBOX_PORCUPINE_OK operations=%d real=%s mutation=%s\n", len(operations), result, mutationResult)
}

func readHistory(path string) ([]porcupine.Operation, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open history: %w", err)
	}
	defer file.Close()

	var recorded []recordedOperation
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&recorded); err != nil {
		return nil, fmt.Errorf("decode history: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("history contains trailing JSON data")
	}
	if len(recorded) == 0 {
		return nil, errors.New("history is empty")
	}

	operations := make([]porcupine.Operation, 0, len(recorded))
	for index, operation := range recorded {
		if operation.ClientID < 0 {
			return nil, fmt.Errorf("operation %d has negative client ID", index)
		}
		if operation.Call <= 0 || operation.Return <= operation.Call {
			return nil, fmt.Errorf("operation %d has invalid interval [%d,%d]", index, operation.Call, operation.Return)
		}
		switch operation.Kind {
		case "write":
			if operation.Value == 0 {
				return nil, fmt.Errorf("operation %d writes reserved zero value", index)
			}
		case "discard", "read", "flush":
			if operation.Value != 0 {
				return nil, fmt.Errorf("operation %d has unexpected input value", index)
			}
		default:
			return nil, fmt.Errorf("operation %d has unknown kind %q", index, operation.Kind)
		}
		operations = append(operations, porcupine.Operation{
			ClientId: operation.ClientID,
			Input: registerInput{
				Kind:  operation.Kind,
				Value: operation.Value,
			},
			Call:   operation.Call,
			Output: operation.Output,
			Return: operation.Return,
		})
	}
	return operations, nil
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "MINISANDBOX_PORCUPINE_FAILED: %v\n", err)
	os.Exit(1)
}
