// An actual runtime test, not a mocked fetch. The public egress network must
// reject destinations after resolution, independently of application DNS checks.
export default {
 async test() {
  for(const url of ['https://127.0.0.1/','https://localhost/','https://[::1]/','https://10.0.0.1/','https://169.254.169.254/','https://[fd00::1]/']) {
   let error;
   try {await fetch(url,{signal:AbortSignal.timeout(3000)});}catch(caught){error=caught;}
   // The runtime intentionally redacts network-policy errors to 'internal error'.
   // run-public-egress.mjs also checks all six native policy-denial diagnostics.
   if(!error)throw Error('Expected public-network rejection for '+url+'; got '+(error?.message||'a response'));
  }
 }
};
