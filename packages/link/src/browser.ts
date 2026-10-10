import { HandClient, type Connector, type HandOptions } from "./hand";

/** Opens the browser's WebSocket. Browsers cannot set request headers, so [headers] is ignored (a browser hand proves itself through the gateway). */
export const browserConnector: Connector = (url, _headers, events) => {
  const ws = new WebSocket(url);
  ws.onopen = () => events.open();
  ws.onmessage = (event) => events.message(event.data, typeof event.data !== "string");
  ws.onclose = (event) => events.close(event.code, event.reason);
  ws.onerror = () => {};
  return ws;
};

/** A hand for web pages: the same client as in Node, over the browser's WebSocket. */
export function createBrowserClient(options: Omit<HandOptions, "connector">): HandClient {
  return new HandClient({ ...options, connector: browserConnector });
}

export { HandClient, MemoryEventQueue, reconnectDelay, HandLinkError } from "./hand";
export type { CallOutcome, EventQueue, HandHandlers, HandOptions, PresentOutcome, QueuedEvent } from "./hand";
