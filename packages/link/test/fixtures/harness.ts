import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CLOSE_CODES } from "../../../sdk/src/link";
import type { HandHandlers, HandOptions } from "../../src/hand";
import { nodeConnector } from "../../src/client";
import { createLinkServer, type LinkServer, type LinkServerOptions, type LinkSession, type SessionHandlers } from "../../src/server";
import { HandClient } from "../../src/hand";

export const TOKEN = "test-token-not-secret";

export interface Harness {
  link: LinkServer;
  http: Server;
  url: string;
  /** Every session the kernel side saw, in order. */
  sessions: LinkSession[];
  stop(): Promise<void>;
}

/**
 * A kernel as the core will wire it: the token is checked in `authenticate` and the hand id is the hand's name.
 */
export async function startKernel(over: Partial<LinkServerOptions> = {}, handlers: (session: LinkSession) => SessionHandlers = () => ({})): Promise<Harness> {
  const sessions: LinkSession[] = [];
  const link: LinkServer = createLinkServer({
    kernel: { id: "kernel-test", version: "0.0.0" },
    authenticate: (hello, ctx) => {
      const bearer = ctx.headers.authorization;
      if (bearer !== `Bearer ${TOKEN}`) return { ok: false, code: CLOSE_CODES.unauthenticated, reason: "bad token" };
      const channels: Record<string, unknown> = {};
      if (hello.channels.device) channels.device = { accepted: true };
      if (hello.channels.human) channels.human = { accepted: true, client: `client:${hello.hand.name}`, local: true };
      if (hello.channels.agent) channels.agent = { accepted: true };
      return { ok: true, hand_id: hello.hand.name, channels };
    },
    onSession: (session) => {
      sessions.push(session);
      return handlers(session);
    },
    ...over,
  });
  const http = createServer();
  link.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/link`;
  return {
    link, http, url, sessions,
    stop: async () => {
      link.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export function nodeHand(kernel: { url: string }, name: string, over: Partial<HandOptions> = {}, handlers: HandHandlers = {}): HandClient {
  return new HandClient({
    connector: nodeConnector,
    url: kernel.url,
    headers: () => ({ authorization: `Bearer ${TOKEN}` }),
    hand: { kind: "computer", name, version: "0.0.0", platform: "test" },
    channels: { device: {}, human: {} },
    handlers,
    ...over,
  });
}

export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
