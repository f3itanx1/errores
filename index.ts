import { DurableObject } from "cloudflare:workers";

import { applyAction } from "./game/EffectEngine";
import { playCard } from "./game/CardPlayEngine";
import {
  createGameState,
  ensurePlayer,
  publicState,
} from "./game/GameState";
import {
  executeMigratedAbility,
  PendingChoiceError,
} from "./game/RealAbilityBridge";
import { dispatchTrigger } from "./game/TriggerDispatcher";
import { validateAbilityActivation } from "./game/actionValidator";

import type {
  CardInstance,
  GameAction,
  GameState,
} from "./game/types";

/* =========================================================
 * TIPOS
 * ======================================================= */

interface CustomRules {
  reducedStartingHandForFirstPlayer: boolean;
  londonMulligan: boolean;
  firstPlayerNoDraw: boolean;
}

interface LobbyPlayer {
  id: string;
  name: string;
  deckName?: string;
}

interface LobbyInfo {
  id: string;
  displayNumber?: number;
  roomId: string;

  hostPlayerId?: string;
  guestPlayerId?: string | null;

  host: LobbyPlayer;
  guest: LobbyPlayer | null;

  players?: LobbyPlayer[];

  status:
    | "waiting"
    | "playing"
    | "closed";

  createdAt: number;

  isRanked?: boolean;
  matchFormat?: string;
  gameFormat?: string;

  customRules?: CustomRules;
}

interface LobbyState {
  lobbies: LobbyInfo[];
}

interface ClientMessage {
  type?: string;
  event?: string;
  data?: unknown;
  playerName?: string;
  deck?: CardInstance[];
}

interface RoomPlayer {
  id: string;
  name: string;
  connected: boolean;
  deckCount: number;
}

interface DiceHistoryEntry {
  round: number;

  player1Roll: [number, number];
  player2Roll: [number, number];

  player1Total: number;
  player2Total: number;

  winner:
    | "player1"
    | "player2"
    | "tie";
}

interface DiceState {
  phase:
    | "WAITING"
    | "SUBMITTED"
    | "RESOLVED"
    | "TIE"
    | "COMPLETED";

  round: number;

  roomId: string;
  gameId: string;

  stateVersion: number;

  player1Id: string;
  player2Id: string;

  player1Submitted: boolean;
  player2Submitted: boolean;

  player1Roll:
    | [number, number]
    | null;

  player2Roll:
    | [number, number]
    | null;

  player1Total: number | null;
  player2Total: number | null;

  winner:
    | "player1"
    | "player2"
    | "tie"
    | null;

  startingPlayerId:
    | string
    | null;

  processedRequests: Record<
    string,
    {
      round: number;
    }
  >;

  history: DiceHistoryEntry[];

  lastUpdated: number;
}

type TriggerName =
  | "CARD_ENTERS_PLAY"
  | "CARD_DESTROYED"
  | "CARD_BANISHED"
  | "CARD_DISCARDED"
  | "CARD_LEAVES_PLAY"
  | "ATTACK_DECLARED"
  | "BLOCK_DECLARED"
  | "VIGILIA_START"
  | "FINAL_PHASE_TRIGGER"
  | "TURN_START";

/* =========================================================
 * CONSTANTES
 * ======================================================= */

const DEFAULT_CUSTOM_RULES: CustomRules = {
  reducedStartingHandForFirstPlayer: false,
  londonMulligan: false,
  firstPlayerNoDraw: true,
};

const LOBBY_CLEANUP_MS =
  15 * 60 * 1000;

const MAX_PUBLIC_LOBBIES = 50;

const json = (
  body: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response => {
  const headers = new Headers(
    extraHeaders,
  );

  if (!headers.has("content-type")) {
    headers.set(
      "content-type",
      "application/json; charset=utf-8",
    );
  }

  return new Response(
    JSON.stringify(body),
    {
      status,
      headers,
    },
  );
};

const fail = (
  error: string,
  status = 400,
): Response =>
  json(
    {
      ok: false,
      error,
    },
    status,
  );

/* =========================================================
 * UTILIDADES
 * ======================================================= */

function normalizeCustomRules(
  value: unknown,
): CustomRules {
  const input =
    value &&
    typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  return {
    reducedStartingHandForFirstPlayer:
      typeof input.reducedStartingHandForFirstPlayer ===
      "boolean"
        ? input.reducedStartingHandForFirstPlayer
        : DEFAULT_CUSTOM_RULES.reducedStartingHandForFirstPlayer,

    londonMulligan:
      typeof input.londonMulligan ===
      "boolean"
        ? input.londonMulligan
        : DEFAULT_CUSTOM_RULES.londonMulligan,

    firstPlayerNoDraw:
      typeof input.firstPlayerNoDraw ===
      "boolean"
        ? input.firstPlayerNoDraw
        : DEFAULT_CUSTOM_RULES.firstPlayerNoDraw,
  };
}

function getNextDisplayNumber(
  lobbies: LobbyInfo[],
): number {
  const used =
    new Set<number>();

  for (const lobby of lobbies) {
    if (
      typeof lobby.displayNumber ===
        "number" &&
      lobby.displayNumber > 0
    ) {
      used.add(
        lobby.displayNumber,
      );
    }
  }

  let value = 1;

  while (used.has(value)) {
    value += 1;
  }

  return value;
}

function normalizeRoomId(
  roomId:
    | string
    | null
    | undefined,
): string | null {
  if (!roomId) {
    return null;
  }

  const normalized =
    roomId.trim();

  if (
    !normalized ||
    normalized === "room"
  ) {
    return null;
  }

  return normalized;
}

/**
 * IMPORTANTE:
 * Nunca expone decks del lobby.
 * Los decks viven en GameRoom y llegan nuevamente
 * por HELLO al abrir el websocket.
 */
function formatLobby(
  lobby: LobbyInfo,
): LobbyInfo {
  const host: LobbyPlayer = {
    id: lobby.host.id,
    name: lobby.host.name,
    ...(lobby.host.deckName
      ? {
          deckName:
            lobby.host.deckName,
        }
      : {}),
  };

  const guest: LobbyPlayer | null =
    lobby.guest
      ? {
          id: lobby.guest.id,
          name: lobby.guest.name,
          ...(lobby.guest.deckName
            ? {
                deckName:
                  lobby.guest.deckName,
              }
            : {}),
        }
      : null;

  return {
    id: lobby.id,

    displayNumber:
      lobby.displayNumber,

    roomId:
      lobby.roomId,

    hostPlayerId:
      lobby.host.id,

    guestPlayerId:
      guest?.id ?? null,

    host,
    guest,

    players: guest
      ? [host, guest]
      : [host],

    status:
      lobby.status,

    createdAt:
      lobby.createdAt,

    isRanked:
      lobby.isRanked,

    matchFormat:
      lobby.matchFormat,

    gameFormat:
      lobby.gameFormat,

    customRules:
      normalizeCustomRules(
        lobby.customRules,
      ),
  };
}

function cleanupLobbies(
  state: LobbyState,
): boolean {
  const cutoff =
    Date.now() -
    LOBBY_CLEANUP_MS;

  const before =
    state.lobbies.length;

  state.lobbies =
    state.lobbies.filter(
      (lobby) => {
        if (
          lobby.status ===
          "closed"
        ) {
          return false;
        }

        if (
          lobby.status ===
          "playing"
        ) {
          return (
            lobby.createdAt >
            cutoff
          );
        }

        return true;
      },
    );

  return (
    before !==
    state.lobbies.length
  );
}

function buildPublicGameEvent(
  event: Record<string, unknown>,
  targetPlayerId: string | null,
): Record<string, unknown> {
  const copy = { ...event };
  if (copy.type === "cards_revealed_private" && copy.playerId !== targetPlayerId) {
    delete copy.cards;
    delete copy.candidates;
  }
  return copy;
}

/* =========================================================
 * LOBBY MANAGER
 * ======================================================= */

export class AceroLobbyManager
  extends DurableObject<Env> {

  private readonly KEY =
    "lobbies";

  async fetch(
    request: Request,
  ): Promise<Response> {
    const url =
      new URL(request.url);

    if (
      request.method ===
        "GET" &&
      url.pathname ===
        "/lobbies"
    ) {
      return this.list();
    }

    if (
      request.method ===
        "GET" &&
      (
        url.pathname.startsWith(
          "/lobbies/by-slug/",
        ) ||
        url.pathname.startsWith(
          "/lobbies/slug/",
        )
      )
    ) {
      const slug =
        url.pathname
          .split("/")
          .pop() || "";

      return this.getBySlug(
        slug,
      );
    }

    if (
      request.method ===
        "POST" &&
      (
        url.pathname ===
          "/matchmaking" ||
        url.pathname ===
          "/lobbies/matchmaking"
      )
    ) {
      return this.matchmaking(
        request,
      );
    }

    if (
      request.method ===
        "POST" &&
      (
        url.pathname ===
          "/matchmaking/cancel" ||
        url.pathname ===
          "/lobbies/matchmaking/cancel"
      )
    ) {
      return this.cancelMatchmaking(
        request,
      );
    }

    if (
      request.method ===
        "POST" &&
      url.pathname ===
        "/lobbies"
    ) {
      return this.create(
        request,
      );
    }

    if (
      request.method ===
        "POST" &&
      url.pathname ===
        "/lobbies/leave-player"
    ) {
      return this.leavePlayer(
        request,
      );
    }

    if (
      request.method ===
        "POST" &&
      url.pathname.endsWith(
        "/join",
      )
    ) {
      return this.join(
        request,
        this.pathId(
          url.pathname,
        ),
      );
    }

    if (
      request.method ===
        "POST" &&
      url.pathname.endsWith(
        "/leave",
      )
    ) {
      return this.leave(
        request,
        this.pathId(
          url.pathname,
        ),
      );
    }

    return fail(
      "Endpoint no encontrado",
      404,
    );
  }

  /* ---------------------------------------------------------
   * GET /lobbies
   * ------------------------------------------------------- */

  private async list(): Promise<Response> {
    const state =
      await this.getState();

    const changed =
      cleanupLobbies(
        state,
      );

    if (changed) {
      await this.saveState(
        state,
      );
    }

    const visible =
      state.lobbies.slice(
        0,
        MAX_PUBLIC_LOBBIES,
      );

    const lobbies =
      visible.map(
        formatLobby,
      );

    const waitingLobbies =
      lobbies.filter(
        (lobby) =>
          lobby.status ===
            "waiting" &&
          !lobby.guest,
      );

    const activeMatches =
      lobbies.filter(
        (lobby) =>
          lobby.status ===
            "playing" &&
          Boolean(
            lobby.guest,
          ),
      );

    return json(
      {
        ok: true,
        lobbies,
        waitingLobbies,
        activeMatches,
      },
      200,
      {
        "Cache-Control":
          "no-store",
      },
    );
  }

  /* ---------------------------------------------------------
   * POST /lobbies
   * ------------------------------------------------------- */

  private async create(
    request: Request,
  ): Promise<Response> {
    const body =
      await this.readBody(
        request,
      );

    if (!body.playerId) {
      return fail(
        "playerId requerido",
      );
    }

    const state =
      await this.getState();

    const changed =
      cleanupLobbies(
        state,
      );

    const existingIndex =
      state.lobbies.findIndex(
        (lobby) =>
          lobby.host.id ===
            body.playerId ||
          lobby.guest?.id ===
            body.playerId,
      );

    if (
      existingIndex !== -1
    ) {
      const existing =
        state.lobbies[
          existingIndex
        ];

      if (
        existing.status ===
          "playing" ||
        existing.status ===
          "closed"
      ) {
        state.lobbies.splice(
          existingIndex,
          1,
        );
      } else {
        const isHost =
          existing.host.id ===
          body.playerId;

        const player =
          isHost
            ? existing.host
            : existing.guest;

        if (!player) {
          return fail(
            "Jugador de lobby inválido.",
            409,
          );
        }

        if (
          body.playerName?.trim()
        ) {
          player.name =
            body.playerName.trim();
        }

        if (
          body.deckName
        ) {
          player.deckName =
            body.deckName;
        }

        if (
          !existing.displayNumber
        ) {
          existing.displayNumber =
            getNextDisplayNumber(
              state.lobbies,
            );
        }

        if (
          changed ||
          true
        ) {
          await this.saveState(
            state,
          );
        }

        return json({
          ok: true,
          reused: true,
          lobby:
            formatLobby(
              existing,
            ),
          roomId:
            existing.roomId,
          displayNumber:
            existing.displayNumber,
          roomSlug: String(
            existing.displayNumber ||
              existing.id,
          ),
          url:
            `/room/${
              existing.displayNumber ||
              existing.id
            }`,
          startMatch:
            false,
        });
      }
    }

    const displayNumber =
      getNextDisplayNumber(
        state.lobbies,
      );

    const lobby: LobbyInfo = {
      id:
        crypto.randomUUID(),

      displayNumber,

      roomId:
        `room-${crypto.randomUUID()}`,

      hostPlayerId:
        body.playerId,

      guestPlayerId:
        null,

      host: {
        id:
          body.playerId,
        name:
          body.playerName?.trim() ||
          "Jugador",
        ...(body.deckName
          ? {
              deckName:
                body.deckName,
            }
          : {}),
      },

      guest:
        null,

      status:
        "waiting",

      createdAt:
        Date.now(),

      isRanked:
        body.isRanked ??
        false,

      matchFormat:
        body.matchFormat ||
        "bo1",

      gameFormat:
        body.gameFormat ||
        "Primer Bloque",

      customRules:
        normalizeCustomRules(
          body.customRules,
        ),
    };

    state.lobbies.push(
      lobby,
    );

    await this.saveState(
      state,
    );

    return json({
      ok: true,
      matched: false,
      lobby:
        formatLobby(
          lobby,
        ),
      roomId:
        lobby.roomId,
      displayNumber,
      roomSlug: String(
        displayNumber,
      ),
      url:
        `/room/${displayNumber}`,
      startMatch:
        false,
    });
  }

  /* ---------------------------------------------------------
   * POST /matchmaking
   * ------------------------------------------------------- */

  private async matchmaking(
    request: Request,
  ): Promise<Response> {
    const body =
      await this.readBody(
        request,
      );

    if (!body.playerId) {
      return fail(
        "playerId requerido",
      );
    }

    const isRanked =
      String(body.isRanked) === "true" ||
      body.isRanked === true;

    const matchFormat =
      String(
        body.matchFormat ||
        "bo1"
      ).toLowerCase();

    const gameFormat =
      String(
        body.gameFormat ||
        "Primer Bloque"
      );

    const playerName =
      body.playerName?.trim() ||
      "Jugador";

    const state =
      await this.getState();

    const changed =
      cleanupLobbies(
        state,
      );

    const matchIndex =
      state.lobbies.findIndex(
        (lobby) =>
          lobby.status ===
            "waiting" &&
          !lobby.guest &&
          lobby.host.id !==
            body.playerId &&
          Boolean(
            lobby.isRanked,
          ) === isRanked &&
          String(
            lobby.matchFormat ||
            "bo1"
          ).toLowerCase() === matchFormat,
      );

    if (
      matchIndex !== -1
    ) {
      const match =
        state.lobbies[
          matchIndex
        ];

      match.guest = {
        id:
          body.playerId,
        name:
          playerName,
        ...(body.deckName
          ? {
              deckName:
                body.deckName,
            }
          : {}),
      };

      match.guestPlayerId =
        body.playerId;

      match.status =
        "playing";

      await this.saveState(
        state,
      );

      return json({
        ok: true,
        matched: true,
        lobby:
          formatLobby(
            match,
          ),
        roomId:
          match.roomId,
        displayNumber:
          match.displayNumber,
        roomSlug: String(
          match.displayNumber ||
            match.id,
        ),
        url:
          `/room/${
            match.displayNumber ||
            match.id
          }`,
        startMatch:
          true,
      });
    }

    const existingWaiting =
      state.lobbies.find(
        (lobby) =>
          lobby.host.id ===
            body.playerId &&
          lobby.status ===
            "waiting" &&
          !lobby.guest,
      );

    if (
      existingWaiting
    ) {
      existingWaiting.isRanked =
        isRanked;

      existingWaiting.matchFormat =
        matchFormat;

      existingWaiting.gameFormat =
        gameFormat;

      existingWaiting.host.name =
        playerName;

      if (
        body.deckName
      ) {
        existingWaiting.host.deckName =
          body.deckName;
      }

      await this.saveState(
        state,
      );

      return json({
        ok: true,
        matched: false,
        lobby:
          formatLobby(
            existingWaiting,
          ),
        roomId:
          existingWaiting.roomId,
        displayNumber:
          existingWaiting.displayNumber,
        roomSlug: String(
          existingWaiting.displayNumber ||
            existingWaiting.id,
        ),
        url:
          `/room/${
            existingWaiting.displayNumber ||
              existingWaiting.id
          }`,
        startMatch:
          false,
      });
    }

    if (changed) {
      await this.saveState(
        state,
      );
    }

    const displayNumber =
      getNextDisplayNumber(
        state.lobbies,
      );

    const lobby: LobbyInfo = {
      id:
        crypto.randomUUID(),

      displayNumber,

      roomId:
        `room-${crypto.randomUUID()}`,

      hostPlayerId:
        body.playerId,

      guestPlayerId:
        null,

      host: {
        id:
          body.playerId,
        name:
          playerName,
        ...(body.deckName
          ? {
              deckName:
                body.deckName,
            }
          : {}),
      },

      guest:
        null,

      status:
        "waiting",

      createdAt:
        Date.now(),

      isRanked,

      matchFormat,

      gameFormat,

      customRules:
        normalizeCustomRules(
          body.customRules,
        ),
    };

    state.lobbies.push(
      lobby,
    );

    await this.saveState(
      state,
    );

    return json({
      ok: true,
      matched: false,
      lobby:
        formatLobby(
          lobby,
        ),
      roomId:
        lobby.roomId,
      displayNumber,
      roomSlug: String(
        displayNumber,
      ),
      url:
        `/room/${displayNumber}`,
      startMatch:
        false,
    });
  }

  /* ---------------------------------------------------------
   * POST /matchmaking/cancel
   * ------------------------------------------------------- */

  private async cancelMatchmaking(
    request: Request,
  ): Promise<Response> {
    const body =
      await this.readBody(
        request,
      );

    if (!body.playerId) {
      return fail(
        "playerId requerido",
      );
    }

    const state =
      await this.getState();

    const index =
      state.lobbies.findIndex(
        (l) =>
          l.host.id === body.playerId &&
          l.status === "waiting" &&
          !l.guest,
      );

    if (index !== -1) {
      state.lobbies.splice(index, 1);
      await this.saveState(state);
      return json({ ok: true, canceled: true });
    }

    return json({ ok: true, canceled: false });
  }

  /* ---------------------------------------------------------
   * GET /lobbies/by-slug/:slug
   * ------------------------------------------------------- */

  private async getBySlug(
    slug: string,
  ): Promise<Response> {
    const state =
      await this.getState();

    const cleanSlug =
      decodeURIComponent(slug)
        .trim()
        .toLowerCase();

    const lobby =
      state.lobbies.find(
        (item) =>
          String(
            item.displayNumber,
          ) === cleanSlug ||
          item.id.toLowerCase() ===
            cleanSlug ||
          item.roomId
            .toLowerCase() ===
            cleanSlug ||
          item.roomId
            .toLowerCase() ===
            `room-${cleanSlug}` ||
          cleanSlug ===
            `room-${item.displayNumber}`,
      );

    if (!lobby) {
      return fail(
        "La partida no existe o ya fue cerrada.",
        404,
      );
    }

    const isFull =
      lobby.status ===
        "playing" &&
      Boolean(
        lobby.guest,
      );

    const isClosed =
      lobby.status ===
      "closed";

    return json({
      ok: true,
      lobby:
        formatLobby(
          lobby,
        ),
      roomId:
        lobby.roomId,
      displayNumber:
        lobby.displayNumber,
      roomSlug: String(
        lobby.displayNumber ||
          lobby.id,
      ),
      url:
        `/room/${
          lobby.displayNumber ||
          lobby.id
        }`,
      isFull,
      isClosed,
    });
  }

  /* ---------------------------------------------------------
   * POST /lobbies/:id/join
   * ------------------------------------------------------- */

  private async join(
    request: Request,
    lobbyId: string | null,
  ): Promise<Response> {
    if (!lobbyId) {
      return fail(
        "lobbyId requerido",
      );
    }

    const body =
      await this.readBody(
        request,
      );

    if (!body.playerId) {
      return fail(
        "playerId requerido",
      );
    }

    const state =
      await this.getState();

    const lobby =
      state.lobbies.find(
        (item) =>
          item.id ===
          lobbyId,
      );

    if (!lobby) {
      return fail(
        "La partida no existe.",
        404,
      );
    }

    if (
      !normalizeRoomId(
        lobby.roomId,
      )
    ) {
      return fail(
        "La sala no tiene un roomId válido.",
        500,
      );
    }

    if (
      lobby.host.id ===
      body.playerId
    ) {
      if (
        body.playerName?.trim()
      ) {
        lobby.host.name =
          body.playerName.trim();
      }

      if (
        body.deckName
      ) {
        lobby.host.deckName =
          body.deckName;
      }

      await this.saveState(
        state,
      );

      return json({
        ok: true,
        reused: true,
        lobby:
          formatLobby(
            lobby,
          ),
        roomId:
          lobby.roomId,
        startMatch:
          lobby.status ===
            "playing" &&
          Boolean(
            lobby.guest,
          ),
      });
    }

    if (
      lobby.guest?.id ===
      body.playerId
    ) {
      if (
        body.playerName?.trim()
      ) {
        lobby.guest.name =
          body.playerName.trim();
      }

      if (
        body.deckName
      ) {
        lobby.guest.deckName =
          body.deckName;
      }

      await this.saveState(
        state,
      );

      return json({
        ok: true,
        reused: true,
        lobby:
          formatLobby(
            lobby,
          ),
        roomId:
          lobby.roomId,
        startMatch:
          lobby.status ===
          "playing",
      });
    }

    if (
      lobby.status !==
        "waiting" ||
      lobby.guest
    ) {
      return fail(
        "La partida está llena o ya comenzó.",
        409,
      );
    }

    lobby.guest = {
      id:
        body.playerId,
      name:
        body.playerName?.trim() ||
        "Jugador",
      ...(body.deckName
        ? {
            deckName:
              body.deckName,
          }
        : {}),
    };

    lobby.guestPlayerId =
      body.playerId;

    lobby.status =
      "playing";

    await this.saveState(
      state,
    );

    return json({
      ok: true,
      lobby:
        formatLobby(
          lobby,
        ),
      roomId:
        lobby.roomId,
      startMatch:
        true,
    });
  }

  /* ---------------------------------------------------------
   * POST /lobbies/:id/leave
   * ------------------------------------------------------- */

  private async leave(
    request: Request,
    lobbyId: string | null,
  ): Promise<Response> {
    if (!lobbyId) {
      return fail(
        "lobbyId requerido",
      );
    }

    const body =
      await this.readBody(
        request,
      );

    if (!body.playerId) {
      return fail(
        "playerId requerido",
      );
    }

    const state =
      await this.getState();

    const index =
      state.lobbies.findIndex(
        (lobby) =>
          lobby.id ===
          lobbyId,
      );

    if (index < 0) {
      return fail(
        "La partida no existe.",
        404,
      );
    }

    const lobby =
      state.lobbies[index];

    if (
      lobby.host.id ===
      body.playerId
    ) {
      state.lobbies.splice(
        index,
        1,
      );
    } else if (
      lobby.guest?.id ===
      body.playerId
    ) {
      lobby.guest =
        null;

      lobby.guestPlayerId =
        null;

      lobby.status =
        "waiting";
    }

    await this.saveState(
      state,
    );

    return json({
      ok: true,
    });
  }

  /* ---------------------------------------------------------
   * POST /lobbies/leave-player
   * ------------------------------------------------------- */

  private async leavePlayer(
    request: Request,
  ): Promise<Response> {
    const body =
      await this.readBody(
        request,
      );

    if (!body.playerId) {
      return fail(
        "playerId requerido",
      );
    }

    const state =
      await this.getState();

    const initialCount =
      state.lobbies.length;

    let changed =
      false;

    state.lobbies =
      state.lobbies.filter(
        (lobby) => {
          if (
            lobby.host.id ===
              body.playerId &&
            lobby.status ===
              "waiting"
          ) {
            changed =
              true;

            return false;
          }

          if (
            lobby.guest?.id ===
              body.playerId &&
            lobby.status ===
              "waiting"
          ) {
            lobby.guest =
              null;

            lobby.guestPlayerId =
              null;

            changed =
              true;
          }

          return true;
        },
      );

    if (changed) {
      await this.saveState(
        state,
      );
    }

    return json({
      ok: true,
      removed:
        initialCount -
        state.lobbies.length,
    });
  }

  private async getState(): Promise<LobbyState> {
    const state =
      await this.ctx.storage.get<LobbyState>(
        this.KEY,
      );

    if (
      !state ||
      !Array.isArray(
        state.lobbies,
      )
    ) {
      return {
        lobbies: [],
      };
    }

    return state;
  }

  private async saveState(
    state: LobbyState,
  ): Promise<void> {
    await this.ctx.storage.put(
      this.KEY,
      state,
    );
  }

  private pathId(
    pathname: string,
  ): string | null {
    const parts =
      pathname
        .split("/")
        .filter(Boolean);

    const index =
      parts.indexOf(
        "lobbies",
      );

    return index >= 0
      ? parts[index + 1] ??
          null
      : null;
  }

  private async readBody(
    request: Request,
  ): Promise<{
    playerId?: string;
    playerName?: string;
    deckName?: string;
    deck?: CardInstance[];
    matchFormat?: string;
    gameFormat?: string;
    isRanked?: boolean;
    customRules?: unknown;
  }> {
    try {
      const value =
        (await request.json()) as Record<
          string,
          unknown
        >;

      return {
        playerId:
          typeof value.playerId ===
          "string"
            ? value.playerId
            : undefined,

        playerName:
          typeof value.playerName ===
          "string"
            ? value.playerName
            : undefined,

        deckName:
          typeof value.deckName ===
          "string"
            ? value.deckName
            : undefined,

        deck:
          Array.isArray(
            value.deck,
          )
            ? (value.deck as CardInstance[])
            : undefined,

        matchFormat:
          typeof value.matchFormat ===
          "string"
            ? value.matchFormat
            : undefined,

        gameFormat:
          typeof value.gameFormat ===
          "string"
            ? value.gameFormat
            : undefined,

        isRanked:
          typeof value.isRanked ===
          "boolean"
            ? value.isRanked
            : undefined,

        customRules:
          value.customRules &&
          typeof value.customRules ===
            "object"
            ? value.customRules
            : undefined,
      };
    } catch {
      return {};
    }
  }
}

/* =========================================================
 * GAME ROOM
 * ======================================================= */

export class AceroGameRoom
  extends DurableObject<Env> {

  private readonly STATE_KEY =
    "roomState";

  private readonly ROOM_KEY =
    "roomId";

  /* ---------------------------------------------------------
   * FETCH
   * ------------------------------------------------------- */

  async fetch(
    request: Request,
  ): Promise<Response> {
    const url =
      new URL(request.url);

    const roomId =
      this.extractRoomId(
        url.pathname,
      );

    if (!roomId) {
      return fail(
        "roomId requerido",
      );
    }

    if (
      roomId ===
      "room"
    ) {
      return fail(
        "roomId inválido",
        400,
      );
    }

    try {
      await this.ensureRoomId(
        roomId,
      );
    } catch (
      error
    ) {
      const message =
        error instanceof Error
          ? error.message
          : "ROOM_ID_ERROR";

      return fail(
        message,
        409,
      );
    }

    if (
      request.headers
        .get("Upgrade")
        ?.toLowerCase() ===
      "websocket"
    ) {
      return this.handleWebSocket(
        request,
      );
    }

    if (
      url.pathname.endsWith(
        "/state",
      )
    ) {
      const viewerId =
        url.searchParams.get(
          "playerId",
        ) ||
        undefined;

      const state =
        await this.getState();

      return json({
        ok: true,
        roomId:
          state.roomId,
        gameState:
          publicState(
            state,
            viewerId,
          ),
      });
    }

    const state =
      await this.getState();

    return json({
      ok: true,
      service:
        "AceroGameRoom",
      roomId:
        state.roomId,
      players:
        this.players(
          state,
        ),
    });
  }

  /* ---------------------------------------------------------
   * WEBSOCKET MESSAGE
   * ------------------------------------------------------- */

  async webSocketMessage(
    ws: WebSocket,
    raw:
      | string
      | ArrayBuffer,
  ): Promise<void> {
    const playerId =
      this.getPlayerId(
        ws,
      );

    if (!playerId) {
      this.send(ws, {
        type:
          "ERROR",
        error:
          "WebSocket no registrado",
      });

      return;
    }

    let message:
      ClientMessage;

    try {
      message =
        JSON.parse(
          typeof raw ===
            "string"
            ? raw
            : new TextDecoder().decode(
                raw,
              ),
        ) as ClientMessage;
    } catch {
      this.send(ws, {
        type:
          "ERROR",
        error:
          "JSON inválido",
      });

      return;
    }

    let state:
      GameState;

    try {
      state =
        await this.getState();
    } catch (
      error
    ) {
      this.send(ws, {
        type:
          "ERROR",
        error:
          error instanceof Error
            ? error.message
            : "STATE_ERROR",
      });

      return;
    }

    const type =
      String(
        message.type ??
          message.event ??
          "",
      );

    /* -------------------------------------------------------
     * DADOS
     * ----------------------------------------------------- */

    if (
      type ===
        "ROLL_DICE" ||
      type ===
        "roll_dice"
    ) {
      await this.handleDiceRoll(
        ws,
        state,
        playerId,
        message,
      );

      return;
    }

    /* -------------------------------------------------------
     * HELLO
     * ----------------------------------------------------- */

    if (
      type ===
      "HELLO"
    ) {
      const tags =
        this.ctx.getTags(
          ws,
        );

      const isSpectator =
        tags.includes(
          "spectator",
        ) ||
        playerId.startsWith(
          "spectator",
        );

      if (!isSpectator) {
        const player =
          ensurePlayer(
            state,
            playerId,
            message.playerName ||
              state.players[
                playerId
              ]?.name ||
              "Jugador",
            message.deck ||
              [],
          );

        player.connected =
          true;

        const playerIds =
          Object.keys(
            state.players,
          );

        /**
         * Una sola inicialización de partida.
         */
        if (
          playerIds.length ===
            2 &&
          !state.started
        ) {
          state.started =
            true;

          state.phase =
            "DICE" as any;

          state.turn =
            0;

          state.activePlayerId =
            null;

          const initialDice =
            await this.getDiceState(
              state,
            );

          await this.saveState(
            state,
          );

          this.broadcast({
            type:
              "GAME_STARTED",

            roomId:
              state.roomId,

            status:
              "READY",

            phase:
              "DICE",

            turn:
              0,

            activePlayerId:
              null,

            player1Id:
              playerIds[0],

            player2Id:
              playerIds[1],

            players:
              this.players(
                state,
              ),

            gameState:
              publicState(
                state,
              ),

            diceState:
              initialDice,
          });
        } else {
          await this.saveState(
            state,
          );
        }
      }

      this.send(ws, {
        type:
          "ROOM_CONNECTED",

        roomId:
          state.roomId,

        playerId,

        isSpectator,

        players:
          this.players(
            state,
          ),

        gameState:
          publicState(
            state,
            isSpectator
              ? undefined
              : playerId,
          ),
      });

      this.broadcastState(
        state,
      );

      return;
    }

    /* -------------------------------------------------------
     * GET STATE
     * ----------------------------------------------------- */

    if (
      type ===
      "GET_STATE"
    ) {
      const isSpectator =
        this.isSpectator(
          ws,
        );

      this.send(ws, {
        type:
          "ROOM_STATE",

        roomId:
          state.roomId,

        isSpectator,

        players:
          this.players(
            state,
          ),

        gameState:
          publicState(
            state,
            isSpectator
              ? undefined
              : playerId,
          ),
      });

      return;
    }

    /* -------------------------------------------------------
     * GAME ACTION
     * ----------------------------------------------------- */

    if (
      type ===
        "GAME_ACTION" ||
      type ===
        "ACTION"
    ) {
      const action =
        (
          message.data ??
          {}
        ) as GameAction;

      await this.executeGameAction(
        ws,
        state,
        playerId,
        action,
      );

      return;
    }

    /* -------------------------------------------------------
     * START GAME
     * ----------------------------------------------------- */

    if (
      type ===
      "START_GAME"
    ) {
      await this.executeGameAction(
        ws,
        state,
        playerId,
        {
          action:
            "START_GAME",
        } as GameAction,
      );

      return;
    }

    /* -------------------------------------------------------
     * MULLIGAN
     * ----------------------------------------------------- */

    if (
      type ===
        "MULLIGAN_DECISION" ||
      type ===
        "EXECUTE_MULLIGAN" ||
      type ===
        "mulligan"
    ) {
      const data =
        (
          message.data &&
          typeof message.data ===
            "object"
            ? message.data
            : message
        ) as Record<
          string,
          unknown
        >;

      const decision =
        data.decision ||
        (
          data.useGoldMulligan
            ? "DRAW_8"
            : "KEEP_7"
        );

      await this.handleMulligan(
        ws,
        state,
        playerId,
        {
          type:
            "MULLIGAN_DECISION",

          data: {
            decision,
          },
        },
      );

      return;
    }

    this.send(ws, {
      type:
        "ERROR",

      error:
        `Mensaje no soportado: ${
          type ||
          "undefined"
        }`,
    });
  }

  /* ---------------------------------------------------------
   * DICE STATE
   * ------------------------------------------------------- */

  private async getDiceState(
    state: GameState,
  ): Promise<DiceState> {
    const key =
      "canonicalDiceState";

    let dice =
      await this.ctx.storage.get<DiceState>(
        key,
      );

    const playerIds =
      Object.keys(
        state.players ||
          {},
      );

    const p1 =
      playerIds[0] ||
      "";

    const p2 =
      playerIds[1] ||
      "";

    if (!dice) {
      dice = {
        phase:
          "WAITING",

        round:
          1,

        roomId:
          state.roomId,

        gameId:
          state.roomId,

        stateVersion:
          1,

        player1Id:
          p1,

        player2Id:
          p2,

        player1Submitted:
          false,

        player2Submitted:
          false,

        player1Roll:
          null,

        player2Roll:
          null,

        player1Total:
          null,

        player2Total:
          null,

        winner:
          null,

        startingPlayerId:
          null,

        processedRequests:
          {},

        history: [],

        lastUpdated:
          Date.now(),
      };

      await this.ctx.storage.put(
        key,
        dice,
      );

      return dice;
    }

    let changed =
      false;

    if (
      !dice.player1Id &&
      p1
    ) {
      dice.player1Id =
        p1;

      changed =
        true;
    }

    if (
      !dice.player2Id &&
      p2
    ) {
      dice.player2Id =
        p2;

      changed =
        true;
    }

    if (
      dice.roomId !==
      state.roomId
    ) {
      dice.roomId =
        state.roomId;

      dice.gameId =
        state.roomId;

      changed =
        true;
    }

    if (changed) {
      await this.ctx.storage.put(
        key,
        dice,
      );
    }

    return dice;
  }

  /* ---------------------------------------------------------
   * DICE ROLL
   * ------------------------------------------------------- */

  private async handleDiceRoll(
    ws: WebSocket,
    state: GameState,
    playerId: string,
    message: ClientMessage,
  ): Promise<void> {
    const data =
      (
        message.data &&
        typeof message.data ===
          "object"
          ? message.data
          : {}
      ) as Record<
        string,
        unknown
      >;

    const requestId =
      String(
        data.requestId ||
          data.idempotencyKey ||
          `${playerId}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
      );

    const key =
      "canonicalDiceState";

    const dice =
      await this.getDiceState(
        state,
      );

    const playerIds =
      Object.keys(
        state.players ||
          {},
      );

    const isVsAI =
      Boolean(
        (state as any).isVsAI ||
          (state as any).gameMode ===
            "vs-ai" ||
          state.roomId.startsWith(
            "ai-",
          ),
      );

    if (
      playerIds.length < 2 &&
      !isVsAI
    ) {
      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action:
          message,

        code:
          "WAITING_FOR_OPPONENT",

        error:
          "Esperando al segundo jugador.",
      });

      return;
    }

    if (
      dice.phase ===
        "COMPLETED" &&
      dice.startingPlayerId
    ) {
      this.send(ws, {
        type:
          "DICE_RESOLVED",

        phase:
          "COMPLETED",

        round:
          dice.round,

        player1Roll:
          dice.player1Roll,

        player2Roll:
          dice.player2Roll,

        player1Total:
          dice.player1Total,

        player2Total:
          dice.player2Total,

        winner:
          dice.winner,

        startingPlayerId:
          dice.startingPlayerId,

        activePlayerId:
          dice.startingPlayerId,

        firstPlayerId:
          dice.startingPlayerId,

        diceState:
          dice,
      });

      return;
    }

    if (
      dice.processedRequests[
        requestId
      ]
    ) {
      this.send(ws, {
        type:
          "DICE_STATUS_UPDATE",

        phase:
          dice.phase,

        round:
          dice.round,

        player1Submitted:
          dice.player1Submitted,

        player2Submitted:
          dice.player2Submitted,

        diceState:
          dice,

        idempotent:
          true,
      });

      return;
    }

    if (
      playerId !==
        dice.player1Id &&
      playerId !==
        dice.player2Id
    ) {
      if (
        !dice.player1Id &&
        playerIds[0]
      ) {
        dice.player1Id =
          playerIds[0];
      }

      if (
        !dice.player2Id &&
        playerIds[1]
      ) {
        dice.player2Id =
          playerIds[1];
      }
    }

    const isP1 =
      playerId ===
      dice.player1Id;

    const isP2 =
      playerId ===
      dice.player2Id;

    if (
      !isP1 &&
      !isP2
    ) {
      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action:
          message,

        code:
          "INVALID_PLAYER",

        error:
          "No perteneces a esta partida.",
      });

      return;
    }

    if (
      (
        isP1 &&
        dice.player1Submitted
      ) ||
      (
        isP2 &&
        dice.player2Submitted
      )
    ) {
      this.send(ws, {
        type:
          "DICE_STATUS_UPDATE",

        phase:
          dice.phase,

        round:
          dice.round,

        player1Submitted:
          dice.player1Submitted,

        player2Submitted:
          dice.player2Submitted,

        diceState:
          dice,
      });

      return;
    }

    dice.processedRequests[
      requestId
    ] = {
      round:
        dice.round,
    };

    if (isP1) {
      dice.player1Submitted =
        true;
    }

    if (isP2) {
      dice.player2Submitted =
        true;
    }

    /* -------------------------------------------------------
     * VS AI
     * ----------------------------------------------------- */

    if (
      isVsAI &&
      !dice.player2Submitted
    ) {
      dice.player2Id =
        dice.player2Id ||
        "ai-opponent";

      dice.player2Submitted =
        true;
    }

    dice.lastUpdated =
      Date.now();

    dice.stateVersion +=
      1;

    /* -------------------------------------------------------
     * ESPERAR RIVAL
     * ----------------------------------------------------- */

    if (
      !dice.player1Submitted ||
      !dice.player2Submitted
    ) {
      dice.phase =
        "SUBMITTED";

      await this.ctx.storage.put(
        key,
        dice,
      );

      this.broadcast({
        type:
          "DICE_STATUS_UPDATE",

        phase:
          "SUBMITTED",

        round:
          dice.round,

        player1Submitted:
          dice.player1Submitted,

        player2Submitted:
          dice.player2Submitted,

        diceState:
          dice,
      });

      return;
    }

    /* -------------------------------------------------------
     * RESOLUCIÓN AUTORITATIVA
     * ----------------------------------------------------- */

    const roll =
      (): number =>
        Math.floor(
          Math.random() * 6,
        ) + 1;

    const player1Roll:
      [number, number] = [
      roll(),
      roll(),
    ];

    const player2Roll:
      [number, number] = [
      roll(),
      roll(),
    ];

    const player1Total =
      player1Roll[0] +
      player1Roll[1];

    const player2Total =
      player2Roll[0] +
      player2Roll[1];

    if (
      player1Total ===
      player2Total
    ) {
      const tiedRound =
        dice.round;

      dice.history.push({
        round:
          tiedRound,

        player1Roll:
          player1Roll,

        player2Roll:
          player2Roll,

        player1Total:
          player1Total,

        player2Total:
          player2Total,

        winner:
          "tie",
      });

      dice.phase =
        "TIE";

      dice.winner =
        "tie";

      dice.round +=
        1;

      dice.player1Submitted =
        false;

      dice.player2Submitted =
        false;

      dice.player1Roll =
        null;

      dice.player2Roll =
        null;

      dice.player1Total =
        null;

      dice.player2Total =
        null;

      dice.startingPlayerId =
        null;

      dice.lastUpdated =
        Date.now();

      dice.stateVersion +=
        1;

      await this.ctx.storage.put(
        key,
        dice,
      );

      this.broadcast({
        type:
          "DICE_RESOLVED",

        phase:
          "TIE",

        round:
          tiedRound,

        nextRound:
          dice.round,

        player1Id:
          dice.player1Id,

        player2Id:
          dice.player2Id,

        player1Roll:
          player1Roll,

        player2Roll:
          player2Roll,

        player1Total:
          player1Total,

        player2Total:
          player2Total,

        winner:
          "tie",

        startingPlayerId:
          null,

        activePlayerId:
          null,

        history:
          dice.history,

        diceState:
          dice,
      });

      return;
    }

    const winner =
      player1Total >
      player2Total
        ? "player1"
        : "player2";

    const startingPlayerId =
      winner ===
      "player1"
        ? dice.player1Id
        : dice.player2Id;

    if (
      !startingPlayerId
    ) {
      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action:
          message,

        code:
          "DICE_STARTING_PLAYER_MISSING",

        error:
          "No se pudo determinar el jugador inicial.",
      });

      return;
    }

    dice.phase =
      "COMPLETED";

    dice.winner =
      winner;

    dice.startingPlayerId =
      startingPlayerId;

    dice.player1Roll =
      player1Roll;

    dice.player2Roll =
      player2Roll;

    dice.player1Total =
      player1Total;

    dice.player2Total =
      player2Total;

    dice.history.push({
      round:
        dice.round,

      player1Roll:
        player1Roll,

      player2Roll:
        player2Roll,

      player1Total:
        player1Total,

      player2Total:
        player2Total,

      winner,
    });

    dice.lastUpdated =
      Date.now();

    dice.stateVersion +=
      1;

    /* -------------------------------------------------------
     * GAME STATE
     * ----------------------------------------------------- */

    state.activePlayerId =
      startingPlayerId;

    (state as any)
      .firstPlayerId =
      startingPlayerId;

    (state as any)
      .startingPlayerId =
      startingPlayerId;

    state.turn =
      1;

    state.phase =
      "MAIN";

    await this.ctx.storage.put(
      key,
      dice,
    );

    await this.saveState(
      state,
    );

    this.broadcast({
      type:
        "DICE_RESOLVED",

      phase:
        "COMPLETED",

      round:
        dice.round,

      player1Id:
        dice.player1Id,

      player2Id:
        dice.player2Id,

      player1Roll:
        player1Roll,

      player2Roll:
        player2Roll,

      player1Total:
        player1Total,

      player2Total:
        player2Total,

      winner,

      startingPlayerId,

      firstPlayerId:
        startingPlayerId,

      activePlayerId:
        startingPlayerId,

      history:
        dice.history,

      diceState:
        dice,
    });

    this.broadcastState(
      state,
    );
  }

  /* ---------------------------------------------------------
   * MULLIGAN
   * ------------------------------------------------------- */

  private async handleMulligan(
    ws: WebSocket,
    state: GameState,
    playerId: string,
    message: ClientMessage,
  ): Promise<void> {
    const data =
      (
        message.data &&
        typeof message.data ===
          "object"
          ? message.data
          : {}
      ) as Record<
        string,
        unknown
      >;

    const decision =
      String(
        data.decision ||
          "KEEP_7",
      );

    const player =
      state.players[
        playerId
      ];

    if (!player) {
      this.send(ws, {
        type:
          "ERROR",
        error:
          "Jugador no encontrado.",
      });

      return;
    }

    const key =
      "mulliganState";

    const mulliganState =
      (
        await this.ctx.storage.get<
          Record<
            string,
            {
              resolved: boolean;
              decision: string;
              eligibleForEight: boolean;
            }
          >
        >(key)
      ) ?? {};

    if (
      mulliganState[
        playerId
      ]?.resolved
    ) {
      this.send(ws, {
        type:
          "ERROR",
        error:
          "Ya tomaste tu decisión de mulligan.",
      });

      return;
    }

    const goldsInHand =
      player.hand.filter(
        (card) =>
          card.type ===
          "Oro",
      ).length;

    const eligibleForEight =
      goldsInHand <= 1;

    if (
      decision ===
      "DRAW_8"
    ) {
      if (
        !eligibleForEight
      ) {
        this.send(ws, {
          type:
            "MULLIGAN_REJECTED",

          reason:
            "Tienes 2 o más Oros en la mano.",

          goldsInHand,
        });

        return;
      }

      if (
        player.castle.length >
        0
      ) {
        const drawn =
          player.castle.shift()!;

        drawn.zone =
          "hand";

        player.hand.push(
          drawn,
        );
      }
    }

    mulliganState[
      playerId
    ] = {
      resolved:
        true,

      decision,

      eligibleForEight,
    };

    await this.ctx.storage.put(
      key,
      mulliganState,
    );

    await this.saveState(
      state,
    );

    this.send(ws, {
      type:
        "MULLIGAN_RESOLVED",

      playerId,

      decision,

      handSize:
        player.hand.length,

      gameState:
        publicState(
          state,
          playerId,
        ),
    });

    const playerIds =
      Object.keys(
        state.players,
      );

    const allResolved =
      playerIds.every(
        (pid) =>
          mulliganState[
            pid
          ]?.resolved,
      );

    if (allResolved) {
      this.broadcast({
        type:
          "MULLIGAN_COMPLETE",

        message:
          "Ambos jugadores terminaron el mulligan.",

        gameState:
          publicState(
            state,
          ),
      });
    } else {
      this.broadcast({
        type:
          "MULLIGAN_PLAYER_READY",

        playerId,

        waitingFor:
          playerIds.filter(
            (pid) =>
              !mulliganState[
                pid
              ]?.resolved,
          ),
      });
    }
  }

  /* ---------------------------------------------------------
   * TRIGGERS
   * ------------------------------------------------------- */

  private async dispatchEvents(
    state: GameState,
    playerId: string,
    events: Array<
      Record<string, unknown>
    >,
  ): Promise<
    Array<
      Record<string, unknown>
    >
  > {
    const triggerEvents:
      Array<
        Record<string, unknown>
      > = [];

    for (const gameEvent of events) {
      const type =
        String(
          gameEvent.type ??
            "",
        );

      const triggerList:
        TriggerName[] = [];

      if (
        type ===
        "card_played"
      ) {
        triggerList.push(
          "CARD_ENTERS_PLAY",
        );
      }

      if (
        type ===
          "card_destroyed" ||
        type ===
          "ability_destroy"
      ) {
        triggerList.push(
          "CARD_DESTROYED",
          "CARD_LEAVES_PLAY",
        );
      }

      if (
        type ===
          "card_banished" ||
        type ===
          "ability_banish"
      ) {
        triggerList.push(
          "CARD_BANISHED",
          "CARD_LEAVES_PLAY",
        );
      }

      if (
        type ===
        "card_discarded"
      ) {
        triggerList.push(
          "CARD_DISCARDED",
        );
      }

      if (
        type ===
        "attack_declared"
      ) {
        triggerList.push(
          "ATTACK_DECLARED",
        );
      }

      if (
        type ===
        "block_declared"
      ) {
        triggerList.push(
          "BLOCK_DECLARED",
        );
      }

      if (
        type ===
          "phase_changed" &&
        gameEvent.phase ===
          "FINAL"
      ) {
        triggerList.push(
          "FINAL_PHASE_TRIGGER",
        );
      }

      if (
        type ===
        "turn_ended"
      ) {
        triggerList.push(
          "TURN_START",
          "VIGILIA_START",
        );
      }

      if (
        type ===
        "game_started"
      ) {
        triggerList.push(
          "TURN_START",
          "VIGILIA_START",
        );
      }

      if (!triggerList.length) {
        continue;
      }

      const affectedId =
        typeof gameEvent.instanceId ===
        "string"
          ? gameEvent.instanceId
          : typeof gameEvent.targetInstanceId ===
            "string"
          ? gameEvent.targetInstanceId
          : typeof gameEvent.attackerId ===
            "string"
          ? gameEvent.attackerId
          : undefined;

      for (const trigger of triggerList) {
        const result =
          await dispatchTrigger(
            state,
            trigger,
            playerId,
            affectedId,
          );

        triggerEvents.push({
          type:
            "trigger_dispatched",

          trigger,

          affectedInstanceId:
            affectedId,

          fired:
            result.fired,

          events:
            result.events,

          pendingChoice:
            result.pendingChoice,
        });

        /**
         * Si una habilidad disparada necesita
         * una decisión del jugador, detenemos
         * la cadena para no ejecutar cosas fuera
         * de orden.
         */
        if (
          state.pendingChoice
        ) {
          return triggerEvents;
        }
      }
    }

    return triggerEvents;
  }

  /* ---------------------------------------------------------
   * GAME ACTION
   * ------------------------------------------------------- */

  private async executeGameAction(
    ws: WebSocket,
    state: GameState,
    playerId: string,
    action: GameAction,
  ): Promise<void> {

    if (
      this.isSpectator(
        ws,
      )
    ) {
      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action,

        code:
          "SPECTATOR_READ_ONLY",

        error:
          "Los espectadores no pueden realizar acciones.",
      });

      return;
    }

    const name =
      String(
        action.action ??
          (action as any).type ??
          "",
      )
        .trim()
        .toUpperCase();

    const publicActions =
      new Set([
        "START_GAME",

        "DRAW",
        "DRAW_CARD",

        "PLAY_GOLD",
        "PAY_GOLD",

        "PLAY_CARD",
        "PLAY_CARD_FROM_HAND",

        "ACTIVATE_ABILITY",

        "RESOLVE_CHOICE",
        "CANCEL_CHOICE",

        "BEGIN_COMBAT",
        "DECLARE_ATTACK",
        "DECLARE_BLOCK",
        "RESOLVE_COMBAT",

        "BEGIN_GROUPING",
        "BEGIN_FINAL",

        "END_TURN",

        "CONCEDE",
        "SURRENDER",

        "NEXT_PHASE",
        "CHANGE_PHASE",
        "PASS_PHASE",
        "ADVANCE_PHASE",

        "REST_CARD",
        "TOGGLE_REST",

        "PING",
        "GET_STATE",
        "TEST_CONNECTION",

        "EXECUTE_MULLIGAN",
        "MULLIGAN",

        "DRACULA_BANISH_CANCEL",
        "SANDRAUDIGA_SHUFFLE_FROM_BANISHED",
        "SEARCH_CASTLE_CANCEL",
        "SEARCH_CASTLE_SELECT",
      ]);

    if (
      !publicActions.has(
        name,
      )
    ) {
      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action,

        code:
          "UNSUPPORTED_PUBLIC_ACTION",

        error:
          `La acción ${name} no puede ser enviada directamente por el cliente.`,
      });

      return;
    }

    /* -------------------------------------------------------
     * MULLIGAN
     * ----------------------------------------------------- */

    if (
      name ===
        "EXECUTE_MULLIGAN" ||
      name ===
        "MULLIGAN"
    ) {
      const decision =
        action.decision ||
        (
          action.useGoldMulligan
            ? "DRAW_8"
            : "KEEP_7"
        );

      await this.handleMulligan(
        ws,
        state,
        playerId,
        {
          type:
            "MULLIGAN_DECISION",

          data: {
            decision,
          },
        },
      );

      return;
    }

    /* -------------------------------------------------------
     * RESOLVE CHOICE
     * ----------------------------------------------------- */

    if (
      name ===
      "RESOLVE_CHOICE"
    ) {
      await this.resolveChoice(
        ws,
        state,
        playerId,
        action,
      );

      return;
    }

    /* -------------------------------------------------------
     * CANCEL CHOICE
     * ----------------------------------------------------- */

    if (
      name ===
      "CANCEL_CHOICE"
    ) {
      if (
        !state.pendingChoice ||
        state.pendingChoice.playerId !==
          playerId
      ) {
        this.send(ws, {
          type:
            "ACTION_REJECTED",

          playerId,

          action,

          code:
            "NO_PENDING_CHOICE",

          error:
            "No tienes una elección pendiente.",
        });

        return;
      }

      state.pendingChoice =
        null;

      await this.saveState(
        state,
      );

      this.broadcastState(
        state,
      );

      return;
    }

    /* -------------------------------------------------------
     * ACTIVATE ABILITY
     *
     * SIEMPRE pasa por RealAbilityBridge.
     * ----------------------------------------------------- */

    if (
      name ===
      "ACTIVATE_ABILITY"
    ) {
      const sourceId =
        String(
          action.instanceId ??
            (action as any)
              .cardInstanceId ??
            action.cardId ??
            (action as any)
              .id ??
            "",
        );

      if (!sourceId) {
        this.send(ws, {
          type:
            "ACTION_REJECTED",

          playerId,

          action,

          code:
            "SOURCE_REQUIRED",

          error:
            "ACTIVATE_ABILITY requiere instanceId o cardId.",
        });

        return;
      }

      const validation =
        validateAbilityActivation(
          sourceId,
          playerId,
          state,
        );

      if (
        !validation.valid
      ) {
        this.send(ws, {
          type:
            "ACTION_REJECTED",

          playerId,

          action,

          code:
            validation.code ||
            "ABILITY_FAILED",

          error:
            validation.error ||
            "No se puede activar la habilidad.",

          required:
            validation.required,

          available:
            validation.available,
        });

        return;
      }

      await this.executeAbilityAction(
        ws,
        state,
        playerId,
        action,
      );

      return;
    }

    /* -------------------------------------------------------
     * PLAY CARD
     *
     * ÚNICO motor autorizado para colocar
     * cartas en campo.
     * ----------------------------------------------------- */

    if (
      name ===
        "PLAY_CARD" ||
      name ===
        "PLAY_CARD_FROM_HAND"
    ) {
      const result =
        playCard(
          state,
          playerId,
          action,
        );

      if (
        !result.ok
      ) {
        this.send(ws, {
          type:
            "ACTION_REJECTED",

          playerId,

          action,

          code:
            result.code ||
            "PLAY_CARD_FAILED",

          error:
            result.error,

          required:
            result.required,

          available:
            result.available,
        });

        return;
      }

      await this.finishGameAction(
        ws,
        state,
        playerId,
        action,
        result.events,
        "game_action",
      );

      return;
    }

    /* -------------------------------------------------------
     * TODO LO DEMÁS
     *
     * Mismo EffectEngine usado por IA/práctica.
     * ----------------------------------------------------- */

    const result =
      applyAction(
        state,
        playerId,
        action,
      );

    if (
      !result.ok
    ) {
      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action,

        code:
          result.code,

        error:
          result.error,
      });

      return;
    }

    await this.finishGameAction(
      ws,
      state,
      playerId,
      action,
      result.events,
      "game_action",
    );
  }

  /* ---------------------------------------------------------
   * FIN COMÚN DE ACCIÓN
   * ------------------------------------------------------- */

  private async finishGameAction(
    ws: WebSocket,
    state: GameState,
    playerId: string,
    action: GameAction,
    events: Array<
      Record<string, unknown>
    >,
    eventName:
      | "game_action"
      | "choice_resolved"
      | "ability_resolved",
  ): Promise<void> {

    /*
     * 1. Ejecutar todos los triggers derivados
     *    de la acción.
     */
    const triggerEvents =
      await this.dispatchEvents(
        state,
        playerId,
        events,
      );

    /*
     * 2. Guardar estado DESPUÉS de la acción
     *    y de los efectos de los triggers.
     */
    state.lastAction = {
      playerId,
      action,
      timestamp:
        Date.now(),
    };

    await this.saveState(
      state,
    );

    /*
     * 3. Avisar de la acción aceptada.
     */
    this.broadcast({
      type:
        "GAME_ACTION_RECEIVED",

      playerId,

      action,
    });

    /*
     * 4. Publicar eventos originales del motor con secuencia y unicidad.
     */
    state.eventSequence = (state.eventSequence || 0) + 1;
    const allActionEvents = [...events, ...triggerEvents];

    for (const gameEvent of events) {
      const eventId = String(
        gameEvent.eventId ||
        `evt_${Date.now()}_${state.eventSequence}_${Math.random().toString(36).slice(2, 7)}`
      );
      gameEvent.eventId = eventId;
      gameEvent.sequence = state.eventSequence;

      const sockets = this.ctx.getWebSockets();
      for (const wsItem of sockets) {
        const targetPlayerId = this.getPlayerId(wsItem);
        const pubEvt = buildPublicGameEvent(gameEvent, targetPlayerId);

        this.send(wsItem, {
          type: "GAME_EVENT",
          eventId,
          sequence: state.eventSequence,
          data: pubEvt,
        });

        this.send(wsItem, {
          type: "SERVER_EVENT",
          event: eventName,
          data: {
            playerId,
            action,
            effect: pubEvt,
          },
        });
      }
    }

    /*
     * 5. Publicar el trigger completo.
     *
     * El cliente puede usar este evento para
     * identificar qué trigger se disparó.
     */
    for (const triggerEvent of triggerEvents) {
      this.broadcast({
        type:
          "SERVER_EVENT",

        event:
          "trigger_dispatched",

        data: {
          playerId,
          action,
          effect:
            triggerEvent,
        },
      });

      /*
       * 6. PUBLICAR LOS EFECTOS REALES GENERADOS
       *    POR LA HABILIDAD DISPARADA.
       *
       * Antes:
       *   trigger_dispatched
       *      -> events: [ability_draw]
       *
       * Ahora:
       *   trigger_dispatched
       *   ability_resolved -> ability_draw
       *
       * Esto conecta explícitamente el resultado
       * del AbilityInterpreter con el cliente online.
       */
      const nestedEvents =
        Array.isArray(
          triggerEvent.events,
        )
          ? triggerEvent.events
          : [];

      for (const nestedEvent of nestedEvents) {
        this.broadcast({
          type:
            "SERVER_EVENT",

          event:
            "ability_resolved",

          data: {
            playerId,

            action,

            effect:
              nestedEvent,

            trigger:
              triggerEvent.trigger,

            sourceInstanceId:
              triggerEvent.affectedInstanceId,

            parentTrigger:
              "trigger_dispatched",
          },
        });
      }
    }

    /*
     * 7. Elecciones pendientes.
     */
    if (
      state.pendingChoice
    ) {
      this.send(ws, {
        type:
          "CHOICE_REQUIRED",

        choice:
          state.pendingChoice,
      });
    }

    /*
     * 8. Estado autoritativo final.
     */
    this.broadcastState(
      state,
    );
  }

  /* ---------------------------------------------------------
   * ABILITY
   * ------------------------------------------------------- */

  private async executeAbilityAction(
    ws: WebSocket,
    state: GameState,
    playerId: string,
    action: GameAction,
  ): Promise<void> {

    const sourceId =
      String(
        action.instanceId ??
          (action as any)
            .cardInstanceId ??
          action.cardId ??
          (action as any)
            .id ??
          "",
      );

    if (!sourceId) {
      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action,

        code:
          "SOURCE_REQUIRED",

        error:
          "ACTIVATE_ABILITY requiere instanceId o cardId.",
      });

      return;
    }

    try {
      /*
       * Si el rival tiene una elección pendiente,
       * no permitimos mezclar resoluciones.
       */
      if (
        state.pendingChoice &&
        state.pendingChoice.playerId !==
          playerId
      ) {
        this.send(ws, {
          type:
            "ACTION_REJECTED",

          playerId,

          action,

          code:
            "OTHER_PLAYER_CHOICE_PENDING",

          error:
            "El rival tiene una elección pendiente.",
        });

        return;
      }

      /*
       * Si el mismo jugador tiene un choice previo,
       * se limpia antes de reanudar.
       */
      if (
        state.pendingChoice &&
        state.pendingChoice.playerId ===
          playerId
      ) {
        state.pendingChoice =
          null;
      }

      const result =
        await executeMigratedAbility(
          state,
          playerId,
          sourceId,
          {
            trigger:
              typeof action.trigger ===
              "string"
                ? action.trigger
                : "ACTIVATED_VIGILIA",

            action,
          },
        );

      await this.finishGameAction(
        ws,
        state,
        playerId,
        action,
        result.events,
        "ability_resolved",
      );
    } catch (
      error
    ) {
      if (
        error instanceof
        PendingChoiceError
      ) {
        await this.saveState(
          state,
        );

        this.send(ws, {
          type:
            "CHOICE_REQUIRED",

          choice:
            state.pendingChoice,
        });

        this.broadcastState(
          state,
        );

        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : "Error al resolver la habilidad.";

      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action,

        code:
          "ABILITY_FAILED",

        error:
          message,
      });
    }
  }

  /* ---------------------------------------------------------
   * RESOLVE CHOICE
   * ------------------------------------------------------- */

  private async resolveChoice(
    ws: WebSocket,
    state: GameState,
    playerId: string,
    action: GameAction,
  ): Promise<void> {

    const pending =
      state.pendingChoice;

    if (
      !pending ||
      pending.playerId !==
        playerId
    ) {
      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action,

        code:
          "NO_PENDING_CHOICE",

        error:
          "No tienes una elección pendiente.",
      });

      return;
    }

    const answer =
      action.choice ??
      action.targetId ??
      action.targetIds ??
      action.name ??
      action.value;

    if (
      answer ===
      undefined
    ) {
      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action,

        code:
          "CHOICE_REQUIRED",

        error:
          "Debes enviar una respuesta a la elección.",
      });

      return;
    }

    /* -------------------------------------------------------
     * VALIDACIÓN DE CANDIDATOS
     * ----------------------------------------------------- */

    if (
      Array.isArray(
        pending.candidates,
      ) &&
      pending.candidates.length >
        0
    ) {
      const answers =
        Array.isArray(answer)
          ? answer.map(String)
          : [String(answer)];

      const valid =
        answers.every(
          (value) =>
            pending.candidates!.includes(
              value,
            ),
        );

      if (!valid) {
        this.send(ws, {
          type:
            "ACTION_REJECTED",

          playerId,

          action,

          code:
            "INVALID_CHOICE",

          error:
            "La respuesta no corresponde a una opción válida.",
        });

        return;
      }
    }

    /*
     * Recuperar respuestas previas.
     */
    const previousAnswers =
      Array.isArray(
        (pending.requestAction as any)
          ?.pendingAnswers,
      )
        ? [
            ...(
              (pending.requestAction as any)
                .pendingAnswers
            ),
          ]
        : [];

    const newAnswers = [
      ...previousAnswers,
      ...(Array.isArray(answer)
        ? answer
        : [answer]),
    ];

    /*
     * Limpiar el choice ANTES de reanudar.
     */
    state.pendingChoice =
      null;

    try {
      const resumedAction =
        {
          ...action,

          action:
            "ACTIVATE_ABILITY",

          instanceId:
            pending.sourceInstanceId,

          pendingAnswers:
            newAnswers,
        } as GameAction;

      const result =
        await executeMigratedAbility(
          state,
          playerId,
          pending.sourceInstanceId,
          {
            trigger:
              typeof pending
                .requestAction
                ?.trigger ===
              "string"
                ? pending
                    .requestAction
                    .trigger
                : "ACTIVATED_VIGILIA",

            action:
              resumedAction,
          },
        );

      await this.finishGameAction(
        ws,
        state,
        playerId,
        action,
        result.events,
        "choice_resolved",
      );
    } catch (
      error
    ) {
      if (
        error instanceof
        PendingChoiceError
      ) {
        await this.saveState(
          state,
        );

        this.send(ws, {
          type:
            "CHOICE_REQUIRED",

          choice:
            state.pendingChoice,
        });

        this.broadcastState(
          state,
        );

        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : "No se pudo resolver la elección.";

      this.send(ws, {
        type:
          "ACTION_REJECTED",

        playerId,

        action,

        code:
          "CHOICE_FAILED",

        error:
          message,
      });
    }
  }

  /* ---------------------------------------------------------
   * STATE
   * ------------------------------------------------------- */

  private async getState(): Promise<GameState> {
    const roomId =
      await this.ctx.storage.get<string>(
        this.ROOM_KEY,
      );

    if (!roomId) {
      throw new Error(
        "ROOM_ID_NOT_INITIALIZED",
      );
    }

    if (
      roomId ===
      "room"
    ) {
      throw new Error(
        "INVALID_ROOM_ID",
      );
    }

    let state =
      await this.ctx.storage.get<GameState>(
        this.STATE_KEY,
      );

    if (!state) {
      state =
        createGameState(
          roomId,
        );

      await this.saveState(
        state,
      );

      return state;
    }

    if (
      !state.roomId ||
      state.roomId ===
        "room"
    ) {
      state.roomId =
        roomId;

      await this.saveState(
        state,
      );
    }

    if (
      state.roomId !==
      roomId
    ) {
      throw new Error(
        `ROOM_STATE_MISMATCH: state=${state.roomId} stored=${roomId}`,
      );
    }

    return state;
  }

  private async saveState(
    state: GameState,
  ): Promise<void> {
    await this.ctx.storage.put(
      this.STATE_KEY,
      state,
    );
  }

  private async ensureRoomId(
    roomId: string,
  ): Promise<void> {
    if (
      !roomId ||
      roomId ===
        "room"
    ) {
      throw new Error(
        "INVALID_ROOM_ID",
      );
    }

    const stored =
      await this.ctx.storage.get<string>(
        this.ROOM_KEY,
      );

    if (!stored) {
      await this.ctx.storage.put(
        this.ROOM_KEY,
        roomId,
      );

      const state =
        await this.ctx.storage.get<GameState>(
          this.STATE_KEY,
        );

      if (
        state &&
        (
          !state.roomId ||
          state.roomId ===
            "room"
        )
      ) {
        state.roomId =
          roomId;

        await this.saveState(
          state,
        );
      }

      return;
    }

    if (
      stored !==
      roomId
    ) {
      throw new Error(
        `ROOM_ID_MISMATCH: stored=${stored} incoming=${roomId}`,
      );
    }

    const state =
      await this.ctx.storage.get<GameState>(
        this.STATE_KEY,
      );

    if (
      state &&
      state.roomId !==
        roomId
    ) {
      state.roomId =
        roomId;

      await this.saveState(
        state,
      );
    }
  }

  /* ---------------------------------------------------------
   * WEBSOCKET
   * ------------------------------------------------------- */

  private handleWebSocket(
    request: Request,
  ): Response {
    const pair =
      new WebSocketPair();

    const [
      client,
      server,
    ] = Object.values(pair);

    const url =
      new URL(request.url);

    const playerId =
      url.searchParams.get(
        "playerId",
      );

    const role =
      url.searchParams.get(
        "role",
      ) ||
      (
        playerId?.startsWith(
          "spectator",
        )
          ? "spectator"
          : "player"
      );

    if (!playerId) {
      return fail(
        "playerId requerido",
      );
    }

    this.ctx.acceptWebSocket(
      server,
      [
        playerId,
        role,
      ],
    );

    this.send(server, {
      type:
        "SOCKET_CONNECTED",

      playerId,

      role,
    });

    return new Response(
      null,
      {
        status:
          101,
        webSocket:
          client,
      },
    );
  }

  private extractRoomId(
    pathname: string,
  ): string | null {
    const parts =
      pathname
        .split("/")
        .filter(Boolean);

    const index =
      parts.findIndex(
        (part) =>
          part ===
            "room" ||
          part ===
            "rooms",
      );

    return index >= 0
      ? parts[
          index + 1
        ] ?? null
      : null;
  }

  /* ---------------------------------------------------------
   * PLAYER / SOCKET
   * ------------------------------------------------------- */

  private getPlayerId(
    ws: WebSocket,
  ): string | null {
    const tags =
      this.ctx.getTags(
        ws,
      );

    return (
      tags[0] ??
      null
    );
  }

  private isSpectator(
    ws: WebSocket,
  ): boolean {
    const tags =
      this.ctx.getTags(
        ws,
      );

    return Boolean(
      tags.includes(
        "spectator",
      ) ||
        (
          tags[0] &&
          tags[0].startsWith(
            "spectator",
          )
        ),
    );
  }

  private players(
    state: GameState,
  ): Record<
    string,
    RoomPlayer
  > {
    return Object.fromEntries(
      Object.values(
        state.players,
      ).map(
        (player) => [
          player.id,

          {
            id:
              player.id,

            name:
              player.name,

            connected:
              player.connected,

            deckCount:
              player.castle
                .length,
          },
        ],
      ),
    );
  }

  /* ---------------------------------------------------------
   * BROADCAST
   * ------------------------------------------------------- */

  private broadcastState(
    state: GameState,
  ): void {
    const sockets =
      this.ctx.getWebSockets();

    for (const ws of sockets) {
      const playerId =
        this.getPlayerId(
          ws,
        );

      if (!playerId) {
        continue;
      }

      const spectator =
        this.isSpectator(
          ws,
        );

      this.send(ws, {
        type:
          "ROOM_STATE",

        roomId:
          state.roomId,

        isSpectator:
          spectator,

        players:
          this.players(
            state,
          ),

        gameState:
          publicState(
            state,
            spectator
              ? undefined
              : playerId,
          ),
      });
    }
  }

  private broadcast(
    message: unknown,
  ): void {
    for (
      const ws of
        this.ctx.getWebSockets()
    ) {
      this.send(
        ws,
        message,
      );
    }
  }

  private send(
    ws: WebSocket,
    message: unknown,
  ): void {
    try {
      ws.send(
        JSON.stringify(
          message,
        ),
      );
    } catch {
      // socket cerrado
    }
  }

  /* ---------------------------------------------------------
   * DISCONNECT
   * ------------------------------------------------------- */

  async webSocketClose(
    ws: WebSocket,
  ): Promise<void> {
    await this.disconnect(
      ws,
    );
  }

  async webSocketError(
    ws: WebSocket,
  ): Promise<void> {
    await this.disconnect(
      ws,
    );
  }

  private async disconnect(
    ws: WebSocket,
  ): Promise<void> {
    const playerId =
      this.getPlayerId(
        ws,
      );

    if (!playerId) {
      return;
    }

    try {
      const state =
        await this.getState();

      if (
        state.players[
          playerId
        ]
      ) {
        state.players[
          playerId
        ].connected =
          false;

        await this.saveState(
          state,
        );

        this.broadcastState(
          state,
        );
      }
    } catch {
      // El room puede haber sido destruido.
    }
  }
}

/* =========================================================
 * WORKER ENTRYPOINT
 * ======================================================= */

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const url =
      new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS",

      "Access-Control-Allow-Headers":
        "Content-Type",
    };

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status:
            204,

          headers:
            corsHeaders,
        },
      );
    }

    /* -------------------------------------------------------
     * HEALTH
     * ----------------------------------------------------- */

    if (
      url.pathname ===
      "/health"
    ) {
      return new Response(
        JSON.stringify({
          service:
            "Acero TCG Server",

          status:
            "online",

          transport:
            "WebSocket",

          authoritative:
            true,

          durableObjects: {
            lobby:
              "AceroLobbyManager",

            game:
              "AceroGameRoom",
          },
        }),
        {
          status:
            200,

          headers: {
            "content-type":
              "application/json",

            ...corsHeaders,
          },
        },
      );
    }

    /* -------------------------------------------------------
     * LOBBIES / MATCHMAKING
     * ----------------------------------------------------- */

    if (
      url.pathname ===
        "/lobbies" ||
      url.pathname.startsWith(
        "/lobbies/",
      ) ||
      url.pathname ===
        "/matchmaking" ||
      url.pathname.startsWith(
        "/matchmaking/",
      )
    ) {
      const lobbyId =
        env.ACERO_LOBBY_MANAGER.idFromName(
          "global-lobby",
        );

      const response =
        await env
          .ACERO_LOBBY_MANAGER
          .get(lobbyId)
          .fetch(request);

      const headers =
        new Headers(
          response.headers,
        );

      Object.entries(
        corsHeaders,
      ).forEach(
        ([
          key,
          value,
        ]) => {
          headers.set(
            key,
            value,
          );
        },
      );

      return new Response(
        response.body,
        {
          status:
            response.status,

          headers,
        },
      );
    }

    /* -------------------------------------------------------
     * ROOM
     * ----------------------------------------------------- */

    if (
      url.pathname.startsWith(
        "/room/",
      ) ||
      url.pathname.startsWith(
        "/rooms/",
      )
    ) {
      const parts =
        url.pathname
          .split("/")
          .filter(Boolean);

      const roomId =
        parts[1];

      if (
        !roomId ||
        roomId ===
          "room"
      ) {
        return fail(
          "roomId inválido",
          400,
        );
      }

      const durableId =
        env.ACERO_GAME_ROOM.idFromName(
          roomId,
        );

      return env
        .ACERO_GAME_ROOM
        .get(durableId)
        .fetch(
          request,
        );
    }

    /* -------------------------------------------------------
     * DEFAULT
     * ----------------------------------------------------- */

    return new Response(
      JSON.stringify({
        ok: true,
        service:
          "Acero TCG Server",
      }),
      {
        status:
          200,

        headers: {
          "content-type":
            "application/json",

          ...corsHeaders,
        },
      },
    );
  },
};