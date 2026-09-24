import 'server-only';
import {headers} from 'next/headers';
import {z} from 'zod';
import {AppError,database} from './db';
import {getAuth,authObjectId} from './better-auth';
import {digest,Identity} from './security';
import {isAllowedOrigin, getTrustedOrigins} from './origins';
import {verifyPassword as verifyBetterAuthPassword} from 'better-auth/crypto';

export {getTrustedOrigins};

export function checkOrigin(request:Request){
  const origin = request.headers.get('origin');
  if (!origin || !isAllowedOrigin(origin)) {
    throw new AppError(403, 'Request origin is not allowed.');
  }
}

export async function verifyLoginPassword(identity: Identity, password: string): Promise<boolean> {
  if (!password || typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return false;
  }
  const db = await database();
  const user = await db.collection<any>('authUsers').findOne({_id: authObjectId(identity.userId), verified: true, disabled: false});
  if (!user) return false;

  const account = await db.collection<any>('authAccounts').findOne({
    $or: [{userId: authObjectId(identity.userId)}, {userId: identity.userId}, {accountId: identity.userId}],
    providerId: 'credential',
  });
  if (!account?.password) return false;

  return verifyBetterAuthPassword({hash: account.password, password});
}

export async function assertStorageRateLimit(identity: Identity) {
  if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL && process.env.DISABLE_AUTH_RATE_LIMIT === 'true') return;
  const db = await database();
  const bucket = Math.floor(Date.now() / 900000); // 15 min window
  const attempt = await db.collection<any>('rateLimits').findOneAndUpdate(
    {_id: digest('storage:' + identity.userId) + ':' + bucket},
    {$inc: {count: 1}, $setOnInsert: {expiresAt: new Date((bucket + 2) * 900000)}},
    {upsert: true, returnDocument: 'after'}
  );
  if (!attempt || attempt.count > 5) {
    throw new AppError(429, 'Too many storage configuration attempts. Please wait 15 minutes before trying again.');
  }
}

export async function assertPrepareRateLimit(identity: Identity) {
  if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL && process.env.DISABLE_AUTH_RATE_LIMIT === 'true') return;
  const db = await database();
  const bucket = Math.floor(Date.now() / 60000); // 1 min window
  const attempt = await db.collection<any>('rateLimits').findOneAndUpdate(
    {_id: digest('prepare:' + identity.tenantId + ':' + identity.userId) + ':' + bucket},
    {$inc: {count: 1}, $setOnInsert: {expiresAt: new Date((bucket + 2) * 60000)}},
    {upsert: true, returnDocument: 'after'}
  );
  if (!attempt || attempt.count > 60) {
    throw new AppError(429, 'Too many upload preparation requests. Please wait a moment before trying again.');
  }
}
export async function jsonBody(request:Request,maxBytes=1048576){const length=Number(request.headers.get('content-length')||0);if(length>maxBytes)throw new AppError(413,'Request is too large.');const raw=await request.text();if(raw.length>maxBytes)throw new AppError(413,'Request is too large.');try{return JSON.parse(raw);}catch{throw new AppError(400,'Invalid JSON.');}}
export async function forwardAuth(request:Request,path:string){try{checkOrigin(request);const auth=await getAuth();const url=new URL(request.url);url.pathname='/api/auth/'+path;const raw=await request.text();if(raw.length>1048576)throw new AppError(413,'Request is too large.');if(raw.trim()){try{JSON.parse(raw);}catch{throw new AppError(400,'Invalid JSON.');}}return auth.handler(new Request(url,{method:request.method,headers:request.headers,body:raw||undefined}));}catch(e){return endpoint(async()=>{throw e;});}}
export async function requireIdentity():Promise<Identity>{const requestHeaders=await headers();if(!requestHeaders.get('cookie'))throw new AppError(401,'Login required.');const value=await (await getAuth()).api.getSession({headers:requestHeaders});if(!value)throw new AppError(401,'Session expired.');const db=await database(),user=await db.collection<any>('authUsers').findOne({_id:authObjectId(value.user.id),verified:true,disabled:false});if(!user?.tenantId)throw new AppError(403,'Account approval required.');const tenant=await db.collection<any>('tenants').findOne({_id:user.tenantId,verified:true,disabled:false});if(!tenant)throw new AppError(403,'Company approval required.');const session=await db.collection<any>('authSessions').findOne({_id:authObjectId(value.session.id),userId:authObjectId(value.user.id),expiresAt:{$gt:new Date()}});if(!session)throw new AppError(401,'Session expired.');return {userId:value.user.id,tenantId:user.tenantId,sessionId:value.session.id};}
export async function profile(){const identity=await requireIdentity(),db=await database();const [user,tenant,settings]=await Promise.all([db.collection<any>('authUsers').findOne({_id:authObjectId(identity.userId)},{projection:{name:1,email:1}}),db.collection<any>('tenants').findOne({_id:identity.tenantId},{projection:{companyName:1}}),db.collection<any>('companySettings').findOne({tenantId:identity.tenantId})]);return {user:{name:user?.name,email:user?.email},company:{name:tenant?.companyName},businessDataMode:settings?.demoImported?'demo-imported':'live'};}
export async function endpoint(action:()=>Promise<unknown>){try{return Response.json(await action(),{headers:{'Cache-Control':'no-store'}});}catch(e:any){if(e instanceof z.ZodError){const issue=e.issues[0];const field=issue?.path.map(String).join('.');return Response.json({error:issue ? `${field ? field + ': ' : ''}${issue.message}` : 'Please check the form fields.'},{status:400,headers:{'Cache-Control':'no-store'}});}if(e instanceof AppError){return Response.json({error:e.message},{status:e.status,headers:{'Cache-Control':'no-store'}});}const reference=crypto.randomUUID();console.error('[API_ENDPOINT_ERROR]',{reference,error:e});return Response.json({error:'The server could not complete this request.',reference},{status:500,headers:{'Cache-Control':'no-store'}});}}
