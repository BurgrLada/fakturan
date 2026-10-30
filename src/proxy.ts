import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { recordAdminDenial } from "@/server/auth/session";

// The page sits behind Suspense, where notFound() can no longer change a status already sent as 200.
export async function proxy(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableRefresh: true },
  });
  if (session && session.user.role !== "admin") {
    recordAdminDenial(request.headers, session.user.id);
    return NextResponse.rewrite(new URL("/stranka-neexistuje", request.url), { status: 404 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/administrace" };
