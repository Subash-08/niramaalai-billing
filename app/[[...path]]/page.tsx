import Workspace from '@/components/workspace';
import {Suspense} from 'react';
export default function Page(){ return <Suspense fallback={<div className="empty">Opening your workspace…</div>}><Workspace/></Suspense>; }
