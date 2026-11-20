const app = document.querySelector('#app');
const clientConfig = window.PHRASE_PHONE_CONFIG || {};
let db = null;
let roomCode = '';
let playerToken = sessionStorage.getItem('pp-token') || crypto.randomUUID();
let roomData = null;
let isHost = false;
let poller = null;
let busy = false;
let refreshSequence = 0;
let revealIndex = -1;
let narratorMode = 'idle';
let narratorState = 'idle';
let narratorNotice = '';
let narratorRunId = 0;

sessionStorage.setItem('pp-token', playerToken);

function setTheme(theme) {
  const mode = theme === 'night' ? 'night' : 'day';
  const night = mode === 'night';
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('phrase-phone-theme', mode); } catch {}
  const button = document.querySelector('#theme-toggle');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = night ? '#11101d' : '#f6f4ff';
  if (button) {
    button.setAttribute('aria-label', night ? 'Activer le thème jour' : 'Activer le thème nuit');
    button.setAttribute('aria-pressed', String(night));
    button.innerHTML = `<span class="theme-icon" aria-hidden="true">${night ? '☀' : '☾'}</span><span class="theme-label">${night ? 'Jour' : 'Nuit'}</span>`;
  }
}

document.querySelector('#theme-toggle')?.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'night' ? 'day' : 'night');
});
document.addEventListener('keydown', event => {
  if (roomData?.status !== 'finished') return;
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepReveal(1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepReveal(-1);
  } else if (event.key === 'Escape') {
    revealIndex = -1;
    renderReveal();
  }
});
let savedTheme = 'day';
try { savedTheme = localStorage.getItem('phrase-phone-theme') || 'day'; } catch {}
setTheme(savedTheme);

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function setupBackend() {
  if (!clientConfig.url || !clientConfig.key || clientConfig.url.includes('COLLER_') || clientConfig.key.includes('COLLER_')) return;
  if (!window.supabase) {
    app.dataset.error = 'Le service de connexion n’a pas chargé. Recharge la page.';
    return;
  }
  db = window.supabase.createClient(clientConfig.url, clientConfig.key);
}

function showError(message) {
  const box = document.querySelector('#error');
  if (box) {
    box.textContent = message;
    box.classList.remove('hidden');
  }
}

function clearError() {
  const box = document.querySelector('#error');
  if (box) box.classList.add('hidden');
}

function backendRequired() { return !!db; }

function renderCreate() {
  app.innerHTML = `<div class="eyebrow">Créer une partie</div><h2>Donne-toi un prénom</h2><p>Tout le monde écrira sa propre histoire dès le début.</p><label class="field-label" for="player-name">Ton prénom</label><input id="player-name" maxlength="18" placeholder="Ex. Camille" autocomplete="nickname"><div id="error" class="error hidden"></div><div class="actions"><button class="secondary" onclick="renderHome()">Retour</button><button class="right" onclick="createRoom()">Créer le salon →</button></div>`;
}

function renderJoin() {
  app.innerHTML = `<div class="eyebrow">Rejoindre une partie</div><h2>Entre le code du salon</h2><p>Demande le code à la personne qui a créé la partie.</p><label class="field-label" for="room-code">Code du salon</label><input id="room-code" maxlength="6" placeholder="ABC123" style="text-transform:uppercase;letter-spacing:5px;font-weight:800" oninput="this.value=this.value.toUpperCase()"><label class="field-label" for="player-name">Ton prénom</label><input id="player-name" maxlength="18" placeholder="Ex. Camille" autocomplete="nickname"><div id="error" class="error hidden"></div><div class="actions"><button class="secondary" onclick="renderHome()">Retour</button><button class="right" onclick="joinRoom()">Rejoindre →</button></div>`;
}

function renderRoom() {
  if (!roomData) return;
  const { status, players = [], stories = [] } = roomData;
  const myTurn = roomData.is_my_turn === true;
  const hasSubmitted = roomData.has_submitted === true;
  const playerCount = players.length;

  if (status === 'lobby') {
    app.innerHTML = `<div class="eyebrow">Salon en attente</div><h2>Invite tes amis ✉️</h2><p>Envoie le code : chacun commencera sa propre histoire, puis les textes passeront d’un joueur à l’autre.</p><div class="room-code">${esc(roomCode)}</div><button class="secondary" onclick="copyInvite()">Copier le lien d’invitation</button><div class="lobby-list"><strong>Joueurs · ${playerCount}/12</strong>${players.map((player, index) => `<div class="player-row"><span class="avatar">${esc(player.name.slice(0, 1).toUpperCase())}</span>${esc(player.name)}${index === 0 ? '<span class="host-label">HÔTE</span>' : ''}</div>`).join('')}</div><div id="error" class="error hidden"></div><div class="actions"><button class="secondary" onclick="leaveRoom()">Quitter</button>${isHost ? `<button class="right" onclick="startRoom()" ${playerCount < 2 ? 'disabled' : ''}>Commencer la partie →</button>` : '<span class="right hint">En attente du lancement par l’hôte…</span>'}</div>${playerCount < 2 ? '<div class="hint">Il faut au moins 2 joueurs pour commencer.</div>' : ''}`;
    return;
  }

  if (status === 'openings') {
    const progress = Math.round((roomData.submitted_count || 0) / playerCount * 100);
    const content = myTurn
      ? `<div class="stage-chip"><span>✦</span> Ton histoire commence ici</div><h2>Écris le début ✍️</h2><p>Chaque joueur invente une histoire en secret. Elles vont ensuite tourner dans le salon.</p><label class="field-label" for="next-line">La première phrase</label><textarea id="next-line" maxlength="240" placeholder="Tout a commencé le jour où…" oninput="document.querySelector('#send').disabled=!this.value.trim()"></textarea><div id="error" class="error hidden"></div><div class="actions"><button id="send" class="right" disabled onclick="submitTurn()">Lancer mon histoire →</button></div>`
      : `<div class="waiting-icon">✍️</div><div class="stage-chip"><span>✦</span> ${roomData.submitted_count || 0} / ${playerCount} histoires lancées</div><h2>${hasSubmitted ? 'Ton début est envoyé !' : 'À toi de trouver une idée…'}</h2><p>${hasSubmitted ? 'Les autres joueurs écrivent leur ouverture. Les histoires démarreront toutes ensemble.' : 'Les autres écrivent aussi leur début en même temps. Rien n’est encore révélé.'}</p><div class="notice">Cette page se met à jour automatiquement.</div>`;
    app.innerHTML = `<div class="progress"><span style="width:${progress}%"></span></div><div class="turn-top"><div class="eyebrow" style="margin:0">Départs en cours</div><span class="counter">${roomData.submitted_count || 0} / ${playerCount} débuts</span></div>${content}`;
    return;
  }

  if (status === 'playing') {
    const round = roomData.round_number || 1;
    const totalRounds = roomData.round_total || Math.max(1, playerCount - 1);
    const progress = Math.round((roomData.submitted_count || 0) / playerCount * 100);
    const prompt = roomData.previous_phrase ? `<div class="prompt"><small>La phrase précédente</small>${esc(roomData.previous_phrase)}</div>` : '';
    const content = myTurn
      ? `<div class="stage-chip"><span>↗</span> Une histoire vient d’arriver</div><h2>À toi d’écrire la suite ✍️</h2><p>Tu ne vois que la dernière phrase de cette histoire. Ajoute ta suite, puis elle continuera son chemin.</p>${prompt}<label class="field-label" for="next-line">Ta phrase</label><textarea id="next-line" maxlength="240" placeholder="Et puis…" oninput="document.querySelector('#send').disabled=!this.value.trim()"></textarea><div id="error" class="error hidden"></div><div class="actions"><button id="send" class="right" disabled onclick="submitTurn()">Envoyer ma phrase →</button></div>`
      : `<div class="waiting-icon">⏳</div><div class="stage-chip"><span>✓</span> ${roomData.submitted_count || 0} / ${playerCount} phrases envoyées</div><h2>Ta phrase est envoyée !</h2><p>Les autres joueurs écrivent leur suite pour cette manche. Les histoires avanceront ensemble quand tout le monde aura terminé.</p><div class="notice">La prochaine histoire apparaîtra automatiquement ici.</div>`;
    app.innerHTML = `<div class="progress"><span style="width:${progress}%"></span></div><div class="turn-top"><div class="eyebrow" style="margin:0">Les histoires tournent</div><span class="counter">Manche ${round} / ${totalRounds}</span></div>${content}`;
    return;
  }

  if (status === 'finished') {
    renderReveal();
  }
}

function renderReveal() {
  if (!roomData || roomData.status !== 'finished') return;
  const stories = roomData.stories || [];
  const phraseCount = stories.reduce((sum, story) => sum + story.lines.length, 0);
  const total = stories.length;
  const progress = revealIndex < 0 ? 0 : Math.min(100, Math.round((revealIndex + 1) / Math.max(1, total) * 100));
  const dots = stories.map((story, index) => `<button class="reveal-dot ${revealIndex === index ? 'active' : ''}" aria-label="Voir l’histoire ${index + 1}" title="Histoire ${index + 1}" onclick="goToReveal(${index})"></button>`).join('');
  const narratorAvailable = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

  if (revealIndex < 0) {
    app.innerHTML = `<div class="reveal-view reveal-intro"><div class="reveal-progress"><span style="width:0%"></span></div><div class="reveal-orbit" aria-hidden="true"><span>✦</span><i></i><b></b></div><div class="eyebrow">LE GRAND DÉVOILEMENT</div><h2>Tout le monde a écrit.<br>Place aux histoires.</h2><p>${total} récits ont voyagé de joueur en joueur. Vous avez créé ${phraseCount} phrases ensemble.</p><div class="reveal-summary"><span><strong>${total}</strong><small>histoires</small></span><span><strong>${phraseCount}</strong><small>phrases</small></span><span><strong>${roomData.players.length}</strong><small>joueurs</small></span></div><div class="actions center reveal-actions"><button onclick="startReveal()">Lancer la révélation <span aria-hidden="true">→</span></button><button class="secondary" onclick="startAllNarration()" ${narratorAvailable ? '' : 'disabled'}>🔊 Écouter toutes les histoires</button></div>${narratorNotice ? `<div class="narrator-message">${esc(narratorNotice)}</div>` : ''}<div class="reveal-bottom"><button class="text-button" onclick="shareStory()">Copier les histoires</button><button class="text-button" onclick="leaveRoom()">Quitter le salon</button></div><div id="share-status" class="hint"></div></div>`;
    return;
  }

  if (revealIndex >= total) {
    app.innerHTML = `<div class="reveal-view reveal-ending"><div class="reveal-progress"><span style="width:100%"></span></div><div class="reveal-endmark" aria-hidden="true">✦</div><div class="eyebrow">FIN DE LA RÉVÉLATION</div><h2>Vous avez tout inventé.<br>Et rien n’était prévu.</h2><p>${total} histoires, ${phraseCount} phrases et sûrement quelques fous rires à raconter.</p><div class="reveal-end-actions"><button onclick="goToReveal(0)">Revoir les histoires</button><button class="secondary" onclick="startAllNarration()" ${narratorAvailable ? '' : 'disabled'}>🔊 Réécouter tout</button><button class="secondary" onclick="shareStory()">Copier toutes les histoires ↗</button><button class="text-button" onclick="leaveRoom()">Quitter le salon</button></div>${narratorNotice ? `<div class="narrator-message">${esc(narratorNotice)}</div>` : ''}<div id="share-status" class="hint"></div></div>`;
    return;
  }

  const story = stories[revealIndex];
  const lines = story.lines.map((line, lineIndex) => `<article class="reveal-phrase ${lineIndex === 0 ? 'reveal-opening' : ''}"><div class="reveal-phrase-meta"><span>${lineIndex === 0 ? 'LE DÉBUT' : `PHRASE ${String(lineIndex + 1).padStart(2, '0')}`}</span><strong>${esc(line.name)}</strong></div><p>${esc(line.text)}</p></article>`).join('');
  const previousLabel = revealIndex === 0 ? '← Intro' : '← Précédente';
  const nextLabel = revealIndex === total - 1 ? 'Terminer →' : 'Suivante →';
  const narratorControls = narratorAvailable ? renderNarratorControls(revealIndex, total) : '<div class="narrator-message">La lecture vocale n’est pas disponible dans ce navigateur.</div>';
  app.innerHTML = `<div class="reveal-view"><div class="reveal-progress"><span style="width:${progress}%"></span></div><div class="reveal-topline"><span class="eyebrow">RÉVÉLATION · ${String(revealIndex + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span><span class="reveal-hint">Utilise ← et → pour avancer</span></div><article class="reveal-story"><div class="reveal-story-heading"><div class="reveal-stamp">✦</div><div><span class="story-kicker">L’HISTOIRE DE</span><h2>${esc(story.owner)}</h2></div><span class="story-count">${story.lines.length} phrases</span></div><div class="reveal-phrases">${lines}</div></article>${narratorControls}${narratorNotice ? `<div class="narrator-message">${esc(narratorNotice)}</div>` : ''}<div class="reveal-dots" aria-label="Choisir une histoire">${dots}</div><div class="reveal-controls"><button class="secondary" onclick="stepReveal(-1)">${previousLabel}</button><span>Histoire ${revealIndex + 1} sur ${total}</span><button onclick="stepReveal(1)">${nextLabel}</button></div><div class="reveal-bottom"><button class="text-button" onclick="shareStory()">Copier toutes les histoires</button><button class="text-button" onclick="leaveRoom()">Quitter</button></div><div id="share-status" class="hint"></div></div>`;
}

function startReveal() {
  stopNarration(false);
  revealIndex = 0;
  renderReveal();
}

function stepReveal(direction) {
  stopNarration(false);
  const total = roomData?.stories?.length || 0;
  revealIndex = Math.max(-1, Math.min(total, revealIndex + direction));
  renderReveal();
}

function goToReveal(index) {
  stopNarration(false);
  const total = roomData?.stories?.length || 0;
  revealIndex = Math.max(0, Math.min(total - 1, index));
  renderReveal();
}

function renderNarratorControls(index, total) {
  if (narratorState === 'speaking') {
    return `<div class="narrator-dock is-speaking"><div class="narrator-indicator"><span class="sound-bars"><i></i><i></i><i></i></span><span>Le narrateur lit ${narratorMode === 'all' ? 'toutes les histoires' : 'cette histoire'}</span></div><div class="narrator-buttons"><button class="secondary" onclick="pauseNarration()">Ⅱ Pause</button><button class="text-button" onclick="stopNarration()">Arrêter</button></div></div>`;
  }
  if (narratorState === 'paused') {
    return `<div class="narrator-dock is-paused"><div class="narrator-indicator"><span class="sound-bars paused"><i></i><i></i><i></i></span><span>Lecture en pause</span></div><div class="narrator-buttons"><button onclick="resumeNarration()">▶ Reprendre</button><button class="text-button" onclick="stopNarration()">Arrêter</button></div></div>`;
  }
  const replayLabel = narratorState === 'done' ? '↻ Réécouter cette histoire' : '▶ Écouter cette histoire';
  return `<div class="narrator-dock"><div class="narrator-indicator"><span class="narrator-icon">◖))</span><span>${narratorState === 'done' ? 'Lecture terminée' : 'Un narrateur peut lire le récit à voix haute'}</span></div><div class="narrator-buttons"><button class="secondary" onclick="startStoryNarration(${index})">${replayLabel}</button><button class="text-button" onclick="startAllNarration(${index})">Tout écouter ↗</button></div></div>`;
}

function startStoryNarration(index) {
  speakStory(index, 'single');
}

function startAllNarration(startIndex = 0) {
  speakStory(startIndex, 'all');
}

function speakStory(index, mode) {
  const voiceEngine = window.speechSynthesis;
  if (!voiceEngine || typeof SpeechSynthesisUtterance === 'undefined') {
    narratorMode = 'idle';
    narratorState = 'error';
    narratorNotice = 'La lecture vocale n’est pas disponible dans ce navigateur.';
    renderReveal();
    return;
  }
  const stories = roomData?.stories || [];
  if (!stories[index]) return;
  const runId = ++narratorRunId;
  voiceEngine.cancel();
  const story = stories[index];
  const speechText = [`Histoire de ${story.owner}.`, ...story.lines.map((line, lineIndex) => lineIndex === 0 ? `Le début, écrit par ${line.name} : ${line.text}` : `Puis ${line.name} écrit : ${line.text}`)].join(' ');
  const utterance = new SpeechSynthesisUtterance(speechText);
  utterance.lang = 'fr-FR';
  utterance.rate = 0.94;
  utterance.pitch = 1;
  const frenchVoice = voiceEngine.getVoices().find(voice => voice.lang?.toLowerCase().startsWith('fr'));
  if (frenchVoice) utterance.voice = frenchVoice;
  narratorMode = mode;
  narratorState = 'speaking';
  narratorNotice = '';
  revealIndex = index;
  renderReveal();
  utterance.onend = () => {
    if (runId !== narratorRunId) return;
    if (mode === 'all') {
      const nextIndex = index + 1;
      if (nextIndex < stories.length) {
        speakStory(nextIndex, 'all');
      } else {
        revealIndex = stories.length;
        narratorMode = 'idle';
        narratorState = 'done';
        renderReveal();
      }
    } else {
      narratorMode = 'idle';
      narratorState = 'done';
      renderReveal();
    }
  };
  utterance.onerror = event => {
    if (runId !== narratorRunId || event.error === 'canceled' || event.error === 'interrupted') return;
    narratorMode = 'idle';
    narratorState = 'error';
    narratorNotice = 'La voix n’a pas pu démarrer. Réessaie ou change de navigateur.';
    renderReveal();
  };
  voiceEngine.speak(utterance);
}

function pauseNarration() {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.pause();
  narratorState = 'paused';
  renderReveal();
}

function resumeNarration() {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.resume();
  narratorState = 'speaking';
  renderReveal();
}

function stopNarration(shouldRender = true) {
  narratorRunId++;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  narratorMode = 'idle';
  narratorState = 'idle';
  narratorNotice = '';
  if (shouldRender && roomData?.status === 'finished') renderReveal();
}

async function rpc(name, args) {
  if (!db) throw new Error('Le backend du jeu n’est pas configuré.');
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

async function createRoom() {
  if (!backendRequired()) return showError('Le jeu en ligne doit d’abord être relié au service de salons. Consulte le fichier LISEZ-MOI pour terminer la configuration.');
  const name = document.querySelector('#player-name').value.trim();
  if (!name) return showError('Écris ton prénom pour créer le salon.');
  if (busy) return;
  busy = true;
  try {
    const data = await rpc('pp_create_room', { p_name: name, p_token: playerToken });
    roomCode = data.code;
    isHost = true;
    await refreshRoom();
  } catch (error) { showError(friendlyError(error)); }
  finally { busy = false; }
}

async function joinRoom() {
  if (!backendRequired()) return showError('Le jeu en ligne doit d’abord être relié au service de salons. Consulte le fichier LISEZ-MOI pour terminer la configuration.');
  const name = document.querySelector('#player-name').value.trim();
  const code = document.querySelector('#room-code').value.trim().toUpperCase();
  if (!name || !code) return showError('Entre le code du salon et ton prénom.');
  if (busy) return;
  busy = true;
  try {
    await rpc('pp_join_room', { p_code: code, p_name: name, p_token: playerToken });
    roomCode = code;
    isHost = false;
    await refreshRoom();
  } catch (error) { showError(friendlyError(error)); }
  finally { busy = false; }
}

async function refreshRoom() {
  const requestCode = roomCode;
  const requestSequence = ++refreshSequence;
  const field = document.querySelector('#next-line');
  const draft = field?.value || '';
  const hadFocus = !!field && document.activeElement === field;
  const selectionStart = field?.selectionStart ?? draft.length;
  const selectionEnd = field?.selectionEnd ?? draft.length;
  const previousPhase = roomData ? `${roomData.status}:${roomData.round_number || 0}` : null;
  try {
    const updatedRoom = await rpc('pp_get_room', { p_code: requestCode, p_token: playerToken });
    if (requestSequence !== refreshSequence || requestCode !== roomCode) return;
    roomData = updatedRoom;
    isHost = roomData.is_host === true;
    renderRoom();
    const nextField = document.querySelector('#next-line');
    const nextPhase = `${roomData.status}:${roomData.round_number || 0}`;
    if (nextField && roomData.is_my_turn && previousPhase === nextPhase) {
      nextField.value = draft;
      const sendButton = document.querySelector('#send');
      if (sendButton) sendButton.disabled = !draft.trim();
      if (hadFocus) {
        nextField.focus({ preventScroll: true });
        nextField.setSelectionRange(selectionStart, selectionEnd);
      }
    }
    if (roomData.status === 'finished') {
      clearInterval(poller);
      poller = null;
    } else if (!poller) {
      poller = setInterval(refreshRoom, 2500);
    }
  } catch (error) {
    if (requestSequence !== refreshSequence || requestCode !== roomCode) return;
    if (!roomData) renderHome();
    showError(friendlyError(error));
  }
}

async function startRoom() {
  if (busy) return;
  busy = true;
  try {
    await rpc('pp_start_room', { p_code: roomCode, p_token: playerToken });
    await refreshRoom();
  } catch (error) { showError(friendlyError(error)); }
  finally { busy = false; }
}

async function submitTurn() {
  if (busy) return;
  const field = document.querySelector('#next-line');
  const text = field?.value.trim();
  if (!text) return;
  busy = true;
  try {
    await rpc('pp_submit_turn', { p_code: roomCode, p_token: playerToken, p_text: text });
    await refreshRoom();
  } catch (error) { showError(friendlyError(error)); }
  finally { busy = false; }
}

function friendlyError(error) {
  const message = String(error?.message || '');
  if (/room_not_found/i.test(message)) return 'Ce code ne correspond à aucun salon. Vérifie-le et réessaie.';
  if (/room_full/i.test(message)) return 'Ce salon est complet (12 joueurs maximum).';
  if (/room_started/i.test(message)) return 'La partie a déjà commencé, impossible de la rejoindre.';
  if (/not_your_turn/i.test(message)) return 'Tu as peut-être déjà envoyé ta phrase. Attends la prochaine manche.';
  if (/already_submitted/i.test(message)) return 'Ta phrase est déjà envoyée. Les histoires avancent dès que tout le monde a terminé.';
  if (/old_room/i.test(message)) return 'Ce salon utilise une ancienne partie. Crée un nouveau salon pour jouer avec les histoires multiples.';
  if (/room_not_waiting|room_already_started/i.test(message)) return 'La partie n’est pas dans le bon état pour cette action.';
  if (/duplicate|already_joined/i.test(message)) return 'Ce prénom est déjà utilisé dans ce salon.';
  if (/need_players/i.test(message)) return 'Il faut au moins 2 joueurs pour lancer la partie.';
  return 'Oups, la connexion a échoué. Vérifie ta connexion et réessaie.';
}

function copyInvite() {
  const link = new URL(location.href);
  link.searchParams.set('salon', roomCode);
  navigator.clipboard.writeText(link.href).then(() => {
    const list = document.querySelector('.lobby-list');
    if (list) list.insertAdjacentHTML('beforebegin', '<div class="hint">Lien copié !</div>');
  }).catch(() => showError('Impossible de copier le lien automatiquement.'));
}

function shareStory() {
  const text = roomData.stories.map((story, index) => `Histoire ${index + 1} — Le début de ${story.owner}\n\n${story.lines.map((line, lineIndex) => `${lineIndex + 1}. ${line.name} : ${line.text}`).join('\n')}`).join('\n\n────────────────────\n\n');
  navigator.clipboard.writeText(text).then(() => {
    const status = document.querySelector('#share-status');
    if (status) status.textContent = 'Toutes les histoires sont copiées !';
  }).catch(() => {
    const status = document.querySelector('#share-status');
    if (status) status.textContent = 'Impossible de copier automatiquement.';
  });
}

function leaveRoom() {
  stopNarration(false);
  clearInterval(poller);
  poller = null;
  roomCode = '';
  roomData = null;
  isHost = false;
  revealIndex = -1;
  history.replaceState({}, '', location.pathname);
  renderHome();
}

function renderHome() {
  clearInterval(poller);
  poller = null;
  app.innerHTML = `<div class="hero"><div class="hero-art"><span class="hero-spark one">✦</span><img class="hero-logo" src="logo.svg" alt=""><span class="hero-spark two">✧</span></div><div class="eyebrow"><span class="eyebrow-dot"></span> LE JEU D’ÉCRITURE À DISTANCE</div><h1>Un début chacun.<br>Des histoires sans fin.</h1><p>Tout le monde lance un récit. Puis les histoires passent de main en main, une phrase à la fois. À la fin, découvrez où elles ont atterri.</p><div class="actions center"><button onclick="renderCreate()">Créer un salon <span aria-hidden="true">→</span></button><button class="secondary" onclick="renderJoin()">J’ai un code de salon</button></div><div class="feature-strip"><div class="feature"><span class="feature-icon">✍</span><span><strong>Tout le monde écrit</strong><small>Chacun lance son histoire</small></span></div><div class="feature"><span class="feature-icon">↗</span><span><strong>À distance</strong><small>Chacun sur son écran</small></span></div><div class="feature"><span class="feature-icon">✦</span><span><strong>Plusieurs fins</strong><small>Révélation des récits à la fin</small></span></div></div>${!db ? '<div class="notice">Le service des salons n’est pas configuré.</div>' : ''}</div>`;
}

async function boot() {
  setupBackend();
  const invite = new URLSearchParams(location.search).get('salon');
  if (invite && db) {
    roomCode = invite.toUpperCase();
    try { await rpc('pp_join_room', { p_code: roomCode, p_name: '', p_token: playerToken }); } catch {}
    renderJoin();
    document.querySelector('#room-code').value = roomCode;
  } else {
    renderHome();
  }
}

boot();
