import fetch from 'node-fetch';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .dev.vars
config({ path: resolve(__dirname, '../.dev.vars') });

// Get the VERIFY_TOKEN and WEBHOOK_SECRET from environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!VERIFY_TOKEN || !WEBHOOK_SECRET) {
    console.error('Error: VERIFY_TOKEN or WEBHOOK_SECRET is not defined in .dev.vars');
    process.exit(1);
}

// Get the webhook URL and mode (subscribe/unsubscribe) from command line arguments
if (process.argv.length < 4) {
    console.error('Usage: tsx ./utils/pshb-subscript.ts <WEBHOOK_URL> <MODE>');
    console.error('Example: tsx ./utils/pshb-subscript.ts https://example.com/webhook subscribe');
    process.exit(1);
}

const WEBHOOK_URL = process.argv[2];
const MODE = process.argv[3].toLowerCase();

// Validate mode
if (MODE !== 'subscribe' && MODE !== 'unsubscribe') {
    console.error('Error: MODE must be either "subscribe" or "unsubscribe"');
    process.exit(1);
}

// Hardcoded hub topic
const HUB_TOPIC = 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC2I6ta1bWX7DnEuYNvHiptQ';

// Detect if output is being piped or redirected
const isCliMode = !process.stdout.isTTY;

async function firePSHBRequest(webhookUrl: string, mode: string) {
    try {
        const form = new URLSearchParams({
            'hub.mode': mode,
            'hub.topic': HUB_TOPIC,
            'hub.callback': webhookUrl,
            'hub.verify': 'async',
            'hub.verify_token': VERIFY_TOKEN!,
            'hub.secret': WEBHOOK_SECRET!,
        });

        // Only include lease_seconds for subscribe
        if (mode === 'subscribe') {
            form.append('hub.lease_seconds', '432000');
        }

        const url = 'https://pubsubhubbub.appspot.com/subscribe';

        // Always log fetching activity to stderr (won't interfere with piped output)
        console.error(`Sending PSHB ${mode} request to: ${url}`);
        console.error(`Form data: ${form.toString()}`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
        });

        if (!response.ok) {
            const errorMessage = `PSHB ${mode} request failed: ${response.status} ${response.statusText}`;
            if (isCliMode) {
                // In CLI mode, output error as JSON to stderr
                console.error(JSON.stringify({ error: errorMessage }, null, 2));
            } else {
                console.error(errorMessage);
            }
            return;
        }

        const successMessage = `PSHB ${mode} request succeeded`;
        if (isCliMode) {
            // CLI mode: output success message as JSON to stdout
            console.log(JSON.stringify({ success: successMessage }, null, 2));
        } else {
            // Interactive mode: output success message
            console.log(successMessage);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (isCliMode) {
            // In CLI mode, output error as formatted JSON to stderr
            console.error(JSON.stringify({ error: 'Error sending PSHB request', message: errorMessage }, null, 2));
        } else {
            console.error('Error sending PSHB request:', errorMessage);
        }
    }
}

// Run the PSHB request
firePSHBRequest(WEBHOOK_URL, MODE);
