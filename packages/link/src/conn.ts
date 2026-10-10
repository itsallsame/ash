import { CLOSE_CODES, FRAME_DEFS, LIMITS, type Frame } from "../../sdk/src/link";
import type { Clock } from "./clock";
import { decodeFrame, encodeFrame, type Decoded } from "./codec";
import type { RawSocket } from "./socket";

export interface ConnOptions {
  socket: RawSocket;
  clock: Clock;
  /** Which end this is. A frame that only the same end may send is a protocol error. */
  role: "kernel" | "hand";
  silenceMs?: number;
  /** A valid frame, except ping and pong, which the connection answers itself. */
  onFrame(frame: Frame): void;
  /**
   * A message that is not a valid frame. Return true when it was handled (for example closed with another code);
   * otherwise the connection answers with an `error` frame and closes with 4400.
   */
  onInvalid?(bad: Extract<Decoded, { ok: false }>): boolean | void;
  /** Called once, whoever closed the connection. */
  onClosed(code: number, reason: string): void;
}

/** Close reasons travel in a control frame, which holds 123 bytes. */
const clip = (reason: string) => reason.slice(0, 100);

/**
 * One WebSocket carrying frames: decoding and checking, ping and pong, and the silence watchdog. The server's
 * sessions and the clients share it; it knows nothing about what the frames mean.
 */
export class FrameConn {
  closed = false;
  private silence: unknown;
  private beat: unknown;

  constructor(private readonly o: ConnOptions) {
    this.armSilence();
  }

  /** Sends a frame; false when the connection is already closed. */
  send(frame: Frame): boolean {
    if (this.closed) return false;
    this.o.socket.send(encodeFrame(frame));
    return true;
  }

  /** The socket's `message` event. */
  receive(data: unknown, isBinary?: boolean): void {
    if (this.closed) return;
    this.armSilence();
    const decoded = decodeFrame(data, isBinary);
    if (!decoded.ok) {
      if (this.o.onInvalid?.(decoded) === true) return;
      this.send({ t: "error", ...(decoded.id ? { id: decoded.id } : {}), code: "bad_request", message: decoded.error });
      this.close(CLOSE_CODES.badFrame, decoded.error);
      return;
    }
    const frame = decoded.frame;
    if (FRAME_DEFS[frame.t].from === this.o.role) {
      this.send({ t: "error", code: "bad_request", message: `a ${this.o.role} does not send ${frame.t}` });
      this.close(CLOSE_CODES.badFrame, `${frame.t} sent by the wrong end`);
      return;
    }
    if (frame.t === "ping") { this.send({ t: "pong", at: frame.at }); return; }
    if (frame.t === "pong") return;
    this.o.onFrame(frame);
  }

  /** Sends a ping every [ms]. */
  startHeartbeat(ms: number): void {
    this.o.clock.clearTimer(this.beat);
    const tick = () => {
      if (this.closed) return;
      this.send({ t: "ping", at: this.o.clock.now() });
      this.beat = this.o.clock.setTimer(tick, ms);
    };
    this.beat = this.o.clock.setTimer(tick, ms);
  }

  /** Closes from this end. */
  close(code: number, reason = ""): void {
    if (this.closed) return;
    this.finish(code, reason);
    try { this.o.socket.close(code, clip(reason)); } catch { /* already gone */ }
  }

  /** The socket's `close` event: the peer (or the network) ended it. */
  remoteClosed(code: number, reason: string): void {
    if (!this.closed) this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    this.closed = true;
    this.o.clock.clearTimer(this.silence);
    this.o.clock.clearTimer(this.beat);
    this.o.onClosed(code, reason);
  }

  private armSilence(): void {
    this.o.clock.clearTimer(this.silence);
    this.silence = this.o.clock.setTimer(() => {
      this.close(CLOSE_CODES.normal, "no frame within the silence limit");
      this.o.socket.terminate?.();
    }, this.o.silenceMs ?? LIMITS.silenceMs);
  }
}
