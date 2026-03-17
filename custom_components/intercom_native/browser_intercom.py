"""Browser-to-browser intercom for Home Assistant (v1).

Architecture:
- BrowserEndpoint: tracks a registered browser client (endpoint_id, display_name,
  websocket connection, state).
- BrowserCallSession: tracks a single call between two browser endpoints
  (call_id, caller, callee, state: ringing|active|ended).
- In-memory registries (cleared on HA restart, endpoints re-register on reload).
- All signaling and audio relay flow through HA websocket; no ESP or TCP dependencies.

Websocket commands:
  browser_register        – subscribe command; registers endpoint and receives events
  browser_unregister      – manually unregister an endpoint
  browser_list_endpoints  – list all online browser endpoints
  browser_call_start      – start a call from caller to callee
  browser_call_answer     – callee answers an incoming call
  browser_call_decline    – callee declines an incoming call
  browser_call_hangup     – either party hangs up
  browser_audio           – relay audio between peers during an active call

Events pushed to the registered subscription:
  endpoint_list_updated   – sent to all endpoints when list changes
  incoming_call           – sent to callee on call_start
  call_answered           – sent to caller when callee answers
  call_declined           – sent to caller when callee declines
  call_ended              – sent to the remaining party when a call ends
  call_busy               – included in the call_start result when callee is busy
  audio                   – forwarded audio chunk to the peer
"""

import logging
import uuid
from typing import Any, Dict, Optional

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory registries (module-level, cleared on HA restart)
# ---------------------------------------------------------------------------

# endpoint_id -> BrowserEndpoint
_browser_endpoints: Dict[str, "BrowserEndpoint"] = {}

# call_id -> BrowserCallSession
_browser_calls: Dict[str, "BrowserCallSession"] = {}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

class BrowserEndpoint:
    """Represents a registered browser endpoint."""

    def __init__(
        self,
        endpoint_id: str,
        display_name: str,
        connection: websocket_api.ActiveConnection,
        msg_id: int,
    ) -> None:
        self.endpoint_id = endpoint_id
        self.display_name = display_name
        self.connection = connection
        self.msg_id = msg_id
        self.state = "idle"  # "idle" | "busy"

    def send_event(self, event_type: str, data: Dict[str, Any]) -> None:
        """Push an event to this endpoint's browser client via the subscription."""
        try:
            self.connection.send_event(self.msg_id, {"event": event_type, **data})
        except Exception:  # noqa: BLE001
            # Connection may already be closed; ignore silently.
            pass

    def to_dict(self) -> Dict[str, Any]:
        """Serialize endpoint info for list responses."""
        return {
            "endpoint_id": self.endpoint_id,
            "display_name": self.display_name,
            "state": self.state,
        }


class BrowserCallSession:
    """Manages a single browser-to-browser call."""

    def __init__(
        self,
        call_id: str,
        caller_endpoint_id: str,
        callee_endpoint_id: str,
    ) -> None:
        self.call_id = call_id
        self.caller_endpoint_id = caller_endpoint_id
        self.callee_endpoint_id = callee_endpoint_id
        self.state = "ringing"  # "ringing" | "active" | "ended"

    def get_peer_endpoint_id(self, endpoint_id: str) -> Optional[str]:
        """Return the other participant's endpoint_id."""
        if endpoint_id == self.caller_endpoint_id:
            return self.callee_endpoint_id
        if endpoint_id == self.callee_endpoint_id:
            return self.caller_endpoint_id
        return None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _broadcast_endpoint_list() -> None:
    """Push the current endpoint list to every registered browser client."""
    endpoint_list = [ep.to_dict() for ep in _browser_endpoints.values()]
    for endpoint in list(_browser_endpoints.values()):
        endpoint.send_event("endpoint_list_updated", {"endpoints": endpoint_list})


def _end_call(
    call_id: str,
    reason: str = "ended",
    exclude_endpoint_id: Optional[str] = None,
) -> None:
    """Terminate a call, free endpoint states, and notify participants."""
    call = _browser_calls.pop(call_id, None)
    if not call:
        return

    call.state = "ended"

    # Free both endpoints
    for ep_id in (call.caller_endpoint_id, call.callee_endpoint_id):
        ep = _browser_endpoints.get(ep_id)
        if ep:
            ep.state = "idle"

    # Notify both sides (skip the one that triggered the end)
    for ep_id in (call.caller_endpoint_id, call.callee_endpoint_id):
        if ep_id == exclude_endpoint_id:
            continue
        ep = _browser_endpoints.get(ep_id)
        if ep:
            ep.send_event("call_ended", {"call_id": call_id, "reason": reason})

    _broadcast_endpoint_list()


def cleanup_endpoint(endpoint_id: str) -> None:
    """Unregister an endpoint and clean up active calls.

    Called when a browser client disconnects or explicitly unregisters.
    """
    endpoint = _browser_endpoints.pop(endpoint_id, None)
    if not endpoint:
        return

    _LOGGER.info("Browser endpoint unregistered: %s (%s)", endpoint_id, endpoint.display_name)

    # End any calls this endpoint is part of
    calls_to_end = [
        call_id
        for call_id, call in list(_browser_calls.items())
        if call.caller_endpoint_id == endpoint_id
        or call.callee_endpoint_id == endpoint_id
    ]
    for call_id in calls_to_end:
        _LOGGER.info("Ending call due to endpoint disconnect: %s", call_id)
        _end_call(call_id, reason="endpoint_disconnected", exclude_endpoint_id=endpoint_id)

    _broadcast_endpoint_list()


# ---------------------------------------------------------------------------
# WebSocket command registration
# ---------------------------------------------------------------------------

def async_register_browser_websocket_api(hass: HomeAssistant) -> None:
    """Register all browser intercom WebSocket commands."""
    websocket_api.async_register_command(hass, websocket_browser_register)
    websocket_api.async_register_command(hass, websocket_browser_unregister)
    websocket_api.async_register_command(hass, websocket_browser_list_endpoints)
    websocket_api.async_register_command(hass, websocket_browser_call_start)
    websocket_api.async_register_command(hass, websocket_browser_call_answer)
    websocket_api.async_register_command(hass, websocket_browser_call_decline)
    websocket_api.async_register_command(hass, websocket_browser_call_hangup)
    websocket_api.async_register_command(hass, websocket_browser_audio)


# ---------------------------------------------------------------------------
# WebSocket command handlers
# ---------------------------------------------------------------------------

@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/browser_register",
        vol.Required("endpoint_id"): str,
        vol.Required("display_name"): str,
    }
)
@callback
def websocket_browser_register(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Register a browser endpoint (subscription command).

    The returned subscription is kept alive while the browser is connected.
    Events (incoming calls, peer audio, list updates) are pushed via this
    subscription.  When the browser navigates away or the websocket closes,
    HA automatically calls the unsub function which cleans up the endpoint.
    """
    endpoint_id = msg["endpoint_id"]
    display_name = msg["display_name"]
    msg_id = msg["id"]

    # If the same endpoint_id is re-registering (e.g. page refresh within the
    # same tab before the old connection has been fully torn down), remove the
    # stale entry first.
    old_ep = _browser_endpoints.pop(endpoint_id, None)
    if old_ep:
        _LOGGER.debug("Replacing stale endpoint registration: %s", endpoint_id)

    endpoint = BrowserEndpoint(
        endpoint_id=endpoint_id,
        display_name=display_name,
        connection=connection,
        msg_id=msg_id,
    )
    _browser_endpoints[endpoint_id] = endpoint

    _LOGGER.info(
        "Browser endpoint registered: %s (%s)", endpoint_id, display_name
    )

    # Register cleanup so HA automatically unregisters this endpoint when the
    # websocket connection closes (or when the client sends an unsubscribe).
    # Guard against stale unsub calls from a previous connection by checking
    # that this connection still owns the endpoint.
    @callback
    def unsub() -> None:
        ep = _browser_endpoints.get(endpoint_id)
        if ep is not None and ep.connection is connection:
            cleanup_endpoint(endpoint_id)

    connection.subscriptions[msg_id] = unsub

    # Acknowledge the subscription
    connection.send_result(msg_id)

    # Immediately push the current endpoint list to the new client
    _broadcast_endpoint_list()


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/browser_unregister",
        vol.Required("endpoint_id"): str,
    }
)
@callback
def websocket_browser_unregister(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Explicitly unregister a browser endpoint."""
    endpoint_id = msg["endpoint_id"]
    cleanup_endpoint(endpoint_id)
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/browser_list_endpoints",
    }
)
@callback
def websocket_browser_list_endpoints(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Return the list of currently registered browser endpoints."""
    endpoints = [ep.to_dict() for ep in _browser_endpoints.values()]
    connection.send_result(msg["id"], {"endpoints": endpoints})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/browser_call_start",
        vol.Required("caller_endpoint_id"): str,
        vol.Required("callee_endpoint_id"): str,
    }
)
@callback
def websocket_browser_call_start(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Start a browser-to-browser call.

    Result:
      success=True, state="ringing", call_id=<uuid>  – callee notified
      success=False, reason="busy"                    – callee already in a call
    """
    caller_id = msg["caller_endpoint_id"]
    callee_id = msg["callee_endpoint_id"]
    msg_id = msg["id"]

    caller = _browser_endpoints.get(caller_id)
    callee = _browser_endpoints.get(callee_id)

    if not caller:
        connection.send_error(
            msg_id, "not_found", f"Caller endpoint '{caller_id}' not registered"
        )
        return

    if not callee:
        connection.send_error(
            msg_id, "not_found", f"Callee endpoint '{callee_id}' not registered"
        )
        return

    if caller.state != "idle":
        connection.send_error(msg_id, "busy", "Caller is already in a call")
        return

    if callee.state != "idle":
        # Callee is busy – return busy result (no call created)
        connection.send_result(msg_id, {"success": False, "reason": "busy"})
        return

    # Create the call
    call_id = str(uuid.uuid4())
    call = BrowserCallSession(
        call_id=call_id,
        caller_endpoint_id=caller_id,
        callee_endpoint_id=callee_id,
    )
    _browser_calls[call_id] = call

    caller.state = "busy"
    callee.state = "busy"

    _LOGGER.info(
        "Browser call started: %s -> %s (call_id=%s)", caller_id, callee_id, call_id
    )

    # Push incoming_call event to callee
    callee.send_event(
        "incoming_call",
        {
            "call_id": call_id,
            "caller_endpoint_id": caller_id,
            "caller_display_name": caller.display_name,
        },
    )

    # Acknowledge to the caller
    connection.send_result(
        msg_id,
        {"success": True, "call_id": call_id, "state": "ringing"},
    )

    _broadcast_endpoint_list()


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/browser_call_answer",
        vol.Required("call_id"): str,
        vol.Required("answering_endpoint_id"): str,
    }
)
@callback
def websocket_browser_call_answer(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Answer an incoming browser call (callee only)."""
    call_id = msg["call_id"]
    answering_id = msg["answering_endpoint_id"]
    msg_id = msg["id"]

    call = _browser_calls.get(call_id)
    if not call:
        connection.send_error(msg_id, "not_found", f"Call '{call_id}' not found")
        return

    if call.callee_endpoint_id != answering_id:
        connection.send_error(msg_id, "forbidden", "Only the callee can answer")
        return

    if call.state != "ringing":
        connection.send_error(
            msg_id, "invalid_state", f"Call is in state '{call.state}', expected 'ringing'"
        )
        return

    call.state = "active"

    _LOGGER.info("Browser call answered: %s (call_id=%s)", answering_id, call_id)

    # Notify caller
    caller = _browser_endpoints.get(call.caller_endpoint_id)
    callee = _browser_endpoints.get(call.callee_endpoint_id)
    if caller:
        caller.send_event(
            "call_answered",
            {
                "call_id": call_id,
                "callee_endpoint_id": answering_id,
                "callee_display_name": callee.display_name if callee else answering_id,
            },
        )

    connection.send_result(msg_id, {"success": True, "call_id": call_id})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/browser_call_decline",
        vol.Required("call_id"): str,
        vol.Required("declining_endpoint_id"): str,
    }
)
@callback
def websocket_browser_call_decline(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Decline an incoming browser call (callee only)."""
    call_id = msg["call_id"]
    declining_id = msg["declining_endpoint_id"]
    msg_id = msg["id"]

    call = _browser_calls.get(call_id)
    if not call:
        connection.send_error(msg_id, "not_found", f"Call '{call_id}' not found")
        return

    if call.callee_endpoint_id != declining_id:
        connection.send_error(msg_id, "forbidden", "Only the callee can decline")
        return

    _LOGGER.info("Browser call declined: %s (call_id=%s)", declining_id, call_id)

    # Notify caller before cleaning up
    caller = _browser_endpoints.get(call.caller_endpoint_id)
    if caller:
        caller.send_event(
            "call_declined",
            {"call_id": call_id, "callee_endpoint_id": declining_id},
        )

    # Clean up (exclude decliner so they don't also receive call_ended)
    _end_call(call_id, reason="declined", exclude_endpoint_id=declining_id)

    connection.send_result(msg_id, {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/browser_call_hangup",
        vol.Required("call_id"): str,
        vol.Required("endpoint_id"): str,
    }
)
@callback
def websocket_browser_call_hangup(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Hang up an active (or ringing) browser call.

    Either the caller or callee can hang up at any time.
    """
    call_id = msg["call_id"]
    endpoint_id = msg["endpoint_id"]
    msg_id = msg["id"]

    call = _browser_calls.get(call_id)
    if not call:
        connection.send_error(msg_id, "not_found", f"Call '{call_id}' not found")
        return

    if endpoint_id not in (call.caller_endpoint_id, call.callee_endpoint_id):
        connection.send_error(msg_id, "forbidden", "Not a participant in this call")
        return

    _LOGGER.info("Browser call hung up by %s (call_id=%s)", endpoint_id, call_id)

    _end_call(call_id, reason="hangup", exclude_endpoint_id=endpoint_id)

    connection.send_result(msg_id, {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/browser_audio",
        vol.Required("call_id"): str,
        vol.Required("sender_endpoint_id"): str,
        vol.Required("audio"): str,  # base64-encoded PCM
    }
)
@callback
def websocket_browser_audio(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Relay an audio chunk from one browser peer to the other.

    This command is fire-and-forget (no response sent).  Audio is only
    forwarded when the call is in the 'active' state to avoid forwarding
    audio captured during the ringing phase.
    """
    call_id = msg["call_id"]
    sender_id = msg["sender_endpoint_id"]
    audio_b64 = msg["audio"]

    call = _browser_calls.get(call_id)
    if not call or call.state != "active":
        return

    peer_id = call.get_peer_endpoint_id(sender_id)
    if not peer_id:
        return

    peer = _browser_endpoints.get(peer_id)
    if not peer:
        return

    peer.send_event(
        "audio",
        {
            "call_id": call_id,
            "sender_endpoint_id": sender_id,
            "audio": audio_b64,
        },
    )
