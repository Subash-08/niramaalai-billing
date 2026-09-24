import {endpoint,profile} from '@/server/auth';
export const runtime='nodejs';
export async function GET(){return endpoint(profile);}
