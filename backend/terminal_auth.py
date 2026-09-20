"""Server authorization for Strategy Lab mutations; no credentials in public assets."""
import asyncio
from collections import deque
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import time

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/terminal-auth")
SESSION_SECONDS = 3600
_sessions = {}
_attempts = deque()


def _password_matches(password):
    path = Path(os.environ.get("TERMINAL_AUTH_FILE", str(Path(__file__).with_name("terminal_auth.json"))))
    try:
        config = json.loads(path.read_text())
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(config["salt"]), n=16384, r=8, p=1).hex()
        return hmac.compare_digest(digest, config["hash"])
    except (OSError, ValueError, KeyError):
        return False  # Missing/malformed credentials always fail closed.


def _token(request):
    header = request.headers.get("authorization", "")
    return header[7:] if header.startswith("Bearer ") else ""


def authorized(request):
    now = time.monotonic()
    for token, expiry in list(_sessions.items()):
        if expiry <= now:
            _sessions.pop(token, None)
    token = _token(request)
    return bool(token) and _sessions.get(hashlib.sha256(token.encode()).hexdigest(), 0) > now


@router.post("/unlock")
async def unlock(request: Request):
    now = time.monotonic()
    while _attempts and _attempts[0] <= now - 60:
        _attempts.popleft()
    if len(_attempts) >= 5:
        raise HTTPException(429, "Too many unlock attempts; wait one minute")
    _attempts.append(now)
    raw = await request.body()
    if len(raw) > 2048:
        raise HTTPException(400, "Invalid password request")
    try:
        password = json.loads(raw).get("password", "")
    except (ValueError, AttributeError):
        raise HTTPException(400, "Invalid password request")
    if not isinstance(password, str) or not await asyncio.to_thread(_password_matches, password):
        raise HTTPException(401, "Incorrect password or terminal access not configured")
    token = secrets.token_urlsafe(32)
    authorized(request)  # Prune expired sessions.
    if len(_sessions) >= 16:
        _sessions.pop(next(iter(_sessions)))
    _sessions[hashlib.sha256(token.encode()).hexdigest()] = time.monotonic() + SESSION_SECONDS
    return {"success": True, "token": token, "expires_in": SESSION_SECONDS}


@router.get("/status")
async def status(request: Request):
    return {"authorized": authorized(request)}


@router.post("/lock")
async def lock(request: Request):
    _sessions.pop(hashlib.sha256(_token(request).encode()).hexdigest(), None)
    return {"success": True}
