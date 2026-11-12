import * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const notFound = HttpServerResponse.text("Not Found", { status: 404 });

const read = (root: string, relative: string) =>
  Effect.tryPromise({
    try: () => readFile(resolve(root, relative)),
    catch: () => "missing" as const,
  });

/**
 * Serve the built web app. The deploy mounts `packages/web/dist` into the
 * API container at `WEB_ROOT`; in development, run Vite separately.
 */
export const serveStatic = (pathname: string): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const root = process.env.WEB_ROOT ?? join(process.cwd(), "packages/web/dist");
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, ""));
  const resolved = resolve(root, relative);

  // Never let a URL escape the mounted web root.
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    return Effect.succeed(notFound);
  }

  return read(root, relative).pipe(
    Effect.map((body) =>
      HttpServerResponse.uint8Array(body, {
        headers: { "content-type": contentTypes[extname(resolved)] ?? "application/octet-stream" },
      }),
    ),
    Effect.catch(() =>
      // A client-side route has no file extension: fall back to index.html.
      extname(relative) === ""
        ? read(root, "index.html").pipe(
            Effect.map((body) =>
              HttpServerResponse.uint8Array(body, {
                headers: { "content-type": contentTypes[".html"]! },
              }),
            ),
            Effect.catch(() => Effect.succeed(notFound)),
          )
        : Effect.succeed(notFound),
    ),
  );
};
