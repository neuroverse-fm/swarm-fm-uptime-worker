/// <reference path="../worker-configuration.d.ts" />

import { XMLParser } from 'fast-xml-parser';

const corsHeaders: { [key: string]: string } = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST',
	'Access-Control-Allow-Headers': 'Content-Type',
};
const baseWorkerUrl = "https://uptime.sw.arm.fm"

export class LiveStatusDO {
	private state: DurableObjectState;
	private env: Env;
	private clients = new Set<WebSocket>();

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
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
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		return crypto.subtle.sign('HMAC', key, data);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		let path = url.pathname;

		// —— STRIP OFF THE FIRST PATH SEGMENT ——
		// e.g. /alerts/webhook   =>  /webhook
		//      /alerts/ws        =>  /ws
		//      /alerts           =>  /
		const MOUNT: string = '/api/uptime';
		if (path === MOUNT) {
			path = '/';
		} else if (path.startsWith(MOUNT + '/')) {
			path = path.slice(MOUNT.length);
		}

		//
		// 1) PubSubHubbub subscription handshake (GET)
		//
		if (path === '/webhook' && request.method === 'GET') {
			const mode = url.searchParams.get('hub.mode');
			const topic = url.searchParams.get('hub.topic');
			const challenge = url.searchParams.get('hub.challenge');
			const verifyTok = url.searchParams.get('hub.verify_token');

			const expectedTopic = 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC2I6ta1bWX7DnEuYNvHiptQ';

			if (mode === 'subscribe' && topic === expectedTopic && verifyTok === this.env.VERIFY_TOKEN && challenge) {
				const leaseSeconds = Number(url.searchParams.get("hub.lease_seconds")) ?? 432_000;
				const expiresAt = Date.now() + leaseSeconds * 1000;
				await this.state.storage.put("pshbExpires", expiresAt)
				return new Response(challenge, { status: 200, headers: { ...corsHeaders } });
			}

			return new Response('Invalid subscription request', { status: 400, headers: { ...corsHeaders } });
		}

		//
		// 2) Webhook notification (POST /webhook)
		//
		if (path === '/webhook' && request.method === 'POST') {
			const secret = this.env.WEBHOOK_SECRET;

			// Validate shared secret
			const token = request.headers.get('X-Webhook-Token') ?? '';
			if (!(await this.equals(token, secret))) {
				return new Response('Unauthorized', { status: 401, headers: { ...corsHeaders } });
			}

			// Validate optional HMAC signature
			const sigHeader = request.headers.get('X-Hub-Signature-256') ?? '';
			if (sigHeader.startsWith('sha256=')) {
				const payload = await request.clone().arrayBuffer();
				const expectedBuf = await this.hmacSHA256(secret, payload);
				const expectedHex = Array.from(new Uint8Array(expectedBuf))
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('');
				const actualHex = sigHeader.slice(7);

				if (!(await this.equals(actualHex, expectedHex))) {
					return new Response('Unauthorized (bad signature)', { status: 401, headers: { ...corsHeaders } });
				}
			}

			// Parse Atom XML to get videoId
			const xml = await request.text();
			const parser = new XMLParser({ ignoreAttributes: false });
			const obj = parser.parse(xml) as any;
			const entry = Array.isArray(obj.feed.entry) ? obj.feed.entry[0] : obj.feed.entry;
			const videoId = entry?.['yt:videoId'];

			if (!videoId) {
				return new Response(null, { status: 204, headers: { ...corsHeaders } }); // no video ID, nothing to do
			}

			// Fetch video metadata from YouTube
			const url = new URL('https://www.googleapis.com/youtube/v3/videos');
			url.search = new URLSearchParams({
				part: 'liveStreamingDetails',
				id: videoId,
				key: this.env.YT_API_KEY,
			}).toString();

			const ytRes = await fetch(url.toString());
			if (!ytRes.ok) {
				console.warn(`YouTube lookup failed for ${videoId}`);
				return new Response(null, { status: 204, headers: { ...corsHeaders } });
			}

			const data: any = await ytRes.json();
			const item = data.items?.[0];

			// Check if this video is a livestream
			const isLivestream = !!item?.liveStreamingDetails;

			if (isLivestream) {
				console.log(`Detected livestream: ${videoId}`);

				await this.state.storage.put('videoId', videoId);
				for (const ws of this.clients) {
					ws.send(JSON.stringify({ live: true, videoId }));
				}
			} else {
				console.log(`Ignoring non-livestream video: ${videoId}`);
			}

			return new Response(null, { status: 204, headers: { ...corsHeaders } });
		}

		//
		// 3) Scheduled “update” from the cron (POST /update)
		//
		if (path === '/update' && request.method === 'POST') {
			const token = request.headers.get('X-Control-Token');
			if (token !== this.env.UPDATE_SECRET) {
				return new Response(null, { status: 403, headers: { ...corsHeaders } });
			}

			const { videoId } = (await request.json()) as { videoId: string | null };
			if (videoId) {
				await this.state.storage.put('videoId', videoId);
			} else {
				await this.state.storage.delete('videoId');
			}
			// broadcast new state
			for (const ws of this.clients) {
				ws.send(JSON.stringify({ live: !!videoId, videoId }));
			}
			return new Response(null, { status: 204, headers: { ...corsHeaders } });
		}

		//
		// 4) WebSocket upgrade (GET /ws)
		//
		if (path === '/') {
			const upgrade = request.headers.get('Upgrade')?.toLowerCase();
			if (upgrade === 'websocket') {
				const [client, server] = Object.values(new WebSocketPair());
				server.accept();
				this.clients.add(server);
				server.addEventListener('close', () => this.clients.delete(server));

				// send current state immediately
				const current = await this.state.storage.get('videoId');
				server.send(JSON.stringify({ live: !!current, videoId: current }));

				return new Response(null, { status: 101, webSocket: client, headers: { ...corsHeaders } });
			} else {
				return new Response(JSON.stringify({ error: 'Expected WebSocket upgrade on / (or /api/uptime)' }), {
					status: 426,
					headers: { 'Content-Type': 'application/json', Upgrade: 'websocket', ...corsHeaders },
				});
			}
		}

		//
		// 5) Backup /status route
		//
		if (path === '/status' && request.method === 'GET') {
			const expires = await this.state.storage.get('pshbExpires');
			const videoId = await this.state.storage.get('videoId');

			const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age: 120', ...corsHeaders });
			if (expires !== undefined) {
				headers.set('x-pshb-expires', String(expires));
			}
			return new Response(JSON.stringify({ live: !!videoId, videoId }), {
				headers,
			});
		}

		//
		// 6) Flush & re-search API
		//
		if (path === '/flush' && request.method === 'POST') {
			const now = Date.now();
			const COOLDOWN = 30 * 60 * 1000; // 30 minutes
			const lastFlush = (await this.state.storage.get<number>('lastFlush')) ?? 0;
			const since = now - lastFlush;

			if (since < COOLDOWN) {
				const retryAfter = Math.ceil((COOLDOWN - since) / 1000);
				return new Response(
					JSON.stringify({
						error: 'Stop hitting the API.',
						retry_after: retryAfter, // seconds
						statusText: 'Cooldown is active.',
					}),
					{
						status: 429,
						headers: { 'Content-Type': 'application/json', ...corsHeaders },
					},
				);
			}

			// mark this flush so next can only happen after 30m
			await this.state.storage.put('lastFlush', now);

			// 1) Query the YouTube API for any live stream
			const ytUrl = new URL('https://www.googleapis.com/youtube/v3/search');
			ytUrl.search = new URLSearchParams({
				part: 'id',
				channelId: 'UC2I6ta1bWX7DnEuYNvHiptQ',
				eventType: 'live',
				type: 'video',
				key: this.env.YT_API_KEY,
			}).toString();

			const ytRes = await fetch(ytUrl.toString());
			if (!ytRes.ok) {
				return new Response(
					JSON.stringify({
						error: 'YouTube Data API error',
						status: ytRes.status,
						statusText: ytRes.statusText,
					}),
					{ status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
				);
			}

			const data = (await ytRes.json()) as { items?: Array<{ id: { videoId: string } }> };
			const newVid = data.items?.[0]?.id.videoId ?? null;

			// 2) Update state & broadcast
			//    — set to null explicitly if no livestream
			await this.state.storage.put('videoId', newVid);

			for (const ws of this.clients) {
				ws.send(JSON.stringify({ live: !!newVid, videoId: newVid }));
			}

			// 3) Return success or a 404 if nothing live
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

		// Default response for unknown routes
		return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...corsHeaders } });
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			const id = env.LIVE_DO.idFromName('singleton');
			const stub = env.LIVE_DO.get(id);
			return await stub.fetch(request);
		} catch (err: any) {
			console.error('Error in fetch handler:', err);
			return new Response(JSON.stringify({ error: err?.message ?? 'Unknown error' }), {
				status: err?.status || 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	},

	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		const id = env.LIVE_DO.idFromName('singleton');
		const stub = env.LIVE_DO.get(id);

		const statusRes = await stub.fetch(baseWorkerUrl + '/api/uptime/status');
		if (!statusRes.ok) {
			console.error('Status fetch failed: ', statusRes.status);
			return;
		}

		const expiryHeader = statusRes.headers.get('x-pshb-expires');
		let expires: Date | null = null;
		if (expiryHeader) {
			const expireAt = Number(expiryHeader);
			if (!Number.isNaN(expireAt)) {
				expires = new Date(expireAt);
				console.log("PSHB sub expires at", expires)
			} else {
				console.warn("PSHB header is invalid, header: ", expiryHeader)
			}
		} else {
			console.error("No PSHB header returned.")
		}

		const now = Date.now()

		const leaseSec = Number(env.PSHB_LEASE_SECONDS || "432000");
		const renewWindow = (leaseSec * 1000) * 0.10;

		// @ts-ignore
		if (expires && expires - now < renewWindow) {
			const form = new URLSearchParams({
				"hub.mode": "subscribe",
				"hub.topic": "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC2I6ta1bWX7DnEuYNvHiptQ",
				"hub.callback": "https://swarm-fm-uptime-worker.ktrain5169.workers.dev/webhook",
				"hub.verify": "async",
				"hub.verify_token": env.VERIFY_TOKEN,
				"hub.secret": env.WEBHOOK_SECRET,
				"hub.lease_seconds": leaseSec.toString()
			})

			stub.fetch("https://pubsubhubbub.appspot.com/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form.toString()
			}).then(async res => {
				if (res.ok) {
					console.log("PSHB sub renewed")
				} else {
					console.error("PSHB sub renew failed: ", res.status)
				}
			}).catch(err => {
				console.error("PSHB renew error: ", err)
			})
		}

		if (!env.ENABLE_SCHEDULED || env.ENABLE_SCHEDULED !== "true") return;

		const { videoId } = (await statusRes.json()) as { videoId: string | null };

		if (!videoId) return;

		const url = new URL('https://www.googleapis.com/youtube/v3/videos');
		url.search = new URLSearchParams({
			part: 'liveStreamingDetails',
			id: videoId,
			key: env.YT_API_KEY,
		}).toString();

		const ytRes = await fetch(url.toString());
		if (!ytRes.ok) {
			console.warn(`Encountered an error with YouTube API: ${JSON.stringify(ytRes)}`);
			return;
		}

		const data = (await ytRes.json()) as {
			items?: Array<{
				liveStreamingDetails?: {
					actualStartTime?: string;
					actualEndTime?: string;
				};
			}>;
		};
		const item = data.items?.[0];
		const details = item?.liveStreamingDetails;

		const hasEnded = !details || !!details.actualEndTime;
		if (hasEnded) {
			await stub.fetch(baseWorkerUrl + '/api/uptime/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Control-Token': env.UPDATE_SECRET },
				body: JSON.stringify({ videoId: null }),
			});
		}
	},
};
