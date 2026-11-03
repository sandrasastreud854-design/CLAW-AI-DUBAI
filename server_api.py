# server_api.py — главный API сервер CLAW-DATYNG
# Отвечает за: авторизацию, аккаунты, настройки, фронтенд
# Проксирует задачи на воркер-серверы платформ
# Запуск: uvicorn server_api:app --host 0.0.0.0 --port 8001

import asyncio
import json
import os
import re
import random
import uuid
import http.client
import socks
import ssl
import time
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
import bisect
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Header, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


class SocksHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, proxy_host, proxy_port, proxy_user, proxy_pass, timeout=30):
        super().__init__(host, port, timeout=timeout)
        self._proxy_host = proxy_host
        self._proxy_port = proxy_port
        self._proxy_user = proxy_user
        self._proxy_pass = proxy_pass

    def connect(self):
        sock = socks.socksocket()
        sock.set_proxy(
            socks.SOCKS5, self._proxy_host, self._proxy_port,
            username=self._proxy_user, password=self._proxy_pass, rdns=True
        )
        sock.settimeout(self.timeout)
        sock.connect((self.host, self.port))
        context = ssl.create_default_context()
        self.sock = context.wrap_socket(sock, server_hostname=self.host)

from shared import (
    supabase, require_auth, create_session,
    hash_password, verify_password, get_ai_settings, save_ai_settings,
    get_team_owner_emails, ACCESS_CODE,
)

# ── URL воркер-серверов ───────────────────────────────────
# Замени на реальные URL после деплоя на Render
MAMBA_SERVER_URL      = "https://mamba-server-gpn5.onrender.com"
LOVELAZ_SERVER_URL    = "https://lovelaz-server-2.onrender.com"
TWINBY_SERVER_URL     = "https://twynb-server.onrender.com"
VZNAKOMSTVE_SERVER_URL = "https://vznakomstve-server-b1r4.onrender.com"
OPERATOR_SERVER_URL   = "https://operator-server-py.onrender.com"
ATOLIN_SERVER_URL     = "https://atolin-server.onrender.com"
LOVERU_SERVER_URL     = "https://loveru-server.onrender.com"  # URL после деплоя

PLATFORM_URLS = {
    "mamba":        MAMBA_SERVER_URL,
    "lovelaz":      LOVELAZ_SERVER_URL,
    "twinby":       TWINBY_SERVER_URL,
    "vznakomstve":  VZNAKOMSTVE_SERVER_URL,
    "atolin":       ATOLIN_SERVER_URL,
    "loveru":       LOVERU_SERVER_URL,
}

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

app = FastAPI(title="CLAW-AI API Server")

# Один клиент на всё приложение вместо нового на каждый вызов.
HTTP_CLIENT = httpx.AsyncClient(
    timeout=30,
    limits=httpx.Limits(max_connections=40, max_keepalive_connections=15),
)
# Потолок одновременных проверок — сколько бы анкет ни было.
CHECK_SEMAPHORE = asyncio.Semaphore(10)
IMAGE_SEMAPHORE = asyncio.Semaphore(8)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv(
        "ALLOWED_ORIGINS",
        "https://server-py-0uy8.onrender.com"
    ).split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Helper: проксирование на воркер ──────────────────────

async def proxy_to_worker(platform: str, path: str, payload: dict, authorization: str = None) -> dict:
    base_url = PLATFORM_URLS.get(platform.lower())
    if not base_url:
        raise HTTPException(status_code=400, detail=f"Неизвестная платформа: {platform}")

    headers = {"Content-Type": "application/json"}
    if authorization:
        headers["Authorization"] = authorization

    try:
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(f"{base_url}{path}", json=payload, headers=headers)
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Воркер {platform} недоступен")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Воркер {platform} не ответил вовремя")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if not resp.content:
        raise HTTPException(
            status_code=502,
            detail=f"Воркер {platform} вернул пустой ответ (возможно, ещё не проснулся после сна)"
        )

    try:
        data = resp.json()
    except ValueError:
        raise HTTPException(
            status_code=502,
            detail=f"Воркер {platform} вернул не-JSON ответ (status={resp.status_code}): {resp.text[:200]}"
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=data.get("detail") or data)

    return data

# ── Pydantic Models ───────────────────────────────────────

class RegisterRequest(BaseModel):
    email: str
    password: str
    access_code: str
    username: str = ""

class LoginRequest(BaseModel):
    email: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class UpdateProfileRequest(BaseModel):
    username: str = ""

class AiSettingsPayload(BaseModel):
    groq_api_key: str = ""
    groq_api_keys: str = ""
    groq_model: str = "openai/gpt-oss-20b"
    bot_name: str = ""
    bot_age: str = ""
    bot_gender: str = "female"
    location: str = ""
    persona: str = ""
    goal: str = ""
    stop_topics: str = ""
    contacts: str = ""
    contacts_trigger: str = ""
    tg_chat_id: str = ""
    gemini_api_keys: str = ""
    proxy_protocol: str = ""
    proxy_host: str = ""
    proxy_port: str = ""
    proxy_login: str = ""
    proxy_password: str = ""
    user_agent: str = ""

class LikesTaskRequest(BaseModel):
    account_id: str
    limit: int = 10
    platform: str = "mamba"

class AutoReplyTaskRequest(BaseModel):
    account_id: str
    max_dialogs: int = 20
    platform: str = "mamba"

class StopTaskRequest(BaseModel):
    account_id: str

class TeamInviteRequest(BaseModel):
    email: str
    role: str = "manager"

class AcceptInviteRequest(BaseModel):
    invite_id: str
    email: str = ""

class RejectInviteRequest(BaseModel):
    invite_id: str
    email: str = ""

class CreateTabRequest(BaseModel):
    name: str
    platform: str = "Mamba"

class AssignTabRequest(BaseModel):
    account_id: str
    tab_id: str

class AccountRunStatusPayload(BaseModel):
    run_status: str = "idle"
    run_task: str = ""
    run_note: str = ""
    is_blocked: bool | None = None

class ProxyNodePayload(BaseModel):
    id: str
    platform: str = "Mamba"
    protocol: str = "http"
    host: str = ""
    port: str = ""
    login: str = ""
    password: str = ""
    user_agent: str = ""
    x: float = 300
    y: float = 300


class RunSchedulePayload(BaseModel):
    work_sec: int = 600
    pause_sec: int = 90
    limit_likes: int = 10
    enabled: bool = True
    do_likes: bool = True
    do_chats: bool = True


class RunOptsPayload(BaseModel):
    """Галочки с карточки — меняем настройки, не трогая запуск."""
    limit_likes: int | None = None
    do_likes: bool | None = None
    do_chats: bool | None = None

class AccountUpdateRequest(BaseModel):
    name: str | None = None

class SplitLogPushRequest(BaseModel):
    account_id: str
    messages: list[str]

class ProxySettingsModel(BaseModel):
    id: str
    host: str
    port: int
    username: str
    password: str
    use_proxy: bool = True
    user_agent: str = ""

def load_platform_proxy(platform_id: str) -> dict | None:
    """Строка из proxy_settings по id платформы ('badanga', 'mamba'...).
    Возвращает словарь в том виде, который ждёт set_account_proxy."""
    try:
        res = (supabase.table("proxy_settings").select("*")
               .eq("id", (platform_id or "").lower()).limit(1).execute())
    except Exception as e:
        print(f"[PROXY] proxy_settings для {platform_id} не прочитались: {e}", flush=True)
        return None
    row = (res.data or [None])[0]
    if not row or not row.get("host") or not row.get("use_proxy"):
        return None
    return {
        "proxy_host": row.get("host") or "",
        "proxy_port": row.get("port") or 1080,
        "proxy_login": row.get("username") or "",
        "proxy_password": row.get("password") or "",
        "proxy_protocol": "socks5",
        "user_agent": row.get("user_agent") or "",
    }


class ConnectAccountRequest(BaseModel):
    account_name: str
    profile_url: str
    cookies_raw: str = ""
    platform: str = "Mamba"
    twinby_email: str = ""
    twinby_code: str = ""
    vzn_email: str = ""
    vzn_code: str = ""
    intcity_email: str = ""
    intcity_password: str = ""
    atolin_role: str = "main"
    atolin_proxy: str = ""
    atolin_proxy_scheme: str = "socks5h"
    proxy: str = ""
    proxy_scheme: str = "socks5"
    user_agent: str = ""

class OperatorSendCodeRequest(BaseModel):
    phone: str

class OperatorLoginVerifyRequest(BaseModel):
    account_name: str = ""
    phone: str
    code: str
    password: str = ""

class SetChainRequest(BaseModel):
    account_id: str
    chain: list[str]

# ── Auth ──────────────────────────────────────────────────

@app.post("/api/auth/register")
def register(payload: RegisterRequest):
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Некорректный email")
    if len(payload.password) < 6:
        raise HTTPException(status_code=400, detail="Пароль должен быть не менее 6 символов")
    if payload.access_code.strip() != ACCESS_CODE:
        raise HTTPException(status_code=403, detail="Неверный код доступа")
    existing = supabase.table("app_users").select("id").eq("email", email).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="Пользователь уже зарегистрирован")
    password_hash = hash_password(payload.password)
    username = (payload.username or "").strip()
    res = supabase.table("app_users").insert({
        "email": email,
        "password_hash": password_hash,
        "username": username or email.split("@")[0],
    }).execute()
    user = res.data[0]
    token = create_session(user["id"], user["email"])
    return {"ok": True, "token": token, "email": user["email"], "username": user.get("username", "")}

_login_fails: dict[str, list] = {}
LOGIN_MAX_FAILS = 7
LOGIN_BLOCK_SEC = 15 * 60


@app.post("/api/auth/login")
def login(payload: LoginRequest):
    email = payload.email.strip().lower()

    # Перебор пароля: после семи промахов почта закрывается на 15 минут
    _now = time.time()
    _f = [t for t in _login_fails.get(email, []) if _now - t < LOGIN_BLOCK_SEC]
    _login_fails[email] = _f
    if len(_f) >= LOGIN_MAX_FAILS:
        raise HTTPException(status_code=429,
                            detail="Слишком много попыток. Попробуй через 15 минут.")

    try:
        res = supabase.table("app_users").select("*").eq("email", email).execute()
    except Exception as e:
        print(f"[LOGIN] select app_users упал: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail="База временно недоступна")

    if not res.data:
        raise HTTPException(status_code=401, detail="Неверный email или пароль")

    user = res.data[0]

    if "password_hash" not in user:
        raise HTTPException(
            status_code=500,
            detail="Ошибка конфигурации учётных записей",
        )

    if not verify_password(payload.password, user["password_hash"]):
        _login_fails.setdefault(email, []).append(time.time())
        time.sleep(0.7)        # гасим скоростной перебор
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    _login_fails.pop(email, None)

    try:
        token = create_session(user["id"], user["email"])
    except Exception as e:
        print(f"[LOGIN] create_session упал: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"Сессия не создалась: {type(e).__name__}: {e}")

    return {"ok": True, "token": token, "email": user["email"]}

@app.get("/api/auth/me")
def auth_me(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    res = supabase.table("app_users").select("username").eq("id", session["user_id"]).execute()
    username = res.data[0].get("username") if res.data else ""
    return {"ok": True, "email": session["email"], "username": username,
            "is_admin": (session["email"] or "").lower() in ADMIN_EMAILS}

@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)):
    if authorization and authorization.startswith("Bearer "):
        token = authorization[len("Bearer "):].strip()
        supabase.table("app_sessions").delete().eq("token", token).execute()
    return {"ok": True}

@app.post("/api/auth/update-profile")
def api_update_profile(payload: UpdateProfileRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    if payload.username:
        supabase.table("app_users").update({"username": payload.username}).eq("id", session["user_id"]).execute()
    return {"ok": True}

@app.post("/api/auth/change-password")
def change_password(payload: ChangePasswordRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    res = supabase.table("app_users").select("*").eq("id", session["user_id"]).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    user = res.data[0]
    if not verify_password(payload.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Текущий пароль неверен")
    if len(payload.new_password) < 6:
        raise HTTPException(status_code=400, detail="Новый пароль должен быть не менее 6 символов")
    supabase.table("app_users").update({"password_hash": hash_password(payload.new_password)}).eq("id", user["id"]).execute()
    return {"ok": True}

# ── Admin: контакты пользователей ─────────────────────────

ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}


def require_admin(authorization):
    session = require_auth(authorization)
    if (session.get("email") or "").lower() not in ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="Только для админа")
    return session


class UserContactPayload(BaseModel):
    contact: str = ""


@app.get("/api/admin/users")
def api_admin_users(authorization: str | None = Header(default=None)):
    require_admin(authorization)
    res = supabase.table("app_users").select("id, email, username, contact").order("username").execute()
    return {"ok": True, "users": res.data or []}


@app.get("/api/my/tg-platforms")
def api_my_tg_platforms(authorization: str | None = Header(default=None)):
    """Для боковой панели: какой TG на каких платформах стоит."""
    session = require_auth(authorization)
    emails = get_team_owner_emails(session["email"])

    accs = (supabase.table("accounts")
            .select("id, platform, is_blocked")
            .in_("owner_email", emails).execute().data or [])
    if not accs:
        return {"ok": True, "map": {}}

    ids = [str(a["id"]) for a in accs]
    contacts = {}
    for i in range(0, len(ids), 200):
        for r in (supabase.table("ai_settings").select("account_id, contacts")
                  .in_("account_id", ids[i:i + 200]).execute().data or []):
            contacts[str(r["account_id"])] = r.get("contacts") or ""

    out = {}
    for a in accs:
        plat = a.get("platform") or "?"
        blocked = bool(a.get("is_blocked"))
        for tg in _contact_tgs(contacts.get(str(a["id"]), "")):
            slot = out.setdefault(tg, {})
            p = slot.setdefault(plat, {"alive": 0, "blocked": 0})
            p["blocked" if blocked else "alive"] += 1
    return {"ok": True, "map": out}


@app.get("/api/admin/cabinet")
def api_admin_cabinet(authorization: str | None = Header(default=None)):
    session = require_admin(authorization)
    users = (supabase.table("app_users")
             .select("id, email, username, contact, created_at")
             .order("created_at", desc=True).execute().data or [])

    accs = supabase.table("accounts").select("owner_email").execute().data or []
    by_owner = {}
    for a in accs:
        e = (a.get("owner_email") or "").lower()
        by_owner[e] = by_owner.get(e, 0) + 1

    sess = supabase.table("app_sessions").select("email").execute().data or []
    online = {(s.get("email") or "").lower() for s in sess}

    for u in users:
        e = (u.get("email") or "").lower()
        u["accounts"] = by_owner.get(e, 0)
        u["has_session"] = e in online
        u["is_admin"] = e in ADMIN_EMAILS
    return {"ok": True, "users": users, "me": session["email"]}


@app.delete("/api/admin/users/{user_id}")
def api_admin_user_delete(user_id: str, purge: int = 0,
                          authorization: str | None = Header(default=None)):
    session = require_admin(authorization)
    res = (supabase.table("app_users").select("email")
           .eq("id", user_id).limit(1).execute())
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    email = (row.get("email") or "").lower()
    if email == (session["email"] or "").lower():
        raise HTTPException(status_code=400, detail="Себя удалить нельзя")
    if email in ADMIN_EMAILS:
        raise HTTPException(status_code=400, detail="Админа удалить нельзя")

    killed = {}

    def _wipe(table: str, column: str, value):
        try:
            r = supabase.table(table).delete().eq(column, value).execute()
            killed[table] = len(r.data or [])
        except Exception as e:
            print(f"[CABINET] {table}: {e}", flush=True)

    # Сессии, членство в команде, приглашения
    _wipe("app_sessions", "email", email)
    _wipe("team_members", "member_email", email)
    _wipe("team_members", "owner_email", email)

    # Его ресурсы в разделе «Ресурсы»
    _wipe("mail_accounts", "owner_email", email)
    _wipe("asset_profiles", "owner_email", email)
    _wipe("groq_pool", "owner_email", email)
    _wipe("work_base", "author_email", email)

    if purge:
        # Полная зачистка: его анкеты со всем, что к ним привязано
        acc_ids = [a["id"] for a in (supabase.table("accounts").select("id")
                   .eq("owner_email", row.get("email")).execute().data or [])]
        for i in range(0, len(acc_ids), 100):
            chunk = acc_ids[i:i + 100]
            for t in ("job_queue", "split_logs", "tasks_log",
                      "run_schedules", "ai_settings"):
                col = "account_id"
                try:
                    supabase.table(t).delete().in_(col, chunk).execute()
                except Exception as e:
                    print(f"[CABINET] {t}: {e}", flush=True)
            try:
                supabase.table("accounts_private").delete().in_("id", chunk).execute()
            except Exception as e:
                print(f"[CABINET] accounts_private: {e}", flush=True)
        _wipe("accounts", "owner_email", row.get("email"))

    supabase.table("app_users").delete().eq("id", user_id).execute()
    print(f"[CABINET] Удалён пользователь {email}, purge={purge}, {killed}", flush=True)
    return {"ok": True, "email": email, "purged": bool(purge)}


@app.post("/api/admin/users/{user_id}/contact")
def api_admin_set_contact(user_id: str, payload: UserContactPayload, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    supabase.table("app_users").update({"contact": payload.contact.strip()}).eq("id", user_id).execute()
    return {"ok": True}

# ── Команда: контакты и назначения ────────────────────────

TG_NAME_RE = re.compile(r"^[A-Za-z0-9_]{3,32}$")


def _clean_tg(raw: str) -> str:
    name = re.sub(r"^(https?://)?(t\.me|telegram\.me)/", "", (raw or "").strip(), flags=re.I)
    return name.lstrip("@").strip()


class TeamContactPayload(BaseModel):
    tg_username: str
    note: str = ""


class AssignmentPayload(BaseModel):
    user_email: str
    work_date: str
    contacts: list[str]
    note: str = ""
    shift_type: str = ""
    shift_start: str = ""
    shift_end: str = ""


@app.get("/api/admin/team-contacts")
def api_team_contacts(authorization: str | None = Header(default=None)):
    require_admin(authorization)
    res = supabase.table("team_contacts").select("*").order("created_at", desc=True).execute()
    return {"ok": True, "contacts": res.data or []}


@app.post("/api/admin/team-contacts")
def api_add_team_contact(payload: TeamContactPayload, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    name = _clean_tg(payload.tg_username)
    if not TG_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail=f"Некорректный Telegram-юзер: {payload.tg_username}")
    supabase.table("team_contacts").upsert(
        {"tg_username": name, "note": payload.note.strip()}, on_conflict="tg_username"
    ).execute()
    return {"ok": True}


@app.delete("/api/admin/team-contacts/{contact_id}")
def api_delete_team_contact(contact_id: str, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    supabase.table("team_contacts").delete().eq("id", contact_id).execute()
    return {"ok": True}


@app.get("/api/admin/assignments")
def api_assignments(authorization: str | None = Header(default=None)):
    require_admin(authorization)
    res = (supabase.table("contact_assignments").select("*")
           .order("work_date", desc=True).order("created_at", desc=True).limit(200).execute())
    return {"ok": True, "assignments": res.data or []}


@app.post("/api/admin/assignments")
def api_create_assignment(payload: AssignmentPayload, authorization: str | None = Header(default=None)):
    session = require_admin(authorization)
    email = payload.user_email.strip().lower()
    contacts = [n for n in (_clean_tg(c) for c in payload.contacts) if TG_NAME_RE.match(n)]
    if not email or not contacts:
        raise HTTPException(status_code=400, detail="Нужны пользователь и хотя бы один контакт")
    try:
        day = datetime.strptime(payload.work_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Дата должна быть в формате ГГГГ-ММ-ДД")

    _hhmm = re.compile(r"^\d{2}:\d{2}$")
    s_start = payload.shift_start if _hhmm.match(payload.shift_start or "") else None
    s_end = payload.shift_end if _hhmm.match(payload.shift_end or "") else None
    s_type = payload.shift_type if payload.shift_type in ("day", "night") and s_start and s_end else None
    shift_txt = f"{'Дневная' if s_type == 'day' else 'Ночная'} {s_start}–{s_end}. " if s_type else ""

    row = supabase.table("contact_assignments").insert({
        "user_email": email,
        "work_date": payload.work_date,
        "contacts": contacts,
        "note": payload.note.strip(),
        "status": "new",
        "created_by": session["email"],
        "shift_type": s_type,
        "shift_start": s_start if s_type else None,
        "shift_end": s_end if s_type else None,
    }).execute().data[0]

    preview = ", ".join("@" + n for n in contacts[:5]) + ("…" if len(contacts) > 5 else "")
    supabase.table("notifications").insert({
        "email": email,
        "type": "contact_assignment",
        "title": f"📋 Назначение на {day.strftime('%d.%m.%Y')}",
        "message": f"{shift_txt}Контактов: {len(contacts)} — {preview}",
        "data": {"assignment_id": row["id"]},
        "is_read": False,
    }).execute()
    return {"ok": True, "assignment": row}


@app.delete("/api/admin/assignments/{assignment_id}")
def api_delete_assignment(assignment_id: str, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    supabase.table("contact_assignments").delete().eq("id", assignment_id).execute()
    return {"ok": True}


@app.get("/api/my/assignments")
def api_my_assignments(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    email = (session["email"] or "").lower()
    res = (supabase.table("contact_assignments").select("*")
           .eq("user_email", email).order("work_date", desc=True).limit(100).execute())
    supabase.table("notifications").update({"is_read": True}).eq("email", session["email"]) \
        .eq("type", "contact_assignment").eq("is_read", False).execute()
    return {"ok": True, "assignments": res.data or []}


@app.post("/api/my/assignments/{assignment_id}/done")
def api_my_assignment_done(assignment_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    email = (session["email"] or "").lower()
    supabase.table("contact_assignments").update({"status": "done"}) \
        .eq("id", assignment_id).eq("user_email", email).execute()
    return {"ok": True}


@app.get("/api/my/assignments/count")
def api_my_assignments_count(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    email = (session["email"] or "").lower()
    res = (supabase.table("contact_assignments").select("id", count="exact")
           .eq("user_email", email).neq("status", "done").execute())
    return {"ok": True, "count": res.count or 0}

# ── График смен ───────────────────────────────────────────

SHIFT_TYPES = {"day", "night", "off", "training"}
MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь",
             "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]


def _month_range(month: str):
    try:
        y, m = map(int, month.split("-"))
        start = datetime(y, m, 1).date()
    except Exception:
        raise HTTPException(status_code=400, detail="month должен быть в формате ГГГГ-ММ")
    end = datetime(y + 1, 1, 1).date() if m == 12 else datetime(y, m + 1, 1).date()
    return start.isoformat(), end.isoformat()


class ShiftChange(BaseModel):
    user_email: str
    day: str
    shift: str = ""


class ShiftBatch(BaseModel):
    changes: list[ShiftChange]


class ShiftNotify(BaseModel):
    month: str


@app.get("/api/admin/shifts")
def api_admin_shifts(month: str, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    start, end = _month_range(month)
    users = supabase.table("app_users").select("email, username, schedule_hidden").order("username").execute().data or []
    shifts = (supabase.table("work_shifts").select("user_email, day, shift, attendance")
              .gte("day", start).lt("day", end).execute().data or [])
    return {"ok": True, "users": users, "shifts": shifts}


@app.post("/api/admin/shifts")
def api_admin_shifts_save(payload: ShiftBatch, authorization: str | None = Header(default=None)):
    session = require_admin(authorization)
    now = datetime.now(timezone.utc).isoformat()
    up, rm = [], []
    for c in payload.changes[:3000]:
        email = c.user_email.strip().lower()
        try:
            datetime.strptime(c.day, "%Y-%m-%d")
        except ValueError:
            continue
        if c.shift in SHIFT_TYPES:
            up.append({"user_email": email, "day": c.day, "shift": c.shift,
                       "updated_by": session["email"], "updated_at": now})
        else:
            rm.append((email, c.day))
    if up:
        supabase.table("work_shifts").upsert(up, on_conflict="user_email,day").execute()
    for email, day in rm:
        supabase.table("work_shifts").delete().eq("user_email", email).eq("day", day).execute()
    return {"ok": True, "saved": len(up), "removed": len(rm)}


class AttendanceChange(BaseModel):
    user_email: str
    day: str
    attendance: str = ""


class AttendanceBatch(BaseModel):
    changes: list[AttendanceChange]


@app.post("/api/admin/shifts/attendance")
def api_admin_attendance(payload: AttendanceBatch, authorization: str | None = Header(default=None)):
    session = require_admin(authorization)
    now = datetime.now(timezone.utc).isoformat()
    n = 0
    for c in payload.changes[:3000]:
        val = c.attendance if c.attendance in ("present", "absent") else None
        supabase.table("work_shifts").update({
            "attendance": val, "updated_by": session["email"], "updated_at": now,
        }).eq("user_email", c.user_email.strip().lower()).eq("day", c.day).execute()
        n += 1
    return {"ok": True, "updated": n}


class ScheduleHidePayload(BaseModel):
    user_email: str
    hidden: bool = True


@app.post("/api/admin/shifts/hide")
def api_admin_shifts_hide(payload: ScheduleHidePayload, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    supabase.table("app_users").update({"schedule_hidden": payload.hidden}) \
        .eq("email", payload.user_email.strip().lower()).execute()
    return {"ok": True}


@app.post("/api/admin/shifts/notify")
def api_admin_shifts_notify(payload: ShiftNotify, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    start, end = _month_range(payload.month)
    rows = (supabase.table("work_shifts").select("user_email")
            .gte("day", start).lt("day", end).execute().data or [])
    emails = sorted({r["user_email"] for r in rows})
    y, m = payload.month.split("-")
    label = f"{MONTHS_RU[int(m) - 1]} {y}"
    if emails:
        supabase.table("notifications").insert([{
            "email": e,
            "type": "shift_schedule",
            "title": f"График смен на {label}",
            "message": "Твой график обновлён — открой раздел «График».",
            "data": {"month": payload.month},
            "is_read": False,
        } for e in emails]).execute()
    return {"ok": True, "notified": len(emails)}


@app.get("/api/my/shifts")
def api_my_shifts(month: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    start, end = _month_range(month)
    email = (session["email"] or "").lower()
    rows = (supabase.table("work_shifts").select("day, shift, attendance").eq("user_email", email)
            .gte("day", start).lt("day", end).order("day").execute().data or [])
    supabase.table("notifications").update({"is_read": True}).eq("email", session["email"]) \
        .eq("type", "shift_schedule").eq("is_read", False).execute()
    return {"ok": True, "shifts": rows}

# ── Отчёт: лиды с TG из базы бота ─────────────────────────

KYIV_TZ = ZoneInfo("Europe/Kyiv")
SHIFT_WINDOWS = {"day": (9, 21), "night": (21, 9), "training": (9, 19)}
BOT_SB_URL = os.getenv("BOT_SUPABASE_URL", "")
BOT_SB_KEY = os.getenv("BOT_SUPABASE_KEY", "")
_bot_sb = None


def _bot_db():
    global _bot_sb
    if _bot_sb is None:
        if not (BOT_SB_URL and BOT_SB_KEY):
            raise RuntimeError("На сервере не заданы BOT_SUPABASE_URL / BOT_SUPABASE_KEY")
        from supabase import create_client as _bot_create
        _bot_sb = _bot_create(BOT_SB_URL, BOT_SB_KEY)
    return _bot_sb


def _ts(value) -> datetime:
    s = re.sub(r"\.\d+", "", str(value).replace("Z", "+00:00"))
    return datetime.fromisoformat(s)


def sync_tg_leads(days: int = 3) -> int:
    bot = _bot_db()
    accs = bot.table("telegram_accounts").select("session_name, username").execute().data or []
    uname = {a["session_name"]: (a.get("username") or "").lstrip("@").lower()
             for a in accs if a.get("session_name") and a.get("username")}
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows, start = [], 0
    while True:
        chunk = (bot.table("lead_registry").select("account_session_name, dialog_id, first_seen_at")
                 .gte("first_seen_at", since).order("first_seen_at")
                 .range(start, start + 999).execute().data or [])
        rows += chunk
        if len(chunk) < 1000:
            break
        start += 1000
    out = {}
    for r in rows:
        u = uname.get(r.get("account_session_name"))
        if u and r.get("first_seen_at"):
            key = (u, str(r["dialog_id"]))
            out[key] = {"tg_username": u, "dialog_id": key[1], "first_seen_at": r["first_seen_at"]}
    data = list(out.values())
    for i in range(0, len(data), 500):
        supabase.table("tg_leads").upsert(data[i:i + 500], on_conflict="tg_username,dialog_id").execute()
    supabase.table("tg_leads_sync").upsert({
        "id": 1, "last_run": datetime.now(timezone.utc).isoformat(), "last_error": None,
    }).execute()
    return len(data)


async def tg_leads_loop():
    days = 60
    while True:
        try:
            n = await asyncio.to_thread(sync_tg_leads, days)
            print(f"[TG-LEADS] синхронизировано {n} лидов за {days} дн.", flush=True)
            days = 3
        except Exception as e:
            print(f"[TG-LEADS] синхронизация упала: {e}", flush=True)
            try:
                supabase.table("tg_leads_sync").upsert({"id": 1, "last_error": str(e)[:300]}).execute()
            except Exception:
                pass
        await asyncio.sleep(600)


def _shift_window(day: str, shift: str):
    d = datetime.strptime(day[:10], "%Y-%m-%d")
    sh, eh = SHIFT_WINDOWS.get(shift or "", (9, 9))
    start = datetime(d.year, d.month, d.day, sh, tzinfo=KYIV_TZ)
    end = datetime(d.year, d.month, d.day, eh, tzinfo=KYIV_TZ)
    if end <= start:
        end += timedelta(days=1)
    return start, end


def _time_window(day: str, start_hm: str, end_hm: str):
    d = datetime.strptime(day[:10], "%Y-%m-%d")
    sh, sm = map(int, start_hm.split(":"))
    eh, em = map(int, end_hm.split(":"))
    start = datetime(d.year, d.month, d.day, sh, sm, tzinfo=KYIV_TZ)
    end = datetime(d.year, d.month, d.day, eh, em, tzinfo=KYIV_TZ)
    if end <= start:
        end += timedelta(days=1)
    return start, end


@app.get("/api/report/tg-leads")
def api_report_tg_leads(month: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = (session["email"] or "").lower()
    is_admin = me in ADMIN_EMAILS
    start, end = _month_range(month)

    q = (supabase.table("contact_assignments").select("id, user_email, work_date, contacts, note, shift_type, shift_start, shift_end")
         .gte("work_date", start).lt("work_date", end))
    if not is_admin:
        q = q.eq("user_email", me)
    assigns = q.order("work_date").execute().data or []

    sync = (supabase.table("tg_leads_sync").select("last_run, last_error").eq("id", 1).execute().data or [{}])[0]
    base = {"ok": True, "is_admin": is_admin, "last_sync": sync.get("last_run"), "sync_error": sync.get("last_error")}
    if not assigns:
        return {**base, "rows": []}

    emails = sorted({a["user_email"] for a in assigns})
    names = _plan_names(emails)
    # Кто ещё числится в команде — удалённые не должны светиться в отчёте
    try:
        alive = {r["email"] for r in (supabase.table("app_users").select("email")
                 .in_("email", emails).execute().data or [])}
    except Exception as e:
        print(f"[REPORT] app_users не прочитались: {e}", flush=True)
        alive = set(emails)
    shift_rows = (supabase.table("work_shifts").select("user_email, day, shift")
                  .in_("user_email", emails).gte("day", start).lt("day", end).execute().data or [])
    shift_map = {(s["user_email"], str(s["day"])[:10]): s["shift"] for s in shift_rows}

    # Реестр TG: какой ПК, и какой ник заменён на какой
    reg = (supabase.table("tg_registry").select("tg_username, pc_name, label, replaced_by")
           .execute().data or [])
    alias, pcs, labels = {}, {}, {}
    for r in reg:
        u = (r.get("tg_username") or "").strip().lstrip("@").lower()
        if not u:
            continue
        nxt = (r.get("replaced_by") or "").strip().lstrip("@").lower()
        if nxt and nxt != u:
            alias[u] = nxt
        if r.get("pc_name"):
            pcs[u] = r["pc_name"]
        if r.get("label"):
            labels[u] = r["label"].strip().lstrip("@")

    def _tg_final(u):
        seen = set()
        while u in alias and u not in seen:
            seen.add(u)
            u = alias[u]
        return u

    members = {}
    for u in set(alias) | set(pcs):
        members.setdefault(_tg_final(u), set()).add(u)

    _base = {str(c).lstrip("@").lower() for a in assigns for c in (a.get("contacts") or [])}
    _fin = {_tg_final(u) for u in _base}
    for u in set(alias) | set(pcs):
        if _tg_final(u) in _fin:
            _base.add(u)
    tgs = sorted(_base)
    lo = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=KYIV_TZ)
    hi = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=KYIV_TZ) + timedelta(days=1)
    times, off = {}, 0
    while tgs:
        chunk = (supabase.table("tg_leads").select("tg_username, first_seen_at")
                 .in_("tg_username", tgs)
                 .gte("first_seen_at", lo.isoformat()).lt("first_seen_at", hi.isoformat())
                 .range(off, off + 999).execute().data or [])
        for r in chunk:
            times.setdefault(r["tg_username"], []).append(_ts(r["first_seen_at"]))
        if len(chunk) < 1000:
            break
        off += 1000
    for v in times.values():
        v.sort()

    # Берём все правки за месяц, а не только по назначенным TG —
    # иначе вручную созданную клетку негде будет показать.
    out_all = (supabase.table("tg_outcomes")
               .select("tg_username, day, shift, visits, bookings, cancels, leads")
               .gte("day", start).lt("day", end).execute().data or [])
    outcomes = {}
    for o in out_all:
        outcomes[(o["tg_username"].lower(), str(o["day"])[:10], o.get("shift") or "")] = o

    accs = (supabase.table("accounts").select("id, owner_email, platform, created_at, is_blocked, blocked_at")
            .in_("owner_email", emails).execute().data or [])
    arch = (supabase.table("accounts_archive").select("owner_email, created_at, blocked_at, was_blocked")
            .in_("owner_email", emails).gte("created_at", start).lt("created_at", end).execute().data or [])
    acc_contacts = {}
    acc_ids = [str(x["id"]) for x in accs]
    for i in range(0, len(acc_ids), 200):
        for r in (supabase.table("ai_settings").select("account_id, contacts")
                  .in_("account_id", acc_ids[i:i + 200]).execute().data or []):
            acc_contacts[str(r["account_id"])] = r.get("contacts") or ""

    eff = {}

    def _eff(e):
        return eff.setdefault(e, {"alive": 0, "blocked": 0, "month": 0, "_life": [], "tg": {}})

    def _life(s, x):
        if x.get("blocked_at") and x.get("created_at"):
            try:
                h = (_ts(x["blocked_at"]) - _ts(x["created_at"])).total_seconds() / 3600
                if h >= 0:
                    s["_life"].append(h)
            except Exception:
                pass

    for x in accs:
        s = _eff((x.get("owner_email") or "").lower())
        blocked = bool(x.get("is_blocked"))
        s["blocked" if blocked else "alive"] += 1
        if start <= str(x.get("created_at") or "")[:10] < end:
            s["month"] += 1
        if blocked:
            _life(s, x)
        plat = x.get("platform") or "?"
        for tg in _contact_tgs(acc_contacts.get(str(x["id"]), "")):
            p = s["tg"].setdefault(tg, {}).setdefault(plat, {"alive": 0, "blocked": 0})
            p["blocked" if blocked else "alive"] += 1
    for x in arch:
        s = _eff((x.get("owner_email") or "").lower())
        s["month"] += 1
        if x.get("was_blocked"):
            _life(s, x)

    eff_summary = {}
    for e, s in eff.items():
        life = s["_life"]
        eff_summary[e] = {
            "alive": s["alive"], "blocked": s["blocked"], "month": s["month"],
            "avg_life_hours": round(sum(life) / len(life), 1) if life else None,
        }

    used = set()
    rows = []
    for a in assigns:
        day = str(a["work_date"])[:10]
        if a.get("shift_start") and a.get("shift_end"):
            shift = a.get("shift_type") or ""
            ws, we = _time_window(day, str(a["shift_start"])[:5], str(a["shift_end"])[:5])
        else:
            shift = shift_map.get((a["user_email"], day), "")
            ws, we = _shift_window(day, shift)
        per_map = {}
        for c in a.get("contacts") or []:
            raw = str(c).lstrip("@")
            src = raw.lower()
            tg_key = _tg_final(src)
            o = outcomes.get((tg_key, day, shift)) or outcomes.get((tg_key, day, ""))
            if not o:
                for _g in (members.get(tg_key) or set()) | {src}:
                    o = outcomes.get((_g, day, shift)) or outcomes.get((_g, day, ""))
                    if o:
                        used.add((_g, day, shift))
                        used.add((_g, day, ""))
                        break
            used.add((tg_key, day, shift))
            used.add((tg_key, day, ""))

            # Лиды считаем по всем никам, которые схлопнулись в этот
            group = (members.get(tg_key) or set()) | {src, tg_key}
            lst = sorted(t for g in group for t in times.get(g, []))
            _auto = bisect.bisect_left(lst, we) - bisect.bisect_left(lst, ws)

            p = per_map.get(tg_key)
            if p is None:
                _lead_m = bool(o) and o.get("leads") is not None
                p = per_map[tg_key] = {
                    "tg": labels.get(tg_key) or (raw if src == tg_key else tg_key),
                    "pc": pcs.get(tg_key, ""),
                    "leads": 0, "leads_auto": 0,
                    "leads_manual": _lead_m, "manual": bool(o),
                    "platforms": {}, "merged": [],
                    "visits": o["visits"] if o else None,
                    "bookings": o["bookings"] if o else None,
                    "cancels": o["cancels"] if o else None,
                    "_fixed": o["leads"] if _lead_m else None,
                }
            p["leads_auto"] = max(p["leads_auto"], _auto)
            if src != tg_key and raw not in p["merged"]:
                p["merged"].append(raw)
            p["platforms"].update(eff.get(a["user_email"], {}).get("tg", {}).get(src, {}))

        per = []
        for p in per_map.values():
            fixed = p.pop("_fixed")
            p["leads"] = fixed if fixed is not None else p["leads_auto"]
            per.append(p)
        rows.append({
            "id": a["id"], "user_email": a["user_email"],
            "user_name": names.get(a["user_email"], a["user_email"].split("@")[0]),
            "user_active": a["user_email"] in alive,
            "day": day, "shift": shift, "window": f"{ws:%H:%M}–{we:%H:%M}",
            "note": a.get("note") or "", "contacts": per, "total": sum(p["leads"] for p in per),
            "eff": eff_summary.get(a["user_email"]),
            "out": {k: sum(p[k] or 0 for p in per) for k in ("visits", "bookings", "cancels")},
            "has_out": any(p["visits"] is not None for p in per),
        })
    extras = []
    if is_admin:
        for o in out_all:
            k = (o["tg_username"].lower(), str(o["day"])[:10], o.get("shift") or "")
            if k in used:
                continue
            fin = _tg_final(k[0])
            if (fin, k[1], k[2]) in used or (fin, k[1], "") in used:
                continue
            extras.append({
                "tg": labels.get(fin) or fin, "pc": pcs.get(fin, ""),
                "day": k[1], "shift": k[2],
                "leads": o.get("leads") or 0, "leads_auto": 0,
                "leads_manual": o.get("leads") is not None, "manual": True,
                "visits": o.get("visits"), "bookings": o.get("bookings"), "cancels": o.get("cancels"),
            })
    return {**base, "rows": rows, "extras": extras}


@app.post("/api/report/tg-leads/sync")
async def api_report_tg_leads_sync(authorization: str | None = Header(default=None)):
    require_admin(authorization)
    try:
        n = await asyncio.to_thread(sync_tg_leads, 3)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)[:300])
    return {"ok": True, "synced": n}


class TgOutcomePayload(BaseModel):
    tg_username: str
    day: str
    shift: str = ""
    leads: int | None = None
    visits: int | None = None
    bookings: int | None = None
    cancels: int | None = None


class TgRegistryPayload(BaseModel):
    tg_username: str
    pc_name: str = ""
    label: str = ""
    replaced_by: str | None = None


class TgPoolNew(BaseModel):
    tg_username: str
    pc_name: str = ""
    note: str = ""


class TgPoolPatch(BaseModel):
    tg_username: str | None = None
    pc_name: str | None = None
    note: str | None = None
    active: bool | None = None
    priority: bool | None = None


class TgClaimPayload(BaseModel):
    date: str = ""
    shift: str = "day"
    owner_email: str = ""


POOL_SHIFTS = {"day": ("09:00", "21:00"), "night": ("21:00", "09:00")}


def _pool_shift(raw: str) -> str:
    s = (raw or "day").strip().lower()
    if s not in POOL_SHIFTS:
        raise HTTPException(status_code=400, detail="Смена должна быть day или night")
    return s


def _pool_dates() -> list[str]:
    """Брать анкеты можно на сегодня и на завтра."""
    today = datetime.now(KYIV_TZ).date()
    return [str(today), str(today + timedelta(days=1))]


def _pool_day(raw: str) -> str:
    day = (raw or "").strip()[:10] or _pool_dates()[0]
    if day not in _pool_dates():
        raise HTTPException(status_code=400, detail="Брать анкеты можно только на сегодня или завтра")
    return day


def _sync_assignment(email: str, day: str, shift: str = "day"):
    """Пересобирает назначение пользователя на дату и смену из его закреплений."""
    email = (email or "").lower()
    shift = _pool_shift(shift)
    ids = [c["slot_id"] for c in (supabase.table("tg_claims").select("slot_id")
           .eq("owner_email", email).eq("work_date", day).eq("shift", shift)
           .execute().data or [])]
    nicks = []
    for i in range(0, len(ids), 100):
        for s in (supabase.table("tg_pool").select("tg_username")
                  .in_("id", ids[i:i + 100]).execute().data or []):
            n = _clean_tg(s.get("tg_username") or "")
            if TG_NAME_RE.match(n) and n not in nicks:
                nicks.append(n)

    row = (supabase.table("contact_assignments").select("id")
           .eq("user_email", email).eq("work_date", day)
           .eq("source", "pool").eq("shift_type", shift)
           .limit(1).execute().data or [None])[0]
    if not nicks:
        if row:
            supabase.table("contact_assignments").delete().eq("id", row["id"]).execute()
        return
    s_start, s_end = POOL_SHIFTS[shift]
    if row:
        supabase.table("contact_assignments").update({"contacts": nicks}).eq("id", row["id"]).execute()
    else:
        supabase.table("contact_assignments").insert({
            "user_email": email, "work_date": day, "contacts": nicks,
            "note": "Взято из пула", "status": "new",
            "created_by": "pool", "source": "pool",
            "shift_type": shift, "shift_start": s_start, "shift_end": s_end,
        }).execute()


class MaintenancePayload(BaseModel):
    maintenance: bool = False
    message: str = ""


@app.get("/api/maintenance")
def api_maintenance_get(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    is_admin = (session["email"] or "").lower() in ADMIN_EMAILS
    try:
        row = (supabase.table("site_settings").select("*").eq("id", 1)
               .limit(1).execute().data or [{}])[0]
    except Exception as e:
        print(f"[MAINT] не прочиталось: {e}", flush=True)
        row = {}
    return {"ok": True, "maintenance": bool(row.get("maintenance")),
            "message": row.get("message") or "", "is_admin": is_admin}


@app.post("/api/maintenance")
def api_maintenance_set(payload: MaintenancePayload, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    supabase.table("site_settings").upsert({
        "id": 1,
        "maintenance": bool(payload.maintenance),
        "message": (payload.message or "").strip(),
        "updated_at": datetime.utcnow().isoformat(),
    }, on_conflict="id").execute()
    print(f"[MAINT] режим техработ: {payload.maintenance}", flush=True)
    return {"ok": True}


@app.get("/api/tg-pool")
def api_tg_pool(date: str = "", shift: str = "day", authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = (session["email"] or "").lower()
    is_admin = me in ADMIN_EMAILS
    day = _pool_day(date)
    sh = _pool_shift(shift)

    rows = (supabase.table("tg_pool").select("*")
            .order("pc_name").order("tg_username").execute().data or [])
    claims = (supabase.table("tg_claims").select("slot_id, owner_email")
              .eq("work_date", day).eq("shift", sh).execute().data or [])
    by_slot = {c["slot_id"]: c["owner_email"] for c in claims}
    emails = sorted(set(by_slot.values()))
    names = _plan_names(emails) if emails else {}

    items = []
    for r in rows:
        own = by_slot.get(r["id"])
        items.append({**r, "owner_email": own,
                      "owner_name": names.get(own, (own or "").split("@")[0]) if own else ""})
    return {"ok": True, "items": items, "date": day, "dates": _pool_dates(),
            "shift": sh, "me": me, "is_admin": is_admin,
            "mine": sum(1 for i in items if i["owner_email"] == me)}


@app.post("/api/tg-pool")
def api_tg_pool_add(payload: TgPoolNew, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    tg = (payload.tg_username or "").strip().lstrip("@")
    if not tg:
        raise HTTPException(status_code=400, detail="Ник обязателен")
    res = supabase.table("tg_pool").insert({
        "tg_username": tg,
        "pc_name": (payload.pc_name or "").strip(),
        "note": (payload.note or "").strip(),
    }).execute()
    return {"ok": True, "item": (res.data or [{}])[0]}


@app.patch("/api/tg-pool/{slot_id}")
def api_tg_pool_patch(slot_id: str, payload: TgPoolPatch, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    cur = (supabase.table("tg_pool").select("*").eq("id", slot_id)
           .limit(1).execute().data or [None])[0]
    if not cur:
        raise HTTPException(status_code=404, detail="Анкета не найдена")

    upd = {"updated_at": datetime.utcnow().isoformat()}
    if payload.pc_name is not None:
        upd["pc_name"] = payload.pc_name.strip()
    if payload.note is not None:
        upd["note"] = payload.note.strip()
    if payload.active is not None:
        upd["active"] = bool(payload.active)
    if payload.priority is not None:
        upd["priority"] = bool(payload.priority)
    renamed = None
    if payload.tg_username is not None:
        new_tg = payload.tg_username.strip().lstrip("@")
        if not new_tg:
            raise HTTPException(status_code=400, detail="Ник не может быть пустым")
        old_tg = (cur.get("tg_username") or "").strip().lstrip("@")
        upd["tg_username"] = new_tg
        # Ник сменился — пусть отчёт склеит старый с новым
        if old_tg and old_tg.lower() != new_tg.lower():
            renamed = (old_tg, new_tg)
            try:
                supabase.table("tg_registry").upsert({
                    "tg_username": old_tg.lower(), "label": old_tg,
                    "pc_name": upd.get("pc_name", cur.get("pc_name") or ""),
                    "replaced_by": new_tg.lower(),
                    "updated_at": datetime.utcnow().isoformat(),
                }, on_conflict="tg_username").execute()
                supabase.table("tg_registry").upsert({
                    "tg_username": new_tg.lower(), "label": new_tg,
                    "pc_name": upd.get("pc_name", cur.get("pc_name") or ""),
                    "updated_at": datetime.utcnow().isoformat(),
                }, on_conflict="tg_username").execute()
            except Exception as e:
                print(f"[TG-POOL] реестр не обновился: {e}", flush=True)

    supabase.table("tg_pool").update(upd).eq("id", slot_id).execute()

    # Ник сменился — обновляем уже выданные назначения на сегодня и завтра
    if renamed:
        for d in _pool_dates():
            for c in (supabase.table("tg_claims").select("owner_email, shift")
                      .eq("slot_id", slot_id).eq("work_date", d).execute().data or []):
                _sync_assignment(c["owner_email"], d, c.get("shift") or "day")
    return {"ok": True, "renamed": bool(renamed)}


@app.delete("/api/tg-pool/{slot_id}")
def api_tg_pool_delete(slot_id: str, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    touched = [(c["owner_email"], str(c["work_date"])[:10], c.get("shift") or "day")
               for c in (supabase.table("tg_claims").select("owner_email, work_date, shift")
                         .eq("slot_id", slot_id).execute().data or [])]
    supabase.table("tg_pool").delete().eq("id", slot_id).execute()
    for em, d, s in touched:
        _sync_assignment(em, d, s)
    return {"ok": True}


@app.post("/api/tg-pool/{slot_id}/take")
def api_tg_pool_take(slot_id: str, payload: TgClaimPayload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = (session["email"] or "").lower()
    is_admin = me in ADMIN_EMAILS
    day = _pool_day(payload.date)
    sh = _pool_shift(payload.shift)
    who = ((payload.owner_email or "").strip().lower() if is_admin else "") or me

    slot = (supabase.table("tg_pool").select("active").eq("id", slot_id)
            .limit(1).execute().data or [None])[0]
    if not slot:
        raise HTTPException(status_code=404, detail="Анкета не найдена")
    if not slot.get("active"):
        raise HTTPException(status_code=400, detail="Анкета выведена из работы")

    try:
        supabase.table("tg_claims").insert({
            "slot_id": slot_id, "work_date": day, "shift": sh, "owner_email": who,
        }).execute()
    except Exception:
        cur = (supabase.table("tg_claims").select("owner_email")
               .eq("slot_id", slot_id).eq("work_date", day).eq("shift", sh)
               .limit(1).execute().data or [None])[0]
        if not cur:
            raise HTTPException(status_code=500, detail="Не удалось закрепить, попробуй ещё раз")
        if cur["owner_email"] != who:
            if not is_admin:
                raise HTTPException(status_code=409, detail="Эту телегу уже забрали")
            prev = cur["owner_email"]
            supabase.table("tg_claims").update({"owner_email": who}) \
                .eq("slot_id", slot_id).eq("work_date", day).eq("shift", sh).execute()
            _sync_assignment(prev, day, sh)

    _sync_assignment(who, day, sh)
    return {"ok": True}


@app.post("/api/tg-pool/{slot_id}/release")
def api_tg_pool_release(slot_id: str, payload: TgClaimPayload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = (session["email"] or "").lower()
    is_admin = me in ADMIN_EMAILS
    day = _pool_day(payload.date)
    sh = _pool_shift(payload.shift)

    cur = (supabase.table("tg_claims").select("owner_email")
           .eq("slot_id", slot_id).eq("work_date", day).eq("shift", sh)
           .limit(1).execute().data or [None])[0]
    if not cur:
        return {"ok": True}
    if cur["owner_email"] != me and not is_admin:
        raise HTTPException(status_code=403, detail="Это не твоя телега")

    supabase.table("tg_claims").delete() \
        .eq("slot_id", slot_id).eq("work_date", day).eq("shift", sh).execute()
    _sync_assignment(cur["owner_email"], day, sh)
    return {"ok": True}


@app.get("/api/report/tg-registry")
def api_tg_registry_get(authorization: str | None = Header(default=None)):
    require_auth(authorization)
    res = supabase.table("tg_registry").select("*").order("tg_username").execute()
    return {"ok": True, "items": res.data or []}


@app.post("/api/report/tg-registry")
def api_tg_registry_set(payload: TgRegistryPayload, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    u = (payload.tg_username or "").strip().lstrip("@").lower()
    if not u:
        raise HTTPException(status_code=400, detail="tg_username обязателен")
    nxt = (payload.replaced_by or "").strip().lstrip("@").lower() or None
    if nxt == u:
        raise HTTPException(status_code=400, detail="Нельзя заменить ник сам на себя")
    chain = {}
    for r in (supabase.table("tg_registry").select("tg_username, replaced_by").execute().data or []):
        if r.get("replaced_by"):
            chain[(r.get("tg_username") or "").lower()] = (r["replaced_by"] or "").lower()
    chain[u] = nxt or ""
    seen, cur = set(), u
    while cur:
        if cur in seen:
            raise HTTPException(status_code=400, detail="Замены зациклились")
        seen.add(cur)
        cur = chain.get(cur)
    (supabase.table("tg_registry").upsert({
        "tg_username": u,
        "pc_name": (payload.pc_name or "").strip(),
        "label": (payload.label or "").strip().lstrip("@"),
        "replaced_by": nxt,
        "updated_at": datetime.utcnow().isoformat(),
    }, on_conflict="tg_username").execute())
    return {"ok": True}


@app.post("/api/report/tg-outcomes")
def api_report_tg_outcome_set(payload: TgOutcomePayload, authorization: str | None = Header(default=None)):
    """Ручная правка ноды месячного отчёта. Все поля пустые — строка удаляется."""
    require_admin(authorization)
    tg = (payload.tg_username or "").lstrip("@").lower()
    day = (payload.day or "")[:10]
    if not tg or not day:
        raise HTTPException(status_code=400, detail="tg_username и day обязательны")
    shift = payload.shift or ""
    vals = {"leads": payload.leads, "visits": payload.visits,
            "bookings": payload.bookings, "cancels": payload.cancels}
    if all(v is None for v in vals.values()):
        (supabase.table("tg_outcomes").delete()
         .eq("tg_username", tg).eq("day", day).eq("shift", shift).execute())
        return {"ok": True, "deleted": True}
    try:
        (supabase.table("tg_outcomes")
         .upsert({"tg_username": tg, "day": day, "shift": shift, **vals},
                 on_conflict="tg_username,day,shift").execute())
    except Exception as e:
        print(f"[TG-OUTCOMES] upsert упал: {e}", flush=True)
        raise HTTPException(status_code=400, detail=str(e)[:300])
    return {"ok": True}


# ── Эффективность команды ─────────────────────────────────

_TG_RE = re.compile(r"(?:@|t\.me/)([A-Za-z0-9_]{3,32})", re.I)


def _contact_tgs(text) -> set:
    """TG-ники из поля «Контакты»: @ник, t.me/ник или просто ник без @."""
    text = (text or "").strip()
    found = {m.lower() for m in _TG_RE.findall(text)}
    if not found and TG_NAME_RE.match(text.lstrip("@")):
        found = {text.lstrip("@").lower()}
    return found


@app.get("/api/admin/team-stats")
def api_admin_team_stats(month: str, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    start, end = _month_range(month)

    live = (supabase.table("accounts")
            .select("id, owner_email, platform, created_at, is_blocked, blocked_at")
            .gte("created_at", start).lt("created_at", end).execute().data or [])
    arch = (supabase.table("accounts_archive")
            .select("owner_email, platform, created_at, blocked_at, was_blocked, contacts")
            .gte("created_at", start).lt("created_at", end).execute().data or [])

    contacts = {}
    ids = [str(a["id"]) for a in live]
    for i in range(0, len(ids), 200):
        rows = (supabase.table("ai_settings").select("account_id, contacts")
                .in_("account_id", ids[i:i + 200]).execute().data or [])
        for r in rows:
            contacts[str(r["account_id"])] = r.get("contacts") or ""

    items = [{
        "owner": (a.get("owner_email") or "").lower(), "platform": a.get("platform") or "?",
        "created_at": a.get("created_at"), "blocked": bool(a.get("is_blocked")),
        "blocked_at": a.get("blocked_at"), "alive": not a.get("is_blocked"), "deleted": False,
        "contacts": contacts.get(str(a["id"]), ""),
    } for a in live] + [{
        "owner": (a.get("owner_email") or "").lower(), "platform": a.get("platform") or "?",
        "created_at": a.get("created_at"), "blocked": bool(a.get("was_blocked")),
        "blocked_at": a.get("blocked_at"), "alive": False, "deleted": True,
        "contacts": a.get("contacts") or "",
    } for a in arch]

    emails = sorted({it["owner"] for it in items if it["owner"]})
    names = _plan_names(emails) if emails else {}
    stats = {}
    for it in items:
        e = it["owner"] or "—"
        s = stats.setdefault(e, {"email": e, "name": names.get(e, e.split("@")[0]), "total": 0,
                                 "platforms": {}, "alive": 0, "blocked": 0, "deleted": 0,
                                 "_life": [], "tgs": {}})
        s["total"] += 1
        s["platforms"][it["platform"]] = s["platforms"].get(it["platform"], 0) + 1
        s["alive"] += 1 if it["alive"] else 0
        s["blocked"] += 1 if it["blocked"] else 0
        s["deleted"] += 1 if it["deleted"] else 0
        if it["blocked"] and it["blocked_at"] and it["created_at"]:
            try:
                h = (_ts(it["blocked_at"]) - _ts(it["created_at"])).total_seconds() / 3600
                if h >= 0:
                    s["_life"].append(h)
            except Exception:
                pass
        for tg in _contact_tgs(it["contacts"]):
            s["tgs"][tg] = s["tgs"].get(tg, 0) + 1

    people = []
    for s in stats.values():
        life = s.pop("_life")
        s["avg_life_hours"] = round(sum(life) / len(life), 1) if life else None
        s["life_samples"] = len(life)
        people.append(s)
    people.sort(key=lambda s: -s["total"])
    return {"ok": True, "people": people}

# ── Accounts ──────────────────────────────────────────────

@app.get("/api/accounts")
def get_accounts(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    # Фронт читает только эти поля (проверено по всему app.js).
    # Раньше select("*") тянул ещё reserve_chain, owner_email, title,
    # images_found, run_started_at — их никто не использует.
    _acc_cols = ("id, name, platform, photo_url, profile_url, final_url, "
                 "checked_at, cookies_count, is_blocked, block_reason, "
                 "session_valid, session_reason, cookies_valid, "
                 "run_status, run_task, run_note, run_started_by, "
                 "role, parser_account_id, created_at")
    res = supabase.table("accounts").select(_acc_cols).in_("owner_email", owner_emails).order("created_at", desc=True).execute()
    return {"ok": True, "accounts": res.data or []}

@app.patch("/api/accounts/{account_id}")
def api_update_account(account_id: str, payload: AccountUpdateRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    account_res = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).execute()
    if not account_res.data:
        raise HTTPException(status_code=403, detail="Нет доступа")
    update_data = {}
    if payload.name is not None:
        update_data["name"] = payload.name
    if update_data:
        supabase.table("accounts").update(update_data).eq("id", account_id).execute()
    return {"ok": True}

@app.delete("/api/accounts/{account_id}")
def delete_account(account_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    account_res = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).execute()
    if not account_res.data:
        raise HTTPException(status_code=403, detail="Нет доступа")

    # Чистим всё что было привязано к анкете, иначе слот ключей остаётся
    # висеть занятым на удалённой анкете (раньше это делал только фронт,
    # и то лишь если панель ключей была открыта в этой вкладке).
    try:
        supabase.table("key_slots").update({"account_id": None}).eq("account_id", account_id).execute()
    except Exception as e:
        print(f"[DELETE] Не смог освободить слот ключей: {e}", flush=True)
    try:
        supabase.table("run_schedules").delete().eq("account_id", account_id).execute()
    except Exception as e:
        print(f"[DELETE] Не смог удалить расписание: {e}", flush=True)
    try:
        supabase.table("job_queue").update({"status": "cancelled"}).eq("account_id", account_id).in_("status", ["pending", "running"]).execute()
    except Exception as e:
        print(f"[DELETE] Не смог отменить задачи: {e}", flush=True)

    supabase.table("accounts").delete().eq("id", account_id).execute()
    return {"ok": True}

@app.get("/api/accounts/reserved-ids")
def api_get_reserved_ids(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    res = supabase.table("accounts").select("id, reserve_chain").in_("owner_email", owner_emails).execute()
    reserved = set()
    for row in res.data or []:
        for rid in (row.get("reserve_chain") or []):
            reserved.add(rid)
    return {"ok": True, "reserved_ids": list(reserved)}

@app.post("/api/accounts/check-statuses")
async def api_check_account_statuses(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    accounts_res = await asyncio.to_thread(
        lambda: supabase.table("accounts")
        .select("id, is_blocked, platform")
        .in_("owner_email", owner_emails)
        .execute()
    )

    async def check_one(row):
        account_id = row["id"]
        platform = (row.get("platform") or "mamba").lower()
        if row.get("is_blocked"):
            return {"account_id": account_id, "status": "blocked", "skipped": True}
        # У платформы нет менеджер-сервиса — раньше её проверку отправляли
        # на воркер мамбы и получали мусорный ответ.
        if platform not in PLATFORM_URLS:
            return {"account_id": account_id, "status": "ok", "skipped": True}
        async with CHECK_SEMAPHORE:
            try:
                base_url = PLATFORM_URLS[platform]
                resp = await HTTP_CLIENT.get(f"{base_url}/api/check-status/{account_id}")
                return resp.json()
            except Exception as e:
                return {"account_id": account_id, "status": "unknown", "reason": str(e)}

    results = await asyncio.gather(*(check_one(row) for row in (accounts_res.data or [])))
    return {"ok": True, "results": results}

@app.post("/api/accounts/{account_id}/run-status")
def api_set_account_run_status(account_id: str, payload: AccountRunStatusPayload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    account_res = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).execute()
    if not account_res.data:
        raise HTTPException(status_code=403, detail="Нет доступа")
    status = payload.run_status or "idle"
    update_data = {"run_status": status, "run_task": payload.run_task or "", "run_note": payload.run_note or ""}
    if payload.is_blocked is True:
        update_data["is_blocked"] = True
    if status == "running":
        update_data["run_started_by"] = session["email"]
        update_data["run_started_at"] = datetime.now().isoformat()
    else:
        update_data["run_started_by"] = ""
        update_data["run_started_at"] = None
        update_data["run_note"] = ""
    supabase.table("accounts").update(update_data).eq("id", account_id).execute()
    return {"ok": True, "account_id": account_id, **update_data}

@app.get("/api/schedules")
def api_get_schedules(authorization: str | None = Header(default=None)):
    """Все расписания команды — фронт рисует по ним карточки таймера."""
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    acc_res = supabase.table("accounts").select("id").in_("owner_email", owner_emails).execute()
    ids = [r["id"] for r in (acc_res.data or [])]
    if not ids:
        return {"ok": True, "schedules": []}
    res = supabase.table("run_schedules").select("*").in_("account_id", ids).execute()
    return {"ok": True, "schedules": res.data or []}


@app.post("/api/accounts/{account_id}/schedule")
def api_set_schedule(account_id: str, payload: RunSchedulePayload, authorization: str | None = Header(default=None)):
    """Включает серверный таймер для анкеты. Дальше воркер сам крутит работу/паузу,
    браузер для этого не нужен — можно закрыть."""
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    account_res = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).execute()
    if not account_res.data:
        raise HTTPException(status_code=403, detail="Нет доступа")

    now_iso = datetime.now(timezone.utc).isoformat()
    row = {
        "account_id": account_id,
        "owner_email": session["email"],
        "work_sec": max(10, int(payload.work_sec or 600)),
        "pause_sec": max(5, int(payload.pause_sec or 90)),
        "limit_likes": max(1, min(100, int(payload.limit_likes or 10))),
        "enabled": bool(payload.enabled),
        "do_likes": bool(payload.do_likes),
        "do_chats": bool(payload.do_chats),
        "phase": "work",
        "phase_started_at": now_iso,
        "updated_at": now_iso,
    }
    supabase.table("run_schedules").upsert(row, on_conflict="account_id").execute()

    if payload.enabled:
        # Сразу запускаем первый круг, не дожидаясь планировщика
        supabase.table("accounts").update({
            "run_status": "running",
            "run_task": "split",
            "run_note": "Работает по таймеру",
            "run_started_by": session["email"],
            "run_started_at": datetime.now().isoformat(),
        }).eq("id", account_id).execute()

        exists = (
            supabase.table("job_queue")
            .select("id")
            .eq("account_id", account_id)
            .in_("status", ["pending", "running"])
            .limit(1)
            .execute()
        )
        if not exists.data:
            # С какого круга стартовать — зависит от галочек на карточке
            _first = "likes-http" if row["do_likes"] else ("auto-reply-http" if row["do_chats"] else "")
            if _first:
                supabase.table("job_queue").insert({
                    "account_id": account_id,
                    "type": _first,
                    "payload": {"limit": row["limit_likes"]},
                    "status": "pending",
                }).execute()

    return {"ok": True, "schedule": row}


@app.patch("/api/accounts/{account_id}/run-opts")
def api_set_run_opts(account_id: str, payload: RunOptsPayload,
                     authorization: str | None = Header(default=None)):
    """Галочки и лимит лайков с карточки. Запуск не трогаем."""
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    acc = (supabase.table("accounts").select("id").eq("id", account_id)
           .in_("owner_email", owner_emails).execute())
    if not acc.data:
        raise HTTPException(status_code=403, detail="Нет доступа")

    upd = {}
    if payload.limit_likes is not None:
        upd["limit_likes"] = max(1, min(100, int(payload.limit_likes)))
    if payload.do_likes is not None:
        upd["do_likes"] = bool(payload.do_likes)
    if payload.do_chats is not None:
        upd["do_chats"] = bool(payload.do_chats)
    if not upd:
        return {"ok": True}

    cur = (supabase.table("run_schedules").select("account_id")
           .eq("account_id", account_id).limit(1).execute())
    if cur.data:
        supabase.table("run_schedules").update(upd).eq("account_id", account_id).execute()
    else:
        supabase.table("run_schedules").upsert({
            "account_id": account_id,
            "owner_email": session["email"],
            "enabled": False,
            "work_sec": 600, "pause_sec": 90, "limit_likes": 10,
            **upd,
        }, on_conflict="account_id").execute()
    return {"ok": True, "opts": upd}


@app.delete("/api/accounts/{account_id}/schedule")
def api_delete_schedule(account_id: str, authorization: str | None = Header(default=None)):
    """Выключает таймер и останавливает анкету."""
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    account_res = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).execute()
    if not account_res.data:
        raise HTTPException(status_code=403, detail="Нет доступа")

    supabase.table("run_schedules").delete().eq("account_id", account_id).execute()
    supabase.table("accounts").update({
        "run_status": "idle",
        "run_task": "",
        "run_note": "",
        "run_started_by": "",
        "run_started_at": None,
    }).eq("id", account_id).execute()
    supabase.table("job_queue").update({"status": "cancelled"}).eq("account_id", account_id).in_("status", ["pending", "running"]).execute()

    return {"ok": True}

@app.post("/api/accounts/{account_id}/chain")
def api_set_chain(account_id: str, payload: SetChainRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    main_res = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).limit(1).execute()
    if not main_res.data:
        raise HTTPException(status_code=404, detail="Анкета не найдена")
    clean_chain = [str(rid).strip() for rid in payload.chain if str(rid).strip() and str(rid).strip() != account_id]
    clean_chain = list(dict.fromkeys(clean_chain))
    supabase.table("accounts").update({"reserve_chain": clean_chain}).eq("id", account_id).execute()
    return {"ok": True, "chain": clean_chain}

@app.get("/api/accounts/{account_id}/chain")
def api_get_chain(account_id: str):
    res = supabase.table("accounts").select("reserve_chain").eq("id", account_id).execute()
    if not res.data:
        return {"ok": True, "chain": []}
    return {"ok": True, "chain": res.data[0].get("reserve_chain") or []}

# ── Atolin: привязка парс-анкеты к главной ───────────────

class SetParserRequest(BaseModel):
    parser_account_id: str | None = None

@app.post("/api/accounts/{account_id}/parser")
def api_set_parser(account_id: str, payload: SetParserRequest, authorization: str | None = Header(default=None)):
    """Нитка на канвасе: у главной анкеты появляется источник целей."""
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])

    main_res = supabase.table("accounts").select("id, role, platform").eq("id", account_id).in_("owner_email", owner_emails).limit(1).execute()
    if not main_res.data:
        raise HTTPException(status_code=403, detail="Нет доступа к этой анкете")
    main = main_res.data[0]

    parser_id = (payload.parser_account_id or "").strip() or None

    if parser_id:
        if parser_id == account_id:
            raise HTTPException(status_code=400, detail="Анкета не может быть источником для самой себя")
        p_res = supabase.table("accounts").select("id, role, platform").eq("id", parser_id).in_("owner_email", owner_emails).limit(1).execute()
        if not p_res.data:
            raise HTTPException(status_code=403, detail="Нет доступа к парс-анкете")
        parser = p_res.data[0]
        if (parser.get("platform") or "").lower() != "atolin" or (main.get("platform") or "").lower() != "atolin":
            raise HTTPException(status_code=400, detail="Обе анкеты должны быть Atolin")
        if (parser.get("role") or "main") != "parser":
            raise HTTPException(status_code=400, detail="Вторая анкета не в роли «Парс»")
        if (main.get("role") or "main") != "main":
            raise HTTPException(status_code=400, detail="Первая анкета должна быть в роли «Обработка»")

    supabase.table("accounts").update({"parser_account_id": parser_id}).eq("id", account_id).execute()
    return {"ok": True, "account_id": account_id, "parser_account_id": parser_id}

# ── Connect Account ───────────────────────────────────────

def _save_account_proxy(account_id: str, raw: str, scheme: str):
    """Привязывает прокси к анкете по её id — воркер берёт его из ai_settings."""
    parts = [p.strip() for p in (raw or "").split(":")]
    if not account_id or len(parts) < 2 or not parts[0]:
        return
    try:
        supabase.table("ai_settings").upsert({
            "account_id": account_id,
            "proxy_protocol": (scheme or "socks5").lower(),
            "proxy_host": parts[0],
            "proxy_port": parts[1],
            "proxy_login": parts[2] if len(parts) > 2 else "",
            "proxy_password": ":".join(parts[3:]) if len(parts) > 3 else "",
        }, on_conflict="account_id").execute()
        print(f"[CONNECT] Прокси {parts[0]}:{parts[1]} привязан к анкете {account_id}", flush=True)
    except Exception as e:
        print(f"[CONNECT] Прокси не сохранился: {e}", flush=True)


# Пул устройств: UA + СОГЛАСОВАННЫЙ с ним curl_cffi-impersonate.
# Версия Chrome в UA обязана совпадать с токеном impersonate, иначе TLS и
# заголовок расходятся — для антибота это явный робот.
_DEVICE_POOL = [
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "chrome120"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36", "chrome123"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "chrome124"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "chrome131"),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "chrome124"),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "chrome131"),
]


@app.post("/api/connect")
async def connect_account(payload: ConnectAccountRequest, authorization: str | None = Header(default=None)):
    result = await _connect_impl(payload, authorization)
    acc = (result or {}).get("account") or {}
    if acc.get("id"):
        if payload.proxy:
            _save_account_proxy(acc["id"], payload.proxy, payload.proxy_scheme)
        # Каждой анкете — свой отпечаток устройства: UA + согласованный TLS.
        # На одном UA/TLS Мамба кластеризует анкеты в ферму и банит пачкой.
        _ua, _imp = random.choice(_DEVICE_POOL)
        try:
            supabase.table("ai_settings").upsert({
                "account_id": acc["id"],
                "user_agent": _ua,
                "tls_impersonate": _imp,
            }, on_conflict="account_id").execute()
            print(f"[CONNECT] отпечаток привязан к анкете {acc['id']}: {_imp}", flush=True)
        except Exception as e:
            print(f"[CONNECT] отпечаток не сохранился: {e}", flush=True)
    return result


async def _connect_impl(payload: ConnectAccountRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    platform_lower = payload.platform.strip().lower()

    if not payload.profile_url.startswith("http") and platform_lower not in ("vznakomstve", "badanga", "soderzhanka", "loveplanet"):
        raise HTTPException(status_code=400, detail="profile_url должен начинаться с http")

    cookies = []
    x_token = ""

    # ── Twinby ──
    if platform_lower == "twinby":
        if not payload.twinby_email or not payload.twinby_code:
            raise HTTPException(status_code=400, detail="Введи email и код из письма")
        import json as _json
        from proxy_loader import get_proxy
        _proxy = get_proxy("twinby")

        def _do_confirm():
            if not (_proxy and _proxy.get("host") and _proxy.get("username")):
                raise RuntimeError("Прокси не настроен для Twinby — подключение без прокси запрещено")
            conn = SocksHTTPSConnection(
                "twinby.ru", 443,
                _proxy["host"], int(_proxy.get("port") or 1080),
                _proxy.get("username"), _proxy.get("password"),
                timeout=30,
            )
            body = _json.dumps({"login": payload.twinby_email, "provider": "email", "code": payload.twinby_code}).encode()
            conn.request("POST", "/api/auth/v2/auth/confirm", body=body, headers={
                "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Dart/3.11 (dart:io)",
            })
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

        account_id = str(uuid.uuid4())

        public_account = {
            "id": account_id, "owner_email": session["email"], "platform": "Twinby",
            "name": payload.account_name or payload.twinby_email,
            "profile_url": "https://twinby.ru", "final_url": "https://twinby.ru",
            "title": payload.account_name or payload.twinby_email,
            "photo_url": photo_url, "cookies_count": 1, "cookies_valid": True,
            "session_valid": True, "session_reason": "JWT авторизация",
            "images_found": 0, "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
        supabase.table("accounts").insert(public_account).execute()
        supabase.table("accounts_private").insert({"id": account_id, "cookies_raw": token}).execute()
        return {"ok": True, "account": public_account, "warning": None if photo_url else "Фото не найдено — добавь вручную."}

    # ── Vznakomstve ──
    if platform_lower == "vznakomstve" and payload.vzn_email and payload.vzn_code:
        import http.client as _hc, gzip as _gzip
        boundary = "getx-http-boundary-CLAWAI"

        # Без прокси этот запрос уходит с IP сервера — анкету метят
        # ещё до первого круга воркера
        _vp = load_platform_proxy("vznakomstve")
        if _vp and _vp.get("proxy_host"):
            import base64 as _b64
            _auth = _b64.b64encode(
                f"{_vp['proxy_login']}:{_vp['proxy_password']}".encode()).decode()
            conn = _hc.HTTPSConnection(_vp["proxy_host"], int(_vp["proxy_port"]), timeout=20)
            conn.set_tunnel("meet.wcase.net", 443,
                            {"Proxy-Authorization": f"Basic {_auth}"})
            print(f"[CONNECT VZN] через прокси {_vp['proxy_host']}:{_vp['proxy_port']}", flush=True)
        else:
            conn = _hc.HTTPSConnection("meet.wcase.net", timeout=15)
            print("[CONNECT VZN] БЕЗ ПРОКСИ — строки vznakomstve в proxy_settings нет", flush=True)
        body_bytes = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"email\"\r\n\r\n{payload.vzn_email}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"code\"\r\n\r\n{payload.vzn_code}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"lang\"\r\n\r\nru\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"no_restore\"\r\n\r\n1\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")
        conn.request("POST", "/email", body=body_bytes, headers={
            "Accept": "application/json", "Accept-Encoding": "gzip",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body_bytes)),
            "User-Agent": "InDating v3.2.6 (302060), Android 9, G011A", "Host": "meet.wcase.net",
        })
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        if resp.getheader("Content-Encoding") == "gzip":
            raw = _gzip.decompress(raw)
        data1 = json.loads(raw.decode("utf-8", errors="ignore"))
        sid = data1.get("data", {}).get("sid") or data1.get("sessionId") or data1.get("sid") or data1.get("token") or ""
        print(f"[VZN LOGIN] step1 status={resp.status} sid={sid}", flush=True)
        if not sid:
            raise HTTPException(status_code=400, detail=f"Неверный код. Ответ: {str(data1)[:200]}")

        conn2 = _hc.HTTPSConnection("meet.wcase.net", timeout=15)
        body2 = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"token\"\r\n\r\n{sid}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"no_restore\"\r\n\r\n1\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")
        conn2.request("POST", "/login", body=body2, headers={
            "Accept": "application/json", "Accept-Encoding": "gzip",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body2)),
            "User-Agent": "InDating v3.2.6 (302060), Android 9, G011A", "Host": "meet.wcase.net",
        })
        resp2 = conn2.getresponse()
        raw2 = resp2.read()
        set_cookie = resp2.getheader("Set-Cookie") or ""
        conn2.close()
        if resp2.getheader("Content-Encoding") == "gzip":
            raw2 = _gzip.decompress(raw2)
        data2 = json.loads(raw2.decode("utf-8", errors="ignore"))

        phpsessid = ""
        for part in set_cookie.split(";"):
            if part.strip().startswith("PHPSESSID="):
                phpsessid = part.strip().split("=", 1)[1]
                break
        if not phpsessid:
            phpsessid = data2.get("sessionId") or data2.get("data", {}).get("sid") or ""
        if not phpsessid:
            raise HTTPException(status_code=400, detail=f"Не удалось получить сессию: {str(data2)[:200]}")

        x_token = data1.get("token") or data2.get("token") or sid or ""
        cookies_raw_vzn = json.dumps([
            {"name": "PHPSESSID", "value": phpsessid},
            {"name": "x_token", "value": x_token},
        ])
        payload.cookies_raw = cookies_raw_vzn

        from vznakomstve_client import parse_cookies as _vzn_parse, get_profile_photo as _vzn_get_photo
        import time as _time
        http_cookies = _vzn_parse(cookies_raw_vzn)
        photo_url = ""
        for _attempt in range(3):
            photo_url = _vzn_get_photo(http_cookies) or ""
            if photo_url:
                break
            _time.sleep(2)

        account_id = str(uuid.uuid4())
        public_account = {
            "id": account_id, "owner_email": session["email"], "platform": payload.platform,
            "name": payload.account_name or "Взнакомстве",
            "profile_url": "https://vznakomstve.com/app/",
            "final_url": "https://vznakomstve.com/app/",
            "title": payload.account_name or "Взнакомстве",
            "photo_url": photo_url, "cookies_count": 2, "cookies_valid": True,
            "session_valid": True, "session_reason": "Email авторизация",
            "images_found": 0, "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
        supabase.table("accounts").insert(public_account).execute()
        supabase.table("accounts_private").insert({"id": account_id, "cookies_raw": cookies_raw_vzn}).execute()
        return {"ok": True, "account": public_account, "warning": None if photo_url else "Фото не найдено — добавь вручную."}

    # ── Mamba / Lovelaz — напрямую ──
    if platform_lower == "mamba":
        from mamba_client import parse_cookies as _m_parse, get_profile_photo as _m_photo
        cookies = _m_parse(payload.cookies_raw)
        photo_url = ""
        try:
            photo_url = _m_photo(cookies) or ""
        except Exception as e:
            print(f"[MAMBA CONNECT] фото не получено: {e}", flush=True)
        account_id = str(uuid.uuid4())
        public_account = {
            "id": account_id, "owner_email": session["email"], "platform": "Mamba",
            "name": payload.account_name or "Анкета",
            "profile_url": payload.profile_url, "final_url": payload.profile_url,
            "title": payload.account_name or "Анкета",
            "photo_url": photo_url, "cookies_count": len(cookies), "cookies_valid": True,
            "session_valid": True, "session_reason": "HTTP проверка",
            "images_found": 0, "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
        supabase.table("accounts").insert(public_account).execute()
        supabase.table("accounts_private").insert({"id": account_id, "cookies_raw": payload.cookies_raw}).execute()
        return {"ok": True, "account": public_account, "warning": None if photo_url else "Фото не найдено — добавь вручную."}

    if platform_lower == "loveru":
        from loveru_client import (
            parse_cookies as _lr_parse, validate_cookies as _lr_validate,
            get_profile_photo as _lr_photo,
        )
        cookies = _lr_parse(payload.cookies_raw)
        ok, missing = _lr_validate(cookies)
        if not ok:
            raise HTTPException(status_code=400,
                detail=f"В куках нет обязательных: {', '.join(missing)}. "
                       "Экспортируй куки love.ru целиком (включая muid).")
        photo_url = ""
        try:
            photo_url = _lr_photo(cookies) or ""
        except Exception as e:
            print(f"[LOVERU CONNECT] фото не получено: {e}", flush=True)
        account_id = str(uuid.uuid4())
        public_account = {
            "id": account_id, "owner_email": session["email"], "platform": "LoveRu",
            "name": payload.account_name or "Анкета",
            "profile_url": payload.profile_url or "https://love.ru/",
            "final_url": payload.profile_url or "https://love.ru/",
            "title": payload.account_name or "Анкета",
            "photo_url": photo_url, "cookies_count": len(cookies), "cookies_valid": True,
            "session_valid": True, "session_reason": "HTTP проверка",
            "images_found": 0, "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
        supabase.table("accounts").insert(public_account).execute()
        supabase.table("accounts_private").insert({"id": account_id, "cookies_raw": payload.cookies_raw}).execute()
        return {"ok": True, "account": public_account,
                "warning": None if photo_url else "Фото не найдено — добавь вручную."}

    if platform_lower in ("badanga", "soderzhanka"):
        from badanga_client import (
            resolve_token as _bd_resolve, credentials_blob as _bd_blob,
            get_me as _bd_me, get_profile_photo as _bd_photo,
            token_days_left as _bd_days,
        )
        from badanga_client import (
            set_account_proxy as _bd_set_proxy,
            clear_account_proxy as _bd_clear_proxy,
        )
        # Аккаунты у витрин разные: пробуем выбранную, при invalidCredentials — соседнюю
        from badanga_client import set_site as _bd_set_site
        _order = [platform_lower] + [s for s in ("badanga", "soderzhanka") if s != platform_lower]
        token, creds, _last_err = None, None, ""
        for _site in _order:
            _bd_set_site(_site)
            _bd_set_proxy(load_platform_proxy(_site) or {})
            try:
                token, creds = _bd_resolve(payload.cookies_raw)
                platform_lower = _site
                break
            except Exception as e:
                _last_err = str(e)
                if "invalidCredentials" in _last_err:
                    continue
                break
        if not token:
            if "loginUnavailable" in _last_err:
                raise HTTPException(status_code=400, detail="Сайт закрыл вход с этого IP (loginUnavailable). Задай прокси в Настройках или подожди 15-30 мин.")
            if "invalidCredentials" in _last_err:
                raise HTTPException(status_code=400, detail="Логин или пароль не подошли ни к Баддане, ни к Содержанке")
            raise HTTPException(status_code=400, detail=_last_err[:200])

        me = _bd_me(token)
        if me.get("_status") in (401, 403):
            raise HTTPException(status_code=400, detail="Логин или пароль не подошли")
        if me.get("_status") not in (200, 201):
            raise HTTPException(status_code=400, detail=f"Badanga не ответил (HTTP {me.get('_status')})")
        if me.get("is_banned"):
            raise HTTPException(status_code=400, detail="Анкета забанена")

        photo_url = _bd_photo(token, me) or ""
        days = _bd_days(token)
        account_id = str(uuid.uuid4())
        public_account = {
            "id": account_id, "owner_email": session["email"],
            "platform": "Soderzhanka" if platform_lower == "soderzhanka" else "Badanga",
            "name": payload.account_name or me.get("name") or "Анкета",
            "profile_url": payload.profile_url or ("https://soderzhanka.com/" if platform_lower == "soderzhanka" else "https://www.badanga.ru/badanga/me"),
            "final_url": payload.profile_url or ("https://soderzhanka.com/" if platform_lower == "soderzhanka" else "https://www.badanga.ru/badanga/me"),
            "title": payload.account_name or me.get("name") or "Анкета",
            "photo_url": photo_url, "cookies_count": 1, "cookies_valid": True,
            "session_valid": True,
            "session_reason": ("Вход по логину" if creds.get("password")
                               else f"Токен живёт ещё {days} дн."),
            "images_found": 0, "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
        supabase.table("accounts").insert(public_account).execute()
        supabase.table("accounts_private").insert(
            {"id": account_id, "cookies_raw": _bd_blob(creds)}
        ).execute()
        return {"ok": True, "account": public_account,
                "warning": None if photo_url else "Фото не найдено — добавь вручную."}

    if platform_lower == "loveplanet":
        from loveplanet_client import (
            resolve_session as _lp_resolve, credentials_blob as _lp_blob,
            get_me as _lp_me,
        )
        try:
            cookie, creds = _lp_resolve(payload.cookies_raw)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e)[:200])

        me = _lp_me(cookie)
        if me.get("_status") not in (200, 201) or me.get("errno") not in (0, None):
            raise HTTPException(status_code=400, detail=f"LovePlanet не ответил (HTTP {me.get('_status')}, errno={me.get('errno')})")

        photo_url = me.get("foto") or ""
        account_id = str(uuid.uuid4())
        public_account = {
            "id": account_id, "owner_email": session["email"], "platform": "LovePlanet",
            "name": payload.account_name or me.get("name") or "Анкета",
            "profile_url": payload.profile_url or "https://loveplanet.ru/",
            "final_url": payload.profile_url or "https://loveplanet.ru/",
            "title": payload.account_name or me.get("name") or "Анкета",
            "photo_url": photo_url, "cookies_count": 1, "cookies_valid": True,
            "session_valid": True, "session_reason": "Вход по логину",
            "images_found": 0, "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
        supabase.table("accounts").insert(public_account).execute()
        supabase.table("accounts_private").insert(
            {"id": account_id, "cookies_raw": _lp_blob(creds)}
        ).execute()
        return {"ok": True, "account": public_account,
                "warning": None if photo_url else "Фото не найдено — добавь вручную."}

    if platform_lower == "lovelaz":
        from lovelaz_client import parse_cookies as _lz_parse, get_profile_photo as _lz_photo
        cookies = _lz_parse(payload.cookies_raw)
        photo_url = ""
        try:
            photo_url = _lz_photo(cookies) or ""
        except Exception as e:
            print(f"[LOVELAZ CONNECT] фото не получено: {e}", flush=True)
        account_id = str(uuid.uuid4())
        public_account = {
            "id": account_id, "owner_email": session["email"], "platform": "Lovelaz",
            "name": payload.account_name or "Анкета",
            "profile_url": payload.profile_url, "final_url": payload.profile_url,
            "title": payload.account_name or "Анкета",
            "photo_url": photo_url, "cookies_count": len(cookies), "cookies_valid": True,
            "session_valid": True, "session_reason": "HTTP проверка",
            "images_found": 0, "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
        supabase.table("accounts").insert(public_account).execute()
        supabase.table("accounts_private").insert({"id": account_id, "cookies_raw": payload.cookies_raw}).execute()
        return {"ok": True, "account": public_account, "warning": None if photo_url else "Фото не найдено — добавь вручную."}

    if platform_lower == "atolin":
        from atolin_client import (
            parse_cookies as _at_parse,
            validate_cookies as _at_validate,
            validate_session as _at_session,
            parse_proxy_string as _at_proxy_str,
        )

        cookies = _at_parse(payload.cookies_raw)
        ok, missing = _at_validate(cookies)
        if not ok:
            raise HTTPException(status_code=400, detail=f"В куках не хватает: {', '.join(missing)}")

        proxy = _at_proxy_str(payload.atolin_proxy, payload.atolin_proxy_scheme or "socks5h")
        if not proxy:
            raise HTTPException(status_code=400, detail="Прокси обязателен, формат: host:port:логин:пароль")

        session_info = _at_session(cookies, proxy=proxy)
        print(f"[ATOLIN CONNECT] сессия: {session_info}", flush=True)
        if session_info["status"] == "logged_out":
            raise HTTPException(
                status_code=400,
                detail="Atolin не принял куки с этого прокси — сессия привязана к другому IP. "
                       "Открой браузер через этот же прокси, залогинься заново и сними свежие куки.",
            )
        if session_info["status"] == "unknown":
            raise HTTPException(status_code=400, detail=f"Не достучались до Atolin: {session_info['reason']}")

        role = "parser" if (payload.atolin_role or "main") == "parser" else "main"
        account_id = str(uuid.uuid4())

        public_account = {
            "id": account_id,
            "owner_email": session["email"],
            "platform": "Atolin",
            "name": payload.account_name or ("Парс" if role == "parser" else "Анкета"),
            "profile_url": "https://atolin.ru",
            "final_url": "https://atolin.ru",
            "title": payload.account_name or "Анкета",
            "photo_url": "",
            "role": role,
            "cookies_count": len(cookies),
            "cookies_valid": True,
            "session_valid": True,
            "session_reason": session_info["reason"],
            "images_found": 0,
            "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
        supabase.table("accounts").insert(public_account).execute()
        supabase.table("accounts_private").insert({"id": account_id, "cookies_raw": payload.cookies_raw}).execute()

        # Прокси храним у самой анкеты, а не общий на платформу
        supabase.table("ai_settings").upsert({
            "account_id": account_id,
            "proxy_protocol": proxy["scheme"],
            "proxy_host": proxy["host"],
            "proxy_port": str(proxy["port"]),
            "proxy_login": proxy["username"],
            "proxy_password": proxy["password"],
        }, on_conflict="account_id").execute()

        return {
            "ok": True,
            "account": public_account,
            "warning": "Фото пока не тянем — добавь вручную." if role == "main" else None,
        }

    if platform_lower == "intcity":
        if not payload.cookies_raw or not payload.cookies_raw.strip().startswith("["):
            raise HTTPException(status_code=400, detail="Вставь Cookie Editor JSON")
        account_id = str(uuid.uuid4())
        public_account = {
            "id": account_id,
            "owner_email": session["email"],
            "platform": "intCity",
            "name": payload.account_name or payload.intcity_email,
            "profile_url": f"mailto:{payload.intcity_email}",
            "final_url": f"mailto:{payload.intcity_email}",
            "photo_url": "/intcity_logo.png",
            "session_valid": True,
            "session_reason": "OK",
            "images_found": 0,
            "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
        # Парсим Cookie Editor JSON и тянем токен со страницы
        mail_cookie_str = ""
        mail_token = ""
        try:
            import httpx as _httpx, re as _re
            cookie_list = json.loads(payload.cookies_raw)
            mail_cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookie_list if c.get("name") and c.get("value"))
            print(f"[intCity] Собрано кук: {len(cookie_list)}", flush=True)
            page_resp = _httpx.get(
                "https://e.mail.ru/inbox/",
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                    "Cookie": mail_cookie_str,
                },
                timeout=15,
                follow_redirects=True,
            )
            token_match = _re.search(r'[a-f0-9]{32}:[A-Za-z0-9_\-+/=.]{20,}', page_resp.text)
            if token_match:
                mail_token = token_match.group(0)
                print(f"[intCity] Токен получен: {mail_token[:20]}...", flush=True)
            else:
                print(f"[intCity] Токен не найден в HTML", flush=True)
        except Exception as e:
            print(f"[intCity] Ошибка при парсинге кук: {e}", flush=True)

        cookies_raw = json.dumps({
            "email": "",
            "password": "",
            "mail_cookie": mail_cookie_str,
            "mail_token": mail_token,
        })
        supabase.table("accounts").insert(public_account).execute()
        supabase.table("accounts_private").insert({"id": account_id, "cookies_raw": cookies_raw}).execute()
        warning = None if mail_token else "Токен не получен автоматически — вставь вручную на карточке"
        return {"ok": True, "account": public_account, "warning": warning}

    raise HTTPException(status_code=400, detail=f"Неизвестная платформа: {platform_lower}")

   
# ── Operator (Telegram) ──────────────────────────────────

@app.post("/api/operator/send-code")
async def operator_send_code(payload: OperatorSendCodeRequest, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{OPERATOR_SERVER_URL}/api/operator/login/start", json={"phone": payload.phone})
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Operator-сервис недоступен: {e}")
    data = resp.json()
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=data.get("detail") or data)
    return data

@app.post("/api/operator/login/verify")
async def operator_login_verify(payload: OperatorLoginVerifyRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{OPERATOR_SERVER_URL}/api/operator/login/verify", json={
                "phone": payload.phone,
                "code": payload.code,
                "password": payload.password or None,
                "owner_email": session["email"],
                "display_name": payload.account_name,
            })
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Operator-сервис недоступен: {e}")
    data = resp.json()
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=data.get("detail") or data)
    return data

# ── Tasks — проксируем на воркеры ──────────────────────────

def get_account_platform(account_id: str) -> str:
    """Получает платформу аккаунта из Supabase."""
    try:
        res = supabase.table("accounts").select("platform").eq("id", account_id).limit(1).execute()
        if res.data:
            return (res.data[0].get("platform") or "mamba").lower()
    except Exception:
        pass
    return "mamba"

def enqueue_local_job(account_id: str, job_type: str, job_payload: dict) -> dict:
    """Платформы без своего менеджер-сервиса (Badanga): кладём задачу
    в очередь напрямую — её воркер сам оттуда заберёт."""
    exists = (supabase.table("job_queue").select("id")
              .eq("account_id", account_id).eq("type", job_type)
              .in_("status", ["pending", "running"]).limit(1).execute())
    if exists.data:
        return {"ok": True, "job_id": exists.data[0]["id"], "status": "pending"}
    res = supabase.table("job_queue").insert({
        "account_id": account_id,
        "type": job_type,
        "payload": job_payload,
        "status": "pending",
    }).execute()
    return {"ok": True, "job_id": res.data[0]["id"], "status": "pending"}


@app.post("/api/tasks/likes-http")
async def api_task_likes(payload: LikesTaskRequest, authorization: str | None = Header(default=None)):
    platform = get_account_platform(payload.account_id)
    if platform == "lovelaz":
        return await proxy_to_worker("lovelaz", "/api/tasks/lovelaz-likes", payload.model_dump(), authorization)
    elif platform == "twinby":
        return await proxy_to_worker("twinby", "/api/tasks/twinby-likes", payload.model_dump(), authorization)
    elif platform == "vznakomstve":
        return await proxy_to_worker("vznakomstve", "/api/tasks/vznakomstve-auto-reply", payload.model_dump(), authorization)
    elif platform == "atolin":
        return await proxy_to_worker("atolin", "/api/tasks/atolin-auto-reply", payload.model_dump(), authorization)
    elif platform == "loveru":
        return await proxy_to_worker("loveru", "/api/tasks/likes-http", payload.model_dump(), authorization)
    elif platform in ("badanga", "soderzhanka", "loveplanet"):
        return enqueue_local_job(payload.account_id, "likes-http", {"limit": payload.limit})
    else:
        return await proxy_to_worker("mamba", "/api/tasks/auto-reply-http", payload.model_dump(), authorization)

@app.post("/api/tasks/lovelaz-likes")
async def api_task_lovelaz_likes(payload: LikesTaskRequest, authorization: str | None = Header(default=None)):
    return await proxy_to_worker("lovelaz", "/api/tasks/lovelaz-likes", payload.model_dump(), authorization)

class BroadcastTaskRequest(BaseModel):
    account_id: str
    prompt: str
    limit: int = 30
    delay: int = 20
    pages: int = 1

@app.post("/api/tasks/lovelaz-broadcast")
async def api_task_lovelaz_broadcast(payload: BroadcastTaskRequest, authorization: str | None = Header(default=None)):
    return await proxy_to_worker("lovelaz", "/api/tasks/lovelaz-broadcast", payload.model_dump(), authorization)

@app.post("/api/tasks/auto-reply-http")
async def api_task_auto_reply(payload: AutoReplyTaskRequest, authorization: str | None = Header(default=None)):
    platform = get_account_platform(payload.account_id)
    if platform == "lovelaz":
        return await proxy_to_worker("lovelaz", "/api/tasks/lovelaz-auto-reply", payload.model_dump(), authorization)
    elif platform == "twinby":
        return await proxy_to_worker("twinby", "/api/tasks/twinby-auto-reply", payload.model_dump(), authorization)
    elif platform == "vznakomstve":
        return await proxy_to_worker("vznakomstve", "/api/tasks/vznakomstve-auto-reply", payload.model_dump(), authorization)
    elif platform == "loveru":
        return await proxy_to_worker("loveru", "/api/tasks/auto-reply-http", payload.model_dump(), authorization)
    elif platform in ("badanga", "soderzhanka", "loveplanet"):
        return enqueue_local_job(payload.account_id, "auto-reply-http", {"max_dialogs": payload.max_dialogs})
    else:
        return await proxy_to_worker("mamba", "/api/tasks/auto-reply-http", payload.model_dump(), authorization)
@app.post("/api/tasks/auto-reply-http-loop")
async def api_task_auto_reply_loop(payload: AutoReplyTaskRequest, authorization: str | None = Header(default=None)):
    platform = get_account_platform(payload.account_id)
    if platform == "lovelaz":
        return await proxy_to_worker("lovelaz", "/api/tasks/lovelaz-auto-reply", payload.model_dump(), authorization)
    elif platform == "twinby":
        return await proxy_to_worker("twinby", "/api/tasks/twinby-auto-reply", payload.model_dump(), authorization)
    elif platform == "vznakomstve":
        return await proxy_to_worker("vznakomstve", "/api/tasks/vznakomstve-auto-reply", payload.model_dump(), authorization)
    else:
        return await proxy_to_worker("mamba", "/api/tasks/auto-reply-http-loop", payload.model_dump(), authorization)

@app.post("/api/tasks/lovelaz-auto-reply")
async def api_task_lovelaz_auto_reply(payload: AutoReplyTaskRequest, authorization: str | None = Header(default=None)):
    return await proxy_to_worker("lovelaz", "/api/tasks/lovelaz-auto-reply", payload.model_dump(), authorization)

@app.post("/api/tasks/stop")
async def api_task_stop(payload: StopTaskRequest, authorization: str | None = Header(default=None)):
    # Стоп на всех воркерах одновременно
    # Раньше пять запросов шли по очереди, каждый с таймаутом 10 сек —
    # при спящих воркерах «Стоп» висел до минуты. Теперь все разом.
    async def _stop_one(url):
        try:
            await HTTP_CLIENT.post(f"{url}/api/tasks/stop",
                                   json={"account_id": payload.account_id}, timeout=10)
        except Exception:
            pass
    await asyncio.gather(*(_stop_one(u) for u in PLATFORM_URLS.values()))
    supabase.table("job_queue").update({"status": "cancelled"}).eq("account_id", payload.account_id).in_("status", ["pending", "running"]).execute()
    return {"ok": True}

# ── Twinby / Vznakomstve send-code ───────────────────────

@app.post("/api/twinby/send-code")
async def twinby_send_code(payload: dict, authorization: str | None = Header(default=None)):
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(f"{TWINBY_SERVER_URL}/api/twinby/send-code", json=payload, headers={"Authorization": authorization or ""})
        try:
            return resp.json()
        except Exception:
            print(f"[TWINBY SEND-CODE] не-JSON от воркера (HTTP {resp.status_code}): "
                  f"{resp.text[:400]}", flush=True)
            raise HTTPException(status_code=502,
                detail=f"Twinby воркер вернул не-JSON (HTTP {resp.status_code}): {resp.text[:200]}")

@app.post("/api/vznakomstve/send-code")
async def vzn_send_code(payload: dict, authorization: str | None = Header(default=None)):
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{VZNAKOMSTVE_SERVER_URL}/api/vznakomstve/send-code", json=payload, headers={"Authorization": authorization or ""})
        return resp.json()

@app.post("/api/vznakomstve/verify-code")
async def vzn_verify_code(payload: dict, authorization: str | None = Header(default=None)):
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{VZNAKOMSTVE_SERVER_URL}/api/vznakomstve/verify-code", json=payload, headers={"Authorization": authorization or ""})
        return resp.json()

# ── AI Settings ───────────────────────────────────────────

@app.get("/api/ai-settings/{account_id}")
def api_get_ai_settings(account_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    account_res = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).execute()
    if not account_res.data:
        raise HTTPException(status_code=403, detail="Нет доступа")
    return {"ok": True, "settings": get_ai_settings(account_id)}

@app.post("/api/ai-settings/{account_id}")
def api_save_ai_settings(account_id: str, payload: AiSettingsPayload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    account_res = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).execute()
    if not account_res.data:
        raise HTTPException(status_code=403, detail="Нет доступа")
    existing = get_ai_settings(account_id)
    data = {k: v for k, v in payload.model_dump().items() if v != "" and v is not None}
    merged = {**existing, **data}
    saved = save_ai_settings(account_id, merged)
    return {"ok": True, "settings": saved}

# ── Tasks log / Stats ─────────────────────────────────────

@app.get("/api/tasks-log")
def api_tasks_log(account_id: str = "", authorization: str | None = Header(default=None)):
    # Раньше отдавал лог задач ВСЕХ пользователей и вообще без авторизации.
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    _acc = supabase.table("accounts").select("id").in_("owner_email", owner_emails).execute()
    _my_ids = [a["id"] for a in (_acc.data or [])]
    if not _my_ids or (account_id and account_id not in _my_ids):
        return {"ok": True, "logs": []}
    # Каждая анкета опрашивает это раз в 15 сек. Раньше отдавали весь лог всем —
    # теперь только свою анкету и только нужные поля.
    q = supabase.table("tasks_log").select(
        "account_id, type, summary, liked, replied, contacts_sent, created_at"
    )
    q = q.eq("account_id", account_id) if account_id else q.in_("account_id", _my_ids)
    res = q.order("created_at", desc=True).limit(50 if account_id else 200).execute()
    return {"ok": True, "logs": res.data or []}

@app.get("/api/accounts-stats")
def api_accounts_stats(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    accounts_res = supabase.table("accounts").select("id").in_("owner_email", owner_emails).execute()
    account_ids = [a["id"] for a in (accounts_res.data or [])]
    if not account_ids:
        return {"ok": True, "stats": {}}
    res = supabase.table("tasks_log").select("account_id, type, liked, replied, contacts_sent").in_("account_id", account_ids).execute()
    stats: dict[str, dict] = {}
    for row in (res.data or []):
        acc_id = row.get("account_id")
        if not acc_id:
            continue
        if acc_id not in stats:
            stats[acc_id] = {"liked": 0, "replied": 0, "contacts": 0}
        if row.get("type") == "likes":
            stats[acc_id]["liked"] += int(row.get("liked") or 0)
        if row.get("type") == "auto-reply-http":
            stats[acc_id]["replied"] += int(row.get("replied") or 0)
            stats[acc_id]["contacts"] += int(row.get("contacts_sent") or 0)
    return {"ok": True, "stats": stats}

# ── Notifications ─────────────────────────────────────────

@app.get("/api/notifications")
def api_get_notifications(authorization: str | None = Header(default=None)):
    try:
        session = require_auth(authorization)
        res = supabase.table("notifications").select("*").eq("email", session["email"]).order("created_at", desc=True).limit(50).execute()
        return {"ok": True, "notifications": res.data or []}
    except Exception as e:
        return {"ok": False, "notifications": [], "error": str(e)}

# ── Team ──────────────────────────────────────────────────

@app.post("/api/team/invite")
def api_team_invite(payload: TeamInviteRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_email = session["email"].strip().lower()
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Некорректный email")
    if owner_email == email:
        raise HTTPException(status_code=400, detail="Нельзя пригласить самого себя")
    invite_res = supabase.table("team_invites").insert({"owner_email": owner_email, "email": email, "role": payload.role, "status": "pending"}).execute()
    invite = invite_res.data[0]
    supabase.table("notifications").insert({"email": email, "type": "team_invite", "title": "Приглашение в команду", "message": f"{owner_email} приглашает вас в команду", "data": {"invite_id": invite["id"], "owner_email": owner_email, "role": payload.role}, "is_read": False}).execute()
    return {"ok": True, "invite": invite}

@app.post("/api/team/invite/accept")
def api_accept_invite(payload: AcceptInviteRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    email = session["email"]
    res = supabase.table("team_invites").select("*").eq("id", payload.invite_id).eq("email", email).eq("status", "pending").execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Приглашение не найдено")
    invite = res.data[0]
    supabase.table("team_members").upsert({"owner_email": invite["owner_email"], "member_email": email, "role": invite["role"], "status": "active"}).execute()
    supabase.table("team_invites").update({"status": "accepted", "accepted_at": datetime.now().isoformat()}).eq("id", payload.invite_id).execute()
    supabase.table("notifications").update({"is_read": True}).eq("email", email).eq("type", "team_invite").execute()
    return {"ok": True}

@app.post("/api/team/invite/reject")
def api_reject_invite(payload: RejectInviteRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    email = session["email"]
    supabase.table("team_invites").update({"status": "rejected"}).eq("id", payload.invite_id).eq("email", email).execute()
    supabase.table("notifications").update({"is_read": True}).eq("email", email).eq("type", "team_invite").execute()
    return {"ok": True}

@app.get("/api/team/members")
def api_team_members(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    res = supabase.table("team_members").select("*").eq("owner_email", session["email"]).order("created_at", desc=True).execute()
    return {"ok": True, "members": res.data or []}

# ── Планирование ──────────────────────────────────────────

class PlanTaskCreate(BaseModel):
    title: str
    description: str = ""
    assignee_email: str = ""
    priority: str = "normal"
    due_date: str = ""

class PlanTaskPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    assignee_email: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    due_date: Optional[str] = None

class PlanCommentCreate(BaseModel):
    body: str

def _plan_guard(task_id: str, session: dict):
    """Задача видна только своей команде."""
    emails = get_team_owner_emails(session["email"])
    cur = supabase.table("plan_tasks").select("id").eq("id", task_id).in_("owner_email", emails).execute()
    if not (cur.data or []):
        raise HTTPException(status_code=404, detail="Задача не найдена")

def _plan_names(emails: list[str]) -> dict:
    """email -> имя из app_users; если имени нет, берём часть до собачки."""
    names = {}
    try:
        res = supabase.table("app_users").select("email, username").in_("email", emails).execute()
        for row in res.data or []:
            nm = (row.get("username") or "").strip()
            if nm:
                names[row["email"]] = nm
    except Exception as e:
        print(f"[PLAN] имена не подтянулись: {e}", flush=True)
    for em in emails:
        names.setdefault(em, (em or "").split("@")[0])
    return names

@app.get("/api/plan/people")
def api_plan_people(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    emails = get_team_owner_emails(session["email"])
    return {
        "ok": True,
        "people": sorted(emails),
        "names": _plan_names(emails),
        "me": session["email"],
    }

@app.get("/api/plan/tasks")
def api_plan_tasks(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    emails = get_team_owner_emails(session["email"])
    res = (supabase.table("plan_tasks").select("*")
           .in_("owner_email", emails)
           .order("created_at", desc=True).execute())
    tasks = res.data or []
    ids = [t["id"] for t in tasks]
    counts = {}
    if ids:
        c = supabase.table("plan_comments").select("task_id").in_("task_id", ids).execute()
        for row in c.data or []:
            counts[row["task_id"]] = counts.get(row["task_id"], 0) + 1
    for t in tasks:
        t["comments_count"] = counts.get(t["id"], 0)
    return {"ok": True, "tasks": tasks, "me": session["email"]}

@app.post("/api/plan/tasks")
def api_plan_task_create(payload: PlanTaskCreate, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    title = (payload.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Название задачи пустое")
    row = {
        "owner_email": session["email"],
        "title": title,
        "description": payload.description or "",
        "assignee_email": (payload.assignee_email or "").strip() or None,
        "status": "new",
        "priority": payload.priority or "normal",
        "due_date": payload.due_date or None,
        "created_by": session["email"],
    }
    res = supabase.table("plan_tasks").insert(row).execute()
    return {"ok": True, "task": (res.data or [None])[0]}

@app.patch("/api/plan/tasks/{task_id}")
def api_plan_task_patch(task_id: str, payload: PlanTaskPatch, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _plan_guard(task_id, session)
    upd = {}
    for field in ("title", "description", "assignee_email", "status", "priority", "due_date"):
        val = getattr(payload, field)
        if val is not None:
            upd[field] = val or None
    if not upd:
        return {"ok": True}
    upd["updated_at"] = datetime.now(timezone.utc).isoformat()
    if upd.get("status") == "done":
        upd["done_at"] = upd["updated_at"]
    elif "status" in upd:
        upd["done_at"] = None
    supabase.table("plan_tasks").update(upd).eq("id", task_id).execute()
    return {"ok": True}

@app.delete("/api/plan/tasks/{task_id}")
def api_plan_task_delete(task_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _plan_guard(task_id, session)
    supabase.table("plan_tasks").delete().eq("id", task_id).execute()
    return {"ok": True}

@app.get("/api/plan/tasks/{task_id}/comments")
def api_plan_comments(task_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _plan_guard(task_id, session)
    res = (supabase.table("plan_comments").select("*")
           .eq("task_id", task_id).order("created_at", desc=False).execute())
    rows = res.data or []
    names = _plan_names(list({r["author_email"] for r in rows})) if rows else {}
    for r in rows:
        r["author_name"] = names.get(r["author_email"], "")
    return {"ok": True, "comments": rows}

@app.post("/api/plan/tasks/{task_id}/comments")
def api_plan_comment_add(task_id: str, payload: PlanCommentCreate, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _plan_guard(task_id, session)
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="Комментарий пустой")
    res = supabase.table("plan_comments").insert({
        "task_id": task_id,
        "author_email": session["email"],
        "body": body,
    }).execute()
    return {"ok": True, "comment": (res.data or [None])[0]}

# ── База: отчёт о проделанной работе за смену ─────────────

class BaseAdd(BaseModel):
    bulk: str = ""          # старый формат, оставлен для совместимости
    emails: str = ""
    passwords: str = ""
    work_date: str = ""
    platform: str = ""
    note: str = ""

def _base_months(oldest: str | None) -> list[str]:
    """Список месяцев от самой старой записи до текущего."""
    now = datetime.now(KYIV_TZ)
    cur = f"{now.year:04d}-{now.month:02d}"
    if not oldest:
        return [cur]
    try:
        y, m = int(oldest[:4]), int(oldest[5:7])
    except Exception:
        return [cur]
    out, ly, lm = [], now.year, now.month
    while (y, m) <= (ly, lm):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out[-24:]

@app.get("/api/work-base")
def api_work_base(month: str = "", authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    is_admin = (me or "").lower() in ADMIN_EMAILS

    now = datetime.now(KYIV_TZ)
    month = month or f"{now.year:04d}-{now.month:02d}"
    start, end = _month_range(month)

    q = (supabase.table("work_base").select("*")
         .gte("work_date", start).lt("work_date", end))
    if not is_admin:
        q = q.eq("author_email", me)
    rows = q.order("work_date", desc=True).execute().data or []

    oq = supabase.table("work_base").select("work_date")
    if not is_admin:
        oq = oq.eq("author_email", me)
    oldest = (oq.order("work_date").limit(1).execute().data or [{}])
    oldest_day = str((oldest[0] if oldest else {}).get("work_date") or "")[:10] or None

    emails = sorted({r["author_email"] for r in rows} | {me})
    return {"ok": True, "rows": rows, "month": month,
            "months": _base_months(oldest_day),
            "names": _plan_names(emails), "me": me, "is_owner": is_admin}

@app.post("/api/work-base")
def api_work_base_add(payload: BaseAdd, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    day = (payload.work_date or "").strip() or datetime.now(KYIV_TZ).strftime("%Y-%m-%d")

    plat_all = (payload.platform or "").strip()
    note = (payload.note or "").strip()
    rows = []

    mails = [s.strip() for s in (payload.emails or "").splitlines() if s.strip()]
    if mails:
        # Два отдельных поля: почты и пароли сопоставляются построчно
        pwds = [s.strip() for s in (payload.passwords or "").splitlines()]
        for i, mail in enumerate(mails):
            rows.append({
                "owner_email": me, "author_email": me, "work_date": day,
                "email": mail,
                "password": pwds[i] if i < len(pwds) else "",
                "platform": plat_all,
                "note": note,
            })
    else:
        # Старый формат одной строкой: почта пароль [платформа]
        for line in (payload.bulk or "").splitlines():
            line = line.strip()
            if not line:
                continue
            parts = [p.strip() for p in re.split(r"[;,:\t|]| {2,}| +", line) if p.strip()]
            if not parts:
                continue
            rows.append({
                "owner_email": me, "author_email": me, "work_date": day,
                "email": parts[0],
                "password": parts[1] if len(parts) > 1 else "",
                "platform": (parts[2] if len(parts) > 2 else "") or plat_all,
                "note": note,
            })
    if not rows:
        raise HTTPException(status_code=400, detail="Пусто — нечего добавлять")

    try:
        res = supabase.table("work_base").insert(rows).execute()
        added = len(res.data or rows)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"База не приняла: {str(e)[:300]}")
    return {"ok": True, "added": added}

@app.delete("/api/work-base/{row_id}")
def api_work_base_delete(row_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    res = (supabase.table("work_base").select("author_email")
           .eq("id", row_id).limit(1).execute())
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    if row.get("author_email") != me and (me or "").lower() not in ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="Нет доступа")
    supabase.table("work_base").delete().eq("id", row_id).execute()
    return {"ok": True}

# ── Пул Groq-ключей ───────────────────────────────────────

class GroqAdd(BaseModel):
    bulk: str = ""
    assigned_to: str = ""
    note: str = ""

class GroqPatch(BaseModel):
    assigned_to: Optional[str] = None
    note: Optional[str] = None

@app.get("/api/groq-pool")
def api_groq_pool(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    is_admin = (me or "").lower() in ADMIN_EMAILS

    if is_admin:
        _all = supabase.table("app_users").select("email").execute().data or []
        emails = sorted({u["email"] for u in _all if u.get("email")} | {me})
        rows = (supabase.table("groq_pool").select("*")
                .order("created_at", desc=True).execute()).data or []
    else:
        emails = get_team_owner_emails(me)
        mine = (supabase.table("groq_pool").select("*")
                .eq("owner_email", me).execute()).data or []
        given = (supabase.table("groq_pool").select("*")
                 .eq("assigned_to", me).execute()).data or []
        seen, rows = set(), []
        for r in mine + given:
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            rows.append(r)
        rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)

    # Какие ключи уже стоят в слотах анкет
    used = {}
    try:
        q = supabase.table("accounts").select("id, name, title, owner_email")
        if not is_admin:
            q = q.in_("owner_email", emails)
        accs = {str(a["id"]): (a.get("name") or a.get("title") or "анкета")
                for a in (q.execute().data or [])}
        ids = list(accs)
        for i in range(0, len(ids), 200):
            for s in (supabase.table("ai_settings")
                      .select("account_id, groq_api_key, groq_api_keys")
                      .in_("account_id", ids[i:i + 200]).execute().data or []):
                nm = accs.get(str(s.get("account_id")), "анкета")
                raw = (s.get("groq_api_keys") or "") + "\n" + (s.get("groq_api_key") or "")
                for k in re.split(r"[\s,;]+", raw):
                    k = k.strip()
                    if k.startswith("gsk_") and nm not in used.setdefault(k, []):
                        used[k].append(nm)
    except Exception as e:
        print(f"[GROQ] занятые ключи не собрались: {e}", flush=True)

    return {"ok": True, "keys": rows, "people": emails,
            "names": _plan_names(emails), "me": me, "is_owner": is_admin,
            "used": {k: v[:6] for k, v in used.items()}}

@app.post("/api/groq-pool")
def api_groq_pool_add(payload: GroqAdd, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    assign = (payload.assigned_to or "").strip() or None
    if (me or "").lower() not in ADMIN_EMAILS:
        assign = me
    if not assign:
        assign = me

    seen, rows = set(), []
    for line in (payload.bulk or "").splitlines():
        key = line.strip()
        if len(key) < 15 or key in seen:
            continue
        seen.add(key)
        rows.append({
            "owner_email": me,
            "assigned_to": assign,
            "api_key": key,
            "note": (payload.note or "").strip(),
        })
    if not rows:
        raise HTTPException(status_code=400, detail="Ни одного ключа не распознано")

    # Одной пачкой, а не по ключу за запрос — иначе на двадцати ключах
    # фронт висит двадцать круговых поездок к базе.
    try:
        res = supabase.table("groq_pool").insert(rows).execute()
        added = len(res.data or rows)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"База не приняла: {str(e)[:300]}")
    return {"ok": True, "added": added, "skipped": len(rows) - added}

@app.patch("/api/groq-pool/{key_id}")
def api_groq_pool_patch(key_id: str, payload: GroqPatch, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    res = (supabase.table("groq_pool").select("owner_email,assigned_to")
           .eq("id", key_id).limit(1).execute())
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Ключ не найден")
    is_admin = (me or "").lower() in ADMIN_EMAILS
    if me not in (row.get("owner_email"), row.get("assigned_to")) and not is_admin:
        raise HTTPException(status_code=403, detail="Нет доступа")

    upd = {}
    if payload.note is not None:
        upd["note"] = payload.note.strip()
    if payload.assigned_to is not None and is_admin:
        upd["assigned_to"] = payload.assigned_to.strip() or None
    if not upd:
        return {"ok": True}
    supabase.table("groq_pool").update(upd).eq("id", key_id).execute()
    return {"ok": True}

@app.delete("/api/groq-pool/{key_id}")
def api_groq_pool_delete(key_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    res = (supabase.table("groq_pool").select("owner_email")
           .eq("id", key_id).limit(1).execute())
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Ключ не найден")
    if row.get("owner_email") != me and (me or "").lower() not in ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="Удалять может только владелец")
    supabase.table("groq_pool").delete().eq("id", key_id).execute()
    return {"ok": True}

# ── Прокси-пул: секции для копирования ────────────────────

PROXY_SECTIONS = [
    ("s1", "ДУБЫ — SOCKS5"),
    ("s2", "SOCKS5 МСК"),
    ("s3", "БАНГКОК SOCKS5"),
]

class ProxySectionPut(BaseModel):
    title: str = ""
    body: str = ""

@app.get("/api/proxy-pool")
def api_proxy_pool(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    rows = supabase.table("proxy_pool").select("*").order("sort").execute().data or []
    by_key = {r["section"]: r for r in rows}
    out = []
    for i, (key, default_title) in enumerate(PROXY_SECTIONS):
        r = by_key.get(key) or {}
        out.append({
            "section": key,
            "title": r.get("title") or default_title,
            "body": r.get("body") or "",
            "updated_at": r.get("updated_at"),
        })
    return {"ok": True, "sections": out,
            "can_edit": (me or "").lower() in ADMIN_EMAILS}

@app.put("/api/proxy-pool/{section}")
def api_proxy_pool_put(section: str, payload: ProxySectionPut,
                       authorization: str | None = Header(default=None)):
    session = require_admin(authorization)
    if section not in [k for k, _ in PROXY_SECTIONS]:
        raise HTTPException(status_code=400, detail="Неизвестная секция")
    sort = [k for k, _ in PROXY_SECTIONS].index(section)
    supabase.table("proxy_pool").upsert({
        "owner_email": session["email"],
        "section": section,
        "title": (payload.title or "").strip(),
        "body": payload.body or "",
        "sort": sort,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="owner_email,section").execute()
    return {"ok": True}

# ── Актив: карточки рабочих анкет ─────────────────────────

class AssetCreate(BaseModel):
    platform: str = ""
    title: str = ""
    email: str = ""
    password: str = ""
    phone: str = ""
    telegram: str = ""
    status: str = "not_verif"
    note: str = ""
    assigned_to: str = ""

class AssetPatch(BaseModel):
    platform: Optional[str] = None
    title: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    phone: Optional[str] = None
    telegram: Optional[str] = None
    status: Optional[str] = None
    note: Optional[str] = None
    assigned_to: Optional[str] = None

def _asset_guard(asset_id: str, session: dict) -> dict:
    me = session["email"]
    res = (supabase.table("asset_profiles").select("owner_email,assigned_to")
           .eq("id", asset_id).limit(1).execute())
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Нода не найдена")
    if (me not in (row.get("owner_email"), row.get("assigned_to"))
            and (me or "").lower() not in ADMIN_EMAILS):
        raise HTTPException(status_code=403, detail="Нет доступа")
    return row

@app.get("/api/assets")
def api_assets(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    is_admin = (me or "").lower() in ADMIN_EMAILS

    if is_admin:
        _all = supabase.table("app_users").select("email").execute().data or []
        emails = sorted({u["email"] for u in _all if u.get("email")} | {me})
        rows = (supabase.table("asset_profiles").select("*")
                .order("created_at", desc=True).execute()).data or []
    else:
        emails = get_team_owner_emails(me)
        mine = (supabase.table("asset_profiles").select("*")
                .eq("owner_email", me).execute()).data or []
        given = (supabase.table("asset_profiles").select("*")
                 .eq("assigned_to", me).execute()).data or []
        seen, rows = set(), []
        for r in mine + given:
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            rows.append(r)
        rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)

    return {"ok": True, "assets": rows, "people": emails,
            "names": _plan_names(emails), "me": me, "is_owner": is_admin}

@app.post("/api/assets")
def api_assets_add(payload: AssetCreate, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    assign = (payload.assigned_to or "").strip() or None
    if assign and (me or "").lower() not in ADMIN_EMAILS:
        assign = None
    res = supabase.table("asset_profiles").insert({
        "owner_email": me,
        "assigned_to": assign or me,
        "platform": (payload.platform or "").strip(),
        "title": (payload.title or "").strip(),
        "email": (payload.email or "").strip(),
        "password": payload.password or "",
        "phone": (payload.phone or "").strip(),
        "telegram": (payload.telegram or "").strip(),
        "status": payload.status or "not_verif",
        "note": payload.note or "",
    }).execute()
    return {"ok": True, "asset": (res.data or [None])[0]}

@app.patch("/api/assets/{asset_id}")
def api_assets_patch(asset_id: str, payload: AssetPatch, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _asset_guard(asset_id, session)
    upd = {}
    for f in ("platform", "title", "email", "password", "phone", "telegram",
              "status", "note", "assigned_to"):
        v = getattr(payload, f)
        if v is not None:
            upd[f] = v.strip() if isinstance(v, str) else v
    if not upd:
        return {"ok": True}
    upd["updated_at"] = datetime.now(timezone.utc).isoformat()
    supabase.table("asset_profiles").update(upd).eq("id", asset_id).execute()
    return {"ok": True}

@app.delete("/api/assets/{asset_id}")
def api_assets_delete(asset_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _asset_guard(asset_id, session)
    supabase.table("asset_profiles").delete().eq("id", asset_id).execute()
    return {"ok": True}

# ── Реестр почт ───────────────────────────────────────────

class MailCreate(BaseModel):
    bulk: str = ""                 # построчно: почта[:пароль[:телефон]]
    assigned_to: str = ""
    platform: str = ""             # старое одиночное поле (обратная совместимость)
    platforms: list[str] = []      # новое: галочки — почты уйдут в каждую отмеченную
    status: str = "free"

class MailPatch(BaseModel):
    assigned_to: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    phone: Optional[str] = None
    platform: Optional[str] = None
    status: Optional[str] = None
    note: Optional[str] = None

def _mail_has_team(email: str) -> bool:
    """Есть ли у человека свои сотрудники — он распределяет почты."""
    res = (supabase.table("team_members").select("member_email")
           .eq("owner_email", email).eq("status", "active").limit(1).execute())
    return bool(res.data)

def _mail_guard(mail_id: str, session: dict) -> dict:
    me = session["email"]
    res = (supabase.table("mail_accounts").select("owner_email,assigned_to")
           .eq("id", mail_id).limit(1).execute())
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=403, detail="Нет доступа")
    if (me not in (row.get("owner_email"), row.get("assigned_to"))
            and (me or "").lower() not in ADMIN_EMAILS):
        raise HTTPException(status_code=403, detail="Нет доступа")
    return row

@app.get("/api/mails")
def api_mails(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    is_admin = (me or "").lower() in ADMIN_EMAILS

    if is_admin:
        # Админ раздаёт почты, поэтому видит все и всех пользователей системы
        _all = supabase.table("app_users").select("email").execute().data or []
        emails = sorted({u["email"] for u in _all if u.get("email")} | {me})
        rows = (supabase.table("mail_accounts").select("*")
                .order("created_at", desc=True).execute()).data or []
    else:
        emails = get_team_owner_emails(me)
        # Два простых запроса вместо or_: свои заведённые + выданные лично мне.
        # or_ с почтой в значении PostgREST разбирает неверно.
        mine = (supabase.table("mail_accounts").select("*")
                .eq("owner_email", me).execute()).data or []
        given = (supabase.table("mail_accounts").select("*")
                 .eq("assigned_to", me).execute()).data or []
        seen, rows = set(), []
        for r in mine + given:
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            rows.append(r)
        rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)

    try:
        notes = {(g.get("assigned_to") or ""): (g.get("label") or "")
                 for g in (supabase.table("mail_group_notes").select("*").execute().data or [])}
    except Exception as e:
        print(f"[MAILS] подписи групп не прочитались: {e}", flush=True)
        notes = {}

    print(f"[MAILS] {me}: отдал {len(rows)} строк, админ={is_admin}", flush=True)
    return {
        "ok": True,
        "mails": rows,
        "people": emails,
        "names": _plan_names(emails),
        "me": me,
        "is_owner": is_admin or len(emails) > 1,
        "is_admin": is_admin,
        "group_notes": notes,
    }


class MailGroupNote(BaseModel):
    assigned_to: str = ""
    label: str = ""


@app.post("/api/mail-groups")
def api_mail_group_note(payload: MailGroupNote, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    supabase.table("mail_group_notes").upsert({
        "assigned_to": (payload.assigned_to or "").strip(),
        "label": (payload.label or "").strip(),
        "updated_at": datetime.utcnow().isoformat(),
    }, on_conflict="assigned_to").execute()
    return {"ok": True}

@app.post("/api/mails")
def api_mails_add(payload: MailCreate, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    # Админ выдаёт любому пользователю, остальные — только внутри своей команды
    assign = (payload.assigned_to or "").strip() or None
    if assign and (me or "").lower() not in ADMIN_EMAILS:
        if assign not in get_team_owner_emails(me):
            assign = None
    plats = [p.strip() for p in (payload.platforms or []) if p and p.strip()]
    if not plats:
        plats = [(payload.platform or "").strip()]   # обратная совместимость
    rows, seen = [], set()
    for line in (payload.bulk or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in re.split(r"[:;\t|]| {2,}", line) if p.strip()]
        if not parts:
            continue
        mail = parts[0].lower()
        if "@" not in mail:
            continue
        for plat in plats:
            key = (mail, plat)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "owner_email": me,
                "assigned_to": assign,
                "email": mail,
                "password": parts[1] if len(parts) > 1 else "",
                "phone": parts[2] if len(parts) > 2 else "",
                "platform": plat,
                "status": payload.status or "free",
                "created_by": session["email"],
            })
    if not rows:
        raise HTTPException(status_code=400, detail="Ни одной почты не распознано")
    added, dupes, last_err = 0, [], ""
    for r in rows:                     # по одной, чтобы дубль не рушил всю пачку
        try:
            supabase.table("mail_accounts").insert(r).execute()
            added += 1
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"
            if "duplicate key" in msg or "23505" in msg:
                dupes.append(r["email"])
                print(f"[MAILS] {r['email']} уже заведена — пропускаю", flush=True)
                continue
            last_err = msg
            print(f"[MAILS] {r['email']} не добавлена: {last_err}", flush=True)
    if not added and last_err:
        raise HTTPException(status_code=400, detail=f"База не приняла: {last_err[:300]}")
    if not added and dupes:
        raise HTTPException(
            status_code=400,
            detail=f"Все {len(dupes)} почт уже заведены: " + ", ".join(dupes[:5])
                   + (" и другие" if len(dupes) > 5 else ""))
    return {"ok": True, "added": added, "skipped": len(rows) - added}

def _sync_work_base(mail_id: str, patcher_email: str):
    """Статус почты в «Мои почты» → запись в сменный отчёт (work_base).
    Ключ: кто делал + почта + платформа + день. 'свободна' убирает запись."""
    res = (supabase.table("mail_accounts")
           .select("owner_email, assigned_to, email, password, phone, platform, status")
           .eq("id", mail_id).limit(1).execute())
    m = (res.data or [None])[0]
    if not m:
        return
    email = (m.get("email") or "").strip()
    if not email:
        return
    status = (m.get("status") or "free").strip()
    platform = (m.get("platform") or "").strip()
    author = (m.get("assigned_to") or "").strip() or (patcher_email or "")
    day = datetime.now(KYIV_TZ).strftime("%Y-%m-%d")

    existing = (supabase.table("work_base").select("id")
                .eq("author_email", author).eq("email", email)
                .eq("platform", platform).eq("work_date", day)
                .limit(1).execute().data or [])

    if status == "free":
        if existing:
            supabase.table("work_base").delete().eq("id", existing[0]["id"]).execute()
        return

    data = {
        "owner_email": m.get("owner_email") or patcher_email,
        "author_email": author,
        "work_date": day,
        "email": email,
        "password": m.get("password") or "",
        "phone": m.get("phone") or "",
        "platform": platform,
        "status": status,
    }
    if existing:
        supabase.table("work_base").update(data).eq("id", existing[0]["id"]).execute()
    else:
        supabase.table("work_base").insert(data).execute()


@app.patch("/api/mails/{mail_id}")
def api_mails_patch(mail_id: str, payload: MailPatch, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    row = _mail_guard(mail_id, session)
    # Сотрудник отмечает платформу, статус и заметку. Выдачу и сами данные
    # почты меняет только тот, кто её завёл.
    fields = ("assigned_to", "email", "password", "phone", "platform", "status", "note")
    if (row.get("owner_email") != session["email"]
            and (session["email"] or "").lower() not in ADMIN_EMAILS):
        fields = ("platform", "status", "note")
    upd = {}
    for f in fields:
        v = getattr(payload, f)
        if v is not None:
            upd[f] = v.strip() if isinstance(v, str) else v
    if not upd:
        return {"ok": True}
    upd["updated_at"] = datetime.now(timezone.utc).isoformat()
    supabase.table("mail_accounts").update(upd).eq("id", mail_id).execute()
    if "status" in upd:
        try:
            _sync_work_base(mail_id, session["email"])
        except Exception as e:
            print(f"[WORK_BASE SYNC] {mail_id}: {e}", flush=True)
    return {"ok": True}

@app.delete("/api/mails/{mail_id}")
def api_mails_delete(mail_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    row = _mail_guard(mail_id, session)
    if row.get("owner_email") != session["email"]:
        raise HTTPException(status_code=403, detail="Удалять может только владелец почты")
    supabase.table("mail_accounts").delete().eq("id", mail_id).execute()
    return {"ok": True}

# ── Командный чат ─────────────────────────────────────────

class ChatRoomCreate(BaseModel):
    kind: str = "group"
    title: str = ""
    members: list[str] = []

class ChatMessageCreate(BaseModel):
    body: str = ""
    attachments: list[dict] = []

class ChatUpload(BaseModel):
    name: str
    mime: str = "application/octet-stream"
    data: str  # base64 без префикса data:

CHAT_BUCKET = "chat-files"
CHAT_MAX_FILE = 10 * 1024 * 1024

def _chat_guard(room_id: str, session: dict):
    """В комнату пускаем только её участников."""
    res = (supabase.table("chat_room_members").select("member_email")
           .eq("room_id", room_id).eq("member_email", session["email"]).execute())
    if not (res.data or []):
        raise HTTPException(status_code=404, detail="Чат не найден")

@app.get("/api/chat/rooms")
def api_chat_rooms(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]

    mine = supabase.table("chat_room_members").select("room_id, last_read_at").eq("member_email", me).execute()
    room_ids = [r["room_id"] for r in (mine.data or [])]
    if not room_ids:
        return {"ok": True, "rooms": [], "me": me}
    read_map = {r["room_id"]: r.get("last_read_at") for r in (mine.data or [])}

    rooms_res = supabase.table("chat_rooms").select("*").in_("id", room_ids).order("last_at", desc=True).execute()
    rooms = rooms_res.data or []

    members_res = supabase.table("chat_room_members").select("room_id, member_email").in_("room_id", room_ids).execute()
    by_room = {}
    for row in members_res.data or []:
        by_room.setdefault(row["room_id"], []).append(row["member_email"])

    all_emails = sorted({e for lst in by_room.values() for e in lst})
    names = _plan_names(all_emails) if all_emails else {}

    msgs_res = (supabase.table("chat_messages").select("room_id, body, author_email, created_at")
                .in_("room_id", room_ids).order("created_at", desc=True).limit(400).execute())
    last_msg, unread = {}, {}
    for m in msgs_res.data or []:
        rid = m["room_id"]
        if rid not in last_msg:
            last_msg[rid] = m
        seen = read_map.get(rid)
        if m["author_email"] != me and (not seen or m["created_at"] > seen):
            unread[rid] = unread.get(rid, 0) + 1

    for r in rooms:
        rid = r["id"]
        r["members"] = by_room.get(rid, [])
        r["member_names"] = [names.get(e, e.split("@")[0]) for e in r["members"]]
        r["unread"] = unread.get(rid, 0)
        lm = last_msg.get(rid)
        r["last_body"] = (lm or {}).get("body", "") or ("📎 Вложение" if lm else "")
        r["last_author"] = names.get((lm or {}).get("author_email", ""), "")
        if r.get("kind") == "dm":
            other = next((e for e in r["members"] if e != me), me)
            r["title"] = names.get(other, other.split("@")[0])

    return {"ok": True, "rooms": rooms, "me": me, "names": names}

@app.post("/api/chat/rooms")
def api_chat_room_create(payload: ChatRoomCreate, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    me = session["email"]
    members = {e.strip().lower() for e in (payload.members or []) if e.strip()}
    if members:
        known = supabase.table("app_users").select("email").in_("email", list(members)).execute()
        members = {r["email"] for r in (known.data or [])}
    members.add(me)

    kind = "dm" if payload.kind == "dm" else "group"
    if kind == "dm":
        if len(members) != 2:
            raise HTTPException(status_code=400, detail="Для личного чата нужен ровно один собеседник")
        # Ищем уже существующий диалог с этим человеком
        mine = supabase.table("chat_room_members").select("room_id").eq("member_email", me).execute()
        ids = [r["room_id"] for r in (mine.data or [])]
        if ids:
            dms = supabase.table("chat_rooms").select("id").in_("id", ids).eq("kind", "dm").execute()
            dm_ids = [r["id"] for r in (dms.data or [])]
            if dm_ids:
                other = next(e for e in members if e != me)
                hit = (supabase.table("chat_room_members").select("room_id")
                       .in_("room_id", dm_ids).eq("member_email", other).execute())
                if hit.data:
                    return {"ok": True, "room_id": hit.data[0]["room_id"], "existed": True}
    else:
        if not (payload.title or "").strip():
            raise HTTPException(status_code=400, detail="У группы должно быть название")

    room = supabase.table("chat_rooms").insert({
        "owner_email": me,
        "kind": kind,
        "title": (payload.title or "").strip(),
        "created_by": me,
    }).execute().data[0]

    supabase.table("chat_room_members").insert(
        [{"room_id": room["id"], "member_email": e} for e in members]
    ).execute()
    return {"ok": True, "room_id": room["id"], "existed": False}

@app.get("/api/chat/rooms/{room_id}/messages")
def api_chat_messages(room_id: str, after: str = "", authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _chat_guard(room_id, session)
    q = supabase.table("chat_messages").select("*").eq("room_id", room_id)
    if after:
        q = q.gt("created_at", after)
    res = q.order("created_at", desc=True).limit(300).execute()
    rows = list(reversed(res.data or []))
    names = _plan_names(list({r["author_email"] for r in rows})) if rows else {}
    for r in rows:
        r["author_name"] = names.get(r["author_email"], r["author_email"].split("@")[0])
    mem = (supabase.table("chat_room_members").select("member_email, last_read_at")
           .eq("room_id", room_id).execute())
    reads = [m.get("last_read_at") for m in (mem.data or [])
             if m["member_email"] != session["email"] and m.get("last_read_at")]
    return {"ok": True, "messages": rows, "me": session["email"], "reads": reads}

@app.post("/api/chat/rooms/{room_id}/messages")
def api_chat_send(room_id: str, payload: ChatMessageCreate, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _chat_guard(room_id, session)
    body = (payload.body or "").strip()
    files = []
    for a in (payload.attachments or [])[:10]:
        p = str(a.get("path") or "")
        if not p.startswith(f"{room_id}/") or ".." in p:
            continue
        files.append({
            "path": p,
            "url": supabase.storage.from_(CHAT_BUCKET).get_public_url(p),
            "name": str(a.get("name") or "file")[:120],
            "mime": str(a.get("mime") or "")[:100],
            "size": int(a.get("size") or 0),
        })
    if not body and not files:
        raise HTTPException(status_code=400, detail="Пустое сообщение")
    now = datetime.now(timezone.utc).isoformat()
    msg = supabase.table("chat_messages").insert({
        "room_id": room_id, "author_email": session["email"], "body": body,
        "attachments": files,
    }).execute().data[0]
    supabase.table("chat_rooms").update({"last_at": now}).eq("id", room_id).execute()
    supabase.table("chat_room_members").update({"last_read_at": now}) \
        .eq("room_id", room_id).eq("member_email", session["email"]).execute()
    return {"ok": True, "message": msg}

@app.post("/api/chat/rooms/{room_id}/upload")
def api_chat_upload(room_id: str, payload: ChatUpload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _chat_guard(room_id, session)
    import base64
    try:
        raw = base64.b64decode(payload.data, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Битый файл")
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл")
    if len(raw) > CHAT_MAX_FILE:
        raise HTTPException(status_code=400, detail="Файл больше 10 МБ")
    name = Path(payload.name or "file").name[:120] or "file"
    ext = Path(name).suffix.lower()[:10]
    path = f"{room_id}/{uuid.uuid4().hex}{ext}"
    mime = (payload.mime or "application/octet-stream")[:100]
    try:
        supabase.storage.from_(CHAT_BUCKET).upload(path, raw, {"content-type": mime})
    except Exception as e:
        print(f"[CHAT] upload упал: {e}", flush=True)
        raise HTTPException(status_code=500, detail="Не удалось загрузить файл")
    return {"ok": True, "file": {"path": path, "name": name, "mime": mime, "size": len(raw)}}

@app.post("/api/chat/rooms/{room_id}/read")
def api_chat_read(room_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _chat_guard(room_id, session)
    supabase.table("chat_room_members").update({"last_read_at": datetime.now(timezone.utc).isoformat()}) \
        .eq("room_id", room_id).eq("member_email", session["email"]).execute()
    return {"ok": True}

class ChatMembersAdd(BaseModel):
    members: list[str] = []

@app.get("/api/chat/people")
def api_chat_people(authorization: str | None = Header(default=None)):
    """Все зарегистрированные на сайте — для создания групп и личных чатов."""
    session = require_auth(authorization)
    res = supabase.table("app_users").select("email, username").execute()
    names = {
        r["email"]: (r.get("username") or "").strip() or r["email"].split("@")[0]
        for r in (res.data or [])
    }
    return {"ok": True, "people": sorted(names), "names": names, "me": session["email"]}


@app.get("/api/chat/search-users")
def api_chat_search_users(q: str = "", authorization: str | None = Header(default=None)):
    """Поиск по всем зарегистрированным — чтобы добавлять в чат без отдельного приглашения."""
    session = require_auth(authorization)
    term = (q or "").strip().lower().replace(",", " ")
    if len(term) < 2:
        return {"ok": True, "users": []}
    try:
        res = supabase.table("app_users").select("email, username").or_(f"email.ilike.%{term}%,username.ilike.%{term}%").limit(10).execute()
        rows = res.data or []
    except Exception as e:
        print(f"[CHAT] поиск юзеров упал: {e}", flush=True)
        rows = []
    out = [{
        "email": r["email"],
        "name": (r.get("username") or "").strip() or r["email"].split("@")[0],
    } for r in rows if r["email"] != session["email"]]
    return {"ok": True, "users": out}

@app.post("/api/chat/rooms/{room_id}/members")
def api_chat_members_add(room_id: str, payload: ChatMembersAdd, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _chat_guard(room_id, session)
    room = supabase.table("chat_rooms").select("kind").eq("id", room_id).execute()
    if not room.data:
        raise HTTPException(status_code=404, detail="Чат не найден")
    if room.data[0]["kind"] == "dm":
        raise HTTPException(status_code=400, detail="В личный чат нельзя добавить людей")
    add = {e.strip().lower() for e in (payload.members or []) if e.strip()}
    if add:
        known = supabase.table("app_users").select("email").in_("email", list(add)).execute()
        add = {r["email"] for r in (known.data or [])}
    if not add:
        raise HTTPException(status_code=400, detail="Такой пользователь не зарегистрирован")
    have = supabase.table("chat_room_members").select("member_email").eq("room_id", room_id).execute()
    exists = {r["member_email"] for r in (have.data or [])}
    new = [e for e in add if e not in exists]
    if new:
        supabase.table("chat_room_members").insert(
            [{"room_id": room_id, "member_email": e} for e in new]
        ).execute()
    return {"ok": True, "added": len(new)}

@app.delete("/api/chat/rooms/{room_id}")
def api_chat_room_delete(room_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    _chat_guard(room_id, session)
    room = supabase.table("chat_rooms").select("created_by").eq("id", room_id).execute()
    if not room.data:
        raise HTTPException(status_code=404, detail="Чат не найден")
    if room.data[0]["created_by"] != session["email"]:
        # не создатель — просто выходим из чата
        supabase.table("chat_room_members").delete() \
            .eq("room_id", room_id).eq("member_email", session["email"]).execute()
        return {"ok": True, "left": True}
    supabase.table("chat_rooms").delete().eq("id", room_id).execute()
    return {"ok": True, "left": False}

# ── Tabs ──────────────────────────────────────────────────

# ── Ноды прокси на канвасе ────────────────────────────────

@app.get("/api/proxy-nodes")
def api_get_proxy_nodes(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    res = supabase.table("proxy_nodes").select("*").in_("owner_email", owner_emails).execute()
    return {"ok": True, "nodes": res.data or []}


@app.post("/api/proxy-nodes")
def api_save_proxy_node(payload: ProxyNodePayload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    row = {
        "id": payload.id,
        "owner_email": session["email"],
        "platform": payload.platform or "Mamba",
        "protocol": payload.protocol or "http",
        "host": (payload.host or "").strip(),
        "port": str(payload.port or "").strip(),
        "login": payload.login or "",
        "password": payload.password or "",
        "user_agent": (payload.user_agent or "").strip(),
        "x": float(payload.x or 0),
        "y": float(payload.y or 0),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    supabase.table("proxy_nodes").upsert(row, on_conflict="id").execute()
    return {"ok": True, "node": row}


@app.delete("/api/proxy-nodes/{node_id}")
def api_delete_proxy_node(node_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    supabase.table("proxy_nodes").delete().eq("id", node_id).in_("owner_email", owner_emails).execute()
    return {"ok": True}


@app.get("/api/tabs")
def api_get_tabs(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    res = supabase.table("operator_tabs").select("*").in_("owner_email", owner_emails).order("sort_order", desc=False).execute()
    tabs = res.data or []
    tab_ids = [t["id"] for t in tabs]
    tags_by_tab = {}
    if tab_ids:
        tags_res = supabase.table("account_tabs").select("*").in_("tab_id", tab_ids).execute()
        for row in tags_res.data or []:
            tags_by_tab.setdefault(row["tab_id"], []).append(row["account_id"])
    for t in tabs:
        t["account_ids"] = tags_by_tab.get(t["id"], [])
    return {"ok": True, "tabs": tabs}

@app.post("/api/tabs")
def api_create_tab(payload: CreateTabRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Название вкладки не может быть пустым")
    count_res = supabase.table("operator_tabs").select("id").eq("owner_email", session["email"]).execute()
    res = supabase.table("operator_tabs").insert({"owner_email": session["email"], "name": name, "platform": payload.platform or "Mamba", "sort_order": len(count_res.data or [])}).execute()
    return {"ok": True, "tab": res.data[0]}

@app.delete("/api/tabs/{tab_id}")
def api_delete_tab(tab_id: str):
    supabase.table("operator_tabs").delete().eq("id", tab_id).execute()
    return {"ok": True}

@app.post("/api/tabs/assign")
def api_assign_tab(payload: AssignTabRequest):
    supabase.table("account_tabs").upsert({"account_id": payload.account_id, "tab_id": payload.tab_id}).execute()
    return {"ok": True}

@app.post("/api/tabs/unassign")
def api_unassign_tab(payload: AssignTabRequest):
    supabase.table("account_tabs").delete().eq("account_id", payload.account_id).eq("tab_id", payload.tab_id).execute()
    return {"ok": True}

# ── Split logs ────────────────────────────────────────────

@app.post("/api/split-log/push")
def api_split_log_push(payload: SplitLogPushRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    if not payload.messages:
        return {"ok": True}
    rows = [{"owner_email": session["email"], "account_id": payload.account_id, "message": msg} for msg in payload.messages if msg]
    supabase.table("split_logs").insert(rows).execute()
    return {"ok": True, "saved": len(rows)}

@app.get("/api/split-log/{account_id}")
def api_split_log_get(account_id: str, after_id: int = 0, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    _own = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).execute()
    if not (_own.data or []):
        return {"ok": True, "logs": [], "last_id": after_id}
    if after_id > 0:
        query = supabase.table("split_logs").select("id, message, created_at").eq("account_id", account_id).gt("id", after_id).order("id", desc=False)
    else:
        query = supabase.table("split_logs").select("id, message, created_at").eq("account_id", account_id).order("id", desc=True).limit(200)
    res = query.execute()
    rows = res.data or []
    if after_id == 0:
        rows = list(reversed(rows))
    return {"ok": True, "logs": rows, "last_id": rows[-1]["id"] if rows else after_id}

# ── Proxy settings ────────────────────────────────────────

@app.get("/api/proxy-settings")
async def get_proxy_settings(authorization: str = Header(None)):
    require_admin(authorization)
    try:
        res = supabase.table("proxy_settings").select("*").execute()
        return res.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/proxy-settings")
async def save_proxy_settings(body: ProxySettingsModel, authorization: str = Header(None)):
    require_admin(authorization)
    try:
        supabase.table("proxy_settings").upsert({
            "id": body.id, "host": body.host, "port": body.port,
            "username": body.username, "password": body.password,
            "use_proxy": body.use_proxy, "user_agent": body.user_agent,
            "updated_at": datetime.utcnow().isoformat(),
        }, on_conflict="id").execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Промты платформ ───────────────────────────────────────

class PlatformPromptModel(BaseModel):
    platform: str
    prompt: str = ""
    blocks: dict = {}

@app.get("/api/platform-prompts")
async def get_platform_prompts(authorization: str = Header(None)):
    session = require_auth(authorization)
    try:
        res = (supabase.table("platform_prompts").select("*")
               .eq("owner_email", session["email"]).execute())
        return res.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/platform-prompts")
async def save_platform_prompt(body: PlatformPromptModel, authorization: str = Header(None)):
    session = require_auth(authorization)
    owner = session["email"]
    platform = body.platform.lower().strip()
    row = {
        "owner_email": owner,
        "platform": platform,
        "prompt": body.prompt,
        "blocks": body.blocks or {},
        "updated_at": datetime.utcnow().isoformat(),
    }
    try:
        existing = (supabase.table("platform_prompts").select("platform")
                    .eq("owner_email", owner).eq("platform", platform)
                    .limit(1).execute())
        if existing.data:
            (supabase.table("platform_prompts").update(row)
             .eq("owner_email", owner).eq("platform", platform).execute())
        else:
            supabase.table("platform_prompts").insert(row).execute()
        return {"ok": True}
    except Exception as e:
        print(f"[PROMPTS] сохранение упало: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e))

# ── Proxy image ───────────────────────────────────────────

# Куда вообще можно ходить за картинками. Всё остальное — отказ:
# иначе эндпоинт работает открытым прокси на весь интернет.
PROXY_IMAGE_HOSTS = (
    "amazonaws.com", "lovelaz.ru", "lovelaz.online",
    "vznakomstve.com", "wcase.net", "mamba.ru",
    "twinby.ru", "atolin.ru", "badanga.ru",
    # Картинки Баданги лежат не на витрине, а на CDN проекта
    "sugrush.com",
)

@app.get("/api/proxy-image")
async def proxy_image(url: str, account_id: str = ""):
    # Без require_auth намеренно: картинки грузит тег <img>, а он не умеет
    # слать заголовок Authorization. От чужих запросов защищает белый
    # список доменов ниже — открытым прокси эндпоинт уже не работает.
    from fastapi.responses import Response
    from urllib.parse import urlparse as _urlparse
    _host = (_urlparse(url).hostname or "").lower()
    if not any(_host == h or _host.endswith("." + h) for h in PROXY_IMAGE_HOSTS):
        raise HTTPException(status_code=400, detail="Домен не разрешён")
    try:
        headers = {"User-Agent": "InDating v3.2.6 (302060), Android 9, A5010", "Referer": "https://vznakomstve.com/"}
        if "lovelaz." in url:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                "Referer": "https://lovelaz.ru/",
                "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
            }
        elif "sugrush.com" in url or "badanga.ru" in url:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
                "Referer": "https://www.badanga.ru/",
                "Origin": "https://www.badanga.ru",
                "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
            }
        # Раньше был поиск подстроки: ссылка вида
        # https://чужой-сервер/?x=amazonaws.com проходила проверку,
        # и x_token анкеты уезжал этому серверу заголовком.
        if (_host == "amazonaws.com" or _host.endswith(".amazonaws.com")) and account_id:
            try:
                res = await asyncio.to_thread(
                    lambda: supabase.table("accounts_private")
                    .select("cookies_raw").eq("id", account_id).execute()
                )
                if res.data:
                    raw = res.data[0].get("cookies_raw", "")
                    cookies_list = json.loads(raw)
                    for c in cookies_list:
                        if c.get("name") == "x_token":
                            headers["x-token"] = c["value"]
                            break
            except Exception:
                pass

        candidates = [url]
        if "//lovelaz.online/" in url:
            candidates.append(url.replace("//lovelaz.online/", "//api.lovelaz.online/"))
            candidates.append(url.replace("//lovelaz.online/", "//api.lovelaz.ru/"))
        elif "//lovelaz.ru/" in url:
            candidates.append(url.replace("//lovelaz.ru/", "//api.lovelaz.ru/"))
            candidates.append(url.replace("//lovelaz.ru/", "//api.lovelaz.online/"))
        elif "//api.lovelaz.online/" in url:
            candidates.append(url.replace("//api.lovelaz.online/", "//api.lovelaz.ru/"))

        last_info = ""
        async with IMAGE_SEMAPHORE:
            for candidate in candidates:
                r = await HTTP_CLIENT.get(candidate, headers=headers, follow_redirects=True)
                ctype = r.headers.get("content-type", "")
                if r.status_code == 200 and ctype.startswith("image"):
                    return Response(content=r.content, media_type=ctype)
                last_info = f"{candidate} → status={r.status_code} type={ctype} body={r.text[:200]!r}"
                print(f"[PROXY-IMAGE] не картинка: {last_info}", flush=True)

        raise HTTPException(status_code=502, detail=f"Не картинка: {last_info}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

# ── Analytics cards ──────────────────────────────────────

class AnalyticsCardPayload(BaseModel):
    account_id: Optional[str] = None
    owner_email: Optional[str] = None
    platform: Optional[str] = None
    bot_name: str = ""
    bot_age: str = ""
    bot_gender: str = "female"
    location: str = ""
    persona: str = ""
    goal: str = ""
    stop_topics: str = ""
    contacts: str = ""
    contacts_trigger: str = ""

@app.get("/api/analytics-cards")
def api_get_analytics_cards(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])
    accounts_res = supabase.table("accounts").select("id").in_("owner_email", owner_emails).execute()
    account_ids = [a["id"] for a in (accounts_res.data or []) if a.get("id")]
    cards_res = supabase.table("analytics_cards").select("*").in_("owner_email", owner_emails).execute()
    null_cards = [c for c in (cards_res.data or []) if c.get("account_id") is None]
    if account_ids:
        account_cards = supabase.table("analytics_cards").select("*").in_("account_id", account_ids).execute()
        all_cards = (account_cards.data or []) + null_cards
    else:
        all_cards = null_cards
    cards_res_data = all_cards
    # Раньше был select("*") — тянул ключи, прокси-пароли и все промпты
    # по всем анкетам каждые 20 секунд. Берём только то, что реально рисуется.
    _settings_cols = ("account_id, bot_name, bot_age, bot_gender, location, "
                      "persona, goal, stop_topics, contacts, contacts_trigger")
    settings_res = supabase.table("ai_settings").select(_settings_cols).in_("account_id", account_ids).execute() if account_ids else type('obj', (object,), {'data': []})()
    settings_by_account = {s.get("account_id"): s for s in (settings_res.data or [])}
    result = []
    for card in cards_res_data:
        account_id = card.get("account_id", "")
        settings = settings_by_account.get(account_id) or {}
        result.append({
            "id": card.get("id", ""),
            "account_id": account_id,
            "platform": card.get("platform") or "Mamba",
            "bot_name": card.get("bot_name") or settings.get("bot_name") or "",
            "bot_age": card.get("bot_age") or settings.get("bot_age") or "",
            "bot_gender": card.get("bot_gender") or settings.get("bot_gender") or "female",
            "location": card.get("location") or settings.get("location") or "",
            "persona": card.get("persona") or settings.get("persona") or "",
            "goal": card.get("goal") or settings.get("goal") or "",
            "stop_topics": card.get("stop_topics") or settings.get("stop_topics") or "",
            "contacts": card.get("contacts") or settings.get("contacts") or "",
            "contacts_trigger": card.get("contacts_trigger") or settings.get("contacts_trigger") or "",
        })
    return {"ok": True, "cards": result}

@app.post("/api/analytics-cards")
def api_save_analytics_card(payload: AnalyticsCardPayload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    data = payload.model_dump()
    data["id"] = str(uuid.uuid4())
    data["owner_email"] = session["email"]
    supabase.table("analytics_cards").insert(data).execute()
    return {"ok": True, "card": data}

@app.patch("/api/analytics-cards/{card_id}")
def api_update_analytics_card(card_id: str, payload: AnalyticsCardPayload):
    data = {k: v for k, v in payload.model_dump().items() if v is not None}
    supabase.table("analytics_cards").update(data).eq("id", card_id).execute()
    return {"ok": True}

@app.delete("/api/analytics-cards/{card_id}")
def api_delete_analytics_card(card_id: str):
    supabase.table("analytics_cards").delete().eq("id", card_id).execute()
    return {"ok": True}

# ── Jobs ──────────────────────────────────────────────────

@app.get("/api/jobs/{job_id}")
def api_get_job(job_id: str):
    if not job_id or job_id == "undefined":
        return {"ok": False, "job": None}
    res = supabase.table("job_queue").select("*").eq("id", job_id).execute()
    if not res.data:
        return {"ok": False, "job": None}
    return {"ok": True, "job": res.data[0]}

@app.get("/api/jobs/account/{account_id}/active")
def api_get_active_job(account_id: str):
    res = supabase.table("job_queue").select("*").eq("account_id", account_id).in_("status", ["pending", "running"]).order("created_at", desc=True).limit(1).execute()
    return {"ok": True, "job": res.data[0] if res.data else None}


# ── Chats ─────────────────────────────────────────────────

class SendChatMessageRequest(BaseModel):
    account_id: str
    href: str
    message: str

@app.post("/api/chats/send")
async def api_send_chat_message(payload: SendChatMessageRequest, authorization: str | None = Header(default=None)):
    return await proxy_to_worker("mamba", "/api/chats/send", payload.model_dump(), authorization)

@app.get("/api/chats/{account_id}")
async def api_get_chats(account_id: str):
    return {"ok": True, "chats": []}

# ── Sheet ─────────────────────────────────────────────────

class SheetCellPayload(BaseModel):
    sheet_id: str
    cells: list[dict]

class CheckKeysRequest(BaseModel):
    keys: list[str]

@app.post("/api/sheet/save")
def api_sheet_save(payload: SheetCellPayload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    email = session["email"]
    if not payload.cells:
        return {"ok": True}
    rows = []
    for c in payload.cells:
        row = {"owner_email": email, "sheet_id": payload.sheet_id, "row_idx": int(c.get("row", 0)), "col_idx": int(c.get("col", 0)), "value": c.get("value", "")}
        if c.get("assigned_account_id"):
            row["assigned_account_id"] = c.get("assigned_account_id")
        rows.append(row)
    empty_rows = [r for r in rows if not r.get("value")]
    save_rows = [r for r in rows if r.get("value")]
    for er in empty_rows:
        supabase.table("sheet_cells").delete().eq("owner_email", email).eq("sheet_id", payload.sheet_id).eq("row_idx", er["row_idx"]).eq("col_idx", er["col_idx"]).execute()
    if save_rows:
        supabase.table("sheet_cells").upsert(save_rows, on_conflict="owner_email,sheet_id,row_idx,col_idx").execute()
    return {"ok": True, "saved": len(save_rows)}

@app.get("/api/sheet/load")
def api_sheet_load(sheet_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    res = supabase.table("sheet_cells").select("*").eq("owner_email", session["email"]).eq("sheet_id", sheet_id).execute()
    return {"ok": True, "cells": res.data or []}

@app.post("/api/sheet/check-keys")
def api_check_keys(payload: CheckKeysRequest, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    from shared import call_groq, is_key_exhausted
    results = {}
    for key in payload.keys:
        key = key.strip()
        if not key:
            continue
        try:
            call_groq(key, "openai/gpt-oss-120b", "test", [{"role": "user", "content": "1"}])
            results[key] = "ok"
        except RuntimeError as e:
            results[key] = "exhausted" if is_key_exhausted(str(e)) else "error"
        except Exception:
            results[key] = "error"
    return {"ok": True, "results": results}

# ── Report ────────────────────────────────────────────────

class ReportTgAccountRequest(BaseModel):
    tg_username: str
    label: str = ""

class ReportEntryRequest(BaseModel):
    tg_account: str
    date: str
    visits: int = 0
    bookings: int = 0
    cancels: int = 0
    notes: str = ""

@app.get("/api/report/tg-accounts")
def api_report_tg_accounts_get(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    res = supabase.table("report_tg_accounts").select("*").eq("owner_email", session["email"]).order("created_at").execute()
    return {"ok": True, "accounts": res.data or []}

@app.post("/api/report/tg-accounts")
def api_report_tg_accounts_post(payload: ReportTgAccountRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    username = payload.tg_username.lstrip("@").strip()
    if not username:
        raise HTTPException(status_code=400, detail="tg_username обязателен")
    try:
        res = supabase.table("report_tg_accounts").insert({"owner_email": session["email"], "tg_username": username, "label": payload.label}).execute()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "account": res.data[0] if res.data else {}}

@app.delete("/api/report/tg-accounts/{account_id}")
def api_report_tg_accounts_delete(account_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    supabase.table("report_tg_accounts").delete().eq("id", account_id).eq("owner_email", session["email"]).execute()
    return {"ok": True}

@app.get("/api/report/entries")
def api_report_entries_get(month: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    try:
        year, mon = month.split("-")
        date_from = f"{year}-{mon}-01"
        next_mon = int(mon) + 1
        next_year = int(year)
        if next_mon > 12:
            next_mon = 1
            next_year += 1
        date_to = f"{next_year}-{next_mon:02d}-01"
    except Exception:
        raise HTTPException(status_code=400, detail="month должен быть в формате YYYY-MM")
    res = supabase.table("report_entries").select("*").eq("owner_email", session["email"]).gte("date", date_from).lt("date", date_to).order("date").execute()
    return {"ok": True, "entries": res.data or []}

@app.post("/api/report/entries")
def api_report_entries_post(payload: ReportEntryRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    try:
        res = supabase.table("report_entries").upsert({"owner_email": session["email"], "tg_account": payload.tg_account, "date": payload.date, "visits": payload.visits, "bookings": payload.bookings, "cancels": payload.cancels, "notes": payload.notes, "updated_at": datetime.utcnow().isoformat()}, on_conflict="owner_email,tg_account,date").execute()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "entry": res.data[0] if res.data else {}}

@app.get("/api/report/summary")
def api_report_summary(month: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    try:
        year, mon = month.split("-")
        date_from = f"{year}-{mon}-01"
        next_mon = int(mon) + 1
        next_year = int(year)
        if next_mon > 12:
            next_mon = 1
            next_year += 1
        date_to = f"{next_year}-{next_mon:02d}-01"
    except Exception:
        raise HTTPException(status_code=400, detail="month должен быть в формате YYYY-MM")
    tg_res = supabase.table("report_tg_accounts").select("*").eq("owner_email", session["email"]).execute()
    entries_res = supabase.table("report_entries").select("*").eq("owner_email", session["email"]).gte("date", date_from).lt("date", date_to).execute()
    entries_map = {(e["tg_account"], e["date"]): e for e in (entries_res.data or [])}
    from datetime import date as dt_date, timedelta
    start = dt_date(int(year), int(mon), 1)
    days = []
    cur = start
    while cur.month == start.month:
        days.append(cur.isoformat())
        cur += timedelta(days=1)
    rows = []
    for day in days:
        for acc in (tg_res.data or []):
            username = acc["tg_username"].lstrip("@").lower()
            entry = entries_map.get((acc["tg_username"], day), entries_map.get((username, day), {}))
            rows.append({"date": day, "tg_account": acc["tg_username"], "label": acc.get("label", ""), "leads": 0, "visits": entry.get("visits", 0) or 0, "bookings": entry.get("bookings", 0) or 0, "cancels": entry.get("cancels", 0) or 0, "conversion": 0.0})
    return {"ok": True, "rows": rows, "month": month}


class IntCitySplitRequest(BaseModel):
    account_id: str
    pages: int = 3
    subject: str = ""
    body: str = ""
    mail_cookie: str = ""
    mail_token: str = ""

@app.post("/api/tasks/intcity-split")
async def intcity_split_task(payload: IntCitySplitRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    # Сохраняем subject/body в ai_settings
    existing = supabase.table("ai_settings").select("account_id").eq("account_id", payload.account_id).execute()
    settings_data = {
        "goal": payload.subject,
        "persona": payload.body,
        "bot_age": str(payload.pages),
    }
    if payload.mail_cookie:
        settings_data["gemini_api_keys"] = payload.mail_cookie
    if payload.mail_token:
        settings_data["stop_topics"] = payload.mail_token
    try:
        if existing.data:
            supabase.table("ai_settings").update(settings_data).eq("account_id", payload.account_id).execute()
        else:
            settings_data["account_id"] = payload.account_id
            supabase.table("ai_settings").insert(settings_data).execute()
    except Exception as e:
        print(f"[intCity] ai_settings save error: {e}", flush=True)
    # Создаём задачу в job_queue
    job = {
        "account_id": payload.account_id,
        "platform": "intCity",
        "type": "intcity-split",
        "status": "pending",
        "payload": {"pages": payload.pages},
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }
    supabase.table("job_queue").insert(job).execute()
    return {"ok": True, "summary": "Задача создана"}

# ── intCity: парсер и рассылка ────────────────────────────

import re as _re
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

class IntCityParseRequest(BaseModel):
    account_id: str
    pages: int = 3

class IntCitySendRequest(BaseModel):
    account_id: str
    subject: str
    body: str
    limit: int = 50

@app.post("/api/intcity/parse")
async def intcity_parse(payload: IntCityParseRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    priv = supabase.table("accounts_private").select("cookies_raw").eq("id", payload.account_id).execute()
    if not priv.data:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")
    owner_email = session["email"]

    BASE_URL = "https://a.intimcity.co"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ru-RU,ru;q=0.9",
    }

    found_emails = []
    errors = []
    ad_urls = []

    async with httpx.AsyncClient(headers=headers, timeout=20, follow_redirects=True) as client:
        for page in range(1, payload.pages + 1):
            try:
                url = f"{BASE_URL}/bullboard?gender_from=m&gender_to=f&place=&page={page}"
                resp = await client.get(url)
                links = _re.findall(r'href="(/bullboard/\d+)"', resp.text)
                for link in links:
                    full = BASE_URL + link
                    if full not in ad_urls:
                        ad_urls.append(full)
            except Exception as e:
                errors.append(f"Страница {page}: {e}")

        for ad_url in ad_urls:
            try:
                resp = await client.get(ad_url)
                emails = _re.findall(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+', resp.text)
                emails = [e for e in emails if not any(x in e for x in ["intimcity", "example", "test"])]
                for email in set(emails):
                    found_emails.append({"email": email, "ad_url": ad_url})
            except Exception as e:
                errors.append(f"{ad_url}: {e}")

    saved = 0
    for item in found_emails:
        try:
            supabase.table("intcity_leads").upsert({
                "email": item["email"],
                "ad_url": item["ad_url"],
                "owner_email": owner_email,
            }, on_conflict="email").execute()
            saved += 1
        except Exception:
            pass

    return {
        "ok": True,
        "found": len(found_emails),
        "saved": saved,
        "ads_parsed": len(ad_urls),
        "errors": errors[:10],
        "summary": f"Найдено {len(found_emails)} email, сохранено {saved}, объявлений: {len(ad_urls)}"
    }


@app.get("/api/intcity/leads")
async def intcity_leads(account_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    res = supabase.table("intcity_leads").select("*").eq("owner_email", session["email"]).order("created_at", desc=True).limit(500).execute()
    return {"ok": True, "leads": res.data or []}


@app.post("/api/intcity/send")
async def intcity_send(payload: IntCitySendRequest, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    priv = supabase.table("accounts_private").select("cookies_raw").eq("id", payload.account_id).execute()
    if not priv.data:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")
    creds = json.loads(priv.data[0]["cookies_raw"])
    sender_email = creds["email"]
    sender_password = creds["password"]

    res = supabase.table("intcity_leads").select("*").eq("owner_email", session["email"]).is_("sent_at", "null").limit(payload.limit).execute()
    leads = res.data or []

    if not leads:
        return {"ok": True, "sent": 0, "summary": "Нет новых лидов для рассылки"}

    sent = 0
    errors = []

    try:
        smtp = smtplib.SMTP_SSL("smtp.mail.ru", 465)
        smtp.login(sender_email, sender_password)
        for lead in leads:
            try:
                msg = MIMEMultipart()
                msg["From"] = sender_email
                msg["To"] = lead["email"]
                msg["Subject"] = payload.subject
                msg.attach(MIMEText(payload.body, "plain", "utf-8"))
                smtp.sendmail(sender_email, lead["email"], msg.as_string())
                supabase.table("intcity_leads").update({
                    "sent_at": datetime.now().isoformat()
                }).eq("id", lead["id"]).execute()
                sent += 1
            except Exception as e:
                errors.append(f"{lead['email']}: {e}")
        smtp.quit()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка SMTP: {e}")

    return {
        "ok": True,
        "sent": sent,
        "errors": errors[:10],
        "summary": f"Отправлено {sent} из {len(leads)}"
    }

# ── Key Slots ─────────────────────────────────────────────

class KeySlotPayload(BaseModel):
    name: str = "Слот"
    keys: str = ""

class ProxyCheckRequest(BaseModel):
    protocol: str = "http"
    host: str = ""
    port: str = ""
    login: str = ""
    password: str = ""


@app.post("/api/proxy/check")
def api_proxy_check(payload: ProxyCheckRequest, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    try:
        proxy_url = f"{payload.protocol}://"
        if payload.login and payload.password:
            proxy_url += f"{payload.login}:{payload.password}@"
        proxy_url += f"{payload.host}:{payload.port}"
        import httpx as _httpx
        try:
            with _httpx.Client(proxy=proxy_url, timeout=10) as client:
                r = client.get("https://api.ipify.org?format=json")
                data = r.json()
                return {"ok": True, "ip": data.get("ip", "")}
        except TypeError:
            with _httpx.Client(proxies={"all://": proxy_url}, timeout=10) as client:
                r = client.get("https://api.ipify.org?format=json")
                data = r.json()
                return {"ok": True, "ip": data.get("ip", "")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:100]}

class CheckSlotKeysRequest(BaseModel):
    keys: list[str]
    account_id: str = ""

def _build_probe_prompt(account_id: str = "") -> str:
    """Собирает системный промпт того же размера, что уходит в бою."""
    base = ""
    if account_id:
        try:
            res = supabase.table("ai_settings").select("*").eq("account_id", account_id).limit(1).execute()
            if res.data:
                s = res.data[0]
                parts = []
                for field in ("bot_name", "bot_age", "bot_gender", "location", "persona",
                              "goal", "stop_topics", "contacts", "contacts_trigger",
                              "system_prompt", "extra_prompt"):
                    val = s.get(field)
                    if val:
                        parts.append(f"{field}: {val}")
                base = "\n".join(parts)
        except Exception as e:
            print(f"[KEY-CHECK] не смог взять ai_settings: {e}", flush=True)

    if not base:
        base = (
            "Ты девушка с сайта знакомств. Отвечай живо, коротко, без канцелярита. "
            "Не признавайся что ты бот. Веди диалог к встрече."
        )
    # Никакого раздувания: проверяем ровно тем объёмом, который уходит в бою.
    # Раньше здесь был padding до 7000 символов, и живые ключи помечались
    # как «промпт не влезает», хотя в работе они нормальные.
    return base[:4000]

def _openrouter_balance(api_key: str) -> dict | None:
    """Остаток кредитов на openrouter-ключе. Для groq-ключей возвращает None."""
    if not api_key.strip().lower().startswith("sk-or-"):
        return None
    import http.client as _hc, json as _json
    try:
        conn = _hc.HTTPSConnection("openrouter.ai", timeout=15)
        conn.request("GET", "/api/v1/credits", headers={"Authorization": f"Bearer {api_key}"})
        r = conn.getresponse()
        raw = r.read().decode("utf-8", errors="ignore")
        conn.close()
        d = (_json.loads(raw) or {}).get("data") or {}
        total = float(d.get("total_credits") or 0)
        used = float(d.get("total_usage") or 0)
        return {"total": round(total, 4), "used": round(used, 4), "left": round(total - used, 4)}
    except Exception as e:
        print(f"[KEY-CHECK] баланс не получен: {e}", flush=True)
        return None

@app.post("/api/key-slots/check")
def api_check_slot_keys(payload: CheckSlotKeysRequest, authorization: str | None = Header(default=None)):
    """Прогоняет ключи боевым промптом. Вердикты:
    ok / rate_limit / too_long / no_credits / blocked / invalid / error"""
    require_auth(authorization)
    from shared import call_groq
    system_prompt = _build_probe_prompt(payload.account_id)
    history = [
        {"role": "user", "content": "привет, как дела?"},
        {"role": "assistant", "content": "привет) нормально, а у тебя?"},
        {"role": "user", "content": "тоже хорошо, чем занимаешься вечером?"},
    ]
    results = {}
    balances = {}
    errors = {}
    for key in payload.keys:
        key = (key or "").strip()
        if not key:
            continue
        _bal = _openrouter_balance(key)
        if _bal:
            balances[key] = _bal
        try:
            call_groq(key, "openai/gpt-oss-120b", system_prompt, history)
            results[key] = "ok"
        except Exception as e:
            msg = str(e).lower()
            if "blocked" in msg or "inference is blocked" in msg:
                verdict = "blocked"
            elif "prompt tokens limit" in msg or "context length" in msg or "too large" in msg or "maximum context" in msg:
                verdict = "too_long"
            elif "never purchased credits" in msg or "insufficient credit" in msg or "402" in msg or "payment" in msg:
                verdict = "no_credits"
            elif "rate limit" in msg or "429" in msg or "quota" in msg or "per day" in msg or "daily" in msg:
                verdict = "rate_limit"
            elif "invalid" in msg or "401" in msg or "user not found" in msg or "no auth" in msg:
                verdict = "invalid"
            else:
                verdict = "error"
            results[key] = verdict
            errors[key] = str(e)[:200]
            print(f"[KEY-CHECK] {key[:14]}… → {verdict} | {str(e)[:160]}", flush=True)
    return {"ok": True, "results": results, "balances": balances, "errors": errors}

@app.get("/api/key-slots/cooldowns")
def api_key_cooldowns(authorization: str | None = Header(default=None)):
    require_auth(authorization)
    from datetime import datetime as _dt, timezone as _tz
    res = supabase.table("key_cooldowns").select("*").execute()
    now = _dt.now(_tz.utc)
    out = {}
    for row in res.data or []:
        try:
            until = _dt.fromisoformat(str(row["until"]).replace("Z", "+00:00"))
        except Exception:
            continue
        if until > now:
            out[row["key_tail"]] = {
                "until": until.isoformat(),
                "minutes_left": int((until - now).total_seconds() / 60),
                "reason": row.get("reason") or "daily_limit",
            }
    return {"ok": True, "cooldowns": out}

@app.get("/api/key-slots")
def api_get_key_slots(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    res = supabase.table("key_slots").select("*").eq("owner_email", session["email"]).order("created_at").execute()
    return {"ok": True, "slots": res.data or []}

@app.post("/api/key-slots")
def api_create_key_slot(payload: KeySlotPayload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    res = supabase.table("key_slots").insert({
        "owner_email": session["email"],
        "name": payload.name,
        "keys": payload.keys,
    }).execute()
    return {"ok": True, "slot": res.data[0]}

@app.patch("/api/key-slots/{slot_id}")
def api_update_key_slot(slot_id: str, payload: KeySlotPayload, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    res = supabase.table("key_slots").update({
        "name": payload.name,
        "keys": payload.keys,
    }).eq("id", slot_id).eq("owner_email", session["email"]).execute()

    # Если слот уже привязан к анкете — прокидываем обновлённые ключи в ai_settings
    if res.data:
        slot = res.data[0]
        account_id = slot.get("account_id")
        if account_id:
            keys = [k.strip() for k in (payload.keys or "").splitlines() if k.strip()]
            supabase.table("ai_settings").update({
                "groq_api_keys": "\n".join(keys)
            }).eq("account_id", account_id).execute()

    return {"ok": True}

@app.post("/api/key-slots/release/{account_id}")
def api_release_key_slot(account_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    # Находим слот привязанный к этой анкете и освобождаем его
    res = supabase.table("key_slots").select("*").eq("account_id", account_id).eq("owner_email", session["email"]).execute()
    if res.data:
        supabase.table("key_slots").update({"account_id": None}).eq("id", res.data[0]["id"]).execute()
    return {"ok": True}

@app.delete("/api/key-slots/{slot_id}")
def api_delete_key_slot(slot_id: str, authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    supabase.table("key_slots").delete().eq("id", slot_id).eq("owner_email", session["email"]).execute()
    return {"ok": True}

@app.post("/api/key-slots/{slot_id}/assign")
def api_assign_key_slot(slot_id: str, account_id: str = "", authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    owner_emails = get_team_owner_emails(session["email"])

    slot_res = supabase.table("key_slots").select("*").eq("id", slot_id).eq("owner_email", session["email"]).execute()
    if not slot_res.data:
        raise HTTPException(status_code=404, detail="Слот не найден")
    slot = slot_res.data[0]
    keys = [k.strip() for k in (slot["keys"] or "").splitlines() if k.strip()]
    if not keys:
        raise HTTPException(status_code=400, detail="Слот пустой")
    if not account_id:
        raise HTTPException(status_code=400, detail="account_id не передан")

    # Проверяем, что анкета принадлежит именно этому пользователю (или его команде)
    account_res = supabase.table("accounts").select("id").eq("id", account_id).in_("owner_email", owner_emails).execute()
    if not account_res.data:
        raise HTTPException(status_code=403, detail="Нет доступа к этой анкете")

    # Применяем все ключи к ai_settings анкеты
    existing = supabase.table("ai_settings").select("account_id").eq("account_id", account_id).execute()
    if existing.data:
        supabase.table("ai_settings").update({"groq_api_keys": "\n".join(keys)}).eq("account_id", account_id).execute()
    else:
        supabase.table("ai_settings").insert({"account_id": account_id, "groq_api_keys": "\n".join(keys)}).execute()
    # Привязываем слот к анкете
    supabase.table("key_slots").update({"account_id": account_id}).eq("id", slot_id).execute()
    return {"ok": True, "assigned": 1}

# ── Health ────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"ok": True, "service": "api"}

@app.head("/health")
def health_head():
    return {"ok": True}

# ── Auto cleanup split_logs ───────────────────────────────

async def cleanup_split_logs():
    """Чистит старые логи раз в час.

    Раньше здесь вычитывалась ВСЯ таблица split_logs (133К строк) в память,
    и всё это крутилось прямо на event loop — на время чистки API замирал
    для всех. Теперь удаляем по дате одним запросом и в отдельном потоке.
    """
    while True:
        await asyncio.sleep(3600)
        try:
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=12)).isoformat()

            def _clean():
                supabase.table("split_logs").delete().lt("created_at", cutoff).execute()
                supabase.table("tasks_log").delete().lt("created_at", cutoff).execute()
                (supabase.table("job_queue").delete()
                 .not_.in_("status", ["pending", "running"])
                 .lt("created_at", cutoff).execute())

            await asyncio.to_thread(_clean)
            print(f"[CLEANUP] логи старше {cutoff} удалены", flush=True)
        except Exception as e:
            print(f"[CLEANUP] Ошибка: {e}", flush=True)

POOL_REMIND_BEFORE = 30   # за сколько минут до смены напоминать
POOL_REMIND_AFTER = 60    # и сколько минут после начала ещё пробовать


def _pool_remind_once():
    now = datetime.now(KYIV_TZ)
    for shift, (start_hm, _) in POOL_SHIFTS.items():
        sh, sm = map(int, start_hm.split(":"))
        start = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
        if not (start - timedelta(minutes=POOL_REMIND_BEFORE)
                <= now <= start + timedelta(minutes=POOL_REMIND_AFTER)):
            continue

        day = str(start.date())
        people = sorted({r["user_email"] for r in (supabase.table("work_shifts")
                         .select("user_email").eq("day", day).eq("shift", shift)
                         .execute().data or []) if r.get("user_email")})
        if not people:
            continue

        taken = {c["owner_email"] for c in (supabase.table("tg_claims")
                 .select("owner_email").eq("work_date", day).eq("shift", shift)
                 .execute().data or [])}
        busy = len(taken and (supabase.table("tg_claims").select("slot_id")
                              .eq("work_date", day).eq("shift", shift)
                              .execute().data or []) or [])
        total = len(supabase.table("tg_pool").select("id")
                    .eq("active", True).execute().data or [])
        free = max(0, total - busy)
        label = "дневная" if shift == "day" else "ночная"

        for em in people:
            if em in taken:
                continue
            try:
                supabase.table("pool_reminders").insert({
                    "email": em, "work_date": day, "shift": shift,
                }).execute()
            except Exception:
                continue  # уже напоминали

            supabase.table("notifications").insert({
                "email": em,
                "type": "tg_pool",
                "title": f"🔔 Скоро {label} смена — забери телеги",
                "message": f"Свободно {free} из {total}. Открой «МОИ TG» и закрепи за собой.",
                "data": {"date": day, "shift": shift},
                "is_read": False,
            }).execute()
            print(f"[POOL-REMIND] {em} · {day} · {shift}", flush=True)


async def pool_reminder_loop():
    while True:
        await asyncio.sleep(300)
        try:
            await asyncio.to_thread(_pool_remind_once)
        except Exception as e:
            print(f"[POOL-REMIND] ошибка: {e}", flush=True)


def _pool_remind(shift: str, day: str):
    """Напоминает тем, у кого смена началась, а телеги не взяты."""
    people = sorted({r["user_email"] for r in (supabase.table("work_shifts")
                     .select("user_email").eq("day", day).eq("shift", shift)
                     .execute().data or []) if r.get("user_email")})
    if not people:
        print(f"[POOL-REMIND] {day} {shift}: на смене никого", flush=True)
        return

    claims = (supabase.table("tg_claims").select("owner_email")
              .eq("work_date", day).eq("shift", shift).execute().data or [])
    taken = {c["owner_email"] for c in claims}
    total = len(supabase.table("tg_pool").select("id")
                .eq("active", True).execute().data or [])
    free = max(0, total - len(claims))
    label = "дневная" if shift == "day" else "ночная"

    sent = 0
    for em in people:
        if em in taken:
            continue
        try:
            supabase.table("pool_reminders").insert({
                "email": em, "work_date": day, "shift": shift,
            }).execute()
        except Exception:
            continue  # уже напоминали
        supabase.table("notifications").insert({
            "email": em,
            "type": "tg_pool",
            "title": f"🔔 Началась {label} смена — забери телеги",
            "message": f"Свободно {free} из {total}. Открой «МОИ TG» и закрепи за собой.",
            "data": {"date": day, "shift": shift},
            "is_read": False,
        }).execute()
        sent += 1
    print(f"[POOL-REMIND] {day} {shift}: на смене {len(people)}, напомнили {sent}", flush=True)


async def pool_reminder_loop():
    """Просыпается ровно к началу смены — в 09:00 и в 21:00 по Киеву."""
    while True:
        now = datetime.now(KYIV_TZ)
        nxt, shift = None, None
        for s, (hm, _) in POOL_SHIFTS.items():
            h, m = map(int, hm.split(":"))
            t = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if t <= now:
                t += timedelta(days=1)
            if nxt is None or t < nxt:
                nxt, shift = t, s
        await asyncio.sleep(max(60, (nxt - now).total_seconds()))
        try:
            await asyncio.to_thread(_pool_remind, shift, str(datetime.now(KYIV_TZ).date()))
        except Exception as e:
            print(f"[POOL-REMIND] ошибка: {e}", flush=True)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_split_logs())
    asyncio.create_task(tg_leads_loop())
    asyncio.create_task(pool_reminder_loop())
    asyncio.create_task(pool_reminder_loop())

# ── Static files ──────────────────────────────────────────

@app.get("/")
def index():
    return FileResponse(BASE_DIR / "index.html")

@app.head("/")
def index_head():
    from fastapi.responses import Response
    return Response(status_code=200)

# ── Раскладка интерфейса: позиции нод, нитки, ноды таймера/логов/трансляции ──
# Всё это раньше жило только в localStorage и терялось при входе с другого ПК.

class UiStatePayload(BaseModel):
    state: dict = {}


@app.get("/api/ui-state")
def api_ui_state_get(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    email = (session["email"] or "").lower()
    try:
        res = supabase.table("ui_state").select("state").eq("email", email).execute()
    except Exception as e:
        print(f"[UI-STATE] чтение упало: {type(e).__name__}: {e}", flush=True)
        return {"ok": True, "state": {}}
    return {"ok": True, "state": (res.data[0].get("state") if res.data else {}) or {}}


@app.put("/api/ui-state")
def api_ui_state_put(payload: UiStatePayload,
                     authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    email = (session["email"] or "").lower()
    raw = payload.state if isinstance(payload.state, dict) else {}
    # Пускаем только свои ключи и только строки — чтобы в таблицу не залетел мусор
    clean = {k: v for k, v in raw.items()
             if isinstance(k, str) and k.startswith("claw_") and isinstance(v, str)}
    if len(json.dumps(clean)) > 2_000_000:
        raise HTTPException(status_code=413, detail="Раскладка слишком большая")
    try:
        supabase.table("ui_state").upsert({
            "email": email,
            "state": clean,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }, on_conflict="email").execute()
    except Exception as e:
        print(f"[UI-STATE] запись упала: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail="Не сохранилось")
    return {"ok": True, "saved": len(clean)}


# ── Видео обучение ────────────────────────────────────────
# Админ заливает ролики и фото, команда смотрит. Файлы лежат в приватном
# бакете, наружу уходят подписанные ссылки на 6 часов.

TRAINING_BUCKET = "training"
TRAINING_MAX_MB = 45
_PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def _training_signed(path: str) -> str:
    if not path:
        return ""
    try:
        r = supabase.storage.from_(TRAINING_BUCKET).create_signed_url(path, 60 * 60 * 6)
        return (r or {}).get("signedURL") or (r or {}).get("signedUrl") or ""
    except Exception as e:
        print(f"[TRAINING] не подписал {path}: {type(e).__name__}: {e}", flush=True)
        return ""


@app.get("/api/training")
def api_training_list(authorization: str | None = Header(default=None)):
    session = require_auth(authorization)
    email = (session["email"] or "").lower()
    owners = get_team_owner_emails(email)
    try:
        res = (supabase.table("training_items").select("*")
               .in_("owner_email", owners)
               .order("created_at", desc=True).execute())
    except Exception as e:
        print(f"[TRAINING] список не прочитался: {e}", flush=True)
        raise HTTPException(status_code=500, detail="База временно недоступна")
    items = res.data or []
    for it in items:
        it["play_url"] = _training_signed(it.get("storage_path") or "")
    return {"ok": True, "items": items, "is_admin": email in ADMIN_EMAILS}


@app.post("/api/training")
async def api_training_add(
    file: UploadFile = File(...),
    title: str = Form(default=""),
    description: str = Form(default=""),
    authorization: str | None = Header(default=None),
):
    session = require_admin(authorization)
    email = (session["email"] or "").lower()

    data = await file.read()
    size = len(data)
    if size > TRAINING_MAX_MB * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"Файл {size // 1024 // 1024} МБ — предел {TRAINING_MAX_MB} МБ")

    ext = os.path.splitext(file.filename or "")[1].lower() or ".bin"
    kind = "photo" if ext in _PHOTO_EXT else "video"
    path = f"{uuid.uuid4().hex}{ext}"

    try:
        supabase.storage.from_(TRAINING_BUCKET).upload(
            path, data,
            {"content-type": file.content_type or "application/octet-stream"})
    except Exception as e:
        print(f"[TRAINING] загрузка упала: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"Не загрузилось: {e}")

    row = {
        "owner_email": email,
        "kind": kind,
        "title": (title or file.filename or "Без названия").strip()[:200],
        "description": (description or "").strip()[:2000],
        "storage_path": path,
        "size_bytes": size,
    }
    try:
        ins = supabase.table("training_items").insert(row).execute()
    except Exception as e:
        supabase.storage.from_(TRAINING_BUCKET).remove([path])
        raise HTTPException(status_code=500, detail=f"Не сохранилось: {e}")

    item = (ins.data or [row])[0]
    item["play_url"] = _training_signed(path)
    return {"ok": True, "item": item}


class TrainingPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None


@app.patch("/api/training/{item_id}")
def api_training_patch(item_id: str, payload: TrainingPatch,
                       authorization: str | None = Header(default=None)):
    require_admin(authorization)
    upd = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not upd:
        return {"ok": True}
    supabase.table("training_items").update(upd).eq("id", item_id).execute()
    return {"ok": True}


@app.delete("/api/training/{item_id}")
def api_training_delete(item_id: str, authorization: str | None = Header(default=None)):
    require_admin(authorization)
    res = supabase.table("training_items").select("storage_path").eq("id", item_id).execute()
    path = (res.data or [{}])[0].get("storage_path") or ""
    if path:
        try:
            supabase.storage.from_(TRAINING_BUCKET).remove([path])
        except Exception as e:
            print(f"[TRAINING] файл не удалился: {e}", flush=True)
    supabase.table("training_items").delete().eq("id", item_id).execute()
    return {"ok": True}


app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")
STATIC_ALLOWED = {".html", ".js", ".css", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".gif", ".woff", ".woff2"}
STATIC_BLOCKED = {"atolin_dump.html"}

@app.get("/{file_path:path}")
def static_files(file_path: str):
    p = (BASE_DIR / file_path).resolve()
    try:
        rel = p.relative_to(BASE_DIR)
    except ValueError:
        raise HTTPException(status_code=404)
    if (not p.is_file()
            or p.suffix.lower() not in STATIC_ALLOWED
            or p.name in STATIC_BLOCKED
            or any(part.startswith(".") for part in rel.parts)):
        raise HTTPException(status_code=404)
    return FileResponse(p)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
