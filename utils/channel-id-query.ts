import fetch from 'node-fetch';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .dev.vars
config({ path: resolve(__dirname, '../.dev.vars') });

// Get the API key from environment variables
const YT_API_KEY = process.env.YT_API_KEY;

if (!YT_API_KEY) {
	console.error('Error: YT_API_KEY is not defined in .dev.vars');
	process.exit(1);
}

// Get the channel ID from command line arguments
if (process.argv.length < 3) {
	console.error('Usage: tsx ./utils/channel-id-query.ts <CHANNEL_ID>');
	console.error('Example: tsx ./utils/channel-id-query.ts UC2I6ta1bWX7DnEuYNvHiptQ');
	process.exit(1);
}

const CHANNEL_ID = process.argv[2];

// Detect if output is being piped or redirected
const isCliMode = !process.stdout.isTTY;

async function queryChannelDetails(apiKey: string, channelId: string) {
	try {
		const url = new URL('https://www.googleapis.com/youtube/v3/channels');
		url.search = new URLSearchParams({
			part: 'snippet,statistics',
			id: channelId,
			key: apiKey,
		}).toString();

		// Always log fetching activity to stderr (won't interfere with piped output)
		console.error(`Querying YouTube API for channel: ${channelId}`);

		const response = await fetch(url.toString());
		if (!response.ok) {
			const errorMessage = `YouTube API Error: ${response.status} ${response.statusText}`;
			if (isCliMode) {
				// In CLI mode, output error as JSON to stderr
				console.error(JSON.stringify({ error: errorMessage }, null, 2));
			} else {
				console.error(errorMessage);
			}
			return;
		}

		const data = await response.json();

		if (isCliMode) {
			// CLI mode: output formatted JSON to stdout
			console.log(JSON.stringify(data, null, 2));
		} else {
			// Interactive mode: output with labels and formatting
			console.log('YouTube API Response:', JSON.stringify(data, null, 2));
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		if (isCliMode) {
			// In CLI mode, output error as formatted JSON to stderr
			console.error(JSON.stringify({ error: 'Error querying YouTube API', message: errorMessage }, null, 2));
		} else {
			console.error('Error querying YouTube API:', errorMessage);
		}
	}
}

// Run the query
queryChannelDetails(YT_API_KEY, CHANNEL_ID);
