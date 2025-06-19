import fetch from 'node-fetch';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .dev.vars
config({ path: resolve(__dirname, '../.dev.vars') });

// Get the API key and video ID from environment variables
const YT_API_KEY = process.env.YT_API_KEY;
const VIDEO_ID = process.env.VIDEO_ID;

if (!YT_API_KEY) {
	console.error('Error: YT_API_KEY is not defined in .dev.vars');
	process.exit(1);
}

if (!VIDEO_ID) {
	console.error('Error: VIDEO_ID is not defined in .dev.vars');
	process.exit(1);
}

async function queryYouTubeAPI(apiKey: string, videoId: string) {
	try {
		const url = new URL('https://www.googleapis.com/youtube/v3/videos');
		url.search = new URLSearchParams({
			part: 'snippet,liveStreamingDetails',
			id: videoId,
			key: apiKey,
		}).toString();

		const response = await fetch(url.toString());
		if (!response.ok) {
			console.error(`YouTube API Error: ${response.status} ${response.statusText}`);
			return;
		}

		const data = await response.json();
		console.log('YouTube API Response:', JSON.stringify(data, null, 2));
	} catch (error) {
		if (error instanceof Error) {
			console.error('Error querying YouTube API:', error.message);
		} else {
			console.error('Error querying YouTube API:', error);
		}
	}
}

// Run the query
queryYouTubeAPI(YT_API_KEY, VIDEO_ID);
