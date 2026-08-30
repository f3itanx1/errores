import { normalizeRoom, getStableUserId, formatErrorMessage, type NormalizedRoom } from './roomAdapter';

type Handler = (...args: any[]) => void;

type LobbyInfo = {
  id: string;
  roomId: string;
  host: any;
  guest?: any | null;
  status: 'waiting' | 'playing';
  createdAt?: number;
  isRanked?: boolean;
  matchFormat?: string;
  gameFormat?: string;
};

export interface AceroSocketRender {
  id: string;
  connected: boolean;
  on(event: string, handler: Handler): this;
  off(event: string, handler?: Handler): this;
  once(event: string, handler: Handler): this;
  emit(event: string, payload?: any): boolean;
  disconnect(): this;
}

const WS_BASE_URL = (process.env.NEXT_PUBLIC_ACERO_SERVER_URL || 'https://acero-server.acero-tcg.workers.dev').replace(/\/$/, '');
const REST_BASE_URL = process.env.NEXT_PUBLIC_ACERO_SERVER_URL
  ? process.env.NEXT_PUBLIC_ACERO_SERVER_URL.replace(/\/$/, '')
  : 'https://acero-server.acero-tcg.workers.dev';

function getPlayerId(customId?: string): string {
  if (customId) return String(customId);
  return getStableUserId();
}

function wsUrl(roomId: string, id: string, name: string, role = 'player'): string {
  if (!WS_BASE_URL) throw new Error('NEXT_PUBLIC_ACERO_SERVER_URL no está configurada.');
  const url = new URL(WS_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/room/${encodeURIComponent(roomId)}`;
  url.search = new URLSearchParams({ playerId: id, playerName: name, role }).toString();
  return url.toString();
}

async function jsonRequest(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${REST_BASE_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return body;
}

import cardsCatalog from '../data/cards.json';

const catalogList: any[] = Array.isArray(cardsCatalog) ? cardsCatalog : (cardsCatalog as any).cards || [];
const catalogMap = new Map<string, any>(catalogList.map((c: any) => [String(c.id), c]));
const catalogNameMap = new Map<string, any>(catalogList.map((c: any) => [
  String(c.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(),
  c
]));

export function flattenDeck(deckInput: any): any[] {
  if (!deckInput) return [];
  const items: any[] = Array.isArray(deckInput.cards) ? deckInput.cards : (Array.isArray(deckInput) ? deckInput : []);
  const startingGoldId = deckInput.startingGoldId;
  const flatCards: any[] = [];

  for (const item of items) {
    const card = item.card || item;
    const count = typeof item.count === 'number' ? item.count : 1;
    const normName = String(card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const master = catalogMap.get(String(card.id || card.cardId)) || catalogNameMap.get(normName) || {};

    for (let i = 0; i < count; i++) {
      const isStartGold = startingGoldId && (String(card.id) === String(startingGoldId) || String(card.cardId) === String(startingGoldId));
      flatCards.push({
        ...master,
        ...card,
        id: String(card.id || card.cardId || master.id || 'card'),
        cardId: String(card.id || card.cardId || master.id || 'card'),
        name: card.name || master.name || 'Carta',
        type: card.type || master.type || 'Aliado',
        race: card.race || master.race || '',
        keywords: card.keywords || master.keywords || [],
        cost: Number(card.cost !== undefined ? card.cost : (master.cost || 0)),
        ability: (card.ability && String(card.ability).trim()) ? card.ability : (master.ability || ''),
        imageUrl: card.imageUrl || master.imageUrl || '',
        isOroInicial: Boolean(isStartGold || card.isOroInicial || card.isStartingGold),
      });
    }
  }
  return flatCards;
}

export function io(_url?: string, options?: any): AceroSocketRender {
  return new AceroSocketRenderImpl(options?.playerId || options?.userId);
}

class AceroSocketRenderImpl implements AceroSocketRender {
  readonly id: string;
  connected = true;

  private handlers = new Map<string, Set<Handler>>();
  private roomSocket: WebSocket | null = null;
  private pollTimer: number | null = null;
  private lobbyId: string | null = null;
  private roomId: string | null = null;
  private playerName = 'Jugador';
  private currentDeck: any[] = [];
  private stopped = false;

  constructor(customPlayerId?: string) {
    this.id = getPlayerId(customPlayerId);
    queueMicrotask(() => {
      if (!this.stopped) this.fire('connect');
    });
  }

  on(event: string, handler: Handler): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }

  off(event: string, handler?: Handler): this {
    if (!handler) this.handlers.delete(event);
    else this.handlers.get(event)?.delete(handler);
    return this;
  }

  once(event: string, handler: Handler): this {
    const wrapper: Handler = (...args: any[]) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  emit(event: string, payload?: any): boolean {
    void this.dispatch(event, payload);
    return true;
  }

  disconnect(): this {
    this.stopped = true;
    if (this.pollTimer !== null && typeof window !== 'undefined') window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.roomSocket?.close();
    this.roomSocket = null;
    this.connected = false;
    this.fire('disconnect', 'client disconnect');
    return this;
  }

  private fire(event: string, ...args: any[]): void {
    for (const handler of [...(this.handlers.get(event) || [])]) {
      try { handler(...args); } catch (error) { console.error(`[AceroSocketCloudflare:${event}]`, error); }
    }
  }

  private async dispatch(event: string, payload: any): Promise<void> {
    try {
      switch (event) {
        case 'get_lobbies': return await this.refreshLobbies();
        case 'request_lobby_user_count': return await this.fetchUserCount();
        case 'find_match':
        case 'matchmaking':
          return await this.findMatch(payload);
        case 'create_lobby': return await this.createLobby(payload);
        case 'join_lobby': return await this.joinLobby(payload);
        case 'leave_lobby': return await this.leaveLobby(payload);
        case 'roll_dice':
        case 'ROLL_DICE':
          return this.send({ type: 'ROLL_DICE', data: { ...payload, playerId: payload?.playerId || this.id } });
        case 'player_action': return this.send({ type: 'GAME_ACTION', data: payload?.actionData ?? payload?.data ?? payload });
        case 'GET_STATE': return this.send({ type: 'GET_STATE' });
        case 'START_GAME': return this.send({ type: 'START_GAME' });
        default:
          if (this.roomSocket?.readyState === WebSocket.OPEN) this.send({ type: event, data: payload });
      }
    } catch (error) {
      this.fire('error_message', error instanceof Error ? error.message : 'Error de comunicación con el servidor.');
    }
  }

  private async fetchUserCount(): Promise<void> {
    try {
      const res = await fetch('/api/online-count');
      if (res.ok) {
        const data = await res.json();
        this.fire('lobby_user_count_update', data.count || 1);
      }
    } catch {
      this.fire('lobby_user_count_update', 1);
    }
  }

  private async refreshLobbies(): Promise<void> {
    const data = await jsonRequest('/lobbies');
    this.fire('lobby_list', Array.isArray(data?.lobbies) ? data.lobbies : []);
  }

  private async findMatch(payload: any): Promise<void> {
    this.playerName = String(payload?.playerName || 'Jugador').trim() || 'Jugador';
    const isRanked = Boolean(payload?.isRanked);
    const matchFormat = payload?.matchFormat || 'bo1';
    const deck = flattenDeck(payload?.deck);
    this.currentDeck = deck;
    const deckName = String(payload?.deckName || payload?.deck?.name || 'Mazo Imperio');

    console.log(`[QUICK MATCH] Solicitando matchmaking para playerId=${this.id}, name=${this.playerName}, ranked=${isRanked}`);

    const data = await jsonRequest('/matchmaking', {
      method: 'POST',
      body: JSON.stringify({
        playerId: this.id,
        playerName: this.playerName,
        deckName,
        deck,
        isRanked,
        matchFormat,
      }),
    });

    const lobby = normalizeRoom(data.lobby || data);
    if (!lobby) {
      throw new Error('No se pudo obtener la información de la sala de emparejamiento.');
    }

    if (lobby.host) {
      lobby.host.deckName = deckName;
    }
    this.lobbyId = lobby.id;
    this.roomId = lobby.roomId;

    console.log(`[QUICK MATCH] Respuesta: roomId=${lobby.roomId}, matched=${data.matched}, status=${lobby.status}`);

    if (data.matched || data.startMatch) {
      this.fire('lobby_update', lobby);
      await this.openRoom(lobby.roomId, lobby);
      this.fire('start_match', {
        id: lobby.id,
        roomId: lobby.roomId,
        status: 'playing',
        lobby,
      });
    } else {
      this.fire('lobby_created', lobby);
      await this.openRoom(lobby.roomId, lobby);
      this.startPolling(lobby);
    }
  }

  private async createLobby(payload: any): Promise<void> {
    this.playerName = String(payload?.playerName || 'Jugador').trim() || 'Jugador';
    const deck = flattenDeck(payload?.deck);
    this.currentDeck = deck;
    const deckName = String(payload?.deckName || payload?.deck?.name || 'Mazo Imperio');

    const data = await jsonRequest('/lobbies', {
      method: 'POST',
      body: JSON.stringify({
        playerId: this.id,
        playerName: this.playerName,
        deckName,
        deck,
        matchFormat: payload?.matchFormat || 'bo1',
        isRanked: payload?.isRanked || false,
        customRules: { firstPlayerNoDraw: true },
      }),
    });

    const lobby = normalizeRoom(data.lobby || data);
    if (!lobby) {
      throw new Error('Error al crear la sala.');
    }

    if (lobby.host) {
      lobby.host.deckName = deckName;
    }
    this.lobbyId = lobby.id;
    this.roomId = lobby.roomId;
    this.fire('lobby_created', lobby);

    await this.openRoom(lobby.roomId, lobby);
    this.startPolling(lobby);
  }

  private async joinLobby(payload: any): Promise<void> {
    this.playerName = String(payload?.playerName || 'Jugador').trim() || 'Jugador';
    const deck = flattenDeck(payload?.deck);
    this.currentDeck = deck;
    const deckName = String(payload?.deckName || payload?.deck?.name || 'Mazo Imperio');
    const lobbyId = String(payload?.lobbyId || payload?.id || '');
    if (!lobbyId) throw new Error('Falta el lobbyId.');

    const data = await jsonRequest(`/lobbies/${encodeURIComponent(lobbyId)}/join`, {
      method: 'POST',
      body: JSON.stringify({ playerId: this.id, playerName: this.playerName, deckName, deck }),
    });

    this.lobbyId = lobbyId;
    this.roomId = data.roomId;
    const lobby = normalizeRoom(data.lobby || { id: lobbyId, roomId: data.roomId, status: 'playing' });
    this.fire('lobby_update', lobby);

    await this.openRoom(data.roomId, lobby || ({} as any));
  }

  private async leaveLobby(payload: any): Promise<void> {
    const lobbyId = String(payload?.lobbyId || payload?.id || this.lobbyId || '');
    if (!lobbyId) return;
    if (this.pollTimer !== null && typeof window !== 'undefined') window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.roomSocket?.close();
    this.roomSocket = null;
    await jsonRequest(`/lobbies/${encodeURIComponent(lobbyId)}/leave`, {
      method: 'POST',
      body: JSON.stringify({ playerId: this.id }),
    }).catch(() => undefined);
  }

  private startPolling(lobby: NormalizedRoom): void {
    if (this.pollTimer !== null && typeof window !== 'undefined') window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        if (!this.lobbyId) return;
        const res = await jsonRequest(`/lobbies/by-slug/${encodeURIComponent(lobby.displayNumber || lobby.id)}`);
        const data = res?.lobby || res;
        if (!data) return;

        const currentLobby = normalizeRoom(data);
        if (currentLobby && currentLobby.status === 'playing' && currentLobby.guest) {
          if (this.pollTimer !== null && typeof window !== 'undefined') window.clearInterval(this.pollTimer);
          this.pollTimer = null;
          this.fire('lobby_update', currentLobby);
          await this.openRoom(this.roomId || currentLobby.roomId, currentLobby);
          this.fire('start_match', {
            id: currentLobby.id,
            roomId: this.roomId || currentLobby.roomId,
            status: 'playing',
            lobby: currentLobby,
          });
        }
      } catch {
        // Ignorar errores de sondeo temporal
      }
    }, 1200);
  }

  private async openRoom(roomId: string, lobby: NormalizedRoom | any, role = 'player'): Promise<void> {
    if (this.roomSocket && this.roomSocket.readyState === WebSocket.OPEN) return;
    if (this.stopped) return;

    try {
      const socket = new WebSocket(wsUrl(roomId, this.id, this.playerName, role));
      this.roomSocket = socket;

      socket.onopen = () => {
        this.connected = true;
        this.fire('connect');
        console.log(`[WEBSOCKET] Conectado a sala ${roomId} con playerId=${this.id}`);
        socket.send(JSON.stringify({
          type: 'HELLO',
          playerName: this.playerName,
          deck: this.currentDeck
        }));
      };

      socket.onmessage = (event) => {
        try { this.handleMessage(JSON.parse(String(event.data))); }
        catch { this.fire('error_message', 'El servidor envió un mensaje inválido.'); }
      };

      socket.onerror = () => {
        this.fire('connect_error', new Error('No se pudo conectar al WebSocket de Cloudflare.'));
      };

      socket.onclose = () => {
        this.roomSocket = null;
        this.connected = false;
        this.fire('disconnect', 'websocket close');
      };
    } catch (err) {
      console.error('[AceroSocketCloudflare] openRoom error', err);
    }
  }

  private handleMessage(message: any): void {
    const type = String(message?.type || '');
    switch (type) {
      case 'GAME_STARTED':
        if (this.pollTimer !== null && typeof window !== 'undefined') window.clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.fire('game_started', message);
        this.fire('start_match', {
          id: this.lobbyId,
          roomId: this.roomId || message.roomId,
          status: 'playing',
          players: message.players,
          gameState: message.gameState,
        });
        if (message.gameState || message.state) {
          this.fire('game_state', message.gameState || message.state);
          this.fire('game_state_update', message.gameState || message.state);
          this.fire('state_update', message.gameState || message.state);
        }
        break;
      case 'ROOM_CONNECTED':
        if (message.players) {
          const rawPlayers = message.players;
          const pList: any[] = Array.isArray(rawPlayers) ? rawPlayers : Object.values(rawPlayers || {});
          if (pList.length >= 2) {
            const guest = pList.find((p: any) => p.id !== this.id);
            if (guest) {
              this.fire('lobby_update', {
                id: this.lobbyId,
                roomId: this.roomId,
                status: 'playing',
                guest: { id: guest.id, name: guest.name },
              });
            }
          }
        }
        if (message.gameState?.started) {
          if (this.pollTimer !== null && typeof window !== 'undefined') window.clearInterval(this.pollTimer);
          this.pollTimer = null;
          this.fire('game_started', message);
          this.fire('start_match', {
            id: this.lobbyId,
            roomId: this.roomId || message.roomId,
            status: 'playing',
            players: message.players,
            gameState: message.gameState,
          });
        }
        if (message.gameState || message.state) {
          this.fire('game_state', message.gameState || message.state);
          this.fire('game_state_update', message.gameState || message.state);
          this.fire('state_update', message.gameState || message.state);
        }
        break;
      case 'ROOM_STATE':
        if (message.players) {
          const rawPlayers = message.players;
          const pList: any[] = Array.isArray(rawPlayers) ? rawPlayers : Object.values(rawPlayers || {});
          if (pList.length >= 2) {
            const guest = pList.find((p: any) => p.id !== this.id);
            if (guest) {
              this.fire('lobby_update', {
                id: this.lobbyId,
                roomId: this.roomId || message.roomId,
                status: 'playing',
                guest: { id: guest.id, name: guest.name },
              });
            }
          }
        }
        if (message.gameState?.started) {
          if (this.pollTimer !== null && typeof window !== 'undefined') window.clearInterval(this.pollTimer);
          this.pollTimer = null;
          this.fire('game_started', message);
          this.fire('start_match', {
            id: this.lobbyId,
            roomId: this.roomId || message.roomId,
            status: 'playing',
            players: message.players,
            gameState: message.gameState,
          });
        }
        if (message.gameState || message.state) {
          this.fire('game_state', message.gameState || message.state);
          this.fire('game_state_update', message.gameState || message.state);
          this.fire('state_update', message.gameState || message.state);
        }
        break;
      case 'CHOICE_REQUIRED':
        this.fire('choice_required', message.choice);
        break;
      case 'DICE_STATUS_UPDATE':
        this.fire('DICE_STATUS_UPDATE', message);
        break;
      case 'DICE_RESOLVED':
        this.fire('DICE_RESOLVED', message);
        break;
      case 'FIRST_PLAYER_CHOSEN':
        this.fire('first_player_chosen', message.data || message);
        break;
      case 'SPECTATOR_JOINED':
        this.fire('spectator_update', message.spectators || []);
        break;
      case 'ACTION_REJECTED': {
        const errMsg = formatErrorMessage(message);
        this.fire('action_rejected', errMsg);
        this.fire('error_message', errMsg);
        break;
      }
      case 'ERROR': {
        const genErr = formatErrorMessage(message);
        this.fire('error_message', genErr);
        break;
      }
      case 'SERVER_EVENT': {
        this.fire('SERVER_EVENT', message.data || message);
        this.fire('server_event', message.data || message);
        const eventName = message.event || message.data?.event;
        if (eventName) {
          this.fire(eventName, message.data || message);
        }
        const effect = message.data?.effect || message.effect;
        if (effect && typeof effect === 'object') {
          if (effect.type) {
            this.fire(effect.type, { ...message.data, ...effect });
          }
          if (effect.message) {
            this.fire('notice', {
              message: effect.message,
              level: effect.level || 'info',
              type: effect.level || 'info',
              playerId: message.data?.playerId || message.playerId
            });
          }
        }
        break;
      }
      case 'GAME_EVENT': {
        this.fire('GAME_EVENT', message.data || message);
        this.fire('game_event', message.data || message);
        const evData = message.data || message;
        if (evData?.type) {
          this.fire(evData.type, evData);
        }
        break;
      }
      case 'GAME_ACTION_RECEIVED': {
        this.fire('GAME_ACTION_RECEIVED', message.data || message);
        this.fire('game_action_received', message.data || message);
        break;
      }
      default:
        this.fire(type, message.data || message);
        if (message.event) {
          this.fire(message.event, message.data || message);
        }
    }
  }

  private send(data: any): void {
    if (this.roomSocket?.readyState === WebSocket.OPEN) {
      this.roomSocket.send(JSON.stringify(data));
    }
  }
}
