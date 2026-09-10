export interface ManagedWebSocketConnection {
  socket: Pick<WebSocket, "close" | "readyState" | "send">;
  transport: { close: () => void };
}

export class LatestWebSocketConnection {
  private generation = 0;
  private active: { generation: number; resource: ManagedWebSocketConnection } | null = null;

  get currentSocket() {
    return this.active?.resource.socket ?? null;
  }

  begin() {
    this.generation += 1;
    this.closeActive("connection replaced");
    return this.generation;
  }

  isCurrent(generation: number) {
    return generation === this.generation;
  }

  activate(generation: number, resource: ManagedWebSocketConnection) {
    if (!this.isCurrent(generation)) {
      this.closeResource(resource, "stale connection");
      return false;
    }
    this.closeActive("connection replaced");
    this.active = { generation, resource };
    return true;
  }

  disconnect() {
    try {
      this.active?.resource.socket.close(1000, "prototype disconnect");
    } catch {
      this.forceClose();
    }
  }

  release(generation: number, resource: ManagedWebSocketConnection) {
    try {
      resource.transport.close();
    } catch {
      // Transport release is best-effort after the WebSocket has closed.
    }
    if (this.active?.generation !== generation || this.active.resource !== resource) {
      return false;
    }
    this.active = null;
    return true;
  }

  forceClose() {
    this.generation += 1;
    this.closeActive("connection reset");
  }

  private closeActive(reason: string) {
    const active = this.active;
    this.active = null;
    if (active) {
      this.closeResource(active.resource, reason);
    }
  }

  private closeResource(resource: ManagedWebSocketConnection, reason: string) {
    try {
      resource.socket.close(1000, reason);
    } catch {
      // The socket may already have failed before it became active.
    }
    try {
      resource.transport.close();
    } catch {
      // The transport may already have closed with the socket.
    }
  }
}
