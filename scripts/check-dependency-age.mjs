// Supply-chain check: lists production dependencies (including transitive ones) published less than MIN_AGE_DAYS ago.
// Usage: npm run deps:age   (needs network access to the npm registry; exits 1 if any are too new)
import { execFileSync } from 'node:child_process';

const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS ?? 14);
const cutoff = Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const packages = new Map();
(function walk(node) {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
        if (child.version) {
            packages.set(`${name}@${child.version}`, { name, version: child.version });
        }
        walk(child);
    }
})(tree);

const tooNew = [];
await Promise.all([...packages.values()].map(async ({ name, version }) => {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, { headers: { accept: 'application/json' } });
    if (!response.ok) {
        tooNew.push(`${name}@${version} (registry lookup failed: HTTP ${response.status})`);
        return;
    }
    const published = (await response.json()).time?.[version];
    if (!published || Date.parse(published) > cutoff) {
        tooNew.push(`${name}@${version} (published ${published ?? 'unknown'})`);
    }
}));

if (tooNew.length) {
    console.error(`Production dependencies newer than ${MIN_AGE_DAYS} days:\n  ${tooNew.sort().join('\n  ')}`);
    console.error('Pin an older version with "overrides" in package.json, or wait.');
    process.exit(1);
}
console.log(`All ${packages.size} production dependencies are at least ${MIN_AGE_DAYS} days old.`);
