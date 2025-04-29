import { XMLParser } from 'fast-xml-parser';

interface Env {
	LIVE_DO: DurableObjectNamespace;
	UPDATE_SECRET: string;
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
		const MOUNT = '/api/uptime';
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
				return new Response(challenge, { status: 200 });
			}

			return new Response('Invalid subscription request', { status: 400 });
		}

		//
		// 2) Webhook notification (POST /webhook)
		//
		if (path === '/webhook' && request.method === 'POST') {
			const secret = this.env.WEBHOOK_SECRET;

			// Validate shared secret
			const token = request.headers.get('X-Webhook-Token') ?? '';
			if (!(await this.equals(token, secret))) {
				return new Response('Unauthorized', { status: 401 });
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
					return new Response('Unauthorized (bad signature)', { status: 401 });
				}
			}

			// Parse Atom XML to get videoId
			const xml = await request.text();
			const parser = new XMLParser({ ignoreAttributes: false });
			const obj = parser.parse(xml) as any;
			const entry = Array.isArray(obj.feed.entry) ? obj.feed.entry[0] : obj.feed.entry;
			const videoId = entry?.['yt:videoId'];

			if (!videoId) {
				return new Response(null, { status: 204 }); // no video ID, nothing to do
			}

			// Fetch video metadata from YouTube
			const url = new URL('https://www.googleapis.com/youtube/v3/videos');
			url.search = new URLSearchParams({
				part: 'snippet,liveStreamingDetails',
				id: videoId,
				key: this.env.YT_API_KEY,
			}).toString();

			const ytRes = await fetch(url.toString());
			if (!ytRes.ok) {
				console.warn(`YouTube lookup failed for ${videoId}`);
				return new Response(null, { status: 204 });
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

			return new Response(null, { status: 204 });
		}

		//
		// 3) Scheduled “update” from the cron (POST /update)
		//
		if (path === '/update' && request.method === 'POST') {
			const token = request.headers.get('X-Control-Token');
			if (token !== this.env.UPDATE_SECRET) {
				return new Response(null, { status: 403 });
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
			return new Response(null, { status: 204 });
		}

		//
		// 4) WebSocket upgrade (GET /ws)
		//
		if (path === '/') {
			const upgrade = request.headers.get('Upgrade')?.toLowerCase();
			if (upgrade === 'websocket') {
				const [client, server] = Object.values(new WebSocketPair());
				await server.accept();
				this.clients.add(server);
				server.addEventListener('close', () => this.clients.delete(server));

				// send current state immediately
				const current = await this.state.storage.get('videoId');
				server.send(JSON.stringify({ live: !!current, videoId: current }));

				return new Response(null, { status: 101, webSocket: client });
			} else {
				return new Response(JSON.stringify({ error: 'Expected WebSocket upgrade on /ws' }), {
					status: 426,
					headers: { 'Content-Type': 'application/json', Upgrade: 'websocket' },
				});
			}
		}

		//
		// 5) Backup /status route
		//
		if (path === '/status' && request.method === 'GET') {
			const videoId = await this.state.storage.get('videoId');
			return new Response(JSON.stringify({ live: !!videoId, videoId }), {
				headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age: 120' },
			});
		}

		return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// All HTTP traffic is routed into the singleton DO
		const id = env.LIVE_DO.idFromName('singleton');
		const stub = env.LIVE_DO.get(id);
		return stub.fetch(request);
	},

	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		// 1) Get the DO stub and current videoId
		const id = env.LIVE_DO.idFromName('singleton');
		const stub = env.LIVE_DO.get(id);
		const statusRes = await stub.fetch('https://dummy/status');
		const { videoId } = (await statusRes.json()) as { videoId: string | null };

		// 2) If we're not live (no videoId), bail out—no API call
		if (!videoId) return;

		// 3) Check the single video via videos.list
		const url = new URL('https://www.googleapis.com/youtube/v3/videos');
		url.search = new URLSearchParams({
			part: 'liveStreamingDetails',
			id: videoId,
			key: env.YT_API_KEY,
		}).toString();

		const ytRes = await fetch(url.toString());
		if (!ytRes.ok) {
			console.log(`Encountered an error with YouTube API: ${JSON.stringify(ytRes)}}`)
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

		// 4) Determine if the stream has ended:
		//    - If there's no liveStreamingDetails, or actualEndTime is set ⇒ ended
		const hasEnded = !details || !!details.actualEndTime;
		if (hasEnded) {
			// clear state & broadcast “went offline”
			await stub.fetch('https://dummy/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ videoId: null }),
			});
		}
		// otherwise: still live → do nothing
	},
};
