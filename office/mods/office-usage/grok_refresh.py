#!/usr/bin/env python3
"""Grok CLI 로그인 토큰 갱신.

~/.grok/auth.json의 access token이 만료됐으면 refresh token으로 새로 받아 같은 파일에 다시 쓴다.
Grok CLI와 같은 잠금 파일(auth.json.lock)을 잡고, 잡은 뒤 다시 읽어서 그사이 Grok이 이미
갱신했으면 아무것도 하지 않는다. 토큰은 출력하지 않는다.

출력(JSON 한 줄): {"ok": true} | {"error": "login" | "network" | "missing", "detail": "..."}
"""
import fcntl
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~/.grok")
AUTH = os.path.join(HOME, "auth.json")
LOCK = AUTH + ".lock"
MARGIN = 120  # 만료 2분 전부터 갱신 대상으로 본다


def out(**kw):
    print(json.dumps(kw))
    sys.exit(0)


def expired(entry):
    try:
        exp = datetime.fromisoformat(entry["expires_at"].replace("Z", "+00:00"))
    except Exception:
        return True
    return exp.timestamp() - MARGIN < time.time()


def token_endpoint(issuer):
    with urllib.request.urlopen(issuer.rstrip("/") + "/.well-known/openid-configuration", timeout=10) as r:
        return json.load(r)["token_endpoint"]


def main():
    if not os.path.exists(AUTH):
        out(error="missing")
    with open(LOCK, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with open(AUTH) as f:
            data = json.load(f)
        if not data:
            out(error="missing")
        key = next(iter(data))
        entry = data[key]
        if not expired(entry):
            out(ok=True, fresh=False)
        refresh = entry.get("refresh_token")
        if not refresh:
            out(error="login")
        try:
            endpoint = token_endpoint(entry.get("oidc_issuer") or "https://auth.x.ai")
            body = urllib.parse.urlencode({
                "grant_type": "refresh_token",
                "refresh_token": refresh,
                "client_id": entry.get("oidc_client_id", ""),
            }).encode()
            req = urllib.request.Request(endpoint, data=body, headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as r:
                tok = json.load(r)
        except urllib.error.HTTPError as e:
            # invalid_grant 등: refresh token이 더는 유효하지 않다 → 다시 로그인해야 한다.
            out(error="login" if e.code in (400, 401, 403) else "network", detail=f"HTTP {e.code}")
        except Exception as e:
            out(error="network", detail=type(e).__name__)
        if not tok.get("access_token"):
            out(error="login", detail="no access_token")
        entry["key"] = tok["access_token"]
        if tok.get("refresh_token"):
            entry["refresh_token"] = tok["refresh_token"]
        expires_in = int(tok.get("expires_in") or 3600)
        entry["expires_at"] = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat().replace("+00:00", "Z")
        data[key] = entry
        fd, tmp = tempfile.mkstemp(dir=HOME, prefix=".auth.json.")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as f:
                # Grok이 쓰는 형식 그대로: 들여쓰기 2, 비ASCII 그대로, 끝 줄바꿈 없음.
                json.dump(data, f, indent=2, ensure_ascii=False)
            os.replace(tmp, AUTH)
        except Exception:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        out(ok=True, fresh=True)


main()
