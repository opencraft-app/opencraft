import React from "react";
import Svg, { Circle, Ellipse, Line, Path, Polygon, Polyline, Rect, type SvgProps } from "react-native-svg";
import { actionArtwork, type ActionArtworkName } from "@opencraft/design-system/action-artwork";
import { sidebarToggleGlyphs } from "@opencraft/design-system/sidebar-toggle-glyphs";

export interface ActionIconProps extends Omit<SvgProps, "children" | "width" | "height"> {
  readonly size?: number;
}

const primitives = { path: Path, rect: Rect, circle: Circle, ellipse: Ellipse, line: Line, polyline: Polyline, polygon: Polygon };

function Canvas({ size = 20, color = "currentColor", strokeWidth = 2, viewBox = "0 0 24 24", children, ...props }: ActionIconProps & { readonly children: React.ReactNode }) {
  const labelled = props.accessible ?? !!props.accessibilityLabel;
  return <Svg {...props} width={size} height={size} viewBox={viewBox} fill={props.fill ?? "none"}
    color={color} stroke={props.stroke ?? color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
    accessible={labelled} accessibilityElementsHidden={props.accessibilityElementsHidden ?? !labelled}
    importantForAccessibility={props.importantForAccessibility ?? (labelled ? "yes" : "no")}>
    {children}
  </Svg>;
}

function glyph(name: ActionArtworkName) {
  const { shapes } = actionArtwork[name];
  return function ActionIcon(props: ActionIconProps) {
    return <Canvas {...props}>{shapes.map(({ tag, attributes }, index) => {
      const Primitive = primitives[tag];
      return <Primitive {...attributes} key={index} />;
    })}</Canvas>;
  };
}

/** Shell state uses the same filled contours as the existing desktop toggle. */
function sidebarGlyph(state: "hidden" | "visible") {
  return function SidebarIcon({ size = sidebarToggleGlyphs.size, color = "currentColor", ...props }: ActionIconProps) {
    return <Canvas {...props} size={size} color={color} viewBox={sidebarToggleGlyphs.viewBox}>
      <Path d={sidebarToggleGlyphs[state]} fill={color} stroke="none" />
    </Canvas>;
  };
}

export const SidebarHiddenIcon = sidebarGlyph("hidden");
export const SidebarVisibleIcon = sidebarGlyph("visible");

export const AddIcon = glyph("AddIcon");
export const AddImageIcon = glyph("AddImageIcon");
export const AgentIcon = glyph("AgentIcon");
export const AlertIcon = glyph("AlertIcon");
export const ArrowLeftIcon = glyph("ArrowLeftIcon");
export const ArrowRightIcon = glyph("ArrowRightIcon");
export const ArrowUpIcon = glyph("ArrowUpIcon");
export const AttachmentIcon = glyph("AttachmentIcon");
export const BoldIcon = glyph("BoldIcon");
export const BookIcon = glyph("BookIcon");
export const BranchIcon = glyph("BranchIcon");
export const CalendarClockIcon = glyph("CalendarClockIcon");
export const CheckIcon = glyph("CheckIcon");
export const ChecklistIcon = glyph("ChecklistIcon");
export const ChevronDownIcon = glyph("ChevronDownIcon");
export const ChevronLeftIcon = glyph("ChevronLeftIcon");
export const ChevronRightIcon = glyph("ChevronRightIcon");
export const CircleIcon = glyph("CircleIcon");
export const CloseIcon = glyph("CloseIcon");
export const CloudIcon = glyph("CloudIcon");
export const CodeFileIcon = glyph("CodeFileIcon");
export const CodeIcon = glyph("CodeIcon");
export const ComposeIcon = glyph("ComposeIcon");
export const CopyIcon = glyph("CopyIcon");
export const ExpandIcon = glyph("ExpandIcon");
export const FolderIcon = glyph("FolderIcon");
export const FolderOpenIcon = glyph("FolderOpenIcon");
export const GlobeIcon = glyph("GlobeIcon");
export const HistoryIcon = glyph("HistoryIcon");
export const ImageIcon = glyph("ImageIcon");
export const ItalicIcon = glyph("ItalicIcon");
export const LinkIcon = glyph("LinkIcon");
export const ListIcon = glyph("ListIcon");
export const MessageIcon = glyph("MessageIcon");
export const MonitorIcon = glyph("MonitorIcon");
export const NewFileIcon = glyph("NewFileIcon");
export const OrderedListIcon = glyph("OrderedListIcon");
export const ParagraphIcon = glyph("ParagraphIcon");
export const QuoteIcon = glyph("QuoteIcon");
export const RedoIcon = glyph("RedoIcon");
export const ResetIcon = glyph("ResetIcon");
export const ReviewShieldIcon = glyph("ReviewShieldIcon");
export const SearchFileIcon = glyph("SearchFileIcon");
export const SearchIcon = glyph("SearchIcon");
export const SparklesIcon = glyph("SparklesIcon");
export const SquareIcon = glyph("SquareIcon");
export const TerminalIcon = glyph("TerminalIcon");
export const ToolIcon = glyph("ToolIcon");
export const UndoIcon = glyph("UndoIcon");
export const WrapTextIcon = glyph("WrapTextIcon");
