package reactvaxis

import (
	"fmt"
	"strings"

	"go.rockorager.dev/vaxis"
	"go.rockorager.dev/vaxis/ui"
)

// VaxisAdapter translates the renderer-neutral commit tree to Vaxis ui
// widgets. It contains no React or goja values.
type VaxisAdapter struct {
	dispatch func(NativeEvent)
	geometry *GeometryObserver
}

func NewVaxisAdapter(dispatch func(NativeEvent)) VaxisAdapter {
	return VaxisAdapter{dispatch: dispatch}
}

func NewVaxisAdapterWithGeometry(
	dispatch func(NativeEvent),
	geometry *GeometryObserver,
) VaxisAdapter {
	return VaxisAdapter{dispatch: dispatch, geometry: geometry}
}

func (a VaxisAdapter) Build(node *NativeNode) ui.Widget {
	if node == nil {
		return ui.Text{Value: ""}
	}
	widget := applyNativeBoxStyle(a.build(node), node.Style)
	if node.TestID != "" {
		if a.geometry != nil {
			widget = geometryProbe{
				testID: node.TestID, observer: a.geometry, child: widget,
			}
		}
		widget = keyedWidget{key: ui.KeyValue(node.TestID), child: widget}
	}
	return widget
}

func semanticSurfaceBackground(theme ui.Theme, surface string) (ui.Color, bool) {
	switch surface {
	case "canvas":
		return theme.Background, true
	case "surface":
		return theme.Surface, true
	case "raised":
		return theme.SurfaceRaised, true
	case "selected":
		return theme.Selection, true
	case "danger":
		return theme.Danger, true
	case "success":
		return theme.Success, true
	default:
		return 0, false
	}
}

type semanticSurface struct {
	surface string
	child   ui.Widget
}

func (semanticSurface) CreateState() ui.State { return &semanticSurfaceState{} }

type semanticSurfaceState struct{ ui.StateBase }

func (state *semanticSurfaceState) Build(ctx ui.BuildContext) ui.Widget {
	widget := state.Widget().(semanticSurface)
	background, ok := semanticSurfaceBackground(ui.MustDepend[ui.Theme](ctx), widget.surface)
	if !ok {
		return widget.child
	}
	return ui.DecoratedBox(
		ui.Decoration{Style: ui.Style{Background: background}},
		widget.child,
	)
}

func (a VaxisAdapter) build(node *NativeNode) ui.Widget {
	switch node.Type {
	case "Text":
		style := ui.Style{}
		if node.TestID == "title" {
			style = ui.Style{Foreground: ui.RGB(99, 140, 255), Attribute: ui.AttrBold}
		}
		return ui.Text{
			Value: node.TextContent(), Style: style, SoftWrap: true,
			MaxLines: node.MaxLines, Overflow: ui.TextOverflowEllipsis,
		}
	case "Button":
		return ui.Button{
			Label: node.TextContent(),
			OnPressed: func(ui.EventContext) {
				a.emit(NativeEvent{HandlerID: node.OnPress, Source: "button"})
			},
		}
	case "Pressable":
		axis := ui.Vertical
		if node.Style.Direction == "row" {
			axis = ui.Horizontal
		}
		var onPressed ui.VoidCallback
		if !node.Disabled && node.OnPress != "" {
			onPressed = func(ui.EventContext) {
				a.emit(NativeEvent{HandlerID: node.OnPress, Source: "pressable"})
			}
		}
		return ui.ListTile{
			Title:     a.children(node, axis),
			Disabled:  node.Disabled,
			MinHeight: 1,
			OnPressed: onPressed,
		}
	case "Checkbox":
		return ui.Checkbox{
			Checked:  node.Checked,
			Disabled: node.Disabled,
			Label:    node.Label,
			OnChanged: func(_ ui.EventContext, value bool) {
				a.emit(NativeEvent{
					HandlerID: node.OnValueChange,
					ValueKind: NativeBoolValue,
					BoolValue: value,
					Source:    "checkbox",
				})
			},
		}
	case "Radio":
		return ui.Radio[string]{
			Value:      node.Value,
			GroupValue: node.GroupValue,
			Disabled:   node.Disabled,
			Label:      node.Label,
			OnChanged: func(_ ui.EventContext, value string) {
				a.emit(NativeEvent{
					HandlerID: node.OnValueChange,
					ValueKind: NativeStringValue,
					Value:     value,
					Source:    "radio",
				})
			},
		}
	case "SegmentedControl":
		segments := make([]ui.SegmentedItem[string], 0, len(node.Segments))
		for _, segment := range node.Segments {
			segments = append(segments, ui.SegmentedItem[string]{
				Value:    segment.Value,
				Label:    segment.Label,
				Disabled: segment.Disabled,
			})
		}
		return ui.SegmentedControl[string]{
			Value:    node.Value,
			Segments: segments,
			Disabled: node.Disabled,
			OnChanged: func(_ ui.EventContext, value string) {
				a.emit(NativeEvent{
					HandlerID: node.OnValueChange,
					ValueKind: NativeStringValue,
					Value:     value,
					Source:    "segmented-control",
				})
			},
		}
	case "ProgressBar":
		return ui.ProgressBar{Value: node.Progress, Width: node.Width}
	case "ListTile":
		var onPressed ui.VoidCallback
		if node.OnPress != "" {
			onPressed = func(ui.EventContext) {
				a.emit(NativeEvent{HandlerID: node.OnPress, Source: "list-tile"})
			}
		}
		return ui.ListTile{
			Leading:   optionalText(node.Leading),
			Title:     optionalText(node.Title),
			Subtitle:  optionalText(node.Subtitle),
			Trailing:  optionalText(node.Trailing),
			Selected:  node.Selected,
			Disabled:  node.Disabled,
			OnPressed: onPressed,
		}
	case "TextInput":
		return controlledTextField{
			Value:                node.Value,
			Placeholder:          node.Placeholder,
			AutoFocus:            node.AutoFocus,
			ObscureText:          node.SecureTextEntry,
			MinWidth:             32,
			HandlerID:            node.OnChangeText,
			MostRecentEventCount: node.MostRecentEventCount,
			OnChanged: func(value string, eventCount int) {
				a.emit(NativeEvent{
					HandlerID:  node.OnChangeText,
					ValueKind:  NativeStringValue,
					Value:      value,
					Source:     "text-input",
					EventCount: eventCount,
				})
			},
		}
	case "TextArea":
		return controlledTextArea{
			Value:                node.Value,
			Placeholder:          node.Placeholder,
			AutoFocus:            node.AutoFocus,
			MinWidth:             32,
			MinHeight:            3,
			MaxHeight:            7,
			SoftWrap:             true,
			HandlerID:            node.OnChangeText,
			MostRecentEventCount: node.MostRecentEventCount,
			OnChanged: func(value string, eventCount int) {
				a.emit(NativeEvent{
					HandlerID:  node.OnChangeText,
					ValueKind:  NativeStringValue,
					Value:      value,
					Source:     "text-area",
					EventCount: eventCount,
				})
			},
		}
	case "ScrollView":
		contentNode := *node
		contentNode.Style = node.ContentStyle
		content := a.children(&contentNode, ui.Vertical)
		return ui.ScrollView{Child: applyNativeBoxStyle(content, node.ContentStyle)}
	case "Overlay":
		return a.buildOverlay(node)
	case "Dialog":
		return a.buildDialog(node)
	case "SliverList":
		return a.buildSliverList(node)
	case "NavigationStack":
		return a.buildNavigationStack(node)
	case "OverlayContent", "OverlayEntry", "DialogActions":
		return invalidHostNode(node, "marker must be consumed by its parent")
	case "View":
		axis := ui.Vertical
		if node.Style.Direction == "row" {
			axis = ui.Horizontal
		}
		return a.children(node, axis)
	default:
		return ui.Text{Value: fmt.Sprintf("[unsupported host component %s]", node.Type)}
	}
}

func (a VaxisAdapter) buildOverlay(node *NativeNode) ui.Widget {
	var content *NativeNode
	entries := make([]*NativeNode, 0, len(node.Children))
	modalCount := 0
	for _, child := range node.Children {
		if child == nil {
			return invalidHostNode(node, "nil direct child")
		}
		switch child.Type {
		case "OverlayContent":
			if content != nil {
				return invalidHostNode(node, "requires exactly one OverlayContent")
			}
			if len(child.Children) != 1 || child.Children[0] == nil {
				return invalidHostNode(node, "OverlayContent requires exactly one child")
			}
			content = child
		case "OverlayEntry":
			if len(child.Children) != 1 || child.Children[0] == nil {
				return invalidHostNode(node, "OverlayEntry requires exactly one child")
			}
			if child.Modal {
				modalCount++
				if child.Children[0].Type != "Dialog" {
					return invalidHostNode(node, "modal OverlayEntry child must be Dialog")
				}
			}
			if _, ok := overlayAlignment(child.Alignment); !ok {
				return invalidHostNode(node, "invalid OverlayEntry alignment "+child.Alignment)
			}
			entries = append(entries, child)
		default:
			return invalidHostNode(node, "direct children must be OverlayContent or OverlayEntry")
		}
	}
	if content == nil {
		return invalidHostNode(node, "requires exactly one OverlayContent")
	}
	if modalCount > 1 {
		return invalidHostNode(node, "supports at most one modal OverlayEntry")
	}

	overlayEntries := make([]ui.OverlayEntry, 0, len(entries))
	for _, entry := range entries {
		alignment, _ := overlayAlignment(entry.Alignment)
		overlayEntries = append(overlayEntries, ui.OverlayEntry{
			Child:     a.Build(entry.Children[0]),
			Modal:     entry.Modal,
			Alignment: alignment,
		})
	}
	return ui.Overlay{
		Child:   a.Build(content.Children[0]),
		Entries: overlayEntries,
	}
}

func (a VaxisAdapter) buildDialog(node *NativeNode) ui.Widget {
	if node.Width < 0 || node.Width > 4096 {
		return invalidHostNode(node, "width must be 1..4096 when specified")
	}
	bodyNodes := node.Children
	var actionNodes []*NativeNode
	hasActions := false
	for index, child := range node.Children {
		if child == nil {
			return invalidHostNode(node, "nil direct child")
		}
		if child.Type != "DialogActions" {
			continue
		}
		if index != len(node.Children)-1 || hasActions {
			return invalidHostNode(node, "DialogActions must be the optional last child")
		}
		hasActions = true
		actionNodes = child.Children
		bodyNodes = node.Children[:index]
	}
	for _, action := range actionNodes {
		if action == nil || action.Type != "Button" {
			return invalidHostNode(node, "DialogActions only accepts Button children")
		}
	}

	bodyWidgets := make([]ui.Widget, 0, len(bodyNodes)+1)
	for _, child := range bodyNodes {
		bodyWidgets = append(bodyWidgets, a.Build(child))
	}
	if !hasEagerFocusableNodes(append(append([]*NativeNode{}, bodyNodes...), actionNodes...)) {
		bodyWidgets = append(bodyWidgets, focusSentinel{})
	}
	var body ui.Widget
	if len(bodyWidgets) > 0 {
		body = ui.Flex{
			Axis:               ui.Vertical,
			MainAxisSize:       ui.MainAxisSizeMin,
			CrossAxisAlignment: ui.CrossAxisStretch,
			Children:           bodyWidgets,
		}
	}
	actions := make([]ui.Widget, 0, len(actionNodes))
	for _, action := range actionNodes {
		actions = append(actions, a.Build(action))
	}
	var onDismiss ui.VoidCallback
	if node.OnDismiss != "" {
		onDismiss = func(ui.EventContext) {
			a.emit(NativeEvent{HandlerID: node.OnDismiss, Source: "dialog-dismiss"})
		}
	}
	return ui.Dialog{
		Title:     node.Title,
		Child:     body,
		Actions:   actions,
		Width:     node.Width,
		OnDismiss: onDismiss,
	}
}

func (a VaxisAdapter) buildSliverList(node *NativeNode) ui.Widget {
	if len(node.Children) > 250_000 {
		return invalidHostNode(node, "supports at most 250000 children")
	}
	if node.ItemExtent < 0 || node.ItemExtent > 1024 {
		return invalidHostNode(node, "itemExtent must be 0..1024")
	}
	if node.EstimatedItemExtent < 1 || node.EstimatedItemExtent > 1024 {
		return invalidHostNode(node, "estimatedItemExtent must be 1..1024")
	}
	if node.Overscan < 0 || node.Overscan > 1024 {
		return invalidHostNode(node, "overscan must be 0..1024")
	}
	for _, child := range node.Children {
		if child == nil {
			return invalidHostNode(node, "nil list child")
		}
	}
	key := node.TestID + "@" + node.LayoutVersion
	sliver := keyedWidget{
		key: ui.KeyValue(key),
		child: ui.SliverListBuilder{
			Count:               len(node.Children),
			ItemExtent:          node.ItemExtent,
			EstimatedItemExtent: node.EstimatedItemExtent,
			Overscan:            node.Overscan,
			Builder: func(_ ui.BuildContext, index int) ui.Widget {
				if index < 0 || index >= len(node.Children) {
					return ui.Text{Value: "[invalid SliverList index]"}
				}
				return applySliverContentStyle(
					a.Build(node.Children[index]),
					node.ContentStyle,
					index,
					len(node.Children),
				)
			},
		},
	}
	return ui.CustomScrollView{Slivers: []ui.Widget{sliver}}
}

func applySliverContentStyle(
	widget ui.Widget,
	style NativeStyle,
	index int,
	count int,
) ui.Widget {
	paddingX, paddingY := style.PaddingX, style.PaddingY
	if paddingX == 0 && paddingY == 0 && style.Padding > 0 {
		paddingX, paddingY = style.Padding, style.Padding
	}
	top, bottom := 0, 0
	if index == 0 {
		top = paddingY
	}
	if index+1 == count {
		bottom = paddingY
	} else if style.MainAlign != "spaceBetween" {
		bottom = style.Gap
	}
	if paddingX > 0 || top > 0 || bottom > 0 {
		widget = ui.Padding(ui.Insets{
			Top: top, Right: paddingX, Bottom: bottom, Left: paddingX,
		}, widget)
	}
	style.Padding, style.PaddingX, style.PaddingY, style.Gap = 0, 0, 0, 0
	return applyNativeBoxStyle(widget, style)
}

func (a VaxisAdapter) buildNavigationStack(node *NativeNode) ui.Widget {
	if len(node.Children) == 0 {
		return invalidHostNode(node, "requires at least one page")
	}
	if node.ActiveIndex < 0 || node.ActiveIndex >= len(node.Children) {
		return invalidHostNode(node, "activeIndex is out of range")
	}
	if node.ActiveRouteKey == "" {
		return invalidHostNode(node, "activeRouteKey must not be empty")
	}
	active := node.Children[node.ActiveIndex]
	if active == nil {
		return invalidHostNode(node, "active page is nil")
	}
	page := a.Build(active)
	if !hasEagerFocusable(active) {
		page = ui.Stack{Children: []ui.Widget{page, focusSentinel{}}}
	}
	page = keyedWidget{
		key: ui.KeyValue(node.ActiveRouteKey),
		child: ui.FocusScope{
			AutoFocus: true,
			Child:     page,
		},
	}
	if !node.CanGoBack || node.OnBack == "" || containsModalNode(active) {
		return page
	}

	back := navigationBackIntent{}
	invokeBack := func(ui.EventContext, ui.Intent) ui.EventResult {
		a.emit(NativeEvent{HandlerID: node.OnBack, Source: "navigation-back"})
		return ui.EventHandled
	}
	return ui.Shortcuts{
		Bindings: ui.ShortcutMap{"Alt+Left": back},
		Child: ui.Actions{
			Bindings: map[ui.IntentType]ui.ActionFunc{back.IntentType(): invokeBack},
			Child: ui.DefaultActions{
				Bindings: map[ui.IntentType]ui.ActionFunc{ui.DismissIntentType: invokeBack},
				Child:    page,
			},
		},
	}
}

func overlayAlignment(value string) (ui.Alignment, bool) {
	switch value {
	case "topLeft":
		return ui.TopLeft, true
	case "topCenter":
		return ui.TopCenter, true
	case "topRight":
		return ui.TopRight, true
	case "centerLeft":
		return ui.CenterLeft, true
	case "", "center":
		return ui.CenterAlign, true
	case "centerRight":
		return ui.CenterRight, true
	case "bottomLeft":
		return ui.BottomLeft, true
	case "bottomCenter":
		return ui.BottomCenter, true
	case "bottomRight":
		return ui.BottomRight, true
	default:
		return ui.Alignment{}, false
	}
}

func invalidHostNode(node *NativeNode, reason string) ui.Widget {
	typeName := "<nil>"
	if node != nil && node.Type != "" {
		typeName = node.Type
	}
	return ui.Text{Value: fmt.Sprintf("[invalid %s: %s]", typeName, reason), SoftWrap: true}
}

func containsModalNode(node *NativeNode) bool {
	if node == nil {
		return false
	}
	if node.Type == "OverlayEntry" && node.Modal {
		return true
	}
	for _, child := range node.Children {
		if containsModalNode(child) {
			return true
		}
	}
	return false
}

func hasEagerFocusableNodes(nodes []*NativeNode) bool {
	for _, node := range nodes {
		if hasEagerFocusable(node) {
			return true
		}
	}
	return false
}

func hasEagerFocusable(node *NativeNode) bool {
	if node == nil || node.Disabled {
		return false
	}
	switch node.Type {
	case "SliverList":
		return false
	case "Button", "Pressable", "TextInput", "TextArea", "Checkbox", "Radio", "SegmentedControl", "ScrollView":
		return true
	case "ListTile":
		return node.OnPress != ""
	}
	return hasEagerFocusableNodes(node.Children)
}

type navigationBackIntent struct{}

func (navigationBackIntent) IntentType() ui.IntentType { return "raft.spike.navigation-back" }

type focusSentinel struct{}

func (focusSentinel) CreateState() ui.State { return &focusSentinelState{} }

type focusSentinelState struct {
	ui.StateBase
	node ui.FocusNode
}

func (state *focusSentinelState) Build(ui.BuildContext) ui.Widget {
	return ui.Focus(&state.node, ui.SizedBox{Width: 0, Height: 0})
}

func optionalText(value string) ui.Widget {
	if value == "" {
		return nil
	}
	return ui.Text{Value: value}
}

// controlledInputFence mirrors React Native TextInput's event-count fencing:
// a JS commit may update Value only after acknowledging every native edit that
// was already applied to the terminal buffer.
type controlledInputFence struct {
	initialized bool
	handlerID   string
	value       string
	eventCount  int
}

func (fence *controlledInputFence) sync(handlerID, value string, mostRecentEventCount int) string {
	if !fence.initialized || fence.handlerID != handlerID {
		fence.initialized = true
		fence.handlerID = handlerID
		fence.value = value
		fence.eventCount = mostRecentEventCount
		return fence.value
	}
	if mostRecentEventCount >= fence.eventCount {
		fence.value = value
		fence.eventCount = mostRecentEventCount
	}
	return fence.value
}

func (fence *controlledInputFence) nativeChange(value string) int {
	fence.value = value
	fence.eventCount++
	return fence.eventCount
}

type controlledTextField struct {
	Value                string
	Placeholder          string
	AutoFocus            bool
	ObscureText          bool
	MinWidth             int
	HandlerID            string
	MostRecentEventCount int
	OnChanged            func(string, int)
}

func (controlledTextField) CreateState() ui.State { return &controlledTextFieldState{} }

type controlledTextFieldState struct {
	ui.StateBase
	fence controlledInputFence
}

func (state *controlledTextFieldState) Build(ui.BuildContext) ui.Widget {
	widget := state.Widget().(controlledTextField)
	value := state.fence.sync(widget.HandlerID, widget.Value, widget.MostRecentEventCount)
	if widget.ObscureText {
		return ui.TextField{
			Value:       value,
			Placeholder: widget.Placeholder,
			AutoFocus:   widget.AutoFocus,
			MinWidth:    widget.MinWidth,
			ObscureText: true,
			OnChanged: func(_ ui.EventContext, value string) {
				var eventCount int
				state.SetState(func() { eventCount = state.fence.nativeChange(value) })
				if widget.OnChanged != nil {
					widget.OnChanged(value, eventCount)
				}
			},
		}
	}
	return ui.Actions{
		Bindings: map[ui.IntentType]ui.ActionFunc{
			ui.InsertLineBreakIntentType: func(ui.EventContext, ui.Intent) ui.EventResult {
				return ui.EventHandled
			},
		},
		Child: ui.TextArea{
			Value:       value,
			Placeholder: widget.Placeholder,
			AutoFocus:   widget.AutoFocus,
			MinWidth:    widget.MinWidth,
			MinHeight:   1,
			MaxHeight:   1,
			SoftWrap:    false,
			OnChanged: func(_ ui.EventContext, value string) {
				value = strings.Map(func(r rune) rune {
					if r == '\r' || r == '\n' {
						return -1
					}
					return r
				}, value)
				var eventCount int
				state.SetState(func() { eventCount = state.fence.nativeChange(value) })
				if widget.OnChanged != nil {
					widget.OnChanged(value, eventCount)
				}
			},
		},
	}
}

type controlledTextArea struct {
	Value                string
	Placeholder          string
	AutoFocus            bool
	MinWidth             int
	MinHeight            int
	MaxHeight            int
	SoftWrap             bool
	HandlerID            string
	MostRecentEventCount int
	OnChanged            func(string, int)
}

func (controlledTextArea) CreateState() ui.State { return &controlledTextAreaState{} }

type controlledTextAreaState struct {
	ui.StateBase
	fence controlledInputFence
}

func (state *controlledTextAreaState) Build(ui.BuildContext) ui.Widget {
	widget := state.Widget().(controlledTextArea)
	value := state.fence.sync(widget.HandlerID, widget.Value, widget.MostRecentEventCount)
	return normalizePasteLineBreak(ui.TextArea{
		Value:       value,
		Placeholder: widget.Placeholder,
		AutoFocus:   widget.AutoFocus,
		MinWidth:    widget.MinWidth,
		MinHeight:   widget.MinHeight,
		MaxHeight:   widget.MaxHeight,
		SoftWrap:    widget.SoftWrap,
		OnChanged: func(_ ui.EventContext, value string) {
			var eventCount int
			state.SetState(func() { eventCount = state.fence.nativeChange(value) })
			if widget.OnChanged != nil {
				widget.OnChanged(value, eventCount)
			}
		},
	})
}

func (a VaxisAdapter) children(node *NativeNode, axis ui.Axis) ui.Widget {
	gap := node.Style.Gap
	if node.Style.MainAlign == "spaceBetween" {
		gap = 0
	}
	extra := 0
	if gap > 0 && len(node.Children) > 1 {
		extra = len(node.Children) - 1
	}
	children := make([]ui.Widget, 0, len(node.Children)+extra)
	for index, child := range node.Children {
		if index > 0 && gap > 0 {
			spacer := ui.SizedBox{Height: gap}
			if axis == ui.Horizontal {
				spacer = ui.SizedBox{Width: gap}
			}
			children = append(children, spacer)
		}
		widget := a.Build(child)
		if child.Style.Flex > 0 {
			widget = ui.ExpandedWidget{Flex: child.Style.Flex, Child: widget}
		}
		children = append(children, widget)
	}
	return ui.Flex{
		Axis:               axis,
		MainAxisSize:       ui.MainAxisSizeMax,
		MainAxisAlignment:  nativeMainAxisAlignment(node.Style.MainAlign),
		CrossAxisAlignment: nativeCrossAxisAlignment(node.Style.CrossAlign),
		Children:           children,
	}
}

func nativeConstraints(style NativeStyle) (ui.Constraints, bool) {
	constraints := ui.Constraints{
		MinWidth: style.MinWidth, MaxWidth: style.MaxWidth,
		MinHeight: style.MinHeight, MaxHeight: style.MaxHeight,
	}
	if style.Width > 0 {
		constraints.MinWidth, constraints.MaxWidth = style.Width, style.Width
	} else if constraints.MaxWidth > 0 && constraints.MaxWidth < constraints.MinWidth {
		constraints.MaxWidth = constraints.MinWidth
	}
	if style.Height > 0 {
		constraints.MinHeight, constraints.MaxHeight = style.Height, style.Height
	} else if constraints.MaxHeight > 0 && constraints.MaxHeight < constraints.MinHeight {
		constraints.MaxHeight = constraints.MinHeight
	}
	return constraints, constraints != (ui.Constraints{})
}

func applyNativeBoxStyle(widget ui.Widget, style NativeStyle) ui.Widget {
	paddingX, paddingY := style.PaddingX, style.PaddingY
	if paddingX == 0 && paddingY == 0 && style.Padding > 0 {
		paddingX, paddingY = style.Padding, style.Padding
	}
	if paddingX > 0 || paddingY > 0 {
		widget = ui.Padding(ui.Symmetric(paddingX, paddingY), widget)
	}
	if style.Border {
		widget = ui.DecoratedBox(
			ui.Decoration{Border: ui.BorderLine(ui.RGB(84, 100, 138))},
			widget,
		)
	}
	if style.Surface != "" {
		widget = semanticSurface{surface: style.Surface, child: widget}
	}
	if constraints, ok := nativeConstraints(style); ok {
		widget = ui.ConstrainedBox{Constraints: constraints, Child: widget}
	}
	return widget
}

func nativeMainAxisAlignment(value string) ui.MainAxisAlignment {
	switch value {
	case "center":
		return ui.MainAxisCenter
	case "end":
		return ui.MainAxisEnd
	case "spaceBetween":
		return ui.MainAxisSpaceBetween
	default:
		return ui.MainAxisStart
	}
}

func nativeCrossAxisAlignment(value string) ui.CrossAxisAlignment {
	switch value {
	case "center":
		return ui.CrossAxisCenter
	case "end":
		return ui.CrossAxisEnd
	case "start":
		return ui.CrossAxisStart
	default:
		return ui.CrossAxisStretch
	}
}

func (a VaxisAdapter) emit(event NativeEvent) {
	if event.HandlerID != "" && a.dispatch != nil {
		a.dispatch(event)
	}
}

// keyedWidget preserves native testID identity across App.UpdateRoot calls.
type keyedWidget struct {
	key   ui.KeyValue
	child ui.Widget
}

func (w keyedWidget) WidgetKey() ui.KeyValue          { return w.key }
func (w keyedWidget) Build(ui.BuildContext) ui.Widget { return w.child }

// pasteLineBreakNormalizer repairs one Vaxis/iTerm2 boundary case without
// changing the React host contract. Bracketed-paste LF currently arrives as
// Ctrl+j with EventPaste, which the stock TextArea otherwise ignores.
type pasteLineBreakNormalizer struct {
	child ui.Widget
}

func normalizePasteLineBreak(child ui.Widget) ui.Widget {
	return pasteLineBreakNormalizer{child: child}
}

func (w pasteLineBreakNormalizer) CreateState() ui.State {
	return &pasteLineBreakNormalizerState{}
}

type pasteLineBreakNormalizerState struct{ ui.StateBase }

func (s *pasteLineBreakNormalizerState) Build(ui.BuildContext) ui.Widget {
	return s.Widget().(pasteLineBreakNormalizer).child
}

func (s *pasteLineBreakNormalizerState) HandleEvent(ctx ui.EventContext, event ui.Event) ui.EventResult {
	if ctx.Phase() != ui.CapturePhase {
		return ui.EventIgnored
	}
	key, ok := event.(vaxis.Key)
	if !ok || key.EventType != vaxis.EventPaste || key.Text != "" || key.Keycode != 'j' {
		return ui.EventIgnored
	}
	modifiers := key.Modifiers &^ (vaxis.ModCapsLock | vaxis.ModNumLock)
	if modifiers != vaxis.ModCtrl {
		return ui.EventIgnored
	}
	return ctx.Invoke(ui.InsertLineBreakIntent{})
}
