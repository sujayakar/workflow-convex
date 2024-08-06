import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/sendFile",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const blob = await req.blob();
    const storageId = await ctx.storage.store(blob);
    return new Response(storageId, {
      status: 200,
      headers: new Headers({
        "Access-Control-Allow-Origin": "*",
        Vary: "Origin",
      }),
    });
  }),
});
http.route({
  path: "/sendFile",
  method: "OPTIONS",
  handler: httpAction(async (_, request) => {
    // Make sure the necessary headers are present
    // for this to be a valid pre-flight request
    const headers = request.headers;
    if (
      headers.get("Origin") !== null &&
      headers.get("Access-Control-Request-Method") !== null &&
      headers.get("Access-Control-Request-Headers") !== null
    ) {
      return new Response(null, {
        headers: new Headers({
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type, Digest",
          "Access-Control-Max-Age": "86400",
        }),
      });
    } else {
      return new Response();
    }
  }),
});

export default http;
