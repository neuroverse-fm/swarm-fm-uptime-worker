import { createHmac } from 'crypto';
import { readFileSync } from 'fs';

function computeSignature(secret, payload) {
    const hmac = createHmac('sha256', secret);
    hmac.update(payload);
    return 'sha256=' + hmac.digest('hex');
}

// Check that a secret was provided as a command-line argument
if (process.argv.length < 3) {
    console.error("Usage: node signature-compute.js <WEBHOOK_SECRET>");
    process.exit(1);
}

const secret = process.argv[2];
const xmlPayload = readFileSync('test-post-notification.xml', 'utf8');

console.log('Computed signature:', computeSignature(secret, xmlPayload));