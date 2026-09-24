import 'server-only';
import {betterAuth} from 'better-auth';
import {mongodbAdapter} from 'better-auth/adapters/mongodb';
import {APIError} from 'better-auth/api';
import {randomUUID} from 'node:crypto';
import {ObjectId} from 'mongodb';
import {database,mongo,ensureIndexes,AppError} from './db';
import {getCanonicalOrigin, getTrustedOrigins} from './origins';
export const authObjectId=(id:string)=>ObjectId.isValid(id)?new ObjectId(id):id;
async function initialize(){
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = getCanonicalOrigin();
  if(!secret || secret.length < 32 || !baseURL) throw new AppError(503, 'Better Auth URL and secret must be configured.');
  const client = await mongo(), db = await database();
  await ensureIndexes();
  const trustedOrigins = getTrustedOrigins();
  return betterAuth({
    database: mongodbAdapter(db, {client}),
    secret,
    baseURL,
    appName: 'Billing Software',
    trustedOrigins,
    emailAndPassword: {enabled: true, minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: false},user:{modelName:'authUsers',additionalFields:{companyName:{type:'string',required:true},tenantId:{type:'string',input:false,returned:false},verified:{type:'boolean',defaultValue:false,input:false},disabled:{type:'boolean',defaultValue:false,input:false,returned:false}}},session:{modelName:'authSessions',expiresIn:43200,cookieCache:{enabled:false}},account:{modelName:'authAccounts'},verification:{modelName:'authVerifications'},rateLimit:{enabled:process.env.NODE_ENV==='production'||!!process.env.VERCEL||(process.env.NODE_ENV!=='test'&&process.env.DISABLE_AUTH_RATE_LIMIT!=='true'),storage:'database',modelName:'authRateLimits',window:60,max:60,customRules:{'/sign-in/email':{window:900,max:8},'/sign-up/email':{window:900,max:3}}},databaseHooks:{user:{create:{before:async(user)=>{const input=user as typeof user&{companyName?:string};if(!input.companyName?.trim()||input.companyName.length>120)throw new APIError('BAD_REQUEST',{message:'Enter a company name up to 120 characters.'});return {data:{...input,tenantId:randomUUID(),verified:false,disabled:false}};},after:async(user)=>{const u=user as typeof user&{tenantId:string;companyName:string};await db.collection<any>('tenants').updateOne({_id:u.tenantId},{$setOnInsert:{companyName:u.companyName,verified:false,disabled:false,createdAt:new Date()}},{upsert:true});}}},session:{create:{before:async(session)=>{const user=await db.collection<any>('authUsers').findOne({_id:authObjectId(session.userId)});const tenant=user&&await db.collection<any>('tenants').findOne({_id:user.tenantId});if(!user?.verified||!tenant?.verified||user.disabled||tenant.disabled)throw new APIError('FORBIDDEN',{message:'Company account is awaiting approval or disabled.'});return {data:session};}}}}});}

let promise:ReturnType<typeof initialize>|undefined;
export function getAuth(){return promise??=initialize().catch(e=>{promise=undefined;throw e;});}
