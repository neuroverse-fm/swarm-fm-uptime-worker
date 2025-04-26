// src/index.ts
import { XMLParser } from "fast-xml-parser";

export class LiveStatusDO {
  state: DurableObjectState;
  clients = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    // 0) Support PubSubHubbub GET‐challenge on /webhook
    if (url.pathname === "/webhook" && request.method === "GET") {
      const mode      = url.searchParams.get("hub.mode");
      const topic     = url.searchParams.get("hub.topic");
      const challenge = url.searchParams.get("hub.challenge");
      const expected  = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC2I6ta1bWX7DnEuYNvHiptQ";

      if (mode === "subscribe" && topic === expected && challenge) {
        // Echo back the challenge to confirm the subscription
        return new Response(challenge, { status: 200 });
      } else {
        return new Response("Invalid subscription request", { status: 400 });
      }
    }

    // 1) Webhook POST to update videoId
    if (url.pathname === "/webhook" && request.method === "POST") {
      const xml    = await request.text();
      const parser = new XMLParser({ ignoreAttributes: false });
      const obj    = parser.parse(xml) as any;
      const entry  = Array.isArray(obj.feed.entry) ? obj.feed.entry[0] : obj.feed.entry;
      const videoId = entry?.["yt:videoId"];

      if (videoId) {
        await this.state.storage.put("videoId", videoId);
        // Broadcast to all WS clients
        for (const ws of this.clients) {
          ws.send(JSON.stringify({ live: true, videoId }));
        }
      }
      return new Response(null, { status: 204 });
    }

    // 2) WebSocket upgrade at /ws
    if (url.pathname === "/ws" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      await server.accept();
      this.clients.add(server);
      server.addEventListener("close", () => this.clients.delete(server));
      // Immediately send current state
      const current = await this.state.storage.get("videoId");
      server.send(JSON.stringify({ live: !!current, videoId: current }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // 3) Simple status endpoint at /status
    if (url.pathname === "/status" && request.method === "GET") {
      const videoId = await this.state.storage.get("videoId");
      return new Response(JSON.stringify({ live: !!videoId, videoId }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    // Route everything into the same Durable Object
    const id   = env.LIVE_DO.idFromName("singleton");
    const stub = env.LIVE_DO.get(id);
    return stub.fetch(request);
  }
};
