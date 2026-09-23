// ── Auth ──
let currentUser = null; // { id, email, displayName }

const authScreen     = document.getElementById('auth-screen');
const appEl          = document.getElementById('app');
const authError      = document.getElementById('auth-error');
const userDisplayEl  = document.getElementById('user-display-name');

// Tab switching
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.getElementById('login-form').classList.toggle('hidden', target !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', target !== 'register');
    authError.textContent = '';
  });
});

async function authFetch(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include', // send/receive cookies
  });
  return { ok: res.ok, data: await res.json() };
}

async function checkSession() {
  try {
    const res = await fetch('/auth/me', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      enterApp(data);
    }
  } catch {}
}

function enterApp(user) {
  currentUser = user;
  authScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  userDisplayEl.textContent = user.displayName;
  myIdEl.textContent = user.displayName;
  document.getElementById('my-avatar').textContent = user.displayName.slice(0, 2).toUpperCase();
  // Auto-connect WebSocket
  connectWS();
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const btn = document.getElementById('login-btn');
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { authError.textContent = 'fill in all fields'; return; }
  btn.disabled = true;
  authError.textContent = '';
  const { ok, data } = await authFetch('/auth/login', { email, password });
  btn.disabled = false;
  if (ok) { enterApp(data); }
  else { authError.textContent = data.error || 'login failed'; }
});

// Submit login form on Enter from any login input
document.getElementById('login-form').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

document.getElementById('register-btn').addEventListener('click', async () => {
  const btn = document.getElementById('register-btn');
  const email = document.getElementById('reg-email').value.trim();
  const displayName = document.getElementById('reg-display').value.trim();
  const password = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;
  if (!email || !displayName || !password) { authError.textContent = 'fill in all fields'; return; }
  if (password !== password2) { authError.textContent = 'passwords do not match'; return; }
  if (password.length < 6) { authError.textContent = 'password must be at least 6 characters'; return; }
  btn.disabled = true;
  authError.textContent = '';
  const { ok, data } = await authFetch('/auth/register', { email, displayName, password });
  btn.disabled = false;
  if (ok) { enterApp(data); }
  else { authError.textContent = data.error || 'registration failed'; }
});

// Submit register form on Enter from any register input
document.getElementById('register-form').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('register-btn').click();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  location.reload();
});

// Check for existing session on page load
checkSession();

// ── State ──
let ws = null;
let myId = null;
let activePeerId = null;
let peerConnection = null;
let localStream = null;
let incomingCallerId = null;
let incomingOffer = null;
let pendingCallPeerId = null;
let iceQueue = []; // buffer ICE candidates that arrive before peerConnection is ready
let callTimerInterval = null;
let callSeconds = 0;
let micMuted = false;
let camOff = false;
let remoteAudioMuted = false;
let remoteVideoMuted = false;

const peers = {};
const peerNames = {}; // id -> displayName

// ── DOM refs ──
const $ = id => document.getElementById(id);
const statusPill = $('status-pill');
const statusText = $('status-text');
const myIdEl = $('my-id');
const peersList = $('peers-list');
const noPeers = $('no-peers');
const remoteVideo = $('remote-video');
const localVideo = $('local-video');
const idleScreen = $('idle-screen');
const rtcBadge = $('rtc-state-badge');
const rtcStateText = $('rtc-state-text');
const callBanner = $('call-banner');
const callBannerLabel = $('call-banner-label');
const acceptBtn = $('accept-btn');
const rejectBtn = $('reject-btn');
const callPeerLabel = $('call-peer-label');
const callTimer = $('call-timer');
const btnMic = $('btn-mic');
const btnCam = $('btn-cam');
const btnHangup = $('btn-hangup');
const btnStartCall = $('btn-start-call');
const chatMessages = $('chat-messages');
const chatInput = $('chat-input');
const sendBtn = $('send-btn');

// ── ICE Config ──
// Use empty iceServers — on a LAN, direct host candidates are sufficient
const iceConfig = {
  iceServers: [],
  iceTransportPolicy: 'all',
};

// ── Utilities ──
function shortId(id) { return id ? id.slice(0, 6).toUpperCase() : '??'; }
function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return m + ':' + sec;
}
// Escape user-controlled strings before inserting into innerHTML
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const systemLogEl = document.getElementById('system-log');
function addSystemMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg-system';
  el.textContent = text;
  systemLogEl.appendChild(el);
  systemLogEl.scrollTop = systemLogEl.scrollHeight;
  // Cap at 50 entries so the log doesn't grow without bound
  while (systemLogEl.children.length > 50) systemLogEl.removeChild(systemLogEl.firstChild);
}
// addChatMsg replaced by renderMsg + receiveChat (per-peer conversations)

// ── WebSocket ──
let reconnectEnabled = true;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = proto + '://' + location.host;
  try {
    ws = new WebSocket(url);
  } catch(e) {
    addSystemMsg('could not connect to signaling server');
    return;
  }

  statusText.textContent = 'connecting…';

  ws.onopen = () => {
    setStatus('connected');
    ws.send(JSON.stringify({ type: 'auth' }));
    addSystemMsg('connected to signaling server');
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleSignal(msg);
  };

  ws.onclose = () => {
    setStatus('offline');
    myIdEl.textContent = currentUser ? (currentUser.displayName) : '—';
    myId = null;
    activePeerId = null;
    clearPeers();
    if (reconnectEnabled) {
      addSystemMsg('disconnected — reconnecting…');
      setTimeout(connectWS, 3000);
    }
  };

  ws.onerror = () => {
    addSystemMsg('connection error');
  };
}

function disconnectWS() {
  if (ws) {
    reconnectEnabled = false; // prevent auto-reconnect on manual disconnect
    ws.close();
    ws = null;
  }
  hangup();
}

function sendSignal(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function setStatus(state) {
  statusPill.className = 'status-pill';
  if (state === 'connected') {
    statusPill.classList.add('connected');
    statusText.textContent = 'online';
  } else {
    statusText.textContent = state;
  }
}

// ── Signal Handling ──
function handleSignal(msg) {
  // Log all signaling to chat system messages so we can see what's happening
  const callMsgs = ['call-request','call-accepted','call-rejected','offer','answer','hangup'];
  if (callMsgs.includes(msg.type)) {
    addSystemMsg(`[signal] ${msg.type} from ${peerNames[msg.from] || shortId(msg.from)}`);
  }
  switch(msg.type) {
    case 'welcome':
      myId = msg.id;
      myIdEl.textContent = currentUser ? (currentUser.displayName) : myId;
      addSystemMsg('welcome, ' + (currentUser ? currentUser.displayName : shortId(myId)));
      break;
    case 'peers':
      // peers message now includes [{id, displayName}] objects
      if (Array.isArray(msg.peers)) {
        msg.peers.forEach(p => {
          if (typeof p === 'object' && p.displayName) peerNames[p.id] = p.displayName;
        });
        updatePeers(msg.peers.map(p => typeof p === 'object' ? p.id : p));
      }
      break;
    case 'peer-joined':
      if (msg.displayName) peerNames[msg.id] = msg.displayName;
      addPeer(msg.id);
      addSystemMsg((msg.displayName || shortId(msg.id)) + ' joined');
      break;
    case 'peer-left':
      removePeer(msg.id);
      addSystemMsg((peerNames[msg.id] || shortId(msg.id)) + ' left');
      delete peerNames[msg.id];
      if (activePeerId === msg.id) hangup();
      break;
    case 'offer':
      handleOffer(msg);
      break;
    case 'answer':
      handleAnswer(msg);
      break;
    case 'ice-candidate':
      handleIce(msg);
      break;
    case 'call-accepted':
      // Callee accepted — send the WebRTC offer now
      if (pendingCallPeerId === msg.from) {
        pendingCallPeerId = null;
        addSystemMsg('call accepted by ' + (peerNames[msg.from] || shortId(msg.from)));
        sendOffer(msg.from);
      } else {
        // Unexpected — log it so we can debug
        addSystemMsg('[signal] unexpected call-accepted: pending=' +
          (pendingCallPeerId ? shortId(pendingCallPeerId) : 'none') +
          ' from=' + shortId(msg.from));
      }
      break;
    case 'call-rejected':
      addSystemMsg('call declined by ' + (peerNames[msg.from] || shortId(msg.from)));
      hangup();
      break;
    case 'call-busy':
      addSystemMsg(msg.reason || 'user is busy');
      hangupLocal();
      break;
    case 'hangup':
      if (msg.from === activePeerId) {
        addSystemMsg((peerNames[msg.from] || shortId(msg.from)) + ' ended the call');
        hangup();
      }
      break;
    case 'mute-state':
      if (msg.from === activePeerId) {
        const muteHints = [];
        if (msg.audio) muteHints.push('muted');
        if (msg.video) muteHints.push('cam off');
        if (muteHints.length) addSystemMsg((peerNames[msg.from] || shortId(msg.from)) + ' is ' + muteHints.join(', '));
      }
      break;
    case 'chat':
      receiveChat(msg.text, msg.from);
      break;
    case 'call-request':
      showIncomingCall(msg.from);
      break;
  }
}

// ── Peers UI ──
function updatePeers(list) {
  clearPeers();
  list.forEach(id => { if (id !== myId) addPeer(id); });
}
function clearPeers() {
  Object.keys(peers).forEach(id => removePeer(id));
}
function addPeer(id) {
  if (peers[id] || id === myId) return;
  const item = document.createElement('div');
  item.className = 'peer-item';
  item.dataset.id = id;
  const name = peerNames[id] || ('peer ' + shortId(id));
  const initials = escHtml(name.slice(0,2).toUpperCase());
  const lastMsg = chatStore[id]?.slice(-1)[0];
  const preview = lastMsg ? escHtml(lastMsg.text.slice(0, 28) + (lastMsg.text.length > 28 ? '…' : '')) : 'tap to chat';
  item.innerHTML = `
    <div class="peer-avatar">${initials}</div>
    <div class="peer-info">
      <div class="peer-name">${escHtml(name)}</div>
      <div class="peer-status">${preview}</div>
    </div>
    <div class="peer-call-btn" data-call="${escHtml(id)}">📞</div>
  `;
  item.querySelector('[data-call]').addEventListener('click', e => {
    e.stopPropagation();
    startCall(id);
  });
  item.addEventListener('click', () => selectPeer(id, true));
  peersList.appendChild(item);
  peers[id] = item;
  noPeers.style.display = 'none';
}
function removePeer(id) {
  if (peers[id]) { peers[id].remove(); delete peers[id]; }
  if (Object.keys(peers).length === 0) noPeers.style.display = '';
  removeChatTab(id);
}
function selectPeer(id, openChat = false) {
  Object.values(peers).forEach(el => el.classList.remove('active'));
  if (peers[id]) peers[id].classList.add('active');
  activePeerId = id;
  callPeerLabel.textContent = peerNames[id] || ('peer ' + shortId(id));
  // Create the tab but only open the conversation if explicitly requested
  ensureChatTab(id);
  if (openChat) openConversation(id);
}

// ── Media ──
let currentFacingMode = 'user'; // 'user' = front, 'environment' = back

async function getLocalStream(facingMode) {
  if (localStream && !facingMode) {
    // Re-attach in case hangupLocal() cleared srcObject without stopping tracks
    localVideo.srcObject = localStream;
    localVideo.classList.remove('hidden');
    return localStream;
  }
  // Stop existing tracks if switching camera
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  const fm = facingMode || currentFacingMode;
  // No hardcoded width/height — let the device pick its native resolution.
  // Phones default to portrait, laptops to landscape; both work correctly this way.
  // The 1.5 Mbps encoding cap in applyEncodingParams causes WebRTC's congestion
  // control to scale resolution/framerate down automatically if the link can't keep up.
  const videoConstraints = {
    facingMode: { ideal: fm },
    frameRate: { ideal: 30 },
  };
  // Do NOT specify sampleRate — doing so forces Chrome out of the native OS audio
  // pipeline (which has hardware AEC) into software processing, causing echo.
  // Let the browser negotiate the sample rate with the OS automatically.
  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl:  true,
  };
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audioConstraints,
    });
    currentFacingMode = fm;
  } catch(e) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: fm }, audio: audioConstraints });
      currentFacingMode = fm;
    } catch(e2) {
      try {
        // Last resort: audio only, still request AEC so we don't get raw mic feedback
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: audioConstraints });
        addSystemMsg('camera unavailable — audio only');
      } catch(e3) {
        addSystemMsg('media access denied — check browser permissions');
        return null;
      }
    }
  }
  localVideo.srcObject = localStream;
  localVideo.classList.remove('hidden');
  // Re-apply mute/cam state
  localStream.getAudioTracks().forEach(t => t.enabled = !micMuted);
  localStream.getVideoTracks().forEach(t => t.enabled = !camOff);
  return localStream;
}

async function switchCamera() {
  const newFacing = currentFacingMode === 'user' ? 'environment' : 'user';
  const stream = await getLocalStream(newFacing);
  if (!stream) return;
  // If in a call, replace the video track in the peer connection
  if (peerConnection) {
    const newVideoTrack = stream.getVideoTracks()[0];
    if (newVideoTrack) {
      const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newVideoTrack);
    }
  }
}

// ── RTC State Badge ──
function setRtcState(state, label) {
  rtcBadge.className = 'rtc-state-badge visible state-' + state;
  rtcStateText.textContent = label;
}
function clearRtcState() {
  rtcBadge.className = 'rtc-state-badge';
  rtcStateText.textContent = '—';
}

// ── WebRTC ──
function createPC(peerId) {
  const pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = e => {
    if (e.candidate) {
      // Use the captured peerId, not the global activePeerId which may have
      // changed by the time async ICE gathering fires
      sendSignal({ type: 'ice-candidate', to: peerId, candidate: e.candidate });
    }
  };

  pc.ontrack = e => {
    const stream = e.streams?.[0];
    if (stream) {
      remoteVideo.srcObject = stream;
      // Unmute AFTER srcObject is set so the browser's AEC can register
      // the output path before audio plays. The element starts muted in HTML
      // to prevent any audio leaking before the stream is properly attached.
      remoteVideo.muted = false;
      // Keep playback at the live edge — skip over any jitter buffer backlog
      // to minimize latency. The browser accumulates a buffer to smooth out
      // uneven packet arrival, which adds ~1s delay on spotty Wi-Fi.
      remoteVideo.onloadedmetadata = () => {
        remoteVideo.play().catch(() => {});
      };
      const nudge = setInterval(() => {
        if (!remoteVideo.srcObject || remoteVideo.paused) { clearInterval(nudge); return; }
        if (remoteVideo.buffered.length > 0) {
          const live = remoteVideo.buffered.end(remoteVideo.buffered.length - 1);
          if (live - remoteVideo.currentTime > 0.15) {
            remoteVideo.currentTime = live;
          }
        }
      }, 3000);
    }
    remoteVideo.classList.remove('hidden');
    idleScreen.classList.add('hidden');
    setRtcState('connecting', 'connecting…');
    // Ensure local video stays muted — browser sometimes resets this
    localVideo.muted = true;
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connecting' || s === 'new') {
      setRtcState('connecting', 'connecting…');
    } else if (s === 'connected') {
      setRtcState('connected', 'connected');
      addSystemMsg('call connected');
      startCallTimer();
      document.getElementById('video-area').classList.add('call-active');
      // Apply encoding params now that senders have live SSRCs.
      // Retry once after 1s — some browsers (especially mobile Chrome) don't
      // populate encodings immediately at 'connected'.
      applyEncodingParams(pc);
      setTimeout(() => { if (pc.connectionState === 'connected') applyEncodingParams(pc); }, 1000);
    } else if (['disconnected','failed','closed'].includes(s)) {
      setRtcState('failed', s);
      hangup();
    }
  };

  // ICE connection state gives earlier signal than connection state
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'checking') setRtcState('connecting', 'checking ICE…');
    else if (s === 'connected' || s === 'completed') setRtcState('connected', 'connected');
    else if (s === 'failed') {
      addSystemMsg('ICE failed — are both devices on the same network?');
      setRtcState('failed', 'ICE failed');
      hangup();
    } else if (s === 'disconnected') {
      setRtcState('failed', 'disconnected');
    }
  };

  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete' && pc.iceConnectionState === 'new') {
      addSystemMsg('ICE gathering done but no connection — check firewall or network');
    }
  };

  return pc;
}

async function startCall(peerId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addSystemMsg('not connected to signaling server');
    return;
  }
  selectPeer(peerId);

  // Get media first — user gesture is active here
  const stream = await getLocalStream();
  if (!stream) return;

  // Ring the callee
  sendSignal({ type: 'call-request', to: peerId });
  addSystemMsg('calling ' + (peerNames[peerId] || shortId(peerId)) + '…');
  btnStartCall.classList.add('hidden');
  btnHangup.classList.remove('hidden');
  btnFlip.classList.remove('hidden');

  // Wait for call-accepted signal before sending offer
  pendingCallPeerId = peerId;
}

// Called once the callee sends back call-accepted
async function sendOffer(peerId) {
  const stream = localStream;
  if (!stream) {
    addSystemMsg('no local stream — tap the camera button first');
    hangupLocal();
    return;
  }
  try {
    peerConnection = createPC(peerId);

    // addTransceiver with sendrecv — required for Safari to declare bidirectional media
    stream.getTracks().forEach(track => {
      peerConnection.addTransceiver(track, { direction: 'sendrecv', streams: [stream] });
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal({ type: 'offer', to: peerId, sdp: peerConnection.localDescription });
  } catch(e) {
    addSystemMsg('failed to create offer: ' + e.message);
    hangupLocal();
  }
}

async function handleOffer(msg) {
  incomingCallerId = msg.from;
  incomingOffer = msg.sdp;
  // tryAnswer() is called here AND at the end of acceptBtn.
  // Whichever fires last will have both localStream and incomingOffer ready.
  tryAnswer();
}

function showIncomingCall(fromId) {
  incomingCallerId = fromId;
  const name = peerNames[fromId] || shortId(fromId);
  callBannerLabel.textContent = 'incoming call from ' + name;
  callBanner.classList.add('visible');
}

acceptBtn.addEventListener('click', async () => {
  callBanner.classList.remove('visible');

  // Capture all state BEFORE any await — async gaps can cause state to change
  const callerId = incomingCallerId;
  if (!callerId) return;

  selectPeer(callerId);
  activePeerId = callerId;

  // Signal acceptance immediately — caller will now send the offer
  sendSignal({ type: 'call-accepted', to: callerId });

  btnStartCall.classList.add('hidden');
  btnHangup.classList.remove('hidden');
  btnFlip.classList.remove('hidden');

  addSystemMsg('accepted call from ' + (peerNames[callerId] || shortId(callerId)));

  // Get media — this tap IS the user gesture on mobile
  const stream = await getLocalStream();
  if (!stream) {
    addSystemMsg('could not access camera/mic — check browser permissions');
    sendSignal({ type: 'call-rejected', to: callerId });
    hangupLocal();
    return;
  }

  // If offer already arrived while we were getting media, answer now.
  // If not, handleOffer will call tryAnswer when it arrives.
  tryAnswer();
});

// Single convergence point — called from both handleOffer and acceptBtn.
// Proceeds only when ALL three prerequisites are met.
// Uses answeringCall flag (not peerConnection) to guard — peerConnection may be
// set by sendOffer on the caller side, which would incorrectly block answerCall.
let answeringCall = false;
function tryAnswer() {
  if (!localStream || !incomingOffer || !incomingCallerId) {
    console.log('[tryAnswer] waiting — stream:' + !!localStream +
      ' offer:' + !!incomingOffer + ' callerId:' + !!incomingCallerId);
    return;
  }
  if (answeringCall) return;
  answeringCall = true;
  console.log('[tryAnswer] answering call from ' + (peerNames[incomingCallerId] || shortId(incomingCallerId)));
  answerCall();
}

async function answerCall() {
  const stream = localStream;
  const offer = incomingOffer;
  const callerId = incomingCallerId;
  incomingOffer = null;

  try {
    peerConnection = createPC(callerId);

    // Set remote description FIRST — creates transceivers from the offer SDP
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    // Drain any ICE candidates that arrived before we were ready
    await drainIceQueue();

    // Add our tracks into those transceivers (addTrack, not addTransceiver)
    stream.getTracks().forEach(track => {
      peerConnection.addTrack(track, stream);
    });

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignal({ type: 'answer', to: callerId, sdp: peerConnection.localDescription });
  } catch(e) {
    addSystemMsg('failed to answer call: ' + e.message);
    answeringCall = false;
    hangupLocal();
  }
}

// Set encoding bitrate targets to equalise quality across devices
function applyEncodingParams(pc) {
  pc.getSenders().forEach(async sender => {
    if (!sender.track) return;
    const params = sender.getParameters();
    // If the browser hasn't populated encodings yet, skip — setParameters
    // will fail without the browser-assigned ssrc/rid fields.
    if (!params.encodings || params.encodings.length === 0) return;
    if (sender.track.kind === 'video') {
      params.encodings[0].maxBitrate = 1_500_000;
      params.encodings[0].maxFramerate = 30;
      // Scale down high-res sources so the encoder doesn't struggle to
      // compress 1080p+ into 1.5 Mbps, which causes frame drops.
      const settings = sender.track.getSettings();
      const longerSide = Math.max(settings.width || 0, settings.height || 0);
      if (longerSide > 720) {
        params.encodings[0].scaleResolutionDownBy = longerSide / 720;
      }
    } else if (sender.track.kind === 'audio') {
      params.encodings[0].maxBitrate = 128_000;
    }
    try {
      await sender.setParameters(params);
      const enc = params.encodings[0];
      const msg = `setParams OK [${sender.track.kind}]: maxBitrate=${enc.maxBitrate}, scale=${enc.scaleResolutionDownBy||1}`;
      console.log(msg);
      if (window._dbg) window._dbg(msg);
    } catch (e) {
      const msg = 'setParameters FAILED: ' + e.message;
      console.warn(msg);
      if (window._dbg) window._dbg(msg);
    }
  });
}

rejectBtn.addEventListener('click', () => {
  callBanner.classList.remove('visible');
  sendSignal({ type: 'call-rejected', to: incomingCallerId });
  incomingCallerId = null;
  incomingOffer = null;
});

async function handleAnswer(msg) {
  if (!peerConnection) return;
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    await drainIceQueue(); // apply any ICE candidates that arrived before the answer
  } catch(e) {
    addSystemMsg('failed to process answer: ' + e.message);
  }
}

async function handleIce(msg) {
  if (!msg.candidate) return;
  if (!peerConnection || !peerConnection.remoteDescription) {
    // PC not ready yet — queue the candidate
    iceQueue.push(msg.candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
  } catch(e) {}
}

async function drainIceQueue() {
  if (!peerConnection) return;
  const queued = iceQueue.splice(0);
  for (const candidate of queued) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch(e) {}
  }
}

function hangupLocal() {
  // Immediate teardown — used when WE initiate the hangup
  if (peerConnection) {
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  pendingCallPeerId = null;
  incomingOffer = null;
  incomingCallerId = null;
  activePeerId = null;
  answeringCall = false;
  iceQueue = [];
  remoteAudioMuted = false;
  remoteVideoMuted = false;
  const rmic = document.getElementById('btn-remote-mic');
  const rcam = document.getElementById('btn-remote-cam');
  if (rmic) { rmic.classList.remove('active'); rmic.title = 'Mute incoming audio'; }
  if (rcam) { rcam.classList.remove('active'); rcam.title = 'Hide incoming video'; }
  remoteVideo.style.visibility = 'visible';
  localVideo.srcObject = null;
  localVideo.classList.add('hidden');
  remoteVideo.srcObject = null;
  remoteVideo.classList.add('hidden');
  document.getElementById('video-area').classList.remove('call-active');
  clearRtcState();
  idleScreen.classList.remove('hidden');
  callBanner.classList.remove('visible');
  btnStartCall.classList.remove('hidden');
  btnHangup.classList.add('hidden');
  if (btnFlip) btnFlip.classList.add('hidden');
  stopCallTimer();
  callPeerLabel.textContent = '—';
}

function hangup() {
  // Used for remote-triggered or error hangup — also stops local stream
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  const previewBtn = $('preview-btn');
  if (previewBtn) previewBtn.classList.remove('active');
  hangupLocal();
}

// ── Call Timer ──
function startCallTimer() {
  callSeconds = 0;
  callTimer.style.display = '';
  callTimerInterval = setInterval(() => {
    callSeconds++;
    callTimer.textContent = formatTime(callSeconds);
  }, 1000);
}
function stopCallTimer() {
  clearInterval(callTimerInterval);
  callTimer.style.display = 'none';
  callSeconds = 0;
}

// ── Controls ──
const btnFlip = $('btn-flip');

btnMic.addEventListener('click', () => {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !micMuted);
  btnMic.classList.toggle('active', micMuted);
  btnMic.title = micMuted ? 'Unmute mic' : 'Mute mic';
  // Signal mute state to remote peer only when in an active call
  if (peerConnection) sendSignal({ type: 'mute-state', to: activePeerId, audio: micMuted, video: camOff });
});

btnCam.addEventListener('click', () => {
  if (!localStream) return;
  camOff = !camOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !camOff);
  btnCam.classList.toggle('active', camOff);
  btnCam.title = camOff ? 'Enable camera' : 'Disable camera';
  if (peerConnection) sendSignal({ type: 'mute-state', to: activePeerId, audio: micMuted, video: camOff });
});

btnFlip.addEventListener('click', async () => {
  btnFlip.style.opacity = '0.4';
  await switchCamera();
  btnFlip.style.opacity = '';
});

// Remote audio/video mute — affects local playback only, not the sender's stream
function toggleRemoteAudio() {
  remoteAudioMuted = !remoteAudioMuted;
  if (remoteVideo.srcObject) {
    remoteVideo.srcObject.getAudioTracks().forEach(t => t.enabled = !remoteAudioMuted);
  }
  const btn = document.getElementById('btn-remote-mic');
  if (btn) {
    btn.classList.toggle('active', remoteAudioMuted);
    btn.title = remoteAudioMuted ? 'Unmute incoming audio' : 'Mute incoming audio';
  }
}

function toggleRemoteVideo() {
  remoteVideoMuted = !remoteVideoMuted;
  remoteVideo.style.visibility = remoteVideoMuted ? 'hidden' : 'visible';
  const btn = document.getElementById('btn-remote-cam');
  if (btn) {
    btn.classList.toggle('active', remoteVideoMuted);
    btn.title = remoteVideoMuted ? 'Show incoming video' : 'Hide incoming video';
  }
}

btnHangup.addEventListener('click', () => {
  if (activePeerId) sendSignal({ type: 'hangup', to: activePeerId });
  addSystemMsg('call ended');
  hangup(); // stops localStream tracks so camera/mic LED turns off
});

btnStartCall.addEventListener('click', () => {
  if (activePeerId) startCall(activePeerId);
  else addSystemMsg('select a peer first');
});

// ── Per-peer chat store ──
// chatStore[peerId] = [{text, mine, time}]
const chatStore = {};
let activeChatPeerId = null;

const chatTabsEl     = document.getElementById('chat-tabs');
const chatTabsEmpty  = document.getElementById('chat-tabs-empty');
const chatEmptyState = document.getElementById('chat-empty-state');
const chatInputRow   = document.getElementById('chat-input-row');

function getOrCreateConvo(peerId) {
  if (!chatStore[peerId]) chatStore[peerId] = [];
  return chatStore[peerId];
}

function openConversation(peerId) {
  activeChatPeerId = peerId;

  // Update tab highlights
  document.querySelectorAll('.chat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.peer === peerId);
    if (t.dataset.peer === peerId) t.classList.remove('has-unread');
  });
  // Clear unread on peer item
  if (peers[peerId]) peers[peerId].classList.remove('has-unread');
  updateFabBadge();

  // Show messages for this peer
  chatMessages.classList.remove('hidden');
  chatInputRow.classList.remove('hidden');
  chatEmptyState.classList.add('hidden');
  chatMessages.innerHTML = '';

  const convo = getOrCreateConvo(peerId);
  if (convo.length === 0) {
    const el = document.createElement('div');
    el.className = 'msg-system';
    el.textContent = 'start of conversation with ' + (peerNames[peerId] || shortId(peerId));
    chatMessages.appendChild(el);
  } else {
    convo.forEach(m => renderMsg(m.text, m.mine, m.time, peerId));
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
  chatInput.focus();
}

function ensureChatTab(peerId) {
  if (document.querySelector(`.chat-tab[data-peer="${peerId}"]`)) return;
  chatTabsEmpty.style.display = 'none';
  const name = peerNames[peerId] || shortId(peerId);
  const tab = document.createElement('div');
  tab.className = 'chat-tab';
  tab.dataset.peer = peerId;
  tab.innerHTML = `<span class="tab-name">${escHtml(name)}</span><span class="unread-badge"></span>`;
  tab.addEventListener('click', () => openConversation(peerId));
  chatTabsEl.appendChild(tab);
}

function removeChatTab(peerId) {
  const tab = document.querySelector(`.chat-tab[data-peer="${peerId}"]`);
  if (tab) tab.remove();
  if (activeChatPeerId === peerId) {
    activeChatPeerId = null;
    chatMessages.classList.add('hidden');
    chatInputRow.classList.add('hidden');
    chatEmptyState.classList.remove('hidden');
    chatMessages.innerHTML = '';
  }
  if (!document.querySelector('.chat-tab')) {
    chatTabsEmpty.style.display = '';
  }
}

function renderMsg(text, mine, time, peerId) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (mine ? 'me' : 'them');
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const timeStr = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = mine ? 'you · ' + timeStr : (peerNames[peerId] || shortId(peerId)) + ' · ' + timeStr;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  wrap.appendChild(meta);
  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
}

function receiveChat(text, fromId) {
  const convo = getOrCreateConvo(fromId);
  const entry = { text, mine: false, time: Date.now() };
  convo.push(entry);

  // Update peer status preview
  if (peers[fromId]) {
    const statusEl = peers[fromId].querySelector('.peer-status');
    if (statusEl) statusEl.textContent = text.slice(0, 28) + (text.length > 28 ? '…' : '');
  }

  ensureChatTab(fromId);

  if (activeChatPeerId === fromId) {
    renderMsg(text, false, entry.time, fromId);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } else {
    // Mark unread
    const tab = document.querySelector(`.chat-tab[data-peer="${fromId}"]`);
    if (tab) tab.classList.add('has-unread');
    if (peers[fromId]) peers[fromId].classList.add('has-unread');
    updateFabBadge();
  }
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!activeChatPeerId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { addSystemMsg('not connected'); return; }
  sendSignal({ type: 'chat', to: activeChatPeerId, text });
  const convo = getOrCreateConvo(activeChatPeerId);
  const entry = { text, mine: true, time: Date.now() };
  convo.push(entry);
  renderMsg(text, true, entry.time, activeChatPeerId);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  // Update peer status preview
  if (peers[activeChatPeerId]) {
    const statusEl = peers[activeChatPeerId].querySelector('.peer-status');
    if (statusEl) statusEl.textContent = text.slice(0, 28) + (text.length > 28 ? '…' : '');
  }
  chatInput.value = '';
}

sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

// ── Mobile chat panel ──
const chatBackdrop = document.getElementById('chat-backdrop');
const chatFab = document.getElementById('chat-fab');
const chatFabBadge = document.getElementById('chat-fab-badge');

function openChatPanel() {
  const panel = document.getElementById('chat-panel');
  panel.classList.add('open');
  chatBackdrop.classList.add('open');
}

function closeChatPanel() {
  const panel = document.getElementById('chat-panel');
  panel.classList.remove('open');
  chatBackdrop.classList.remove('open');
}

if (chatBackdrop) chatBackdrop.addEventListener('click', closeChatPanel);

// Track unread for FAB badge
function updateFabBadge() {
  if (!chatFabBadge) return;
  const hasUnread = document.querySelector('.chat-tab.has-unread');
  chatFabBadge.classList.toggle('hidden', !hasUnread);
}

// ── My ID block: display name only, no copy ──
// (ID is internal — users don't need to see or share it)

// ── Connect / Disconnect ──
// WS connects automatically on login — no manual connect button

// Preview button: grants camera/mic permission early (important on mobile)
$('preview-btn').addEventListener('click', async () => {
  const btn = $('preview-btn');
  if (localStream) {
    // Toggle off
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
    localVideo.classList.add('hidden');
    btn.classList.remove('active');
    btn.title = 'Preview camera';
  } else {
    const stream = await getLocalStream();
    if (stream) {
      btn.classList.add('active');
      btn.title = 'Stop preview';
    }
  }
});

// ── Debug overlay — triple-tap video area to toggle ──
(function() {
  const overlay = document.getElementById('debug-overlay');
  const log = document.getElementById('debug-log');
  if (!overlay || !log) return;

  let tapCount = 0, tapTimer = null;
  document.getElementById('video-area').addEventListener('click', () => {
    tapCount++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { tapCount = 0; }, 500);
    if (tapCount >= 3) {
      tapCount = 0;
      overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none';
    }
  });

  const lines = [];
  function dbg(msg) {
    const ts = new Date().toLocaleTimeString();
    lines.push(ts + ' ' + msg);
    if (lines.length > 80) lines.shift();
    log.textContent = lines.join('\n');
    log.scrollTop = log.scrollHeight;
  }

  // Expose globally so applyEncodingParams can log
  window._dbg = dbg;

  // Poll WebRTC stats every 2s while overlay is visible
  setInterval(async () => {
    if (overlay.style.display === 'none' || !peerConnection) return;
    try {
      const stats = await peerConnection.getStats();
      stats.forEach(report => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          const kbps = report.bytesSent ? Math.round((report.bytesSent * 8) / (report.timestamp / 1000) / 1000) : '?';
          dbg(`OUT video: ${report.frameWidth||'?'}x${report.frameHeight||'?'} @${report.framesPerSecond||'?'}fps, ${kbps}kbps avg, ${report.framesEncoded||0} encoded, ${report.qualityLimitationReason||'none'}`);
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          dbg(`IN video: ${report.frameWidth||'?'}x${report.frameHeight||'?'} @${report.framesPerSecond||'?'}fps, lost=${report.packetsLost||0}, jitter=${report.jitter||0}`);
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          dbg(`ICE: rtt=${report.currentRoundTripTime||'?'}s, avail-out=${report.availableOutgoingBitrate ? Math.round(report.availableOutgoingBitrate/1000)+'kbps' : '?'}`);
        }
      });
    } catch(e) { dbg('stats error: ' + e.message); }
  }, 2000);
})();
