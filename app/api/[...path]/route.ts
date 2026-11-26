import { handleApi } from "@/lib/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => handleApi(req);
export const POST = (req: Request) => handleApi(req);
export const PATCH = (req: Request) => handleApi(req);
export const PUT = (req: Request) => handleApi(req);
export const DELETE = (req: Request) => handleApi(req);
