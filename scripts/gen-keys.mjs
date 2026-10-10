import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const oneLine = (pem) => pem.trim().replace(/\n/g, '\n');
console.log(`JWT_PRIVATE_KEY="${oneLine(privateKey.export({ type: 'pkcs8', format: 'pem' }))}"`);
console.log(`JWT_PUBLIC_KEY="${oneLine(publicKey.export({ type: 'spki', format: 'pem' }))}"`);
console.log(`DATA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
