'use client';

import React, {
  useMemo,
  useEffect,
  useState,
  useRef,
  useCallback
} from 'react';

import {
  Swords,
  Home,
  X,
  Shield,
  Ban,
  Zap,
  Search,
  ShieldAlert,
  BookOpen,
  Trophy,
  Clock,
  Flag,
  RotateCcw,
  Eye,
  Maximize
} from 'lucide-react';

import cardsCatalog from '../data/cards.json';
import { resolveAbility } from '../game/abilityEngine';
import { parseAbility } from '../game/abilityParser';
import { recordMatchResult, getPlayerStats, DEFAULT_AVATAR } from '../utils/playerStats';
import { executeAiFullTurn, evaluateAiBlockers } from '../game/ai/aiBotEngine';
import { AiBotProfile } from '../game/ai/aiDecks';
import cardAbilityInventory from '../data/card-ability-inventory.json';
import { AbilityInterpreter } from '../game/engine/abilityInterpreter';
import {
  canPlayCard,
  canActivateAbility,
  canDeclareAttack,
  canDeclareBlock,
  resolveAutomaticGrouping,
  resolveFinalPhaseDraw,
  DAR_PHASE_INDEX,
  DAR_PHASE_NAMES,
  getCardPhaseException,
  isResponseCard
} from '../game/engine/phaseValidator';
import { GoldRulesEngine, GoldRulesState, createInitialGoldRulesState } from '../game/engine/goldRulesEngine';
import { useDeviceLayout } from '../hooks/useDeviceLayout';
import { PortraitBlocker } from './layout/PortraitBlocker';
import { GameModal } from './ui/GameModal';
import { MobileLandscapeLayout } from './layout/MobileLandscapeLayout';
import { TabletLandscapeLayout } from './layout/TabletLandscapeLayout';
import { DesktopLayout } from './layout/DesktopLayout';
import { MenuDrawerModal } from './ui/MenuDrawerModal';
import { ResponsiveCard } from './ui/ResponsiveCard';
import { MobileCardInspector } from './ui/MobileCardInspector';
import { ZoneDrawerModal } from './ui/ZoneDrawerModal';
import { VFXLayer, VFXEvent } from './ui/VFXLayer';

const catalogCardsList: any[] = Array.isArray(cardsCatalog) ? cardsCatalog : (cardsCatalog as any).cards;
const inventoryList = (cardAbilityInventory as any).inventory || [];
AbilityInterpreter.initInventory(inventoryList);
const catalogMapById = new Map<string, any>(catalogCardsList.map((c: any) => [String(c.id), c]));
const catalogMapByName = new Map<string, any>(catalogCardsList.map((c: any) => [
  String(c.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(),
  c
]));

export const getMasterCardData = (card: any): any => {
  if (!card) return card;
  const normName = String(card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const master = catalogMapById.get(String(card.id)) || catalogMapByName.get(normName);
  if (master) {
    const isBlanked = card.hasNoAbility || card.losesAbilities || card.sinHabilidad || String(card.ability || '').toLowerCase().startsWith('sin habilidad') || String(card.ability || '').toLowerCase().startsWith('oro sin habilidad') || String(card.ability || '').toLowerCase().startsWith('aliado sin habilidad');
    return {
      ...master,
      ...card,
      cost: master.cost !== undefined ? master.cost : card.cost,
      type: master.type || card.type,
      strength: master.strength !== undefined ? master.strength : card.strength,
      ability: isBlanked ? (card.ability || 'Sin habilidad.') : (card.ability !== undefined ? card.ability : master.ability),
      imageUrl: master.imageUrl || card.imageUrl,
    };
  }
  return card;
};

export const getCardCost = (card: any): number => {
  if (!card) return 0;
  const master = getMasterCardData(card);
  if (master.type === 'Oro') return 0;
  return Number(master.cost !== undefined ? master.cost : card.cost) || 0;
};

const DAR_PHASES = [
  'Agrupación',
  'Vigilia',
  'Ataque',
  'Fase Final'
];

export default function GameBoard({
  setView,
  currentDeckName,

  castleCards,
  setCastleCards,

  hand,
  setHand,

  attackZone,
  setAttackZone,

  defenseZone,
  setDefenseZone,

  totemZone,
  setTotemZone,

  goldZone,
  setGoldZone,

  graveyard,
  setGraveyard,

  banished,
  setBanished,

  playerSideboard = [],

  // =========================================================
  // ZONAS OPONENTE
  // =========================================================

  opponentAttackZone = [],
  setOpponentAttackZone,

  opponentDefenseZone = [],
  setOpponentDefenseZone,

  opponentTotemZone = [],
  setOpponentTotemZone,

  opponentGoldZone = [],
  setOpponentGoldZone,

  opponentGraveyard = [],
  setOpponentGraveyard,

  opponentBanished = [],
  setOpponentBanished,

  // =========================================================
  // PARTIDA
  // =========================================================

  turn,
  currentPhaseIndex,
  advancePhase,
  playerGoesFirst,

  activePlayerId,
  responseWindow,
  responsePlayerId,
  myPlayerId: suppliedPlayerId,

  opponentCastleCount,
  setOpponentCastleCount,

  opponentHandCount,
  opponentReserveGold,
  opponentPaidGold,

  // =========================================================
  // RONDA BO3 Y MATCH
  // =========================================================

  matchState,
  mulliganCount = 0,
  usedGoldMulligan = false,
  opponentRevealedMulligan = null,
  setOpponentRevealedMulligan,

  // =========================================================
  // CARTAS
  // =========================================================

  getCardRaces,

  // =========================================================
  // OTROS
  // =========================================================

  showMulliganModal,
  setShowMulliganModal,

  usedFreeMulligan,
  executeMulligan,

  goldsInHandCount,

  showDarRulesModal,
  setShowDarRulesModal,

  multiplayerData,
  currentUser,
  namedCards = [],
  setNamedCards,

  // IA Props
  aiBotProfile,
  opponentHand = [],
  setOpponentHand,
  opponentCastleCards = [],
  setOpponentCastleCards,
  setTurn,
  setCurrentPhaseIndex
}: any) {

  // =========================================================
  // SOCKET / MULTIPLAYER
  // =========================================================

  const socket =
    multiplayerData?.socket;

  const lobbyCode =
    multiplayerData?.lobbyData?.id;

  const lobbyData =
    multiplayerData?.lobbyData;

  const myPlayerId =
    suppliedPlayerId ||
    socket?.id ||
    'player';

  const isMultiplayer =
    Boolean(
      socket &&
      lobbyCode
    );

  const [localIsMyTurn, setLocalIsMyTurn] = useState<boolean>(true);

  const isMyTurn =
    isMultiplayer
      ? activePlayerId === myPlayerId
      : (!aiBotProfile || localIsMyTurn);

  const canRespond =
    isMultiplayer &&
    responseWindow &&
    responsePlayerId ===
      myPlayerId;

  const canMakeTurnAction =
    (
      isMyTurn &&
      !responseWindow
    ) ||
    canRespond;

  const isPlayer1 =
    lobbyData?.host?.id ===
    myPlayerId;

  const opponentInfo =
    isPlayer1
      ? lobbyData?.guest
      : lobbyData?.host;

  const opponentName =
    (!isMultiplayer && aiBotProfile)
      ? `${aiBotProfile.name} [${aiBotProfile.race}]`
      : opponentInfo?.name || 'Oponente';

  const opponentAvatar =
    (!isMultiplayer && aiBotProfile?.avatarUrl)
      ? aiBotProfile.avatarUrl
      : '/images/avatars/avatar_demonio_lucifer.jpg';

  const [playerAvatar, setPlayerAvatar] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const global = localStorage.getItem('acerotcg_selected_avatar');
      if (global) return global;
    }
    return getPlayerStats(currentUser?.username)?.avatar || DEFAULT_AVATAR;
  });

  useEffect(() => {
    const handleAvatarChange = (e: any) => {
      if (e.detail) setPlayerAvatar(e.detail);
    };
    if (typeof window !== 'undefined') {
      const global = localStorage.getItem('acerotcg_selected_avatar');
      if (global) setPlayerAvatar(global);
      window.addEventListener('acerotcg_avatar_changed', handleAvatarChange);
      return () => window.removeEventListener('acerotcg_avatar_changed', handleAvatarChange);
    }
  }, [currentUser?.username]);

  // =========================================================
  // ENVIAR ACCIÓN AL SERVIDOR
  // =========================================================

  const sendGameAction = (
    actionData: any
  ) => {

    if (
      !isMultiplayer ||
      !lobbyCode ||
      !socket
    ) {

      return false;
    }

    console.log(
      '[GAME] PLAYER_ACTION:',
      {
        lobbyId:
          lobbyCode,

        actionData
      }
    );

    socket.emit(
      'player_action',
      {
        lobbyId:
          lobbyCode,

        actionData
      }
    );

    return true;
  };

  // =========================================================
  // POPUP CARTA
  // =========================================================

  const [
    previewPosition,
    setPreviewPosition
  ] = useState({
    x: 0,
    y: 0
  });

  const [
    previewVisible,
    setPreviewVisible
  ] = useState(false);

  const [
    hoveredCard,
    setHoveredCard
  ] = useState<any>(null);

  const [
    activatingAbilityCardId,
    setActivatingAbilityCardId
  ] = useState<string | null>(null);

  // =========================================================
  // PAGO OROS
  // =========================================================

  const [
    pendingCard,
    setPendingCard
  ] = useState<any>(null);

  const [
    selectedGoldIds,
    setSelectedGoldIds
  ] = useState<string[]>([]);

  const [
    showGoldModal,
    setShowGoldModal
  ] = useState(false);

  // =========================================================
  // VISUALIZAR OROS
  // =========================================================

  const [
    showReserveGold,
    setShowReserveGold
  ] = useState(false);

  const [
    showPaidGold,
    setShowPaidGold
  ] = useState(false);

  const [
    showOpponentReserveGold,
    setShowOpponentReserveGold
  ] = useState(false);

  const [
    showOpponentPaidGold,
    setShowOpponentPaidGold
  ] = useState(false);

  // =========================================================
  // CEMENTERIO / DESTIERRO
  // =========================================================

  const [
    showGraveyard,
    setShowGraveyard
  ] = useState(false);

  const [
    showBanished,
    setShowBanished
  ] = useState(false);

  // =========================================================
  // BLOQUEOS Y COMBATE
  // =========================================================

  const [
    localCombatBlocks,
    setLocalCombatBlocks
  ] = useState<{ [attackerId: string]: string }>({});

  const [
    blockTargetingAttacker,
    setBlockTargetingAttacker
  ] = useState<any>(null);

  // =========================================================
  // RONDA (BO3), TEMPORIZADOR Y SIDEDECK
  // =========================================================

  const [showSurrenderModal, setShowSurrenderModal] = useState(false);
  const [timeLeftSeconds, setTimeLeftSeconds] = useState<number | null>(null);
  const [isExtraTime, setIsExtraTime] = useState(false);

  const [showHandDiscardModal, setShowHandDiscardModal] = useState(false);
  const [selectedHandDiscardIds, setSelectedHandDiscardIds] = useState<string[]>([]);

  const [showOpponentGraveyard, setShowOpponentGraveyard] = useState(false);
  const [showOpponentBanished, setShowOpponentBanished] = useState(false);
  const [lastDamageDealt, setLastDamageDealt] = useState<{ amount: number; time: number; milledNames?: string[] } | null>(null);
  const [recentOpponentGraveyardCards, setRecentOpponentGraveyardCards] = useState<any[]>([]);
  const [localGameResult, setLocalGameResult] = useState<'VICTORY' | 'DEFEAT' | null>(null);

  const [localSideboardMain, setLocalSideboardMain] = useState<any[]>([]);
  const [localSideboardSide, setLocalSideboardSide] = useState<any[]>([]);
  const [sideboardConfirmed, setSideboardConfirmed] = useState(false);
  const [isPhaseStartWindow, setIsPhaseStartWindow] = useState(true);
  const [rulesState, setRulesState] = useState<GoldRulesState>(createInitialGoldRulesState);

  const device = useDeviceLayout();
  const [selectedBoardCard, setSelectedBoardCard] = useState<any | null>(null);
  const [isMenuDrawerOpen, setIsMenuDrawerOpen] = useState<boolean>(false);
  const [mobileInspectCard, setMobileInspectCard] = useState<any | null>(null);
  const [mobileZoneDrawer, setMobileZoneDrawer] = useState<{
    isOpen: boolean;
    title: string;
    cards: any[];
    icon: 'graveyard' | 'banished' | 'totems' | 'gold';
  }>({
    isOpen: false,
    title: '',
    cards: [],
    icon: 'graveyard'
  });
  const [vfxEvents, setVfxEvents] = useState<VFXEvent[]>([]);

  const triggerVfx = (type: VFXEvent['type'], text?: string, x?: number, y?: number) => {
    const newId = 'vfx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    setVfxEvents(prev => [...prev, { id: newId, type, text, x, y }]);
    setTimeout(() => {
      setVfxEvents(prev => prev.filter(e => e.id !== newId));
    }, 1400);
  };

  useEffect(() => {
    setIsPhaseStartWindow(true);
    setRulesState(prev => ({
      ...prev,
      searchCountThisTurn: {},
      outsideGameAbilitiesCountThisTurn: {}
    }));
  }, [currentPhaseIndex, turn]);

  useEffect(() => {
    setRulesState(prev => GoldRulesEngine.evaluateGoldRules({
      goldZone,
      opponentGoldZone,
      banished,
      opponentBanished,
      defenseZone,
      attackZone
    }, prev));
  }, [goldZone, opponentGoldZone, banished, opponentBanished, defenseZone, attackZone]);

  // Inicializar estado local de sideboard cuando entramos a la fase
  useEffect(() => {
    if (matchState?.phase === 'SIDEBOARDING') {
      setSideboardConfirmed(false);
      const currentMainCards = [
        ...castleCards,
        ...hand,
        ...attackZone,
        ...defenseZone,
        ...totemZone,
        ...goldZone,
        ...graveyard,
        ...banished
      ];
      setLocalSideboardMain(currentMainCards);
      setLocalSideboardSide(Array.isArray(playerSideboard) ? [...playerSideboard] : []);
    }
  }, [matchState?.phase]);

  // DAR Sección 5.A: Agrupación Automática y Transición Inmediata a Vigilia
  useEffect(() => {
    if (!isMultiplayer && currentPhaseIndex === DAR_PHASE_INDEX.AGRUPACION) {
      regroupAllAllies();
      if (typeof advancePhase === 'function') {
        advancePhase();
      }
    }
  }, [currentPhaseIndex, isMultiplayer, advancePhase]);

  // Disparo automático de habilidades al inicio de Vigilia (DAR 5.B)
  useEffect(() => {
    if (currentPhaseIndex === DAR_PHASE_INDEX.VIGILIA) {
      const allMyCards = [...defenseZone, ...attackZone, ...totemZone, ...goldZone];
      allMyCards.forEach((c: any) => {
        const abNorm = String(c.ability || '').toLowerCase();
        if (abNorm.includes('al comienzo de la vigilia') || abNorm.includes('al comienzo de tu vigilia') || abNorm.includes('al comienzo del turno') || abNorm.includes('al inicio de la vigilia')) {
          executeCardAbility(c, false, 'VIGILIA_START');
        }
      });
    }
  }, [currentPhaseIndex, turn]);

  // Registro automático de resultados de partida en estadísticas del perfil
  const recordedMatchRef = useRef(false);
  useEffect(() => {
    if (matchState?.phase === 'MATCH_OVER' && !recordedMatchRef.current) {
      recordedMatchRef.current = true;
      const isWinner = matchState.winnerId === myPlayerId;
      recordMatchResult(
        currentUser?.username,
        currentDeckName || 'Mazo Principal',
        isWinner,
        opponentName || 'Oponente'
      );
    }
  }, [matchState?.phase, matchState?.winnerId, myPlayerId, currentUser?.username, currentDeckName, opponentName]);

  // Comprobación de fin de partida en solitario / VS IA cuando el Castillo llega a 0
  useEffect(() => {
    if (!isMultiplayer) {
      if (castleCards && castleCards.length === 0 && !localGameResult) {
        setLocalGameResult('DEFEAT');
      } else if (
        opponentCastleCount !== undefined &&
        opponentCastleCount <= 0 &&
        !localGameResult
      ) {
        setLocalGameResult('VICTORY');
      }
    }
  }, [isMultiplayer, castleCards?.length, opponentCastleCount, localGameResult]);

  // Temporizador de Ronda 40 min + 5 min tiempo extra
  useEffect(() => {
    if (!matchState?.roundStartTime) {
      setTimeLeftSeconds(40 * 60);
      setIsExtraTime(false);
      return;
    }

    const interval = setInterval(() => {
      const elapsedMs = Date.now() - matchState.roundStartTime;
      const normalDurationMs = matchState.roundDurationMs || 40 * 60 * 1000;
      const extraDurationMs = matchState.extraTimeDurationMs || 5 * 60 * 1000;
      const remainingNormalMs = normalDurationMs - elapsedMs;

      if (remainingNormalMs > 0) {
        setTimeLeftSeconds(Math.ceil(remainingNormalMs / 1000));
        setIsExtraTime(false);
      } else {
        const extraElapsedMs = -remainingNormalMs;
        const remainingExtraMs = extraDurationMs - extraElapsedMs;
        setTimeLeftSeconds(Math.max(0, Math.ceil(remainingExtraMs / 1000)));
        setIsExtraTime(true);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [matchState?.roundStartTime, matchState?.roundDurationMs, matchState?.extraTimeDurationMs]);

  const formatRoundTime = (seconds: number | null) => {
    if (seconds === null) return '40:00';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handleConfirmSideboardSubmit = () => {
    if (localSideboardMain.length !== 50) {
      alert(`El Mazo Castillo debe tener exactamente 50 cartas (actualmente tiene ${localSideboardMain.length}).`);
      return;
    }
    if (localSideboardSide.length > 15) {
      alert(`El Sidedeck no puede tener más de 15 cartas (actualmente tiene ${localSideboardSide.length}).`);
      return;
    }

    const mainMap = new Map<string, { card: any; count: number }>();
    localSideboardMain.forEach((c) => {
      const cardId = String(c.id);
      const existing = mainMap.get(cardId);
      if (existing) {
        existing.count += 1;
      } else {
        mainMap.set(cardId, { card: c, count: 1 });
      }
    });

    const sideMap = new Map<string, { card: any; count: number }>();
    localSideboardSide.forEach((c) => {
      const cardId = String(c.id);
      const existing = sideMap.get(cardId);
      if (existing) {
        existing.count += 1;
      } else {
        sideMap.set(cardId, { card: c, count: 1 });
      }
    });

    const newCards = Array.from(mainMap.values());
    const newSideboard = Array.from(sideMap.values());

    setSideboardConfirmed(true);
    sendGameAction({
      type: 'CONFIRM_SIDEBOARD',
      cards: newCards,
      sideboard: newSideboard
    });
  };

  const handleSurrender = () => {
    sendGameAction({ type: 'SURRENDER' });
    setShowSurrenderModal(false);
  };

  const handleGoldMulligan = () => {
    if (isMultiplayer) {
      sendGameAction({ type: 'REVEAL_MULLIGAN_HAND' });
    } else {
      const newCastle = [...castleCards, ...hand];
      const shuffled = [...newCastle].sort(() => Math.random() - 0.5);
      setHand(shuffled.slice(0, 8));
      setCastleCards(shuffled.slice(8));
    }
    setShowMulliganModal(false);
  };

  const handleNormalMulligan = () => {
    if (isMultiplayer) {
      sendGameAction({ type: 'EXECUTE_NORMAL_MULLIGAN' });
    } else {
      const nextCount = Math.max(1, 8 - (mulliganCount || 0) - 1);
      const newCastle = [...castleCards, ...hand];
      const shuffled = [...newCastle].sort(() => Math.random() - 0.5);
      setHand(shuffled.slice(0, nextCount));
      setCastleCards(shuffled.slice(nextCount));
    }
    setShowMulliganModal(false);
  };

  const myScore = matchState?.scores?.[myPlayerId] ?? 0;
  const opponentScore = matchState?.scores?.[opponentInfo?.id || ''] ?? 0;

  // =========================================================
  // PROMPTS DE HABILIDAD
  // =========================================================

  const [
    abilityPrompt,
    setAbilityPrompt
  ] = useState<any>(null);

  const abilityPromptResolverRef =
    useRef<(value: any) => void>(
      () => {}
    );

  const [nameCardSearch, setNameCardSearch] = useState('');

  const allCardCatalog = useMemo(() => {
    const map = new Map<string, any>();
    if (Array.isArray(cardsCatalog)) {
      cardsCatalog.forEach((c: any) => {
        const key = String(c?.name || '').toLowerCase().trim();
        if (key && !map.has(key)) {
          map.set(key, c);
        }
      });
    }
    return Array.from(map.values());
  }, []);

  const filteredNamingCards = useMemo(() => {
    if (!nameCardSearch.trim()) {
      return allCardCatalog.slice(0, 30);
    }
    const q = nameCardSearch.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    return allCardCatalog.filter((c: any) => {
      const nameNorm = String(c?.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return nameNorm.includes(q);
    });
  }, [allCardCatalog, nameCardSearch]);

  // =========================================================
  // CARTA ACTUAL DE HABILIDAD
  // =========================================================

  const currentAbilityCardRef =
    useRef<any>(null);

  // =========================================================
  // ROBO
  // =========================================================

  const [
    hasDrawnThisFinal,
    setHasDrawnThisFinal
  ] = useState(false);

  const lastProcessedTurn =
    useRef<number | null>(
      null
    );

  // =========================================================
  // LÍMITE DE 1 ORO POR TURNO
  // =========================================================

  const [
    goldPlayedFromHandThisTurn,
    setGoldPlayedFromHandThisTurn
  ] = useState(false);

  const [
    cannotPlayGoldNextTurn,
    setCannotPlayGoldNextTurn
  ] = useState(false);

  const [
    usedAbilityCardIdsThisTurn,
    setUsedAbilityCardIdsThisTurn
  ] = useState<string[]>([]);

  const [
    goldRampedThisMatch,
    setGoldRampedThisMatch
  ] = useState(false);

  const [
    showEscarapelaModal,
    setShowEscarapelaModal
  ] = useState<any | null>(null);

  // =========================================================
  // BÚSQUEDA EN CASTILLO
  // =========================================================

  const [
    showCastleSearchModal,
    setShowCastleSearchModal
  ] = useState(false);

  const [
    castleSearchFilter,
    setCastleSearchFilter
  ] = useState<{ type?: string; minCost?: number; maxCost?: number; text?: string }>({});

  const [
    castleSearchResolver,
    setCastleSearchResolver
  ] = useState<((card: any | null) => void) | null>(null);

  const [onlineCastleSearch, setOnlineCastleSearch] = useState<any>(null);

  // MODAL INTERACTIVO SIGNO AMARILLO
  const [signoAmarilloModal, setSignoAmarilloModal] = useState<{
    isOpen: boolean;
    cards: any[];
    toHandId: string | null;
    toGraveId: string | null;
    toTopIds: string[];
    toBottomIds: string[];
  } | null>(null);

  // MODAL INTERACTIVO PULSO KAIJU
  const [pulsoKaijuModal, setPulsoKaijuModal] = useState<{
    isOpen: boolean;
    card: any;
    allies: any[];
    toHandId: string | null;
    toGraveIds: string[];
  } | null>(null);

  // =========================================================
  // SISTEMA DE NOTIFICACIONES TOAST & DIÁLOGOS INTERACTIVOS TEMÁTICOS (REEMPLAZO DE UI DEL NAVEGADOR)
  // =========================================================
  const [gameNotice, setGameNotice] = useState<{
    id: string;
    message: string;
    type?: 'info' | 'success' | 'warning' | 'error';
    icon?: string;
  } | null>(null);

  const [gameDialog, setGameDialog] = useState<{
    id: string;
    title: string;
    message: string;
    badge?: string;
    type: 'ALERT' | 'CONFIRM' | 'CHOICE' | 'PROMPT';
    options?: { label: string; value: any; icon?: string; description?: string; color?: string }[];
    defaultValue?: string;
    placeholder?: string;
    resolver: (val: any) => void;
  } | null>(null);

  const showNotice = (message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info', icon?: string) => {
    const id = String(Date.now() + Math.random());
    setGameNotice({ id, message, type, icon });
    setTimeout(() => {
      setGameNotice((prev) => (prev?.id === id ? null : prev));
    }, 4500);
  };

  // Reemplazo temático in-game de alert(...)
  const alert = (msg: string) => {
    showNotice(msg, 'info');
  };

  // Reemplazo temático in-game de confirm(...)
  const showConfirm = (title: string, message: string, confirmLabel: string = 'Aceptar', cancelLabel: string = 'Cancelar', badge?: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setGameDialog({
        id: String(Date.now()),
        title,
        message,
        badge: badge || '⚔️ Confirmación',
        type: 'CONFIRM',
        options: [
          { label: confirmLabel, value: true, color: 'gold' },
          { label: cancelLabel, value: false, color: 'zinc' }
        ],
        resolver: resolve
      });
    });
  };

  // Selector interactivo de opciones múltiples (Castillo vs Cementerio, Tipos de carta, etc.)
  const showChoice = (title: string, message: string, choices: { label: string; value: any; icon?: string; description?: string }[], badge?: string): Promise<any> => {
    return new Promise((resolve) => {
      setGameDialog({
        id: String(Date.now()),
        title,
        message,
        badge: badge || '✨ Selección de Acción',
        type: 'CHOICE',
        options: choices,
        resolver: resolve
      });
    });
  };

  // Reemplazo temático in-game de prompt(...)
  const showPrompt = (title: string, message: string, defaultValue: string = '', placeholder: string = '', badge?: string): Promise<string | null> => {
    return new Promise((resolve) => {
      setGameDialog({
        id: String(Date.now()),
        title,
        message,
        badge: badge || '📝 Ingresar Valor',
        type: 'PROMPT',
        defaultValue,
        placeholder,
        resolver: resolve
      });
    });
  };

  // =========================================================
  // GENERAR ORO (Mecánica "Genera un Oro / Genera Oros")
  // =========================================================
  const generateGold = (reason: string = 'Efecto de carta', count: number = 1) => {
    const newGolds: any[] = [];
    for (let i = 0; i < count; i++) {
      newGolds.push({
        id: 'generated-gold-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
        instanceId: 'generated-gold-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
        name: 'Oro Generado',
        type: 'Oro',
        isGenerated: true,
        isRested: false,
        zone: 'GOLD',
        ability: `Oro Generado por ${reason}. Se consume automáticamente al pagar.`
      });
    }
    setGoldZone((prev: any[]) => [...(prev || []), ...newGolds]);
    showNotice(`🪙 ¡Se generó ${count} Oro(s) en tu Reserva! (${reason})`, 'success');
    return newGolds;
  };

  // MODAL GENÉRICO DE SELECCIÓN DE CARTAS EN MANO (Kaitai, Trono del Dragón, etc.)
  const [handSelectionModal, setHandSelectionModal] = useState<{
    isOpen: boolean;
    title: string;
    subtitle: string;
    sourceCard: any;
    requiredCount: number;
    actionType: 'DISCARD' | 'SHUFFLE_CASTLE';
    selectedCardIds: string[];
    onConfirm: (selectedCards: any[]) => void;
  } | null>(null);

  const [isShufflingCastle, setIsShufflingCastle] = useState(false);

  // MODAL INTERACTIVO SANDRAUDIGA
  const [sandraudigaModal, setSandraudigaModal] = useState<{
    isOpen: boolean;
    sandraCard: any;
    sacerdotesInHand: any[];
    step: 'SELECT_SACERDOTE' | 'VIEW_OPPONENT_HAND';
    selectedSacerdoteId: string | null;
    opponentHandCards: any[];
  } | null>(null);

  // MODAL INTERACTIVO CAMILO HENRÍQUEZ
  const [camiloModal, setCamiloModal] = useState<{
    isOpen: boolean;
    cards: any[];
    toBanishIds: string[];
    toHandIds: string[];
  } | null>(null);

  // ANIMACIÓN VISUAL DE ROBO DE CARTA
  const [drawnCardAnim, setDrawnCardAnim] = useState<{
    cards: any[];
    count: number;
  } | null>(null);

  // MODAL INTERACTIVO LANZA ARGENTA (BARAJAR 3 CARTAS AL CAER AL CEMENTERIO)
  const [lanzaArgentaModal, setLanzaArgentaModal] = useState<{
    isOpen: boolean;
    sourceCard: any;
    cemeteryCards: any[];
    selectedIds: string[];
  } | null>(null);

  // PROMPT RESPUESTA COLAPSO GLOBAL
  const [colapsoPrompt, setColapsoPrompt] = useState<{
    isOpen: boolean;
    reason: string;
    colapsoCard: any;
  } | null>(null);

  // MODAL INTERACTIVO CUERVO NOCTURNO (HABILIDAD DE MANO)
  const [cuervoModal, setCuervoModal] = useState<{
    isOpen: boolean;
    cuervoCard: any;
    selectedOtherId: string | null;
  } | null>(null);

  // Función para barajar el Castillo con animación visual
  const shuffleCastleWithAnim = () => {
    setIsShufflingCastle(true);
    setCastleCards((prev: any[]) => [...prev].sort(() => Math.random() - 0.5));
    setTimeout(() => setIsShufflingCastle(false), 1400);
  };

  // Función para abrir el modal de búsqueda en Castillo
  const openCastleSearch = (filter: { type?: string; maxCost?: number; text?: string } = {}): Promise<any | null> => {
    if (isMultiplayer && socket && lobbyCode) {
      sendGameAction({
        type: 'SEARCH_CASTLE',
        filter
      });
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      setCastleSearchFilter(filter);
      setCastleSearchResolver(() => resolve);
      setShowCastleSearchModal(true);
    });
  };

  // =========================================================
  // CARTA DE RESPUESTA
  // =========================================================

  const isResponseCard = (card: any) => {
    if (!card) return false;
    const ability = String(card?.ability || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    const nameNorm = String(card?.name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    // 1. Textos explícitos de respuesta
    if (/en\s*respuesta|entrespuesta|como\s*respuesta|puedes\s*jugarlo\s*en\s*respuesta|puedes\s*jugarla\s*en\s*respuesta|en\s*respuesta\s*a/.test(ability)) {
      return true;
    }

    // 2. Anulación, Cancelación y Prevención (Paso D de DAR)
    // Descartar frases pasivas como "si es anulado", "no puede ser anulado", etc.
    const activeAbility = ability
      .replace(/si\s*es\s*anulad[ao]|cuando\s*sea\s*anulad[ao]/g, '')
      .replace(/no\s*puede\s*ser\s*anulad[ao]|no\s*puede\s*ser\s*cancelad[ao]|no\s*pueden\s*ser\s*canceladas/g, '')
      .replace(/sin\s*habilidad/g, '');

    if (/anula|anular|cancela|cancelar|preven|prevenir|redirige|redirigir/.test(activeAbility)) {
      return true;
    }

    // 3. Cartas clave de respuesta
    if (
      nameNorm.includes('caleuche') ||
      nameNorm.includes('colapso') ||
      nameNorm.includes('dracula') ||
      nameNorm.includes('llamada salvaje') ||
      nameNorm.includes('espada vikinga') ||
      nameNorm.includes('red de plata') ||
      nameNorm.includes('signo amarillo') ||
      nameNorm.includes('bacanal') ||
      nameNorm.includes('guillotina') ||
      nameNorm.includes('fe sin limite')
    ) {
      return true;
    }

    // Nyssara Cautiva: puede jugarse en cualquier fase
    if (nameNorm.includes('nyssara cautiva')) return true;

    // Sombrerero Loco: puede jugarse en Fase Final (idx 3)
    if (nameNorm.includes('sombrerero loco') && currentPhaseIndex === 3) return true;

    // Escarapela Nacional: puede jugarse en Vigilia oponente
    if (nameNorm.includes('escarapela nacional') && !isMyTurn && currentPhaseIndex === 1) return true;

    // Habilidades con texto de flash genérico
    if (/puedes jugarlo al comienzo de cualquier fase|puede jugarse en cualquier fase|en cualquier fase/.test(ability)) return true;
    if (/puedes jugarlo en la fase final|en la fase final de cada jugador|puedes jugar armas en la fase final/.test(ability) && currentPhaseIndex === 3) return true;
    if (/al comienzo del bloqueo|al comienzo del ataque|al comienzo de la batalla mitologica/.test(ability) && currentPhaseIndex === 2) return true;
    if (card.type === 'Talismán' && currentPhaseIndex === 2) return true; // En Guerra de Talismanes

    return false;
  };


  // =========================================================
  // KEYWORDS
  // =========================================================

  const getCardKeywords = (
    card: any
  ): string[] => {

    if (!card) {
      return [];
    }

    const result: string[] = [];

    if (
      Array.isArray(
        card.keywords
      )
    ) {

      result.push(
        ...card.keywords
      );
    }

    if (
      Array.isArray(
        card.abilities
      )
    ) {

      result.push(
        ...card.abilities
      );
    }

    if (
      Array.isArray(
        card.abilityKeywords
      )
    ) {

      result.push(
        ...card.abilityKeywords
      );
    }

    return result
      .filter(Boolean)
      .map(
        (value: any) =>
          String(
            value
          )
            .trim()
            .toLowerCase()
      );
  };

  const hasKeyword = (
    card: any,
    keyword: string
  ): boolean => {

    if (!card) {
      return false;
    }

    const normalized =
      keyword
        .trim()
        .toLowerCase();

    if (
      getCardKeywords(
        card
      ).includes(
        normalized
      )
    ) {

      return true;
    }

    const abilityText =
      String(
        card.ability || ''
      ).toLowerCase();

    return abilityText.includes(
      normalized
    );
  };

  const hasFury = (
    card: any
  ): boolean => {

    if (
      card?.type !==
      'Aliado'
    ) {

      return false;
    }

    return hasKeyword(
      card,
      'Furia'
    );
  };

  const isIndestructible = (
    card: any
  ): boolean => {

    return hasKeyword(
      card,
      'Indestructible'
    );
  };

  const isIndesterrable = (
    card: any
  ): boolean => {

    return hasKeyword(
      card,
      'Indesterrable'
    );
  };

  const isUnblockable = (
    card: any
  ): boolean => {
    if (!card) return false;
    const abilityText = String(card.ability || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    return (
      hasKeyword(card, 'Imbloqueable') ||
      hasKeyword(card, 'Inbloqueable') ||
      abilityText.includes('imbloqueable') ||
      abilityText.includes('inbloqueable') ||
      abilityText.includes('no puede ser bloqueado') ||
      abilityText.includes('no pueden ser bloqueados')
    );
  };

  const getCardEffectiveStrength = (
    card: any,
    isOpponentCard: boolean = false
  ): number => {
    if (!card) return 0;
    let str = Number(card.strength) || 0;
    if (card.attachedWeapon) {
      const wName = String(card.attachedWeapon.name || '').toLowerCase();
      if (wName.includes('garra') && (wName.includes('dragon') || wName.includes('dragones'))) {
        str += Number(card.cost !== undefined ? card.cost : getCardCost(card)) || 0;
      } else {
        str += Number(card.attachedWeapon.strength) || 0;
      }
    }
    if (card.temporaryStrengthBonus) {
      str += Number(card.temporaryStrengthBonus) || 0;
    }
    if (card.permanentStrengthBonus) {
      str += Number(card.permanentStrengthBonus) || 0;
    }

    const relevantGold = isOpponentCard ? (opponentGoldZone || []) : (goldZone || []);
    const relevantAllies = isOpponentCard
      ? [...(opponentDefenseZone || []), ...(opponentAttackZone || [])]
      : [...(defenseZone || []), ...(attackZone || [])];

    // Armería del Guerrero: Aliados de coste 1 o más ganan +1 de Fuerza
    const hasArmeria = relevantGold.some((g: any) => {
      const gName = String(g.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return gName.includes('armeria');
    });
    if (hasArmeria && (Number(card.cost) >= 1 || getCardCost(card) >= 1)) {
      str += 1;
    }

    // Trono del Dragón: Si controlas 3 o más Aliados de la misma Raza, tus Aliados ganan 1 de Fuerza
    const hasTronoDragon = relevantGold.some((g: any) => {
      const gName = String(g.name || '').toLowerCase();
      return gName.includes('trono del dragon');
    });
    if (hasTronoDragon) {
      const raceCounts: Record<string, number> = {};
      for (const a of relevantAllies) {
        const races = Array.isArray(a.races) ? a.races : (a.race ? [a.race] : []);
        for (const r of races) {
          if (r) {
            const cleanR = String(r).toLowerCase().trim();
            raceCounts[cleanR] = (raceCounts[cleanR] || 0) + 1;
          }
        }
      }
      const hasThreeOfSameRace = Object.values(raceCounts).some((count) => count >= 3);
      if (hasThreeOfSameRace) {
        str += 1;
      }
    }

    // Sombrerero Loco: Los Aliados oponentes pierden 1 de Fuerza
    const enemyAllies = isOpponentCard
      ? [...(defenseZone || []), ...(attackZone || [])]
      : [...(opponentDefenseZone || []), ...(opponentAttackZone || [])];

    const enemyHasSombrerero = enemyAllies.some((a: any) => {
      if (a.sinHabilidad || a.hasNoAbility) return false;
      const aName = String(a.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return aName.includes('sombrerero');
    });
    if (enemyHasSombrerero) {
      str -= 1;
    }

    return Math.max(0, str);
  };

  // Badge visual interactivo de Fuerza Efectiva / Modificada
  const renderStrengthBadge = (card: any, isOpponentCard: boolean = false) => {
    if (card?.strength === undefined && card?.type !== 'Aliado') return null;
    const baseStr = Number(card?.strength) || 0;
    const effectiveStr = getCardEffectiveStrength(card, isOpponentCard);
    const diff = effectiveStr - baseStr;

    if (diff > 0) {
      return (
        <span
          className="absolute top-0.5 right-0.5 bg-gradient-to-r from-emerald-600 to-green-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded shadow-lg ring-1 ring-emerald-300 animate-pulse flex items-center gap-0.5 z-10"
          title={`Fuerza Modificada: ${effectiveStr} (Base: ${baseStr}, +${diff} por Armería/Trono/Armas/Efectos)`}
        >
          ⚔️ {effectiveStr}
          <span className="text-[7px] text-emerald-200">+{diff}</span>
        </span>
      );
    }

    if (diff < 0) {
      return (
        <span
          className="absolute top-0.5 right-0.5 bg-gradient-to-r from-red-700 to-orange-700 text-white text-[9px] font-black px-1.5 py-0.5 rounded shadow-lg ring-1 ring-red-400 flex items-center gap-0.5 z-10"
          title={`Fuerza Reducida: ${effectiveStr} (Base: ${baseStr}, ${diff})`}
        >
          ⚔️ {effectiveStr}
          <span className="text-[7px] text-red-200">{diff}</span>
        </span>
      );
    }

    return (
      <span
        className="absolute top-0.5 right-0.5 bg-red-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded shadow z-10"
        title={`Fuerza: ${effectiveStr}`}
      >
        ⚔️ {effectiveStr}
      </span>
    );
  };

  // Badge visual para cartas sin habilidad (Drácula, Signo Amarillo, Acabar la Esperanza, Juan de Patmos, etc.)
  const renderNoAbilityBadge = (card: any) => {
    if (!card) return null;
    const ab = String(card.ability || '').toLowerCase().trim();
    const hasNoAb = card.hasNoAbility || card.losesAbilities || ab === 'sin habilidad.' || ab === 'oro sin habilidad.' || ab === 'aliado sin habilidad.' || ab === 'totem sin habilidad.' || ab === 'arma sin habilidad.' || (ab.startsWith('sin habilidad') && !ab.includes('puedes'));
    if (!hasNoAb) return null;

    return (
      <span
        className="absolute bottom-0.5 inset-x-0.5 bg-zinc-950/95 text-zinc-300 border border-zinc-500/70 text-[7px] font-black uppercase py-0.5 rounded shadow text-center truncate z-10"
        title="Esta carta no tiene habilidad activa"
      >
        🚫 Sin Habilidad
      </span>
    );
  };

  // Cálculo de Coste Dinámico con Reducciones Activas y Pasivas
  const getDynamicCardCost = (card: any): number => {
    if (!card) return 0;
    const master = getMasterCardData(card);
    if (master.type === 'Oro') return 0;
    let baseCost = Number(master.cost !== undefined ? master.cost : card.cost) || 0;
    const nameNorm = String(master.name || card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

    // 1. Carpa Dragón / Levantar Pirámide: Reduce en 1 por cada Aliado en juego (tuyo y oponente), hasta un mínimo de 1
    if (nameNorm.includes('carpa dragon') || nameNorm.includes('levantar piramide')) {
      const totalAlliesInPlay = (defenseZone?.length || 0) + (attackZone?.length || 0) + (opponentDefenseZone?.length || 0) + (opponentAttackZone?.length || 0);
      baseCost = Math.max(1, baseCost - totalAlliesInPlay);
    }

    // 2. Cadena Negra: Reduce en 1 por cada Aliado declarado atacante este turno, hasta un mínimo de 0
    if (nameNorm.includes('cadena negra')) {
      const totalAttackers = (attackZone?.length || 0) + (opponentAttackZone?.length || 0);
      baseCost = Math.max(0, baseCost - totalAttackers);
    }

    // 3. Rito del Bandido: Reduce en 1 por cada Bandido que controles, hasta un mínimo de 1
    if (nameNorm.includes('rito del bandido')) {
      const myBandidos = [...(defenseZone || []), ...(attackZone || [])].filter((a: any) => {
        const races = Array.isArray(a.races) ? a.races : (a.race ? [a.race] : []);
        return races.some((r: string) => String(r).toLowerCase().includes('bandido'));
      });
      baseCost = Math.max(1, baseCost - myBandidos.length);
    }

    // 4. Manipular Destino: Reduce en 1 por cada carta de coste 2 o más que controles, hasta un mínimo de 1
    if (nameNorm.includes('manipular destino')) {
      const allMyPermanents = [...(defenseZone || []), ...(attackZone || []), ...(totemZone || []), ...(goldZone || [])];
      const count2Plus = allMyPermanents.filter((c: any) => getCardCost(c) >= 2 || Number(c.cost) >= 2).length;
      baseCost = Math.max(1, baseCost - count2Plus);
    }

    // 5. Festín Orco: Reduce en 1 si el oponente controla 2 o más Oros que tú
    if (nameNorm.includes('festin orco')) {
      if ((opponentGoldZone?.length || 0) >= (goldZone?.length || 0) + 2) {
        baseCost = Math.max(0, baseCost - 1);
      }
    }

    // 6. Sheut: Si controlas menos Oros que tu oponente, puedes jugarlo por un Oro menos (coste 0)
    if (nameNorm.includes('sheut')) {
      if ((goldZone?.length || 0) < (opponentGoldZone?.length || 0)) {
        baseCost = Math.max(0, baseCost - 1);
      }
    }

    // 7. Jabberwocky: Si no controlas Aliados de coste 1 o menos, reduce su coste en un Oro
    if (nameNorm.includes('jabberwocky') && !nameNorm.includes('desatado')) {
      const hasCost1OrLessAlly = [...(defenseZone || []), ...(attackZone || [])].some(
        (a: any) => a.type === 'Aliado' && (getCardCost(a) <= 1 || Number(a.cost || 0) <= 1)
      );
      if (!hasCost1OrLessAlly) {
        baseCost = Math.max(0, baseCost - 1);
      }
    }

    // 7. Descanso Solar: En Batalla Mitológica (Combate / Ataque) reduce su coste en 1
    if (nameNorm.includes('descanso solar')) {
      if (currentPhaseIndex === 2) {
        baseCost = Math.max(0, baseCost - 1);
      }
    }

    // 8. Cetro Demoníaco: Reduce en 1 si controlas o jugaste este turno Armas o a Lucifer
    if (nameNorm.includes('cetro demoniaco')) {
      const controlsWeapons = (totemZone?.length || 0) > 0 || defenseZone.some((a: any) => a.attachedWeapon);
      const controlsLucifer = [...(defenseZone || []), ...(attackZone || [])].some((a: any) => String(a.name || '').toLowerCase().includes('lucifer'));
      if (controlsWeapons || controlsLucifer) {
        baseCost = Math.max(0, baseCost - 1);
      }
    }

    // 9. Furia Berserker: Durante tu Vigilia cuesta un Oro adicional (+1)
    if (nameNorm.includes('furia berserker')) {
      if (isMyTurn && currentPhaseIndex === 1) {
        baseCost += 1;
      }
    }

    // 10. Modificadores pasivos globales (ej. Tesoro de los Césares / cartas nombradas)
    if (Array.isArray(namedCards) && namedCards.some((n: any) => (n.effectType === 'EXTRA_COST' || n.type === 'EXTRA_COST') && String(n.cardName || '').toLowerCase() === nameNorm)) {
      baseCost += 1;
    }

    return Math.max(0, baseCost);
  };

  // =========================================================
  // PREPARAR ALIADO
  // =========================================================

  const prepareAllyForAttack = (
    card: any
  ) => {

    if (
      card?.type !==
      'Aliado'
    ) {

      return card;
    }

    return {
      ...card,

      canAttack:
        hasFury(card),

      hasFury:
        hasFury(card),

      isUnblockable:
        isUnblockable(card)
    };
  };

  // =========================================================
  // AGRUPACIÓN
  // =========================================================

  const regroupAllAllies = () => {
    // Enderezar y retornar atacantes a Línea de Defensa
    setDefenseZone((prev: any[]) => [
      ...prev.map((card) =>
        card.type === 'Aliado'
          ? { ...card, isRested: false, canAttack: true }
          : { ...card, isRested: false }
      ),
      ...attackZone.map((card) => ({
        ...card,
        zone: 'DEFENSE',
        isRested: false,
        canAttack: true
      }))
    ]);

    setAttackZone([]);

    // Enderezar Oros en Reserva
    setGoldZone((prev: any[]) =>
      (prev || []).map((g) => ({ ...g, isRested: false }))
    );

    // Enderezar Tótems
    setTotemZone((prev: any[]) =>
      (prev || []).map((t) => ({ ...t, isRested: false }))
    );
  };

  const handlePayToShuffleBrujo = (namedEntry: any) => {
    if (reserveGoldCount === 0) {
      alert('No tienes Oro en tu Reserva para pagar el coste de 1 Oro.');
      return;
    }

    if (isMultiplayer) {
      sendGameAction({
        type: 'SHUFFLE_BANISHED_CARD',
        cardInstanceId: namedEntry.sourceCardInstanceId,
        sourceCardName: namedEntry.sourceCardName
      });
    } else {
      const availableGold = goldZone.find((g: any) => !g.isRested);
      if (availableGold) {
        setGoldZone((prev: any[]) => prev.map((g: any) => g.instanceId === availableGold.instanceId ? { ...g, isRested: true } : g));
      }
      const brujoIdx = banished.findIndex((c: any) => String(c.name || '').toLowerCase().includes('brujo de salamanca'));
      if (brujoIdx >= 0) {
        const [brujoCard] = banished.splice(brujoIdx, 1);
        setBanished([...banished]);
        setCastleCards((prev: any[]) => {
          const updated = [...prev, { ...brujoCard, isRested: false }];
          return updated.sort(() => Math.random() - 0.5);
        });
      }
      setNamedCards((prev: any[]) => prev.filter((n: any) => n !== namedEntry));
      alert('Has pagado 1 Oro. Brujo de Salamanca fue barajado al Castillo y la prohibición ha sido levantada.');
    }
  };

  // =========================================================
  // POPUP CARTA
  // =========================================================

  const handleCardHover = (
    card: any,
    event: React.MouseEvent<HTMLElement>
  ) => {

    if (
      !card ||
      !card.imageUrl ||
      signoAmarilloModal?.isOpen ||
      abilityPrompt ||
      sandraudigaModal?.isOpen ||
      camiloModal?.isOpen ||
      lanzaArgentaModal?.isOpen ||
      colapsoPrompt?.isOpen ||
      cuervoModal?.isOpen ||
      showGoldModal ||
      showGraveyard ||
      showBanished ||
      showCastleSearchModal ||
      showMulliganModal ||
      showSurrenderModal ||
      showDarRulesModal
    ) {
      return;
    }

    const rect =
      event.currentTarget
        .getBoundingClientRect();

    const popupWidth = 300;
    const popupHeight = 520;
    const gap = 14;

    const viewportWidth =
      window.innerWidth;

    const viewportHeight =
      window.innerHeight;

    let x =
      rect.left -
      popupWidth -
      gap;

    if (
      x < 8
    ) {

      x =
        rect.right +
        gap;
    }

    if (
      x + popupWidth >
      viewportWidth - 8
    ) {

      x =
        viewportWidth -
        popupWidth -
        8;
    }

    let y =
      rect.top;

    if (
      y + popupHeight >
      viewportHeight - 8
    ) {

      y =
        viewportHeight -
        popupHeight -
        8;
    }

    if (
      y < 8
    ) {

      y = 8;
    }

    setPreviewPosition({
      x,
      y
    });

    setHoveredCard({
      ...card
    });

    setPreviewVisible(
      true
    );
  };

  const handleCardLeave = () => {

    setPreviewVisible(
      false
    );
  };

  // =========================================================
  // SOCKET LEGACY
  // =========================================================

  useEffect(() => {

    if (
      !socket
    ) {
      return;
    }

    const handleOpponentAction =
      (data: any) => {

        console.log(
          '[GAME] Acción del oponente:',
          data
        );
      };

    socket.on(
      'opponent_action',
      handleOpponentAction
    );

    return () => {

      socket.off(
        'opponent_action',
        handleOpponentAction
      );
    };

  }, [
    socket
  ]);

  // =========================================================
  // EVENTOS ONLINE: BÚSQUEDA DE CASTILLO Y HABILIDADES
  // =========================================================

  useEffect(() => {
    if (!socket) return;

    const onSearchOptions = (data: any) => {
      if (!data || !Array.isArray(data.cards)) return;
      setOnlineCastleSearch({
        searchId: data.searchId || data.requestId || null,
        cards: data.cards,
        filter: data.filter || {},
        sourceCardInstanceId: data.sourceCardInstanceId || null,
        sourceCardName: data.sourceCardName || 'Habilidad',
        readonly: false
      });
    };

    const onSearchCancelled = () => setOnlineCastleSearch(null);

    const onAbilityPrompt = (data: any) => {
      if (!data) return;
      setAbilityPrompt({
        ...data,
        _effectTarget: data.target || data._effectTarget || null
      });
    };

    const onAbilityResolved = () => setAbilityPrompt(null);

    const onRevealOpponentHand = (data: any) => {
      if (!data || !Array.isArray(data.hand)) return;
      setSandraudigaModal({
        isOpen: true,
        sandraCard: { name: 'Sandraudiga' },
        sacerdotesInHand: [],
        step: 'VIEW_OPPONENT_HAND',
        selectedSacerdoteId: null,
        opponentHandCards: data.hand
      });
    };

    socket.on('castle_search_options', onSearchOptions);
    socket.on('castle_search_cancelled', onSearchCancelled);
    socket.on('ability_prompt', onAbilityPrompt);
    socket.on('ability_resolved', onAbilityResolved);
    socket.on('REVEAL_OPPONENT_HAND_FOR_BANISH', onRevealOpponentHand);

    return () => {
      socket.off('castle_search_options', onSearchOptions);
      socket.off('castle_search_cancelled', onSearchCancelled);
      socket.off('ability_prompt', onAbilityPrompt);
      socket.off('ability_resolved', onAbilityResolved);
      socket.off('REVEAL_OPPONENT_HAND_FOR_BANISH', onRevealOpponentHand);
    };
  }, [socket]);

  // =========================================================
  // ROBO POR TURNO
  // =========================================================

  useEffect(() => {

    if (
      lastProcessedTurn.current !==
      turn
    ) {

      setHasDrawnThisFinal(
        false
      );

      lastProcessedTurn.current =
        turn;
    }

  }, [
    turn
  ]);

  // Ref sincronizada del Castillo para evitar clonación/duplicación en robos consecutivos inmediatos
  const castleCardsRef = useRef(castleCards);
  useEffect(() => {
    castleCardsRef.current = castleCards;
  }, [castleCards]);

  const drawCardByEffect = (count: number = 1) => {
    const currentCastle = castleCardsRef.current || castleCards || [];
    if (currentCastle.length === 0) {
      if (!isMultiplayer) setLocalGameResult('DEFEAT');
      showNotice('¡Tu Castillo se ha quedado sin cartas! Has perdido la partida por mazo agotado.', 'error');
      return null;
    }

    const actualCount = Math.min(count, currentCastle.length);
    const drawnCardsList = currentCastle.slice(0, actualCount);
    const remainingCastle = currentCastle.slice(actualCount);

    // Actualizar inmediatamente la ref sincronizada para que llamadas en el mismo tick tomen la siguiente carta
    castleCardsRef.current = remainingCastle;

    setCastleCards(remainingCastle);
    setHand((prev: any[]) => [...prev, ...drawnCardsList]);

    if (drawnCardsList.length > 0) {
      setDrawnCardAnim({
        cards: drawnCardsList,
        count: actualCount
      });
      setTimeout(() => setDrawnCardAnim(null), Math.min(3000, 1600 + actualCount * 400));
      return drawnCardsList[0];
    }

    return null;
  };

  // =========================================================
  // ID CARTA
  // =========================================================

  const getCardInstanceId = (
    card: any
  ): string | null => {

    if (!card) {
      return null;
    }

    if (
      card.instanceId !==
        undefined &&
      card.instanceId !==
        null
    ) {

      return String(
        card.instanceId
      );
    }

    if (
      card.id !==
        undefined &&
      card.id !==
        null
    ) {

      return String(
        card.id
      );
    }

    return null;
  };

  // =========================================================
  // QUITAR CARTA PROPIA
  // =========================================================

  const removeCardFromPlayerZones =
    (
      card: any
    ) => {

      const id =
        getCardInstanceId(
          card
        );

      if (!id) {
        return;
      }

      setHand(
        (prev: any[]) =>
          prev.filter(
            (c) =>
              getCardInstanceId(
                c
              ) !==
              id
          )
      );

      setAttackZone(
        (prev: any[]) =>
          prev.filter(
            (c) =>
              getCardInstanceId(
                c
              ) !==
              id
          )
      );

      setDefenseZone(
        (prev: any[]) =>
          prev.filter(
            (c) =>
              getCardInstanceId(
                c
              ) !==
              id
          )
      );

      setTotemZone(
        (prev: any[]) =>
          prev.filter(
            (c) =>
              getCardInstanceId(
                c
              ) !==
              id
          )
      );

      setGoldZone(
        (prev: any[]) =>
          prev.filter(
            (c) =>
              getCardInstanceId(
                c
              ) !==
              id
          )
      );
    };

  // =========================================================
  // QUITAR CARTA OPONENTE
  // =========================================================

  const removeCardFromOpponentZones =
    (
      card: any
    ) => {

      const id =
        getCardInstanceId(
          card
        );

      if (!id) {
        return;
      }

      if (
        typeof setOpponentAttackZone ===
        'function'
      ) {

        setOpponentAttackZone(
          (prev: any[]) =>
            prev.filter(
              (c) =>
                getCardInstanceId(
                  c
                ) !==
                id
            )
        );
      }

      if (
        typeof setOpponentDefenseZone ===
        'function'
      ) {

        setOpponentDefenseZone(
          (prev: any[]) =>
            prev.filter(
              (c) =>
                getCardInstanceId(
                  c
                ) !==
                id
            )
        );
      }

      if (
        typeof setOpponentTotemZone ===
        'function'
      ) {

        setOpponentTotemZone(
          (prev: any[]) =>
            prev.filter(
              (c) =>
                getCardInstanceId(
                  c
                ) !==
                id
            )
        );
      }

      if (
        typeof setOpponentGoldZone ===
        'function'
      ) {

        setOpponentGoldZone(
          (prev: any[]) =>
            prev.filter(
              (c) =>
                getCardInstanceId(
                  c
                ) !==
                id
            )
        );
      }
    };

  // =========================================================
  // CEMENTERIO
  // =========================================================

  const addToGraveyard =
    (
      card: any
    ) => {

      if (!card) {
        return;
      }

      const id =
        getCardInstanceId(
          card
        );

      if (!id) {
        return;
      }

      if (
        typeof setGraveyard !==
        'function'
      ) {

        console.error(
          '[GRAVEYARD] setGraveyard no disponible.',
          card
        );

        return;
      }

      setGraveyard(
        (prev: any[]) => {

          const current =
            Array.isArray(
              prev
            )
              ? prev
              : [];

          if (
            current.some(
              (c) =>
                getCardInstanceId(
                  c
                ) ===
                id
            )
          ) {

            return current;
          }

          return [
            ...current,
            {
              ...card,
              zone: 'CEMETERY',
              isRested: false
            }
          ];
        }
      );

      const cardName = String(card.name || '').toLowerCase();
      const cardAb = String(card.ability || '').toLowerCase();
      if (
        cardName.includes('lanza argenta') ||
        (cardAb.includes('puesta en el cementerio') && cardAb.includes('barajar'))
      ) {
        setTimeout(() => {
          setLanzaArgentaModal((prev) => {
            if (prev?.isOpen) return prev;
            return {
              isOpen: true,
              sourceCard: card,
              cemeteryCards: graveyard.filter(
                (c: any) => (c.instanceId || c.id) !== (card.instanceId || card.id)
              ),
              selectedIds: []
            };
          });
        }, 150);
      }
    };

  // =========================================================
  // DESTIERRO
  // =========================================================

  const addToBanished = (
    card: any
  ) => {

    if (!card) {
      return;
    }

    if (
      typeof setBanished !==
      'function'
    ) {

      console.error(
        '[BANISHED] setBanished no disponible.',
        card
      );

      return;
    }

    const id =
      getCardInstanceId(
        card
      );

    if (!id) {
      return;
    }

    setBanished(
      (prev: any[]) => {

        const current =
          Array.isArray(
            prev
          )
            ? prev
            : [];

        if (
          current.some(
            (existingCard) =>
              getCardInstanceId(
                existingCard
              ) ===
              id
          )
        ) {

          return current;
        }

        return [
          ...current,

          {
            ...card,

            zone:
              'BANISHED',

            isRested:
              false
          }
        ];
      }
    );

    const cardNorm = String(card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (cardNorm.includes('brujo de salamanca')) {
      setTimeout(async () => {
        const nameToProhibit = await new Promise<string | undefined>((resolve) => {
          abilityPromptResolverRef.current = resolve;
          setAbilityPrompt({
            cardId: card.id,
            cardName: card.name,
            mode: 'NAME_CARD',
            message: `[Brujo de Salamanca en Destierro]: Nombra una carta. Mientras permanezca en tu Destierro, nadie podrá jugar cartas con ese nombre:`,
          });
        });
        if (nameToProhibit) {
          setNamedCards((prev: any[]) => [
            ...prev,
            {
              name: nameToProhibit,
              sourceCardName: 'Brujo de Salamanca',
              sourceCardInstanceId: card.instanceId,
              rule: 'CANNOT_PLAY'
            }
          ]);
          alert(`¡Brujo de Salamanca en Destierro! Prohibido jugar "${nameToProhibit}".`);
        }
      }, 300);
    }
  };

  // =========================================================
  // SELECCIÓN DE EFECTOS
  // =========================================================

  const getSelectedEffectCards =
    (
      effect: any
    ): any[] => {

      const selected =
        effect?.target?.selected;

      if (
        selected ===
          undefined ||
        selected ===
          null
      ) {

        return [];
      }

      if (
        Array.isArray(
          selected
        )
      ) {

        return selected.filter(
          Boolean
        );
      }

      return [
        selected
      ];
    };

  // =========================================================
  // APPLY EFFECT
  // =========================================================

  const applyEffect =
    async (
      effect: any,
      ctx: any
    ) => {

      if (!effect) {
        return null;
      }

      const sourceCard =
        ctx?.card;

      // =====================================================
      // BANISH
      // =====================================================

      if (
        effect.type ===
        'BANISH'
      ) {

        if (
          effect.target?.self ===
          true
        ) {

          if (
            !sourceCard
          ) {

            return null;
          }

          if (
            isIndesterrable(
              sourceCard
            )
          ) {

            ctx?.log?.(
              `${sourceCard.name} es Indesterrable.`
            );

            return null;
          }

          removeCardFromPlayerZones(
            sourceCard
          );

          addToBanished(
            sourceCard
          );

          return sourceCard;
        }

        const selectedCards =
          getSelectedEffectCards(
            effect
          );

        if (
          selectedCards.length ===
          0
        ) {

          ctx?.log?.(
            'BANISH: no hay objetivos seleccionados.'
          );

          return null;
        }

        const movedCards: any[] = [];

        for (
          const rawTarget of
          selectedCards
        ) {

          if (
            !rawTarget
          ) {
            continue;
          }

          const owner =
            rawTarget.__targetOwner ||
            (
              effect.target?.opponent
                ? 'OPPONENT'
                : 'PLAYER'
            );

          const targetCard = {
            ...rawTarget
          };

          delete targetCard.__targetOwner;
          delete targetCard.__targetZone;

          if (
            isIndesterrable(
              targetCard
            )
          ) {

            ctx?.log?.(
              `${targetCard.name} es Indesterrable.`
            );

            continue;
          }

          if (
            owner ===
            'OPPONENT'
          ) {

            removeCardFromOpponentZones(
              targetCard
            );

          } else {

            removeCardFromPlayerZones(
              targetCard
            );
          }

          addToBanished(
            targetCard
          );

          movedCards.push(
            targetCard
          );
        }

        return movedCards;
      }

      // =====================================================
      // DESTROY
      // =====================================================

      if (
        effect.type ===
        'DESTROY'
      ) {

        if (
          effect.target?.self ===
          true
        ) {

          if (
            !sourceCard
          ) {

            return null;
          }

          if (
            isIndestructible(
              sourceCard
            )
          ) {

            ctx?.log?.(
              `${sourceCard.name} es Indestructible.`
            );

            return null;
          }

          removeCardFromPlayerZones(
            sourceCard
          );

          addToGraveyard(
            sourceCard
          );

          return sourceCard;
        }

        const selectedCards =
          getSelectedEffectCards(
            effect
          );

        if (
          selectedCards.length ===
          0
        ) {

          ctx?.log?.(
            'DESTROY: no hay objetivos seleccionados.'
          );

          return null;
        }

        const destroyedCards: any[] = [];

        for (
          const rawTarget of
          selectedCards
        ) {

          if (
            !rawTarget
          ) {
            continue;
          }

          const owner =
            rawTarget.__targetOwner ||
            (
              effect.target?.opponent
                ? 'OPPONENT'
                : 'PLAYER'
            );

          const targetCard = {
            ...rawTarget
          };

          delete targetCard.__targetOwner;
          delete targetCard.__targetZone;

          if (
            isIndestructible(
              targetCard
            )
          ) {

            ctx?.log?.(
              `${targetCard.name} es Indestructible.`
            );

            continue;
          }

          if (
            owner ===
            'OPPONENT'
          ) {

            removeCardFromOpponentZones(
              targetCard
            );

          } else {

            removeCardFromPlayerZones(
              targetCard
            );
          }

          addToGraveyard(
            targetCard
          );

          destroyedCards.push(
            targetCard
          );
        }

        return destroyedCards;
      }

      // =====================================================
      // MOVE
      // =====================================================

      if (
        effect.type ===
        'MOVE'
      ) {

        const selectedCards =
          effect.target?.self ===
          true
            ? sourceCard
              ? [sourceCard]
              : []
            : getSelectedEffectCards(
                effect
              );

        if (
          selectedCards.length ===
          0
        ) {

          return null;
        }

        const destination =
          effect.destinationZone;

        const movedCards: any[] = [];

        for (
          const rawTarget of
          selectedCards
        ) {

          if (
            !rawTarget
          ) {
            continue;
          }

          const owner =
            rawTarget.__targetOwner ||
            (
              effect.target?.opponent
                ? 'OPPONENT'
                : 'PLAYER'
            );

          const card = {
            ...rawTarget
          };

          delete card.__targetOwner;
          delete card.__targetZone;

          if (
            owner ===
            'OPPONENT'
          ) {

            removeCardFromOpponentZones(
              card
            );

          } else {

            removeCardFromPlayerZones(
              card
            );
          }

          if (
            destination ===
            'CEMETERY'
          ) {

            addToGraveyard(
              card
            );

            movedCards.push(
              card
            );

          } else if (
            destination ===
            'BANISHED'
          ) {

            if (
              isIndesterrable(
                card
              )
            ) {
              continue;
            }

            addToBanished(
              card
            );

            movedCards.push(
              card
            );

          } else if (
            destination ===
            'HAND'
          ) {

            /*
             * Solo localmente.
             *
             * Online estas operaciones serán
             * responsabilidad del servidor.
             */

            setHand(
              (prev: any[]) => [
                ...prev,
                card
              ]
            );

            movedCards.push(
              card
            );
          }
        }

        return movedCards;
      }

      // =====================================================
      // DRAW
      // =====================================================

      if (
        effect.type ===
        'DRAW'
      ) {

        const amount =
          Number(
            effect.amount
          ) || 1;

        const drawnCards: any[] = [];

        for (
          let i = 0;
          i < amount;
          i += 1
        ) {

          const drawn =
            drawCardByEffect();

          if (
            drawn
          ) {

            drawnCards.push(
              drawn
            );
          }
        }

        return drawnCards;
      }

      // =====================================================
      // SEARCH (busca en castillo)
      // =====================================================

      if (
        effect.type === 'SEARCH'
      ) {
        const filter: any = {};
        if (effect.target?.kind) filter.type = effect.target.kind === 'ALLY' ? 'Aliado' : effect.target.kind === 'GOLD' ? 'Oro' : effect.target.kind === 'TALISMAN' ? 'Talismán' : effect.target.kind === 'WEAPON' ? 'Arma' : effect.target.kind === 'TOTEM' ? 'Tótem' : undefined;
        if (effect.target?.maxCost !== undefined) filter.maxCost = effect.target.maxCost;

        const found = await openCastleSearch(filter);
        if (found) {
          setHand((prev: any[]) => [...prev, { ...found, zone: 'HAND', isRested: false }]);
        }
        return found ? [found] : [];
      }

      // =====================================================
      // MILL (botar del castillo al cementerio con soporte de Barrera)
      // =====================================================

      if (
        effect.type === 'MILL'
      ) {
        const isBarrier = (c: any) => {
          if (!c) return false;
          const ab = String(c.ability || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const n = String(c.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          return (
            ab.includes('dejas de botar') ||
            ab.includes('dejas de desterrar') ||
            ab.includes('dejas de botar cartas') ||
            ab.includes('dejas de botar o desterrar') ||
            n.includes('aud la sabia') ||
            n.includes('pistola de dos canones') ||
            n.includes('vision de enoc') ||
            n.includes('abraham') ||
            n.includes('fantasma del puente') ||
            n.includes('diadema celestial')
          );
        };

        const amount = Number(effect.amount) || 1;
        const isOpponent = effect.target?.opponent;
        const milled: any[] = [];
        for (let i = 0; i < amount; i++) {
          if (!isOpponent) {
            const top = castleCards[0];
            if (top) {
              setCastleCards((prev: any[]) => prev.slice(1));
              milled.push(top);

              const topName = String(top.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

              // Lanza Argenta al caer al Cementerio
              if (topName.includes('lanza argenta')) {
                addToGraveyard(top);
                setLanzaArgentaModal({
                  isOpen: true,
                  sourceCard: top,
                  cemeteryCards: [...graveyard, top],
                  selectedIds: []
                });
                continue;
              }

              if (isBarrier(top)) {
                const a = String(top.ability || '').toLowerCase();
                if (a.includes('destierr') || a.includes('destierra')) {
                  setBanished((prev: any[]) => [...(prev || []), top]);
                  alert(`🛡️ ¡Barrera activada por "${top.name}"! Se frenó el daño al Castillo y la carta fue Desterrada.`);
                } else {
                  addToGraveyard(top);
                  alert(`🛡️ ¡Barrera activada por "${top.name}"! Se frenó el daño al Castillo.`);
                }
                break;
              } else {
                addToGraveyard(top);
              }
            }
          }
        }
        return milled;
      }

      // =====================================================
      // UNGOLD / GENERATE_GOLD (pasar Oro pagado a Reserva / generar)
      // =====================================================

      if (
        effect.type === 'UNGOLD' || effect.type === 'GENERATE_GOLD'
      ) {
        const paidGold = goldZone.find((g: any) => g.isRested);
        if (paidGold) {
          setGoldZone((prev: any[]) =>
            prev.map((g: any) =>
              g.instanceId === paidGold.instanceId
                ? { ...g, isRested: false }
                : g
            )
          );
          return [paidGold];
        }
        return [];
      }

      // =====================================================
      // BUFF / DEBUFF / MODIFY_STRENGTH de fuerza
      // =====================================================

      if (
        effect.type === 'BUFF' || effect.type === 'DEBUFF' || effect.type === 'MODIFY_STRENGTH'
      ) {
        const val = Number(effect.amount) || 1;
        const buffVal = effect.type === 'DEBUFF' ? -Math.abs(val) : val;
        const targets = getSelectedEffectCards(effect);
        const cardsToBuff = targets.length > 0 ? targets : sourceCard ? [sourceCard] : [];
        const targetIds = new Set(cardsToBuff.map((c: any) => c.instanceId));

        const applyBuff = (setter: any) => {
          setter((prev: any[]) =>
            prev.map((c: any) =>
              targetIds.has(c.instanceId)
                ? { ...c, tempStrengthBuff: (c.tempStrengthBuff || 0) + buffVal }
                : c
            )
          );
        };
        applyBuff(setDefenseZone);
        applyBuff(setAttackZone);
        if (typeof setOpponentDefenseZone === 'function' && effect.target?.opponent) {
          setOpponentDefenseZone((prev: any[]) =>
            prev.map((c: any) =>
              targetIds.has(c.instanceId)
                ? { ...c, tempStrengthBuff: (c.tempStrengthBuff || 0) + buffVal }
                : c
            )
          );
        }
        return cardsToBuff;
      }

      // =====================================================
      // GAIN_KEYWORD (Furia, Imbloqueable, Indestructible, etc.)
      // =====================================================

      if (
        effect.type === 'GAIN_KEYWORD'
      ) {
        const kw = effect.keyword || 'Furia';
        const targets = getSelectedEffectCards(effect);
        const cardsToModify = targets.length > 0 ? targets : sourceCard ? [sourceCard] : [];
        const targetIds = new Set(cardsToModify.map((c: any) => c.instanceId));
        const applyKw = (setter: any) => {
          setter((prev: any[]) =>
            prev.map((c: any) =>
              targetIds.has(c.instanceId)
                ? {
                    ...c,
                    keywords: [...(c.keywords || []), kw],
                    canAttack: kw === 'Furia' ? true : c.canAttack,
                    hasFury: kw === 'Furia' ? true : c.hasFury,
                    isUnblockable: kw === 'Imbloqueable' ? true : c.isUnblockable
                  }
                : c
            )
          );
        };
        applyKw(setDefenseZone);
        applyKw(setAttackZone);
        return cardsToModify;
      }

      // =====================================================
      // LOSE_ABILITY (perder habilidad)
      // =====================================================

      if (
        effect.type === 'LOSE_ABILITY'
      ) {
        const targets = getSelectedEffectCards(effect);
        const targetIds = new Set(targets.map((c: any) => c.instanceId));
        const applyLose = (setter: any) => {
          setter((prev: any[]) =>
            prev.map((c: any) =>
              targetIds.has(c.instanceId) ? { ...c, ability: '', hasLostAbility: true } : c
            )
          );
        };
        applyLose(setDefenseZone);
        applyLose(setAttackZone);
        if (typeof setOpponentDefenseZone === 'function') {
          setOpponentDefenseZone((prev: any[]) =>
            prev.map((c: any) =>
              targetIds.has(c.instanceId) ? { ...c, ability: '', hasLostAbility: true } : c
            )
          );
        }
        return targets;
      }

      // =====================================================
      // CANCEL_ATTACK (cancelar ataque de Aliados)
      // =====================================================

      if (
        effect.type === 'CANCEL_ATTACK'
      ) {
        const targets = getSelectedEffectCards(effect);
        const targetIds = new Set(targets.map((c: any) => c.instanceId));
        if (typeof setOpponentAttackZone === 'function') {
          setOpponentAttackZone((prev: any[]) => {
            const toKeep = prev.filter((c: any) => !targetIds.has(c.instanceId));
            const toReturn = prev.filter((c: any) => targetIds.has(c.instanceId));
            if (typeof setOpponentDefenseZone === 'function' && toReturn.length > 0) {
              setOpponentDefenseZone((def: any[]) => [
                ...def,
                ...toReturn.map((c: any) => ({ ...c, canAttack: false, isRested: false }))
              ]);
            }
            return toKeep;
          });
        }
        return targets;
      }

      // =====================================================
      // SHUFFLE (barajar cartas al Castillo)
      // =====================================================

      if (
        effect.type === 'SHUFFLE'
      ) {
        const targets = getSelectedEffectCards(effect);
        if (targets.length > 0) {
          const targetIds = new Set(targets.map((c: any) => c.instanceId));
          setGraveyard((prev: any[]) => prev.filter((c: any) => !targetIds.has(c.instanceId)));
          setCastleCards((prev: any[]) => {
            const combined = [...prev, ...targets.map((c: any) => ({ ...c, isRested: false }))];
            return [...combined].sort(() => Math.random() - 0.5);
          });
        } else {
          setCastleCards((prev: any[]) => [...prev].sort(() => Math.random() - 0.5));
        }
        return targets;
      }

      // =====================================================
      // DISCARD (descartar de la mano)
      // =====================================================

      if (
        effect.type === 'DISCARD'
      ) {
        const targets = getSelectedEffectCards(effect);
        if (targets.length > 0) {
          const targetIds = new Set(targets.map((c: any) => c.instanceId));
          setHand((prev: any[]) => prev.filter((c: any) => !targetIds.has(c.instanceId)));
          targets.forEach((c: any) => addToGraveyard(c));
          return targets;
        } else {
          const amount = Number(effect.amount) || 1;
          const discarded = hand.slice(0, amount);
          const discIds = new Set(discarded.map((c: any) => c.instanceId));
          setHand((prev: any[]) => prev.filter((c: any) => !discIds.has(c.instanceId)));
          discarded.forEach((c: any) => addToGraveyard(c));
          return discarded;
        }
      }

      // =====================================================
      // PLAY_CARD (jugar carta desde cualquier zona)
      // =====================================================

      if (
        effect.type === 'PLAY_CARD'
      ) {
        const targets = getSelectedEffectCards(effect);
        if (targets.length > 0) {
          targets.forEach((c: any) => {
            removeCardFromPlayerZones(c);
            setGraveyard((prev: any[]) => prev.filter((g: any) => g.instanceId !== c.instanceId));
            setBanished((prev: any[]) => prev.filter((b: any) => b.instanceId !== c.instanceId));
            if (c.type === 'Aliado') {
              setDefenseZone((prev: any[]) => [...prev, { ...c, zone: 'DEFENSE', isRested: false, canAttack: false }]);
            } else if (c.type === 'Tótem') {
              setTotemZone((prev: any[]) => [...prev, { ...c, zone: 'TOTEM', isRested: false }]);
            }
          });
          return targets;
        }
      }

      // =====================================================
      // CONTROL_CHANGE (ganar control de Aliado oponente)
      // =====================================================

      if (
        effect.type === 'CONTROL_CHANGE'
      ) {
        const targets = getSelectedEffectCards(effect);
        if (targets.length > 0) {
          targets.forEach((c: any) => {
            removeCardFromOpponentZones(c);
            setDefenseZone((prev: any[]) => [...prev, { ...c, zone: 'DEFENSE', isRested: false, canAttack: false }]);
          });
          return targets;
        }
      }

      // =====================================================
      // TRANSFORM (convertir en Aliado o en Oro)
      // =====================================================

      if (
        effect.type === 'TRANSFORM'
      ) {
        const targets = getSelectedEffectCards(effect);
        const cardsToTransform = targets.length > 0 ? targets : sourceCard ? [sourceCard] : [];
        cardsToTransform.forEach((c: any) => {
          const str = Number(effect.value) || 3;
          removeCardFromPlayerZones(c);
          setDefenseZone((prev: any[]) => [
            ...prev,
            { ...c, type: 'Aliado', strength: str, ability: c.ability || 'Aliado F3.', zone: 'DEFENSE', isRested: false, canAttack: true }
          ]);
        });
        return cardsToTransform;
      }

      // =====================================================
      // DOUBLE_COMBAT_DAMAGE (doble daño de combate)
      // =====================================================

      if (
        effect.type === 'DOUBLE_COMBAT_DAMAGE'
      ) {
        const targets = getSelectedEffectCards(effect);
        const cardsToBuff = targets.length > 0 ? targets : sourceCard ? [sourceCard] : [];
        cardsToBuff.forEach((c: any) => {
          c.dealsDoubleDamage = true;
        });
        alert(`¡Doble daño de combate activado para ${cardsToBuff.map((c: any) => c.name).join(', ')}!`);
        return cardsToBuff;
      }

      // =====================================================
      // LOOK_AT / REVEAL (mirar mano u oponente)
      // =====================================================

      if (
        effect.type === 'LOOK_AT' || effect.type === 'REVEAL'
      ) {
        const oppHand = typeof opponentHandCount === 'number' ? opponentHandCount : 0;
        alert(`👁️ [Efecto Revelar]: Miraste las cartas (${oppHand} cartas en mano oponente).`);
        return [];
      }

      // =====================================================
      // MODIFY_COST (reducción de coste)
      // =====================================================

      if (
        effect.type === 'MODIFY_COST'
      ) {
        const red = Number(effect.amount || effect.costReduction) || 1;
        alert(`Coste reducido en ${red} Oro(s) para este turno.`);
        return [];
      }

      // =====================================================
      // NO IMPLEMENTADO
      // =====================================================

      ctx?.log?.(
        'Efecto detectado pero sin resolución física:',
        effect
      );

      return null;
    };

  // =========================================================
  // PROMPT
  // =========================================================

  const requestAbilityPrompt = (promptData: any): Promise<any> => {
    const target = promptData?.options?.find(
      (option: any) => option?.type === 'TARGET_SPEC'
    )?.target;

    const sourceCard = currentAbilityCardRef.current;

    const enrichedPrompt = {
      ...promptData,
      _effectTarget: target,
      cardName: promptData?.cardName || sourceCard?.name || 'Carta',
      cardType: promptData?.cardType || sourceCard?.type || 'Efecto',
      cardAbility: promptData?.cardAbility || sourceCard?.ability || '',
      imageUrl: promptData?.imageUrl || sourceCard?.imageUrl || '',
      triggerType: promptData?.triggerType || (sourceCard ? 'Habilidad de Carta' : 'Efecto')
    };

    return new Promise((resolve) => {
      abilityPromptResolverRef.current = resolve;
      setAbilityPrompt(enrichedPrompt);
    });
  };

  // =========================================================
  // ESTADO DEL MOTOR
  // =========================================================

  const effectState = {

    applyEffect,

    drawCard:
      async (
        playerId: string
      ) => {

        if (
          playerId !==
          myPlayerId
        ) {

          return null;
        }

        return drawCardByEffect();
      }
  };

  // =========================================================
  // EJECUTAR HABILIDAD
  // =========================================================

  const executeCardAbility =
    async (
      card: any,
      isEnteringPlay: boolean = false,
      customTrigger?: any
    ) => {

      if (!card) {
        return;
      }

      // Check if card is silenced or has its ability disabled
      if (card.isAbilityDisabled || card.isSilenced || card.convertedToVanilla) {
        showNotice(`"${card.name}" está sin habilidad / anulada y no puede activar efectos.`, 'info');
        return;
      }

      const ability =
        String(
          card.ability ||
          ''
        ).trim();

      if (!ability || ability === 'Oro sin habilidad.') {
        return;
      }

      const normName = String(card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      const normAb = String(card.ability || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      const isGold = card.type === 'Oro';

      currentAbilityCardRef.current =
        card;

      try {
        const activeTrigger = customTrigger || (isEnteringPlay ? 'CARD_ENTERS_PLAY' : 'ACTIVATED_ONCE_PER_TURN');
        console.log(
          '[ABILITY] Resolviendo:',
          card.name,
          'trigger:',
          activeTrigger
        );

        const executionContext = {
          sourceCard: card,
          playerSide: 'player' as const,
          trigger: activeTrigger as any,
          isMultiplayer: !!isMultiplayer,
          gameState: {
            hand,
            castleCards,
            graveyard,
            banished,
            defenseZone,
            attackZone,
            totemZone,
            goldZone,
            opponentCastleCards,
            opponentCastleCount,
            opponentHand,
            opponentHandCount,
            opponentDefenseZone,
            opponentAttackZone,
            opponentTotemZone,
            opponentGoldZone,
            opponentGraveyard,
            opponentBanished
          },
          promptUser: requestAbilityPrompt,
          sendGameAction,
          showNotice,
          drawCard: drawCardByEffect,
          millCards: (side: 'player' | 'opponent', count: number) => {
            if (side === 'opponent') {
              if (typeof setOpponentCastleCards === 'function') {
                setOpponentCastleCards((prev: any[]) => {
                  const milled = (prev || []).slice(0, count);
                  setRecentOpponentGraveyardCards(milled);
                  if (typeof setOpponentGraveyard === 'function') {
                    setOpponentGraveyard((g: any[]) => [...(g || []), ...milled]);
                  }
                  return (prev || []).slice(count);
                });
              }
              if (typeof setOpponentCastleCount === 'function') {
                setOpponentCastleCount((c: number) => Math.max(0, (c ?? 0) - count));
              }
            } else {
              setCastleCards((prev: any[]) => {
                const milled = (prev || []).slice(0, count);
                setGraveyard((g: any[]) => [...(g || []), ...milled]);
                return (prev || []).slice(count);
              });
            }
          },

          // ── Game State Mutation Functions ──
          // These allow handlers/EffectEngine to ACTUALLY modify game state.

          destroyCard: (instanceId: string) => {
            // Find the card in any field zone, remove it, and add to graveyard
            let foundCard: any = null;
            setDefenseZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setAttackZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setTotemZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setGoldZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            // Also check opponent zones
            if (typeof setOpponentDefenseZone === 'function') {
              setOpponentDefenseZone((prev: any[]) => {
                const card = (prev || []).find((c: any) => (c.instanceId || c.id) === instanceId);
                if (card && !foundCard) foundCard = card;
                return (prev || []).filter((c: any) => (c.instanceId || c.id) !== instanceId);
              });
            }
            if (typeof setOpponentAttackZone === 'function') {
              setOpponentAttackZone((prev: any[]) => {
                const card = (prev || []).find((c: any) => (c.instanceId || c.id) === instanceId);
                if (card && !foundCard) foundCard = card;
                return (prev || []).filter((c: any) => (c.instanceId || c.id) !== instanceId);
              });
            }
            // Add to graveyard (opponent or player based on where found)
            if (foundCard) {
              addToGraveyard(foundCard);
            }
          },

          banishCard: (instanceId: string) => {
            let foundCard: any = null;
            // Remove from all possible zones
            setDefenseZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setAttackZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setTotemZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setGoldZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setHand((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setGraveyard((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setCastleCards((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            if (foundCard) {
              addToBanished(foundCard);
            }
          },

          shuffleToCastle: (instanceId: string) => {
            let foundCard: any = null;
            setDefenseZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setAttackZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setTotemZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setGoldZone((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setGraveyard((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            setHand((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card && !foundCard) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            if (foundCard) {
              setCastleCards((prev: any[]) => [...(prev || []), { ...foundCard, zone: 'CASTLE', isRested: false }]);
            }
          },

          discardFromHand: (instanceId: string) => {
            let foundCard: any = null;
            setHand((prev: any[]) => {
              const card = prev.find((c: any) => (c.instanceId || c.id) === instanceId);
              if (card) foundCard = card;
              return prev.filter((c: any) => (c.instanceId || c.id) !== instanceId);
            });
            if (foundCard) {
              addToGraveyard(foundCard);
            }
          },

          moveCardToHand: (card: any) => {
            if (!card) return;
            setHand((prev: any[]) => [...prev, { ...card, zone: 'HAND' }]);
          },

          removeFromField: (instanceId: string) => {
            setDefenseZone((prev: any[]) => prev.filter((c: any) => (c.instanceId || c.id) !== instanceId));
            setAttackZone((prev: any[]) => prev.filter((c: any) => (c.instanceId || c.id) !== instanceId));
            setTotemZone((prev: any[]) => prev.filter((c: any) => (c.instanceId || c.id) !== instanceId));
            setGoldZone((prev: any[]) => prev.filter((c: any) => (c.instanceId || c.id) !== instanceId));
          },

          removeFromCastle: (instanceId: string) => {
            setCastleCards((prev: any[]) => prev.filter((c: any) => (c.instanceId || c.id) !== instanceId));
          },

          removeFromGraveyard: (instanceId: string) => {
            setGraveyard((prev: any[]) => prev.filter((c: any) => (c.instanceId || c.id) !== instanceId));
          },

          addToGraveyard: (card: any) => {
            addToGraveyard(card);
          },

          addToBanished: (card: any) => {
            addToBanished(card);
          },

          disableAbility: (instanceId: string, duration?: 'TURN' | 'WHILE_IN_PLAY' | 'PERMANENT') => {
            const silenceMapper = (c: any) =>
              (c.instanceId || c.id) === instanceId
                ? { ...c, isAbilityDisabled: true, isSilenced: true, abilityDisabledDuration: duration || 'TURN' }
                : c;

            setDefenseZone((prev: any[]) => prev.map(silenceMapper));
            setAttackZone((prev: any[]) => prev.map(silenceMapper));
            setTotemZone((prev: any[]) => prev.map(silenceMapper));
            setGoldZone((prev: any[]) => prev.map(silenceMapper));
            if (typeof setOpponentDefenseZone === 'function') {
              setOpponentDefenseZone((prev: any[]) => (prev || []).map(silenceMapper));
            }
            if (typeof setOpponentAttackZone === 'function') {
              setOpponentAttackZone((prev: any[]) => (prev || []).map(silenceMapper));
            }
          },

          stealControl: (instanceId: string) => {
            let stolenCard: any = null;
            if (typeof setOpponentDefenseZone === 'function') {
              setOpponentDefenseZone((prev: any[]) => {
                const card = (prev || []).find((c: any) => (c.instanceId || c.id) === instanceId);
                if (card) stolenCard = card;
                return (prev || []).filter((c: any) => (c.instanceId || c.id) !== instanceId);
              });
            }
            if (typeof setOpponentAttackZone === 'function') {
              setOpponentAttackZone((prev: any[]) => {
                const card = (prev || []).find((c: any) => (c.instanceId || c.id) === instanceId);
                if (card && !stolenCard) stolenCard = card;
                return (prev || []).filter((c: any) => (c.instanceId || c.id) !== instanceId);
              });
            }
            if (typeof setOpponentTotemZone === 'function') {
              setOpponentTotemZone((prev: any[]) => {
                const card = (prev || []).find((c: any) => (c.instanceId || c.id) === instanceId);
                if (card && !stolenCard) stolenCard = card;
                return (prev || []).filter((c: any) => (c.instanceId || c.id) !== instanceId);
              });
            }
            if (stolenCard) {
              const underMyControl = { ...stolenCard, playerSide: 'player' };
              if (stolenCard.type === 'Tótem') {
                setTotemZone((prev: any[]) => [...prev, underMyControl]);
              } else {
                setDefenseZone((prev: any[]) => [...prev, underMyControl]);
              }
            }
          },

          generateGold: (count: number = 1) => {
            setGoldZone((prev: any[]) => {
              const newGolds: any[] = [];
              for (let i = 0; i < count; i++) {
                newGolds.push({
                  id: `generated-gold-${Date.now()}-${i}`,
                  instanceId: `gen-gold-${Date.now()}-${i}`,
                  name: 'Oro Generado',
                  type: 'Oro',
                  cost: 0,
                  isRested: false,
                  isGenerated: true,
                  ability: 'Oro sin habilidad.'
                });
              }
              return [...prev, ...newGolds];
            });
          }
        };


        const handledByEngine = await AbilityInterpreter.executeAbility(executionContext);
        if (!handledByEngine) {
          console.log('[ABILITY] Habilidad procesada o sin efecto activo para el trigger actual:', card.name);
        }
      } catch (
        error
      ) {

        console.error(
          `[ABILITY] Error resolviendo "${card.name}":`,
          error
        );

        setAbilityPrompt(
          null
        );

        abilityPromptResolverRef.current(
          null
        );

      } finally {

        currentAbilityCardRef.current =
          null;
      }
    };

  // =========================================================
  // VALIDAR OBJETIVO
  // =========================================================

  const cardMatchesTarget =
    (
      card: any,
      target: any,
      owner:
        | 'PLAYER'
        | 'OPPONENT'
    ): boolean => {

      if (!card) {
        return false;
      }

      if (
        target?.opponent ===
        true
      ) {

        if (
          owner !==
          'OPPONENT'
        ) {
          return false;
        }

      } else {

        if (
          owner !==
          'PLAYER'
        ) {
          return false;
        }
      }

      const type =
        String(
          card.type ||
          ''
        )
          .normalize('NFD')
          .replace(
            /[\u0300-\u036f]/g,
            ''
          )
          .toLowerCase();

      const kind =
        target?.kind;

      if (
        kind ===
        'ALLY' &&
        type !==
        'aliado'
      ) {

        return false;
      }

      if (
        kind ===
        'WEAPON' &&
        type !==
        'arma'
      ) {

        return false;
      }

      if (
        kind ===
        'GOLD' &&
        type !==
        'oro'
      ) {

        return false;
      }

      if (
        kind ===
        'TOTEM' &&
        type !==
        'totem'
      ) {

        return false;
      }

      if (
        kind ===
        'TALISMAN' &&
        type !==
        'talisman'
      ) {

        return false;
      }

      if (
        target?.maxCost !==
        undefined
      ) {

        const cost =
          Number(
            card.cost
          ) || 0;

        if (
          cost >
          Number(
            target.maxCost
          )
        ) {

          return false;
        }
      }

      if (
        target?.minCost !==
        undefined
      ) {

        const cost =
          Number(
            card.cost
          ) || 0;

        if (
          cost <
          Number(
            target.minCost
          )
        ) {

          return false;
        }
      }

      return true;
    };

  // =========================================================
  // CANDIDATOS
  // =========================================================

  const getTargetCandidates =
    (
      target: any
    ): any[] => {

      if (!target) {
        return [];
      }

      const candidates: any[] = [];

      const seen =
        new Set<string>();

      const addCandidate =
        (
          card: any,
          owner:
            | 'PLAYER'
            | 'OPPONENT',
          zoneName: string,
          index: number
        ) => {

          if (!card) {
            return;
          }

          const baseId =
            getCardInstanceId(
              card
            );

          const uniqueKey =
            baseId
              ? `${owner}:${baseId}`
              : `${owner}:${zoneName}:${index}`;

          if (
            seen.has(
              uniqueKey
            )
          ) {
            return;
          }

          seen.add(
            uniqueKey
          );

          candidates.push({

            ...card,

            __targetOwner:
              owner,

            __targetZone:
              zoneName
          });
        };

      // =======================================================
      // PROPIAS
      // =======================================================

      if (
        target.opponent !==
        true
      ) {

        const zones = [

          {
            name:
              'ATTACK',

            cards:
              attackZone || []
          },

          {
            name:
              'DEFENSE',

            cards:
              defenseZone || []
          },

          {
            name:
              'TOTEM',

            cards:
              totemZone || []
          },

          {
            name:
              'GOLD',

            cards:
              goldZone || []
          }

        ];

        for (
          const zone of
          zones
        ) {

          zone.cards.forEach(
            (
              card: any,
              index: number
            ) => {

              if (
                cardMatchesTarget(
                  card,
                  target,
                  'PLAYER'
                )
              ) {

                addCandidate(
                  card,
                  'PLAYER',
                  zone.name,
                  index
                );
              }
            }
          );
        }
      }

      // =======================================================
      // OPONENTE
      // =======================================================

      if (
        target.opponent ===
        true
      ) {

        const zones = [

          {
            name:
              'ATTACK',

            cards:
              opponentAttackZone || []
          },

          {
            name:
              'DEFENSE',

            cards:
              opponentDefenseZone || []
          },

          {
            name:
              'TOTEM',

            cards:
              opponentTotemZone || []
          },

          {
            name:
              'GOLD',

            cards:
              opponentGoldZone || []
          }

        ];

        for (
          const zone of
          zones
        ) {

          zone.cards.forEach(
            (
              card: any,
              index: number
            ) => {

              if (
                cardMatchesTarget(
                  card,
                  target,
                  'OPPONENT'
                )
              ) {

                addCandidate(
                  card,
                  'OPPONENT',
                  zone.name,
                  index
                );
              }
            }
          );
        }
      }

      return candidates;
    };

  // =========================================================
  // LABEL OBJETIVO
  // =========================================================

  const getTargetLabel =
    (
      target: any
    ): string => {

      if (
        target?.opponent
      ) {

        switch (
          target.kind
        ) {

          case 'ALLY':
            return 'Aliado oponente';

          case 'WEAPON':
            return 'Arma oponente';

          case 'GOLD':
            return 'Oro oponente';

          case 'TOTEM':
            return 'Tótem oponente';

          case 'TALISMAN':
            return 'Talismán oponente';

          default:
            return 'Carta oponente';
        }
      }

      switch (
        target?.kind
      ) {

        case 'ALLY':
          return 'Aliado';

        case 'WEAPON':
          return 'Arma';

        case 'GOLD':
          return 'Oro';

        case 'TOTEM':
          return 'Tótem';

        case 'TALISMAN':
          return 'Talismán';

        default:
          return 'Carta';
      }
    };

  // =========================================================
  // PROMPT VISUAL
  // =========================================================

  const renderAbilityPrompt = () => {
    if (!abilityPrompt) {
      return null;
    }

    const target = abilityPrompt?._effectTarget;
    const candidates = target ? getTargetCandidates(target) : [];

    const handleClose = () => {
      if (abilityPromptResolverRef.current) {
        abilityPromptResolverRef.current(false);
      }
      setAbilityPrompt(null);
    };

    return (
      <GameModal
        isOpen={Boolean(abilityPrompt)}
        onClose={handleClose}
        title={abilityPrompt.cardName || 'Habilidad'}
        badge={abilityPrompt.triggerType || 'Habilidad'}
        subtitle={abilityPrompt.cardType || 'Carta'}
        imageUrl={abilityPrompt.imageUrl}
        maxWidth="max-w-md sm:max-w-lg md:max-w-xl"
        zIndexClass="z-[600]"
        footer={
          abilityPrompt.mode === 'CONFIRM' ? (
            <div className="w-full flex gap-2">
              <button
                onClick={() => {
                  abilityPromptResolverRef.current(true);
                  setAbilityPrompt(null);
                }}
                className="flex-1 py-2.5 bg-gradient-to-r from-amber-500 via-amber-400 to-amber-500 hover:from-amber-400 text-zinc-950 rounded-xl font-black text-xs uppercase tracking-wider transition shadow active:scale-95 cursor-pointer"
              >
                ✨ Activar ({abilityPrompt.cardName || 'Efecto'})
              </button>

              <button
                onClick={() => {
                  abilityPromptResolverRef.current(false);
                  setAbilityPrompt(null);
                }}
                className="flex-1 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl font-bold text-xs uppercase tracking-wider transition active:scale-95 cursor-pointer"
              >
                ❌ Pasar
              </button>
            </div>
          ) : abilityPrompt.mode === 'PAY_COST' ? (
            <button
              onClick={() => {
                abilityPromptResolverRef.current(true);
                setAbilityPrompt(null);
              }}
              className="w-full py-2.5 bg-amber-500 text-zinc-950 rounded-xl font-black text-xs hover:bg-amber-400 active:scale-95 cursor-pointer"
            >
              Confirmar Pago
            </button>
          ) : (
            <button
              onClick={handleClose}
              className="w-full py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 font-bold text-xs rounded-xl border border-zinc-700"
            >
              Cancelar
            </button>
          )
        }
      >
        {/* Ability Card Text */}
        {abilityPrompt.cardAbility && (
          <div className="mb-2 p-2 bg-zinc-950/80 border border-amber-500/30 rounded-xl">
            <span className="text-[9px] font-bold text-amber-400 uppercase tracking-wider block mb-0.5">
              📜 Texto de la Carta:
            </span>
            <p className="text-[10px] text-zinc-300 italic leading-relaxed">
              {abilityPrompt.cardAbility}
            </p>
          </div>
        )}

        {target && (
          <span className="inline-block mb-2 text-[9px] font-black uppercase text-blue-300 bg-blue-950 border border-blue-700 rounded-md px-2 py-0.5">
            Objetivo: {getTargetLabel(target)}
          </span>
        )}

        {/* Mode: CONFIRM */}
        {abilityPrompt.mode === 'CONFIRM' && (
          <div className="p-2.5 bg-zinc-950/90 border border-amber-500/40 rounded-xl shadow-inner my-1">
            <span className="text-[9px] text-amber-400 font-bold uppercase tracking-wider block mb-0.5">
              ⚡ Efecto a Resolver:
            </span>
            <p className="text-xs text-zinc-200 font-semibold leading-relaxed">
              {abilityPrompt.message || `¿Deseas activar la habilidad de ${abilityPrompt.cardName || 'esta carta'}?`}
            </p>
          </div>
        )}

        {/* Mode: SELECT_TARGETS */}
        {abilityPrompt.mode === 'SELECT_TARGETS' && (
          <div>
            {candidates.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-zinc-500 font-black text-xs">No hay objetivos válidos.</p>
                <p className="text-[10px] text-zinc-600 mt-0.5">No existe ninguna carta que cumpla las condiciones requeridas.</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 max-h-[45dvh] overflow-y-auto pr-1">
                {candidates.map((targetCard: any, index: number) => {
                  const owner = targetCard.__targetOwner;
                  const zone = targetCard.__targetZone || 'ZONE';
                  const preview = { ...targetCard };
                  delete preview.__targetOwner;
                  delete preview.__targetZone;

                  return (
                    <button
                      key={`${owner}-${zone}-${targetCard.instanceId || targetCard.id || index}`}
                      onClick={() => {
                        abilityPromptResolverRef.current(targetCard);
                        setAbilityPrompt(null);
                      }}
                      className={`relative aspect-[2.5/3.5] rounded-xl overflow-hidden border-2 bg-zinc-950 shadow hover:scale-105 active:scale-95 transition-transform ${
                        owner === 'OPPONENT' ? 'border-red-500 hover:border-red-300' : 'border-amber-500 hover:border-amber-300'
                      }`}
                    >
                      <img
                        src={targetCard.imageUrl}
                        alt={targetCard.name || 'Carta'}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-0.5 left-0.5 right-0.5">
                        <span className={`block text-[7px] font-black px-1 py-0.2 rounded text-center ${
                          owner === 'OPPONENT' ? 'bg-red-600 text-white' : 'bg-amber-500 text-zinc-950'
                        }`}>
                          {owner === 'OPPONENT' ? 'OPONENTE' : 'TÚ'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Mode: SELECT_CARDS */}
        {abilityPrompt.mode === 'SELECT_CARDS' && (
          <div>
            {hand.length === 0 ? (
              <div className="py-8 text-center text-xs text-zinc-500 font-bold">No hay cartas disponibles.</div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 max-h-[45dvh] overflow-y-auto pr-1">
                {hand.map((card: any, index: number) => (
                  <button
                    key={`${card.instanceId || card.id || 'hand'}-select-${index}`}
                    onClick={() => {
                      abilityPromptResolverRef.current(card);
                      setAbilityPrompt(null);
                    }}
                    className="relative aspect-[2.5/3.5] rounded-xl overflow-hidden border border-zinc-700 hover:border-amber-400 hover:scale-105 active:scale-95 transition shadow"
                  >
                    <img src={card.imageUrl} alt={card.name || 'Carta'} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Mode: CUSTOM_CHOICE */}
        {abilityPrompt.mode === 'CUSTOM_CHOICE' && (
          <div className="flex flex-col gap-2">
            {abilityPrompt.message && (
              <p className="text-xs text-zinc-300 font-semibold mb-1">{abilityPrompt.message}</p>
            )}
            <div className="space-y-1.5 max-h-[45dvh] overflow-y-auto pr-1">
              {(abilityPrompt.options || []).map((opt: any, idx: number) => (
                <button
                  key={`custom-choice-opt-${opt.id || idx}`}
                  onClick={() => {
                    if (typeof abilityPrompt.onSelect === 'function') abilityPrompt.onSelect(opt.id);
                    if (abilityPromptResolverRef.current) abilityPromptResolverRef.current(opt.id);
                    setAbilityPrompt(null);
                  }}
                  className="w-full p-2.5 bg-gradient-to-r from-[#24170e] to-[#140e08] hover:from-amber-600 hover:to-amber-700 border border-amber-500/60 text-amber-100 hover:text-zinc-950 rounded-xl font-bold text-xs flex items-center justify-between transition active:scale-95 shadow cursor-pointer text-left"
                >
                  <div className="flex items-center gap-2">
                    {opt.icon && <span>{opt.icon}</span>}
                    <span>{opt.label}</span>
                  </div>
                  <span className="text-[9px] opacity-70 uppercase">Elegir →</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Mode: SELECT_CARD */}
        {abilityPrompt.mode === 'SELECT_CARD' && (
          <div className="flex flex-col gap-2">
            {abilityPrompt.message && (
              <p className="text-xs text-zinc-300 font-semibold mb-1">{abilityPrompt.message}</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[45dvh] overflow-y-auto pr-1">
              {(abilityPrompt.options || []).map((opt: any, idx: number) => (
                <button
                  key={`select-card-opt-${opt.id || idx}`}
                  onClick={() => {
                    if (typeof abilityPrompt.onSelect === 'function') abilityPrompt.onSelect(opt.id);
                    if (abilityPromptResolverRef.current) abilityPromptResolverRef.current(opt.id);
                    setAbilityPrompt(null);
                  }}
                  className="p-2 bg-zinc-950/80 hover:bg-amber-950/80 border border-zinc-800 hover:border-amber-400 rounded-xl flex items-center gap-2.5 transition active:scale-95 cursor-pointer shadow text-left"
                >
                  {opt.imageUrl ? (
                    <img src={opt.imageUrl} alt={opt.label} className="w-8 h-11 object-cover rounded border border-zinc-700 shrink-0" />
                  ) : (
                    <span className="w-8 h-11 bg-zinc-900 rounded border border-zinc-700 flex items-center justify-center text-xs shrink-0">🃏</span>
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-bold text-zinc-200 block truncate">{opt.label}</span>
                    {opt.type && <span className="text-[9px] text-zinc-400">{opt.type}</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Mode: NAME_CARD */}
        {abilityPrompt.mode === 'NAME_CARD' && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
                <input
                  type="text"
                  autoFocus
                  value={nameCardSearch}
                  onChange={(e) => setNameCardSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && nameCardSearch.trim()) {
                      abilityPromptResolverRef.current(nameCardSearch.trim());
                      setAbilityPrompt(null);
                      setNameCardSearch('');
                    }
                  }}
                  placeholder="Buscar carta a nombrar..."
                  className="w-full pl-8 pr-3 py-1.5 bg-zinc-950 border border-amber-900/50 rounded-xl text-zinc-100 text-xs focus:outline-none focus:border-amber-500"
                />
              </div>
              {nameCardSearch.trim() && (
                <button
                  onClick={() => {
                    abilityPromptResolverRef.current(nameCardSearch.trim());
                    setAbilityPrompt(null);
                    setNameCardSearch('');
                  }}
                  className="px-3 py-1.5 bg-amber-500 text-zinc-950 rounded-xl font-black text-xs shadow active:scale-95"
                >
                  Nombrar
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-[40dvh] overflow-y-auto pr-1">
              {filteredNamingCards.map((cardItem: any, idx: number) => (
                <button
                  key={`${cardItem.id || cardItem.name}-${idx}`}
                  onClick={() => {
                    abilityPromptResolverRef.current(cardItem.name);
                    setAbilityPrompt(null);
                    setNameCardSearch('');
                  }}
                  className="flex flex-col items-center bg-zinc-950/80 border border-zinc-800 hover:border-amber-500 p-1.5 rounded-xl transition active:scale-95 shadow text-center"
                >
                  {cardItem.imageUrl && (
                    <img src={cardItem.imageUrl} alt={cardItem.name} className="w-full aspect-[2.5/3.5] object-cover rounded mb-1 bg-zinc-900" />
                  )}
                  <span className="text-[10px] font-bold text-zinc-200 truncate w-full capitalize">{cardItem.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </GameModal>
    );
  };
  // =========================================================
  // MODAL INTERACTIVO SIGNO AMARILLO (MIRAR 4 CARTAS)
  // =========================================================

  const renderSignoAmarilloModal = () => {
    if (!signoAmarilloModal || !signoAmarilloModal.isOpen) return null;

    const { cards, toHandId, toGraveId, toTopIds, toBottomIds } = signoAmarilloModal;

    const getCardDestination = (cardId: string) => {
      if (toHandId === cardId) return 'HAND';
      if (toGraveId === cardId) return 'GRAVE';
      if (toTopIds.includes(cardId)) return 'TOP';
      if (toBottomIds.includes(cardId)) return 'BOTTOM';
      return null;
    };

    const assignCard = (cardId: string, dest: 'HAND' | 'GRAVE' | 'TOP' | 'BOTTOM') => {
      setSignoAmarilloModal((prev) => {
        if (!prev) return null;
        let newToHand = prev.toHandId === cardId ? null : prev.toHandId;
        let newToGrave = prev.toGraveId === cardId ? null : prev.toGraveId;
        const newToTop = prev.toTopIds.filter((id) => id !== cardId);
        const newToBottom = prev.toBottomIds.filter((id) => id !== cardId);

        if (dest === 'HAND') {
          newToHand = cardId;
        } else if (dest === 'GRAVE') {
          newToGrave = cardId;
        } else if (dest === 'TOP') {
          newToTop.push(cardId);
        } else if (dest === 'BOTTOM') {
          newToBottom.push(cardId);
        }

        return {
          ...prev,
          toHandId: newToHand,
          toGraveId: newToGrave,
          toTopIds: newToTop,
          toBottomIds: newToBottom
        };
      });
    };

    const canConfirm =
      Boolean(toHandId) &&
      Boolean(toGraveId) &&
      (cards.length <= 2 || toTopIds.length + toBottomIds.length === cards.length - 2);

    const handleConfirm = () => {
      const cardToHand = cards.find((c: any) => (c.instanceId || c.id) === toHandId);
      const cardToGrave = cards.find((c: any) => (c.instanceId || c.id) === toGraveId);
      const cardsToTop = toTopIds
        .map((id) => cards.find((c: any) => (c.instanceId || c.id) === id))
        .filter(Boolean);
      const cardsToBottom = toBottomIds
        .map((id) => cards.find((c: any) => (c.instanceId || c.id) === id))
        .filter(Boolean);

      if (isMultiplayer) {
        sendGameAction({
          type: 'SIGNO_AMARILLO_RESOLVE',
          toHandInstanceId: toHandId,
          toGraveInstanceId: toGraveId,
          toTopInstanceIds: toTopIds,
          toBottomInstanceIds: toBottomIds
        });
      } else {
        const cardIds = cards.map((c: any) => c.instanceId || c.id);
        const remainingCastle = castleCards.filter(
          (c: any) => !cardIds.includes(c.instanceId || c.id)
        );

        setCastleCards([...cardsToTop, ...remainingCastle, ...cardsToBottom]);

        if (cardToHand) {
          setHand((prev: any[]) => [...prev, { ...cardToHand, isRested: false }]);
        }

        if (cardToGrave) {
          setGraveyard((prev: any[]) => [...(prev || []), cardToGrave]);
        }

        alert(`¡Signo Amarillo resuelto!
• Mano: ${cardToHand?.name || 'Ninguna'}
• Cementerio: ${cardToGrave?.name || 'Ninguna'}
• Tope de Castillo (${cardsToTop.length}): ${cardsToTop.map((c: any) => c.name).join(', ') || 'Ninguna'}
• Fondo de Castillo (${cardsToBottom.length}): ${cardsToBottom.map((c: any) => c.name).join(', ') || 'Ninguna'}`);
      }

      setSignoAmarilloModal(null);
    };

    return (
      <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
        <div className="w-full max-w-3xl max-h-[92dvh] bg-[#120d08] border-2 border-amber-500 rounded-2xl shadow-2xl p-3 sm:p-4 flex flex-col justify-between overflow-hidden safe-area-paddings">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-amber-800/40">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl">🌟</span>
                <h2 className="text-xl font-black text-amber-300 uppercase tracking-wide">
                  Signo Amarillo
                </h2>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                Mira las 4 primeras cartas de tu Castillo. Selecciona exactamente{' '}
                <strong className="text-emerald-400">1 para tu Mano</strong>,{' '}
                <strong className="text-red-400">1 para tu Cementerio</strong> y las demás para el{' '}
                <strong className="text-blue-400">Tope</strong> o{' '}
                <strong className="text-purple-400">Fondo</strong> de tu Castillo.
              </p>
            </div>
            <button
              onClick={() => setSignoAmarilloModal(null)}
              className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {cards.map((card: any, idx: number) => {
                const cId = card.instanceId || card.id || `card-${idx}`;
                const dest = getCardDestination(cId);

                return (
                  <div
                    key={`signo-${cId}-${idx}`}
                    className={`relative bg-zinc-950 rounded-2xl p-2 border-2 transition-all flex flex-col items-center ${
                      dest === 'HAND'
                        ? 'border-emerald-500 shadow-lg shadow-emerald-500/20 bg-emerald-950/20'
                        : dest === 'GRAVE'
                        ? 'border-red-500 shadow-lg shadow-red-500/20 bg-red-950/20'
                        : dest === 'TOP'
                        ? 'border-blue-500 shadow-lg shadow-blue-500/20 bg-blue-950/20'
                        : dest === 'BOTTOM'
                        ? 'border-purple-500 shadow-lg shadow-purple-500/20 bg-purple-950/20'
                        : 'border-zinc-800 hover:border-amber-500/50'
                    }`}
                  >
                    <div className="w-full aspect-[2/3] rounded-xl overflow-hidden bg-black mb-2 flex items-center justify-center">
                      <img
                        src={card.imageUrl}
                        alt={card.name}
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <span className="text-xs font-black text-amber-200 text-center line-clamp-1 mb-2">
                      {card.name}
                    </span>

                    {/* Botones de acción */}
                    <div className="w-full grid grid-cols-2 gap-1 mt-auto">
                      <button
                        onClick={() => assignCard(cId, 'HAND')}
                        className={`py-1 px-1 rounded-lg text-[10px] font-black uppercase transition ${
                          dest === 'HAND'
                            ? 'bg-emerald-500 text-black shadow'
                            : toHandId && toHandId !== cId
                            ? 'bg-zinc-900 text-zinc-600 hover:bg-zinc-800'
                            : 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 hover:bg-emerald-800'
                        }`}
                      >
                        🖐️ Mano
                      </button>

                      <button
                        onClick={() => assignCard(cId, 'GRAVE')}
                        className={`py-1 px-1 rounded-lg text-[10px] font-black uppercase transition ${
                          dest === 'GRAVE'
                            ? 'bg-red-500 text-white shadow'
                            : toGraveId && toGraveId !== cId
                            ? 'bg-zinc-900 text-zinc-600 hover:bg-zinc-800'
                            : 'bg-red-950/80 text-red-300 border border-red-700/60 hover:bg-red-800'
                        }`}
                      >
                        💀 Cementerio
                      </button>

                      <button
                        onClick={() => assignCard(cId, 'TOP')}
                        className={`py-1 px-1 rounded-lg text-[10px] font-black uppercase transition ${
                          dest === 'TOP'
                            ? 'bg-blue-500 text-white shadow'
                            : 'bg-blue-950/80 text-blue-300 border border-blue-700/60 hover:bg-blue-800'
                        }`}
                      >
                        ⬆️ Tope
                      </button>

                      <button
                        onClick={() => assignCard(cId, 'BOTTOM')}
                        className={`py-1 px-1 rounded-lg text-[10px] font-black uppercase transition ${
                          dest === 'BOTTOM'
                            ? 'bg-purple-500 text-white shadow'
                            : 'bg-purple-950/80 text-purple-300 border border-purple-700/60 hover:bg-purple-800'
                        }`}
                      >
                        ⬇️ Fondo
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Resumen y Botón de Confirmación */}
          <div className="mt-4 pt-3 border-t border-zinc-800 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span
                className={`px-2 py-1 rounded-lg font-bold ${
                  toHandId
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                    : 'bg-zinc-900 text-zinc-500'
                }`}
              >
                🖐️ Mano:{' '}
                {cards.find((c: any) => (c.instanceId || c.id) === toHandId)?.name || 'Sin elegir'}
              </span>
              <span
                className={`px-2 py-1 rounded-lg font-bold ${
                  toGraveId
                    ? 'bg-red-950 text-red-300 border border-red-700'
                    : 'bg-zinc-900 text-zinc-500'
                }`}
              >
                💀 Cementerio:{' '}
                {cards.find((c: any) => (c.instanceId || c.id) === toGraveId)?.name ||
                  'Sin elegir'}
              </span>
              <span
                className={`px-2 py-1 rounded-lg font-bold ${
                  toTopIds.length > 0
                    ? 'bg-blue-950 text-blue-300 border border-blue-700'
                    : 'bg-zinc-900 text-zinc-500'
                }`}
              >
                ⬆️ Tope ({toTopIds.length})
              </span>
              <span
                className={`px-2 py-1 rounded-lg font-bold ${
                  toBottomIds.length > 0
                    ? 'bg-purple-950 text-purple-300 border border-purple-700'
                    : 'bg-zinc-900 text-zinc-500'
                }`}
              >
                ⬇️ Fondo ({toBottomIds.length})
              </span>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                disabled={!canConfirm}
                onClick={handleConfirm}
                className={`flex-1 sm:flex-initial px-6 py-2.5 rounded-xl font-black text-xs uppercase tracking-wider transition ${
                  canConfirm
                    ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 shadow-lg shadow-amber-500/20 cursor-pointer'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                }`}
              >
                Confirmar y Aplicar
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // ACTIVACIÓN DE CARTAS DESDE EL CEMENTERIO (EXHUMAR / EFECTOS)
  // =========================================================

  const handleActivateGraveyardCard = async (card: any) => {
    const ab = String(card.ability || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const n = String(card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Gullinbursti: Desterrar de cementerio para convertir hasta 2 aliados en Bestias F2 sin habilidad
    if (n.includes('gullinbursti')) {
      setGraveyard((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
      addToBanished({ ...card, zone: 'BANISHED', isRested: false });
      const alliesInGrave = graveyard.filter((c: any) => c.instanceId !== card.instanceId && c.type === 'Aliado').slice(0, 2);
      if (alliesInGrave.length > 0) {
        const graveIds = alliesInGrave.map((c: any) => c.instanceId || c.id);
        setGraveyard((prev: any[]) => prev.filter((c: any) => !graveIds.includes(c.instanceId || c.id)));
        setDefenseZone((prev: any[]) => [
          ...prev,
          ...alliesInGrave.map((c: any) => ({
            ...c,
            type: 'Aliado',
            race: 'Bestia',
            strength: 2,
            ability: 'Bestia sin habilidad.',
            zone: 'DEFENSE',
            isRested: false,
            canAttack: false
          }))
        ]);
        alert(`¡Gullinbursti desterrado! ${alliesInGrave.length} Aliado(s) convertidos en Bestias F2 en tu Línea de Defensa.`);
      } else {
        alert('¡Gullinbursti desterrado del Cementerio!');
      }
      setShowGraveyard(false);
      return;
    }

    // Lobo de Muerte: Desterrar para botar 2 y dar +2 de Fuerza
    if (n.includes('lobo de muerte') || n.includes('lobo de la muerte')) {
      setGraveyard((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
      addToBanished({ ...card, zone: 'BANISHED', isRested: false });
      setCastleCards((prev: any[]) => {
        const milled = prev.slice(0, 2);
        setGraveyard((g: any[]) => [...(g || []), ...milled]);
        return prev.slice(2);
      });
      if (typeof setOpponentCastleCount === 'function') {
        setOpponentCastleCount((prev: number) => Math.max(0, prev - 2));
      }
      alert('¡Lobo de Muerte desterrado del Cementerio! Cada jugador bota 2 cartas y tus Aliados ganan +2 de Fuerza.');
      setShowGraveyard(false);
      return;
    }

    // Duelo Espacial: En Vigilia robar 1 carta
    if (n.includes('duelo espacial')) {
      drawCardByEffect();
      alert('¡Habilidad de Duelo Espacial activada desde Cementerio! Robaste 1 carta.');
      setShowGraveyard(false);
      return;
    }

    // Fantasma del Puente: En tu Vigilia barajar en Castillo
    if (n.includes('fantasma del puente') || n.includes('fantasma del puerto')) {
      setGraveyard((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
      setCastleCards((prev: any[]) => [...prev, { ...card, zone: 'CASTLE', isRested: false }].sort(() => Math.random() - 0.5));
      alert(`¡"Fantasma del Puente" barajado desde el Cementerio a tu Castillo!`);
      setShowGraveyard(false);
      return;
    }

    // Baile sobre el Puente: Pagar 2 Oros para poner en mano
    if (n.includes('baile sobre el puente')) {
      const availGold = goldZone.filter((g: any) => !g.isRested);
      if (availGold.length < 2) {
        alert('Necesitas al menos 2 Oros en Reserva para subir "Baile sobre el Puente" a tu mano.');
        return;
      }
      let paid = 0;
      setGoldZone((prev: any[]) =>
        prev.map((g: any) => {
          if (!g.isRested && paid < 2) {
            paid++;
            return { ...g, isRested: true };
          }
          return g;
        })
      );
      setGraveyard((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
      setHand((prev: any[]) => [...prev, { ...card, isRested: false }]);
      alert('¡Pagaste 2 Oros y subiste "Baile sobre el Puente" a tu mano!');
      setShowGraveyard(false);
      return;
    }

    // Wendy en Cementerio: Desterrar otro Aliado del Cementerio para subir Wendy a la mano
    if (n.includes('wendy')) {
      const otherAlliesInGrave = graveyard.filter((c: any) => c.instanceId !== card.instanceId && c.type === 'Aliado');
      if (otherAlliesInGrave.length === 0) {
        alert('No tienes otro Aliado en tu Cementerio para desterrar y recuperar a Wendy.');
        return;
      }
      const allyToBanish = otherAlliesInGrave[0];
      setGraveyard((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId && c.instanceId !== allyToBanish.instanceId));
      addToBanished({ ...allyToBanish, zone: 'BANISHED', isRested: false });
      setHand((prev: any[]) => [...prev, { ...card, zone: 'HAND', isRested: false }]);
      alert(`¡Desterraste a "${allyToBanish.name}" de tu Cementerio y recuperaste a Wendy en tu mano!`);
      setShowGraveyard(false);
      return;
    }

    // Drácula en Cementerio: Desterrar para cancelar el Ataque de hasta 2 Aliados
    if (n.includes('dracula')) {
      const wantCancelAttack = await showConfirm('Drácula', '¿Deseas Desterrar a Drácula de tu Cementerio para cancelar el Ataque de hasta dos Aliados?');
      if (wantCancelAttack) {
        setGraveyard((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
        addToBanished({ ...card, zone: 'BANISHED', isRested: false });
        if (opponentAttackZone && opponentAttackZone.length > 0) {
          setOpponentDefenseZone((prev: any[]) => [...(prev || []), ...opponentAttackZone.slice(0, 2)]);
          setOpponentAttackZone((prev: any[]) => prev.slice(2));
        }
        alert('¡Drácula desterrado del Cementerio! El ataque de hasta 2 Aliados oponentes fue cancelado.');
        setShowGraveyard(false);
        return;
      }
    }

    if (ab.includes('exhumar')) {
      let effectiveCost = getCardCost(card);
      const cardNorm = String(card.name || '').toLowerCase();
      if (cardNorm.includes('el monstruo') || (card.ability && card.ability.toLowerCase().includes('reduce su coste') && card.ability.toLowerCase().includes('descartes'))) {
        const beastAlliesInHand = hand.filter((c: any) =>
          c.type === 'Aliado' || c.race === 'Bestia' || (Array.isArray(c.races) && c.races.includes('Bestia')) || String(c.race || '').toLowerCase().includes('bestia')
        );

        if (beastAlliesInHand.length > 0 && effectiveCost > 1) {
          const maxPossibleDiscount = Math.min(beastAlliesInHand.length, effectiveCost - 1);
          const wantDiscount = await showConfirm(
            'El Monstruo - Exhumar',
            `¿Deseas descartar Aliados Bestia de tu mano para reducir su coste en 1 por cada uno? (Mínimo: 1 Oro)\n\nTienes ${beastAlliesInHand.length} Aliado(s) Bestia en mano.`
          );
          if (wantDiscount) {
            const promptCount = await showPrompt(
              'El Monstruo',
              `¿Cuántos Aliados Bestia deseas descartar? (1 a ${maxPossibleDiscount}):`,
              String(maxPossibleDiscount)
            );
            const countToDiscard = parseInt(promptCount || '0', 10);
            if (!isNaN(countToDiscard) && countToDiscard > 0) {
              const actualDiscount = Math.min(countToDiscard, maxPossibleDiscount);
              const beastsToDiscard = beastAlliesInHand.slice(0, actualDiscount);
              const bIds = beastsToDiscard.map((b: any) => b.instanceId);

              // Quitar de mano y mandar al Cementerio
              setHand((prev: any[]) => prev.filter((c: any) => !bIds.includes(c.instanceId)));
              setGraveyard((prev: any[]) => [
                ...(prev || []),
                ...beastsToDiscard.map((b: any) => ({ ...b, zone: 'GRAVEYARD', isRested: false }))
              ]);

              effectiveCost = Math.max(1, effectiveCost - actualDiscount);
              alert(`¡Descartaste ${actualDiscount} Aliado(s) Bestia! El coste de Exhumar se redujo a ${effectiveCost} Oro(s).`);
            }
          }
        }
      }

      const availGold = goldZone.filter((g: any) => !g.isRested);
      if (availGold.length < effectiveCost) {
        alert(`Necesitas al menos ${effectiveCost} Oro(s) en tu Reserva para Exhumar a "${card.name}".`);
        return;
      }

      let paid = 0;
      setGoldZone((prev: any[]) =>
        prev.map((g: any) => {
          if (!g.isRested && paid < effectiveCost) {
            paid++;
            return { ...g, isRested: true };
          }
          return g;
        })
      );
      setGraveyard((prev: any[]) =>
        prev.filter((c: any) => c.instanceId !== card.instanceId)
      );

      if (card.type === 'Talismán') {
        await executeCardAbility(card, true);
        addToBanished({ ...card, zone: 'BANISHED', isRested: false });
        alert(`¡Talismán "${card.name}" Exhumado, resuelto y Desterrado!`);
      } else if (card.type === 'Tótem') {
        setTotemZone((prev: any[]) => [
          ...prev,
          { ...card, zone: 'TOTEM', isRested: false }
        ]);
        alert(`¡Tótem "${card.name}" Exhumado con éxito y puesto en tu Línea de Tótems!`);
        await executeCardAbility(card, true);
      } else if (card.type === 'Arma') {
        const target = defenseZone.find((ally: any) => ally.type === 'Aliado');
        if (target) {
          setDefenseZone((prev: any[]) =>
            prev.map((ally: any) =>
              ally.instanceId === target.instanceId
                ? { ...ally, attachedWeapon: card }
                : ally
            )
          );
          alert(`¡Arma "${card.name}" Exhumada y portada a "${target.name}"!`);
        } else {
          setDefenseZone((prev: any[]) => [
            ...prev,
            { ...card, zone: 'DEFENSE', isRested: false, canAttack: false }
          ]);
          alert(`¡Arma "${card.name}" Exhumada con éxito!`);
        }
        await executeCardAbility(card, true);
      } else if (card.type === 'Oro') {
        setGoldZone((prev: any[]) => [
          ...prev,
          { ...card, zone: 'GOLD', isRested: false }
        ]);
        alert(`¡Oro "${card.name}" Exhumado a tu Zona de Oro!`);
        await executeCardAbility(card, true);
      } else {
        // Aliado
        setDefenseZone((prev: any[]) => [
          ...prev,
          { ...card, zone: 'DEFENSE', isRested: false, canAttack: false }
        ]);
        alert(`¡Aliado "${card.name}" Exhumado con éxito y puesto en tu Línea de Defensa!`);
        await executeCardAbility(card, true);
      }
      setShowGraveyard(false);
      return;
    }

    // Si la carta no tiene Exhumar ni habilidad explícita de Cementerio, no hacer nada
    alert(`La carta "${card.name}" no tiene ninguna habilidad activable desde el Cementerio.`);
    setShowGraveyard(false);
  };

  // =========================================================
  // ACTIVACIÓN DE CARTAS DESDE EL DESTIERRO (SACERDOTES / EFECTOS)
  // =========================================================

  const handleActivateBanishedCard = async (card: any) => {
    const n = String(card.name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    // Brujo de Salamanca en Destierro: Pagar 1 Oro para barajarlo en el Castillo y levantar prohibición
    if (n.includes('brujo de salamanca')) {
      const availGold = goldZone.find((g: any) => !g.isRested);
      if (!availGold) {
        alert('No tienes Oro disponible en tu Reserva para pagar el coste de 1 Oro.');
        return;
      }
      setGoldZone((prev: any[]) =>
        prev.map((g: any) =>
          g.instanceId === availGold.instanceId ? { ...g, isRested: true } : g
        )
      );
      setBanished((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
      setCastleCards((prev: any[]) =>
        [...prev, { ...card, zone: 'CASTLE', isRested: false }].sort(() => Math.random() - 0.5)
      );
      setNamedCards((prev: any[]) => prev.filter((nc: any) => nc.sourceCardName !== 'Brujo de Salamanca'));
      alert(`¡Brujo de Salamanca barajado en tu Castillo tras pagar 1 Oro! Su restricción de nombre ha quedado cancelada.`);
      setShowBanished(false);
      return;
    }

    // Cruzar el Bosque: Jugar desde destierro, barajar en Castillo y subir carta <= 2 o destruir hasta dos <= 1
    if (n.includes('cruzar el bosque') || (n.includes('cruzar') && n.includes('bosque'))) {
      const availGold = goldZone.find((g: any) => !g.isRested);
      if (!availGold) {
        alert('No tienes Oro en tu Reserva para pagar el coste de 1 Oro.');
        return;
      }
      setGoldZone((prev: any[]) =>
        prev.map((g: any) =>
          g.instanceId === availGold.instanceId ? { ...g, isRested: true } : g
        )
      );
      setBanished((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
      setCastleCards((prev: any[]) =>
        [...prev, { ...card, zone: 'CASTLE', isRested: false }].sort(() => Math.random() - 0.5)
      );

      const mode = await showChoice(
        'Cruzar el Bosque',
        'Elige el efecto a realizar:',
        [
          { label: 'Subir carta oponente ≤ 2 a su mano', value: true, icon: '✋' },
          { label: 'Destruir hasta 2 cartas de coste ≤ 1', value: false, icon: '💥' }
        ]
      );
      if (mode) {
        alert('¡Cruzar el Bosque jugado desde Destierro y barajado en Castillo! Carta de coste 2 o menos subida a la mano.');
      } else {
        alert('¡Cruzar el Bosque jugado desde Destierro y barajado en Castillo! Hasta dos cartas de coste 1 o menos destruidas.');
      }
      setShowBanished(false);
      return;
    }

    // Dr. Moreau: Pagar 1 oro para barajarlo
    if (n.includes('moreau')) {
      const availGold = goldZone.find((g: any) => !g.isRested);
      if (!availGold) {
        alert('No tienes Oro disponible en tu Reserva para pagar el coste de 1 Oro.');
        return;
      }
      setGoldZone((prev: any[]) =>
        prev.map((g: any) =>
          g.instanceId === availGold.instanceId ? { ...g, isRested: true } : g
        )
      );
      setBanished((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
      setCastleCards((prev: any[]) =>
        [...prev, { ...card, zone: 'CASTLE', isRested: false }].sort(() => Math.random() - 0.5)
      );
      alert(`¡Dr. Moreau barajado en tu Castillo tras pagar 1 Oro!`);
      setShowBanished(false);
      return;
    }

    // Dr. Frankenstein: Barajarlo en el castillo
    if (n.includes('frankenstein')) {
      setBanished((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
      setCastleCards((prev: any[]) =>
        [...prev, { ...card, zone: 'CASTLE', isRested: false }].sort(() => Math.random() - 0.5)
      );
      alert(`¡Dr. Frankenstein barajado en tu Castillo!`);
      setShowBanished(false);
      return;
    }

    // Mu: Jugar desde destierro reduciendo coste en 1
    if (n === 'mu') {
      const effectiveCost = Math.max(0, (Number(card.cost) || 1) - 1);
      const availGold = goldZone.filter((g: any) => !g.isRested);
      if (availGold.length < effectiveCost) {
        alert(
          `Necesitas ${effectiveCost} Oro(s) en tu Reserva para jugar a Mu desde el Destierro.`
        );
        return;
      }
      let paid = 0;
      setGoldZone((prev: any[]) =>
        prev.map((g: any) => {
          if (!g.isRested && paid < effectiveCost) {
            paid++;
            return { ...g, isRested: true };
          }
          return g;
        })
      );
      setBanished((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
      setDefenseZone((prev: any[]) => [
        ...prev,
        { ...card, zone: 'DEFENSE', isRested: false, canAttack: false }
      ]);
      alert(`¡Mu jugado desde el Destierro por coste reducido (${effectiveCost} Oro)!`);
      setShowBanished(false);
      return;
    }

    alert(`Habilidad de "${card.name}" en Destierro:\n${card.ability || 'Sin texto adicional.'}`);
  };

  // =========================================================
  // MODAL Y ACTIVACIÓN INTERACTIVA DE SANDRAUDIGA
  // =========================================================

  const handleActivateSandraudiga = async (sandraCard: any) => {
    const availGold = goldZone.find((g: any) => !g.isRested);
    if (!availGold) {
      alert('No tienes Oro disponible en tu Reserva para pagar el coste de 1 Oro.');
      return;
    }

    const otherSacerdotes = hand.filter(
      (c: any) =>
        c.instanceId !== sandraCard.instanceId &&
        (Array.isArray(c.races) ? c.races.includes('Sacerdote') : c.race === 'Sacerdote')
    );

    if (otherSacerdotes.length === 0) {
      alert('Necesitas tener otro Aliado Sacerdote en tu mano para desterrarlo junto a Sandraudiga.');
      return;
    }

    const oppHasP12 = (opponentGoldZone || []).some((g: any) => {
      const n = String(g.name || '').toLowerCase();
      return (n.includes('p-12') || n.includes('p12') || n.includes('terminal')) && !g.isRested;
    });
    if (oppHasP12) {
      alert('Terminal P-12 en la Reserva del oponente previene mirar su Mano o su Castillo.');
      return;
    }

    if (isMultiplayer) {
      sendGameAction({
        type: 'SANDRAUDIGA_ACTIVATE',
        sourceInstanceId: sandraCard.instanceId
      });
      return;
    }

    // Modo local / playtest
    const oppHandCards = [
      { instanceId: 'opp-c1', name: 'Relámpago Sagrado', type: 'Talismán', cost: 2, imageUrl: 'https://codicetcg.b-cdn.net/IMP/148_BES/148_050_relampago_sagrado.webp' },
      { instanceId: 'opp-c2', name: 'Escudo Sagrado', type: 'Arma', cost: 1, imageUrl: 'https://codicetcg.b-cdn.net/IMP/148_BES/148_045_escudo_sagrado.webp' },
      { instanceId: 'opp-c3', name: 'Tótem de Guerra', type: 'Tótem', cost: 2, imageUrl: 'https://codicetcg.b-cdn.net/IMP/148_BES/148_035_totem_de_guerra.webp' },
      { instanceId: 'opp-c4', name: 'Paladín Dorado', type: 'Aliado', cost: 2, imageUrl: 'https://codicetcg.b-cdn.net/IMP/148_BES/148_010_paladin_dorado.webp' },
      { instanceId: 'opp-c5', name: 'Oro Sagrado', type: 'Oro', cost: 0, imageUrl: 'https://codicetcg.b-cdn.net/IMP/148_BES/148_001_oro_sagrado.webp' }
    ];

    if (otherSacerdotes.length === 1) {
      setGoldZone((prev: any[]) =>
        prev.map((g: any) => (g.instanceId === availGold.instanceId ? { ...g, isRested: true } : g))
      );
      setHand((prev: any[]) =>
        prev.filter(
          (c: any) =>
            c.instanceId !== sandraCard.instanceId &&
            c.instanceId !== otherSacerdotes[0].instanceId
        )
      );
      addToBanished({ ...sandraCard, zone: 'BANISHED', isRested: false });
      addToBanished({ ...otherSacerdotes[0], zone: 'BANISHED', isRested: false });

      setSandraudigaModal({
        isOpen: true,
        sandraCard,
        sacerdotesInHand: otherSacerdotes,
        step: 'VIEW_OPPONENT_HAND',
        selectedSacerdoteId: otherSacerdotes[0].instanceId,
        opponentHandCards: oppHandCards
      });
    } else {
      setSandraudigaModal({
        isOpen: true,
        sandraCard,
        sacerdotesInHand: otherSacerdotes,
        step: 'SELECT_SACERDOTE',
        selectedSacerdoteId: null,
        opponentHandCards: oppHandCards
      });
    }
  };

  const renderSandraudigaModal = () => {
    if (!sandraudigaModal || !sandraudigaModal.isOpen) return null;

    const { sandraCard, sacerdotesInHand, step, opponentHandCards } = sandraudigaModal;

    const handleSelectSacerdote = (sacCard: any) => {
      const availGold = goldZone.find((g: any) => !g.isRested);
      if (availGold) {
        setGoldZone((prev: any[]) =>
          prev.map((g: any) => (g.instanceId === availGold.instanceId ? { ...g, isRested: true } : g))
        );
      }
      setHand((prev: any[]) =>
        prev.filter(
          (c: any) =>
            c.instanceId !== sandraCard.instanceId && c.instanceId !== sacCard.instanceId
        )
      );
      addToBanished({ ...sandraCard, zone: 'BANISHED', isRested: false });
      addToBanished({ ...sacCard, zone: 'BANISHED', isRested: false });

      setSandraudigaModal((prev) =>
        prev
          ? {
              ...prev,
              step: 'VIEW_OPPONENT_HAND',
              selectedSacerdoteId: sacCard.instanceId
            }
          : null
      );
    };

    const handleBanishOpponentCard = (oppCard: any) => {
      if (oppCard.type === 'Aliado' || oppCard.type === 'Oro') {
        alert('Solo puedes desterrar una carta que NO sea Aliado ni Oro (Talismán, Arma o Tótem).');
        return;
      }

      if (isMultiplayer) {
        sendGameAction({
          type: 'SANDRAUDIGA_BANISH_OPPONENT_CARD',
          targetInstanceId: oppCard.instanceId
        });
      } else {
        if (typeof setOpponentBanished === 'function') {
          setOpponentBanished((prev: any[]) => [...(prev || []), oppCard]);
        }
      }

      alert(`¡Sandraudiga! Has desterrado "${oppCard.name}" (${oppCard.type}) de la mano de tu oponente.`);
      setSandraudigaModal(null);
    };

    return (
      <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
        <div className="w-full max-w-2xl max-h-[92dvh] bg-[#130d0a] border-2 border-amber-500/80 rounded-2xl shadow-2xl p-3 sm:p-4 flex flex-col justify-between overflow-hidden safe-area-paddings">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-amber-800/40">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl">✨</span>
                <h2 className="text-xl font-black text-amber-300 uppercase tracking-wide">
                  Habilidad de Sandraudiga
                </h2>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                {step === 'SELECT_SACERDOTE'
                  ? 'Pagas 1 Oro y seleccionas otro Aliado Sacerdote de tu mano para desterrarlo junto a Sandraudiga.'
                  : 'Mano del oponente revelada. Selecciona 1 carta que NO sea Aliado ni Oro para desterrarla.'}
              </p>
            </div>
            <button
              onClick={() => setSandraudigaModal(null)}
              className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {step === 'SELECT_SACERDOTE' && (
              <div className="space-y-3">
                <span className="text-xs font-bold text-amber-400 block uppercase">
                  Elige el Sacerdote a desterrar de tu mano:
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {sacerdotesInHand.map((card: any, idx: number) => (
                    <div
                      key={`sac-${card.instanceId}-${idx}`}
                      onClick={() => handleSelectSacerdote(card)}
                      className="bg-zinc-950 rounded-2xl p-2 border-2 border-amber-700/50 hover:border-amber-400 hover:scale-105 transition-all cursor-pointer flex flex-col items-center shadow-lg"
                    >
                      <div className="w-full aspect-[2/3] rounded-xl overflow-hidden bg-black mb-2 flex items-center justify-center">
                        <img
                          src={card.imageUrl}
                          alt={card.name}
                          className="w-full h-full object-contain"
                        />
                      </div>
                      <span className="text-xs font-black text-amber-200 text-center line-clamp-1">
                        {card.name}
                      </span>
                      <span className="text-[10px] text-amber-500 font-bold mt-1">
                        Desterrar este Sacerdote
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {step === 'VIEW_OPPONENT_HAND' && (
              <div className="space-y-3">
                <span className="text-xs font-bold text-sky-400 block uppercase">
                  Mano del Oponente (Selecciona 1 Talismán, Arma o Tótem para desterrar):
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {opponentHandCards.map((card: any, idx: number) => {
                    const isBanishable = card.type !== 'Aliado' && card.type !== 'Oro';
                    return (
                      <div
                        key={`opp-hand-${card.instanceId || idx}`}
                        onClick={() => {
                          if (isBanishable) handleBanishOpponentCard(card);
                          else
                            alert(
                              'Esta carta es un ' +
                                card.type +
                                '. Sandraudiga solo puede desterrar cartas que NO sean Aliado ni Oro.'
                            );
                        }}
                        className={`relative rounded-2xl p-2 border-2 transition-all flex flex-col items-center ${
                          isBanishable
                            ? 'bg-zinc-950 border-rose-600/80 hover:border-rose-400 hover:scale-105 cursor-pointer shadow-lg shadow-rose-950/40'
                            : 'bg-zinc-900/50 border-zinc-800 opacity-60 cursor-not-allowed'
                        }`}
                      >
                        <div className="w-full aspect-[2/3] rounded-xl overflow-hidden bg-black mb-1.5 flex items-center justify-center">
                          {card.imageUrl ? (
                            <img
                              src={card.imageUrl}
                              alt={card.name}
                              className="w-full h-full object-contain"
                            />
                          ) : (
                            <span className="text-xs font-bold text-zinc-400">{card.name}</span>
                          )}
                        </div>
                        <span className="text-[11px] font-black text-zinc-200 text-center line-clamp-1">
                          {card.name}
                        </span>
                        <span
                          className={`text-[9px] font-black uppercase mt-1 px-1.5 py-0.5 rounded ${
                            isBanishable
                              ? 'bg-rose-950 text-rose-300 border border-rose-700/60'
                              : 'bg-zinc-800 text-zinc-500'
                          }`}
                        >
                          {card.type}
                        </span>
                        {isBanishable && (
                          <span className="text-[9px] text-rose-400 font-black mt-1">
                            💀 Desterrar
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // MODAL INTERACTIVO CAMILO HENRÍQUEZ (4 CARTAS: 2 DESTIERRO / 2 MANO)
  // =========================================================

  const renderCamiloHenriquezModal = () => {
    if (!camiloModal || !camiloModal.isOpen) return null;

    const { cards, toBanishIds, toHandIds } = camiloModal;

    const getDest = (cardId: string) => {
      if (toBanishIds.includes(cardId)) return 'BANISH';
      if (toHandIds.includes(cardId)) return 'HAND';
      return null;
    };

    const toggleDest = (cardId: string, dest: 'BANISH' | 'HAND') => {
      setCamiloModal((prev) => {
        if (!prev) return null;
        const newBanish = prev.toBanishIds.filter((id) => id !== cardId);
        const newHand = prev.toHandIds.filter((id) => id !== cardId);

        if (dest === 'BANISH') {
          if (newBanish.length < 2) newBanish.push(cardId);
          else {
            newBanish.shift();
            newBanish.push(cardId);
          }
        } else {
          if (newHand.length < 2) newHand.push(cardId);
          else {
            newHand.shift();
            newHand.push(cardId);
          }
        }

        return { ...prev, toBanishIds: newBanish, toHandIds: newHand };
      });
    };

    const canConfirm = toBanishIds.length === 2 && toHandIds.length === 2;

    const handleConfirm = () => {
      const cardsToBanish = toBanishIds
        .map((id) => cards.find((c: any) => (c.instanceId || c.id) === id))
        .filter(Boolean);
      const cardsToHand = toHandIds
        .map((id) => cards.find((c: any) => (c.instanceId || c.id) === id))
        .filter(Boolean);

      if (isMultiplayer) {
        sendGameAction({
          type: 'CAMILO_HENRIQUEZ_RESOLVE',
          toBanishInstanceIds: toBanishIds,
          toHandInstanceIds: toHandIds
        });
      } else {
        const cardIds = cards.map((c: any) => c.instanceId || c.id);
        const remainingCastle = castleCards.filter(
          (c: any) => !cardIds.includes(c.instanceId || c.id)
        );
        setCastleCards(remainingCastle);

        cardsToBanish.forEach((c: any) =>
          addToBanished({ ...c, zone: 'BANISHED', isRested: false })
        );
        cardsToHand.forEach((c: any) =>
          setHand((prev: any[]) => [...prev, { ...c, isRested: false }])
        );

        alert(`¡Camilo Henríquez resuelto!
• Destierro (2): ${cardsToBanish.map((c: any) => c.name).join(', ')}
• Mano (2): ${cardsToHand.map((c: any) => c.name).join(', ')}`);
      }

      setCamiloModal(null);
    };

    return (
      <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
        <div className="w-full max-w-3xl max-h-[92dvh] bg-[#120d08] border-2 border-amber-500 rounded-2xl shadow-2xl p-3 sm:p-4 flex flex-col justify-between overflow-hidden safe-area-paddings">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-amber-800/40">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl">📜</span>
                <h2 className="text-xl font-black text-amber-300 uppercase tracking-wide">
                  Camilo Henríquez
                </h2>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                Mira las primeras 4 cartas de tu Castillo. Selecciona exactamente{' '}
                <strong className="text-purple-400">2 cartas para tu Destierro</strong> y{' '}
                <strong className="text-emerald-400">2 cartas para tu Mano</strong>.
              </p>
            </div>
            <button
              onClick={() => setCamiloModal(null)}
              className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {cards.map((card: any, idx: number) => {
                const cId = card.instanceId || card.id || `camilo-c-${idx}`;
                const dest = getDest(cId);

                return (
                  <div
                    key={`camilo-${cId}-${idx}`}
                    className={`relative bg-zinc-950 rounded-2xl p-2.5 border-2 transition-all flex flex-col items-center ${
                      dest === 'BANISH'
                        ? 'border-purple-500 shadow-lg shadow-purple-500/20 bg-purple-950/20'
                        : dest === 'HAND'
                        ? 'border-emerald-500 shadow-lg shadow-emerald-500/20 bg-emerald-950/20'
                        : 'border-zinc-800 hover:border-amber-500/50'
                    }`}
                  >
                    <div className="w-full aspect-[2/3] rounded-xl overflow-hidden bg-black mb-2 flex items-center justify-center">
                      <img
                        src={card.imageUrl}
                        alt={card.name}
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <span className="text-xs font-black text-amber-200 text-center line-clamp-1 mb-2">
                      {card.name}
                    </span>

                    <div className="w-full grid grid-cols-2 gap-1.5 mt-auto">
                      <button
                        onClick={() => toggleDest(cId, 'BANISH')}
                        className={`py-1.5 px-1 rounded-xl text-[10px] font-black uppercase transition ${
                          dest === 'BANISH'
                            ? 'bg-purple-600 text-white shadow'
                            : 'bg-purple-950/80 text-purple-300 border border-purple-700/60 hover:bg-purple-800'
                        }`}
                      >
                        💀 Destierro
                      </button>

                      <button
                        onClick={() => toggleDest(cId, 'HAND')}
                        className={`py-1.5 px-1 rounded-xl text-[10px] font-black uppercase transition ${
                          dest === 'HAND'
                            ? 'bg-emerald-500 text-black shadow'
                            : 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 hover:bg-emerald-800'
                        }`}
                      >
                        🖐️ Mano
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-zinc-800 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-xs">
              <span
                className={`px-3 py-1.5 rounded-xl font-bold ${
                  toBanishIds.length === 2
                    ? 'bg-purple-950 text-purple-300 border border-purple-600'
                    : 'bg-zinc-900 text-zinc-400'
                }`}
              >
                💀 Al Destierro: {toBanishIds.length}/2
              </span>
              <span
                className={`px-3 py-1.5 rounded-xl font-bold ${
                  toHandIds.length === 2
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-600'
                    : 'bg-zinc-900 text-zinc-400'
                }`}
              >
                🖐️ A la Mano: {toHandIds.length}/2
              </span>
            </div>

            <button
              disabled={!canConfirm}
              onClick={handleConfirm}
              className={`px-8 py-2.5 rounded-xl font-black text-xs uppercase tracking-wider transition ${
                canConfirm
                  ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 shadow-lg shadow-amber-500/20 cursor-pointer'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
              }`}
            >
              Confirmar y Aplicar
            </button>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // ANIMACIÓN VISUAL DE ROBO DE CARTA
  // =========================================================

  const renderDrawCardAnimation = () => {
    if (!drawnCardAnim || !drawnCardAnim.cards || drawnCardAnim.cards.length === 0) return null;

    return (
      <div className="fixed inset-0 pointer-events-none z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-[4px] transition-all duration-300">
        <div className="relative flex flex-col items-center anim-card-draw max-w-4xl px-4">
          {/* Resplandor radial místico */}
          <div className="absolute -inset-20 bg-[radial-gradient(circle,_rgba(245,158,11,0.5)_0%,_transparent_70%)] blur-3xl rounded-full pointer-events-none" />
          
          <div className="flex items-center justify-center gap-4 flex-wrap z-10">
            {drawnCardAnim.cards.map((c: any, idx: number) => (
              <div
                key={`drawn-anim-card-${c.instanceId || c.id || idx}`}
                className="relative w-36 sm:w-44 h-52 sm:h-64 rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(245,158,11,0.9)] border-2 border-amber-400/90 bg-gradient-to-b from-zinc-900 to-black p-1.5 foil-card-effect transition-transform hover:scale-105"
              >
                {c.imageUrl ? (
                  <img
                    src={c.imageUrl}
                    alt={c.name || 'Carta'}
                    className="w-full h-full object-contain rounded-xl"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center font-black text-amber-300 text-sm text-center p-2">
                    {c.name || 'Carta'}
                  </div>
                )}
                <div className="absolute top-2 left-2 bg-black/80 border border-amber-400/80 text-amber-300 text-[10px] font-black px-2 py-0.5 rounded-full shadow">
                  #{idx + 1}
                </div>
              </div>
            ))}
          </div>

          <span className="mt-4 px-6 py-2.5 glass-panel-golden text-amber-200 text-xs sm:text-sm font-black rounded-full shadow-[0_0_35px_rgba(245,158,11,0.6)] tracking-wide flex items-center gap-2 z-10">
            <span className="text-amber-400 text-base animate-pulse">✨</span>
            Robaste {drawnCardAnim.count} carta{drawnCardAnim.count > 1 ? 's' : ''}:{' '}
            <strong className="text-amber-100 uppercase">
              {drawnCardAnim.cards.map((c: any) => c.name || 'Carta').join(' • ')}
            </strong>
          </span>
        </div>
      </div>
    );
  };

  // =========================================================
  // MODAL INTERACTIVO LANZA ARGENTA (BARAJAR 3 CARTAS AL CAER AL CEMENTERIO)
  // =========================================================

  const renderLanzaArgentaModal = () => {
    if (!lanzaArgentaModal || !lanzaArgentaModal.isOpen) return null;

    const { sourceCard, cemeteryCards, selectedIds } = lanzaArgentaModal;

    const toggleSelect = (id: string) => {
      setLanzaArgentaModal((prev) => {
        if (!prev) return null;
        if (prev.selectedIds.includes(id)) {
          return { ...prev, selectedIds: prev.selectedIds.filter((x) => x !== id) };
        }
        if (prev.selectedIds.length >= 2) {
          return { ...prev, selectedIds: [...prev.selectedIds.slice(1), id] };
        }
        return { ...prev, selectedIds: [...prev.selectedIds, id] };
      });
    };

    const handleConfirm = () => {
      const extraCards = cemeteryCards.filter((c: any) =>
        selectedIds.includes(c.instanceId || c.id)
      );
      const allToShuffle = [sourceCard, ...extraCards];
      const allIds = allToShuffle.map((c: any) => c.instanceId || c.id);

      if (isMultiplayer) {
        sendGameAction({
          type: 'LANZA_ARGENTA_RESOLVE',
          sourceInstanceId: sourceCard.instanceId,
          targetInstanceIds: selectedIds
        });
      } else {
        setGraveyard((prev: any[]) =>
          prev.filter((c: any) => !allIds.includes(c.instanceId || c.id))
        );
        setCastleCards((prev: any[]) =>
          [...prev, ...allToShuffle.map((c: any) => ({ ...c, zone: 'CASTLE', isRested: false }))].sort(
            () => Math.random() - 0.5
          )
        );
        alert(
          `¡${sourceCard.name} resuelto! Se barajó ${sourceCard.name} y ${extraCards.length} carta(s) en tu Castillo.`
        );
      }

      setLanzaArgentaModal(null);
    };

    return (
      <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
        <div className="w-full max-w-3xl bg-[#120e0d] border-2 border-amber-500 rounded-3xl shadow-2xl p-6 flex flex-col max-h-[85vh]">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-amber-800/40">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl">🗡️</span>
                <h2 className="text-xl font-black text-amber-300 uppercase tracking-wide">
                  {sourceCard.name || 'Lanza Argenta'}
                </h2>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                Al ser puesta en el Cementerio: Selecciona hasta{' '}
                <strong className="text-amber-400">2 cartas adicionales</strong> de tu Cementerio para barajar junto con esta carta en tu Castillo.
              </p>
            </div>
            <button
              onClick={() => setLanzaArgentaModal(null)}
              className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {cemeteryCards.length === 0 ? (
              <div className="py-12 text-center text-zinc-500 font-bold">
                No hay otras cartas en tu Cementerio. Se barajará solo {sourceCard.name}.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {cemeteryCards.map((card: any, idx: number) => {
                  const cId = card.instanceId || card.id || `cemetery-${idx}`;
                  const isSelected = selectedIds.includes(cId);

                  return (
                    <div
                      key={`lanza-${cId}-${idx}`}
                      onClick={() => toggleSelect(cId)}
                      className={`relative bg-zinc-950 rounded-2xl p-2 border-2 transition-all cursor-pointer flex flex-col items-center ${
                        isSelected
                          ? 'border-amber-400 bg-amber-950/30 scale-105 shadow-lg shadow-amber-500/20'
                          : 'border-zinc-800 hover:border-amber-700/50'
                      }`}
                    >
                      <div className="w-full aspect-[2/3] rounded-xl overflow-hidden bg-black mb-1.5 flex items-center justify-center">
                        <img src={card.imageUrl} alt={card.name} className="w-full h-full object-contain" />
                      </div>
                      <span className="text-[11px] font-black text-amber-200 text-center line-clamp-1">
                        {card.name}
                      </span>
                      <span
                        className={`text-[9px] font-bold mt-1 ${
                          isSelected ? 'text-amber-400' : 'text-zinc-500'
                        }`}
                      >
                        {isSelected ? '✓ Seleccionada' : 'Seleccionar'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-zinc-800 flex items-center justify-between">
            <span className="text-xs text-zinc-400 font-semibold">
              Cartas seleccionadas:{' '}
              <strong className="text-amber-400">{selectedIds.length}/2</strong> (+{' '}
              {sourceCard.name})
            </span>
            <button
              onClick={handleConfirm}
              className="px-8 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-lg shadow-amber-500/20 transition"
            >
              Barajar en Castillo
            </button>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // PROMPT RESPUESTA COLAPSO GLOBAL
  // =========================================================

  const renderColapsoPrompt = () => {
    if (!colapsoPrompt || !colapsoPrompt.isOpen) return null;

    const { reason, colapsoCard } = colapsoPrompt;

    const handlePlayColapso = (mode: 'PAY_GOLD' | 'BANISH_HAND') => {
      if (mode === 'PAY_GOLD') {
        const availGold = goldZone.find((g: any) => !g.isRested);
        if (!availGold) {
          alert('No tienes Oro disponible en tu Reserva.');
          return;
        }
        setGoldZone((prev: any[]) =>
          prev.map((g: any) =>
            g.instanceId === availGold.instanceId ? { ...g, isRested: true } : g
          )
        );
      } else {
        const otherInHand = hand.filter(
          (c: any) =>
            (c.instanceId || c.id) !== (colapsoCard.instanceId || colapsoCard.id)
        );
        if (otherInHand.length === 0) {
          alert('No tienes otra carta en tu mano para desterrar.');
          return;
        }
        const toBanish = otherInHand[0];
        setHand((prev: any[]) =>
          prev.filter((c: any) => (c.instanceId || c.id) !== (toBanish.instanceId || toBanish.id))
        );
        addToBanished({ ...toBanish, zone: 'BANISHED', isRested: false });
      }

      // Remover Colapso de la mano
      setHand((prev: any[]) =>
        prev.filter((c: any) => (c.instanceId || c.id) !== (colapsoCard.instanceId || colapsoCard.id))
      );
      addToGraveyard(colapsoCard);

      // Robar 1 carta
      drawCardByEffect();

      if (isMultiplayer) {
        sendGameAction({
          type: 'COLAPSO_GLOBAL_RESPONSE',
          sourceInstanceId: colapsoCard.instanceId
        });
      }

      alert('¡Colapso Global jugado en respuesta! Efecto oponente cancelado y robaste 1 carta.');
      setColapsoPrompt(null);
    };

    return (
      <div className="fixed inset-0 z-[10001] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-[#140e0c] border-2 border-rose-500 rounded-3xl shadow-2xl p-6 flex flex-col">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-2xl">⚡</span>
            <h2 className="text-xl font-black text-rose-400 uppercase tracking-wide">
              Respuesta: Colapso Global
            </h2>
          </div>
          <p className="text-xs text-zinc-300 leading-relaxed mb-4">
            El oponente intentó <strong className="text-amber-400">{reason}</strong>. Puedes jugar{' '}
            <strong>Colapso Global</strong> desde tu mano para cancelar ese efecto y robar 1 carta.
          </p>

          <div className="flex flex-col gap-2.5">
            <button
              onClick={() => handlePlayColapso('BANISH_HAND')}
              className="py-3 bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white rounded-xl font-black text-xs uppercase tracking-wider transition shadow-lg shadow-rose-600/20"
            >
              💀 Desterrar 1 de Mano → Jugar Gratis y Robar 1
            </button>
            <button
              onClick={() => handlePlayColapso('PAY_GOLD')}
              className="py-3 bg-zinc-800 hover:bg-zinc-700 text-amber-300 border border-amber-500/40 rounded-xl font-black text-xs uppercase tracking-wider transition"
            >
              💰 Pagar 1 Oro → Jugar y Robar 1
            </button>
            <button
              onClick={() => setColapsoPrompt(null)}
              className="py-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 rounded-xl font-bold text-xs uppercase transition mt-1"
            >
              ❌ No Responder / Pasar
            </button>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // MODAL INTERACTIVO CUERVO NOCTURNO (HABILIDAD DE MANO)
  // =========================================================

  const handleCuervoNocturnoHandAbility = (cuervoCard: any) => {
    const otherCards = hand.filter((c: any) => c.instanceId !== cuervoCard.instanceId);
    if (otherCards.length === 0) {
      alert('Necesitas tener al menos otra carta en tu mano para poner en el fondo de tu Castillo junto a Cuervo Nocturno.');
      return;
    }

    setHoveredCard(null);
    setPreviewVisible(false);
    setCuervoModal({
      isOpen: true,
      cuervoCard,
      selectedOtherId: otherCards[0]?.instanceId || null
    });
  };

  const renderCuervoNocturnoModal = () => {
    if (!cuervoModal || !cuervoModal.isOpen) return null;

    const { cuervoCard, selectedOtherId } = cuervoModal;
    const otherCards = hand.filter((c: any) => c.instanceId !== cuervoCard.instanceId);

    const handleConfirm = () => {
      const otherCard = otherCards.find((c: any) => c.instanceId === selectedOtherId);
      if (!otherCard) {
        alert('Selecciona una carta de tu mano.');
        return;
      }

      if (isMultiplayer) {
        sendGameAction({
          type: 'CUERVO_NOCTURNO_HAND_RESOLVE',
          cuervoInstanceId: cuervoCard.instanceId,
          otherInstanceId: otherCard.instanceId
        });
      } else {
        setHand((prev: any[]) =>
          prev.filter(
            (c: any) =>
              c.instanceId !== cuervoCard.instanceId &&
              c.instanceId !== otherCard.instanceId
          )
        );
        setCastleCards((prev: any[]) => [
          ...prev,
          { ...cuervoCard, zone: 'CASTLE', isRested: false },
          { ...otherCard, zone: 'CASTLE', isRested: false }
        ]);
        drawCardByEffect();
        drawCardByEffect();
        alert(`¡Cuervo Nocturno y "${otherCard.name}" fueron colocados en el fondo de tu Castillo! Robaste 2 cartas.`);
      }

      setCuervoModal(null);
    };

    return (
      <div className="fixed inset-0 z-[10000] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
        <div className="w-full max-w-2xl bg-[#120d08] border-2 border-indigo-500 rounded-3xl shadow-2xl p-6 flex flex-col max-h-[85vh]">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-indigo-800/40">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🦅</span>
              <div>
                <h2 className="text-xl font-black text-indigo-300 uppercase tracking-wide">
                  Habilidad de Mano: Cuervo Nocturno
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Selecciona 1 otra carta de tu mano para poner ambas en el fondo de tu Castillo y Robar 2 cartas.
                </p>
              </div>
            </div>
            <button
              onClick={() => setCuervoModal(null)}
              className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            <span className="text-[10px] font-black uppercase text-indigo-400 block mb-2">
              Cartas en Mano (Elige 1):
            </span>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
              {otherCards.map((c: any) => {
                const isSelected = c.instanceId === selectedOtherId;
                return (
                  <div
                    key={c.instanceId || c.id}
                    onClick={() =>
                      setCuervoModal((prev) =>
                        prev ? { ...prev, selectedOtherId: c.instanceId } : null
                      )
                    }
                    className={`relative rounded-xl overflow-hidden cursor-pointer border-2 transition ${
                      isSelected
                        ? 'border-indigo-400 ring-2 ring-indigo-500 scale-105 shadow-xl'
                        : 'border-zinc-800 hover:border-zinc-600 opacity-75 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={c.imageUrl}
                      alt={c.name}
                      className="w-full h-32 object-contain bg-black"
                    />
                    <div className="p-1.5 bg-zinc-950/90 text-center border-t border-zinc-800">
                      <span className="text-[9px] font-bold text-zinc-200 block truncate">
                        {c.name}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex gap-3 mt-4 pt-3 border-t border-indigo-900/40">
            <button
              onClick={handleConfirm}
              disabled={!selectedOtherId}
              className="flex-1 py-3 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 disabled:opacity-50 text-white rounded-xl font-black text-xs uppercase tracking-wider transition shadow-lg shadow-indigo-600/20"
            >
              🦅 Poner al Fondo de Castillo y Robar 2 Cartas
            </button>
            <button
              onClick={() => setCuervoModal(null)}
              className="py-3 px-5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl font-bold text-xs uppercase transition"
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // MODAL DE ESCARAPELA NACIONAL
  // =========================================================

  const renderEscarapelaModal = () => {
    if (!showEscarapelaModal) return null;

    return (
      <div className="fixed inset-0 z-[9998] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-[#0b141e] border-2 border-sky-500/80 rounded-2xl shadow-2xl p-6 flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-200">
          
          <div className="w-12 h-12 rounded-2xl bg-sky-950/80 border border-sky-400 flex items-center justify-center mb-3 text-2xl shadow-lg shadow-sky-500/20">
            🇦🇷
          </div>

          <h2 className="text-xl font-black text-sky-300 uppercase tracking-wide">
            Escarapela Nacional
          </h2>

          <p className="text-xs text-zinc-400 mt-1 max-w-sm">
            Efecto al Entrar en Juego. Elige una de las dos opciones para resolver:
          </p>

          {/* Imagen de la carta */}
          <div className="my-5 w-36 h-52 rounded-xl overflow-hidden border-2 border-sky-400/60 shadow-xl shadow-sky-900/40">
            <img
              src={showEscarapelaModal.imageUrl || '/images/card-back.jpg'}
              alt="Escarapela Nacional"
              className="w-full h-full object-cover"
            />
          </div>

          {/* Opciones */}
          <div className="w-full flex flex-col gap-3">
            <button
              onClick={() => {
                setShowEscarapelaModal(null);
                const d1 = drawCardByEffect();
                const d2 = drawCardByEffect();
                alert(`¡Escarapela Nacional resuelta! Robaste 2 cartas (${d1?.name || 'Carta'}, ${d2?.name || 'Carta'}).`);
              }}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-amber-100 rounded-xl font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 transition shadow-lg shadow-amber-950/40 hover:scale-[1.02]"
            >
              <span>🎴</span>
              <span>ROBAR 2 CARTAS</span>
            </button>

            <button
              onClick={() => {
                setShowEscarapelaModal(null);
                void (async () => {
                  if (castleCards.length === 0) {
                    alert('Tu Castillo está vacío.');
                    return;
                  }
                  const selected = await openCastleSearch({ type: 'Aliado,Oro' });
                  if (selected) {
                    setHand((prev: any[]) => [...prev, { ...selected, zone: 'HAND', isRested: false }]);
                    alert(`¡Buscaste "${selected.name}" en tu Castillo, lo pusiste en tu mano y barajaste el mazo!`);
                  }
                })();
              }}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-sky-600 to-blue-700 hover:from-sky-500 hover:to-blue-600 text-sky-100 rounded-xl font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 transition shadow-lg shadow-sky-950/40 hover:scale-[1.02]"
            >
              <span>🔍</span>
              <span>BUSCAR ALIADO U ORO EN CASTILLO</span>
            </button>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // MODAL INTERACTIVO PULSO KAIJU
  // "Busca en tu Castillo tres Aliados de diferente nombre.
  // Pon uno en tu mano, dos en tu Cementerio y Roba una carta."
  // =========================================================

  const renderPulsoKaijuModal = () => {
    if (!pulsoKaijuModal || !pulsoKaijuModal.isOpen) return null;

    const { allies, toHandId, toGraveIds } = pulsoKaijuModal;

    const toggleHand = (cardId: string) => {
      setPulsoKaijuModal((prev) => {
        if (!prev) return null;
        if (prev.toHandId === cardId) {
          return { ...prev, toHandId: null };
        }
        const newGrave = prev.toGraveIds.filter((id) => id !== cardId);
        return { ...prev, toHandId: cardId, toGraveIds: newGrave };
      });
    };

    const toggleGrave = (cardId: string) => {
      setPulsoKaijuModal((prev) => {
        if (!prev) return null;
        const newHand = prev.toHandId === cardId ? null : prev.toHandId;
        if (prev.toGraveIds.includes(cardId)) {
          return { ...prev, toHandId: newHand, toGraveIds: prev.toGraveIds.filter((id) => id !== cardId) };
        }
        if (prev.toGraveIds.length >= 2) {
          alert('Solo puedes enviar hasta 2 Aliados al Cementerio.');
          return prev;
        }
        return { ...prev, toHandId: newHand, toGraveIds: [...prev.toGraveIds, cardId] };
      });
    };

    const canConfirm = Boolean(toHandId) && (toGraveIds.length >= Math.min(2, Math.max(0, allies.length - 1)));

    const handleConfirm = () => {
      if (!toHandId) {
        alert('Debes seleccionar 1 Aliado para poner en tu mano.');
        return;
      }

      const handCard = allies.find((c: any) => (c.instanceId || c.id) === toHandId);
      const graveCards = allies.filter((c: any) => toGraveIds.includes(c.instanceId || c.id));

      const idsToRemove = [toHandId, ...toGraveIds];

      // Quitar exactamente las instancias seleccionadas del castillo
      setCastleCards((prev: any[]) => {
        const remainingToRemove = [...idsToRemove];
        return prev.filter((c: any) => {
          const matchIdx = remainingToRemove.findIndex(
            (id) => (c.instanceId && c.instanceId === id) || (!c.instanceId && c.id === id)
          );
          if (matchIdx !== -1) {
            remainingToRemove.splice(matchIdx, 1);
            return false;
          }
          return true;
        });
      });

      // Poner 1 en mano
      if (handCard) {
        setHand((prev: any[]) => [...prev, { ...handCard, zone: 'HAND', isRested: false }]);
      }

      // Poner 2 en Cementerio
      if (graveCards.length > 0) {
        setGraveyard((prev: any[]) => [...(prev || []), ...graveCards.map((c: any) => ({ ...c, zone: 'GRAVEYARD', isRested: false }))]);
      }

      // Barajar castillo con animación
      shuffleCastleWithAnim();

      // Robar 1 carta
      const drawn = drawCardByEffect();

      alert(`¡Pulso Kaiju resuelto con éxito!
• A tu Mano: ${handCard?.name || 'Ninguno'}
• Al Cementerio (${graveCards.length}): ${graveCards.map((c: any) => c.name).join(', ') || 'Ninguno'}
• Castillo Barajado y Robaste 1 carta (${drawn?.name || 'Carta'}).`);

      setPulsoKaijuModal(null);
    };

    return (
      <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
        <div className="w-full max-w-4xl bg-[#0e1713] border-2 border-emerald-500/80 rounded-3xl shadow-2xl p-6 flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-emerald-900/40">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl">⚡🦖</span>
                <h2 className="text-xl font-black text-emerald-300 uppercase tracking-wide">
                  Pulso Kaiju
                </h2>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                Busca 3 Aliados de diferente nombre en tu Castillo. Selecciona exactamente{' '}
                <strong className="text-emerald-400">1 para tu Mano</strong> y{' '}
                <strong className="text-red-400">hasta 2 para tu Cementerio</strong>. Luego barajas y robas 1 carta.
              </p>
            </div>
            <button
              onClick={() => setPulsoKaijuModal(null)}
              className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {allies.length === 0 ? (
              <div className="text-center py-12 text-zinc-500 font-bold">
                No hay Aliados en tu Castillo.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {allies.map((card: any, idx: number) => {
                  const cId = card.instanceId || card.id || `ally-${idx}`;
                  const isHand = toHandId === cId;
                  const isGrave = toGraveIds.includes(cId);

                  return (
                    <div
                      key={`pulso-ally-${cId}-${idx}`}
                      className={`relative bg-zinc-950 rounded-2xl p-2 border-2 transition-all flex flex-col items-center ${
                        isHand
                          ? 'border-emerald-400 shadow-lg shadow-emerald-500/30 bg-emerald-950/30'
                          : isGrave
                          ? 'border-red-500 shadow-lg shadow-red-500/30 bg-red-950/30'
                          : 'border-zinc-800 hover:border-emerald-500/40'
                      }`}
                    >
                      <div className="w-full aspect-[2/3] rounded-xl overflow-hidden bg-black mb-2 flex items-center justify-center">
                        <img
                          src={card.imageUrl || '/images/card-back.jpg'}
                          alt={card.name}
                          className="w-full h-full object-contain"
                        />
                      </div>
                      <span className="text-xs font-black text-emerald-200 text-center line-clamp-1 mb-1">
                        {card.name}
                      </span>
                      <span className="text-[10px] text-zinc-400 mb-2">
                        Coste: {card.cost} | F: {card.strength}
                      </span>

                      <div className="w-full grid grid-cols-2 gap-1 mt-auto">
                        <button
                          onClick={() => toggleHand(cId)}
                          className={`py-1.5 px-1 rounded-lg text-[10px] font-black uppercase transition ${
                            isHand
                              ? 'bg-emerald-500 text-black shadow-md shadow-emerald-500/40 font-black'
                              : 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 hover:bg-emerald-800'
                          }`}
                        >
                          🖐️ Mano
                        </button>
                        <button
                          onClick={() => toggleGrave(cId)}
                          className={`py-1.5 px-1 rounded-lg text-[10px] font-black uppercase transition ${
                            isGrave
                              ? 'bg-red-500 text-white shadow-md shadow-red-500/40 font-black'
                              : 'bg-red-950/80 text-red-300 border border-red-700/60 hover:bg-red-800'
                          }`}
                        >
                          💀 Cementerio
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-zinc-800 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-xs">
              <span className={`px-2.5 py-1 rounded-lg font-bold ${toHandId ? 'bg-emerald-950 text-emerald-300 border border-emerald-600' : 'bg-zinc-900 text-zinc-500'}`}>
                🖐️ Mano: {toHandId ? '1 / 1' : '0 / 1'}
              </span>
              <span className={`px-2.5 py-1 rounded-lg font-bold ${toGraveIds.length > 0 ? 'bg-red-950 text-red-300 border border-red-600' : 'bg-zinc-900 text-zinc-500'}`}>
                💀 Cementerio: {toGraveIds.length} / 2
              </span>
            </div>

            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="py-3 px-6 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl font-black text-xs uppercase tracking-wider transition shadow-lg shadow-emerald-900/40"
            >
              ✅ Confirmar Selección y Robar 1 Carta
            </button>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // MODAL INTERACTIVO DE SELECCIÓN DE CARTAS EN MANO
  // (Kaitai, Trono del Dragón, etc.)
  // =========================================================
  const renderHandSelectionModal = () => {
    if (!handSelectionModal || !handSelectionModal.isOpen) return null;

    const { title, subtitle, requiredCount, actionType, selectedCardIds, onConfirm } = handSelectionModal;

    const toggleSelect = (instanceId: string) => {
      setHandSelectionModal((prev) => {
        if (!prev) return null;
        if (prev.selectedCardIds.includes(instanceId)) {
          return { ...prev, selectedCardIds: prev.selectedCardIds.filter((id) => id !== instanceId) };
        }
        if (prev.selectedCardIds.length >= requiredCount) {
          return { ...prev, selectedCardIds: [...prev.selectedCardIds.slice(1), instanceId] };
        }
        return { ...prev, selectedCardIds: [...prev.selectedCardIds, instanceId] };
      });
    };

    const isConfirmDisabled = selectedCardIds.length < Math.min(requiredCount, hand.length);

    return (
      <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
        <div className="w-full max-w-2xl bg-[#0c131c] border-2 border-amber-500/80 rounded-3xl shadow-2xl p-6 flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between pb-3 border-b border-amber-900/40 mb-3">
            <div>
              <h3 className="text-lg font-black uppercase text-amber-300 tracking-wide">{title}</h3>
              <p className="text-xs text-zinc-400 mt-0.5">{subtitle}</p>
            </div>
            <span className="text-xs font-black px-2.5 py-1 rounded-full bg-amber-950 text-amber-400 border border-amber-700">
              {selectedCardIds.length} / {Math.min(requiredCount, hand.length)}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {hand.length === 0 ? (
              <div className="h-40 flex items-center justify-center">
                <p className="text-zinc-500 text-sm">No tienes cartas en mano.</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {hand.map((c: any) => {
                  const isSelected = selectedCardIds.includes(c.instanceId);
                  return (
                    <div
                      key={c.instanceId}
                      onClick={() => toggleSelect(c.instanceId)}
                      className={`relative aspect-[2/3] rounded-xl overflow-hidden border-2 cursor-pointer transition-all ${
                        isSelected
                          ? actionType === 'DISCARD'
                            ? 'border-red-500 ring-4 ring-red-500/50 scale-105 shadow-xl shadow-red-950'
                            : 'border-blue-500 ring-4 ring-blue-500/50 scale-105 shadow-xl shadow-blue-950'
                          : 'border-zinc-800 hover:border-amber-500/50'
                      }`}
                    >
                      {c.imageUrl ? (
                        <img src={c.imageUrl} alt={c.name} className="w-full h-full object-contain" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center p-1 bg-zinc-900">
                          <span className="text-[9px] text-amber-300 font-bold text-center">{c.name}</span>
                        </div>
                      )}
                      <div className="absolute bottom-0 inset-x-0 bg-black/80 p-1 text-center">
                        <span className="text-[9px] font-bold text-amber-200 line-clamp-1">{c.name}</span>
                      </div>
                      {isSelected && (
                        <div className={`absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-black ${
                          actionType === 'DISCARD' ? 'bg-red-600' : 'bg-blue-600'
                        }`}>
                          ✓
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-zinc-800 mt-3 flex justify-end">
            <button
              disabled={isConfirmDisabled}
              onClick={() => {
                const chosen = hand.filter((c: any) => selectedCardIds.includes(c.instanceId));
                onConfirm(chosen);
                setHandSelectionModal(null);
              }}
              className="py-3 px-6 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-amber-100 font-black text-xs uppercase tracking-wider rounded-xl transition shadow-lg shadow-amber-950/40"
            >
              Confirmar ({selectedCardIds.length}/{Math.min(requiredCount, hand.length)})
            </button>
          </div>
        </div>
      </div>
    );
  };

  // =========================================================
  // ROBO FASE FINAL
  // =========================================================

  const drawCardAtFinalPhase = () => {
    if (hasDrawnThisFinal) return;

    const firstPlayerNoDraw = turn === 1 && playerGoesFirst;
    if (firstPlayerNoDraw) {
      setHasDrawnThisFinal(true);
      return;
    }

    const currentCastle = castleCardsRef.current || castleCards || [];
    if (currentCastle.length === 0) {
      setHasDrawnThisFinal(true);
      alert('Castillo agotado. ¡Has perdido la partida por quedarte sin cartas en tu Castillo!');
      return;
    }

    const drawn = currentCastle[0];
    const remainingCastle = currentCastle.slice(1);
    castleCardsRef.current = remainingCastle;
    setHasDrawnThisFinal(true);
    setCastleCards(remainingCastle);

    setHand((prev: any[]) => {
      const nextHand = [...prev, drawn];
      if (nextHand.length > 8) {
        setTimeout(() => {
          setHand((currentHand: any[]) => {
            if (currentHand.length > 8) {
              const excess = currentHand.length - 8;
              const cardsToKeep = currentHand.slice(0, 8);
              const discarded = currentHand.slice(8);
              setGraveyard((g: any[]) => [...(g || []), ...discarded]);
              alert(`[Fase Final - Límite de Mano]: Tienes ${currentHand.length} cartas en mano (el máximo es 8). Se descartaron ${discarded.length} carta(s) al Cementerio por exceso de mano.`);
              return cardsToKeep;
            }
            return currentHand;
          });
        }, 1400);
      }
      return nextHand;
    });

    setDrawnCardAnim({
      cards: [drawn],
      count: 1
    });
    setTimeout(() => setDrawnCardAnim(null), 1600);
  };

  // =========================================================
  // JUGAR CARTA
  // =========================================================

  const executePlayCard =
    async (
      card: any,
      selectedGolds: any[] = []
    ) => {

      if (!card) {
        return;
      }

      // =======================================================
      // VERIFICAR PROHIBICIÓN DE NOMBRE (CARTAS NOMBRADAS)
      // =======================================================
      const cardNorm = String(card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      const prohibition = namedCards.find((n: any) => {
        const nNorm = String(n?.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        return nNorm === cardNorm && (n.rule === 'CANNOT_PLAY' || !n.rule);
      });

      if (prohibition) {
        alert(`No puedes jugar "${card.name}" porque fue nombrada por "${prohibition.sourceCardName || 'una habilidad'}".`);
        return;
      }

      // =======================================================
      // PROMPT DE NOMBRAR CARTA SI LA HABILIDAD LO REQUIERE AL ENTRAR O JUGARSE
      // =======================================================
      let namedCardResult: string | undefined = undefined;
      const abilityText = String(card.ability || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const triggersNamingOnPlay = (card.type === 'Talismán' || abilityText.includes('entra en juego') || abilityText.includes('al entrar')) && (abilityText.includes('nombra') || abilityText.includes('nombrar') || abilityText.includes('menciona')) && !abilityText.includes('puesto en tu destierro') && !cardNorm.includes('brujo de salamanca');
      if (triggersNamingOnPlay) {
        namedCardResult = await new Promise<string | undefined>((resolve) => {
          abilityPromptResolverRef.current = resolve;
          setAbilityPrompt({
            cardId: card.id,
            cardName: card.name,
            mode: 'NAME_CARD',
            message: `Escribe o busca el nombre de la carta que deseas nombrar con "${card.name}":`,
          });
        });
      }

      // =======================================================
      // PRE-VALIDACIÓN SISTÉMICA DE OBJETIVOS Y CONDICIONES
      // =======================================================
      if (card.type === 'Talismán') {
        const isReactive = abilityText.includes('en respuesta') || abilityText.includes('en respuesta a');
        if (isReactive && !canRespond && isMyTurn) {
          // Si el talismán es exclusivamente reactivo a acciones del rival
          if (abilityText.includes('mirar tu mano') || abilityText.includes('buscar cartas en un castillo') || abilityText.includes('fuera a mirar')) {
            alert(`"${card.name}" solo puede jugarse en respuesta a la acción oponente correspondiente.`);
            return;
          }
        }

        // Validación de Talismán de anulación con objetivo obligatorio
        if ((abilityText.includes('anula una carta') || abilityText.includes('anula un talisman') || cardNorm.includes('dragon dorado')) && !abilityText.includes('puedes')) {
          const hasFieldTargets = (opponentDefenseZone?.length || 0) > 0 || (opponentAttackZone?.length || 0) > 0 || (opponentTotemZone?.length || 0) > 0;
          if (!canRespond && !hasFieldTargets) {
            alert(`"${card.name}" requiere un objetivo legal para ser jugado.`);
            return;
          }
        }

        // Validación de destrucción obligatoria de Aliado oponente
        if (abilityText.includes('destruye un aliado oponente') && !abilityText.includes('puedes')) {
          const hasOppAllies = (opponentDefenseZone?.length || 0) > 0 || (opponentAttackZone?.length || 0) > 0;
          if (!hasOppAllies) {
            alert(`No puedes jugar "${card.name}" porque tu oponente no controla Aliados.`);
            return;
          }
        }
      }

      // =======================================================
      // MULTIPLAYER
      // =======================================================

      if (
        isMultiplayer
      ) {

        if (
          !canMakeTurnAction
        ) {

          console.warn(
            '[GAME] No puedes jugar esta carta ahora.'
          );

          return;
        }

        const isResponse =
          canRespond &&
          !isMyTurn;

        const paidGoldIds =
          selectedGolds
            .map(
              (gold: any) =>
                String(
                  gold.instanceId
                )
            )
            .filter(Boolean);

        const sent =
          sendGameAction({

            type:
              'PLAY_CARD',

            cardInstanceId:
              String(
                card.instanceId
              ),

            paidGoldIds,

            isResponse,

            namedCard:
              namedCardResult
          });

        if (!sent) {

          console.error(
            '[GAME] PLAY_CARD no pudo enviarse.'
          );

          return;
        }

        /*
         * MUY IMPORTANTE:
         *
         * En online NO modificamos localmente:
         *
         * - mano
         * - Oros
         * - campo
         * - cementerio
         *
         * El servidor devolverá game_state.
         */

        setPendingCard(
          null
        );

        setSelectedGoldIds(
          []
        );

        setShowGoldModal(
          false
        );

        /*
         * Y TAMPOCO ejecutamos aquí
         * executeCardAbility().
         *
         * La habilidad será ejecutada
         * por server.js.
         */

        return;
      }

      // =======================================================
      // LOCAL
      // =======================================================

      if (namedCardResult) {
        setNamedCards((prev: any[]) => [
          ...prev,
          {
            name: namedCardResult,
            sourceCardName: card.name,
            sourceCardInstanceId: card.instanceId,
            rule: 'CANNOT_PLAY'
          }
        ]);
      }

      const cardToPlay =
        card.type ===
        'Aliado'
          ? prepareAllyForAttack(
              card
            )
          : {
              ...card
            };

      // =======================================================
      // QUITAR DE MANO
      // =======================================================

      setHand(
        (prev: any[]) =>
          prev.filter(
            (currentCard) =>
              getCardInstanceId(
                currentCard
              ) !==
              getCardInstanceId(
                card
              )
          )
      );

      // =======================================================
      // PAGAR OROS
      // =======================================================

      if (
        selectedGolds.length >
        0
      ) {

        const selectedIds = selectedGolds.map((gold: any) => gold.instanceId);

        setGoldZone((prev: any[]) =>
          (prev || [])
            .filter((gold: any) => !(selectedIds.includes(gold.instanceId) && (gold.isGenerated || String(gold.id).startsWith('generated-gold'))))
            .map((gold: any) =>
              selectedIds.includes(gold.instanceId)
                ? {
                    ...gold,
                    isRested: true
                  }
                : gold
            )
        );
      }

      // =======================================================
      // ALIADO
      // =======================================================

      if (
        card.type ===
        'Aliado'
      ) {

        const fury =
          hasFury(
            card
          );

        setDefenseZone(
          (prev: any[]) => [

            ...prev,

            {
              ...cardToPlay,

              canAttack:
                fury,

              hasFury:
                fury
            }

          ]
        );
      }

      // =======================================================
      // ORO
      // =======================================================

      else if (
        card.type ===
        'Oro'
      ) {

        setGoldZone(
          (prev: any[]) => [

            ...prev,

            {
              ...card,

              isRested:
                false
            }

          ]
        );

        // Marcar que ya se jugó un Oro este turno
        setGoldPlayedFromHandThisTurn(true);
      }

      // =======================================================
      // TALISMÁN
      // =======================================================

      else if (
        card.type ===
        'Talismán'
      ) {
        const abNorm = String(card.ability || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (abNorm.includes('destierralo') || abNorm.includes('destierra este talisman') || cardNorm.includes('duelo de dragones') || cardNorm.includes('golpe fulminante')) {
          addToBanished(card);
        } else {
          addToGraveyard(card);
        }
      }

      // =======================================================
      // TÓTEM
      // =======================================================

      else if (
        card.type ===
        'Tótem'
      ) {

        setTotemZone(
          (prev: any[]) => [

            ...prev,

            {
              ...card,

              isRested:
                false
            }

          ]
        );
      }

      // =======================================================
      // ARMA
      // =======================================================

      else if (
        card.type ===
        'Arma'
      ) {

        const target =
          defenseZone.find(
            (
              fieldCard: any
            ) =>
              fieldCard.type ===
              'Aliado'
          );

        if (
          target
        ) {

          setDefenseZone(
            (prev: any[]) =>
              prev.map(
                (
                  ally
                ) =>
                  ally.instanceId ===
                  target.instanceId
                    ? {
                        ...ally,

                        attachedWeapon:
                          card
                      }
                    : ally
              )
          );

        } else {

          addToGraveyard(
            card
          );
        }
      }

      // =======================================================
      // HABILIDAD
      // =======================================================

      if (
        String(
          card.ability ||
          ''
        ).trim()
      ) {
        const isGold = card.type === 'Oro';
        const abNorm = String(card.ability || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const hasEnterTrigger = abNorm.includes('entra en juego') || abNorm.includes('al entrar en juego') || abNorm.includes('cuando entra en juego');

        // Para Oros: SOLO se dispara automáticamente de la mano si tiene efecto de entrar en juego
        if (!isGold || hasEnterTrigger) {
          console.log(
            '[LOCAL][ABILITY] Ejecutando al entrar en juego:',
            card.name
          );

          await executeCardAbility(
            cardToPlay,
            true
          );
        }
      }

      // =======================================================
      // LIMPIAR
      // =======================================================

      setPendingCard(
        null
      );

      setSelectedGoldIds(
        []
      );

      setShowGoldModal(
        false
      );
    };

  // =========================================================
  // JUGAR DESDE MANO
  // =========================================================

  const playCardFromHand = async (card: any) => {
    if (!card) {
      return;
    }

    const masterData = getMasterCardData(card);
    const hasPortador = (defenseZone || []).some((c: any) => c.type === 'Aliado') || (attackZone || []).some((c: any) => c.type === 'Aliado');
    const playValidation = canPlayCard({
      card: { ...masterData, ...card },
      playerSide: 'player',
      isMyTurn: isMultiplayer ? isMyTurn : localIsMyTurn,
      currentPhaseIndex,
      isPhaseStartWindow,
      isResponseWindow: isMultiplayer ? (responseWindow && !isMyTurn) : false,
      hasPriority: isMultiplayer ? (isMyTurn || responseWindow) : true,
      goldPlayedThisTurn: goldPlayedFromHandThisTurn,
      cannotPlayGoldPenalty: cannotPlayGoldNextTurn,
      hasPortadorValid: hasPortador,
      gameState: { defenseZone, attackZone, totemZone, goldZone, graveyard, banished },
      rulesState
    });

    if (!playValidation.legal) {
      showNotice(`⚠️ Jugada Ilegal: ${playValidation.reason || 'No puedes jugar esta carta en esta fase.'}`, 'warning');
      return;
    }

    setIsPhaseStartWindow(false);

    if (isMultiplayer && !canMakeTurnAction && !playValidation.isException) {
      alert('No puedes jugar cartas en este momento.');
      return;
    }

    // Cuervo Nocturno: preguntar si jugar como Talismán o activar Habilidad de Mano
    const cardNorm = String(card.name || '').toLowerCase();
    if (cardNorm.includes('cuervo nocturno')) {
      const otherCards = hand.filter((c: any) => c.instanceId !== card.instanceId);
      if (otherCards.length > 0) {
        const playMode = await showChoice(
          'Cuervo Nocturno',
          '¿Cómo deseas usar a Cuervo Nocturno?',
          [
            { label: 'Jugar como Talismán (Pagar 2 Oros)', value: 'TALISMAN', icon: '📜', description: 'Destierra 6 cartas del tope del Castillo oponente' },
            { label: 'Habilidad de Mano (Coste 0)', value: 'HAND', icon: '🦅', description: 'Poner al fondo con otra carta y Robar 2 cartas' }
          ]
        );
        if (playMode === 'HAND') {
          handleCuervoNocturnoHandAbility(card);
          return;
        }
      }
    }

    // Escarapela Nacional: chequeo de turno oponente y condición de no controlar más oros
    if (cardNorm.includes('escarapela')) {
      if (!isMyTurn) {
        const myGolds = goldZone.length;
        const oppGolds = opponentGoldZone?.length || 0;
        if (myGolds > oppGolds) {
          alert('No puedes jugar Escarapela Nacional en el turno oponente porque controlas más Oros que él.');
          return;
        }
        alert('¡Escarapela Nacional jugada en la Vigilia oponente! No podrás jugar Oro desde tu mano en tu próximo turno.');
        setCannotPlayGoldNextTurn(true);
      }
    }

    const cost = getDynamicCardCost(card);

    // =======================================================
    // VALIDACIÓN DE OBJETIVOS VÁLIDOS PARA TALISMANES
    // =======================================================
    if (masterData.type === 'Talismán') {
      const abClean = String(masterData.ability || card.ability || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

      // A) Cancelar (requiere habilidad/efecto en juego o respuesta)
      if (abClean.includes('cancela') || abClean.includes('cancelar')) {
        if (isMultiplayer && !responseWindow) {
          alert('No puedes jugar este Talismán: no hay ninguna habilidad activa o en respuesta para cancelar.');
          return;
        }
      }

      // B) Anular (requiere carta en juego jugándose para anular)
      if (abClean.includes('anula') || abClean.includes('anular')) {
        if (isMultiplayer && !responseWindow) {
          alert('No puedes jugar este Talismán: no hay ninguna carta jugándose para anular.');
          return;
        }
      }

      // C) Colapso Global / Sidhes del Bosque (requiere respuesta a búsqueda en castillo o mirar mano)
      if (cardNorm.includes('colapso global') || cardNorm.includes('sidhes del bosque') || cardNorm.includes('ofrenda a los abuelos')) {
        if (isMultiplayer && !responseWindow) {
          alert(`No puedes jugar ${card.name}: solo se puede jugar en respuesta a que tu oponente fuera a mirar tu mano o buscar cartas en un Castillo.`);
          return;
        }
      }

      // D) Espectro del Padre (requiere respuesta a destrucción de aliado)
      if (cardNorm.includes('espectro del padre')) {
        if (isMultiplayer && !responseWindow) {
          alert('No puedes jugar Espectro del Padre: solo se puede jugar en respuesta a que un Aliado que controles sea Destruido.');
          return;
        }
      }

      // C) Destruir o desterrar Aliado oponente exclusivo en mesa
      if ((abClean.includes('destruye un aliado oponente') || abClean.includes('destierra un aliado oponente') || abClean.includes('destruye un aliado en juego')) && !abClean.includes(' o ') && !abClean.includes('luego') && !abClean.includes('roba')) {
        const totalOppAllies = (opponentDefenseZone?.length || 0) + (opponentAttackZone?.length || 0);
        if (totalOppAllies === 0) {
          alert('No puedes jugar este Talismán: el oponente no tiene ningún Aliado en juego para hacer objetivo.');
          return;
        }
      }

      // D) Destruir Tótem oponente exclusivo
      if (abClean.includes('destruye un totem') && !abClean.includes(' o ') && !abClean.includes('luego') && !abClean.includes('roba')) {
        if ((opponentTotemZone?.length || 0) === 0) {
          alert('No puedes jugar este Talismán: el oponente no tiene ningún Tótem en juego para hacer objetivo.');
          return;
        }
      }

      // E) Desterrar / barajar cartas de Cementerio exclusivo
      if ((abClean.includes('destierra de un cementerio') || abClean.includes('baraja de un cementerio') || abClean.includes('baraja cartas de tu cementerio')) && !abClean.includes('castillo') && !abClean.includes('mano') && !abClean.includes('roba')) {
        const totalGraveCards = (graveyard?.length || 0) + (opponentGraveyard?.length || 0);
        if (totalGraveCards === 0) {
          alert('No puedes jugar este Talismán: no hay cartas en los Cementerios para hacer objetivo.');
          return;
        }
      }
    }

    // =======================================================
    // ORO
    // =======================================================
    if (masterData.type === 'Oro') {
      // Límite: solo 1 Oro por turno desde la mano (modo local) o penalización de Escarapela
      if (!isMultiplayer && (goldPlayedFromHandThisTurn || cannotPlayGoldNextTurn)) {
        alert('No puedes bajar un Oro este turno (límite de 1 Oro por turno o efecto de Escarapela Nacional).');
        return;
      }

      void executePlayCard(card, []);
      return;
    }

    // =======================================================
    // REDUCCIÓN DE COSTE POR DESCARTE (Ej. El Monstruo)
    // "reduce su coste en un Oro por cada Aliado Bestia que Descartes al jugarlo, hasta un mínimo de 1."
    // =======================================================
    let effectiveCost = cost;
    if (cardNorm.includes('el monstruo') || (masterData.ability && masterData.ability.toLowerCase().includes('reduce su coste') && masterData.ability.toLowerCase().includes('descartes'))) {
      const beastAlliesInHand = hand.filter((c: any) =>
        c.instanceId !== card.instanceId &&
        (c.type === 'Aliado' || c.race === 'Bestia' || (Array.isArray(c.races) && c.races.includes('Bestia')) || String(c.race || '').toLowerCase().includes('bestia'))
      );

      if (beastAlliesInHand.length > 0 && effectiveCost > 1) {
        const maxPossibleDiscount = Math.min(beastAlliesInHand.length, effectiveCost - 1);
        const wantDiscount = await showConfirm(
          'El Monstruo - Reducción de Coste',
          `¿Deseas descartar Aliados Bestia de tu mano para reducir su coste en 1 por cada uno? (Mínimo: 1 Oro)\n\nTienes ${beastAlliesInHand.length} Aliado(s) Bestia en mano.`
        );
        if (wantDiscount) {
          const promptCount = await showPrompt(
            'El Monstruo',
            `¿Cuántos Aliados Bestia deseas descartar? (1 a ${maxPossibleDiscount}):`,
            String(maxPossibleDiscount)
          );
          const countToDiscard = parseInt(promptCount || '0', 10);
          if (!isNaN(countToDiscard) && countToDiscard > 0) {
            const actualDiscount = Math.min(countToDiscard, maxPossibleDiscount);
            const beastsToDiscard = beastAlliesInHand.slice(0, actualDiscount);
            const bIds = beastsToDiscard.map((b: any) => b.instanceId);

            // Quitar de mano y mandar al Cementerio
            setHand((prev: any[]) => prev.filter((c: any) => !bIds.includes(c.instanceId)));
            setGraveyard((prev: any[]) => [
              ...(prev || []),
              ...beastsToDiscard.map((b: any) => ({ ...b, zone: 'GRAVEYARD', isRested: false }))
            ]);

            effectiveCost = Math.max(1, cost - actualDiscount);
            alert(`¡Descartaste ${actualDiscount} Aliado(s) Bestia (${beastsToDiscard.map((b: any) => b.name).join(', ')})! El coste de ${card.name} se redujo a ${effectiveCost} Oro(s).`);
          }
        }
      }
    }

      // =======================================================
      // COSTO 0
      // =======================================================

      if (
        effectiveCost <=
        0
      ) {

        void executePlayCard(
          card,
          []
        );

        return;
      }

      // =======================================================
      // OROS DISPONIBLES Y PRIORIZACIÓN DE ORO GENERADO
      // =======================================================
      const availableGold = reserveGolds;

      if (availableGold.length < effectiveCost) {
        alert(
          `No puedes jugar "${card.name}". ` +
          `Cuesta ${effectiveCost} oro(s) y solo tienes ` +
          `${availableGold.length} oro(s) en Reserva.`
        );
        return;
      }

      // Priorizar Oros Generados (se deben usar sí o sí de forma prioritaria)
      const genGolds = availableGold.filter((g: any) => g.isGenerated || String(g.id).startsWith('generated-gold'));
      const normalGolds = availableGold.filter((g: any) => !g.isGenerated && !String(g.id).startsWith('generated-gold'));
      const prioritizedSelection = [...genGolds, ...normalGolds].slice(0, effectiveCost);

      // Si la reserva total es igual al coste, o los oros generados cubren todo el coste:
      if (availableGold.length === effectiveCost || genGolds.length >= effectiveCost) {
        void executePlayCard(card, prioritizedSelection);
        return;
      }

      setPendingCard(card);
      setSelectedGoldIds(prioritizedSelection.map((g: any) => g.instanceId));
      setShowGoldModal(true);
    };

  // =========================================================
  // ACTIVAR HABILIDAD DE CARTA EN CAMPO
  // =========================================================

  const handleActivateCardAbility = async (card: any) => {
    if (!card || !card.ability) return;

    if (card.isAbilityDisabled || card.isSilenced || card.sinHabilidad || card.hasNoAbility || card.convertedToVanilla) {
      showNotice(`"${card.name}" está sin habilidad / silenciada y no puede activarla.`, 'warning');
      return;
    }

    // Comprobar que la carta esté físicamente en el campo (Línea de Defensa, Ataque, Tótems u Oros)
    const inField = [
      ...(defenseZone || []),
      ...(attackZone || []),
      ...(totemZone || []),
      ...(goldZone || [])
    ].some((c: any) => (c.instanceId || c.id) === (card.instanceId || card.id));

    if (!inField) {
      showNotice(`"${card.name}" no está en el campo de juego para activar esta habilidad.`, 'warning');
      return;
    }

    const abText = String(card.ability || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const normName = String(card.name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    // Comprobar si la carta tiene una habilidad activable en campo
    const entry = AbilityInterpreter.getEntry(card);
    const triggers = entry?.analysis?.triggers || [];
    const hasActivatedTrigger = triggers.some((t: any) =>
      t.type === 'ACTIVATED_VIGILIA' ||
      t.type === 'ACTIVATED_ONCE_PER_TURN' ||
      t.type === 'IN_RESPONSE' ||
      t.type === 'FINAL_PHASE_TRIGGER'
    );

    const hasActivatedKeywords = /una vez por turno|en tu vigilia|en vigilia|puedes desterrar|puedes destruir|puedes pagar|barajando|en respuesta|puedes convertir|en tu fase final/i.test(abText);
    const hasSpecificActive = ['torre de babel', 'armeria del guerrero', 'jinete de la peste', 'escamas de dragon', 'lanza argenta', 'cthulhu'].includes(normName);

    const isPureEtbOrPassive = !hasActivatedTrigger && !hasActivatedKeywords && !hasSpecificActive;

    if (isPureEtbOrPassive) {
      showNotice(`"${card.name}" solo tiene efectos automáticos / continuos y no posee una habilidad activable manual en campo.`, 'info');
      return;
    }

    // Validación Central de Habilidades según el DAR
    const abilityValidation = canActivateAbility({
      card,
      playerSide: 'player',
      isMyTurn: isMultiplayer ? isMyTurn : localIsMyTurn,
      currentPhaseIndex,
      isResponseWindow: isMultiplayer ? (responseWindow && !isMyTurn) : false,
      hasPriority: isMultiplayer ? (isMyTurn || responseWindow) : true,
      usedThisTurn: usedAbilityCardIdsThisTurn.includes(card.instanceId || card.id),
      isSilenced: card.isAbilityDisabled || card.isSilenced || card.sinHabilidad || card.convertedToVanilla,
      gameState: { defenseZone, attackZone, totemZone, goldZone }
    });

    if (!abilityValidation.legal) {
      showNotice(`⚠️ Habilidad Ilegal: ${abilityValidation.reason || 'No puedes activar esta habilidad en esta fase.'}`, 'warning');
      return;
    }

    const cardId = card.instanceId || card.id;
    setUsedAbilityCardIdsThisTurn((prev) => [...prev, cardId]);

    // Trigger visual ability activation pulse
    setActivatingAbilityCardId(card.instanceId);
    setTimeout(() => {
      setActivatingAbilityCardId(null);
    }, 1200);

    // Resting the card upon ability use
    setDefenseZone((prev: any[]) => prev.map((c: any) => c.instanceId === card.instanceId ? { ...c, isRested: true } : c));
    setTotemZone((prev: any[]) => prev.map((c: any) => c.instanceId === card.instanceId ? { ...c, isRested: true } : c));
    setGoldZone((prev: any[]) => prev.map((g: any) => g.instanceId === card.instanceId ? { ...g, isRested: true } : g));

    if (isMultiplayer) {
      if (!isMyTurn && !canRespond) {
        alert('Solo puedes activar habilidades en tu turno o en tu ventana de respuesta.');
        return;
      }

      const socket = multiplayerData?.socket;
      const lobbyId = multiplayerData?.lobbyData?.id || multiplayerData?.lobbyData?.lobbyId;
      if (!socket || !lobbyId) return;

      socket.emit('player_action', {
        lobbyId,
        actionData: {
          type: 'ACTIVATE_ABILITY',
          sourceInstanceId: card.instanceId,
          isResponse: canRespond && !isMyTurn
        }
      });
      return;
    }

    // Modo local / playtest
    await executeCardAbility(card);
  };

  // =========================================================
  // SELECCIONAR ORO
  // =========================================================

  const toggleGoldSelection =
    (
      gold: any
    ) => {

      setSelectedGoldIds(
        (prev) => {

          if (
            prev.includes(
              gold.instanceId
            )
          ) {

            return prev.filter(
              (id) =>
                id !==
                gold.instanceId
            );
          }

          const required =
            Number(
              pendingCard?.cost
            ) || 0;

          if (
            prev.length >=
            required
          ) {

            return prev;
          }

          return [
            ...prev,

            gold.instanceId
          ];
        }
      );
    };

  // =========================================================
  // CONFIRMAR PAGO
  // =========================================================

  const confirmGoldPayment =
    () => {

      if (
        !pendingCard
      ) {

        return;
      }

      const required = getCardCost(pendingCard);

      if (
        selectedGoldIds.length !==
        required
      ) {

        return;
      }

      const selectedGolds =
        goldZone.filter(
          (gold: any) =>
            selectedGoldIds.includes(
              gold.instanceId
            )
        );

      void executePlayCard(
        pendingCard,
        selectedGolds
      );
    };

  // =========================================================
  // DESCANSAR
  // =========================================================

  const toggleRest =
    (
      card: any,
      zoneSetter: any,
      zone: string
    ) => {

      if (
        isMultiplayer
      ) {

        if (
          !isMyTurn ||
          responseWindow
        ) {

          return;
        }

        sendGameAction({

          type:
            'TOGGLE_REST',

          cardInstanceId:
            card.instanceId,

          zone
        });

        return;
      }

      zoneSetter(
        (prev: any[]) =>
          prev.map(
            (c) =>
              c.instanceId ===
              card.instanceId
                ? {
                    ...c,

                    isRested:
                      !c.isRested
                  }
                : c
          )
      );
    };

  // =========================================================
  // AVANZAR FASE
  // =========================================================

  const handleConfirmHandLimitDiscard = () => {
    const excess = (hand?.length || 0) - 8;
    if (selectedHandDiscardIds.length !== excess) {
      alert(`Debes seleccionar exactamente ${excess} carta(s) para descartar (has seleccionado ${selectedHandDiscardIds.length}).`);
      return;
    }

    const discardedCards = hand.filter((c: any) => selectedHandDiscardIds.includes(c.instanceId));
    setHand((prev: any[]) => prev.filter((c: any) => !selectedHandDiscardIds.includes(c.instanceId)));
    setGraveyard((prev: any[]) => [...(prev || []), ...discardedCards.map((c: any) => ({ ...c, zone: 'GRAVEYARD', isRested: false }))]);
    setShowHandDiscardModal(false);
    setSelectedHandDiscardIds([]);
    showNotice(`🗑️ Descartaste ${discardedCards.length} carta(s) por límite de mano.`, 'info');

    // Continuar el fin de turno
    finalizeEndOfTurn();
  };

  const finalizeEndOfTurn = () => {
    drawCardAtFinalPhase();

    // Resetear el límite de Oro por turno en Agrupación teniendo en cuenta penalizaciones
    if (cannotPlayGoldNextTurn) {
      setGoldPlayedFromHandThisTurn(true);
      setCannotPlayGoldNextTurn(false);
    } else {
      setGoldPlayedFromHandThisTurn(false);
    }

    // Resetear el contador de 1 habilidad por turno para cartas en juego
    setUsedAbilityCardIdsThisTurn([]);

    // Resetear silencios temporales de 1 turno
    const clearTurnSilence = (c: any) =>
      c.abilityDisabledDuration === 'TURN'
        ? { ...c, isAbilityDisabled: false, isSilenced: false, abilityDisabledDuration: undefined }
        : c;
    setDefenseZone((prev: any[]) => prev.map(clearTurnSilence));
    setAttackZone((prev: any[]) => prev.map(clearTurnSilence));
    setTotemZone((prev: any[]) => prev.map(clearTurnSilence));
    setGoldZone((prev: any[]) => prev.map(clearTurnSilence));

    regroupAllAllies();

    // Si estamos jugando contra la IA en modo local:
    if (!isMultiplayer && aiBotProfile) {
      setLocalIsMyTurn(false);
      showNotice(`🤖 Turno de ${aiBotProfile.name} iniciado...`, 'info');

      setTimeout(async () => {
        await executeAiFullTurn(
          {
            setOpponentHand: (fn: any) => {
              if (typeof setOpponentHand === 'function') setOpponentHand(fn);
            },
            setOpponentCastle: (fn: any) => {
              if (typeof setOpponentCastleCards === 'function') setOpponentCastleCards(fn);
            },
            setOpponentGoldZone: (fn: any) => {
              if (typeof setOpponentGoldZone === 'function') setOpponentGoldZone(fn);
            },
            setOpponentAttackZone: (fn: any) => {
              if (typeof setOpponentAttackZone === 'function') setOpponentAttackZone(fn);
            },
            setOpponentDefenseZone: (fn: any) => {
              if (typeof setOpponentDefenseZone === 'function') setOpponentDefenseZone(fn);
            },
            setOpponentTotemZone: (fn: any) => {
              if (typeof setOpponentTotemZone === 'function') setOpponentTotemZone(fn);
            },
            setOpponentGraveyard: (fn: any) => {
              if (typeof setOpponentGraveyard === 'function') setOpponentGraveyard(fn);
            },
            setOpponentBanished: (fn: any) => {
              if (typeof setOpponentBanished === 'function') setOpponentBanished(fn);
            },
            setPlayerCastleCards: (fn: any) => {
              if (typeof setCastleCards === 'function') setCastleCards(fn);
            },
            setPlayerGraveyard: (fn: any) => {
              if (typeof setGraveyard === 'function') setGraveyard(fn);
            },
            setPlayerDefenseZone: (fn: any) => {
              if (typeof setDefenseZone === 'function') setDefenseZone(fn);
            },
            setCurrentPhaseIndex: (phase: number) => {
              if (typeof setCurrentPhaseIndex === 'function') setCurrentPhaseIndex(phase);
            },
            setIsMyTurn: (val: boolean) => {
              setLocalIsMyTurn(val);
            },
            setTurn: (fn: any) => {
              if (typeof setTurn === 'function') setTurn(fn);
            },
            showNotice: (msg: string, type?: any) => {
              showNotice(msg, type);
            }
          },
          () => ({
            aiHand: opponentHand || [],
            aiCastle: opponentCastleCards || [],
            aiGoldZone: opponentGoldZone || [],
            aiAttackZone: opponentAttackZone || [],
            aiDefenseZone: opponentDefenseZone || [],
            aiTotemZone: opponentTotemZone || [],
            aiGraveyard: opponentGraveyard || [],
            aiBanished: opponentBanished || [],
            playerAttackZone: attackZone || [],
            playerDefenseZone: defenseZone || [],
            playerGoldZone: goldZone || [],
            playerCastleCards: castleCards || [],
            playerGraveyard: graveyard || [],
            turnNumber: turn || 1
          })
        );
      }, 600);

      return;
    }

    advancePhase();
  };

  const handleAdvancePhaseWithSync = () => {
    if (isMultiplayer) {
      if (!isMyTurn || responseWindow) {
        return;
      }

      sendGameAction({
        type: 'NEXT_PHASE'
      });

      return;
    }

    const isLastPhase = currentPhaseIndex === DAR_PHASES.length - 1;

    if (isLastPhase) {
      // Regla DAR: Límite de 8 cartas en mano al finalizar Fase Final
      if ((hand?.length || 0) > 8) {
        const excess = (hand?.length || 0) - 8;
        setSelectedHandDiscardIds([]);
        setShowHandDiscardModal(true);
        showNotice(`⚠️ Límite de Mano: Tienes ${hand.length} cartas (máximo 8). Selecciona ${excess} carta(s) para descartar.`, 'warning');
        return;
      }

      finalizeEndOfTurn();
      return;
    }

    advancePhase();
  };

  // =========================================================
  // BLOQUEOS Y COMBATE
  // =========================================================

  const combatBlocks = useMemo(() => {
    if (isMultiplayer && multiplayerData?.combat?.blocks) {
      return multiplayerData.combat.blocks;
    }
    return localCombatBlocks;
  }, [isMultiplayer, multiplayerData?.combat?.blocks, localCombatBlocks]);

  // =========================================================
  // ATAQUE
  // =========================================================

  const declareAttack = (
    card: any
  ) => {
    const attackValidation = canDeclareAttack({
      card,
      currentPhaseIndex,
      isMyTurn: isMultiplayer ? isMyTurn : localIsMyTurn,
      enteredThisTurn: card.enteredThisTurn || false,
      hasFuria: card.hasFury || false,
      isRested: card.isRested || false,
      isSilenced: card.isAbilityDisabled || card.isSilenced || false
    });

    if (!attackValidation.legal) {
      showNotice(`⚠️ Ataque Ilegal: ${attackValidation.reason || 'No puedes declarar ataque con esta carta.'}`, 'warning');
      return;
    }

    if (
      isMultiplayer
    ) {

      if (
        !isMyTurn ||
        responseWindow
      ) {

        return;
      }

      sendGameAction({

        type:
          'DECLARE_ATTACK',

        cardInstanceId:
          card.instanceId
      });

      return;
    }

    // Disparador de Jabberwocky al atacar
    const cardNorm = String(card?.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (cardNorm.includes('jabberwocky') && !cardNorm.includes('desatado')) {
      let stolenCard: any = null;
      if (opponentCastleCards && opponentCastleCards.length > 0) {
        stolenCard = opponentCastleCards[0];
        if (typeof setOpponentCastleCards === 'function') {
          setOpponentCastleCards((prev: any[]) => prev.slice(1));
        }
      } else if (typeof setOpponentCastleCount === 'function') {
        setOpponentCastleCount((c: number) => Math.max(0, c - 1));
      }

      const newGold = {
        ...(stolenCard || { id: `stolen-gold-${Date.now()}`, name: 'Oro de Castillo Oponente', imageUrl: 'https://images.api-dar.com/cards/oro-base.jpg' }),
        instanceId: `jabber-gold-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        type: 'Oro',
        ability: 'Oro sin habilidad.',
        sinHabilidad: true,
        hasNoAbility: true,
        zone: 'GOLD',
        isRested: true
      };

      setGoldZone((prev: any[]) => [...(prev || []), newGold]);
      showNotice('🐉 Jabberwocky atacó: convirtió la primera carta del Castillo rival en un Oro Pagado.', 'success');
    }

    setAttackZone(
      (prev: any[]) => [

        ...prev,

        {
          ...card,

          canAttack:
            false,

          isRested:
            false
        }

      ]
    );

    setDefenseZone(
      (prev: any[]) =>
        prev.filter(
          (currentCard) =>
            currentCard.instanceId !==
            card.instanceId
        )
    );
  };

  const cancelAttack = (
    card: any
  ) => {
    if (isMultiplayer) {
      sendGameAction({
        type: 'CANCEL_ATTACK',
        cardInstanceId: card.instanceId
      });
      return;
    }

    setAttackZone((prev: any[]) =>
      prev.filter((c) => c.instanceId !== card.instanceId)
    );

    setDefenseZone((prev: any[]) => [
      ...prev,
      {
        ...card,
        canAttack: true,
        isRested: false
      }
    ]);

    setLocalCombatBlocks((prev) => {
      const next = { ...prev };
      delete next[card.instanceId];
      return next;
    });
  };

  const declareBlock = (
    attackerCard: any,
    blockerCard: any
  ) => {
    if (isUnblockable(attackerCard)) {
      alert(`¡${attackerCard.name} es Imbloqueable! No puede ser bloqueado.`);
      return;
    }

    if (isMultiplayer) {
      sendGameAction({
        type: 'DECLARE_BLOCK',
        attackerInstanceId: attackerCard.instanceId,
        blockerInstanceId: blockerCard.instanceId
      });
    } else {
      setLocalCombatBlocks((prev) => ({
        ...prev,
        [attackerCard.instanceId]: blockerCard.instanceId
      }));
    }
    setBlockTargetingAttacker(null);
  };

  const removeBlock = (
    attackerInstanceId: string
  ) => {
    if (isMultiplayer) {
      sendGameAction({
        type: 'REMOVE_BLOCK',
        attackerInstanceId
      });
    } else {
      setLocalCombatBlocks((prev) => {
        const next = { ...prev };
        delete next[attackerInstanceId];
        return next;
      });
    }
  };

  const confirmBlocks = () => {
    if (isMultiplayer) {
      sendGameAction({
        type: 'CONFIRM_BLOCKS'
      });
    }
  };

  // =========================================================
  // DAÑO Y RESOLUCIÓN DE COMBATE
  // =========================================================

  const assignDamage = () => {

    if (
      isMultiplayer
    ) {

      if (
        !isMyTurn ||
        responseWindow
      ) {

        return;
      }

      sendGameAction({

        type:
          'ASSIGN_DAMAGE'
      });

      return;
    }

    // Local / Solitario: Resolución completa de combate
    const activeBlocks = { ...combatBlocks };
    if (!isMultiplayer && aiBotProfile && Object.keys(activeBlocks).length === 0 && opponentDefenseZone.length > 0) {
      const readyDefenders = opponentDefenseZone.filter((d: any) => !d.isRested);
      attackZone.forEach((atk: any, idx: number) => {
        if (!isUnblockable(atk) && readyDefenders[idx]) {
          activeBlocks[atk.instanceId] = readyDefenders[idx].instanceId;
        }
      });
    }

    let totalCastleDamage = 0;
    const survivingAttackers: any[] = [];

    attackZone.forEach((attacker: any) => {
      const fAttacker = getCardEffectiveStrength(attacker);
      const blockerId = activeBlocks[attacker.instanceId];
      const blocker = blockerId
        ? opponentDefenseZone.find((c: any) => c.instanceId === blockerId)
        : null;

      if (!blocker || isUnblockable(attacker)) {
        // 1. Ataque directo al Castillo
        totalCastleDamage += fAttacker;
        survivingAttackers.push({
          ...attacker,
          isRested: true,
          canAttack: false
        });
      } else {
        // 2. Combate de Fuerza (Atacante vs Bloqueador)
        const fBlocker = getCardEffectiveStrength(blocker);

        if (fAttacker > fBlocker) {
          // Destruye al defensor y pasa daño sobrante al Castillo
          const excess = fAttacker - fBlocker;
          totalCastleDamage += excess;
          if (typeof setOpponentGraveyard === 'function') {
            setOpponentGraveyard((prev: any[]) => [...(prev || []), blocker]);
            setRecentOpponentGraveyardCards((prev: any[]) => [blocker, ...prev]);
            setTimeout(() => setRecentOpponentGraveyardCards([]), 10000);
          }
          if (typeof setOpponentDefenseZone === 'function') {
            setOpponentDefenseZone((prev: any[]) =>
              (prev || []).filter((c: any) => c.instanceId !== blocker.instanceId)
            );
          }
          survivingAttackers.push({
            ...attacker,
            isRested: true,
            canAttack: false
          });
        } else if (fAttacker === fBlocker) {
          // Empate: ambos destruidos
          setGraveyard((prev: any[]) => [...(prev || []), attacker]);
          if (typeof setOpponentGraveyard === 'function') {
            setOpponentGraveyard((prev: any[]) => [...(prev || []), blocker]);
            setRecentOpponentGraveyardCards((prev: any[]) => [blocker, ...prev]);
            setTimeout(() => setRecentOpponentGraveyardCards([]), 10000);
          }
          if (typeof setOpponentDefenseZone === 'function') {
            setOpponentDefenseZone((prev: any[]) =>
              (prev || []).filter((c: any) => c.instanceId !== blocker.instanceId)
            );
          }
        } else {
          // Defensor gana: atacante destruido, defensor descansa
          setGraveyard((prev: any[]) => [...(prev || []), attacker]);
          if (typeof setOpponentDefenseZone === 'function') {
            setOpponentDefenseZone((prev: any[]) =>
              (prev || []).map((c: any) =>
                c.instanceId === blocker.instanceId
                  ? { ...c, isRested: true }
                  : c
              )
            );
          }
        }
      }
    });

    if (totalCastleDamage > 0) {
      let milledNames: string[] = [];
      if (typeof setOpponentCastleCards === 'function') {
        setOpponentCastleCards((prev: any[]) => {
          const milled = (prev || []).slice(0, totalCastleDamage);
          milledNames = milled.map((c: any) => c.name || 'Carta');
          if (milled.length > 0) {
            setRecentOpponentGraveyardCards((prev: any[]) => [...milled, ...prev]);
            setTimeout(() => setRecentOpponentGraveyardCards([]), 10000);
          }
          if (typeof setOpponentGraveyard === 'function' && milled.length > 0) {
            setOpponentGraveyard((g: any[]) => [...(g || []), ...milled]);
          }
          return (prev || []).slice(totalCastleDamage);
        });
      }
      if (typeof setOpponentCastleCount === 'function') {
        setOpponentCastleCount((count: number) =>
          Math.max(0, (count ?? 0) - totalCastleDamage)
        );
      }
      setLastDamageDealt({ amount: totalCastleDamage, time: Date.now(), milledNames });
      showNotice(
        `💥 ¡Tu ataque infligió ${totalCastleDamage} de daño al Castillo del rival! ${
          milledNames.length > 0 ? `(Cartas botadas: ${milledNames.slice(0, 3).join(', ')}${milledNames.length > 3 ? '...' : ''})` : ''
        }`,
        'success'
      );
    }

    // Los Aliados atacantes sobrevivientes permanecen descansados en la Línea de Ataque hasta la próxima Agrupación
    setAttackZone(survivingAttackers.map((a: any) => ({ ...a, isRested: true, canAttack: false })));
    setLocalCombatBlocks({});
  };

  // =========================================================
  // RESUMEN DE COMBATE
  // =========================================================

  const combatSummary = useMemo(() => {
    const currentAttackers = isMyTurn ? attackZone : opponentAttackZone;
    const currentDefenders = isMyTurn ? opponentDefenseZone : defenseZone;

    if (!Array.isArray(currentAttackers) || currentAttackers.length === 0) {
      return null;
    }

    let projectedCastleDamage = 0;
    const matchups = currentAttackers.map((atk: any) => {
      const fAtk = getCardEffectiveStrength(atk);
      const unblockable = isUnblockable(atk);
      const blockerId = combatBlocks[atk.instanceId] || localCombatBlocks[atk.instanceId];
      const blocker = blockerId
        ? currentDefenders.find((d: any) => d.instanceId === blockerId)
        : null;

      if (!blocker || unblockable) {
        projectedCastleDamage += fAtk;
        return {
          attacker: atk,
          blocker: null,
          fAtk,
          fBlk: 0,
          unblockable,
          outcome: 'DIRECT',
          damage: fAtk
        };
      }

      const fBlk = getCardEffectiveStrength(blocker);
      if (fAtk > fBlk) {
        const excess = fAtk - fBlk;
        projectedCastleDamage += excess;
        return {
          attacker: atk,
          blocker,
          fAtk,
          fBlk,
          unblockable: false,
          outcome: 'ATTACKER_WINS',
          damage: excess
        };
      } else if (fAtk === fBlk) {
        return {
          attacker: atk,
          blocker,
          fAtk,
          fBlk,
          unblockable: false,
          outcome: 'TIE',
          damage: 0
        };
      } else {
        return {
          attacker: atk,
          blocker,
          fAtk,
          fBlk,
          unblockable: false,
          outcome: 'DEFENDER_WINS',
          damage: 0
        };
      }
    });

    return {
      matchups,
      projectedCastleDamage
    };
  }, [
    attackZone,
    opponentAttackZone,
    defenseZone,
    opponentDefenseZone,
    combatBlocks,
    isMyTurn
  ]);

  // =========================================================
  // PASS RESPONSE
  // =========================================================

  const passResponse = () => {

    if (
      !canRespond
    ) {

      return;
    }

    sendGameAction({
      type:
        'PASS_RESPONSE'
    });
  };

  // =========================================================
  // ATAQUE TOTAL
  // =========================================================

  const playerAttackPower =
    useMemo(
      () =>
        (
          attackZone || []
        ).reduce(
          (
            sum: number,
            card: any
          ) =>
            sum +
            (
              Number(
                card.strength
              ) || 0
            ),
          0
        ),
      [
        attackZone
      ]
    );

  // =========================================================
  // OROS
  // =========================================================

  const paidGolds =
    (
      goldZone || []
    ).filter(
      (gold: any) =>
        gold.isRested
    );

  const reserveGolds =
    (
      goldZone || []
    ).filter(
      (gold: any) =>
        !gold.isRested
    );

  const paidGoldCount =
    paidGolds.length;

  const reserveGoldCount =
    reserveGolds.length;

  const opponentPaidGolds =
    (
      opponentGoldZone || []
    ).filter(
      (gold: any) =>
        gold.isRested
    );

  const opponentReserveGolds =
    (
      opponentGoldZone || []
    ).filter(
      (gold: any) =>
        !gold.isRested
    );

  const checkCanActivateAbility = useCallback((card: any) => {
    if (!card || !card.ability) return false;
    const cardId = card.instanceId || card.id;
    return canActivateAbility({
      card,
      playerSide: 'player',
      isMyTurn: isMultiplayer ? isMyTurn : localIsMyTurn,
      currentPhaseIndex,
      isResponseWindow: isMultiplayer ? (responseWindow && !isMyTurn) : false,
      hasPriority: isMultiplayer ? (isMyTurn || responseWindow) : true,
      usedThisTurn: usedAbilityCardIdsThisTurn.includes(cardId),
      isSilenced: card.isAbilityDisabled || card.isSilenced || card.sinHabilidad || card.convertedToVanilla,
      gameState: { defenseZone, attackZone, totemZone, goldZone }
    }).legal;
  }, [isMultiplayer, isMyTurn, localIsMyTurn, currentPhaseIndex, responseWindow, usedAbilityCardIdsThisTurn, defenseZone, attackZone, totemZone, goldZone]);

  const checkIsCardPlayable = useCallback((card: any) => {
    if (!card) return false;
    return canPlayCard({
      card: { ...getMasterCardData(card), ...card },
      playerSide: 'player',
      isMyTurn: isMultiplayer ? isMyTurn : localIsMyTurn,
      currentPhaseIndex,
      isPhaseStartWindow,
      isResponseWindow: isMultiplayer ? (responseWindow && !isMyTurn) : false,
      hasPriority: isMultiplayer ? (isMyTurn || responseWindow) : true,
      goldPlayedThisTurn: goldPlayedFromHandThisTurn,
      cannotPlayGoldPenalty: cannotPlayGoldNextTurn,
      hasPortadorValid: (defenseZone?.length || 0) > 0 || (attackZone?.length || 0) > 0,
      gameState: { defenseZone, attackZone, totemZone, goldZone },
      rulesState
    }).legal;
  }, [isMultiplayer, isMyTurn, localIsMyTurn, currentPhaseIndex, isPhaseStartWindow, responseWindow, goldPlayedFromHandThisTurn, cannotPlayGoldNextTurn, defenseZone, attackZone, totemZone, goldZone, rulesState]);

  // =========================================================
  // RENDER
  // =========================================================

  if (device.isPortraitBlocked) {
    return <PortraitBlocker />;
  }

  return (

    <div className="flex-1 flex h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-[#26180e] via-[#120d09] to-[#080504] text-amber-100 font-sans relative overflow-hidden select-none safe-area-paddings">

      {/* VFX Layer (Floating buffs, debuffs, gold particles, non-blocking) */}
      <VFXLayer events={vfxEvents} />

      {/* Mobile Card Inspector (Bottom-sheet modal for touch devices) */}
      <MobileCardInspector
        card={mobileInspectCard}
        isOpen={Boolean(mobileInspectCard)}
        onClose={() => setMobileInspectCard(null)}
        onPlay={(c) => playCardFromHand(c)}
        isPlayable={mobileInspectCard ? checkIsCardPlayable(mobileInspectCard) : false}
      />

      {/* Zone Drawer Modal (Graveyard / Banished for Mobile & Tablet) */}
      <ZoneDrawerModal
        isOpen={mobileZoneDrawer.isOpen}
        onClose={() => setMobileZoneDrawer(prev => ({ ...prev, isOpen: false }))}
        title={mobileZoneDrawer.title}
        cards={mobileZoneDrawer.cards}
        icon={mobileZoneDrawer.icon}
        onSelectCard={(c) => setMobileInspectCard(c)}
      />

      {/* =====================================================
          PROMPT HABILIDAD
      ===================================================== */}

      {renderAbilityPrompt()}
      {renderSignoAmarilloModal()}
      {renderSandraudigaModal()}
      {renderCamiloHenriquezModal()}
      {renderLanzaArgentaModal()}
      {renderColapsoPrompt()}
      {renderCuervoNocturnoModal()}
      {renderEscarapelaModal()}
      {renderPulsoKaijuModal()}
      {renderHandSelectionModal()}
      {renderDrawCardAnimation()}

      {/* =====================================================
          POPUP CARTA
      ===================================================== */}

      {previewVisible &&
        hoveredCard &&
        !signoAmarilloModal?.isOpen &&
        !pulsoKaijuModal?.isOpen &&
        !abilityPrompt &&
        !sandraudigaModal?.isOpen &&
        !camiloModal?.isOpen &&
        !lanzaArgentaModal?.isOpen &&
        !colapsoPrompt?.isOpen &&
        !cuervoModal?.isOpen &&
        !showEscarapelaModal &&
        !showGoldModal &&
        !showGraveyard &&
        !showBanished &&
        !showCastleSearchModal &&
        !showMulliganModal &&
        !showSurrenderModal &&
        !showDarRulesModal && (

          <div
            className="fixed z-[9999] pointer-events-none"
            style={{
              left: 20,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 280,
            }}
          >

            <div className="bg-zinc-950/98 border-2 border-amber-500/80 rounded-2xl p-2 shadow-2xl">

              <div className="bg-black/60 rounded-xl border border-amber-900/40 p-1.5 flex justify-center">

                <img
                  src={
                    hoveredCard.imageUrl
                  }
                  alt={
                    hoveredCard.name ||
                    'Carta'
                  }
                  className="max-w-full max-h-[240px] w-auto h-auto object-contain rounded-lg"
                />

              </div>

              <div className="mt-2 bg-zinc-900 rounded-xl border border-zinc-800 p-2">

                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-black text-amber-300">
                    {hoveredCard.name}
                  </span>
                  {hoveredCard.cost !== undefined && hoveredCard.cost !== null && (
                    <div className="w-8 h-8 rounded-full bg-amber-900/60 border-2 border-amber-500/80 flex items-center justify-center flex-shrink-0">
                      <span className="text-amber-300 font-black text-base">{hoveredCard.cost}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 mt-1 ml-10">

                  {hoveredCard.type && (
                    <span className="text-[9px] uppercase font-bold text-zinc-400">
                      {hoveredCard.type}
                    </span>
                  )}

                  {getCardRaces && getCardRaces(hoveredCard)?.length > 0 && (
                    <>
                      <span className="text-zinc-700">-</span>
                      <span className="text-[9px] uppercase font-bold text-amber-500/80">
                        {getCardRaces(hoveredCard).join(' / ')}
                      </span>
                    </>
                  )}

                </div>

                <div className="flex flex-wrap justify-center gap-1 mt-2">

                  {hasFury(
                    hoveredCard
                  ) && (

                    <span className="flex items-center gap-1 px-2 py-1 rounded-md bg-red-950 border border-red-500/50 text-[8px] font-black text-red-300 uppercase">

                      <Zap className="w-2.5 h-2.5" />

                      Furia

                    </span>

                  )}

                  {isIndestructible(
                    hoveredCard
                  ) && (

                    <span className="flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-950 border border-emerald-500/50 text-[8px] font-black text-emerald-300 uppercase">

                      <Shield className="w-2.5 h-2.5" />

                      Indestructible

                    </span>

                  )}

                  {isIndesterrable(
                    hoveredCard
                  ) && (

                    <span className="flex items-center gap-1 px-2 py-1 rounded-md bg-blue-950 border border-blue-500/50 text-[8px] font-black text-blue-300 uppercase">

                      <Ban className="w-2.5 h-2.5" />

                      Indesterrable

                    </span>

                  )}

                </div>

                {/* Strength / Damage row */}
                {(hoveredCard.type === 'Aliado' || (hoveredCard.type === 'Hechizo' && hoveredCard.strength !== undefined)) && (
                  <div className="mt-2 flex gap-1.5">
                    {hoveredCard.type === 'Aliado' && (
                      <div className="flex-1 p-1.5 rounded-lg bg-zinc-950/80 border border-zinc-800 text-center">
                        <span className="text-[9px] text-zinc-500 font-bold block uppercase">Fuerza</span>
                        <div className="flex items-center justify-center gap-1">
                          <span className="text-amber-400 font-black text-sm">{getCardEffectiveStrength(hoveredCard)}</span>
                          {(() => {
                            const base = Number(hoveredCard.strength) || 0;
                            const eff = getCardEffectiveStrength(hoveredCard);
                            const diff = eff - base;
                            if (diff === 0) return null;
                            return (
                              <span className={`text-[9px] font-bold px-1 rounded ${diff > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {diff > 0 ? `+${diff}` : diff}
                              </span>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                    {hoveredCard.type === 'Hechizo' && hoveredCard.strength !== undefined && (
                      <div className="flex-1 p-1.5 rounded-lg bg-zinc-950/80 border border-zinc-800 text-center">
                        <span className="text-[9px] text-zinc-500 font-bold block uppercase">Dano</span>
                        <span className="text-red-400 font-black text-sm">{hoveredCard.strength}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Ability text */}
                {hoveredCard.ability && (
                  <div className="mt-2 p-2 rounded-lg bg-[#12140f] border border-amber-900/30 text-left">
                    <span className="text-[9px] text-amber-500/70 font-bold uppercase block mb-1">Habilidad</span>
                    <p className="text-[10px] text-zinc-300 leading-snug">{hoveredCard.ability}</p>
                  </div>
                )}

                {/* Flavor text */}
                {hoveredCard.flavorText && (
                  <div className="mt-1 px-2 py-1">
                    <p className="text-[9px] text-zinc-600 italic leading-snug">{hoveredCard.flavorText}</p>
                  </div>
                )}

              </div>

            </div>

          </div>
      )}

      {/* =====================================================
          CEMENTERIO
      ===================================================== */}

      {showGraveyard && (

        <div
          className="fixed inset-0 z-[9996] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() =>
            setShowGraveyard(
              false
            )
          }
        >

          <div
            className="w-full max-w-5xl max-h-[92dvh] bg-[#140e09] p-3 sm:p-4 rounded-2xl overflow-hidden safe-area-paddings border-2 border-red-900/70 rounded-2xl shadow-2xl p-4 flex flex-col"
            onClick={(event) =>
              event.stopPropagation()
            }
          >

            <div className="flex items-center justify-between mb-4">

              <div>

                <h2 className="text-xl font-black text-red-400 uppercase">
                  Cementerio
                </h2>

                <p className="text-[10px] text-zinc-500 mt-1">
                  {
                    graveyard.length
                  } carta(s)
                </p>

              </div>

              <button
                onClick={() =>
                  setShowGraveyard(
                    false
                  )
                }
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700"
              >

                <X className="w-5 h-5" />

              </button>

            </div>

            <div className="flex-1 overflow-y-auto p-2">

              {graveyard.length ===
              0 ? (

                <div className="h-64 flex items-center justify-center">

                  <div className="text-center">

                    <p className="text-zinc-600 font-black text-lg">
                      Cementerio vacío
                    </p>

                    <p className="text-zinc-700 text-xs mt-1">
                      No hay cartas en tu cementerio.
                    </p>

                  </div>

                </div>

              ) : (

                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-3">

                  {graveyard.map(
                    (
                      card: any,
                      index: number
                    ) => (

                      <div
                        key={
                          `${card.instanceId || card.id || 'card'}-graveyard-${index}`
                        }

                        onMouseEnter={(event) =>
                          handleCardHover(
                            card,
                            event
                          )
                        }

                        onMouseLeave={
                          handleCardLeave
                        }

                        className="relative aspect-[2/3] rounded-xl overflow-hidden border border-red-900/60 bg-zinc-950 shadow-lg hover:border-red-400 hover:scale-105 transition-transform cursor-pointer"
                      >

                        <img
                          src={
                            card.imageUrl
                          }
                          alt={
                            card.name ||
                            'Carta'
                          }
                          className="w-full h-full object-contain"
                        />
                        {/* Botón Drácula (cementerio) */}
                        {(() => {
                          const n = String(card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                          return n.includes('dracula') && card.type === 'Oro';
                        })() && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!Array.isArray(opponentAttackZone) || opponentAttackZone.length === 0) { alert('El oponente debe tener al menos 1 atacante.'); return; }
                              if (isMultiplayer) {
                                sendGameAction({ type: 'DRACULA_BANISH_CANCEL', sourceInstanceId: card.instanceId, sourceZone: 'GRAVEYARD' });
                              } else {
                                setGraveyard((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
                                addToBanished({ ...card, zone: 'BANISHED', isRested: false });
                                const toCancel = opponentAttackZone.slice(0, 2);
                                if (typeof setOpponentAttackZone === 'function') setOpponentAttackZone((prev: any[]) => prev.filter((c: any) => !toCancel.find((tc: any) => tc.instanceId === c.instanceId)));
                                if (typeof setOpponentDefenseZone === 'function') setOpponentDefenseZone((prev: any[]) => [...prev, ...toCancel.map((tc: any) => ({ ...tc, canAttack: false, isRested: false }))]);
                                alert(`Drácula desterrado. Cancelado ataque de ${toCancel.length} Aliado(s).`);
                              }
                              setShowGraveyard(false);
                            }}
                            className="absolute inset-x-0 bottom-0 bg-purple-900/90 text-purple-200 text-[8px] font-black py-0.5 hover:bg-purple-700 transition-colors text-center"
                          >🦇 Desterrar → Cancelar</button>
                        )}

                        {/* Botón Exhumar / Habilidad Cementerio */}
                        {(() => {
                          const ab = String(card.ability || '').toLowerCase();
                          const hasExhumar = ab.includes('exhumar');
                          const hasGraveEffect = ab.includes('de tu cementerio') || ab.includes('en tu cementerio') || ab.includes('este cementerio');
                          return hasExhumar || hasGraveEffect;
                        })() && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleActivateGraveyardCard(card);
                            }}
                            className="absolute inset-x-0 bottom-0 bg-emerald-800/95 text-emerald-200 text-[8px] font-black py-0.5 hover:bg-emerald-600 transition-colors text-center border-t border-emerald-500"
                          >
                            ⚡ Activar / Exhumar
                          </button>
                        )}

                      </div>

                    )
                  )}

                </div>
              )}

            </div>

          </div>

        </div>
      )}

      {/* =====================================================
          DESTIERRO
      ===================================================== */}

      {showBanished && (

        <div
          className="fixed inset-0 z-[9996] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() =>
            setShowBanished(
              false
            )
          }
        >

          <div
            className="w-full max-w-5xl max-h-[92dvh] bg-[#140e09] p-3 sm:p-4 rounded-2xl overflow-hidden safe-area-paddings border-2 border-blue-900/70 rounded-2xl shadow-2xl p-4 flex flex-col"
            onClick={(event) =>
              event.stopPropagation()
            }
          >

            <div className="flex items-center justify-between mb-4">

              <div>

                <h2 className="text-xl font-black text-blue-400 uppercase">
                  Destierro
                </h2>

                <p className="text-[10px] text-zinc-500 mt-1">
                  {
                    banished.length
                  } carta(s)
                </p>

              </div>

              <button
                onClick={() =>
                  setShowBanished(
                    false
                  )
                }
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700"
              >

                <X className="w-5 h-5" />

              </button>

            </div>

            <div className="flex-1 overflow-y-auto p-2">

              {banished.length ===
              0 ? (

                <div className="h-64 flex items-center justify-center">

                  <div className="text-center">

                    <p className="text-zinc-600 font-black text-lg">
                      Destierro vacío
                    </p>

                    <p className="text-zinc-700 text-xs mt-1">
                      No hay cartas desterradas.
                    </p>

                  </div>

                </div>

              ) : (

                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-3">

                  {banished.map(
                    (
                      card: any,
                      index: number
                    ) => (

                      <div
                        key={
                          `${card.instanceId || card.id || 'card'}-banished-${index}`
                        }

                        onMouseEnter={(event) =>
                          handleCardHover(
                            card,
                            event
                          )
                        }

                        onMouseLeave={
                          handleCardLeave
                        }

                        className="relative aspect-[2/3] rounded-xl overflow-hidden border border-blue-900/60 bg-zinc-950 shadow-lg hover:border-blue-400 hover:scale-105 transition-transform cursor-pointer"
                      >

                        <img
                          src={
                            card.imageUrl
                          }
                          alt={
                            card.name ||
                            'Carta'
                          }
                          className="w-full h-full object-contain"
                        />

                        {/* Botón Sandraudiga (destierro) */}
                        {(() => {
                          const n = String(card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                          return (n.includes('sandra') || n.includes('sandraudiga')) && card.type === 'Aliado';
                        })() && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (hand.length === 0) {
                                alert('No tienes cartas en tu mano para desterrar.');
                                return;
                              }
                              setShowBanished(false);
                              setHandSelectionModal({
                                isOpen: true,
                                title: 'Sandraudiga - Desterrar carta de mano',
                                subtitle: 'Selecciona 1 carta de tu mano para Desterrar y barajar a Sandraudiga en tu Castillo.',
                                sourceCard: card,
                                requiredCount: 1,
                                actionType: 'DISCARD',
                                selectedCardIds: [],
                                onConfirm: (selectedCards) => {
                                  if (selectedCards.length === 0) return;
                                  const [toBanish] = selectedCards;
                                  if (isMultiplayer) {
                                    sendGameAction({ type: 'SANDRAUDIGA_SHUFFLE_FROM_BANISHED', sourceInstanceId: card.instanceId, handCardId: toBanish.instanceId });
                                  }
                                  setHand((prev: any[]) => prev.filter((c: any) => c.instanceId !== toBanish.instanceId));
                                  addToBanished({ ...toBanish, zone: 'BANISHED', isRested: false });
                                  setBanished((prev: any[]) => prev.filter((c: any) => c.instanceId !== card.instanceId));
                                  setCastleCards((prev: any[]) => [
                                    ...prev,
                                    { ...card, zone: 'CASTLE', isRested: false }
                                  ].sort(() => Math.random() - 0.5));
                                  shuffleCastleWithAnim();
                                  alert(`¡Sandraudiga barajada en tu Castillo tras desterrar "${toBanish.name}" de tu mano!`);
                                }
                              });
                            }}
                            className="absolute inset-x-0 bottom-0 bg-amber-600/95 text-amber-100 text-[8px] font-black py-1 hover:bg-amber-500 transition-colors text-center border-t border-amber-400 shadow"
                          >
                            🔄 Barajar en Castillo
                          </button>
                        )}

                        {/* Botón Otros Sacerdotes y Aliados en Destierro (Moreau, Frankenstein, Mu, etc.) */}
                        {(() => {
                          const n = String(card.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                          const ab = String(card.ability || '').toLowerCase();
                          const isSandra = n.includes('sandra') || n.includes('sandraudiga');
                          const hasDestierroEffect = ab.includes('en tu destierro') || ab.includes('de tu destierro') || n.includes('moreau') || n.includes('frankenstein') || n === 'mu';
                          return !isSandra && hasDestierroEffect;
                        })() && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleActivateBanishedCard(card);
                            }}
                            className="absolute inset-x-0 bottom-0 bg-blue-900/95 text-blue-100 text-[8px] font-black py-1 hover:bg-blue-700 transition-colors text-center border-t border-blue-400 shadow"
                          >
                            ⚡ Activar Habilidad
                          </button>
                        )}

                      </div>

                    )
                  )}

                </div>
              )}

            </div>

          </div>

        </div>
      )}

      {/* =====================================================
          CEMENTERIO OPONENTE
      ===================================================== */}
      {showOpponentGraveyard && (
        <div
          className="fixed inset-0 z-[9996] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowOpponentGraveyard(false)}
        >
          <div
            className="w-full max-w-5xl max-h-[92dvh] bg-[#140e09] p-3 sm:p-4 rounded-2xl overflow-hidden safe-area-paddings border-2 border-red-900/70 rounded-2xl shadow-2xl p-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-black text-red-400 uppercase">
                  Cementerio de {opponentName}
                </h2>
                <p className="text-[10px] text-zinc-500 mt-1">
                  {(opponentGraveyard || []).length} carta(s) en el cementerio rival
                </p>
              </div>
              <button
                onClick={() => setShowOpponentGraveyard(false)}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {(opponentGraveyard || []).length === 0 ? (
                <div className="h-64 flex items-center justify-center">
                  <div className="text-center">
                    <p className="text-zinc-600 font-black text-lg">Cementerio rival vacío</p>
                    <p className="text-zinc-700 text-xs mt-1">No hay cartas en el cementerio del oponente.</p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-3">
                  {(opponentGraveyard || []).map((card: any, index: number) => (
                    <div
                      key={`opp-grave-modal-${card.instanceId || card.id || 'card'}-${index}`}
                      onMouseEnter={(event) => handleCardHover(card, event)}
                      onMouseLeave={handleCardLeave}
                      className="relative aspect-[2/3] rounded-xl overflow-hidden border border-red-900/60 bg-zinc-950 shadow-lg hover:border-red-400 hover:scale-105 transition-transform cursor-pointer"
                    >
                      <img
                        src={card.imageUrl}
                        alt={card.name || 'Carta'}
                        className="w-full h-full object-contain"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================
          DESTIERRO OPONENTE
      ===================================================== */}
      {showOpponentBanished && (
        <div
          className="fixed inset-0 z-[9996] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowOpponentBanished(false)}
        >
          <div
            className="w-full max-w-5xl max-h-[92dvh] bg-[#140e09] p-3 sm:p-4 rounded-2xl overflow-hidden safe-area-paddings border-2 border-blue-900/70 rounded-2xl shadow-2xl p-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-black text-blue-400 uppercase">
                  Destierro de {opponentName}
                </h2>
                <p className="text-[10px] text-zinc-500 mt-1">
                  {(opponentBanished || []).length} carta(s) en el destierro rival
                </p>
              </div>
              <button
                onClick={() => setShowOpponentBanished(false)}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {(opponentBanished || []).length === 0 ? (
                <div className="h-64 flex items-center justify-center">
                  <div className="text-center">
                    <p className="text-zinc-600 font-black text-lg">Destierro rival vacío</p>
                    <p className="text-zinc-700 text-xs mt-1">No hay cartas en el destierro del oponente.</p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-3">
                  {(opponentBanished || []).map((card: any, index: number) => (
                    <div
                      key={`opp-banished-modal-${card.instanceId || card.id || 'card'}-${index}`}
                      onMouseEnter={(event) => handleCardHover(card, event)}
                      onMouseLeave={handleCardLeave}
                      className="relative aspect-[2/3] rounded-xl overflow-hidden border border-blue-900/60 bg-zinc-950 shadow-lg hover:border-blue-400 hover:scale-105 transition-transform cursor-pointer"
                    >
                      <img
                        src={card.imageUrl}
                        alt={card.name || 'Carta'}
                        className="w-full h-full object-contain"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================
          MODAL BÚSQUEDA EN CASTILLO ONLINE / ZONAS PÚBLICAS
      ===================================================== */}
      {onlineCastleSearch && (
        <div className="fixed inset-0 z-[10001] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div
            className="w-full max-w-5xl max-h-[85vh] bg-[#0d1722] border-2 border-cyan-500/70 rounded-2xl shadow-2xl p-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <span className="text-[9px] text-cyan-400 uppercase font-black">
                  {onlineCastleSearch.readonly ? 'Zona pública' : 'Búsqueda online'}
                </span>
                <h2 className="text-xl font-black text-cyan-300 uppercase">
                  {onlineCastleSearch.readonly ? onlineCastleSearch.sourceCardName : 'Buscar en Castillo'}
                </h2>
                <p className="text-[10px] text-zinc-500 mt-1">
                  {onlineCastleSearch.readonly
                    ? 'Cartas visibles para ambos jugadores.'
                    : 'Selecciona una carta; el servidor hará el movimiento y barajará el Castillo.'}
                </p>
              </div>
              <button
                onClick={() => {
                  if (!onlineCastleSearch.readonly && onlineCastleSearch.searchId) {
                    sendGameAction({ type: 'SEARCH_CASTLE_CANCEL', searchId: onlineCastleSearch.searchId });
                  }
                  setOnlineCastleSearch(null);
                }}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {onlineCastleSearch.cards.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-center">
                  <p className="text-zinc-600 font-black text-lg">No hay cartas visibles.</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
                  {onlineCastleSearch.cards.map((card: any, index: number) => (
                    <button
                      key={`online-zone-${card.instanceId || card.id || 'card'}-${index}`}
                      type="button"
                      disabled={Boolean(onlineCastleSearch.readonly)}
                      onMouseEnter={(e) => handleCardHover(card, e)}
                      onMouseLeave={handleCardLeave}
                      onClick={() => {
                        if (onlineCastleSearch.readonly) return;
                        if (!onlineCastleSearch.searchId || !card.instanceId) return;
                        sendGameAction({
                          type: 'SEARCH_CASTLE_PICK',
                          searchId: onlineCastleSearch.searchId,
                          cardInstanceId: card.instanceId
                        });
                        setOnlineCastleSearch(null);
                      }}
                      className={`relative aspect-[2/3] rounded-xl overflow-hidden border bg-zinc-950 shadow-lg transition-transform ${
                        onlineCastleSearch.readonly
                          ? 'border-zinc-800 cursor-default'
                          : 'border-cyan-700/60 hover:border-cyan-400 hover:scale-105 cursor-pointer'
                      }`}
                    >
                      {card.imageUrl ? (
                        <img src={card.imageUrl} alt={card.name || 'Carta'} className="w-full h-full object-contain" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center p-2 text-center">
                          <span className="text-[9px] text-cyan-300 font-bold">{card.name}</span>
                        </div>
                      )}
                      <div className="absolute bottom-0 left-0 right-0 bg-black/75 px-1 py-1">
                        <span className="text-[8px] text-cyan-200 font-bold line-clamp-1">{card.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================
          MODAL BÚSQUEDA EN CASTILLO
      ===================================================== */}

      {showCastleSearchModal && castleSearchResolver && (
        <div
          className="fixed inset-0 z-[9997] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            className="w-full max-w-5xl max-h-[85vh] bg-[#0d1722] border-2 border-amber-600/70 rounded-2xl shadow-2xl p-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-black text-amber-400 uppercase">Búsqueda en Castillo</h2>
                <p className="text-[10px] text-zinc-500 mt-1">
                  Selecciona una carta para añadirla a tu mano. El castillo se barajará.
                  {castleSearchFilter.type ? ` (Solo: ${castleSearchFilter.type})` : ''}
                  {castleSearchFilter.maxCost !== undefined ? ` (Coste ≤ ${castleSearchFilter.maxCost})` : ''}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowCastleSearchModal(false);
                  castleSearchResolver(null);
                  setCastleSearchResolver(null);
                }}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {castleCards.length === 0 ? (
                <div className="h-64 flex items-center justify-center">
                  <p className="text-zinc-600 font-black text-lg">Castillo vacío</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
                  {castleCards
                    .filter((c: any) => {
                      if (castleSearchFilter.type) {
                        const allowedTypes = castleSearchFilter.type.split(',').map((s: string) => s.trim().toLowerCase());
                        const cardType = String(c.type || '').toLowerCase();
                        if (!allowedTypes.includes(cardType)) return false;
                      }
                      if (castleSearchFilter.maxCost !== undefined && Number(c.cost) > castleSearchFilter.maxCost) return false;
                      if (castleSearchFilter.text) {
                        const t = castleSearchFilter.text.toLowerCase();
                        const name = String(c.name || '').toLowerCase();
                        if (!name.includes(t)) return false;
                      }
                      return true;
                    })
                    .map((card: any, index: number) => (
                      <div
                        key={`castle-search-${card.instanceId || card.id || 'c'}-${index}`}
                        onMouseEnter={(e) => handleCardHover(card, e)}
                        onMouseLeave={handleCardLeave}
                        onClick={() => {
                          const targetCard = card;
                          // Quitar exactamente 1 copia del castillo y barajar con animación
                          setCastleCards((prev: any[]) => {
                            const targetInstanceId = targetCard.instanceId;
                            let removed = false;
                            const remaining = prev.filter((c: any) => {
                              if (!removed) {
                                if (targetInstanceId && c.instanceId) {
                                  if (c.instanceId === targetInstanceId) {
                                    removed = true;
                                    return false;
                                  }
                                } else if (c.id === targetCard.id || c.name === targetCard.name) {
                                  removed = true;
                                  return false;
                                }
                              }
                              return true;
                            });
                            return remaining.sort(() => Math.random() - 0.5);
                          });

                          shuffleCastleWithAnim();
                          setShowCastleSearchModal(false);

                          if (castleSearchResolver) {
                            castleSearchResolver(targetCard);
                            setCastleSearchResolver(null);
                          }
                        }}
                        className="relative aspect-[2/3] rounded-xl overflow-hidden border border-amber-700/50 bg-zinc-950 shadow-lg hover:border-amber-400 hover:scale-105 transition-transform cursor-pointer"
                      >
                        {card.imageUrl ? (
                          <img src={card.imageUrl} alt={card.name || 'Carta'} className="w-full h-full object-contain" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center p-1">
                            <span className="text-[9px] text-amber-300 font-bold text-center">{card.name}</span>
                          </div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 bg-black/70 p-1 text-center">
                          <span className="text-[8px] text-amber-200 font-bold line-clamp-1">{card.name}</span>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

          </div>
        </div>
      )}

      {/* =====================================================
          MODAL OROS
      ===================================================== */}

      {showGoldModal &&
        pendingCard && (

        <div className="fixed inset-0 z-[9998] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">

          <div className="w-full max-w-xl max-h-[92dvh] bg-[#140e09] border-2 border-amber-500/80 rounded-2xl shadow-2xl p-3 sm:p-4 flex flex-col justify-between overflow-hidden safe-area-paddings">

            <div className="flex items-center justify-between mb-4">

              <div>

                <h2 className="text-lg font-black text-amber-300">
                  Pagar carta
                </h2>

                <p className="text-[10px] text-zinc-400 mt-1">

                  Selecciona exactamente{' '}
                  {getCardCost(pendingCard)}
                  {' '}oro(s) para pagar{' '}
                  {pendingCard.name}.
                </p>

              </div>

              <button
                onClick={() => {
                  setShowGoldModal(false);
                  setPendingCard(null);
                  setSelectedGoldIds([]);
                }}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700"
              >
                <X className="w-4 h-4" />
              </button>

            </div>

            <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-3 max-h-[55vh] overflow-y-auto p-2">

              {reserveGolds.map(
                (
                  gold: any,
                  index: number
                ) => {

                  const selected =
                    selectedGoldIds.includes(
                      gold.instanceId
                    );

                  return (

                    <button
                      key={
                        `${gold.instanceId || gold.id || 'gold'}-payment-${index}`
                      }

                      onClick={() =>
                        toggleGoldSelection(
                          gold
                        )
                      }

                      className={`relative aspect-[2/3] rounded-xl overflow-hidden border-2 transition-all ${
                        selected
                          ? 'border-amber-300 ring-4 ring-amber-500/40 scale-105'
                          : 'border-zinc-700 hover:border-amber-500'
                      }`}
                    >

                      {gold.isGenerated || String(gold.id).startsWith('generated-gold') ? (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-amber-950 via-yellow-900/90 to-black text-center p-2 border border-yellow-500/50">
                          <span className="text-3xl filter drop-shadow">🪙</span>
                          <span className="text-[10px] font-black text-amber-300 uppercase mt-1">Generado</span>
                          <span className="text-[8px] text-amber-200/80 font-bold">(Prioritario)</span>
                        </div>
                      ) : (
                        <img
                          src={gold.imageUrl}
                          alt={gold.name || 'Oro'}
                          className="w-full h-full object-contain bg-black"
                        />
                      )}

                      {selected && (

                        <div className="absolute inset-0 bg-amber-500/20 flex items-center justify-center">

                          <span className="bg-amber-400 text-zinc-950 font-black text-xs rounded-full w-7 h-7 flex items-center justify-center">
                            OK
                          </span>

                        </div>

                      )}

                    </button>

                  );
                }
              )}

            </div>

            <div className="flex items-center justify-between mt-4 pt-3 border-t border-zinc-800">

              <span className="text-xs text-zinc-400">
                Seleccionados:{' '}
                <strong className="text-amber-400">
                  {selectedGoldIds.length}
                </strong>
                {' / '}
                {getCardCost(pendingCard)}
              </span>

              <button
                onClick={confirmGoldPayment}
                disabled={selectedGoldIds.length !== getCardCost(pendingCard)}
                className="px-5 py-2 bg-amber-500 text-zinc-950 rounded-xl font-black text-xs disabled:opacity-30 disabled:cursor-not-allowed hover:bg-amber-400 transition"
              >
                Pagar y jugar
              </button>

            </div>

          </div>

        </div>
      )}

      {/* Menu Drawer Modal (Secondary info for mobile/tablet) */}
      <MenuDrawerModal
        isOpen={isMenuDrawerOpen}
        onClose={() => setIsMenuDrawerOpen(false)}
        castleCount={castleCards.length}
        graveyardCount={graveyard.length}
        banishedCount={banished.length}
        opponentCastleCount={opponentCastleCount}
        opponentGraveyardCount={opponentGraveyard.length}
        opponentBanishedCount={opponentBanished.length}
        onOpenGraveyard={() => setShowGraveyard(true)}
        onOpenBanished={() => setShowBanished(true)}
        onOpenOpponentGraveyard={() => setShowOpponentGraveyard(true)}
        onOpenOpponentBanished={() => setShowOpponentBanished(true)}
        onOpenDarRules={() => setShowDarRulesModal(true)}
        onSurrender={() => setShowSurrenderModal(true)}
        turn={turn}
        currentPhaseName={DAR_PHASE_NAMES[currentPhaseIndex] || 'Vigilia'}
        roundScore={{ myScore, opponentScore, currentGame: matchState?.currentGame || 1 }}
      />

      {/* =====================================================
          MAIN BOARD VIEW DISPATCHER BY DEVICE LAYOUT
      ===================================================== */}
      {device.isMobileLandscape ? (
        <MobileLandscapeLayout
          hand={hand}
          defenseZone={defenseZone}
          attackZone={attackZone}
          totemZone={totemZone}
          goldZone={goldZone}
          castleCards={castleCards}
          graveyard={graveyard}
          banished={banished}
          opponentDefenseZone={opponentDefenseZone}
          opponentAttackZone={opponentAttackZone}
          opponentTotemZone={opponentTotemZone}
          opponentGoldZone={opponentGoldZone}
          opponentCastleCount={opponentCastleCount}
          opponentHandCount={opponentHandCount}
          opponentGraveyard={opponentGraveyard}
          opponentBanished={opponentBanished}
          turn={turn}
          currentPhaseIndex={currentPhaseIndex}
          currentPhaseName={DAR_PHASE_NAMES[currentPhaseIndex] || 'Vigilia'}
          isMyTurn={isMultiplayer ? isMyTurn : localIsMyTurn}
          isResponseWindow={isMultiplayer ? (responseWindow && !isMyTurn) : false}
          hasPriority={isMultiplayer ? (isMyTurn || responseWindow) : true}
          opponentName={opponentName}
          opponentAvatar={opponentAvatar}
          playerAvatar={playerAvatar || DEFAULT_AVATAR}
          currentDeckName={currentDeckName}
          selectedCard={selectedBoardCard}
          onSelectCard={(c) => setSelectedBoardCard(c)}
          onInspectCard={(c) => setMobileInspectCard(c)}
          onPlayCard={(c) => playCardFromHand(c)}
          isPlayableCard={(c) => checkIsCardPlayable(c)}
          onActivateCardAbility={(c) => handleActivateCardAbility(c)}
          canActivateCardAbility={(c) => checkCanActivateAbility(c)}
          onAdvancePhase={handleAdvancePhaseWithSync}
          onOpenMenuDrawer={() => setIsMenuDrawerOpen(true)}
          cardDimensions={device.cardDimensions}
          namedCards={namedCards}
          onPayToShuffleBrujo={(c) => handlePayToShuffleBrujo(c)}
        />
      ) : device.isTabletLandscape ? (
        <TabletLandscapeLayout
          hand={hand}
          defenseZone={defenseZone}
          attackZone={attackZone}
          totemZone={totemZone}
          goldZone={goldZone}
          castleCards={castleCards}
          graveyard={graveyard}
          banished={banished}
          opponentDefenseZone={opponentDefenseZone}
          opponentAttackZone={opponentAttackZone}
          opponentTotemZone={opponentTotemZone}
          opponentGoldZone={opponentGoldZone}
          opponentCastleCount={opponentCastleCount}
          opponentHandCount={opponentHandCount}
          opponentGraveyard={opponentGraveyard}
          opponentBanished={opponentBanished}
          turn={turn}
          currentPhaseIndex={currentPhaseIndex}
          currentPhaseName={DAR_PHASE_NAMES[currentPhaseIndex] || 'Vigilia'}
          isMyTurn={isMultiplayer ? isMyTurn : localIsMyTurn}
          isResponseWindow={isMultiplayer ? (responseWindow && !isMyTurn) : false}
          hasPriority={isMultiplayer ? (isMyTurn || responseWindow) : true}
          opponentName={opponentName}
          opponentAvatar={opponentAvatar}
          playerAvatar={playerAvatar || DEFAULT_AVATAR}
          currentDeckName={currentDeckName}
          selectedCard={selectedBoardCard}
          onSelectCard={(c) => setSelectedBoardCard(c)}
          onInspectCard={(c) => setMobileInspectCard(c)}
          onPlayCard={(c) => playCardFromHand(c)}
          isPlayableCard={(c) => checkIsCardPlayable(c)}
          onActivateCardAbility={(c) => handleActivateCardAbility(c)}
          canActivateCardAbility={(c) => checkCanActivateAbility(c)}
          onAdvancePhase={handleAdvancePhaseWithSync}
          onOpenGraveyard={() => setShowGraveyard(true)}
          onOpenBanished={() => setShowBanished(true)}
          onOpenOpponentGraveyard={() => setShowOpponentGraveyard(true)}
          onOpenOpponentBanished={() => setShowOpponentBanished(true)}
          onOpenMenuDrawer={() => setIsMenuDrawerOpen(true)}
          cardDimensions={device.cardDimensions}
          namedCards={namedCards}
          onPayToShuffleBrujo={(c) => handlePayToShuffleBrujo(c)}
        />
      ) : (
        <DesktopLayout
          hand={hand}
          defenseZone={defenseZone}
          attackZone={attackZone}
          totemZone={totemZone}
          goldZone={goldZone}
          castleCards={castleCards}
          graveyard={graveyard}
          banished={banished}
          opponentDefenseZone={opponentDefenseZone}
          opponentAttackZone={opponentAttackZone}
          opponentTotemZone={opponentTotemZone}
          opponentGoldZone={opponentGoldZone}
          opponentCastleCount={opponentCastleCount}
          opponentHandCount={opponentHandCount}
          opponentGraveyard={opponentGraveyard}
          opponentBanished={opponentBanished}
          turn={turn}
          currentPhaseIndex={currentPhaseIndex}
          currentPhaseName={DAR_PHASE_NAMES[currentPhaseIndex] || 'Vigilia'}
          isMyTurn={isMultiplayer ? isMyTurn : localIsMyTurn}
          isResponseWindow={isMultiplayer ? (responseWindow && !isMyTurn) : false}
          hasPriority={isMultiplayer ? (isMyTurn || responseWindow) : true}
          opponentName={opponentName}
          opponentAvatar={opponentAvatar}
          playerAvatar={playerAvatar || DEFAULT_AVATAR}
          currentDeckName={currentDeckName}
          matchState={matchState}
          myScore={myScore}
          opponentScore={opponentScore}
          timeLeftSeconds={timeLeftSeconds ?? 0}
          isExtraTime={isExtraTime}
          formatRoundTime={formatRoundTime}
          onPlayCard={(c) => playCardFromHand(c)}
          isPlayableCard={(c) => checkIsCardPlayable(c)}
          onActivateCardAbility={(c) => handleActivateCardAbility(c)}
          canActivateCardAbility={(c) => checkCanActivateAbility(c)}
          onAdvancePhase={handleAdvancePhaseWithSync}
          onSurrender={() => setShowSurrenderModal(true)}
          onOpenGraveyard={() => setShowGraveyard(true)}
          onOpenBanished={() => setShowBanished(true)}
          onOpenOpponentGraveyard={() => setShowOpponentGraveyard(true)}
          onOpenOpponentBanished={() => setShowOpponentBanished(true)}
          onOpenDarRules={() => setShowDarRulesModal(true)}
          onToggleRestAlly={(c, zone) => toggleRest(c, zone === 'defense' ? setDefenseZone : setAttackZone, zone)}
          onToggleRestGold={(c) => toggleRest(c, setGoldZone, 'gold')}
          onToggleRestTotem={(c) => toggleRest(c, setTotemZone, 'totem')}
          onCardHover={(c, e) => handleCardHover(c, e as any)}
          onCardLeave={handleCardLeave}
          namedCards={namedCards}
          onPayToShuffleBrujo={(c) => handlePayToShuffleBrujo(c)}
          isShufflingCastle={isShufflingCastle}
          activatingAbilityCardId={activatingAbilityCardId}
          cardDimensions={device.cardDimensions}
        />
      )}

      {/* =====================================================
          NOTIFICACIÓN TOAST IN-GAME (REEMPLAZO DE ALERT)
      ===================================================== */}
      {gameNotice && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[99999] max-w-lg w-[92%] pointer-events-auto transition-all animate-bounce duration-300">
          <div className={`p-3.5 rounded-2xl border-2 shadow-2xl backdrop-blur-xl flex items-center justify-between gap-3 text-xs font-bold ${
            gameNotice.type === 'error'
              ? 'bg-red-950/95 border-red-500 text-red-200 shadow-red-950/80'
              : gameNotice.type === 'warning'
              ? 'bg-amber-950/95 border-amber-500 text-amber-200 shadow-amber-950/80'
              : gameNotice.type === 'success'
              ? 'bg-emerald-950/95 border-emerald-500 text-emerald-200 shadow-emerald-950/80'
              : 'bg-[#1a120b]/95 border-amber-500/80 text-amber-100 shadow-amber-950/80'
          }`}>
            <div className="flex items-center gap-2.5 overflow-hidden">
              <span className="text-base shrink-0">{gameNotice.icon || (gameNotice.type === 'error' ? '⚠️' : gameNotice.type === 'success' ? '✨' : '⚔️')}</span>
              <span className="leading-snug break-words">{gameNotice.message}</span>
            </div>
            <button
              onClick={() => setGameNotice(null)}
              className="p-1 rounded-lg bg-black/40 hover:bg-black/70 text-zinc-400 hover:text-white transition shrink-0 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* =====================================================
          MODAL DE DIÁLOGO / ELECCIÓN IN-GAME (REEMPLAZO DE PROMPT / CONFIRM)
      ===================================================== */}
      {gameDialog && (
        <div className="fixed inset-0 z-[900] bg-black/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 select-none animate-fadeIn">
          <div className="w-full max-w-sm sm:max-w-md max-h-[92dvh] bg-gradient-to-b from-[#1c140c] to-[#0c0906] border-2 border-amber-500/80 rounded-2xl sm:rounded-3xl p-3 sm:p-5 shadow-[0_25px_60px_rgba(0,0,0,0.95)] flex flex-col justify-between overflow-hidden text-center safe-area-paddings">
            {/* Encabezado */}
            <div className="flex flex-col items-center gap-1.5">
              <span className="text-xs uppercase font-black tracking-widest text-amber-400 bg-amber-950/80 border border-amber-500/40 px-3 py-0.5 rounded-full">
                {gameDialog.badge || '⚔️ Decisión en Juego'}
              </span>
              <h3 className="text-lg font-black text-amber-200 uppercase tracking-wide">
                {gameDialog.title}
              </h3>
              <p className="text-xs text-zinc-300 font-medium whitespace-pre-line leading-relaxed px-2">
                {gameDialog.message}
              </p>
            </div>

            {/* Input de Prompt si aplica */}
            {gameDialog.type === 'PROMPT' && (
              <div className="my-1">
                <input
                  type="text"
                  id="game-dialog-prompt-input"
                  defaultValue={gameDialog.defaultValue || ''}
                  placeholder={gameDialog.placeholder || 'Escribe tu respuesta...'}
                  className="w-full bg-zinc-950 border border-amber-500/60 rounded-xl px-4 py-2.5 text-center text-sm font-bold text-amber-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-400"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = (e.target as HTMLInputElement).value;
                      gameDialog.resolver(val);
                      setGameDialog(null);
                    }
                  }}
                />
              </div>
            )}

            {/* Botones de Opciones / Elección / Confirm */}
            <div className="flex flex-col gap-2 mt-2">
              {gameDialog.type === 'CHOICE' && gameDialog.options && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {gameDialog.options.map((opt, idx) => (
                    <button
                      key={`dialog-choice-${idx}`}
                      onClick={() => {
                        gameDialog.resolver(opt.value);
                        setGameDialog(null);
                      }}
                      className="py-3 px-4 bg-gradient-to-r from-[#2a1d12] to-[#1a1109] hover:from-amber-600 hover:to-amber-700 border border-amber-500/50 hover:border-amber-400 text-amber-100 hover:text-zinc-950 font-black text-xs uppercase tracking-wider rounded-xl transition shadow flex flex-col items-center gap-1 group cursor-pointer"
                    >
                      {opt.icon && <span className="text-base">{opt.icon}</span>}
                      <span>{opt.label}</span>
                      {opt.description && (
                        <span className="text-[9px] text-zinc-400 group-hover:text-zinc-950 font-normal">
                          {opt.description}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {gameDialog.type === 'CONFIRM' && (
                <div className="flex gap-2.5">
                  <button
                    onClick={() => {
                      gameDialog.resolver(true);
                      setGameDialog(null);
                    }}
                    className="flex-1 py-3 px-4 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-zinc-950 font-black text-xs uppercase tracking-wider rounded-xl transition shadow-lg shadow-amber-950/60 cursor-pointer"
                  >
                    {gameDialog.options?.[0]?.label || 'Aceptar'}
                  </button>
                  <button
                    onClick={() => {
                      gameDialog.resolver(false);
                      setGameDialog(null);
                    }}
                    className="flex-1 py-3 px-4 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-zinc-300 font-bold text-xs uppercase tracking-wider rounded-xl transition cursor-pointer"
                  >
                    {gameDialog.options?.[1]?.label || 'Cancelar'}
                  </button>
                </div>
              )}

              {gameDialog.type === 'PROMPT' && (
                <div className="flex gap-2.5">
                  <button
                    onClick={() => {
                      const el = document.getElementById('game-dialog-prompt-input') as HTMLInputElement;
                      const val = el ? el.value : (gameDialog.defaultValue || '');
                      gameDialog.resolver(val);
                      setGameDialog(null);
                    }}
                    className="flex-1 py-3 px-4 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-zinc-950 font-black text-xs uppercase tracking-wider rounded-xl transition shadow-lg shadow-amber-950/60 cursor-pointer"
                  >
                    Confirmar
                  </button>
                  <button
                    onClick={() => {
                      gameDialog.resolver(null);
                      setGameDialog(null);
                    }}
                    className="flex-1 py-3 px-4 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 text-zinc-300 font-bold text-xs uppercase tracking-wider rounded-xl transition cursor-pointer"
                  >
                    Cancelar
                  </button>
                </div>
              )}

              {gameDialog.type === 'ALERT' && (
                <button
                  onClick={() => {
                    gameDialog.resolver(true);
                    setGameDialog(null);
                  }}
                  className="w-full py-3 px-4 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-zinc-950 font-black text-xs uppercase tracking-wider rounded-xl transition shadow-lg shadow-amber-950/60 cursor-pointer"
                >
                  Entendido
                </button>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}