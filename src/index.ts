import { XMLParser } from 'fast-xml-parser';

const corsHeaders: { [key: string]: string } = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST',
	'Access-Control-Allow-Headers': 'Content-Type',
};

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

	// Helper to add logs directly to the file
	private addLog(message: string): void {
		const timestamp = new Date().toISOString();
		const logEntry = `[${timestamp}] ${message}\n`;
		console.log(logEntry.trim());
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
				return new Response(challenge, { status: 200, headers: { ...corsHeaders } });
			}

			return new Response('Invalid subscription request', { status: 400, headers: { ...corsHeaders } });
		}

		//
		// 2) Webhook notification (POST /webhook)
		//
		if (path === '/webhook' && request.method === 'POST') {
			this.addLog('Webhook notification received');

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
			this.addLog('Update request received');

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
				await server.accept();
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
			this.addLog('Status requested');

			const videoId = await this.state.storage.get('videoId');
			return new Response(JSON.stringify({ live: !!videoId, videoId }), {
				headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age: 120', ...corsHeaders },
			});
		}

		//
		// 6) Flush & re-search API
		//
		if (path === '/flush' && request.method === 'POST') {
			this.addLog('Flush request received');

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
		this.addLog(`Unknown route accessed: ${path}`);
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
		const statusRes = await stub.fetch('/api/uptime/status');
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
			await stub.fetch('/api/uptime/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Control-Token': env.UPDATE_SECRET },
				body: JSON.stringify({ videoId: null }),
			});
		}
	},
};
