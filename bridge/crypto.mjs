import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, timingSafeEqual } from 'node:crypto';

export const challengeMessage = (host, nonce) => Buffer.from('memo-bridge-agent-v1\n' + host + '\n' + nonce, 'utf8');
export const nonce = () => randomBytes(32).toString('base64url');
export function generateAgentIdentity() {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({type:'pkcs8',format:'pem'}),
    publicKey: publicKey.export({type:'spki',format:'pem'})
  };
}
export function signChallenge(host, value, pem) {
  return sign(null, challengeMessage(host,value), createPrivateKey(pem)).toString('base64url');
}
export function verifyChallenge(host,value,signature,pem) {
  try { return verify(null, challengeMessage(host,value), createPublicKey(pem), Buffer.from(signature,'base64url')); }
  catch { return false; }
}
export function keyFingerprint(pem) { return createHash('sha256').update(createPublicKey(pem).export({type:'spki',format:'der'})).digest('hex').slice(0,16); }
export function bearerValid(header, tokenSha256) {
  if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header) || !/^[0-9a-f]{64}$/.test(tokenSha256)) return false;
  const digest = createHash('sha256').update(header.slice(7)).digest();
  return timingSafeEqual(digest,Buffer.from(tokenSha256,'hex'));
}
