/**
 * What the server needs from an open WebSocket. A `ws` WebSocket fits; so does anything a gateway tunnel is wrapped
 * into, as long as it can send text, close with a code, and report `message` and `close`.
 */
export interface LinkSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Drops the connection without waiting for the peer; used when the peer has gone silent. */
  terminate?(): void;
  /** `message` is called with (data, isBinary?); `close` with (code, reason). */
  on(event: "message" | "close", listener: (...args: any[]) => void): unknown;
}

/** The sending half of a connection, which is all a hand needs from its WebSocket (events come through [SocketEvents]). */
export interface RawSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}
