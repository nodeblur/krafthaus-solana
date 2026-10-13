// Shared browser/local policy boundary. No wallet, owner issuer or network transport.
const fields = ['schema_version','obligation_id','invoice_id','milestone_id','delivery_sha256','recipient','lamports','cluster'];
const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function validAddress(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let integer = 0n;
  for (const char of value) integer = integer * 58n + BigInt(base58.indexOf(char));
  let bytes = 0;
  while (integer) {bytes++; integer /= 256n;}
  for (const char of value) {if (char !== '1') break; bytes++;}
  return bytes === 32;
}
function plain(value) {return value && typeof value === 'object' && !Array.isArray(value);}
function canonical(value, keys) {
  return JSON.stringify(Object.fromEntries([...keys].sort().map(key => [key, value[key]])));
}
function validAgreement(value) {
  return plain(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value,key)) &&
    value.schema_version === 'krafthaus_contractor_agreement_v1' && value.cluster === 'devnet' &&
    ['obligation_id','invoice_id','milestone_id'].every(key => typeof value[key] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value[key])) &&
    /^[a-f0-9]{64}$/.test(value.delivery_sha256) && validAddress(value.recipient) &&
    Number.isSafeInteger(value.lamports) && value.lamports > 0 && value.lamports <= 1000000;
}
export async function agreementHash(agreement) {
  if (!validAgreement(agreement)) throw Error('INVALID_AGREEMENT');
  const bytes = new TextEncoder().encode(canonical(agreement,fields));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
const acceptanceFields = ['schema_version','agreement_hash','accepted_at'];
function validAcceptance(record) {
  return plain(record) && record.schema_version === 'krafthaus_owner_acceptance_v1' &&
    /^[a-f0-9]{64}$/.test(record.agreement_hash) && typeof record.accepted_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.accepted_at) &&
    Number.isFinite(Date.parse(record.accepted_at)) && new Date(record.accepted_at).toISOString() === record.accepted_at;
}
export function acceptanceSigningBytes(record) {
  if (!validAcceptance(record)) throw Error('OWNER_ACCEPTANCE_INVALID');
  return new TextEncoder().encode('KRAFTHAUS_OWNER_ACCEPTANCE_V1\n' + canonical(record,acceptanceFields));
}
const digestHex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function verifyAcceptance(agreement, acceptance, trustedOwnerSpkiBase64, {now = Date.now()} = {}) {
  // Snapshot before the first await so an agent cannot mutate evidence mid-verification.
  try {agreement = structuredClone(agreement); acceptance = structuredClone(acceptance);} catch {return {verdict:'BLOCK',code:'INVALID_AGREEMENT'};}
  let hash;
  try {hash = await agreementHash(agreement);} catch {return {verdict:'BLOCK',code:'INVALID_AGREEMENT'};}
  if (acceptance == null) return {verdict:'DEFER',code:'OWNER_ACCEPTANCE_MISSING',agreementHash:hash};
  const blocked = code => ({verdict:'BLOCK',code,agreementHash:hash});
  if (!validAcceptance(acceptance) || Object.keys(acceptance).length !== 4 ||
      ![...acceptanceFields,'signature_base64'].every(key=>Object.hasOwn(acceptance,key)) ||
      !/^[A-Za-z0-9+/]{86}==$/.test(acceptance.signature_base64) || !Number.isFinite(now) || Date.parse(acceptance.accepted_at) > now + 30000) return blocked('OWNER_ACCEPTANCE_INVALID');
  if (acceptance.agreement_hash !== hash) return blocked('ACCEPTANCE_SCOPE_MISMATCH');
  try {
    if (typeof trustedOwnerSpkiBase64 !== 'string' || !/^[A-Za-z0-9+/]{16,256}={0,2}$/.test(trustedOwnerSpkiBase64)) return blocked('OWNER_KEY_INVALID');
    const keyBytes = Uint8Array.from(atob(trustedOwnerSpkiBase64),c=>c.charCodeAt(0));
    const signature = Uint8Array.from(atob(acceptance.signature_base64),c=>c.charCodeAt(0));
    const key = await crypto.subtle.importKey('spki',keyBytes,{name:'Ed25519'},false,['verify']);
    const bytes = acceptanceSigningBytes(acceptance);
    if (!await crypto.subtle.verify('Ed25519',key,signature,bytes)) return blocked('OWNER_SIGNATURE_INVALID');
    return {verdict:'APPROVE',code:'OWNER_ACCEPTANCE_VERIFIED',agreementHash:hash,acceptanceHash:await digestHex(new Uint8Array([...bytes,...signature])),ownerKeyId:await digestHex(keyBytes)};
  } catch {return blocked('OWNER_SIGNATURE_INVALID');}
}
