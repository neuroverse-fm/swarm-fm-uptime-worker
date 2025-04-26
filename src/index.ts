import { XMLParser } from "fast-xml-parser";

interface Env {
  LIVE_DO: DurableObjectNamespace;
  WEBHOOK_SECRET: string;
  VERIFY_TOKEN: string;
  YT_API_KEY: string;
}

export class LiveStatusDO {
  private state: DurableObjectState;
  private env: Env;
  private clients = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env   = env;
  }

  // constant‐time compare
  private async equals(a: string, b: string): Promise<boolean> {
    const ua = new TextEncoder().encode(a);
    const ub = new TextEncoder().encode(b);
    if (ua.length !== ub.length) return false;
    let diff = 0;
    for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
    return diff === 0;
  }

  // HMAC-SHA256 helper
  private async hmacSHA256(secret: string, data: ArrayBuffer): Promise<ArrayBuffer> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return crypto.subtle.sign("HMAC", key, data);
  }

  async fetch(request: Request): Promise<Response> {
    const url  = new URL(request.url);
    const path = url.pathname;

    //
    // 1) PubSubHubbub subscription handshake (GET)
    //
    if (path === "/webhook" && request.method === "GET") {
      const mode      = url.searchParams.get("hub.mode");
      const topic     = url.searchParams.get("hub.topic");
      const challenge = url.searchParams.get("hub.challenge");
      const verifyTok = url.searchParams.get("hub.verify_token");

      const expectedTopic = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC2I6ta1bWX7DnEuYNvHiptQ";

      if (
        mode === "subscribe" &&
        topic === expectedTopic &&
        verifyTok === this.env.VERIFY_TOKEN &&
        challenge
      ) {
        return new Response(challenge, { status: 200 });
      }

      return new Response("Invalid subscription request", { status: 400 });
    }

    //
    // 2) Webhook notification (POST /webhook)
    //
    if (path === "/webhook" && request.method === "POST") {
      const secret = this.env.WEBHOOK_SECRET;

      // 2a) Shared‐secret check
      const token = request.headers.get("X-Webhook-Token") ?? "";
      if (!(await this.equals(token, secret))) {
        return new Response("Unauthorized: bad token", { status: 401 });
      }

      // 2b) Optional HMAC‐SHA256 signature check
      const sigHeader = request.headers.get("X-Hub-Signature-256") ?? "";
      if (sigHeader.startsWith("sha256=")) {
        const payload    = await request.clone().arrayBuffer();
        const expectedBuf = await this.hmacSHA256(secret, payload);
        const expectedHex = Array.from(new Uint8Array(expectedBuf))
          .map(b => b.toString(16).padStart(2, "0")).join("");
        const actualHex   = sigHeader.slice(7);

        if (!(await this.equals(actualHex, expectedHex))) {
          return new Response("Unauthorized: bad signature", { status: 401 });
        }
      }

      // 2c) Parse the Atom XML and extract videoId
      const xml    = await request.text();
      const parser = new XMLParser({ ignoreAttributes: false });
      const obj    = parser.parse(xml) as any;
      const entry  = Array.isArray(obj.feed.entry)
        ? obj.feed.entry[0]
        : obj.feed.entry;
      const videoId = entry?.["yt:videoId"];

      // 2d) Update state & broadcast if live
      if (videoId) {
        await this.state.storage.put("videoId", videoId);
        for (const ws of this.clients) {
          ws.send(JSON.stringify({ live: true, videoId }));
        }
      }

      return new Response(null, { status: 204 });
    }

    //
    // 3) Scheduled “update” from the cron (POST /update)
    //
    if (path === "/update" && request.method === "POST") {
      const { videoId } = await request.json() as { videoId: string | null };
      if (videoId) {
        await this.state.storage.put("videoId", videoId);
      } else {
        await this.state.storage.delete("videoId");
      }
      // broadcast new state
      for (const ws of this.clients) {
        ws.send(JSON.stringify({ live: !!videoId, videoId }));
      }
      return new Response(null, { status: 204 });
    }

    //
    // 4) WebSocket upgrade (GET /ws)
    //
    if (
      path === "/ws" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      const [client, server] = Object.values(new WebSocketPair());
      await server.accept();
      this.clients.add(server);
      server.addEventListener("close", () => this.clients.delete(server));

      // send current state immediately
      const current = await this.state.storage.get("videoId");
      server.send(JSON.stringify({ live: !!current, videoId: current }));

      return new Response(null, { status: 101, webSocket: client });
    }

    //
    // 5) Pollable status endpoint (GET /status)
    //
    if (path === "/status" && request.method === "GET") {
      const videoId = await this.state.storage.get("videoId");
      return new Response(
        JSON.stringify({ live: !!videoId, videoId }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // All HTTP traffic is routed into the singleton DO
    const id   = env.LIVE_DO.idFromName("singleton");
    const stub = env.LIVE_DO.get(id);
    return stub.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Poll YouTube’s Search API every minute
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.search = new URLSearchParams({
      part:      "id",
      channelId: "UC2I6ta1bWX7DnEuYNvHiptQ",
      eventType: "live",
      type:      "video",
      key:       env.YT_API_KEY,
    }).toString();

    const res = await fetch(url.toString());
    if (!res.ok) return; // skip on error

    const json = await res.json() as { items: Array<{ id: { videoId: string } }> };
    const liveVideo = json.items[0]?.id.videoId ?? null;

    // Tell the same DO about the new state via POST /update
    const id   = env.LIVE_DO.idFromName("singleton");
    const stub = env.LIVE_DO.get(id);
    await stub.fetch("https://dummy/update", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ videoId: liveVideo }),
    });
  }
};
