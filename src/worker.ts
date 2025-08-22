/// <reference path="../worker-configuration.d.ts" />

import { XMLParser } from 'fast-xml-parser';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const baseWorkerUrl = 'https://sw.arm.fm'; // used by scheduled handler to check status

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleFetch(request, env, ctx);
    } catch (err: any) {
      console.error('Unhandled error in fetch:', err);
      return new Response(JSON.stringify({ error: err?.message ?? 'Unknown error' }), {
        status: err?.status || 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },

  // scheduled cron handler: renew PSHB subscription when near expiry, and check live status end
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      // fetch our own /status endpoint (public)
      const statusRes = await fetch(baseWorkerUrl + '/api/uptime/status');
      if (!statusRes.ok) {
        console.error('Status fetch failed:', statusRes.status);
        return;
      }

      const expiryHeader = statusRes.headers.get('x-pshb-expires');
      let expires: number | null = null;
      if (expiryHeader) {
        const n = Number(expiryHeader);
        if (!Number.isNaN(n)) expires = n;
        else console.warn('Invalid x-pshb-expires header:', expiryHeader);
      }

      const now = Date.now();
      const leaseSec = Number(env.PSHB_LEASE_SECONDS || '432000');
      const renewWindow = leaseSec * 1000 * 0.1; // renew when within 10% of lease

      // Renew PSHB subscription if close to expiry
      if (expires && expires - now < renewWindow) {
        const form = new URLSearchParams({
          'hub.mode': 'subscribe',
          'hub.topic': 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC2I6ta1bWX7DnEuYNvHiptQ',
          'hub.callback': baseWorkerUrl + "/api/uptime/webhook",
          'hub.verify': 'async',
          'hub.verify_token': env.VERIFY_TOKEN,
          'hub.secret': env.WEBHOOK_SECRET,
          'hub.lease_seconds': leaseSec.toString(),
        });

        fetch('https://pubsubhubbub.appspot.com/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        })
          .then((res) => {
            if (res.ok) console.log('PSHB sub renewed');
            else console.error('PSHB renew failed:', res.status);
          })
          .catch((err) => console.error('PSHB renew error:', err));
      }

      // If scheduled checks are disabled, stop here
      if (!env.ENABLE_SCHEDULED || env.ENABLE_SCHEDULED !== 'true') return;

      // If there is a current videoId, check if it ended
      const statusJson = (await statusRes.json()) as { videoId?: string | null };
      const currentVideo = statusJson?.videoId;
      if (!currentVideo) return;

      const url = new URL('https://www.googleapis.com/youtube/v3/videos');
      url.search = new URLSearchParams({
        part: 'liveStreamingDetails',
        id: currentVideo,
        key: env.YT_API_KEY,
      }).toString();

      const ytRes = await fetch(url.toString());
      if (!ytRes.ok) {
        console.warn('YouTube API returned error in scheduled:', ytRes.status);
        return;
      }

      const data = (await ytRes.json()) as {
        items?: Array<{ liveStreamingDetails?: { actualStartTime?: string; actualEndTime?: string } }>;
      };
      const details = data.items?.[0]?.liveStreamingDetails;
      const hasEnded = !details || !!details.actualEndTime;
      if (hasEnded) {
        // clear videoId in KV
        const KV = env.SwarmFM_LiveStatusKV;
        await KV.delete('videoId');
        console.log('Cleared videoId from KV because stream ended.');
      }
    } catch (err) {
      console.error('Scheduled handler error:', err);
    }
  },
};

async function handleFetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  let path = url.pathname;

  // Only accept API requests under /api/uptime — strip that prefix and route by remainder.
  const API_PREFIX = '/api/uptime';
  if (path === API_PREFIX) {
    path = '/';
  } else if (path.startsWith(API_PREFIX + '/')) {
    path = path.slice(API_PREFIX.length);
  } else {
    // Not our API; return 404 so static asset handling (or another route) can take over
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Immediately reject any WebSocket Upgrade attempts
  const upgradeHdr = request.headers.get('Upgrade')?.toLowerCase();
  if (upgradeHdr === 'websocket') {
    return new Response(JSON.stringify({ error: 'WebSocket now disabled' }), {
      status: 426,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Short-hand to access the KV (bracket notation to allow hyphens in binding name)
  const KV = env.SwarmFM_LiveStatusKV;

  // 1) PSHB handshake (GET /webhook)
  if (path === '/webhook' && request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const topic = url.searchParams.get('hub.topic');
    const challenge = url.searchParams.get('hub.challenge');
    const verifyTok = url.searchParams.get('hub.verify_token');

    const expectedTopic = 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC2I6ta1bWX7DnEuYNvHiptQ';

    if (mode === 'subscribe' && topic === expectedTopic && verifyTok === env.VERIFY_TOKEN && challenge) {
      const leaseSeconds = Number(url.searchParams.get('hub.lease_seconds')) || 432000;
      const expiresAt = Date.now() + leaseSeconds * 1000;
      await KV.put('pshbExpires', String(expiresAt));
      return new Response(challenge, { status: 200, headers: { ...corsHeaders } });
    }

    return new Response('Invalid subscription request', { status: 400, headers: { ...corsHeaders } });
  }

  // 2) Webhook notification (POST /webhook)
  if (path === '/webhook' && request.method === 'POST') {
    const secret = env.WEBHOOK_SECRET ?? '';

    // Validate shared token header
    const token = request.headers.get('X-Webhook-Token') ?? '';
    if (!(await equals(token, secret))) {
      return new Response('Unauthorized', { status: 401, headers: { ...corsHeaders } });
    }

    // Optionally validate HMAC signature if present
    const sigHeader = request.headers.get('X-Hub-Signature-256') ?? '';
    if (sigHeader.startsWith('sha256=')) {
      const payload = await request.clone().arrayBuffer();
      const expectedBuf = await hmacSHA256(secret, payload);
      const expectedHex = Array.from(new Uint8Array(expectedBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const actualHex = sigHeader.slice(7);

      if (!(await equals(actualHex, expectedHex))) {
        return new Response('Unauthorized (bad signature)', { status: 401, headers: { ...corsHeaders } });
      }
    }

    // Parse Atom XML and extract yt:videoId
    const xml = await request.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const obj = parser.parse(xml) as any;
    const entry = Array.isArray(obj.feed?.entry) ? obj.feed.entry[0] : obj.feed?.entry;
    const videoId = entry?.['yt:videoId'];

    if (!videoId) {
      // nothing to do
      return new Response(null, { status: 204, headers: { ...corsHeaders } });
    }

    // Check if the reported video is a livestream via YouTube API
    const ytUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    ytUrl.search = new URLSearchParams({
      part: 'liveStreamingDetails',
      id: videoId,
      key: env.YT_API_KEY,
    }).toString();

    const ytRes = await fetch(ytUrl.toString());
    if (!ytRes.ok) {
      console.warn('YouTube lookup failed for', videoId);
      return new Response(null, { status: 204, headers: { ...corsHeaders } });
    }

    const data: any = await ytRes.json();
    const item = data.items?.[0];

    const isLivestream = !!item?.liveStreamingDetails;
    if (isLivestream) {
      console.log('Detected livestream:', videoId);
      await KV.put('videoId', videoId);
    } else {
      console.log('Ignoring non-livestream video:', videoId);
    }

    return new Response(null, { status: 204, headers: { ...corsHeaders } });
  }

  // 3) POST /update — authenticated update to set videoId explicitly
  if (path === '/update' && request.method === 'POST') {
    const token = request.headers.get('X-Control-Token');
    if (token !== env.UPDATE_SECRET) {
      return new Response(null, { status: 403, headers: { ...corsHeaders } });
    }

    const body = (await request.json()) as { videoId: string | null };
    if (body.videoId) await KV.put('videoId', body.videoId);
    else await KV.delete('videoId');

    return new Response(null, { status: 204, headers: { ...corsHeaders } });
  }

  // 4) Root path (GET /api/uptime -> '/')
  if (path === '/') {
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const videoId = await KV.get('videoId');
    return new Response(JSON.stringify({ live: !!videoId, videoId: videoId ?? null }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // 5) /status
  if (path === '/status' && request.method === 'GET') {
    const expires = await KV.get('pshbExpires');
    const videoId = await KV.get('videoId');

    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age: 120', ...corsHeaders });
    if (expires !== null) headers.set('x-pshb-expires', String(expires));
    return new Response(JSON.stringify({ live: !!videoId, videoId }), { headers });
  }

  // 6) /flush — query YouTube search for active live
  if (path === '/flush' && request.method === 'POST') {
    const now = Date.now();
    const COOLDOWN = 30 * 60 * 1000; // 30 minutes
    const lastFlushRaw = await KV.get('lastFlush');
    const lastFlush = lastFlushRaw ? Number(lastFlushRaw) : 0;
    const since = now - lastFlush;

    if (since < COOLDOWN) {
      const retryAfter = Math.ceil((COOLDOWN - since) / 1000);
      return new Response(
        JSON.stringify({
          error: 'Stop hitting the API.',
          retry_after: retryAfter,
          statusText: 'Cooldown is active.',
        }),
        { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }

    await KV.put('lastFlush', String(now));

    // Call YouTube Search for live events
    const ytUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    ytUrl.search = new URLSearchParams({
      part: 'id',
      channelId: 'UC2I6ta1bWX7DnEuYNvHiptQ',
      eventType: 'live',
      type: 'video',
      key: env.YT_API_KEY,
    }).toString();

    const ytRes = await fetch(ytUrl.toString());
    if (!ytRes.ok) {
      return new Response(
        JSON.stringify({ error: 'YouTube Data API error', status: ytRes.status, statusText: ytRes.statusText }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }

    const data = (await ytRes.json()) as { items?: Array<{ id: { videoId: string } }> };
    const newVid = data.items?.[0]?.id.videoId ?? null;

    if (newVid) {
      await KV.put('videoId', newVid);
    } else {
      await KV.delete('videoId');
    }

    if (!newVid) {
      return new Response(JSON.stringify({ live: false, videoId: null }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response(JSON.stringify({ live: true, videoId: newVid }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

// Helper: constant-time compare
async function equals(a: string, b: string): Promise<boolean> {
  const ua = new TextEncoder().encode(a);
  const ub = new TextEncoder().encode(b);
  if (ua.length !== ub.length) return false;
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// Helper: HMAC-SHA256
async function hmacSHA256(secret: string, data: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, data);
}
