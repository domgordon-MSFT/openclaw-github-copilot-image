import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

// Test-only stdio service. No model, network, or credential access.
export const fixturePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DgAAAEQQFAjv0/EgAAAABJRU5ErkJggg==";

export function serveImageFixture(onExecute) {
  const rpc = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
  rpc.onRequest("connect", () => ({ protocolVersion: 4 }));
  rpc.onRequest("status.get", () => ({ version: "1.0.114", protocolVersion: 4 }));
  rpc.onRequest("auth.getStatus", () => ({ isAuthenticated: true, login: "fixture" }));
  rpc.onRequest("session.create", p => ({ sessionId: p.sessionId }));
  rpc.onRequest("session.options.update", () => ({}));
  rpc.onRequest("session.tools.initializeAndValidate", () => ({}));
  rpc.onRequest("session.tools.getCurrentMetadata", () => ({ tools: [{ name: "image_generation", input_schema: {
    properties: { prompt: { type: "string", maxLength: 32000 }, input_images: { type: "array", maxItems: 2,
      items: { oneOf: [{ properties: { path: { type: "string" } }, required: ["path"] }] } },
    size: { enum: ["auto"] }, quality: { enum: ["auto"] } },
  } }] }));
  rpc.onRequest("session.tools.execute", async request => {
    await onExecute(request);
    return { resultType: "success", binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: fixturePng }] };
  });
  rpc.onRequest("session.detach", () => ({ success: true }));
  rpc.onRequest("runtime.shutdown", () => ({}));
  rpc.listen();
}
