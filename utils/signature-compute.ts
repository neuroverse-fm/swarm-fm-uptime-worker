import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .dev.vars
config({ path: resolve(__dirname, '../.dev.vars') });

// Get the webhook secret from environment variables
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
	console.error('Error: WEBHOOK_SECRET is not defined in .dev.vars');
	process.exit(1);
}

// Get the XML file path from command line arguments
if (process.argv.length < 3) {
	console.error('Usage: tsx ./utils/signature-compute.ts <XML_FILE_PATH>');
	console.error('Example: tsx ./utils/signature-compute.ts test-post-notification.xml');
	process.exit(1);
}

const xmlFilePath = process.argv[2];

// Detect if output is being piped or redirected
const isCliMode = !process.stdout.isTTY;

export function computeSignature(secret: string, payload: string): string {
	const hmac = createHmac('sha256', secret);
	hmac.update(payload);
	return 'sha256=' + hmac.digest('hex');
}

try {
	// Always log reading activity to stderr (won't interfere with piped output)
	console.error(`Reading XML payload from: ${xmlFilePath}`);

	const xmlPayload = readFileSync(xmlFilePath, 'utf8');
	const signature = computeSignature(WEBHOOK_SECRET, xmlPayload);

	if (isCliMode) {
		// CLI mode: output only the signature to stdout
		console.log(signature);
	} else {
		// Interactive mode: output with label
		console.log('Computed signature:', signature);
	}
} catch (error) {
	const errorMessage = error instanceof Error ? error.message : String(error);

	if (isCliMode) {
		// In CLI mode, output error as JSON to stderr
		console.error(
			JSON.stringify(
				{
					error: 'Error computing signature',
					message: errorMessage,
				},
				null,
				2,
			),
		);
	} else {
		console.error('Error computing signature:', errorMessage);
	}
	process.exit(1);
}
