/**
 * Intercom Card v2.0.0 - Pure mirror of ESP state
 *
 * The card is a simple frontend that mirrors the ESP's intercom_state entity.
 * No complex internal state tracking - just read ESP state and render UI.
 *
 * ESP States -> Card UI:
 * - Idle       -> Show destination + Call button
 * - Calling    -> Show "Calling [dest]..." + Hangup
 * - Ringing    -> Show "Incoming [caller]" + Answer/Decline
 * - Streaming  -> Show "In Call [peer]" + Hangup
 *
 * Browser mode (mode: "browser"):
 * - Registers this browser tab as a named endpoint with HA
 * - Lists other online browser endpoints
 * - Supports one-to-one calling with full-duplex audio relayed through HA
 */

const INTERCOM_CARD_VERSION = "2.1.4";

class IntercomCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    // UI transition states only
    this._starting = false;
    this._stopping = false;

    // Audio (simple mode only)
    this._audioContext = null;
    this._mediaStream = null;
    this._workletNode = null;
    this._source = null;
    this._playbackContext = null;
    this._gainNode = null;
    this._nextPlayTime = 0;
    this._unsubscribeAudio = null;
    this._chunksSent = 0;
    this._chunksReceived = 0;

    // Device info
    this._activeDeviceInfo = null;
    this._availableDevices = [];
    this._activeBridgeId = null;

    // Entity IDs (discovered once)
    this._intercomStateEntityId = null;
    this._callerEntityId = null;
    this._destinationEntityId = null;
    this._previousButtonEntityId = null;
    this._nextButtonEntityId = null;
    this._callButtonEntityId = null;
    this._declineButtonEntityId = null;

    // Audio streaming active (for P2P)
    this._audioStreaming = false;
    this._scriptProcessor = null;

    // Persistent error message (survives _render() DOM rebuild)
    this._errorMsg = "";

    // -----------------------------------------------------------------------
    // Browser-to-browser mode state
    // -----------------------------------------------------------------------
    this._browserEndpointId = null;       // stable per-tab ID (sessionStorage)
    this._browserSubscription = null;     // subscribeMessage unsubscribe fn
    this._browserEndpoints = [];          // online endpoints from server
    this._browserCallState = "idle";      // idle|calling|ringing|active
    this._activeCallId = null;            // current call_id
    this._browserPeerName = "";           // display name of the remote peer
    this._browserRegistered = false;      // true after register completes
    this._browserSelectedEndpoint = null; // endpoint_id selected to call
  }

  setConfig(config) {
    this.config = config;
    this._render();
  }

  set hass(hass) {
    const oldHass = this._hass;
    this._hass = hass;

    // Browser mode: register endpoint once when hass is first set
    if (hass && this._isBrowserMode()) {
      if (!this._browserRegistered) {
        this._registerBrowserEndpoint();
      }
      return; // Browser mode renders via event callbacks only
    }

    // Load devices for full mode
    if (hass && this._isFullMode() && this._availableDevices.length === 0) {
      this._loadAvailableDevices();
    }

    // Discover entity IDs once
    if (hass && !this._intercomStateEntityId) {
      this._findEntityIds();
    }

    // Re-render when ESP state or destination changes
    if (hass) {
      let needsRender = false;
      let newEspState = null;
      let espStateChanged = false;

      // Check intercom_state
      if (this._intercomStateEntityId) {
        const stateEntity = hass.states[this._intercomStateEntityId];
        const oldStateEntity = oldHass?.states?.[this._intercomStateEntityId];
        newEspState = stateEntity?.state?.toLowerCase();
        if (stateEntity?.state !== oldStateEntity?.state) {
          needsRender = true;
          espStateChanged = true;
        }
      }

      // Check destination (for full mode contact cycling)
      if (this._destinationEntityId) {
        const destEntity = hass.states[this._destinationEntityId];
        const oldDestEntity = oldHass?.states?.[this._destinationEntityId];
        if (destEntity?.state !== oldDestEntity?.state) {
          needsRender = true;
        }
      }

      // Check caller (for incoming call info)
      if (this._callerEntityId) {
        const callerEntity = hass.states[this._callerEntityId];
        const oldCallerEntity = oldHass?.states?.[this._callerEntityId];
        if (callerEntity?.state !== oldCallerEntity?.state) {
          needsRender = true;
        }
      }

      // CRITICAL: Cleanup audio when ESP goes to Idle
      if (espStateChanged && newEspState === "idle") {
        if (this._audioStreaming || this._activeBridgeId) {
          this._cleanup();
        }
        this._errorMsg = "";
      }

      if (needsRender) {
        this._render();
      }
    }
  }

  _isFullMode() {
    return this.config?.mode === "full";
  }

  _isBrowserMode() {
    return this.config?.mode === "browser";
  }

  _getConfigDeviceId() {
    return this.config?.entity_id || this.config?.device_id;
  }

  // Get current ESP state from entity
  _getEspState() {
    if (!this._hass || !this._intercomStateEntityId) return "unknown";
    const entity = this._hass.states[this._intercomStateEntityId];
    return entity?.state || "unknown";
  }

  // Get caller name from entity
  _getCallerName() {
    if (!this._hass || !this._callerEntityId) return "";
    const entity = this._hass.states[this._callerEntityId];
    const state = entity?.state;
    if (!state || state === "unknown" || state === "") return "";
    return state;
  }

  // Get destination from entity
  _getDestination() {
    if (!this._hass || !this._destinationEntityId) return "Home Assistant";
    const entity = this._hass.states[this._destinationEntityId];
    return entity?.state || "Home Assistant";
  }

  // =========================================================================
  // Browser-to-browser mode methods
  // =========================================================================

  /** Return or generate a stable endpoint ID for this browser tab. */
  _getBrowserEndpointId() {
    if (this._browserEndpointId) return this._browserEndpointId;
    const epName = this.config?.endpoint_name || "Browser";
    const slug = epName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const storageKey = `intercom_native_ep_${slug}`;
    let id = sessionStorage.getItem(storageKey);
    if (!id) {
      id = `browser-${slug}-${Math.random().toString(36).slice(2, 9)}`;
      sessionStorage.setItem(storageKey, id);
    }
    this._browserEndpointId = id;
    return id;
  }

  /** Register this card as a browser endpoint (subscription command). */
  async _registerBrowserEndpoint() {
    if (!this._hass || this._browserRegistered) return;
    this._browserRegistered = true; // Prevent duplicate calls

    const endpointId = this._getBrowserEndpointId();
    const displayName = this.config?.endpoint_name || "Browser";

    try {
      this._browserSubscription = await this._hass.connection.subscribeMessage(
        (msg) => this._handleBrowserEvent(msg),
        {
          type: "intercom_native/browser_register",
          endpoint_id: endpointId,
          display_name: displayName,
        }
      );
    } catch (err) {
      console.error("Failed to register browser endpoint:", err);
      this._browserRegistered = false;
      this._showError("Failed to register endpoint");
      this._render();
    }
  }

  /** Handle events pushed from the server via the browser_register subscription. */
  _handleBrowserEvent(msg) {
    if (!msg || !msg.event) return;

    switch (msg.event) {
      case "endpoint_list_updated":
        // Refresh the list of available endpoints (exclude self)
        this._browserEndpoints = (msg.endpoints || []).filter(
          (ep) => ep.endpoint_id !== this._getBrowserEndpointId()
        );
        this._render();
        break;

      case "incoming_call":
        // Another browser is calling us
        this._browserCallState = "ringing";
        this._activeCallId = msg.call_id;
        this._browserPeerName = msg.caller_display_name || msg.caller_endpoint_id;
        this._errorMsg = "";
        this._render();
        break;

      case "call_answered":
        // Our outgoing call was answered
        this._browserCallState = "active";
        this._browserPeerName = msg.callee_display_name || msg.callee_endpoint_id;
        this._startBrowserAudio();
        this._render();
        break;

      case "call_declined":
        // Our outgoing call was declined
        this._browserCallState = "idle";
        this._activeCallId = null;
        this._browserPeerName = "";
        this._showError("Call declined");
        this._render();
        break;

      case "call_ended":
        // Call was ended by the other side or due to disconnect
        if (this._browserCallState !== "idle") {
          const wasActive = this._browserCallState === "active";
          this._browserCallState = "idle";
          this._activeCallId = null;
          this._browserPeerName = "";
          if (wasActive) this._cleanupBrowserAudio();
          this._errorMsg = msg.reason === "endpoint_disconnected" ? "Peer disconnected" : "";
          this._render();
        }
        break;

      case "audio":
        // Incoming audio chunk from the peer
        if (this._browserCallState === "active" && this._playbackContext) {
          this._handleBrowserAudio(msg.audio);
        }
        break;

      default:
        break;
    }
  }

  /** Start mic capture and playback for a browser call. */
  async _startBrowserAudio() {
    try {
      await this._setupMicAndSpeaker();
      // Override the worklet audio handler to route via browser_audio command
      if (this._workletNode) {
        this._workletNode.port.onmessage = (e) => {
          if (e.data.type === "audio") this._sendBrowserAudio(new Int16Array(e.data.buffer));
        };
      }
      this._audioStreaming = true;
      this._chunksSent = 0;
      this._chunksReceived = 0;
    } catch (err) {
      console.error("Failed to start browser audio:", err);
      this._showError("Microphone access denied");
      // Hang up since we can't do audio
      if (this._activeCallId) {
        this._hangupBrowserCall().catch(() => {});
      }
    }
  }

  /** Send an audio chunk to the peer via browser_audio command. */
  _sendBrowserAudio(int16Array) {
    if (!this._activeCallId || !this._hass) return;
    const bytes = new Uint8Array(int16Array.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    this._hass.connection.sendMessage({
      type: "intercom_native/browser_audio",
      call_id: this._activeCallId,
      sender_endpoint_id: this._getBrowserEndpointId(),
      audio: btoa(binary),
    });
    this._chunksSent++;
    if (this._chunksSent % 25 === 0) this._updateStats();
  }

  /** Play an incoming audio chunk from the peer. */
  _handleBrowserAudio(audiob64) {
    if (!audiob64 || !this._playbackContext) return;
    this._chunksReceived++;
    if (this._chunksReceived % 50 === 0) this._updateStats();
    try {
      const binary = atob(audiob64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;
      this._playScheduled(float32);
    } catch (_err) { /* ignore decode errors */ }
  }

  /** Stop mic/speaker for a browser call. */
  async _cleanupBrowserAudio() {
    this._audioStreaming = false;
    if (this._unsubscribeAudio) { this._unsubscribeAudio(); this._unsubscribeAudio = null; }
    if (this._mediaStream) { this._mediaStream.getTracks().forEach(t => t.stop()); this._mediaStream = null; }
    if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null; }
    if (this._source) { this._source.disconnect(); this._source = null; }
    if (this._audioContext) { await this._audioContext.close().catch(() => {}); this._audioContext = null; }
    if (this._playbackContext) { await this._playbackContext.close().catch(() => {}); this._playbackContext = null; }
    this._gainNode = null;
    this._nextPlayTime = 0;
  }

  /** Initiate a call to the selected browser endpoint. */
  async _startBrowserCall() {
    if (!this._browserSelectedEndpoint || !this._hass) return;
    this._errorMsg = "";
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/browser_call_start",
        caller_endpoint_id: this._getBrowserEndpointId(),
        callee_endpoint_id: this._browserSelectedEndpoint,
      });
      if (result?.success) {
        this._browserCallState = "calling";
        this._activeCallId = result.call_id;
        const peer = this._browserEndpoints.find(ep => ep.endpoint_id === this._browserSelectedEndpoint);
        this._browserPeerName = peer?.display_name || this._browserSelectedEndpoint;
        this._render();
      } else if (result?.reason === "busy") {
        this._showError("Endpoint is busy");
        this._render();
      } else {
        this._showError("Call failed");
        this._render();
      }
    } catch (err) {
      this._showError(err.message || "Call failed");
      this._render();
    }
  }

  /** Answer an incoming browser call. */
  async _answerBrowserCall() {
    if (!this._activeCallId || !this._hass) return;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/browser_call_answer",
        call_id: this._activeCallId,
        answering_endpoint_id: this._getBrowserEndpointId(),
      });
      if (result?.success) {
        this._browserCallState = "active";
        await this._startBrowserAudio();
        this._render();
      } else {
        this._showError("Answer failed");
        this._render();
      }
    } catch (err) {
      this._showError(err.message || "Answer failed");
      this._render();
    }
  }

  /** Decline an incoming browser call. */
  async _declineBrowserCall() {
    if (!this._activeCallId || !this._hass) return;
    try {
      await this._hass.connection.sendMessagePromise({
        type: "intercom_native/browser_call_decline",
        call_id: this._activeCallId,
        declining_endpoint_id: this._getBrowserEndpointId(),
      });
    } catch (_err) { /* ignore */ }
    this._browserCallState = "idle";
    this._activeCallId = null;
    this._browserPeerName = "";
    this._render();
  }

  /** Hang up an active or ringing browser call. */
  async _hangupBrowserCall() {
    if (!this._activeCallId || !this._hass) return;
    const callId = this._activeCallId;
    const wasActive = this._browserCallState === "active";
    this._browserCallState = "idle";
    this._activeCallId = null;
    this._browserPeerName = "";
    if (wasActive) this._cleanupBrowserAudio();
    this._render();
    try {
      await this._hass.connection.sendMessagePromise({
        type: "intercom_native/browser_call_hangup",
        call_id: callId,
        endpoint_id: this._getBrowserEndpointId(),
      });
    } catch (_err) { /* ignore */ }
  }

  /** Render the browser-mode card UI. */
  _renderBrowserMode() {
    const name = this.config?.name || "Intercom";
    const registered = this._browserRegistered;
    const epName = this.config?.endpoint_name || "Browser";
    const callState = this._browserCallState;
    const peerName = this._browserPeerName;
    const endpoints = this._browserEndpoints;

    let statusText = "";
    let statusClass = "disconnected";
    let showCall = false;
    let showHangup = false;
    let showAnswer = false;

    switch (callState) {
      case "idle":
        statusText = registered ? "Ready" : "Connecting...";
        statusClass = registered ? "disconnected" : "transitioning";
        showCall = registered && this._browserSelectedEndpoint != null;
        break;
      case "calling":
        statusText = `Calling ${peerName}...`;
        statusClass = "transitioning";
        showHangup = true;
        break;
      case "ringing":
        statusText = `Incoming: ${peerName}`;
        statusClass = "ringing";
        showAnswer = true;
        break;
      case "active":
        statusText = `In Call: ${peerName}`;
        statusClass = "connected";
        showHangup = true;
        break;
    }

    const endpointOptions = endpoints.map(ep => `
      <div class="endpoint-item ${this._browserSelectedEndpoint === ep.endpoint_id ? 'selected' : ''}"
           data-id="${ep.endpoint_id}">
        <span class="ep-name">${ep.display_name}</span>
        <span class="ep-state ${ep.state}">${ep.state}</span>
      </div>
    `).join("") || '<div class="no-endpoints">No other endpoints online</div>';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: var(--ha-card-background, var(--card-background-color, white));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.1));
          padding: 16px;
        }
        .header { font-size: 1.2em; font-weight: 500; margin-bottom: 4px; color: var(--primary-text-color); }
        .mode-badge {
          display: inline-block; font-size: 0.7em; padding: 2px 6px;
          border-radius: 4px; margin-left: 8px; vertical-align: middle;
          background: #9c27b0; color: white;
        }
        .ep-label { font-size: 0.8em; color: var(--secondary-text-color); margin-bottom: 12px; }
        .endpoints-label { font-size: 0.8em; font-weight: 500; color: var(--secondary-text-color); margin-bottom: 6px; }
        .endpoints-list { border: 1px solid var(--divider-color, #ccc); border-radius: 8px; overflow: hidden; margin-bottom: 12px; max-height: 160px; overflow-y: auto; }
        .endpoint-item {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 12px; cursor: pointer; border-bottom: 1px solid var(--divider-color, #eee);
          transition: background 0.15s;
        }
        .endpoint-item:last-child { border-bottom: none; }
        .endpoint-item:hover { background: var(--secondary-background-color, #f5f5f5); }
        .endpoint-item.selected { background: var(--primary-color, #03a9f4); color: white; }
        .endpoint-item.selected .ep-state { color: rgba(255,255,255,0.8); }
        .ep-name { font-weight: 500; }
        .ep-state { font-size: 0.75em; color: var(--secondary-text-color); }
        .ep-state.busy { color: #f44336; }
        .no-endpoints { padding: 16px; text-align: center; color: var(--secondary-text-color); font-style: italic; font-size: 0.9em; }
        .button-container { display: flex; justify-content: center; gap: 20px; margin-bottom: 12px; }
        .intercom-button {
          width: 90px; height: 90px; border-radius: 50%; border: none; cursor: pointer;
          font-size: 0.95em; font-weight: bold; transition: all 0.2s ease;
          display: flex; align-items: center; justify-content: center;
        }
        .intercom-button.call { background: #4caf50; color: white; }
        .intercom-button.answer { background: #4caf50; color: white; animation: ring-pulse 1s infinite; }
        .intercom-button.decline { background: #f44336; color: white; animation: ring-pulse 1s infinite; }
        .intercom-button.hangup { background: #f44336; color: white; }
        .intercom-button:disabled { opacity: 0.5; cursor: not-allowed; animation: none; }
        @keyframes ring-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        .status { text-align: center; color: var(--secondary-text-color); font-size: 0.9em; }
        .status-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
        .status-indicator.connected { background: #4caf50; }
        .status-indicator.disconnected { background: #9e9e9e; }
        .status-indicator.transitioning { background: #ff9800; animation: blink 0.5s infinite; }
        .status-indicator.ringing { background: #ff9800; animation: blink 0.5s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .stats { font-size: 0.75em; color: #666; margin-top: 8px; text-align: center; }
        .error { color: #f44336; font-size: 0.85em; text-align: center; margin-top: 8px; }
        .version { font-size: 0.65em; color: #999; text-align: right; margin-top: 8px; }
      </style>
      <div class="card">
        <div class="header">
          ${name}
          <span class="mode-badge">Browser</span>
        </div>
        <div class="ep-label">Registered as: <strong>${epName}</strong></div>

        ${callState === "idle" ? `
        <div class="endpoints-label">Available Endpoints</div>
        <div class="endpoints-list" id="endpoints-list">
          ${endpointOptions}
        </div>
        ` : ""}

        <div class="button-container">
          ${showAnswer ? `
            <button class="intercom-button answer" id="answer-btn">Answer</button>
            <button class="intercom-button decline" id="decline-btn">Decline</button>
          ` : showHangup ? `
            <button class="intercom-button hangup" id="hangup-btn">Hangup</button>
          ` : showCall ? `
            <button class="intercom-button call" id="call-btn">Call</button>
          ` : `
            <button class="intercom-button" disabled>...</button>
          `}
        </div>

        <div class="status">
          <span class="status-indicator ${statusClass}"></span>
          ${statusText}
        </div>
        <div class="stats" id="stats">${this._audioStreaming ? `Sent: ${this._chunksSent} | Recv: ${this._chunksReceived}` : 'Browser ↔ Browser'}</div>
        <div class="error" id="err">${this._errorMsg}</div>
        <div class="version">v${INTERCOM_CARD_VERSION}</div>
      </div>
    `;

    // Attach endpoint selection
    const list = this.shadowRoot.getElementById("endpoints-list");
    if (list) {
      list.querySelectorAll(".endpoint-item").forEach(item => {
        item.onclick = () => {
          this._browserSelectedEndpoint = item.dataset.id;
          this._render();
        };
      });
    }

    // Attach call controls
    const callBtn = this.shadowRoot.getElementById("call-btn");
    const hangupBtn = this.shadowRoot.getElementById("hangup-btn");
    const answerBtn = this.shadowRoot.getElementById("answer-btn");
    const declineBtn = this.shadowRoot.getElementById("decline-btn");

    if (callBtn) callBtn.onclick = () => this._startBrowserCall();
    if (hangupBtn) hangupBtn.onclick = () => this._hangupBrowserCall();
    if (answerBtn) answerBtn.onclick = () => this._answerBrowserCall();
    if (declineBtn) declineBtn.onclick = () => this._declineBrowserCall();
  }

  // =========================================================================
  // End of browser-to-browser mode methods
  // =========================================================================

  async _findEntityIds() {
    if (!this._hass) return;

    const deviceInfo = await this._getDeviceInfo();
    if (!deviceInfo?.device_id) return;

    // Use entities mapping from backend
    if (deviceInfo.entities && typeof deviceInfo.entities === "object") {
      const e = deviceInfo.entities;
      this._intercomStateEntityId = e.intercom_state || null;
      this._callerEntityId = e.incoming_caller || null;
      this._destinationEntityId = e.destination || null;
      this._previousButtonEntityId = e.previous || null;
      this._nextButtonEntityId = e.next || null;
      this._callButtonEntityId = e.call || null;
      this._declineButtonEntityId = e.decline || null;
      this._render();
      return;
    }

    // Fallback: entity registry
    try {
      const registry = await this._hass.connection.sendMessagePromise({
        type: "config/entity_registry/list",
      });
      if (!registry) return;

      for (const entity of registry) {
        if (entity.device_id !== deviceInfo.device_id) continue;
        const id = entity.entity_id;
        if (id.includes("intercom_state")) this._intercomStateEntityId = id;
        else if (id.includes("caller")) this._callerEntityId = id;
        else if (id.includes("destination")) this._destinationEntityId = id;
        else if (id.startsWith("button.") && id.includes("previous")) this._previousButtonEntityId = id;
        else if (id.startsWith("button.") && id.includes("next")) this._nextButtonEntityId = id;
        else if (id.startsWith("button.") && id.includes("call") && !id.includes("decline")) this._callButtonEntityId = id;
        else if (id.startsWith("button.") && id.includes("decline")) this._declineButtonEntityId = id;
      }
      this._render();
    } catch (err) {
      console.error("Entity discovery failed:", err);
    }
  }

  async _loadAvailableDevices() {
    if (!this._hass) return;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/list_devices",
      });
      if (result?.devices) {
        this._availableDevices = result.devices;
        this._render();
      }
    } catch (err) {
      console.error("Failed to load devices:", err);
    }
  }

  _render() {
    const name = this.config?.name || "Intercom";

    // Browser mode: separate rendering path
    if (this._isBrowserMode()) {
      this._renderBrowserMode();
      return;
    }

    const deviceId = this._getConfigDeviceId();

    if (!deviceId) {
      this._renderUnconfigured(name);
      return;
    }

    const espState = this._getEspState();
    const isFullMode = this._isFullMode();
    const destination = this._getDestination();
    const caller = this._getCallerName();

    // Determine what to show based on ESP state
    let statusText = "";
    let statusClass = "disconnected";
    let showAnswer = false;
    let showHangup = false;
    let showCall = false;
    let buttonDisabled = this._starting || this._stopping;

    // Get ESP device name for incoming call display
    // Try activeDeviceInfo first, then search in availableDevices, fallback to config name
    let espDeviceName = this._activeDeviceInfo?.name;
    if (!espDeviceName && deviceId) {
      const device = this._availableDevices.find(d =>
        d.device_id === deviceId || d.esphome_id === deviceId ||
        d.name === deviceId || d.name?.toLowerCase().replace(/\s+/g, '-') === deviceId
      );
      espDeviceName = device?.name;
    }
    espDeviceName = espDeviceName || name;

    switch (espState.toLowerCase()) {
      case "idle":
        statusText = "Ready";
        statusClass = "disconnected";
        showCall = true;
        break;
      case "calling":
      case "outgoing":
        // Special case: ESP calling "Home Assistant" = incoming call TO the card
        if (destination === "Home Assistant") {
          statusText = `Incoming: ${espDeviceName}`;
          statusClass = "ringing";
          showAnswer = true;
        } else {
          statusText = `Calling ${destination}...`;
          statusClass = "transitioning";
          showHangup = true;
        }
        break;
      case "ringing":
      case "incoming":
        statusText = `Incoming: ${caller || "Unknown"}`;
        statusClass = "ringing";
        showAnswer = true;
        break;
      case "streaming":
      case "answering":
        statusText = `In Call: ${caller || destination || "Active"}`;
        statusClass = "connected";
        showHangup = true;
        break;
      default:
        statusText = espState;
        statusClass = "disconnected";
        showCall = true;
    }

    if (this._starting) statusText = "Connecting...";
    if (this._stopping) statusText = "Ending call...";

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: var(--ha-card-background, var(--card-background-color, white));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.1));
          padding: 16px;
        }
        .header { font-size: 1.2em; font-weight: 500; margin-bottom: 16px; color: var(--primary-text-color); }
        .mode-badge {
          display: inline-block; font-size: 0.7em; padding: 2px 6px;
          border-radius: 4px; margin-left: 8px; vertical-align: middle;
        }
        .mode-badge.simple { background: #4caf50; color: white; }
        .mode-badge.full { background: #2196f3; color: white; }

        .destination-row {
          display: flex; align-items: center; justify-content: center;
          gap: 12px; margin-bottom: 16px;
        }
        .nav-btn {
          width: 36px; height: 36px; border-radius: 50%;
          border: 1px solid var(--divider-color, #ccc);
          background: var(--card-background-color, white);
          color: var(--primary-text-color); cursor: pointer;
          font-size: 1.2em; display: flex; align-items: center; justify-content: center;
        }
        .nav-btn:hover { background: var(--secondary-background-color, #f5f5f5); }
        .nav-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .destination-value {
          flex: 1; text-align: center; font-size: 1.1em; font-weight: 500;
          color: var(--primary-text-color); padding: 8px 0;
        }
        .destination-label {
          font-size: 0.75em; color: var(--secondary-text-color);
          display: block; margin-bottom: 2px;
        }

        .button-container { display: flex; justify-content: center; gap: 20px; margin-bottom: 16px; }
        .intercom-button {
          width: 100px; height: 100px; border-radius: 50%; border: none; cursor: pointer;
          font-size: 1em; font-weight: bold; transition: all 0.2s ease;
          display: flex; align-items: center; justify-content: center;
        }
        .intercom-button.small { width: 80px; height: 80px; font-size: 0.9em; }
        .intercom-button.call { background: #4caf50; color: white; }
        .intercom-button.answer { background: #4caf50; color: white; animation: ring-pulse 1s infinite; }
        .intercom-button.decline { background: #f44336; color: white; animation: ring-pulse 1s infinite; }
        .intercom-button.hangup { background: #f44336; color: white; }
        .intercom-button:disabled { opacity: 0.5; cursor: not-allowed; animation: none; }
        @keyframes ring-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }

        .status { text-align: center; color: var(--secondary-text-color); font-size: 0.9em; }
        .status-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
        .status-indicator.connected { background: #4caf50; }
        .status-indicator.disconnected { background: #9e9e9e; }
        .status-indicator.transitioning { background: #ff9800; animation: blink 0.5s infinite; }
        .status-indicator.ringing { background: #ff9800; animation: blink 0.5s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

        .stats { font-size: 0.75em; color: #666; margin-top: 8px; text-align: center; }
        .error { color: #f44336; font-size: 0.85em; text-align: center; margin-top: 8px; }
        .version { font-size: 0.65em; color: #999; text-align: right; margin-top: 8px; }
      </style>
      <div class="card">
        <div class="header">
          ${name}
          <span class="mode-badge ${isFullMode ? 'full' : 'simple'}">${isFullMode ? 'Full' : 'Simple'}</span>
        </div>

        ${isFullMode && showCall ? `
        <div class="destination-row">
          <button class="nav-btn" id="prev-btn" ${buttonDisabled ? 'disabled' : ''} title="Previous">&lt;</button>
          <div class="destination-value">
            <span class="destination-label">Destination</span>
            ${destination}
          </div>
          <button class="nav-btn" id="next-btn" ${buttonDisabled ? 'disabled' : ''} title="Next">&gt;</button>
        </div>
        ` : ''}

        <div class="button-container">
          ${showAnswer ? `
            <button class="intercom-button small answer" id="answer-btn" ${buttonDisabled ? 'disabled' : ''}>Answer</button>
            <button class="intercom-button small decline" id="decline-btn" ${buttonDisabled ? 'disabled' : ''}>Decline</button>
          ` : showHangup ? `
            <button class="intercom-button hangup" id="hangup-btn" ${buttonDisabled ? 'disabled' : ''}>Hangup</button>
          ` : showCall ? `
            <button class="intercom-button call" id="call-btn" ${buttonDisabled ? 'disabled' : ''}>Call</button>
          ` : `
            <button class="intercom-button" disabled>...</button>
          `}
        </div>

        <div class="status">
          <span class="status-indicator ${statusClass}"></span>
          ${statusText}
        </div>
        <div class="stats" id="stats">${isFullMode ? (destination === 'Home Assistant' ? 'Browser ↔ ESP' : 'ESP ↔ ESP') : 'Sent: 0 | Recv: 0'}</div>
        <div class="error" id="err">${this._errorMsg}</div>
        <div class="version">v${INTERCOM_CARD_VERSION}</div>
      </div>
    `;

    this._attachEventHandlers();
  }

  _renderUnconfigured(name) {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: var(--ha-card-background, var(--card-background-color, white));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.1));
          padding: 16px;
        }
        .header { font-size: 1.2em; font-weight: 500; margin-bottom: 16px; color: var(--primary-text-color); }
        .unconfigured { text-align: center; color: var(--secondary-text-color); padding: 20px; font-style: italic; }
        .version { font-size: 0.65em; color: #999; text-align: right; margin-top: 8px; }
      </style>
      <div class="card">
        <div class="header">${name}</div>
        <div class="unconfigured">Please configure the card to select an intercom device.</div>
        <div class="version">v${INTERCOM_CARD_VERSION}</div>
      </div>
    `;
  }

  _attachEventHandlers() {
    const callBtn = this.shadowRoot.getElementById("call-btn");
    const hangupBtn = this.shadowRoot.getElementById("hangup-btn");
    const answerBtn = this.shadowRoot.getElementById("answer-btn");
    const declineBtn = this.shadowRoot.getElementById("decline-btn");
    const prevBtn = this.shadowRoot.getElementById("prev-btn");
    const nextBtn = this.shadowRoot.getElementById("next-btn");

    if (callBtn) callBtn.onclick = () => this._startCall();
    if (hangupBtn) hangupBtn.onclick = () => this._hangup();
    if (answerBtn) answerBtn.onclick = () => this._answer();
    if (declineBtn) declineBtn.onclick = () => this._decline();
    if (prevBtn) prevBtn.onclick = () => this._prevContact();
    if (nextBtn) nextBtn.onclick = () => this._nextContact();
  }

  async _prevContact() {
    if (this._previousButtonEntityId) {
      await this._hass.callService("button", "press", { entity_id: this._previousButtonEntityId });
    }
  }

  async _nextContact() {
    if (this._nextButtonEntityId) {
      await this._hass.callService("button", "press", { entity_id: this._nextButtonEntityId });
    }
  }

  async _startCall() {
    const deviceInfo = await this._getDeviceInfo();
    if (!deviceInfo?.host) {
      this._showError("Device not available");
      return;
    }

    this._activeDeviceInfo = deviceInfo;
    this._starting = true;
    this._errorMsg = "";
    this._render();

    try {
      const destination = this._getDestination();

      if (this._isFullMode() && destination !== "Home Assistant") {
        // Full mode: Bridge to another ESP
        await this._startBridge(deviceInfo, destination);
      } else {
        // P2P: Direct call with browser audio
        await this._startP2P(deviceInfo);
      }
    } catch (err) {
      this._showError(err.message || String(err));
      await this._cleanup();
    } finally {
      this._starting = false;
      this._render();
    }
  }

  async _setupMicAndSpeaker() {
    // Setup mic
    this._mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    const track = this._mediaStream.getAudioTracks()[0];
    const trackSampleRate = track?.getSettings?.().sampleRate;
    this._audioContext = new (window.AudioContext || window.webkitAudioContext)(
      trackSampleRate ? { sampleRate: trackSampleRate } : undefined
    );
    if (this._audioContext.state === "suspended") await this._audioContext.resume();

    this._source = this._audioContext.createMediaStreamSource(this._mediaStream);

    await this._audioContext.audioWorklet.addModule(`/intercom-native/intercom-processor.js?v=${INTERCOM_CARD_VERSION}`);
    this._workletNode = new AudioWorkletNode(this._audioContext, "intercom-processor");
    this._workletNode.port.onmessage = (e) => {
      if (e.data.type === "audio") this._sendAudio(new Int16Array(e.data.buffer));
    };
    this._source.connect(this._workletNode);

    // Setup speaker
    this._playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    this._gainNode = this._playbackContext.createGain();
    this._gainNode.gain.value = 1.0;
    this._gainNode.connect(this._playbackContext.destination);
  }

  async _startP2P(deviceInfo) {
    await this._setupMicAndSpeaker();

    const result = await this._hass.connection.sendMessagePromise({
      type: "intercom_native/start",
      device_id: deviceInfo.device_id,
      host: deviceInfo.host,
    });
    if (!result.success) throw new Error("Start failed");

    this._unsubscribeAudio = await this._hass.connection.subscribeMessage(
      (msg) => this._handleAudioMessage(msg),
      { type: "intercom_native/subscribe_audio", device_id: deviceInfo.device_id }
    );

    this._audioStreaming = true;
    this._chunksSent = 0;
    this._chunksReceived = 0;
  }

  async _answerEspCall(deviceInfo) {
    await this._setupMicAndSpeaker();

    const result = await this._hass.connection.sendMessagePromise({
      type: "intercom_native/answer_esp_call",
      device_id: deviceInfo.device_id,
      host: deviceInfo.host,
    });
    if (!result.success) throw new Error("Answer failed");

    this._unsubscribeAudio = await this._hass.connection.subscribeMessage(
      (msg) => this._handleAudioMessage(msg),
      { type: "intercom_native/subscribe_audio", device_id: deviceInfo.device_id }
    );

    this._audioStreaming = true;
    this._chunksSent = 0;
    this._chunksReceived = 0;
  }

  async _startBridge(sourceDevice, destinationName) {
    const destDevice = this._availableDevices.find(d => d.name === destinationName);
    if (!destDevice?.host) {
      throw new Error(`Destination "${destinationName}" not available`);
    }

    const result = await this._hass.connection.sendMessagePromise({
      type: "intercom_native/bridge",
      source_device_id: sourceDevice.device_id,
      source_host: sourceDevice.host,
      source_name: sourceDevice.name || "Intercom",
      dest_device_id: destDevice.device_id,
      dest_host: destDevice.host,
      dest_name: destDevice.name || "Intercom",
    });

    if (!result.success) throw new Error(result.error || "Bridge failed");
    this._activeBridgeId = result.bridge_id;
  }

  async _answer() {
    const deviceInfo = await this._getDeviceInfo();
    if (!deviceInfo?.device_id) {
      this._showError("Device not found");
      return;
    }

    this._starting = true;
    this._activeDeviceInfo = deviceInfo;
    this._errorMsg = "";
    this._render();

    try {
      const espState = this._getEspState().toLowerCase();
      const destination = this._getDestination();

      // Check if ESP is calling HA (outgoing + destination = Home Assistant)
      if ((espState === "outgoing" || espState === "calling") && destination === "Home Assistant") {
        // ESP is calling us - answer with proper ANSWER message (not START)
        await this._answerEspCall(deviceInfo);
      } else {
        // Normal case: ESP is ringing (we called it), send answer command
        const res = await this._hass.connection.sendMessagePromise({
          type: "intercom_native/answer",
          device_id: deviceInfo.device_id,
        });

        if (!res?.success && this._callButtonEntityId) {
          // Fallback: press call button on ESP
          await this._hass.callService("button", "press", { entity_id: this._callButtonEntityId });
        }
      }
    } catch (err) {
      this._showError(err.message || String(err));
      await this._cleanup();
    } finally {
      this._starting = false;
      this._render();
    }
  }

  async _decline() {
    const deviceInfo = await this._getDeviceInfo();
    if (!deviceInfo?.device_id) {
      this._showError("Device not found");
      return;
    }

    this._stopping = true;
    this._errorMsg = "";
    this._render();

    try {
      const espState = this._getEspState().toLowerCase();
      const destination = this._getDestination();

      // Check if ESP is calling HA (outgoing + destination = Home Assistant)
      if ((espState === "outgoing" || espState === "calling") && destination === "Home Assistant") {
        // ESP is calling us - press ESP's decline button to hang up
        if (this._declineButtonEntityId) {
          await this._hass.callService("button", "press", { entity_id: this._declineButtonEntityId });
        } else if (this._callButtonEntityId) {
          // Fallback: call button acts as toggle (hangup when active)
          await this._hass.callService("button", "press", { entity_id: this._callButtonEntityId });
        }
      } else {
        // Normal decline via WS command
        await this._hass.connection.sendMessagePromise({
          type: "intercom_native/decline",
          device_id: deviceInfo.device_id,
        });
      }
    } catch (err) {
      this._showError(err.message || String(err));
    } finally {
      this._stopping = false;
      this._render();
    }
  }

  async _hangup() {
    this._stopping = true;
    this._render();

    try {
      if (this._activeBridgeId) {
        await this._hass.connection.sendMessagePromise({
          type: "intercom_native/bridge_stop",
          bridge_id: this._activeBridgeId,
        });
      } else if (this._activeDeviceInfo) {
        await this._hass.connection.sendMessagePromise({
          type: "intercom_native/stop",
          device_id: this._activeDeviceInfo.device_id,
        });
      } else {
        // No active session from card - use decline to find and stop any session
        const deviceInfo = await this._getDeviceInfo();
        if (deviceInfo?.device_id) {
          await this._hass.connection.sendMessagePromise({
            type: "intercom_native/decline",
            device_id: deviceInfo.device_id,
          });
        }
      }
    } catch (err) {
      console.error("Hangup error:", err);
    }

    await this._cleanup();
    this._stopping = false;
    this._render();
  }

  async _cleanup() {
    if (this._unsubscribeAudio) { this._unsubscribeAudio(); this._unsubscribeAudio = null; }
    if (this._mediaStream) { this._mediaStream.getTracks().forEach(t => t.stop()); this._mediaStream = null; }
    if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null; }
    if (this._scriptProcessor) { this._scriptProcessor.disconnect(); this._scriptProcessor = null; }
    if (this._source) { this._source.disconnect(); this._source = null; }
    if (this._audioContext) { await this._audioContext.close().catch(() => {}); this._audioContext = null; }
    if (this._playbackContext) { await this._playbackContext.close().catch(() => {}); this._playbackContext = null; }
    this._gainNode = null;
    this._nextPlayTime = 0;
    this._activeDeviceInfo = null;
    this._activeBridgeId = null;
    this._audioStreaming = false;
  }

  async _getDeviceInfo() {
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/list_devices",
      });
      if (result?.devices) {
        const configId = this.config.entity_id || this.config.device_id;
        return result.devices.find(d =>
          d.device_id === configId ||
          d.esphome_id === configId ||
          d.name === configId ||
          d.name?.toLowerCase().replace(/\s+/g, '-') === configId
        );
      }
    } catch (err) {
      console.error("Failed to get device info:", err);
    }
    return null;
  }

  _sendAudio(int16Array) {
    if (!this._audioStreaming || !this._activeDeviceInfo) return;
    const bytes = new Uint8Array(int16Array.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    this._hass.connection.sendMessage({
      type: "intercom_native/audio",
      device_id: this._activeDeviceInfo.device_id,
      audio: btoa(binary),
    });
    this._chunksSent++;
    if (this._chunksSent % 25 === 0) this._updateStats();
  }

  _handleAudioMessage(msg) {
    if (!msg || !this._activeDeviceInfo) return;
    if (msg.device_id !== this._activeDeviceInfo.device_id) return;
    if (!this._audioStreaming || !this._playbackContext) return;

    this._chunksReceived++;
    if (this._chunksReceived % 50 === 0) this._updateStats();

    try {
      const binary = atob(msg.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

      this._playScheduled(float32);
    } catch (err) {}
  }

  _playScheduled(float32) {
    if (!this._playbackContext || !this._gainNode) return;
    try {
      const buffer = this._playbackContext.createBuffer(1, float32.length, 16000);
      buffer.getChannelData(0).set(float32);
      const now = this._playbackContext.currentTime;
      if (this._nextPlayTime < now) this._nextPlayTime = now + 0.01;
      if (this._nextPlayTime - now > 0.2) { this._nextPlayTime = now + 0.02; return; }
      const src = this._playbackContext.createBufferSource();
      src.buffer = buffer;
      src.connect(this._gainNode);
      src.start(this._nextPlayTime);
      this._nextPlayTime += buffer.duration;
    } catch (err) {}
  }

  _updateStats() {
    const el = this.shadowRoot?.getElementById("stats");
    // Show stats when browser audio is active (simple mode or full mode with Home Assistant)
    if (el && this._audioStreaming) {
      el.textContent = `Sent: ${this._chunksSent} | Recv: ${this._chunksReceived}`;
    }
  }

  _showError(msg) {
    this._errorMsg = msg || "";
    const el = this.shadowRoot?.getElementById("err");
    if (el) el.textContent = this._errorMsg;
  }

  disconnectedCallback() {
    // Browser mode: unsubscribe from endpoint events (triggers server-side cleanup)
    if (this._browserSubscription) {
      this._browserSubscription();
      this._browserSubscription = null;
    }
    this._cleanupBrowserAudio();
    this._cleanup();
  }

  getCardSize() { return 3; }

  static getConfigElement() {
    return document.createElement("intercom-card-editor");
  }

  static getStubConfig() {
    return { name: "Intercom" };
  }
}

// Card editor
class IntercomCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._devices = [];
    this._devicesLoaded = false;
  }

  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (hass && !this._devicesLoaded) this._loadDevices();
  }

  async _loadDevices() {
    if (!this._hass || this._devicesLoaded) return;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/list_devices",
      });
      if (result?.devices) {
        this._devices = result.devices;
        this._devicesLoaded = true;
        this._render();
      }
    } catch (err) {
      console.error("Failed to load devices:", err);
    }
  }

  _render() {
    const deviceOptions = this._devices.map(d =>
      `<option value="${d.device_id}" ${this._config.entity_id === d.device_id ? 'selected' : ''}>${d.name}</option>`
    ).join('');

    const currentMode = this._config.mode || 'simple';

    this.innerHTML = `
      <style>
        .form-group { margin-bottom: 16px; }
        .form-group label { display: block; margin-bottom: 4px; font-weight: 500; color: var(--primary-text-color); }
        .form-group input, .form-group select {
          width: 100%; padding: 8px; border: 1px solid var(--divider-color, #ccc);
          border-radius: 4px; background: var(--card-background-color, white);
          color: var(--primary-text-color); font-size: 1em; box-sizing: border-box;
        }
        .info { color: var(--secondary-text-color); font-size: 0.85em; margin-top: 8px; }
        .mode-selector { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
        .mode-btn {
          flex: 1; min-width: 100px; padding: 12px; border: 2px solid var(--divider-color, #ccc);
          border-radius: 8px; background: var(--card-background-color, white);
          cursor: pointer; text-align: center; transition: all 0.2s;
        }
        .mode-btn:hover { border-color: var(--primary-color, #03a9f4); }
        .mode-btn.selected { border-color: var(--primary-color, #03a9f4); background: var(--primary-color, #03a9f4); color: white; }
        .mode-btn .mode-title { font-weight: bold; font-size: 1.1em; }
        .mode-btn .mode-desc { font-size: 0.8em; opacity: 0.8; margin-top: 4px; }
        .mode-info { background: var(--secondary-background-color, #f5f5f5); border-radius: 8px; padding: 12px; margin-top: 16px; }
        .mode-info h4 { margin: 0 0 8px 0; color: var(--primary-text-color); }
        .mode-info p { margin: 0; color: var(--secondary-text-color); font-size: 0.9em; }
      </style>
      <div style="padding: 16px;">
        ${currentMode !== 'browser' ? `
        <div class="form-group">
          <label>Intercom Device</label>
          <select id="entity-select">
            <option value="">-- Select device --</option>
            ${deviceOptions}
          </select>
          <div class="info">${this._devicesLoaded ? (this._devices.length === 0 ? 'No devices found' : 'Select device') : 'Loading...'}</div>
        </div>
        ` : ''}
        <div class="form-group">
          <label>Card Name (optional)</label>
          <input type="text" id="name-input" value="${this._config.name || ''}" placeholder="Intercom">
        </div>
        ${currentMode === 'browser' ? `
        <div class="form-group">
          <label>Endpoint Name</label>
          <input type="text" id="endpoint-name-input" value="${this._config.endpoint_name || ''}" placeholder="e.g. Living Room">
          <div class="info">Human-readable name shown to other browser endpoints.</div>
        </div>
        ` : ''}
        <div class="form-group">
          <label>Mode</label>
          <div class="mode-selector">
            <div class="mode-btn ${currentMode === 'simple' ? 'selected' : ''}" id="mode-simple">
              <div class="mode-title">Simple</div>
              <div class="mode-desc">Browser ↔ ESP</div>
            </div>
            <div class="mode-btn ${currentMode === 'full' ? 'selected' : ''}" id="mode-full">
              <div class="mode-title">Full</div>
              <div class="mode-desc">ESP ↔ ESP</div>
            </div>
            <div class="mode-btn ${currentMode === 'browser' ? 'selected' : ''}" id="mode-browser">
              <div class="mode-title">Browser</div>
              <div class="mode-desc">Browser ↔ Browser</div>
            </div>
          </div>
        </div>
        <div class="mode-info">
          ${currentMode === 'simple' ? `
            <h4>Simple Mode</h4>
            <p>Browser audio ↔ ESP device</p>
          ` : currentMode === 'full' ? `
            <h4>Full Mode</h4>
            <p>ESP ↔ ESP bridged through Home Assistant</p>
          ` : `
            <h4>Browser Mode</h4>
            <p>Browser ↔ Browser via Home Assistant (no ESP required)</p>
          `}
        </div>
      </div>
    `;

    const entitySelect = this.querySelector('#entity-select');
    if (entitySelect) entitySelect.onchange = (e) => this._valueChanged('entity_id', e.target.value);
    this.querySelector('#name-input').onchange = (e) => this._valueChanged('name', e.target.value);
    const epInput = this.querySelector('#endpoint-name-input');
    if (epInput) epInput.onchange = (e) => this._valueChanged('endpoint_name', e.target.value);
    this.querySelector('#mode-simple').onclick = () => this._valueChanged('mode', 'simple');
    this.querySelector('#mode-full').onclick = () => this._valueChanged('mode', 'full');
    this.querySelector('#mode-browser').onclick = () => this._valueChanged('mode', 'browser');
  }

  _valueChanged(key, value) {
    const newConfig = { ...this._config };
    if (value) newConfig[key] = value;
    else delete newConfig[key];
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: newConfig }, bubbles: true, composed: true }));
  }
}

customElements.define("intercom-card", IntercomCard);
customElements.define("intercom-card-editor", IntercomCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "intercom-card",
  name: "Intercom Card",
  description: "ESP intercom control - Simple, Full (ESP-ESP), and Browser (browser-to-browser) modes",
  preview: true,
});
