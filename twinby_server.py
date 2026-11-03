# twinby_server.py — менеджер задач Twinby
import json, gzip, socket, ssl
from datetime import datetime
import uuid
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from shared import supabase, CANCEL_FLAGS, require_auth
import http.client
from twinby_client import _Socks5HTTPSConnection as Socks5HTTPSConnection


def socks5_connect(proxy_host, proxy_port, target_host, target_port, username=None, password=None, timeout=30):
    sock = socket.create_connection((proxy_host, proxy_port), timeout=timeout)
    sock.settimeout(timeout)
    if username:
        sock.sendall(b"\x05\x02\x00\x02")
    else:
        sock.sendall(b"\x05\x01\x00")
    resp = sock.recv(2)
    if len(resp) < 2 or resp[0] != 0x05:
        raise RuntimeError("SOCKS5 handshake failed: " + repr(resp))
    method = resp[1]
    if method == 0x02:
        u = username.encode()
        p = (password or "").encode()
        sock.sendall(bytes([0x01, len(u)]) + u + bytes([len(p)]) + p)
        auth_resp = sock.recv(2)
        if len(auth_resp) < 2 or auth_resp[1] != 0x00:
            raise RuntimeError("SOCKS5 auth failed: " + repr(auth_resp))
    elif method == 0xFF:
        raise RuntimeError("SOCKS5: server rejected all auth methods")
    host_bytes = target_host.encode()
    req = b"\x05\x01\x00\x03" + bytes([len(host_bytes)]) + host_bytes + int(target_port).to_bytes(2, "big")
    sock.sendall(req)
    resp = sock.recv(10)
    if len(resp) < 2 or resp[1] != 0x00:
        code = resp[1] if len(resp) > 1 else "?"
        raise RuntimeError("SOCKS5 CONNECT failed, code=" + str(code))
    return sock

app = FastAPI(title="CLAW-AI Twinby Manager")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

class LikesTaskRequest(BaseModel):
    account_id: str
    limit: int = 10

class AutoReplyTaskRequest(BaseModel):
    account_id: str
    max_dialogs: int = 20

class StopTaskRequest(BaseModel):
    account_id: str
    job_type: str | None = None

def enqueue_job(account_id: str, job_type: str, payload: dict) -> dict:
    existing = supabase.table("job_queue").select("id").eq("account_id", account_id).eq("type", job_type).in_("status", ["pending", "running"]).limit(1).execute()
    if existing.data:
        return existing.data[0]
    res = supabase.table("job_queue").insert({"account_id": account_id, "type": job_type, "payload": payload, "status": "pending"}).execute()
    return res.data[0]

@app.get("/")
def root():
    return {"ok": True, "service": "twinby-manager"}

@app.head("/")
def root_head():
    from fastapi.responses import Response
    return Response(status_code=200)

@app.head("/health")
def health_head():
    from fastapi.responses import Response
    return Response(status_code=200)

@app.get("/health")
def health():
    return {"ok": True, "service": "twinby-manager"}

@app.post("/api/tasks/twinby-likes")
def api_twinby_likes(payload: LikesTaskRequest):
    job = enqueue_job(payload.account_id, "likes-http", {"limit": payload.limit})
    return {"ok": True, "job_id": job["id"], "status": "pending"}

@app.post("/api/tasks/twinby-auto-reply")
def api_twinby_auto_reply(payload: AutoReplyTaskRequest):
    job = enqueue_job(payload.account_id, "auto-reply-http", {"max_dialogs": payload.max_dialogs})
    return {"ok": True, "job_id": job["id"], "status": "pending"}

@app.post("/api/tasks/stop")
def api_stop(payload: StopTaskRequest):
    CANCEL_FLAGS[payload.account_id] = True
    q = supabase.table("job_queue").update({"status": "cancelled"}).eq("account_id", payload.account_id).in_("status", ["pending", "running"])
    if payload.job_type:
        q = q.in_("type", [payload.job_type, f"{payload.job_type}-http"])
    q.execute()
    return {"ok": True}

@app.post("/api/twinby/send-code")
async def twinby_send_code(payload: dict, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    email = (payload.get("email") or "").strip()
    if not email:
        raise HTTPException(status_code=400, detail="email обязателен")
    import json as _json, http.client as _hc, asyncio
    body = _json.dumps({"login": email, "provider": "email", "codeSender": "email"}, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Dart/3.11 (dart:io)",
        "Content-Length": str(len(body)),
    }

    def _do_request():
        # ВСЕГДА напрямую, без прокси
        conn = _hc.HTTPSConnection("twinby.ru", timeout=30)
        conn.request("POST", "/api/auth/v2/auth/init", body=body, headers=headers)
        resp = conn.getresponse()
        status = resp.status
        resp.read()
        conn.close()
        return status

    try:
        status = await asyncio.to_thread(_do_request)
        if status not in (200, 202):
            raise HTTPException(status_code=400, detail=f"Twinby вернул {status}")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[TWINBY SEND-CODE ERROR] {type(e).__name__}: {e!r}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

@app.get("/api/debug/twinby-proxy-test")
def debug_twinby_proxy_test():
    import time, socket, ssl, base64, json as _json
    from proxy_loader import get_proxy as _gp

    _px = _gp("twinby")
    log = []
    t0 = time.time()

    def step(msg):
        line = f"{msg} ({round(time.time()-t0,2)}s)"
        log.append(line)
        print(f"[TWINBY DEBUG] {line}", flush=True)

    step(f"proxy_config: host={_px.get('host')} port={_px.get('port')} use_proxy={_px.get('use_proxy')}")

    if not (_px.get("use_proxy") and _px.get("host")):
        step("прокси не настроен — тест прекращён")
        return {"log": log}

    host = _px["host"]
    port = int(_px.get("port") or 8080)
    user = _px.get("username", "")
    pw = _px.get("password", "")
    sock = None
    ssock = None

    try:
        step("stage1: TCP-connect к прокси...")
        sock = socket.create_connection((host, port), timeout=10)
        step("stage1 OK")
    except Exception as e:
        step(f"stage1 FAILED: {type(e).__name__}: {e}")
        return {"log": log}

    try:
        step("stage2: CONNECT twinby.ru:443 через прокси...")
        auth = base64.b64encode(f"{user}:{pw}".encode()).decode()
        connect_req = (
            f"CONNECT twinby.ru:443 HTTP/1.1\r\n"
            f"Host: twinby.ru:443\r\n"
            f"Proxy-Authorization: Basic {auth}\r\n"
            f"Proxy-Connection: Keep-Alive\r\n\r\n"
        ).encode()
        sock.sendall(connect_req)
        sock.settimeout(10)
        resp = sock.recv(4096)
        step(f"stage2 response: {resp[:200]!r}")
        if b"200" not in resp.split(b"\r\n", 1)[0]:
            step("stage2 FAILED: прокси не установил туннель")
            return {"log": log}
    except Exception as e:
        step(f"stage2 FAILED: {type(e).__name__}: {e}")
        return {"log": log}

    try:
        step("stage3: TLS handshake к twinby.ru...")
        ctx = ssl.create_default_context()
        sock.settimeout(10)
        ssock = ctx.wrap_socket(sock, server_hostname="twinby.ru")
        step("stage3 OK")
    except Exception as e:
        step(f"stage3 FAILED: {type(e).__name__}: {e}")
        return {"log": log}

    try:
        step("stage4: отправка HTTPS-запроса...")
        body = _json.dumps({"login": "swope-85@mail.ru", "provider": "email", "codeSender": "email"}).encode()
        req = (
            f"POST /api/auth/v2/auth/init HTTP/1.1\r\n"
            f"Host: twinby.ru\r\n"
            f"Content-Type: application/json\r\n"
            f"Accept: application/json\r\n"
            f"User-Agent: Dart/3.11 (dart:io)\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n\r\n"
        ).encode() + body
        ssock.sendall(req)
        step("stage4 отправлено")
    except Exception as e:
        step(f"stage4 FAILED: {type(e).__name__}: {e}")
        return {"log": log}

    try:
        step("stage5: ожидание ответа...")
        ssock.settimeout(15)
        data = b""
        while True:
            chunk = ssock.recv(4096)
            if not chunk:
                break
            data += chunk
            if len(data) > 2000:
                break
        step(f"stage5 OK, получено {len(data)} байт: {data[:300]!r}")
    except Exception as e:
        step(f"stage5 FAILED: {type(e).__name__}: {e}")
        return {"log": log}
    finally:
        try:
            (ssock or sock).close()
        except Exception:
            pass

    return {"log": log}

@app.post("/api/connect")
async def connect_twinby(payload: dict, authorization: str | None = Header(default=None)):
    require_auth(authorization)

    email = (payload.get("twinby_email") or "").strip()
    code = (payload.get("twinby_code") or "").strip()
    account_name = (payload.get("account_name") or email).strip()

    if not email or not code:
        raise HTTPException(status_code=400, detail="Введи email и код из письма")

    import json as _json, http.client as _hc, base64, asyncio
    from proxy_loader import get_proxy as _gp2
    px = _gp2("twinby")

    body = _json.dumps({"login": email, "provider": "email", "code": code}, ensure_ascii=False).encode()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Dart/3.11 (dart:io)",
        "Content-Length": str(len(body)),
    }

    def _do_confirm():
        if not (px.get("host") and px.get("username")):
            raise RuntimeError("Прокси не настроен в Supabase (proxy_settings, id=twinby) — подключение без прокси запрещено")
        conn = Socks5HTTPSConnection(
            "twinby.ru", 443,
            px["host"], int(px.get("port") or 1080),
            px.get("username"), px.get("password"),
            timeout=30,
        )
        conn.request("POST", "/api/auth/v2/auth/confirm", body=body, headers=headers)
        resp = conn.getresponse()
        status = resp.status
        raw = resp.read()
        conn.close()
        return status, raw

    try:
        status, raw = await asyncio.to_thread(_do_confirm)
    except Exception as e:
        print(f"[TWINBY CONNECT ERROR] {type(e).__name__}: {e!r}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

    if status != 200:
        raise HTTPException(status_code=400, detail=f"Неверный код или email (статус {status})")

    data = _json.loads(raw.decode("utf-8", errors="ignore"))
    token = data.get("accessToken") or data.get("token") or data.get("access") or data.get("jwt") or ""
    if not token:
        raise HTTPException(status_code=400, detail=f"Twinby не вернул токен. Ответ: {str(data)[:200]}")

    # Получаем фото профиля
    photo_url = ""
    try:
        from twinby_client import get_me
        me = get_me(token)
        avatar = me.get("avatar") or {}
        photo_url = avatar.get("file") or avatar.get("preview") or ""
        if not photo_url:
            photos = me.get("photos") or []
            if photos and isinstance(photos[0], dict):
                photo_url = photos[0].get("file") or photos[0].get("preview") or ""
        print(f"[TWINBY CONNECT] фото: {photo_url}", flush=True)
    except Exception as e:
        print(f"[TWINBY CONNECT] фото не получено: {e}", flush=True)

    import uuid as _uuid
    account_id = str(_uuid.uuid4())

    public_account = {
        "id": account_id,
        "owner_email": require_auth(authorization)["email"],
        "platform": "Twinby",
        "name": account_name,
        "profile_url": "https://twinby.ru",
        "final_url": "https://twinby.ru",
        "title": account_name,
        "photo_url": photo_url,
        "cookies_count": 1,
        "cookies_valid": True,
        "session_valid": True,
        "session_reason": "JWT авторизация",
        "images_found": 0,
        "checked_at": datetime.now().isoformat(timespec="seconds"),
    }

    supabase.table("accounts").insert(public_account).execute()
    supabase.table("accounts_private").insert({
        "id": account_id,
        "cookies_raw": token
    }).execute()

    return {
        "ok": True,
        "account": public_account,
        "warning": None if photo_url else "Фото не найдено — добавь вручную.",
    }

@app.get("/api/jobs/{job_id}")
def api_get_job(job_id: str):
    if not job_id or job_id == "undefined":
        return {"ok": False, "job": None}
    res = supabase.table("job_queue").select("*").eq("id", job_id).limit(1).execute()
    return {"ok": True, "job": res.data[0] if res.data else None}

@app.get("/api/jobs/account/{account_id}/active")
def api_get_active_job(account_id: str):
    res = supabase.table("job_queue").select("*").eq("account_id", account_id).in_("status", ["pending", "running"]).order("created_at", desc=True).limit(1).execute()
    return {"ok": True, "job": res.data[0] if res.data else None}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8004)
