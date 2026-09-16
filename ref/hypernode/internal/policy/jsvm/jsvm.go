// Package goja is Hypernode's engine-neutral JavaScript host ABI.
//
// The package name intentionally remains goja while callers migrate away from
// importing the third-party Goja module.  Its implementation is QuickJS-NG via
// quickjs-go; policy host code depends only on this small compatibility surface.
package goja

import (
	"encoding/json"
	"fmt"
	"reflect"
	"runtime/debug"
	"sync"
	"time"
	"unicode/utf16"

	quickjs "github.com/buke/quickjs-go"
)

const propertyFlags = quickjs.PropConfigurable | quickjs.PropWritable | quickjs.PropEnumerable

type Runtime struct {
	runtime  *quickjs.Runtime
	context  *quickjs.Context
	identity *quickjs.Value
	valuesMu sync.Mutex
	values   map[*value]struct{}
}

type Value interface {
	String() string
	Export() any
	ToObject(*Runtime) *Object
	rawValue() *quickjs.Value
	Free()
}

type value struct {
	runtime *Runtime
	raw     *quickjs.Value
	freed   bool
}

// undefinedValue is the engine-independent equivalent of Goja's package-level
// Undefined sentinel. It intentionally has no QuickJS reference; marshal turns
// it into a fresh JS_UNDEFINED owned by the destination runtime.
type undefinedValue struct{}

func (undefinedValue) String() string            { return "undefined" }
func (undefinedValue) Export() any               { return nil }
func (undefinedValue) ToObject(*Runtime) *Object { return nil }
func (undefinedValue) rawValue() *quickjs.Value  { return nil }
func (undefinedValue) Free()                     {}

type Object struct{ *value }

type FunctionCall struct {
	This      Value
	Arguments []Value
}

func (c FunctionCall) Argument(index int) Value {
	if index < 0 || index >= len(c.Arguments) {
		if c.This != nil {
			return c.This.(*value).runtime.Undefined()
		}
		return nil
	}
	return c.Arguments[index]
}

type Symbol string

const SymIterator Symbol = "iterator"

type PromiseState int

const (
	PromiseStatePending PromiseState = iota
	PromiseStateFulfilled
	PromiseStateRejected
)

type Promise struct{ value Value }

func New() *Runtime {
	// Engine access is serialized by policy.Engine. QuickJS itself does not
	// require goroutine affinity, only that a context is never entered
	// concurrently; disabling the binding's diagnostic owner check permits the
	// serialized owner to move between Go scheduler goroutines.
	rt := quickjs.NewRuntime(quickjs.WithOwnerGoroutineCheck(false))
	context := rt.NewBareContext()
	return &Runtime{
		runtime:  rt,
		context:  context,
		identity: context.Eval("(value) => value"),
		values:   make(map[*value]struct{}),
	}
}

func (r *Runtime) Close() error {
	if r == nil || r.runtime == nil {
		return nil
	}
	// Host objects can intentionally retain themselves (for example
	// createHash().update() returns the same object). Goja let the Go collector
	// discover those cycles; QuickJS requires every embedding-owned JSValue to
	// be released before JS_FreeRuntime. Keep ownership in the adapter so callers
	// cannot accidentally make engine shutdown unsafe.
	r.valuesMu.Lock()
	values := make([]*value, 0, len(r.values))
	for item := range r.values {
		values = append(values, item)
	}
	r.valuesMu.Unlock()
	for _, item := range values {
		item.Free()
	}
	if r.identity != nil {
		r.identity.Free()
		r.identity = nil
	}
	r.context.Close()
	r.runtime.RunGC()
	r.runtime.Close()
	r.context = nil
	r.runtime = nil
	return nil
}

func (r *Runtime) NewObject() *Object {
	return &Object{r.own(r.context.NewObject())}
}

func (r *Runtime) NewUint8Array(data []byte) Value {
	return r.wrap(r.context.NewUint8Array(append([]byte(nil), data...)))
}

func (r *Runtime) NewArrayBuffer(data []byte) any {
	return append([]byte(nil), data...)
}

func (r *Runtime) Undefined() Value { return r.wrap(r.context.NewUndefined()) }

func Undefined() Value { return undefinedValue{} }

func (r *Runtime) NewGoError(err error) error { return err }

func (r *Runtime) Set(name string, input any) error {
	return r.setValue(r.context.Globals(), name, input)
}

func (r *Runtime) Get(name string) Value {
	return r.wrap(r.context.Globals().Get(name))
}

func (r *Runtime) ToValue(input any) Value {
	if existing, ok := input.(Value); ok {
		return existing
	}
	raw, err := r.marshal(input)
	if err != nil {
		return r.wrap(r.context.ThrowError(err))
	}
	return r.wrap(raw)
}

func (r *Runtime) RunString(source string) (Value, error) {
	return r.eval(source)
}

func (r *Runtime) RunScript(name, source string) (Value, error) {
	raw := r.context.Eval(source, quickjs.EvalFileName(name))
	return r.evalResult(raw)
}

// Await settles a JavaScript Promise while continuing to drive QuickJS jobs.
// The Go-side timeout bounds promises whose completion depends on external
// events or a dependency graph that never becomes ready.
func (r *Runtime) Await(input Value, timeout time.Duration) (Value, error) {
	if input == nil || input.rawValue() == nil {
		return nil, fmt.Errorf("cannot await nil JavaScript value")
	}
	raw := input.rawValue()
	if raw.IsPromise() {
		deadline := time.Now().Add(timeout)
		for raw.PromiseState() == quickjs.PromisePending {
			r.context.LoopOnce()
			if timeout > 0 && time.Now().After(deadline) {
				return nil, fmt.Errorf("JavaScript Promise did not settle within %s", timeout)
			}
			time.Sleep(time.Millisecond)
		}
	}
	return r.evalResult(input.rawValue().Await())
}

func (r *Runtime) eval(source string) (Value, error) {
	return r.evalResult(r.context.Eval(source))
}

func (r *Runtime) evalResult(raw *quickjs.Value) (Value, error) {
	if raw == nil {
		return nil, fmt.Errorf("QuickJS returned no value")
	}
	if raw.IsException() {
		err := r.context.Exception()
		raw.Free()
		if err == nil {
			err = fmt.Errorf("QuickJS evaluation failed")
		}
		return nil, err
	}
	// QuickJS deliberately leaves Promise jobs to its embedding host. Cordis
	// starts services through microtasks, so every synchronous host entry must
	// reach a microtask checkpoint before returning to Go. LoopOnce drains all
	// currently-runnable jobs without waiting for unresolved host promises;
	// Loop would deadlock the engine mutex against their completion event.
	r.context.LoopOnce()
	return r.wrap(raw), nil
}

func (r *Runtime) ExportTo(input Value, target any) error {
	if input == nil {
		return fmt.Errorf("cannot export nil JavaScript value")
	}
	exported, err := r.exportValue(input.rawValue())
	if err != nil {
		return err
	}
	return assignExport(target, exported)
}

func (r *Runtime) exportValue(raw *quickjs.Value) (any, error) {
	if raw == nil || raw.IsUndefined() || raw.IsNull() {
		return nil, nil
	}
	if raw.IsUint8Array() {
		return raw.ToUint8Array()
	}
	if raw.IsArray() {
		length := int(raw.Len())
		values := make([]any, length)
		for index := 0; index < length; index++ {
			item := raw.GetIdx(int64(index))
			if item == nil {
				continue
			}
			converted, err := r.exportValue(item)
			item.Free()
			if err != nil {
				return nil, err
			}
			values[index] = converted
		}
		return values, nil
	}
	if raw.IsObject() && !raw.IsDate() && !raw.IsError() && !raw.IsFunction() {
		names, err := raw.PropertyNames()
		if err != nil {
			return nil, err
		}
		values := make(map[string]any, len(names))
		for _, name := range names {
			item := raw.Get(name)
			if item == nil {
				continue
			}
			converted, err := r.exportValue(item)
			item.Free()
			if err != nil {
				return nil, err
			}
			values[name] = converted
		}
		return values, nil
	}
	var output any
	if err := r.context.Unmarshal(raw, &output); err != nil {
		return nil, err
	}
	return output, nil
}

func assignExport(target any, input any) error {
	output := reflect.ValueOf(target)
	if output.Kind() != reflect.Pointer || output.IsNil() {
		return fmt.Errorf("export target must be a non-nil pointer")
	}
	return assignValue(output.Elem(), input)
}

func assignValue(target reflect.Value, input any) error {
	if !target.CanSet() {
		return fmt.Errorf("export target is not settable")
	}
	if input == nil {
		target.Set(reflect.Zero(target.Type()))
		return nil
	}
	source := reflect.ValueOf(input)
	if source.Type().AssignableTo(target.Type()) {
		target.Set(source)
		return nil
	}
	if source.Type().ConvertibleTo(target.Type()) && target.Kind() != reflect.String {
		target.Set(source.Convert(target.Type()))
		return nil
	}
	switch target.Kind() {
	case reflect.Interface:
		target.Set(source)
		return nil
	case reflect.Slice:
		if source.Kind() != reflect.Slice && source.Kind() != reflect.Array {
			return fmt.Errorf("cannot export %T to %s", input, target.Type())
		}
		result := reflect.MakeSlice(target.Type(), source.Len(), source.Len())
		for index := 0; index < source.Len(); index++ {
			if err := assignValue(result.Index(index), source.Index(index).Interface()); err != nil {
				return err
			}
		}
		target.Set(result)
		return nil
	case reflect.Map:
		if source.Kind() != reflect.Map {
			return fmt.Errorf("cannot export %T to %s", input, target.Type())
		}
		result := reflect.MakeMapWithSize(target.Type(), source.Len())
		iterator := source.MapRange()
		for iterator.Next() {
			key := reflect.New(target.Type().Key()).Elem()
			if err := assignValue(key, iterator.Key().Interface()); err != nil {
				return err
			}
			value := reflect.New(target.Type().Elem()).Elem()
			if err := assignValue(value, iterator.Value().Interface()); err != nil {
				return err
			}
			result.SetMapIndex(key, value)
		}
		target.Set(result)
		return nil
	case reflect.Struct:
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		return json.Unmarshal(encoded, target.Addr().Interface())
	}
	return fmt.Errorf("cannot export %T to %s", input, target.Type())
}

func (r *Runtime) wrap(raw *quickjs.Value) Value {
	if raw == nil {
		return nil
	}
	return r.own(raw)
}

func (r *Runtime) own(raw *quickjs.Value) *value {
	owned := &value{runtime: r, raw: raw}
	r.valuesMu.Lock()
	r.values[owned] = struct{}{}
	r.valuesMu.Unlock()
	return owned
}

func (r *Runtime) setValue(target *quickjs.Value, name string, input any) error {
	raw, err := r.marshal(input)
	if err != nil {
		return err
	}
	defer raw.Free()
	if !target.DefinePropertyValue(name, raw, propertyFlags) {
		return fmt.Errorf("define JavaScript property %q", name)
	}
	return nil
}

func (r *Runtime) marshal(input any) (*quickjs.Value, error) {
	switch input := input.(type) {
	case nil:
		return r.context.NewNull(), nil
	case Value:
		if input == nil || input.rawValue() == nil {
			return r.context.NewUndefined(), nil
		}
		return r.clone(input.rawValue())
	case *Object:
		return r.clone(input.raw)
	}
	if reflect.TypeOf(input).Kind() == reflect.Func {
		return r.newFunction(input), nil
	}
	return r.marshalReflect(reflect.ValueOf(input))
}

func (r *Runtime) marshalReflect(input reflect.Value) (*quickjs.Value, error) {
	for input.IsValid() && (input.Kind() == reflect.Interface || input.Kind() == reflect.Pointer) {
		if input.IsNil() {
			return r.context.NewNull(), nil
		}
		input = input.Elem()
	}
	if !input.IsValid() {
		return r.context.NewNull(), nil
	}
	switch input.Kind() {
	case reflect.Slice:
		if input.Type().Elem().Kind() == reflect.Uint8 {
			return r.context.NewUint8Array(append([]byte(nil), input.Bytes()...)), nil
		}
		fallthrough
	case reflect.Array:
		array, err := r.context.Marshal([]any{})
		if err != nil {
			return nil, err
		}
		for index := 0; index < input.Len(); index++ {
			item, err := r.marshalReflect(input.Index(index))
			if err != nil {
				array.Free()
				return nil, err
			}
			array.SetInt64(int64(index), item)
			item.Free()
		}
		return array, nil
	case reflect.Map:
		if input.Type().Key().Kind() != reflect.String {
			return r.context.Marshal(input.Interface())
		}
		object := r.context.NewObject()
		iterator := input.MapRange()
		for iterator.Next() {
			item, err := r.marshalReflect(iterator.Value())
			if err != nil {
				object.Free()
				return nil, err
			}
			object.DefinePropertyValue(iterator.Key().String(), item, propertyFlags)
			item.Free()
		}
		return object, nil
	default:
		return r.context.Marshal(input.Interface())
	}
}

func (r *Runtime) newFunction(function any) *quickjs.Value {
	return r.context.NewFunction(func(ctx *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) (result *quickjs.Value) {
		defer func() {
			if recovered := recover(); recovered != nil {
				result = ctx.ThrowError(fmt.Errorf("host callback panic: %v\n%s", recovered, debug.Stack()))
			}
		}()
		result, err := r.invoke(function, this, args)
		if err != nil {
			return ctx.ThrowError(err)
		}
		if result == nil {
			return ctx.NewUndefined()
		}
		return result
	})
}

func (r *Runtime) invoke(function any, this *quickjs.Value, args []*quickjs.Value) (*quickjs.Value, error) {
	typeOf := reflect.TypeOf(function)
	valueOf := reflect.ValueOf(function)
	inputs := make([]reflect.Value, typeOf.NumIn())
	if typeOf.NumIn() == 1 && typeOf.In(0) == reflect.TypeOf(FunctionCall{}) {
		arguments := make([]Value, len(args))
		for index, argument := range args {
			arguments[index] = &value{runtime: r, raw: argument}
		}
		inputs[0] = reflect.ValueOf(FunctionCall{
			This:      &value{runtime: r, raw: this},
			Arguments: arguments,
		})
	} else {
		if !typeOf.IsVariadic() && len(args) > typeOf.NumIn() {
			return nil, fmt.Errorf("host callback received %d arguments, expected %d", len(args), typeOf.NumIn())
		}
		for index := 0; index < typeOf.NumIn(); index++ {
			argumentType := typeOf.In(index)
			if typeOf.IsVariadic() && index == typeOf.NumIn()-1 {
				argumentType = argumentType.Elem()
			}
			if index >= len(args) {
				inputs[index] = reflect.Zero(typeOf.In(index))
				continue
			}
			converted, err := r.convertArgument(args[index], argumentType)
			if err != nil {
				return nil, fmt.Errorf("host callback argument %d: %w", index, err)
			}
			inputs[index] = converted
		}
	}
	outputs := valueOf.Call(inputs)
	if count := len(outputs); count > 0 && typeOf.Out(count-1).Implements(reflect.TypeOf((*error)(nil)).Elem()) {
		if !outputs[count-1].IsNil() {
			return nil, outputs[count-1].Interface().(error)
		}
		outputs = outputs[:count-1]
	}
	switch len(outputs) {
	case 0:
		return r.context.NewUndefined(), nil
	case 1:
		return r.marshalReturn(outputs[0])
	default:
		values := make([]any, len(outputs))
		for index, output := range outputs {
			values[index] = output.Interface()
		}
		return r.context.Marshal(values)
	}
}

func (r *Runtime) convertArgument(raw *quickjs.Value, target reflect.Type) (reflect.Value, error) {
	valueType := reflect.TypeOf((*Value)(nil)).Elem()
	if target.Implements(valueType) {
		return reflect.ValueOf(&value{runtime: r, raw: raw}), nil
	}
	exported, err := r.exportValue(raw)
	if err != nil {
		return reflect.Value{}, err
	}
	converted := reflect.New(target).Elem()
	if err := assignValue(converted, exported); err != nil {
		return reflect.Value{}, err
	}
	return converted, nil
}

func (r *Runtime) marshalReturn(output reflect.Value) (*quickjs.Value, error) {
	if !output.IsValid() || ((output.Kind() == reflect.Pointer || output.Kind() == reflect.Interface) && output.IsNil()) {
		return r.context.NewNull(), nil
	}
	if exported, ok := output.Interface().(Value); ok {
		return r.clone(exported.rawValue())
	}
	if object, ok := output.Interface().(*Object); ok {
		return r.clone(object.raw)
	}
	return r.marshalReflect(output)
}

func (r *Runtime) clone(input *quickjs.Value) (*quickjs.Value, error) {
	if input == nil {
		return r.context.NewUndefined(), nil
	}
	this := r.context.NewUndefined()
	defer this.Free()
	cloned := r.identity.Execute(this, input)
	if cloned == nil {
		return nil, fmt.Errorf("duplicate QuickJS value")
	}
	if cloned.IsException() {
		err := r.context.Exception()
		cloned.Free()
		return nil, err
	}
	return cloned, nil
}

func (o *Object) Set(name string, input any) error {
	return o.runtime.setValue(o.raw, name, input)
}

func (o *Object) Get(name string) Value { return o.runtime.wrap(o.raw.Get(name)) }

func (o *Object) SetSymbol(symbol Symbol, input any) error {
	function, err := o.runtime.marshal(input)
	if err != nil {
		return err
	}
	defer function.Free()
	targetGlobal := "__hypernodeSymbolTarget"
	valueGlobal := "__hypernodeSymbolValue"
	if err := o.runtime.setValue(o.runtime.context.Globals(), targetGlobal, o); err != nil {
		return err
	}
	if err := o.runtime.setValue(o.runtime.context.Globals(), valueGlobal, &value{runtime: o.runtime, raw: function}); err != nil {
		return err
	}
	result, err := o.runtime.RunString(fmt.Sprintf("globalThis.%s[Symbol.%s] = globalThis.%s", targetGlobal, symbol, valueGlobal))
	if result != nil {
		result.Free()
	}
	return err
}

func (v *value) String() string {
	if v == nil || v.raw == nil {
		return "undefined"
	}
	exported, err := v.runtime.exportValue(v.raw)
	if err != nil {
		return ""
	}
	if text, ok := exported.(string); ok {
		return text
	}
	return fmt.Sprint(exported)
}

func (v *value) Export() any {
	if v == nil || v.raw == nil {
		return nil
	}
	if v.raw.IsPromise() {
		return &Promise{value: v}
	}
	output, err := v.runtime.exportValue(v.raw)
	if err != nil {
		return nil
	}
	return output
}

func (v *value) ToObject(_ *Runtime) *Object {
	if v == nil {
		return nil
	}
	return &Object{v}
}

func (v *value) rawValue() *quickjs.Value {
	if v == nil {
		return nil
	}
	return v.raw
}

func (v *value) Free() {
	if v == nil || v.raw == nil || v.freed {
		return
	}
	v.raw.Free()
	v.freed = true
	if v.runtime != nil {
		v.runtime.valuesMu.Lock()
		delete(v.runtime.values, v)
		v.runtime.valuesMu.Unlock()
	}
}

func IsUndefined(input Value) bool {
	return input == nil || input.rawValue() == nil || input.rawValue().IsUndefined()
}

func IsNull(input Value) bool {
	return input != nil && input.rawValue() != nil && input.rawValue().IsNull()
}

type Callable func(this Value, args ...Value) (Value, error)

func AssertFunction(input Value) (Callable, bool) {
	if input == nil || input.rawValue() == nil || !input.rawValue().IsFunction() {
		return nil, false
	}
	return func(this Value, args ...Value) (Value, error) {
		rawArgs := make([]*quickjs.Value, len(args))
		ownedArgs := make([]*quickjs.Value, 0, len(args))
		defer func() {
			for _, argument := range ownedArgs {
				argument.Free()
			}
		}()
		for index, argument := range args {
			if argument == nil {
				rawArgs[index] = input.(*value).runtime.context.NewUndefined()
				ownedArgs = append(ownedArgs, rawArgs[index])
			} else {
				rawArgs[index] = argument.rawValue()
			}
		}
		var ownedThis *quickjs.Value
		rawThis := input.(*value).runtime.context.NewUndefined()
		ownedThis = rawThis
		if this != nil && this.rawValue() != nil {
			rawThis = this.rawValue()
			ownedThis = nil
		}
		if ownedThis != nil {
			defer ownedThis.Free()
		}
		result := input.rawValue().Execute(rawThis, rawArgs...)
		return input.(*value).runtime.evalResult(result)
	}, true
}

func (p *Promise) State() PromiseState {
	if p == nil || p.value == nil || p.value.rawValue() == nil {
		return PromiseStatePending
	}
	switch p.value.rawValue().PromiseState() {
	case quickjs.PromiseFulfilled:
		return PromiseStateFulfilled
	case quickjs.PromiseRejected:
		return PromiseStateRejected
	default:
		return PromiseStatePending
	}
}

func (p *Promise) Result() Value {
	if p == nil || p.value == nil {
		return nil
	}
	result := p.value.rawValue().Await()
	return p.value.(*value).runtime.wrap(result)
}

func StringFromUTF16(input []uint16) string {
	return string(utf16.Decode(input))
}
