"""Server authorization for Strategy Lab mutations; no credentials in public assets."""
import asyncio
from collections import deque
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import tempfile
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/api/terminal-auth")
SESSION_SECONDS = 3600
REMEMBER_SECONDS = 86400
REMEMBER_COOKIE = "__Host-skhynix_terminal_remember"
_sessions = {}
_attempts = deque()


def _remember_path():
    return Path(os.environ.get("TERMINAL_REMEMBER_FILE", str(Path(__file__).with_name("terminal_auth_sessions.json"))))


def _auth_version():
    path = Path(os.environ.get("TERMINAL_AUTH_FILE", str(Path(__file__).with_name("terminal_auth.json"))))
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
        return hashlib.sha256((config["salt"] + config["hash"]).encode()).hexdigest()
    except (OSError, ValueError, KeyError, TypeError):
        return ""


def _remembered():
    try:
        raw = json.loads(_remember_path().read_text(encoding="utf-8"))
        version = _auth_version()
        if not version or not isinstance(raw, dict) or raw.get("auth_version") != version:
            return {}
        raw = raw.get("sessions")
        if not isinstance(raw, dict):
            return {}
        now = time.time()
        return {key: float(expiry) for key, expiry in raw.items()
                if isinstance(key, str) and len(key) == 64 and isinstance(expiry, (int, float))
                and now < float(expiry) <= now + REMEMBER_SECONDS}
    except (OSError, ValueError, TypeError):
        return {}  # Missing or malformed state never authorizes a browser.


def _save_remembered(sessions):
    path = _remember_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".terminal-auth-", delete=False) as stream:
            name = stream.name
            json.dump({"auth_version": _auth_version(), "sessions": sessions}, stream,
                      separators=(",", ":"), allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def _issue_access_token():
    token = secrets.token_urlsafe(32)
    now = time.monotonic()
    for old, expiry in list(_sessions.items()):
        if expiry <= now:
            _sessions.pop(old, None)
    if len(_sessions) >= 16:
        _sessions.pop(next(iter(_sessions)))
    _sessions[hashlib.sha256(token.encode()).hexdigest()] = now + SESSION_SECONDS
    return token


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
    remember_token = secrets.token_urlsafe(32)
    remembered = _remembered()
    if len(remembered) >= 32:
        remembered.pop(next(iter(remembered)))
    remembered[hashlib.sha256(remember_token.encode()).hexdigest()] = time.time() + REMEMBER_SECONDS
    try:
        _save_remembered(remembered)
    except OSError:
        raise HTTPException(503, "Terminal session storage unavailable") from None
    response = JSONResponse({"success": True, "token": _issue_access_token(),
                             "expires_in": SESSION_SECONDS, "remembered_for": REMEMBER_SECONDS})
    response.set_cookie(REMEMBER_COOKIE, remember_token, max_age=REMEMBER_SECONDS,
                        secure=True, httponly=True, samesite="strict", path="/")
    response.headers["Cache-Control"] = "no-store"
    return response


@router.post("/resume")
async def resume(request: Request):
    remember_token = request.cookies.get(REMEMBER_COOKIE, "")
    if not remember_token or len(remember_token) > 128:
        raise HTTPException(401, "Password required")
    expiry = _remembered().get(hashlib.sha256(remember_token.encode()).hexdigest(), 0)
    if expiry <= time.time():
        raise HTTPException(401, "Password required")
    response = JSONResponse({"success": True, "token": _issue_access_token(),
                             "expires_in": SESSION_SECONDS, "remembered_for": max(0, int(expiry - time.time()))})
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/status")
async def status(request: Request):
    return {"authorized": authorized(request)}


@router.post("/lock")
async def lock(request: Request):
    _sessions.pop(hashlib.sha256(_token(request).encode()).hexdigest(), None)
    return {"success": True}


@router.post("/forget")
async def forget(request: Request):
    remember_token = request.cookies.get(REMEMBER_COOKIE, "")
    if remember_token:
        remembered = _remembered()
        remembered.pop(hashlib.sha256(remember_token.encode()).hexdigest(), None)
        try:
            _save_remembered(remembered)
        except OSError:
            raise HTTPException(503, "Terminal session storage unavailable") from None
    _sessions.pop(hashlib.sha256(_token(request).encode()).hexdigest(), None)
    response = JSONResponse({"success": True})
    response.delete_cookie(REMEMBER_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
    response.headers["Cache-Control"] = "no-store"
    return response
