import { Component, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { WebConversationViewportOwner, WebConversationWindowHandoff } from "@opencraft/timeline-host-web";

interface TurnWindowProps {
  readonly viewportOwner: WebConversationViewportOwner;
  readonly elementRef: RefObject<HTMLDivElement | null>;
  readonly naturalFlow: boolean;
  readonly rowKeys: readonly string[];
  readonly style: CSSProperties;
  readonly children: ReactNode;
}

/** The snapshot lifecycle is essential: a layout-effect cleanup/ref callback
 * runs during mutation, too late to sample an intact outgoing window. The
 * platform viewport owner owns all geometry, protection and retirement. */
export class ConversationTurnWindow extends Component<TurnWindowProps> {
  private handoff: WebConversationWindowHandoff | null = null;

  getSnapshotBeforeUpdate(previous: TurnWindowProps): WebConversationWindowHandoff | null {
    const next = this.props;
    if (!previous.naturalFlow || !next.naturalFlow || previous.viewportOwner !== next.viewportOwner) return null;
    const keys = new Set(next.rowKeys);
    if (!previous.rowKeys.some(key => !keys.has(key))) return null;
    this.handoff?.cancel();
    return this.handoff = next.viewportOwner.protectWindowHandoff(next.elementRef.current);
  }

  componentDidUpdate(
    _previous: TurnWindowProps,
    _state: unknown,
    snapshot?: WebConversationWindowHandoff | null,
  ): void {
    if (this.handoff === snapshot) this.handoff = null;
    snapshot?.complete();
  }

  componentWillUnmount(): void {
    this.handoff?.cancel();
    this.handoff = null;
  }

  render() {
    return <div className="thread-virtualizer-spacer" ref={this.props.elementRef} style={this.props.style}>
      {this.props.children}
    </div>;
  }
}
