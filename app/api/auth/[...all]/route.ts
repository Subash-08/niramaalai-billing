import {getAuth} from '@/server/better-auth';
import {endpoint} from '@/server/auth';
export const runtime='nodejs';
async function handle(request:Request){try{return (await getAuth()).handler(request);}catch(e){return endpoint(async()=>{throw e;});}}
export const GET=handle;
export const POST=handle;
