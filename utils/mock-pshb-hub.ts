import fetch from 'node-fetch';
import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { computeSignature } from './signature-compute'; // Import the signature computation function

// Load environment variables from .dev.vars
config({ path: resolve(__dirname, '../.dev.vars') });

// Get the webhook secret and verify token from environment variables
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

if (!WEBHOOK_SECRET || !VERIFY_TOKEN) {
	console.error('Error: WEBHOOK_SECRET or VERIFY_TOKEN is not defined in .dev.vars');
	process.exit(1);
}

// Get the webhook URL, mode (GET or POST), and payload mode from command line arguments
if (process.argv.length < 4) {
	console.error('Usage: tsx ./utils/mock-pshb-hub.ts <WEBHOOK_URL> <MODE> [--mode=onstream|video]');
	console.error('Example: tsx ./utils/mock-pshb-hub.ts https://example.com/webhook POST --mode=onstream');
	process.exit(1);
}

const WEBHOOK_URL = process.argv[2];
const MODE = process.argv[3].toUpperCase();
const PAYLOAD_MODE = process.argv.includes('--video');

// Validate mode
if (MODE !== 'GET' && MODE !== 'POST') {
	console.error('Error: MODE must be either "GET" or "POST"');
	process.exit(1);
}

// Hardcoded hub topic
const HUB_TOPIC = 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC2I6ta1bWX7DnEuYNvHiptQ';

// Detect if output is being piped or redirected
const isCliMode = !process.stdout.isTTY;

async function mockPSHBHub(webhookUrl: string, mode: string, payloadMode: boolean) {
	try {
		if (mode === 'GET') {
			// Simulate a subscription handshake (GET request)
			const url = new URL(webhookUrl);
			url.search = new URLSearchParams({
				'hub.mode': 'subscribe',
				'hub.topic': HUB_TOPIC,
				'hub.challenge': 'test-challenge',
				'hub.verify_token': VERIFY_TOKEN!,
			}).toString();

			console.error(`Sending PSHB GET request to: ${url.toString()}`);

			const response = await fetch(url.toString(), { method: 'GET' });

			if (!response.ok) {
				const errorMessage = `PSHB GET request failed: ${response.status} ${response.statusText}`;
				if (isCliMode) {
					console.error(JSON.stringify({ error: errorMessage }, null, 2));
				} else {
					console.error(errorMessage);
				}
				return;
			}

			const successMessage = `PSHB GET request succeeded: ${await response.text()}`;
			if (isCliMode) {
				console.log(JSON.stringify({ success: successMessage }, null, 2));
			} else {
				console.log(successMessage);
			}
		} else if (mode === 'POST') {
			// Determine payload based on payload mode
			let payload: string;
			if (!payloadMode) {
				// Use the test post notification XML file
				payload = readFileSync('./utils/test-post-notification.xml', 'utf8');
			} else {
				// Use the current hardcoded payload
				payload = `
                    <feed xmlns="http://www.w3.org/2005/Atom">
                        <entry>
                            <yt:videoId xmlns:yt="http://www.youtube.com/xml/schemas/2015">dQw4w9WgXcQ</yt:videoId>
                        </entry>
                    </feed>
                `;
			}

			const signature = computeSignature(WEBHOOK_SECRET!, payload);

			console.error(`Sending PSHB POST request to: ${webhookUrl}`);
			console.error(`Payload: ${payload}`);
			console.error(`Computed Signature: ${signature}`);

			const response = await fetch(webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/xml',
					'X-Hub-Signature-256': signature,
					'X-Webhook-Token': WEBHOOK_SECRET!,
				},
				body: payload,
			});

			if (!response.ok) {
				const errorMessage = `PSHB POST request failed: ${response.status} ${response.statusText}`;
				if (isCliMode) {
					console.error(JSON.stringify({ error: errorMessage }, null, 2));
				} else {
					console.error(errorMessage);
				}
				return;
			}

			const successMessage = `PSHB POST request succeeded: ${await response.text()}`;
			if (isCliMode) {
				console.log(JSON.stringify({ success: successMessage }, null, 2));
			} else {
				console.log(successMessage);
			}
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		if (isCliMode) {
			console.error(JSON.stringify({ error: 'Error mocking PSHB hub', message: errorMessage }, null, 2));
		} else {
			console.error('Error mocking PSHB hub:', errorMessage);
		}
	}
}

// Run the mock PSHB hub
mockPSHBHub(WEBHOOK_URL, MODE, PAYLOAD_MODE);
