import express from 'express';
import { createErpProxy } from './server-plugin/erp-proxy.js';

const app = express();
app.use('/api/erp', createErpProxy({ apiBase: 'http://localhost:3000' }));
app.use((err, req, res, _n) => res.status(err.status||500).json({error:{code:err.code||'ERR',message:err.message}}));
const srv = app.listen(4300, '0.0.0.0');
await new Promise(r=>setTimeout(r,300));
const B='http://localhost:4300/api/erp';
// Credentials come from the environment — never hardcode them in a repo.
const U = process.env.ERP_USER, P = process.env.ERP_PASS;
if (!U || !P) {
  console.error('Set ERP_USER and ERP_PASS, e.g.\n  ERP_USER=2026BT0683 ERP_PASS=… node examples/test-peruser.mjs');
  process.exit(2);
}
const login = async (u,p) => {
  const r = await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:u,password:p})});
  return { status:r.status, ...(await r.json()) };
};
let pass=0, fail=0;
const check=(ok,label,extra='')=>{ ok?pass++:fail++; console.log(`${ok?'✔':'✘'} ${label}${extra?' — '+extra:''}`); };

// 1. wrong password must NOT yield a token
let r = await login('2026BT0683','definitely-wrong-password');
check(r.status===401 && r.error?.code==='INCORRECT_PASSWORD' && !r.token, 'wrong password rejected, no token (INCORRECT_PASSWORD)', `${r.status} ${r.error?.code}`);

// 2. missing fields
r = await login('', '');
check(r.status===400 && r.error?.code==='MISSING_CREDENTIALS', 'missing credentials rejected', String(r.status));

// 3. real login
r = await login(U, P);
check(r.status===200 && !!r.token, 'correct password → token', `attempts=${r.captchaAttempts}, user=${r.user?.userId}`);
const tok = r.token;

// 4. token identifies the user
let me = await (await fetch(B+'/me',{headers:{'X-Session-Token':tok}})).json();
check(me.userId===U.toUpperCase(), '/me returns logged-in user', me.userId);

// 5. data reachable with token
let prof = await (await fetch(B+'/student/profile',{headers:{'X-Session-Token':tok}})).json();
check(prof.data?.registrationCode===U.toUpperCase(), 'data fetched for that user', prof.data?.fullName);
check(prof.data?.registrationCode===me.userId, 'data matches token owner (no cross-user leakage)');

// 6. no token / bad token
check((await fetch(B+'/student/profile')).status===401,'no token → 401');
check((await fetch(B+'/student/profile',{headers:{'X-Session-Token':'bogus'}})).status===401,'bad token → 401');

// 7. second login for same user → separate token, both work
const r2 = await login(U, P);
check(r2.status===200 && r2.token!==tok,'second login → distinct token');
const both = await Promise.all([
  fetch(B+'/student/profile',{headers:{'X-Session-Token':tok}}),
  fetch(B+'/student/profile',{headers:{'X-Session-Token':r2.token}}),
]);
check(both.every(x=>x.status===200),'both sessions independently valid');

// 8. logout kills only that token
await fetch(B+'/logout',{method:'POST',headers:{'X-Session-Token':tok}});
check((await fetch(B+'/student/profile',{headers:{'X-Session-Token':tok}})).status===401,'logged-out token → 401');
check((await fetch(B+'/student/profile',{headers:{'X-Session-Token':r2.token}})).status===200,'sibling token still works');

console.log(`\n${fail===0?'✅':'❌'} ${pass} passed, ${fail} failed`);
srv.close(); process.exit(fail===0?0:1);
