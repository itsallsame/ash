import type { Connector } from "../../src/hand";
import type { LinkServer } from "../../src/server";
import type { LinkSocket } from "../../src/socket";

type Listener = (...args: any[]) => void;

/** One end of an in-memory WebSocket pair. Messages arrive asynchronously, in order, like on a real socket. */
export class MemorySocket implements LinkSocket {
  peer!: MemorySocket;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private readonly listeners: Record<string, Listener[]> = { message: [], close: [] };
  /** Return true to swallow a message this end receives (to simulate a lost frame). */
  drop: ((data: string) => boolean) | null = null;
  send(data: string): void {
    if (this.closedWith) return;
    this.sent.push(data);
    const peer = this.peer;
    queueMicrotask(() => { if (!peer.closedWith && !peer.drop?.(data)) peer.emit("message", data, false); });
  }
  close(code = 1005, reason = ""): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    const peer = this.peer;
    queueMicrotask(() => { if (!peer.closedWith) { peer.closedWith = { code, reason }; peer.emit("close", code, Buffer.from(reason)); } this.emit("close", code, Buffer.from(reason)); });
  }
  terminate(): void { this.close(1006, "terminated"); }
  on(event: "message" | "close", listener: Listener): this { this.listeners[event]!.push(listener); return this; }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners[event] ?? []) listener(...args); }
}

export function memoryPair(): { server: MemorySocket; hand: MemorySocket } {
  const server = new MemorySocket();
  const hand = new MemorySocket();
  server.peer = hand;
  hand.peer = server;
  return { server, hand };
}

/** A hand connector that reaches [server] through memory. [onSocket] sees each connection's hand end. */
export function memoryConnector(server: LinkServer, onSocket?: (hand: MemorySocket) => void): Connector {
  return (_url, headers, events) => {
    const pair = memoryPair();
    pair.hand.on("message", (data: string) => events.message(data, false));
    pair.hand.on("close", (code: number, reason: Buffer) => events.close(code, reason.toString()));
    onSocket?.(pair.hand);
    server.accept(pair.server, { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });
    queueMicrotask(() => events.open());
    return pair.hand;
  };
}
