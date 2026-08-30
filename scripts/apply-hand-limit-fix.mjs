import fs from 'node:fs';

const path = 'GameBoard.tsx';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(haystack, pattern, replacement, label) {
  const next = haystack.replace(pattern, replacement);
  if (next === haystack) throw new Error(`No se encontró el bloque esperado: ${label}`);
  return next;
}

// 1) Add explicit state for the pending hand-limit decision.
source = replaceOnce(
  source,
  "  const [showHandDiscardModal, setShowHandDiscardModal] = useState(false);\n  const [selectedHandDiscardIds, setSelectedHandDiscardIds] = useState<string[]>([]);",
  "  const [showHandDiscardModal, setShowHandDiscardModal] = useState(false);\n  const [selectedHandDiscardIds, setSelectedHandDiscardIds] = useState<string[]>([]);\n  const [handLimitRequiredCount, setHandLimitRequiredCount] = useState<number | null>(null);",
  'hand-limit state'
);

// 2) Make the socket choice_required event capable of opening the hand-limit UI.
const eventAnchor = "    const onSearchOptions = (data: any) => {";
const eventInsertion = `    const onHandLimitChoice = (choice: any) => {\n      if (!choice) return;\n      const rawKind = String(choice.kind || choice.type || choice.actionType || choice.mode || '').toUpperCase();\n      const isHandLimit = Boolean(choice.handLimit) || /HAND[_\\s-]*LIMIT|MAX[_\\s-]*HAND|HAND[_\\s-]*SIZE|END[_\\s-]*TURN[_\\s-]*DISCARD/.test(rawKind);\n      if (!isHandLimit) return;\n\n      const requested = Number(\n        choice.requiredCount ??\n        choice.discardRequired ??\n        choice.excess ??\n        choice.amount ??\n        choice.count ??\n        0\n      );\n      const required = requested > 0 ? requested : Math.max(0, (hand?.length || 0) - 8);\n      if (required <= 0) return;\n\n      setHandLimitRequiredCount(required);\n      setSelectedHandDiscardIds([]);\n      setShowHandDiscardModal(true);\n      showNotice(\n        \`⚠️ Límite de Mano: debes descartar \${required} carta\${required > 1 ? 's' : ''} para quedar con 8.\`,\n        'warning'\n      );\n    };\n\n`;
source = replaceOnce(source, eventAnchor, eventInsertion + eventAnchor, 'socket hand-limit listener function');

source = replaceOnce(
  source,
  "    socket.on('castle_search_options', onSearchOptions);",
  "    socket.on('choice_required', onHandLimitChoice);\n    socket.on('HAND_LIMIT_REQUIRED', onHandLimitChoice);\n    socket.on('castle_search_options', onSearchOptions);",
  'socket hand-limit listener registration'
);
source = replaceOnce(
  source,
  "      socket.off('castle_search_options', onSearchOptions);",
  "      socket.off('choice_required', onHandLimitChoice);\n      socket.off('HAND_LIMIT_REQUIRED', onHandLimitChoice);\n      socket.off('castle_search_options', onSearchOptions);",
  'socket hand-limit listener cleanup'
);

// 3) Replace the existing hand-limit confirmation with local and Online paths.
const oldConfirm = /  const handleConfirmHandLimitDiscard = \(\) => \{[\s\S]*?\n  \};\n\n  const finalizeEndOfTurn =/;
const newConfirm = `  const handleConfirmHandLimitDiscard = () => {\n    const requiredCount = handLimitRequiredCount ?? Math.max(0, (hand?.length || 0) - 8);\n    if (requiredCount <= 0) {\n      setShowHandDiscardModal(false);\n      setSelectedHandDiscardIds([]);\n      setHandLimitRequiredCount(null);\n      return;\n    }\n\n    if (selectedHandDiscardIds.length !== requiredCount) {\n      alert(\`Debes seleccionar exactamente \${requiredCount} carta\${requiredCount > 1 ? 's' : ''} para descartar (has seleccionado \${selectedHandDiscardIds.length}).\`);\n      return;\n    }\n\n    // Online: el servidor autoritativo decide el movimiento real.\n    if (isMultiplayer) {\n      const sent = sendGameAction({\n        type: 'HAND_LIMIT_DISCARD',\n        action: 'HAND_LIMIT_DISCARD',\n        cardInstanceIds: [...selectedHandDiscardIds],\n        selectedHandDiscardIds: [...selectedHandDiscardIds],\n        requiredCount,\n        handLimit: true\n      });\n\n      if (!sent) {\n        showNotice('No se pudo enviar la decisión de límite de mano al servidor.', 'error');\n        return;\n      }\n\n      setShowHandDiscardModal(false);\n      setSelectedHandDiscardIds([]);\n      setHandLimitRequiredCount(null);\n      return;\n    }\n\n    // Local / VS IA: aplicar exactamente las cartas seleccionadas y NO volver a robar.\n    const discardedCards = (hand || []).filter((c: any) => {\n      const id = String(c?.instanceId ?? c?.id ?? '');\n      return selectedHandDiscardIds.includes(id);\n    });\n\n    if (discardedCards.length !== requiredCount) {\n      alert('Una o más cartas seleccionadas ya no están en tu mano. Vuelve a seleccionarlas.');\n      setSelectedHandDiscardIds([]);\n      return;\n    }\n\n    const discardedIds = new Set(selectedHandDiscardIds.map(String));\n    setHand((prev: any[]) => (prev || []).filter((c: any) => !discardedIds.has(String(c?.instanceId ?? c?.id ?? ''))));\n    setGraveyard((prev: any[]) => [\n      ...(prev || []),\n      ...discardedCards.map((c: any) => ({ ...c, zone: 'GRAVEYARD', isRested: false }))\n    ]);\n    setShowHandDiscardModal(false);\n    setSelectedHandDiscardIds([]);\n    setHandLimitRequiredCount(null);\n    showNotice(\`🗑️ Descartaste \${discardedCards.length} carta\${discardedCards.length > 1 ? 's' : ''} por límite de mano.\`, 'info');\n\n    // El robo de Fase Final ya ocurrió. Continuar sin volver a llamar a drawCardAtFinalPhase().\n    finalizeEndOfTurn(true);\n  };\n\n  const finalizeEndOfTurn =`;
source = replaceOnce(source, oldConfirm, newConfirm, 'hand-limit confirmation');

// 4) Make finalizeEndOfTurn optionally skip the draw after a completed hand-limit decision.
source = replaceOnce(
  source,
  "  const finalizeEndOfTurn = () => {\n    drawCardAtFinalPhase();",
  "  const finalizeEndOfTurn = (skipFinalDraw: boolean = false) => {\n    if (!skipFinalDraw && !drawCardAtFinalPhase()) return;",
  'finalize-end-turn draw gate'
);

// 5) Replace final-phase automatic discard with interactive selection.
const oldDraw = /  const drawCardAtFinalPhase = \(\) => \{[\s\S]*?\n  \};\n\n  \/\/ =========================================================\n  \/\/ JUGAR CARTA/;
const newDraw = `  const drawCardAtFinalPhase = (): boolean => {\n    if (hasDrawnThisFinal) return true;\n\n    const firstPlayerNoDraw = turn === 1 && playerGoesFirst;\n    if (firstPlayerNoDraw) {\n      setHasDrawnThisFinal(true);\n      return true;\n    }\n\n    const currentCastle = castleCardsRef.current || castleCards || [];\n    if (currentCastle.length === 0) {\n      setHasDrawnThisFinal(true);\n      alert('Castillo agotado. ¡Has perdido la partida por quedarte sin cartas en tu Castillo!');\n      return true;\n    }\n\n    const drawn = currentCastle[0];\n    const remainingCastle = currentCastle.slice(1);\n    const nextHand = [...(hand || []), drawn];\n\n    castleCardsRef.current = remainingCastle;\n    setHasDrawnThisFinal(true);\n    setCastleCards(remainingCastle);\n    setHand(nextHand);\n\n    setDrawnCardAnim({\n      cards: [drawn],\n      count: 1\n    });\n    setTimeout(() => setDrawnCardAnim(null), 1600);\n\n    // Regla de límite: después del Robo de Fase Final, si superas 8,\n    // el jugador elige exactamente qué cartas conserva/descarta.\n    const excess = nextHand.length - 8;\n    if (excess > 0) {\n      setHandLimitRequiredCount(excess);\n      setSelectedHandDiscardIds([]);\n      setShowHandDiscardModal(true);\n      showNotice(\n        \`⚠️ Límite de Mano: tienes \${nextHand.length} cartas. Debes descartar \${excess} para quedar con 8.\`,\n        'warning'\n      );\n      return false;\n    }\n\n    return true;\n  };\n\n  // =========================================================\n  // JUGAR CARTA`;
source = replaceOnce(source, oldDraw, newDraw, 'final-phase draw');

// 6) Local end-of-turn must not pre-open the modal before the final draw.
const oldFinalBlock = /    if \(isLastPhase\) \{\n      \/\/ Regla DAR: Límite de 8 cartas en mano al finalizar Fase Final\n      if \(\(hand\?\.length \|\| 0\) > 8\) \{[\s\S]*?\n      finalizeEndOfTurn\(\);\n      return;\n    \}/;
const newFinalBlock = `    if (isLastPhase) {\n      // El check de límite ocurre dentro de drawCardAtFinalPhase(), justo después del Robo de Fase Final.\n      finalizeEndOfTurn();\n      return;\n    }`;
source = replaceOnce(source, oldFinalBlock, newFinalBlock, 'final-phase transition block');

// 7) Add the actual interactive hand-discard modal. It blocks progression until exact selection.
const renderAnchor = "  // =========================================================\n  // ROBO FASE FINAL\n  // =========================================================\n";
const handModal = `  // =========================================================\n  // MODAL LÍMITE DE MANO — DESCARTE INTERACTIVO\n  // =========================================================\n  const renderHandDiscardModal = () => {\n    if (!showHandDiscardModal) return null;\n\n    const requiredCount = handLimitRequiredCount ?? Math.max(0, (hand?.length || 0) - 8);\n    if (requiredCount <= 0) return null;\n\n    const isSelected = (card: any) => selectedHandDiscardIds.includes(String(card?.instanceId ?? card?.id ?? ''));\n\n    const toggleDiscard = (card: any) => {\n      const id = String(card?.instanceId ?? card?.id ?? '');\n      if (!id) return;\n      setSelectedHandDiscardIds((prev) => {\n        if (prev.includes(id)) return prev.filter((x) => x !== id);\n        if (prev.length >= requiredCount) return prev;\n        return [...prev, id];\n      });\n    };\n\n    return (\n      <div className="fixed inset-0 z-[10020] bg-black/90 backdrop-blur-xl flex items-center justify-center p-4 select-none">\n        <div className="w-full max-w-4xl max-h-[92dvh] bg-gradient-to-b from-[#18130e] via-[#0d0a07] to-black border-2 border-amber-500/70 rounded-3xl shadow-[0_0_70px_rgba(245,158,11,0.25)] p-4 sm:p-6 flex flex-col">\n          <div className="flex items-center justify-between gap-4 border-b border-amber-500/20 pb-3 mb-3">\n            <div>\n              <span className="text-[10px] uppercase tracking-[0.2em] font-black text-amber-400">Límite de Mano</span>\n              <h2 className="text-xl sm:text-2xl font-black text-zinc-100 uppercase tracking-wide">Descarta hasta quedar con 8</h2>\n              <p className="text-xs text-zinc-400 mt-1">Selecciona exactamente <strong className="text-amber-300">{requiredCount}</strong> carta{requiredCount === 1 ? '' : 's'} para enviar al Cementerio.</p>\n            </div>\n            <div className="shrink-0 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 font-black text-sm">\n              {selectedHandDiscardIds.length} / {requiredCount}\n            </div>\n          </div>\n\n          <div className="flex-1 overflow-y-auto py-2 pr-1">\n            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">\n              {(hand || []).map((card: any, index: number) => {\n                const selected = isSelected(card);\n                return (\n                  <button\n                    key={String(card?.instanceId ?? card?.id ?? index)}\n                    type="button"\n                    onClick={() => toggleDiscard(card)}\n                    className={\`relative aspect-[2/3] rounded-xl overflow-hidden border-2 transition-all transform \${\n                      selected\n                        ? 'border-red-400 ring-4 ring-red-500/30 scale-105 shadow-xl shadow-red-950/40'\n                        : 'border-zinc-700 hover:border-amber-400 hover:scale-105'\n                    }\`}\n                  >\n                    {card?.imageUrl ? (\n                      <img src={card.imageUrl} alt={card.name || 'Carta'} className="w-full h-full object-contain bg-black" />\n                    ) : (\n                      <div className="w-full h-full bg-zinc-900 flex items-center justify-center p-2 text-center">\n                        <span className="text-[9px] font-bold text-zinc-300">{card?.name || 'Carta'}</span>\n                      </div>\n                    )}\n                    <div className="absolute inset-x-0 bottom-0 bg-black/80 px-1 py-1 text-center">\n                      <span className="text-[8px] font-bold text-zinc-100 line-clamp-1">{card?.name || 'Carta'}</span>\n                    </div>\n                    {selected && (\n                      <div className="absolute inset-0 bg-red-500/15 flex items-center justify-center">\n                        <span className="w-9 h-9 rounded-full bg-red-500 text-white font-black flex items-center justify-center shadow-lg">✓</span>\n                      </div>\n                    )}\n                  </button>\n                );\n              })}\n            </div>\n          </div>\n\n          <div className="border-t border-zinc-800 pt-3 mt-3 flex items-center justify-between gap-3">\n            <div className="text-xs text-zinc-400">\n              Tu mano quedará en <strong className="text-amber-300">8 cartas</strong> después del descarte.\n            </div>\n            <button\n              type="button"\n              disabled={selectedHandDiscardIds.length !== requiredCount}\n              onClick={handleConfirmHandLimitDiscard}\n              className="px-6 py-3 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-white font-black text-xs uppercase tracking-wider rounded-xl shadow-lg transition"\n            >\n              Descartar {requiredCount} y continuar\n            </button>\n          </div>\n        </div>\n      </div>\n    );\n  };\n\n`;
source = replaceOnce(source, renderAnchor, handModal + renderAnchor, 'hand-limit modal renderer');

// 8) Render the new modal in the main render tree.
source = replaceOnce(
  source,
  "      {renderHandSelectionModal()}\n      {renderDrawCardAnimation()}",
  "      {renderHandSelectionModal()}\n      {renderHandDiscardModal()}\n      {renderDrawCardAnimation()}",
  'hand-limit modal mount'
);

fs.writeFileSync(path, source, 'utf8');
console.log('Hand-limit patch applied successfully.');
