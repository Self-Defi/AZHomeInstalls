import { publicSourceUrl, resolvePublicAddresses } from './public-source-network.js';

// This module runs behind Cloudflare's public-only global fetch egress guard.
// wrangler.jsonc MUST retain global_fetch_strictly_public: it prevents an own-zone
// URL from bypassing the public edge and accessing a privileged origin. The
// runtime rejects private destinations at connection time, including DNS changes
// after our preflight. A DNS check alone is NOT rebinding protection.
// Self-hosted workerd must use a globalOutbound network restricted to "public".
export function createPublicSourceFetcher({lookupFetch=(...args)=>globalThis.fetch(...args),publicFetch=(...args)=>globalThis.fetch(...args)}={}) {
 return async function fetchPublicSource(value,{signal=AbortSignal.timeout(10000)}={}) {
  if(!publicSourceUrl(value))throw Error('Source URL is not public HTTPS');
  signal.throwIfAborted();
  const url=new URL(value);
  // No cached application DNS answers, partial-family success or unsafe CNAMEs.
  // Every redirect comes through this function again, even on the same hostname.
  await resolvePublicAddresses(url.hostname,{signal,lookupFetch});
  signal.throwIfAborted();
  // Do not use an origin/service/VPC binding, resolveOverride, caller headers,
  // custom Host, sockets, or a Node HTTP client. The runtime public egress guard
  // is the connection-time boundary that closes the DNS-check/fetch race.
  return publicFetch(url.href,{method:'GET',redirect:'manual',signal,cache:'no-store',headers:{'User-Agent':'AZHomeInstalls-Outreach-Compliance/1.0'}});
 };
}
export const fetchPublicSource=createPublicSourceFetcher();
