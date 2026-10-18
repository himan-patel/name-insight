// Generates a new random API key and the SHA-256 digest to configure on the server.
// The key is printed to YOUR terminal only: store it in a secret manager / password manager.
// Never commit it, paste it into issues or PRs, or put it in .env files that are tracked by git.
import { createHash, randomBytes } from 'node:crypto';

const key = `ni_${randomBytes(32).toString('base64url')}`;
const digest = createHash('sha256').update(key, 'utf8').digest('hex');

console.log(`
API key (give to the client; shown once):
  ${key}

Server setting (add the digest; separate multiple digests with commas):
  API_KEYS_SHA256=${digest}

Clients send it as:  Authorization: Bearer <key>   or   X-API-Key: <key>
`);
