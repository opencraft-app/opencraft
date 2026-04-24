package pulumiutil

import (
	"fmt"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

func StringArray(values []string) pulumi.StringArray {
	out := make(pulumi.StringArray, 0, len(values))
	for _, value := range values {
		out = append(out, pulumi.String(value))
	}
	return out
}

func StringMap(values map[string]string) pulumi.StringMap {
	out := make(pulumi.StringMap, len(values))
	for key, value := range values {
		out[key] = pulumi.String(value)
	}
	return out
}

func HostPort(host pulumi.StringInput, port pulumi.IntPtrInput) pulumi.StringOutput {
	return pulumi.All(host, port).ApplyT(func(args []interface{}) string {
		hostValue := args[0].(string)
		portValue, ok := args[1].(*int)
		if !ok || portValue == nil {
			return hostValue
		}
		return fmt.Sprintf("%s:%d", hostValue, *portValue)
	}).(pulumi.StringOutput)
}

func NullableHostPort(host pulumi.StringPtrInput, port pulumi.IntPtrInput) pulumi.StringOutput {
	return pulumi.All(host, port).ApplyT(func(args []interface{}) string {
		hostValue, ok := args[0].(*string)
		if !ok || hostValue == nil {
			return ""
		}
		portValue, ok := args[1].(*int)
		if !ok || portValue == nil {
			return *hostValue
		}
		return fmt.Sprintf("%s:%d", *hostValue, *portValue)
	}).(pulumi.StringOutput)
}
