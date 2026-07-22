package observability

import (
	"go.opentelemetry.io/otel/attribute"
	otellog "go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/sdk/instrumentation"
	"go.opentelemetry.io/otel/sdk/resource"
	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	resourcev1 "go.opentelemetry.io/proto/otlp/resource/v1"
)

func otlpResource(value *resource.Resource, sanitizer *Sanitizer) *resourcev1.Resource {
	if value == nil {
		return &resourcev1.Resource{}
	}
	return &resourcev1.Resource{Attributes: otlpAttributes(value.Attributes(), sanitizer)}
}

func otlpScope(value instrumentation.Scope, sanitizer *Sanitizer) *commonv1.InstrumentationScope {
	return &commonv1.InstrumentationScope{
		Name:       sanitizer.Text(value.Name),
		Version:    sanitizer.Text(value.Version),
		Attributes: otlpAttributes(value.Attributes.ToSlice(), sanitizer),
	}
}

func otlpAttributes(values []attribute.KeyValue, sanitizer *Sanitizer) []*commonv1.KeyValue {
	result := make([]*commonv1.KeyValue, 0, len(values))
	for _, value := range values {
		if !value.Valid() {
			continue
		}
		result = append(result, &commonv1.KeyValue{
			Key:   sanitizer.Text(string(value.Key)),
			Value: otlpAttributeValue(value.Value, sanitizer),
		})
	}
	return result
}

func otlpAttributeValue(value attribute.Value, sanitizer *Sanitizer) *commonv1.AnyValue {
	switch value.Type() {
	case attribute.BOOL:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_BoolValue{BoolValue: value.AsBool()}}
	case attribute.INT64:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_IntValue{IntValue: value.AsInt64()}}
	case attribute.FLOAT64:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_DoubleValue{DoubleValue: value.AsFloat64()}}
	case attribute.STRING:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_StringValue{StringValue: sanitizer.Text(value.AsString())}}
	case attribute.BOOLSLICE:
		return otlpBoolSlice(value.AsBoolSlice())
	case attribute.INT64SLICE:
		return otlpInt64Slice(value.AsInt64Slice())
	case attribute.FLOAT64SLICE:
		return otlpFloat64Slice(value.AsFloat64Slice())
	case attribute.STRINGSLICE:
		return otlpStringSlice(value.AsStringSlice(), sanitizer)
	default:
		return &commonv1.AnyValue{}
	}
}

func otlpLogKeyValues(values []otellog.KeyValue, sanitizer *Sanitizer) []*commonv1.KeyValue {
	result := make([]*commonv1.KeyValue, 0, len(values))
	for _, value := range values {
		if value.Key == "" || value.Value.Empty() {
			continue
		}
		result = append(result, &commonv1.KeyValue{Key: sanitizer.Text(value.Key), Value: otlpLogValue(value.Value, sanitizer)})
	}
	return result
}

func otlpLogValue(value otellog.Value, sanitizer *Sanitizer) *commonv1.AnyValue {
	switch value.Kind() {
	case otellog.KindBool:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_BoolValue{BoolValue: value.AsBool()}}
	case otellog.KindFloat64:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_DoubleValue{DoubleValue: value.AsFloat64()}}
	case otellog.KindInt64:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_IntValue{IntValue: value.AsInt64()}}
	case otellog.KindString:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_StringValue{StringValue: sanitizer.Text(value.AsString())}}
	case otellog.KindBytes:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_BytesValue{BytesValue: value.AsBytes()}}
	case otellog.KindSlice:
		items := value.AsSlice()
		values := make([]*commonv1.AnyValue, 0, len(items))
		for _, item := range items {
			values = append(values, otlpLogValue(item, sanitizer))
		}
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_ArrayValue{ArrayValue: &commonv1.ArrayValue{Values: values}}}
	case otellog.KindMap:
		return &commonv1.AnyValue{Value: &commonv1.AnyValue_KvlistValue{KvlistValue: &commonv1.KeyValueList{Values: otlpLogKeyValues(value.AsMap(), sanitizer)}}}
	default:
		return &commonv1.AnyValue{}
	}
}

func otlpBoolSlice(values []bool) *commonv1.AnyValue {
	items := make([]*commonv1.AnyValue, 0, len(values))
	for _, value := range values {
		items = append(items, &commonv1.AnyValue{Value: &commonv1.AnyValue_BoolValue{BoolValue: value}})
	}
	return &commonv1.AnyValue{Value: &commonv1.AnyValue_ArrayValue{ArrayValue: &commonv1.ArrayValue{Values: items}}}
}

func otlpInt64Slice(values []int64) *commonv1.AnyValue {
	items := make([]*commonv1.AnyValue, 0, len(values))
	for _, value := range values {
		items = append(items, &commonv1.AnyValue{Value: &commonv1.AnyValue_IntValue{IntValue: value}})
	}
	return &commonv1.AnyValue{Value: &commonv1.AnyValue_ArrayValue{ArrayValue: &commonv1.ArrayValue{Values: items}}}
}

func otlpFloat64Slice(values []float64) *commonv1.AnyValue {
	items := make([]*commonv1.AnyValue, 0, len(values))
	for _, value := range values {
		items = append(items, &commonv1.AnyValue{Value: &commonv1.AnyValue_DoubleValue{DoubleValue: value}})
	}
	return &commonv1.AnyValue{Value: &commonv1.AnyValue_ArrayValue{ArrayValue: &commonv1.ArrayValue{Values: items}}}
}

func otlpStringSlice(values []string, sanitizer *Sanitizer) *commonv1.AnyValue {
	items := make([]*commonv1.AnyValue, 0, len(values))
	for _, value := range values {
		items = append(items, &commonv1.AnyValue{Value: &commonv1.AnyValue_StringValue{StringValue: sanitizer.Text(value)}})
	}
	return &commonv1.AnyValue{Value: &commonv1.AnyValue_ArrayValue{ArrayValue: &commonv1.ArrayValue{Values: items}}}
}
