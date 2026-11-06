import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const binary=process.argv[2]||'workerd';
const result=spawnSync(binary,['test',fileURLToPath(new URL('./workerd-public-egress.capnp',import.meta.url))],{encoding:'utf8',timeout:15000});
if(result.error)throw result.error;
const logs=result.stdout+result.stderr;
assert.equal(result.status,0,logs);
// Distinguish an actual network-policy rejection from a generic DNS/TLS failure.
const denials=logs.match(/connecting to [^\n]+ is not allowed/g)||[];
assert.equal(denials.length,6,logs);
for(const destination of ['127.0.0.1:443','localhost:443','::1:443','10.0.0.1:443','169.254.169.254:443','fd00::1:443'])assert.ok(denials.some(line=>line.includes('connecting to '+destination+' is not allowed')),destination);
console.log('PASS: native workerd public-only egress rejected all 6 private destinations, including DNS-resolved loopback.');
