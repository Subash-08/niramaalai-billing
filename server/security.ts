import {randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const derive=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scryptCallback(password,salt,64,{N:131072,r:8,p:1,maxmem:192*1024*1024},(error,key)=>error?reject(error):resolve(key)));
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function hashPassword(password:string){const salt=randomBytes(24).toString('hex');const key=await derive(password,salt);return 'scrypt-v1$'+salt+'$'+key.toString('hex');}
export async function verifyPassword(password:string,stored:string){const [version,salt,hex]=stored.split('$');if(version!=='scrypt-v1'||!salt||!hex||!/^[a-f0-9]{128}$/.test(hex))return false;const key=await derive(password,salt);return timingSafeEqual(key,Buffer.from(hex,'hex'));}
export const sessionToken=()=>randomBytes(32).toString('base64url');
export type Identity={userId:string;tenantId:string;sessionId:string;profitUntil?:Date};
/** Only call with an identity obtained from requireIdentity, never a request body. */
export function tenantFilter(identity:Identity,filter:Record<string,unknown>={}){if(!identity.tenantId)throw new Error('Tenant context required');return {...filter,tenantId:identity.tenantId};}
