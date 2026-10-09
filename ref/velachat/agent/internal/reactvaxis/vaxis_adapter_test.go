package reactvaxis

import (
	"fmt"
	"strings"
	"testing"

	"go.rockorager.dev/vaxis"
	"go.rockorager.dev/vaxis/ui"
)

func TestVaxisButtonDispatchesHandlerID(t *testing.T) {
	dispatched := make(chan NativeEvent, 1)
	root := &NativeNode{Type: "Button", TestID: "button", Text: "增加", OnPress: "handler-1"}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		dispatched <- event
	}).Build(root), 24, 5)

	harness.Send(vaxis.Key{Keycode: vaxis.KeyTab})
	harness.Send(vaxis.Key{Keycode: vaxis.KeyEnter})

	select {
	case event := <-dispatched:
		if event.HandlerID != "handler-1" {
			t.Fatalf("handler ID = %q, want handler-1", event.HandlerID)
		}
	default:
		t.Fatal("Vaxis Button 没有把事件送回 bridge")
	}
}

func TestVaxisPressablePreservesChildLabelAndDispatchesHandlerID(t *testing.T) {
	dispatched := make(chan NativeEvent, 1)
	root := &NativeNode{
		Type:    "Pressable",
		TestID:  "login-submit",
		OnPress: "handler-login",
		Children: []*NativeNode{
			{Type: "Text", Text: "登录"},
		},
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		dispatched <- event
	}).Build(root), 24, 3)

	if !strings.Contains(strings.ReplaceAll(harness.Snapshot(), " ", ""), "登录") {
		t.Fatalf("Pressable 没有显示 children label:\n%s", harness.Snapshot())
	}
	harness.Send(vaxis.Key{Keycode: vaxis.KeyTab})
	harness.Send(vaxis.Key{Keycode: vaxis.KeyEnter})

	select {
	case event := <-dispatched:
		if event.HandlerID != "handler-login" || event.Source != "pressable" {
			t.Fatalf("Pressable event = %#v", event)
		}
	default:
		t.Fatal("Vaxis Pressable 没有把事件送回 bridge")
	}
}

func TestVaxisPressablePreservesChildLayoutWithoutPermanentButtonSurface(t *testing.T) {
	root := &NativeNode{
		Type:  "View",
		Style: NativeStyle{Direction: "column"},
		Children: []*NativeNode{
			{Type: "Button", Text: "先行按钮", OnPress: "anchor"},
			{
				Type:    "Pressable",
				OnPress: "open-channel",
				Children: []*NativeNode{{
					Type:  "View",
					Style: NativeStyle{Direction: "column"},
					Children: []*NativeNode{
						{Type: "Text", Text: "频道标题"},
						{Type: "Text", Text: "频道说明"},
					},
				}},
			},
		},
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 24, 5)

	lines := strings.Split(harness.Snapshot(), "\n")
	titleRow, descriptionRow := -1, -1
	for row, line := range lines {
		if strings.Contains(line, "频道标题") {
			titleRow = row
		}
		if strings.Contains(line, "频道说明") {
			descriptionRow = row
		}
	}
	if titleRow < 0 || descriptionRow != titleRow+1 {
		t.Fatalf("Pressable child layout was flattened:\n%s", harness.Snapshot())
	}
	for column := 0; column < harness.width; column++ {
		cell := harness.painter.Cell(column, titleRow)
		if cell.Grapheme != "频" {
			continue
		}
		if cell.Background == ui.DefaultTheme().Surface {
			t.Fatalf("unfocused Pressable retained permanent Button surface: %#v", cell.Background)
		}
		return
	}
	t.Fatal("Pressable title cell was not painted")
}

func TestSemanticSurfaceUsesCurrentLightAndDarkTheme(t *testing.T) {
	themeSet := ui.DefaultThemeSet()
	tests := []struct {
		name    string
		surface string
		light   ui.Color
		dark    ui.Color
	}{
		{name: "canvas", surface: "canvas", light: themeSet.Light.Background, dark: themeSet.Dark.Background},
		{name: "surface", surface: "surface", light: themeSet.Light.Surface, dark: themeSet.Dark.Surface},
		{name: "raised", surface: "raised", light: themeSet.Light.SurfaceRaised, dark: themeSet.Dark.SurfaceRaised},
		{name: "selected", surface: "selected", light: themeSet.Light.Selection, dark: themeSet.Dark.Selection},
		{name: "danger", surface: "danger", light: themeSet.Light.Danger, dark: themeSet.Dark.Danger},
		{name: "success", surface: "success", light: themeSet.Light.Success, dark: themeSet.Dark.Success},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got, ok := semanticSurfaceBackground(themeSet.Light, test.surface); !ok || got != test.light {
				t.Fatalf("light %s = %#v,%v, want %#v,true", test.surface, got, ok, test.light)
			}
			if got, ok := semanticSurfaceBackground(themeSet.Dark, test.surface); !ok || got != test.dark {
				t.Fatalf("dark %s = %#v,%v, want %#v,true", test.surface, got, ok, test.dark)
			}
		})
	}
	if got, ok := semanticSurfaceBackground(themeSet.Light, "future-surface"); ok || got != 0 {
		t.Fatalf("unknown surface = %#v,%v, want zero,false", got, ok)
	}
}

func TestVaxisViewPaintsSemanticSurfaceBehindReadableText(t *testing.T) {
	theme := ui.DefaultTheme()
	root := &NativeNode{
		Type:  "View",
		Style: NativeStyle{Surface: "raised"},
		Children: []*NativeNode{
			{Type: "Text", Text: "区域"},
		},
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 12, 2)
	for column := 0; column < harness.width; column++ {
		cell := harness.painter.Cell(column, 0)
		if cell.Grapheme != "区" {
			continue
		}
		if cell.Background != theme.SurfaceRaised {
			t.Fatalf("semantic surface background = %#v, want %#v", cell.Background, theme.SurfaceRaised)
		}
		if cell.Grapheme != "区" {
			t.Fatalf("semantic surface obscured text: %#v", cell)
		}
		return
	}
	t.Fatal("semantic surface text was not painted")
}

func TestVaxisV2LayoutAppliesAxisPaddingAndFixedConstraints(t *testing.T) {
	root := &NativeNode{
		Type: "View",
		Style: NativeStyle{
			Width: 14, Height: 3,
			MinWidth: 10, MaxWidth: 20,
			MinHeight: 2, MaxHeight: 4,
			PaddingX: 2, PaddingY: 1,
		},
		Children: []*NativeNode{{Type: "Text", Text: "内容"}},
	}
	widget := NewVaxisAdapter(nil).Build(root)
	box, ok := widget.(ui.ConstrainedBox)
	if !ok {
		t.Fatalf("v2 layout root = %T, want ui.ConstrainedBox", widget)
	}
	if got, want := box.Constraints, (ui.Constraints{MinWidth: 14, MaxWidth: 14, MinHeight: 3, MaxHeight: 3}); got != want {
		t.Fatalf("constraints = %#v, want %#v", got, want)
	}

	harness := NewHeadlessHarness(widget, 30, 8)
	if got := harness.painter.Cell(2, 1).Grapheme; got != "内" {
		t.Fatalf("axis padding content origin = %q, want 内\n%s", got, harness.Snapshot())
	}
}

func TestVaxisV2GapAndAlignmentRemainTerminalNative(t *testing.T) {
	root := &NativeNode{
		Type:  "View",
		Style: NativeStyle{Direction: "row", Width: 8, Gap: 2, CrossAlign: "center", MainAlign: "start"},
		Children: []*NativeNode{
			{Type: "Text", Text: "甲"},
			{Type: "Text", Text: "乙"},
		},
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 12, 3)
	for row := 0; row < harness.height; row++ {
		for column := 0; column < harness.width; column++ {
			if harness.painter.Cell(column, row).Grapheme != "甲" {
				continue
			}
			if got := harness.painter.Cell(column+4, row).Grapheme; got != "乙" {
				t.Fatalf("乙 column = %q, want two terminal gap cells after 甲:\n%s", got, harness.Snapshot())
			}
			return
		}
	}
	t.Fatalf("gap layout did not paint 甲:\n%s", harness.Snapshot())
}

func TestVaxisTextHonorsMaxLinesWithEllipsis(t *testing.T) {
	root := &NativeNode{Type: "Text", Text: "这是超过一行宽度的中文说明", MaxLines: 1}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 8, 3)
	lines := strings.Split(harness.Snapshot(), "\n")
	if strings.TrimSpace(lines[1]) != "" {
		t.Fatalf("MaxLines rendered a second row:\n%s", harness.Snapshot())
	}
	if !strings.Contains(lines[0], "…") {
		t.Fatalf("MaxLines did not render ellipsis: %q", lines[0])
	}
}

func TestVaxisScrollViewSeparatesViewportAndContentStyle(t *testing.T) {
	root := &NativeNode{
		Type:         "ScrollView",
		Style:        NativeStyle{Width: 12, Height: 5},
		ContentStyle: NativeStyle{PaddingX: 2, Gap: 1},
		Children: []*NativeNode{
			{Type: "Text", Text: "第一项"},
			{Type: "Text", Text: "第二项"},
		},
	}
	widget := NewVaxisAdapter(nil).Build(root)
	box, ok := widget.(ui.ConstrainedBox)
	if !ok || box.Constraints.MaxWidth != 12 || box.Constraints.MaxHeight != 5 {
		t.Fatalf("scroll viewport constraints = %#v (%T)", box.Constraints, widget)
	}
	harness := NewHeadlessHarness(widget, 20, 8)
	if got := harness.painter.Cell(2, 0).Grapheme; got != "第" {
		t.Fatalf("content padding origin = %q, want 第\n%s", got, harness.Snapshot())
	}
	if got := harness.painter.Cell(2, 2).Grapheme; got != "第" {
		t.Fatalf("content gap did not preserve one empty row: %q\n%s", got, harness.Snapshot())
	}
}

func TestGeometryObserverTracksTestIDAcrossResize(t *testing.T) {
	observer := NewGeometryObserver()
	root := &NativeNode{
		Type: "View", TestID: "root", Style: NativeStyle{Direction: "row", Gap: 1},
		Children: []*NativeNode{
			{Type: "View", TestID: "rail", Style: NativeStyle{Width: 14}},
			{Type: "View", TestID: "stage", Style: NativeStyle{Flex: 1}},
		},
	}
	harness := NewHeadlessHarness(NewVaxisAdapterWithGeometry(nil, observer).Build(root), 120, 20)
	if got, ok := observer.Rect("rail"); !ok || got != (ui.Rect{X: 0, Y: 0, Width: 14, Height: 20}) {
		t.Fatalf("rail rect = %#v,%v", got, ok)
	}
	if got, ok := observer.Rect("stage"); !ok || got != (ui.Rect{X: 15, Y: 0, Width: 105, Height: 20}) {
		t.Fatalf("stage rect = %#v,%v", got, ok)
	}
	harness.Resize(150, 24)
	if got, ok := observer.Rect("stage"); !ok || got != (ui.Rect{X: 15, Y: 0, Width: 135, Height: 24}) {
		t.Fatalf("resized stage rect = %#v,%v", got, ok)
	}
}

func TestVaxisSliverListAppliesContentPaddingAndGapInsideViewport(t *testing.T) {
	root := &NativeNode{
		Type:                "SliverList",
		Style:               NativeStyle{Width: 12, Height: 8},
		ContentStyle:        NativeStyle{PaddingX: 2, PaddingY: 1, Gap: 1},
		EstimatedItemExtent: 1,
		Children: []*NativeNode{
			{Type: "Text", Text: "第一项"},
			{Type: "Text", Text: "第二项"},
		},
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 20, 10)
	if got := harness.painter.Cell(2, 1).Grapheme; got != "第" {
		t.Fatalf("sliver first item origin = %q\n%s", got, harness.Snapshot())
	}
	if got := harness.painter.Cell(2, 3).Grapheme; got != "第" {
		t.Fatalf("sliver second item gap origin = %q\n%s", got, harness.Snapshot())
	}
}

func TestVaxisCheckboxDispatchesTypedBooleanValue(t *testing.T) {
	dispatched := make(chan NativeEvent, 1)
	root := &NativeNode{
		Type:          "Checkbox",
		TestID:        "notifications-checkbox",
		Checked:       false,
		Label:         "允许通知",
		OnValueChange: "handler-checkbox",
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		dispatched <- event
	}).Build(root), 24, 3)

	harness.Send(vaxis.Key{Keycode: vaxis.KeyTab})
	harness.Send(vaxis.Key{Keycode: vaxis.KeySpace})

	select {
	case event := <-dispatched:
		if event.HandlerID != "handler-checkbox" || event.Source != "checkbox" {
			t.Fatalf("checkbox event = %#v", event)
		}
		if event.ValueKind != NativeBoolValue || !event.BoolValue {
			t.Fatalf("checkbox typed value = %#v, want bool/true", event)
		}
	default:
		t.Fatal("Vaxis Checkbox 没有发送 typed boolean event")
	}
}

func TestVaxisCheckboxMouseDispatchesAndDisabledCheckboxDoesNot(t *testing.T) {
	events := make(chan NativeEvent, 2)
	adapter := NewVaxisAdapter(func(event NativeEvent) { events <- event })
	enabled := &NativeNode{
		Type: "Checkbox", TestID: "enabled", Label: "启用", OnValueChange: "handler-enabled",
	}
	harness := NewHeadlessHarness(adapter.Build(enabled), 20, 1)
	harness.Send(vaxis.Mouse{Col: 0, Row: 0, Button: vaxis.MouseLeftButton, EventType: vaxis.EventPress})
	if event := <-events; event.HandlerID != "handler-enabled" || !event.BoolValue {
		t.Fatalf("checkbox mouse event = %#v", event)
	}

	disabled := &NativeNode{
		Type: "Checkbox", TestID: "disabled", Label: "禁用", Disabled: true, OnValueChange: "handler-disabled",
	}
	harness.Update(adapter.Build(disabled))
	if got := harness.painter.Cell(0, 0).Foreground; got != ui.DefaultTheme().DisabledForeground {
		t.Fatalf("disabled checkbox foreground = %#v, want theme disabled", got)
	}
	harness.Send(vaxis.Mouse{Col: 0, Row: 0, Button: vaxis.MouseLeftButton, EventType: vaxis.EventPress})
	harness.Send(vaxis.Key{Keycode: vaxis.KeySpace})
	select {
	case event := <-events:
		t.Fatalf("disabled Checkbox 不应发送事件，收到 %#v", event)
	default:
	}
}

func TestVaxisRadioDispatchesTypedStringValue(t *testing.T) {
	dispatched := make(chan NativeEvent, 1)
	root := &NativeNode{
		Type:          "Radio",
		TestID:        "runtime-radio-codex",
		Value:         "codex",
		GroupValue:    "hermes",
		Label:         "Codex",
		OnValueChange: "handler-radio",
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		dispatched <- event
	}).Build(root), 24, 3)

	harness.Send(vaxis.Key{Keycode: vaxis.KeyTab})
	harness.Send(vaxis.Key{Keycode: vaxis.KeyEnter})

	select {
	case event := <-dispatched:
		if event.HandlerID != "handler-radio" || event.Source != "radio" {
			t.Fatalf("radio event = %#v", event)
		}
		if event.ValueKind != NativeStringValue || event.Value != "codex" {
			t.Fatalf("radio typed value = %#v, want string/codex", event)
		}
	default:
		t.Fatal("Vaxis Radio 没有发送 typed string event")
	}
}

func TestVaxisSegmentedControlNavigatesBeforeSubmitting(t *testing.T) {
	dispatched := make(chan NativeEvent, 1)
	root := &NativeNode{
		Type:   "SegmentedControl",
		TestID: "workspace-tabs",
		Value:  "chat",
		Segments: []NativeSegment{
			{Value: "chat", Label: "聊天"},
			{Value: "tasks", Label: "任务"},
		},
		OnValueChange: "handler-segments",
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		dispatched <- event
	}).Build(root), 32, 3)

	harness.Send(vaxis.Key{Keycode: vaxis.KeyTab})
	harness.Send(vaxis.Key{Keycode: vaxis.KeyRight})
	select {
	case event := <-dispatched:
		t.Fatalf("方向键不应提交 segment，收到 %#v", event)
	default:
	}
	harness.Send(vaxis.Key{Keycode: vaxis.KeyEnter})

	select {
	case event := <-dispatched:
		if event.HandlerID != "handler-segments" || event.Source != "segmented-control" {
			t.Fatalf("segmented event = %#v", event)
		}
		if event.ValueKind != NativeStringValue || event.Value != "tasks" {
			t.Fatalf("segmented typed value = %#v, want string/tasks", event)
		}
	default:
		t.Fatal("Vaxis SegmentedControl 激活后没有发送事件")
	}
}

func TestVaxisSegmentedControlPreservesActiveStateAcrossCommitAndSkipsDisabled(t *testing.T) {
	events := make(chan NativeEvent, 1)
	adapter := NewVaxisAdapter(func(event NativeEvent) { events <- event })
	root := func() *NativeNode {
		return &NativeNode{
			Type: "SegmentedControl", TestID: "workspace-tabs", Value: "chat",
			Segments: []NativeSegment{
				{Value: "chat", Label: "聊天"},
				{Value: "tasks", Label: "任务", Disabled: true},
				{Value: "files", Label: "文件"},
			},
			OnValueChange: "handler-segments",
		}
	}
	harness := NewHeadlessHarness(adapter.Build(root()), 36, 2)
	harness.Send(vaxis.Key{Keycode: vaxis.KeyTab})
	harness.Send(vaxis.Key{Keycode: vaxis.KeyRight})
	harness.Update(adapter.Build(root()))
	harness.Send(vaxis.Key{Keycode: vaxis.KeyEnter})

	select {
	case event := <-events:
		if event.Value != "files" {
			t.Fatalf("跨 commit active segment = %q, want files", event.Value)
		}
	default:
		t.Fatal("跨 commit 后 SegmentedControl 没有提交")
	}
}

func TestVaxisProgressBarUsesBoundedParentWidth(t *testing.T) {
	root := &NativeNode{Type: "ProgressBar", TestID: "agent-progress", Progress: 0.5, Width: 3}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 8, 1)

	for col := 0; col < 4; col++ {
		if got := harness.painter.Cell(col, 0).Grapheme; got != "█" {
			t.Fatalf("bounded progress cell %d = %q, want filled", col, got)
		}
	}
	if got := harness.painter.Cell(4, 0).Grapheme; got != " " {
		t.Fatalf("bounded progress empty cell = %q, want space", got)
	}
}

func TestVaxisProgressBarUsesWidthOnUnboundedRowAxis(t *testing.T) {
	root := &NativeNode{
		Type:  "View",
		Style: NativeStyle{Direction: "row"},
		Children: []*NativeNode{
			{Type: "ProgressBar", TestID: "agent-progress", Progress: 1, Width: 5},
			{Type: "Text", Text: "尾"},
		},
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 12, 1)

	if got := harness.painter.Cell(4, 0).Grapheme; got != "█" {
		t.Fatalf("unbounded progress fifth cell = %q, want filled", got)
	}
	if got := harness.painter.Cell(5, 0).Grapheme; got != "尾" {
		t.Fatalf("progress width 后的内容 = %q, want 尾", got)
	}
}

func TestVaxisListTileMapsSlotsAndDispatchesPress(t *testing.T) {
	dispatched := make(chan NativeEvent, 1)
	root := &NativeNode{
		Type:     "ListTile",
		TestID:   "agent-tile",
		Title:    "研究助手",
		Subtitle: "在线",
		Leading:  "A",
		Trailing: "›",
		OnPress:  "handler-tile",
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		dispatched <- event
	}).Build(root), 32, 3)

	normalized := strings.ReplaceAll(harness.Snapshot(), " ", "")
	for _, text := range []string{"A", "研究助手", "在线", "›"} {
		if !strings.Contains(normalized, text) {
			t.Fatalf("ListTile 缺少槽位 %q:\n%s", text, harness.Snapshot())
		}
	}
	harness.Send(vaxis.Key{Keycode: vaxis.KeyTab})
	harness.Send(vaxis.Key{Keycode: vaxis.KeyEnter})
	select {
	case event := <-dispatched:
		if event.HandlerID != "handler-tile" || event.Source != "list-tile" {
			t.Fatalf("ListTile event = %#v", event)
		}
	default:
		t.Fatal("Vaxis ListTile 没有发送 press event")
	}
}

func TestVaxisListTileUsesNativeSelectedStyle(t *testing.T) {
	root := &NativeNode{Type: "ListTile", TestID: "agent-tile", Title: "研究助手", Selected: true}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 20, 2)

	if got := harness.painter.Cell(0, 0).Background; got != ui.DefaultTheme().Primary {
		t.Fatalf("selected ListTile background = %#v, want theme primary", got)
	}
}

func TestVaxisControlledTextInputDispatchesNextValue(t *testing.T) {
	dispatched := make(chan NativeEvent, 1)
	root := &NativeNode{
		Type:         "TextInput",
		TestID:       "input",
		Value:        "",
		Placeholder:  "输入姓名",
		AutoFocus:    true,
		OnChangeText: "handler-input",
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		dispatched <- event
	}).Build(root), 24, 3)

	harness.Send(vaxis.Key{Text: "B", Keycode: 'B'})

	select {
	case event := <-dispatched:
		if event.HandlerID != "handler-input" ||
			event.ValueKind != NativeStringValue ||
			event.Value != "B" {
			t.Fatalf("input event = %#v, want handler-input/B", event)
		}
	default:
		t.Fatal("Vaxis TextField 没有发送受控 next value")
	}
}

func TestVaxisTextInputPlacesHardwareCursorAfterWideCharacters(t *testing.T) {
	root := &NativeNode{
		Type:         "TextInput",
		TestID:       "input",
		AutoFocus:    true,
		OnChangeText: "handler-input",
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(NativeEvent) {}).Build(root), 32, 3)

	harness.Send(vaxis.Key{Text: "你", EventType: vaxis.EventPress})
	harness.Send(vaxis.Key{Text: "好", EventType: vaxis.EventPress})

	cursor, ok := harness.painter.Cursor()
	if !ok {
		t.Fatal("输入框没有显示终端硬件光标")
	}
	// TextField has one cell of left padding. Each CJK grapheme occupies two
	// terminal cells, so the cursor after 你好 must be at column 1 + 2 + 2.
	if cursor.Col != 5 || cursor.Row != 0 {
		t.Fatalf("中文输入后的终端光标 = %#v, want col=5 row=0", cursor)
	}
}

func TestVaxisTextInputStripsPastedLineBreaks(t *testing.T) {
	events := make(chan NativeEvent, 1)
	root := &NativeNode{
		Type:         "TextInput",
		TestID:       "input",
		AutoFocus:    true,
		OnChangeText: "handler-input",
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		events <- event
	}).Build(root), 32, 3)

	harness.Send(vaxis.Key{Text: "甲\n乙\r丙", EventType: vaxis.EventPaste})

	select {
	case event := <-events:
		if event.Value != "甲乙丙" {
			t.Fatalf("单行输入粘贴结果 = %q, want 甲乙丙", event.Value)
		}
	default:
		t.Fatal("单行输入没有发送粘贴结果")
	}
}

func TestControlledTextInputRejectsStaleReactValue(t *testing.T) {
	events := make(chan NativeEvent, 4)
	adapter := NewVaxisAdapter(func(event NativeEvent) { events <- event })
	root := func(value string, mostRecentEventCount int) *NativeNode {
		return &NativeNode{
			Type:                 "TextInput",
			TestID:               "input",
			Value:                value,
			AutoFocus:            true,
			OnChangeText:         "handler-input",
			MostRecentEventCount: mostRecentEventCount,
		}
	}
	harness := NewHeadlessHarness(adapter.Build(root("", 0)), 32, 3)

	// A single IME commit can be decoded by Vaxis as adjacent grapheme events.
	harness.Send(vaxis.Key{Text: "你", EventType: vaxis.EventPress})
	first := <-events
	harness.Send(vaxis.Key{Text: "好", EventType: vaxis.EventPress})
	second := <-events
	if first.EventCount != 1 || second.EventCount != 2 || second.Value != "你好" {
		t.Fatalf("native events = %#v / %#v", first, second)
	}

	// The first React commit can reach the terminal after native input has
	// already advanced. It must not shrink the buffer or move the cursor.
	harness.Update(adapter.Build(root("你", 1)))
	harness.Update(adapter.Build(root("你好", 2)))
	harness.Send(vaxis.Key{Text: "是的", EventType: vaxis.EventPress})
	third := <-events
	if third.Value != "你好是的" || third.EventCount != 3 {
		t.Fatalf("after stale commit event = %#v, want 你好是的/count=3", third)
	}
}

func TestVaxisScrollAndResize(t *testing.T) {
	children := make([]*NativeNode, 0, 12)
	for i := 1; i <= 12; i++ {
		children = append(children, &NativeNode{Type: "Text", Text: lineLabel(i)})
	}
	root := &NativeNode{Type: "ScrollView", Children: children}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 18, 4)

	if !harness.Contains("第 01 行") || harness.Contains("第 12 行") {
		t.Fatalf("初始 viewport 不正确:\n%s", harness.Snapshot())
	}
	harness.Send(vaxis.Key{Keycode: vaxis.KeyTab})
	harness.Send(vaxis.Key{Keycode: vaxis.KeyEnd})
	if !harness.Contains("第 12 行") {
		t.Fatalf("End 后没有滚到底部:\n%s", harness.Snapshot())
	}

	harness.Resize(10, 3)
	if got := harness.Size(); got.Width != 10 || got.Height != 3 {
		t.Fatalf("resize 后 size = %#v, want 10x3", got)
	}
}

func TestVaxisNavigationStackBuildsOnlyActivePageAndDispatchesBack(t *testing.T) {
	events := make(chan NativeEvent, 1)
	root := &NativeNode{
		Type: "NavigationStack", TestID: "stack", ActiveIndex: 1, CanGoBack: true,
		ActiveRouteKey: "route-2", OnBack: "handler-back",
		Children: []*NativeNode{
			{Type: "Text", Text: "旧页面"},
			{Type: "Text", Text: "当前页面"},
		},
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		events <- event
	}).Build(root), 24, 4)

	if harness.Contains("旧页面") || !harness.Contains("当前页面") {
		t.Fatalf("NavigationStack active page 错误:\n%s", harness.Snapshot())
	}
	harness.Send(vaxis.Key{Keycode: vaxis.KeyLeft, Modifiers: vaxis.ModAlt})
	select {
	case event := <-events:
		if event.HandlerID != "handler-back" || event.Source != "navigation-back" {
			t.Fatalf("navigation back event = %#v", event)
		}
	default:
		t.Fatal("Alt+Left 没有派发 NavigationStack onBack")
	}
}

func TestVaxisModalDialogEscapeDispatchesDismiss(t *testing.T) {
	events := make(chan NativeEvent, 1)
	root := &NativeNode{
		Type: "Overlay",
		Children: []*NativeNode{
			{Type: "OverlayContent", Children: []*NativeNode{{Type: "Text", Text: "底层页面"}}},
			{
				Type: "OverlayEntry", Modal: true, Alignment: "center",
				Children: []*NativeNode{{
					Type: "Dialog", TestID: "dialog", Title: "确认", Width: 30,
					OnDismiss: "handler-dismiss",
					Children:  []*NativeNode{{Type: "Text", Text: "确定继续？"}},
				}},
			},
		},
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(func(event NativeEvent) {
		events <- event
	}).Build(root), 50, 12)

	normalized := strings.ReplaceAll(harness.Snapshot(), " ", "")
	if !strings.Contains(normalized, "确认") || !strings.Contains(normalized, "确定继续？") {
		t.Fatalf("Dialog 未绘制:\n%s", harness.Snapshot())
	}
	harness.Send(vaxis.Key{Keycode: vaxis.KeyEsc})
	select {
	case event := <-events:
		if event.HandlerID != "handler-dismiss" || event.Source != "dialog-dismiss" {
			t.Fatalf("dialog dismiss event = %#v", event)
		}
	default:
		t.Fatal("Escape 没有由 Dialog 派发 dismiss")
	}
}

func TestVaxisSliverListBuildsViewportAndCanJumpToEnd(t *testing.T) {
	children := make([]*NativeNode, 0, 1000)
	for i := 1; i <= 1000; i++ {
		children = append(children, &NativeNode{Type: "Text", Text: fmt.Sprintf("第 %04d 行", i)})
	}
	root := &NativeNode{
		Type: "SliverList", TestID: "large-list", ItemExtent: 1,
		EstimatedItemExtent: 1, Overscan: 2, LayoutVersion: "v1", Children: children,
	}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 24, 5)
	if !harness.Contains("第 0001 行") || harness.Contains("第 1000 行") {
		t.Fatalf("Sliver 初始 viewport 错误:\n%s", harness.Snapshot())
	}
	harness.Send(vaxis.Key{Keycode: vaxis.KeyTab})
	harness.Send(vaxis.Key{Keycode: vaxis.KeyEnd})
	if !harness.Contains("第 1000 行") {
		t.Fatalf("Sliver End 后未到末行:\n%s", harness.Snapshot())
	}
}

func TestVaxisInvalidOverlayReturnsDiagnosticPlaceholder(t *testing.T) {
	root := &NativeNode{Type: "Overlay", TestID: "broken-overlay"}
	harness := NewHeadlessHarness(NewVaxisAdapter(nil).Build(root), 60, 2)
	if snapshot := harness.Snapshot(); !strings.Contains(snapshot, "invalid Overlay") {
		t.Fatalf("非法 Overlay 没有诊断占位:\n%s", snapshot)
	}
}

func lineLabel(i int) string {
	const digits = "0123456789"
	return "第 " + string(digits[i/10]) + string(digits[i%10]) + " 行"
}
