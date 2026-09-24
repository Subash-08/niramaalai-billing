const notFound = () => Response.json(
  {error: 'API endpoint not found.'},
  {status: 404, headers: {'Cache-Control': 'no-store'}}
);

export const dynamic = 'force-dynamic';

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;

