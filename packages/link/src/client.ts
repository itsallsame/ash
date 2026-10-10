import { WebSocket } from "ws";
import { LIMITS } from "../../sdk/src/link";
import { HandClient, type Connector, type HandOptions } from "./hand";

/** Opens a WebSocket with `ws`, which can send request headers (the local connection needs `Authorization`). */
export const nodeConnector: Connector = (url, headers, events) => {
  const ws = new WebSocket(url, { headers, maxPayload: LIMITS.frameBytes, handshakeTimeout: 20_000 });
  ws.on("open", () => events.open());
  ws.on("message", (data, isBinary) => events.message(data, isBinary));
  ws.on("close", (code, reason) => events.close(code, reason.toString()));
  ws.on("error", () => {}); // a failed connect is followed by `close`
  return ws;
};

/** A hand for Node programs (the computer program, tests). */
export function createNodeClient(options: Omit<HandOptions, "connector">): HandClient {
  return new HandClient({ ...options, connector: nodeConnector });
}
