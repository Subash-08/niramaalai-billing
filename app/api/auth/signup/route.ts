import {forwardAuth} from '@/server/auth';
export const runtime='nodejs';
export async function POST(request:Request){return forwardAuth(request,'sign-up/email');}
