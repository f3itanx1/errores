import { Hono } from "hono";
import auth from "./api/auth";
import admin from "./api/admin";
import decks from "./api/decks";
import friends from "./api/friends";
import messages from "./api/messages";
import notifications from "./api/notifications";
import worker from "./index";
export { AceroLobbyManager, AceroGameRoom } from "./index";

const api = new Hono<{ Bindings: Env }>();

api.route("/api/auth", auth);
api.route("/api/admin", admin);
api.route("/api/decks", decks);
api.route("/api/friends", friends);
api.route("/api/messages", messages);
api.route("/api/notifications", notifications);

const ALLOW_HEADERS = "Content-Type, Authorization, X-Requested-With";

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("Origin");
  headers.set("Access-Control-Allow-Origin", origin || "*");
  headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");
  if (origin) headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request);
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return withCors(await api.fetch(request, env), request);
    }

    if (url.pathname === "/health") {
      return withCors(
        Response.json({
          service: "Acero TCG Server",
          status: "online",
          transport: "WebSocket",
          authoritative: true,
          durableObjects: { lobby: "AceroLobbyManager", game: "AceroGameRoom" },
        }),
        request,
      );
    }

    if (url.pathname === "/lobbies" || url.pathname.startsWith("/lobbies/")) {
      const lobbyId = env.ACERO_LOBBY_MANAGER.idFromName("global-lobby");
      const response = await env.ACERO_LOBBY_MANAGER.get(lobbyId).fetch(request);
      return withCors(response, request);
    }

    if (url.pathname.startsWith("/room/") || url.pathname.startsWith("/rooms/")) {
      const roomId = url.pathname.split("/")[2];
      const id = env.ACERO_GAME_ROOM.idFromName(roomId);
      const response = await env.ACERO_GAME_ROOM.get(id).fetch(request);
      if (response.status === 101 || request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return response;
      }
      return withCors(response, request);
    }

    return withCors(
      Response.json({ ok: true, service: "Acero TCG Server" }),
      request,
    );
  },
} satisfies ExportedHandler<Env>;
