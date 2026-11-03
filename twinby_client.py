"""
Twinby — HTTP клиент без Playwright.
Работает через JWT токен напрямую.
"""
import random
import json
import re
import http.client
import gzip
import time
import uuid
from typing import Optional
from pathlib import Path
import base64


BASE_HOST = "twinby.ru"
API_BASE = "/api"

import socket as _socket
import ssl as _ssl

import threading as _threading
from proxy_loader import get_proxy as _get_proxy

# Прокси текущей анкеты. Именно thread-local, а не глобальная переменная:
# воркер крутит анкеты параллельно в потоках и они затирали прокси друг другу.
_proxy_ctx = _threading.local()


def _socks5_connect(proxy_host, proxy_port, target_host, target_port, username=None, password=None, timeout=15):
    sock = _socket.create_connection((proxy_host, int(proxy_port)), timeout=timeout)
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


class _Socks5HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, proxy_host, proxy_port, proxy_user, proxy_pass, timeout=15):
        super().__init__(host, port, timeout=timeout)
        self._proxy_host = proxy_host
        self._proxy_port = proxy_port
        self._proxy_user = proxy_user
        self._proxy_pass = proxy_pass

    def connect(self):
        raw_sock = _socks5_connect(
            self._proxy_host, self._proxy_port, self.host, self.port,
            self._proxy_user, self._proxy_pass, self.timeout
        )
        context = _ssl.create_default_context()
        self.sock = context.wrap_socket(raw_sock, server_hostname=self.host)


def _proxy():
    v = getattr(_proxy_ctx, "value", None)
    if v and v.get("host"):
        return v
    return _get_proxy("twinby")


def set_account_proxy(settings: dict):
    """Ставит прокси анкеты из её настроек — данные приходят из ноды на канвасе."""
    s = settings or {}
    host = (s.get("proxy_host") or "").strip()
    if not host:
        _proxy_ctx.value = None
        print("[TWINBY PROXY] У анкеты не привязана нода прокси — беру платформенный", flush=True)
        return
    _proxy_ctx.value = {
        "use_proxy": True,
        "host": host,
        "port": int(s.get("proxy_port") or 1080),
        "username": (s.get("proxy_login") or "").strip(),
        "password": (s.get("proxy_password") or "").strip(),
        "protocol": (s.get("proxy_protocol") or "socks5").strip().lower(),
        "user_agent": (s.get("user_agent") or "").strip(),
    }
    print(f"[TWINBY PROXY] Анкета идёт через ноду {host}:{_proxy_ctx.value['port']}", flush=True)


def clear_account_proxy():
    _proxy_ctx.value = None


def parse_cookies(raw: str) -> dict:
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return {item["name"]: item["value"] for item in parsed if item.get("name")}
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    result = {}
    for part in raw.split(";"):
        part = part.strip()
        if "=" in part:
            name, value = part.split("=", 1)
            result[name.strip()] = value.strip()
    return result


def extract_jwt(cookies_or_token: dict | str) -> str:
    """Извлекает JWT токен из кук или строки."""
    if isinstance(cookies_or_token, str):
        raw = cookies_or_token.strip()
        # Если это JSON с полем token
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return data.get("token") or data.get("jwt") or data.get("access_token") or ""
        except Exception:
            pass
        # Если это уже чистый JWT
        if raw.startswith("eyJ"):
            return raw
        # Может быть "JWT eyJ..." или "JWT {json}"
        if raw.upper().startswith("JWT "):
            after = raw[4:].strip()
            # after может быть JSON объектом
            try:
                data = json.loads(after)
                if isinstance(data, dict):
                    return data.get("token") or data.get("jwt") or data.get("access_token") or ""
            except Exception:
                pass
            if after.startswith("eyJ"):
                return after
            return after
        return raw
    if isinstance(cookies_or_token, dict):
        return (
            cookies_or_token.get("token") or
            cookies_or_token.get("jwt") or
            cookies_or_token.get("access_token") or
            ""
        )
    return ""


def _api_request(method: str, path: str, token: str, body: dict = None, account_proxy: dict = None) -> dict:
    """Запрос к twinby.ru API."""
    p = _proxy()
    # Если есть per-account прокси — используем его
    if account_proxy and account_proxy.get("proxy_host"):
        p = {
            "use_proxy": True,
            "host": account_proxy["proxy_host"],
            "port": int(account_proxy.get("proxy_port") or 8080),
            "username": account_proxy.get("proxy_login", ""),
            "password": account_proxy.get("proxy_password", ""),
            "user_agent": account_proxy.get("user_agent", ""),
        }
    headers = {
        "Accept": "application/json",
        "Accept-Language": "ru-RU,ru;q=0.9",
        "Content-Type": "application/json",
        "Authorization": f"JWT {token}",
        "User-Agent": p.get("user_agent") or "Dart/3.11 (dart:io)",
        "Origin": "https://twinby.ru",
        "Referer": "https://twinby.ru/",
    }
    body_bytes = None
    if body is not None:
        body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Length"] = str(len(body_bytes))

    try:
        if p.get("use_proxy") and p.get("host"):
            _scheme = (p.get("protocol") or "socks5").lower()
            if _scheme in ("http", "https"):
                # HTTP-прокси: CONNECT-туннель до twinby.ru
                conn = http.client.HTTPSConnection(p["host"], int(p["port"]), timeout=15)
                _tunnel_headers = {}
                if p.get("username"):
                    _cred = f"{p.get('username')}:{p.get('password') or ''}"
                    _tunnel_headers["Proxy-Authorization"] = "Basic " + base64.b64encode(
                        _cred.encode("utf-8")
                    ).decode("ascii")
                conn.set_tunnel(BASE_HOST, 443, headers=_tunnel_headers)
            else:
                conn = _Socks5HTTPSConnection(
                    BASE_HOST, 443,
                    p["host"], p["port"],
                    p.get("username"), p.get("password"),
                    timeout=15,
                )
        else:
            conn = http.client.HTTPSConnection(BASE_HOST, timeout=15)

        conn.request(method, path, body=body_bytes, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()

        if resp.getheader("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)

        text = raw.decode("utf-8", errors="ignore")
        try:
            data = json.loads(text)
        except Exception:
            data = {"_raw": text}
        data["_status"] = resp.status
        return data
    except Exception as e:
        return {"_status": 0, "_error": str(e)}


# ── API методы ────────────────────────────────────────────

def get_me(token: str) -> dict:
    """Получить профиль текущего пользователя. GET /api/users/me/"""
    resp = _api_request("GET", f"{API_BASE}/users/me/", token)
    print(f"[TWINBY] get_me статус={resp.get('_status')}", flush=True)
    print(f"[TWINBY] get_me raw={str(resp)[:500]}", flush=True)
    return resp


def detect_account_status(token: str) -> dict:
    """Проверяет что токен живой."""
    resp = get_me(token)
    status = resp.get("_status", 0)

    if status in (200, 201):
        moderation = resp.get("moderationStatus")
        if moderation == 3:
            return {"status": "blocked", "reason": "Аккаунт заблокирован (moderationStatus=3)", "http_status": status}
        return {"status": "valid", "http_status": status}
    if status == 401:
        return {"status": "logged_out", "reason": "Токен недействителен", "http_status": status}
    if status == 403:
        return {"status": "blocked", "reason": "Аккаунт заблокирован (HTTP 403)", "http_status": status}
    if status == 0:
        return {"status": "error", "reason": resp.get("_error", "Нет соединения"), "http_status": 0}

    return {"status": "unknown", "reason": f"HTTP {status}", "http_status": status}


def get_profiles_for_likes(token: str, limit: int = 20) -> list[dict]:
    all_results = []
    page = 1
    while len(all_results) < limit:
        resp = _api_request("GET", f"{API_BASE}/dating/action/incoming/?page={page}&size=40", token)
        results = resp.get("results") or resp.get("data") or []
        if not results:
            break
        all_results.extend(results)
        if len(results) < 40:
            break
        page += 1
    print(f"[TWINBY] Входящих лайков: {len(all_results)}", flush=True)
    return all_results


def like_profile(token: str, user_id) -> dict:
    """
    Поставить лайк.
    POST /api/dating/action/from-search-action/
    Body: {"user": <user_id>, "type": 0}
    """
    resp = _api_request(
        "POST",
        f"{API_BASE}/dating/action/from-search-action/",
        token,
        body={"user": user_id, "type": 0}
    )
    print(f"[TWINBY] Лайк {user_id}: статус={resp.get('_status')}", flush=True)
    return resp


def get_chats(token: str, page: int = 1) -> dict:
    """
    Получить список чатов.
    GET /api/chats/list/
    """
    resp = _api_request("GET", f"{API_BASE}/chats/list/?page={page}", token)
    print(f"[TWINBY] get_chats статус={resp.get('_status')}", flush=True)
    return resp

def get_empty_chats(token: str, page: int = 1, size: int = 20) -> dict:
    """
    Получить список чатов без сообщений (новые матчи, которым ещё не писали).
    GET /api/chats/chat/empty/v2/
    """
    resp = _api_request("GET", f"{API_BASE}/chats/chat/empty/v2/?page={page}&size={size}", token)
    print(f"[TWINBY] get_empty_chats статус={resp.get('_status')}", flush=True)
    return resp

def get_lobby(token: str) -> dict:
    resp = _api_request("GET", f"{API_BASE}/chats/lobby-v2/lobby-main-list/", token)
    print(f"[TWINBY] get_lobby статус={resp.get('_status')}", flush=True)
    print(f"[TWINBY] get_lobby keys={list(resp.keys())}", flush=True)
    print(f"[TWINBY] get_lobby raw={str(resp)[:300]}", flush=True)
    return resp


def get_chat_messages(token: str, chat_id) -> dict:
    """
    Получить историю чата.
    GET /api/chats/chat/<chat_id>/message/
    """
    resp = _api_request("GET", f"{API_BASE}/chats/chat/{chat_id}/message/?page=1&size=50", token)
    print(f"[TWINBY] get_chat_messages {chat_id}: статус={resp.get('_status')}", flush=True)
    return resp

def _msgs_chronological(msgs_raw: list) -> list:
    """Сообщения в хронологическом порядке: старые → новые.

    Порядок от API не угадываем — сортируем по времени, если оно есть.
    """
    def _ts(m):
        return (m.get("createdAt") or m.get("created_at")
                or m.get("date") or m.get("timestamp") or "")
    if msgs_raw and all(_ts(m) for m in msgs_raw):
        return sorted(msgs_raw, key=_ts)
    return list(reversed(msgs_raw))

def send_message(token: str, chat_id, message: str) -> dict:
    """
    Отправить сообщение.
    POST /api/chats/chat/<chat_id>/message/
    Body: {"id": "<uuid>", "text": "<text>", "attaches": []}
    """
    body = {
        "id": str(uuid.uuid4()),
        "text": message,
        "attaches": [],
    }
    resp = _api_request(
        "POST",
        f"{API_BASE}/chats/chat/{chat_id}/message/",
        token,
        body=body
    )
    print(f"[TWINBY] send_message {chat_id}: статус={resp.get('_status')}", flush=True)
    return resp


# ── Высокоуровневые задачи ────────────────────────────────

def task_likes_http(token: str, limit: int = 20, settings: dict = None, log_fn=None) -> dict:
    if settings:
        set_account_proxy(settings)
    liked = 0
    skipped = 0
    errors = 0

    def _log(msg: str):
        print(f"[TWINBY LIKES] {msg}", flush=True)
        if log_fn:
            try:
                log_fn(msg)
            except Exception:
                pass

    profiles = get_profiles_for_likes(token, limit=limit)

    if not profiles:
        print("[TWINBY LIKES] Нет анкет для лайков", flush=True)
        return {"liked": 0, "skipped": 0, "errors": 0}

    profiles = profiles[:limit]

    seen_users = set()

    for profile in profiles:
        user_obj = profile.get("user") or profile
        user_id = user_obj.get("id") or profile.get("user_id")
        action_id = profile.get("id")  # UUID входящего лайка
        name = user_obj.get("name") or str(user_id)

        if not user_id:
            skipped += 1
            continue

        if user_id in seen_users:
            print(f"[TWINBY LIKES] дубль {name}, пропускаю", flush=True)
            skipped += 1
            continue
        seen_users.add(user_id)

        try:
            result = like_profile(token, user_id)
            status = result.get("_status")
            if status in (200, 201):
                liked += 1
                _log(f"✓ Лайк поставлен: {name}")
            elif status == 400 and "conflict" in str(result).lower():
                print(f"[TWINBY LIKES] уже лайкнут {name}, пропускаю", flush=True)
                skipped += 1
            else:
                print(f"[TWINBY LIKES] ✗ {name}: статус={status} {result}", flush=True)
                errors += 1
        except Exception as e:
            print(f"[TWINBY LIKES] ✗ {name}: {e}", flush=True)
            errors += 1

        time.sleep(random.uniform(1, 3))

    return {"liked": liked, "skipped": skipped, "errors": errors}


def task_get_all_chats_with_history(token: str, max_chats: int = 30) -> list[dict]:
    """Получает чаты с историей переписки."""

    # Берём чаты из /api/chats/list/
    chats_resp = get_chats(token)
    chats_raw = (
        chats_resp.get("results") or
        chats_resp.get("data") or
        []
    )

    # Дедупликация чатов по chat_id
    seen_chats = set()
    unique_chats = []
    for chat in chats_raw:
        chat_obj = chat.get("chat") or chat
        cid = chat_obj.get("id") or chat.get("chat_id")
        if cid and cid not in seen_chats:
            seen_chats.add(cid)
            unique_chats.append(chat)
    chats_raw = unique_chats

    print(f"[TWINBY] Чатов: {len(chats_raw)}", flush=True)

    result = []

    # Получаем свой ID один раз
    me = get_me(token)
    my_id = str(me.get("id") or me.get("user_id") or "")
    print(f"[TWINBY DEBUG] my_id={my_id}", flush=True)

    for chat in chats_raw[:max_chats]:
        chat_obj = chat.get("chat") or chat
        chat_id = chat_obj.get("id") or chat.get("chat_id")
        if not chat_id:
            continue

        companion = chat.get("companion") or chat.get("user") or {}
        name = companion.get("name") or companion.get("username") or str(chat_id)
        companion_id = companion.get("id")

        msgs_resp = get_chat_messages(token, chat_id)
        msgs_raw = msgs_resp.get("results") or msgs_resp.get("data") or []
        print(f"[TWINBY DEBUG] chat {chat_id} ({name}): получено сообщений из API = {len(msgs_raw)}", flush=True)

        if not msgs_raw:
            print(f"[TWINBY DEBUG] chat {chat_id}: пустая история", flush=True)
            continue

        # API возвращает от новых к старым — разворачиваем
        msgs_raw = list(reversed(msgs_raw))

        history = []
        for msg in msgs_raw:
            text = (msg.get("text") or "").strip()
            if not text:
                continue
            owner_id = str(msg.get("ownerId") or msg.get("owner_id") or "")
            is_incoming = owner_id != my_id
            history.append({
                "role": "user" if is_incoming else "assistant",
                "content": text,
            })

        if not history:
            continue

        print(f"[TWINBY DEBUG] {name}: {len(history)} сообщ, последнее: [{history[-1]['role']}] {history[-1]['content'][:40]}", flush=True)

        result.append({
            "chat_id": chat_id,
            "name": name,
            "companion_id": companion_id,
            "history": history,
            "last_role": history[-1]["role"],
        })

    return result

def iter_chats_with_history(token: str, max_chats: int = 30):
    """
    Отдаёт чаты ПО ОДНОМУ, сразу после чтения каждого.

    Раньше сначала читались ВСЕ чаты (каждый запрос ~2 сек через прокси),
    и только потом начинались ответы. При 25+ чатах первый ответ уходил
    через минуту с лишним — со стороны это выглядело как
    "бот читает чаты и не отвечает".
    """
    me = get_me(token)
    my_id = str(me.get("id") or me.get("user_id") or "")
    print(f"[TWINBY DEBUG] my_id={my_id}", flush=True)

    def _items(resp):
        return resp.get("results") or resp.get("data") or []

    sources = []
    for page in (1, 2, 3):
        items = _items(get_chats(token, page=page))
        if not items:
            break
        sources.extend(items)
    try:
        sources.extend(_items(get_empty_chats(token, page=1, size=50)))
    except Exception as e:
        print(f"[TWINBY] empty/v2: {e}", flush=True)

    print(f"[TWINBY] Всего чатов к обработке: {len(sources)}", flush=True)

    seen = set()
    given = 0
    for item in sources:
        if given >= max_chats:
            return
        chat_obj = item.get("chat") or item
        chat_id = chat_obj.get("id") or item.get("chatId") or item.get("chat_id")
        if not chat_id or str(chat_id) in seen:
            continue
        seen.add(str(chat_id))

        companion = item.get("interlocutor") or item.get("companion") or item.get("user") or {}
        name = companion.get("name") or str(chat_id)

        msgs_resp = get_chat_messages(token, chat_id)
        if msgs_resp.get("_status") not in (200, 201):
            print(f"[TWINBY] {name}: чат не открылся (статус={msgs_resp.get('_status')}), пропускаю", flush=True)
            continue
        msgs_raw = _items(msgs_resp)
        if not msgs_raw:
            continue

        # API отдаёт от новых к старым — разворачиваем в хронологический порядок
        history = []
        for msg in reversed(msgs_raw):
            text = (msg.get("text") or "").strip()
            if not text:
                continue
            owner_id = str(msg.get("ownerId") or msg.get("owner_id") or "")
            history.append({
                "role": "user" if owner_id != my_id else "assistant",
                "content": text,
            })
        if not history:
            continue

        print(f"[TWINBY DEBUG] {name}: {len(history)} сообщ, последнее: [{history[-1]['role']}] {history[-1]['content'][:40]}", flush=True)
        given += 1
        yield {
            "chat_id": chat_id,
            "name": name,
            "history": history,
            "last_role": history[-1]["role"],
        }

# Ниже этой суммы контакт не отдаём — лид не наш.
MIN_PRICE = 15000

_INSULT_RE = re.compile(
    r"очко|анал|шлюх|шалав|прост[ие]тут|давалк|подстилк|"
    r"сперм|дроч|трах|ебат|ебал|ебуч|ебл|бля[дт]|пизд|ху[йеё]|мраз|тварь|уродин",
    re.IGNORECASE,
)
_BRUSH_OFF = ["теряйся", "иди лесом", "фу, теряйся"]

_BOT_ACCUSE_RE = re.compile(
    r"(?<![а-яёa-z])бот(?![а-яёa-z])|ботяра|нейросет|нейронк|робот|"
    r"(?<![а-яёa-z])ии(?![а-яёa-z])|скрипт",
    re.IGNORECASE,
)
_BOT_REPLY = [
    "ок ок, как скажешь, теряйся тогда",
    "ок, как скажешь, теряйся",
    "ага, бот. теряйся тогда",
]
_RELATIONSHIP_RE = re.compile(
    r"серь[её]зн\w*\s*отношени|для\s*отношений|создать\s*семь|семейн|замуж|"
    r"вторую\s*половин|спутниц|(?<![а-яё])любов[ьи](?![а-яё])",
    re.IGNORECASE,
)
_RELATIONSHIP_REPLY = [
    "отношения не ищу, только встречи",
    "я не по отношениям, только встречи",
    "серьёзного не ищу, только встречи",
]
_NO_MATCH = "ну тогда не по пути, удачи"
_CLOSERS = _BRUSH_OFF + _BOT_REPLY + [_NO_MATCH]


def _offered_amount(text: str) -> int:
    """Максимальная сумма, названная лидом. 0 — денег в сообщении нет."""
    t = (text or "").lower()
    if not re.search(r"\d", t):
        return 0
    if re.search(r"\d+\s*(лет|года|год|см|кг|часов|час|мин|:\d)", t):
        return 0
    vals = []
    for m in re.finditer(r"(\d{1,6})\s*(к|k|тыс|т\.?р)?", t):
        num = int(m.group(1))
        if m.group(2):
            num *= 1000
        elif num < 1000:
            num *= 1000
        if 1000 <= num <= 1_000_000:
            vals.append(num)
    return max(vals) if vals else 0


def task_auto_reply_http(
    token: str,
    settings: dict,
    build_prompt_fn,
    call_groq_fn,
    max_chats: int = 5,
    should_cancel_fn=None,
    log_fn=None,
) -> dict:
    """Авто-ответ для Twinby."""
    set_account_proxy(settings)

    def _log(msg: str):
        print(f"[TWINBY AUTO-REPLY] {msg}", flush=True)
        if log_fn:
            try:
                log_fn(msg)
            except Exception:
                pass

    status_check = detect_account_status(token)
    if status_check["status"] == "blocked":
        return {"replied": 0, "skipped": 0, "errors": 0, "contacts_sent": 0,
                "blocked": True, "logged_out": False}
    if status_check["status"] == "logged_out":
        return {"replied": 0, "skipped": 0, "errors": 0, "contacts_sent": 0,
                "blocked": False, "logged_out": True}

    account_id = settings.get("_account_id", "")
    system_prompt = build_prompt_fn(settings)
    contacts = (settings.get("contacts") or "").strip()

    replied = 0
    skipped = 0
    errors = 0
    contacts_sent = 0
    greeted = 0

    # ── Пишем первым новым матчам ──────────────────────────
    try:
        matches_resp = get_empty_chats(token, page=1, size=5)
        print(f"[TWINBY MATCH] raw={str(matches_resp)[:500]}", flush=True)
        matches = matches_resp.get("results") or matches_resp.get("data") or []
        print(f"[TWINBY MATCH] Пустых чатов (новых матчей): {len(matches)}", flush=True)

        seen_chat_ids = set()
        unique_matches = []
        for m in matches:
            cid = (m.get("chat") or m).get("id") or m.get("chatId") or m.get("chat_id")
            if cid and cid not in seen_chat_ids:
                seen_chat_ids.add(cid)
                unique_matches.append(m)
        matches = unique_matches

        for match in matches:
            if should_cancel_fn and should_cancel_fn():
                break
            chat_obj = match.get("chat") or match
            companion = match.get("interlocutor") or match.get("companion") or match.get("user") or {}
            name = companion.get("name") or "Собеседник"
            chat_id = chat_obj.get("id") or match.get("chatId") or match.get("chat_id")
            if not chat_id:
                print(f"[TWINBY MATCH] {name}: нет chat_id. keys={list(match.keys())}", flush=True)
                continue

            msgs_resp = get_chat_messages(token, chat_id)
            msgs_raw = msgs_resp.get("results") or msgs_resp.get("data") or []
            if msgs_raw:
                continue

            try:
                # Только простое приветствие — БЕЗ упоминания встречи/мп.
                # Вопрос про встречи за мп задаётся отдельным сообщением ПОСЛЕ ответа
                # собеседника (см. force_ask_meeting в task_auto_reply_http ниже).
                _greetings = [
                    "приветик, встретимся ?",
                    "привет, встречи рассматриваешь ?",
                    "привет, какие планы на сегодня ?",
                    "привет, встретиться не хочешь ?",
                ]
                _acc_id = settings.get("_account_id", "default")
                _idx_path = Path(__file__).resolve().parent / "data" / f"greeting_index_twinby_{_acc_id}.json"
                try:
                    _idx = json.loads(_idx_path.read_text(encoding="utf-8")).get("idx", 0)
                except Exception:
                    _idx = 0
                first_reply = _greetings[_idx % len(_greetings)]
                _idx_path.write_text(json.dumps({"idx": (_idx + 1) % len(_greetings)}, ensure_ascii=False), encoding="utf-8")
                print(f"[TWINBY MATCH] Приветствие #{_idx}: {first_reply}", flush=True)

                recheck_resp = get_chat_messages(token, chat_id)
                recheck_raw = recheck_resp.get("results") or recheck_resp.get("data") or []
                if recheck_raw:
                    _rc_ordered = _msgs_chronological(recheck_raw)
                    last_owner = str(_rc_ordered[-1].get("ownerId") or _rc_ordered[-1].get("owner_id") or "")
                    me_check = get_me(token)
                    my_id_check = str(me_check.get("id") or me_check.get("user_id") or "")
                    if last_owner == my_id_check:
                        print(f"[TWINBY MATCH] {name}: уже ответили, пропускаю", flush=True)
                        continue

                send_result = send_message(token, chat_id, first_reply)
                if send_result.get("_status") not in (200, 201):
                    print(f"[TWINBY MATCH] ✗ {name}: {send_result}", flush=True)
                else:
                    print(f"[TWINBY MATCH] ✓ написал первым {name}: {first_reply[:50]}", flush=True)
                    greeted += 1

            except Exception as e:
                print(f"[TWINBY MATCH] ✗ {name}: {e}", flush=True)

            time.sleep(random.uniform(1, 3))

    except Exception as e:
        print(f"[TWINBY MATCH] ошибка: {e}", flush=True)

    # ── Отвечаем на входящие сообщения — сразу, чат за чатом ──
    def _iter_chats_to_answer():
        me = get_me(token)
        my_id = str(me.get("id") or me.get("user_id") or "")

        try:
            matches_resp = get_empty_chats(token, page=1, size=20)
            matches_all = matches_resp.get("results") or matches_resp.get("data") or []
            for m in matches_all:
                chat_obj = m.get("chat") or m
                chat_id = chat_obj.get("id") or m.get("chatId") or m.get("chat_id")
                if not chat_id:
                    continue
                msgs_resp = get_chat_messages(token, chat_id)
                msgs_raw = msgs_resp.get("results") or msgs_resp.get("data") or []
                if not msgs_raw:
                    continue
                _ordered = _msgs_chronological(msgs_raw)
                last_owner = str(_ordered[-1].get("ownerId") or _ordered[-1].get("owner_id") or "")
                if last_owner == my_id:
                    continue
                companion = m.get("interlocutor") or m.get("companion") or m.get("user") or {}
                name = companion.get("name") or "Собеседник"
                history = []
                for msg in _ordered:
                    text = (msg.get("text") or "").strip()
                    if not text:
                        continue
                    owner_id = str(msg.get("ownerId") or msg.get("owner_id") or "")
                    history.append({"role": "user" if owner_id != my_id else "assistant", "content": text})
                if history and history[-1]["role"] == "user":
                    yield {"chat_id": chat_id, "name": name, "history": history, "last_role": "user"}
        except Exception as e:
            print(f"[TWINBY] Матчи с сообщениями: {e}", flush=True)

        chats_raw = []
        for _page in (1, 2, 3):
            _resp = get_chats(token, page=_page)
            if _resp.get("_status") not in (200, 201):
                print(f"[TWINBY] chats/list стр.{_page}: статус={_resp.get('_status')} {str(_resp)[:200]}", flush=True)
                break
            _items = _resp.get("results") or _resp.get("data") or []
            if not _items:
                break
            chats_raw.extend(_items)
        print(f"[TWINBY] Чатов в списке: {len(chats_raw)}", flush=True)
        if not chats_raw:
            print(f"[TWINBY] chats/list пуст — пробую лобби", flush=True)
            try:
                _lob = get_lobby(token)
                _lob_items = _lob.get("results") or _lob.get("data") or []
                print(f"[TWINBY] лобби дало: {len(_lob_items)} шт", flush=True)
                chats_raw.extend(_lob_items)
            except Exception as _e:
                print(f"[TWINBY] лобби: {_e}", flush=True)
        seen_chats = set()
        unique_chats = []
        for chat in chats_raw:
            chat_obj = chat.get("chat") or chat
            cid = chat_obj.get("id") or chat.get("chat_id")
            if cid and cid not in seen_chats:
                seen_chats.add(cid)
                unique_chats.append(chat)

        given = 0
        for chat in unique_chats:
            if given >= max_chats:
                return
            chat_obj = chat.get("chat") or chat
            chat_id = chat_obj.get("id") or chat.get("chat_id")
            if not chat_id:
                continue
            companion = chat.get("companion") or chat.get("user") or {}
            name = companion.get("name") or companion.get("username") or str(chat_id)

            msgs_resp = get_chat_messages(token, chat_id)
            msgs_raw = msgs_resp.get("results") or msgs_resp.get("data") or []
            if not msgs_raw:
                continue

            msgs_raw = _msgs_chronological(msgs_raw)
            history = []
            for msg in msgs_raw:
                text = (msg.get("text") or "").strip()
                if not text:
                    continue
                owner_id = str(msg.get("ownerId") or msg.get("owner_id") or "")
                history.append({"role": "user" if owner_id != my_id else "assistant", "content": text})
            if not history:
                continue
            print(f"[TWINBY DEBUG] {name}: {len(history)} сообщ, последнее [{history[-1]['role']}]: {history[-1]['content'][:40]}", flush=True)
            if history[-1]["role"] != "user":
                continue

            given += 1
            yield {"chat_id": chat_id, "name": name, "history": history, "last_role": "user"}

    _log("Читаю чаты...")
    for chat in _iter_chats_to_answer():
        if should_cancel_fn and should_cancel_fn():
            _log("Отмена")
            break

        chat_id = chat["chat_id"]
        history = chat["history"]
        name = chat["name"]

        if not history or history[-1]["role"] != "user":
            skipped += 1
            continue

        # Системный чат / поддержка Twinby — туда не пишем
        _sup_name = (name or "").lower()
        _sup_txt = " ".join((m.get("content") or "") for m in history).lower()
        _sup_markers = (
            "команда twinby", "twinby team", "поддержк", "support",
            "администрац", "модерац", "служба заботы", "техподдержк",
        )
        if (
            _sup_name in ("twinby", "twinby team", "поддержка", "support", "администрация")
            or "twinby" in _sup_name
            or any(_w in _sup_txt for _w in _sup_markers)
        ):
            print(f"[TWINBY] {name}: чат поддержки — пропускаю", flush=True)
            skipped += 1
            continue

        _last_in = (history[-1].get("content") or "").lower()

        # Уже отшили — в этот чат больше ни слова.
        if any(
            " ".join((m.get("content") or "").lower().split()) in _CLOSERS
            for m in history if m.get("role") == "assistant"
        ):
            _log(f"{name}: диалог закрыт — молчу")
            skipped += 1
            continue

        # Похабщина — одна фраза и конец, модель не зовём.
        if _INSULT_RE.search(_last_in):
            _log(f"{name}: хамство — отшиваю и закрываю диалог")
            _res = send_message(token, chat_id, random.choice(_BRUSH_OFF))
            if _res.get("_status") in (200, 201):
                replied += 1
            else:
                errors += 1
            continue

        # Назвал ботом — не спорим, закрываем.
        if _BOT_ACCUSE_RE.search(_last_in):
            _log(f"{name}: назвал ботом — закрываю диалог")
            _res = send_message(token, chat_id, random.choice(_BOT_REPLY))
            if _res.get("_status") in (200, 201):
                replied += 1
            else:
                errors += 1
            continue

        # Серьёзные отношения: первый раз отвечаем, на второй прощаемся.
        if _RELATIONSHIP_RE.search(_last_in):
            _said = any(
                " ".join((m.get("content") or "").lower().split()) in
                [p.lower() for p in _RELATIONSHIP_REPLY]
                for m in history if m.get("role") == "assistant"
            )
            _txt = _NO_MATCH if _said else random.choice(_RELATIONSHIP_REPLY)
            _log(f"{name}: про отношения — {'закрываю' if _said else 'отвечаю'}")
            _res = send_message(token, chat_id, _txt)
            if _res.get("_status") in (200, 201):
                replied += 1
            else:
                errors += 1
            continue

        assistant_msgs_count = sum(1 for m in history if m.get("role") == "assistant")
        already_has_contact = bool(contacts) and any(
            contacts.lower() in (m.get("content") or "").lower()
            for m in history if m.get("role") == "assistant"
        )
        # Первое сообщение уже спрашивает про встречу, поэтому на ответ лида
        # (после 1-го нашего сообщения) сразу ведём в телеграм при согласии.
        force_ask_meeting = False
        force_telegram = assistant_msgs_count == 1 and contacts and not already_has_contact

        turn_system_prompt = system_prompt
        if force_ask_meeting:
            turn_system_prompt = (
                system_prompt
                + "\n\nВАЖНО: собеседник только что ответил на твоё приветствие. В этом ответе "
                + "НЕ здоровайся снова, НЕ упоминай Telegram и не давай контакт — сразу спроси "
                + "про встречи за мп, выбери один из вариантов (не копируй дословно, перефразируй "
                + "в своём стиле, коротко, строчными буквами): 'рассматриваешь встречи за мп ?', "
                + "'встречи за мп рассматриваешь ?', 'какие планы на вечер ? рассматриваешь встречи за мп ?', "
                + "'встречаюсь за мп, если интересно — продолжим общение ?'."
            )
            print(f"[TWINBY AUTO-REPLY] {name} (chat {chat_id}): 2-е сообщение — форсирую вопрос про встречи за мп через Groq", flush=True)
        elif force_telegram:
            turn_system_prompt = (
                system_prompt
                + "\n\nВАЖНО: собеседник только что ответил на вопрос про встречи за мп (согласием, "
                + "интересом или уточняющим вопросом). В этом ответе предложи ему перейти в Telegram, "
                + f"обязательно укажи ник {contacts} прямо в тексте. "
                + "Пиши так, как реально пишут в переписке на сайтах знакомств: живо, коротко, "
                + "строчными буквами, без формальностей вроде 'кстати' или двоеточий перед ником. "
                + "Пример тона (не копируй дословно, придумай свою формулировку в этом же духе): "
                + f"'давай лучше в телеге, вот мой ник {contacts} а то тут редко захожу' или "
                + f"'сюда редко захожу, погнали в тг {contacts}'. "
                + "Никаких точек в конце, никакого 'Telegram:' — просто ник в тексте."
            )
            print(f"[TWINBY AUTO-REPLY] {name} (chat {chat_id}): 3-е сообщение — форсирую приглашение в Telegram через Groq", flush=True)
        else:
            _log(f"{name}: генерирую ответ...")

        try:
            reply = call_groq_fn(
                account_id=account_id,
                settings=settings,
                system_prompt=turn_system_prompt,
                messages=history[-8:],
            )
        except Exception as e:
            print(f"[TWINBY AUTO-REPLY] Groq ошибка: {e}", flush=True)
            errors += 1
            continue

        if not reply:
            skipped += 1
            continue

        if not any(ch.isalpha() for ch in reply):
            _log(f"{name}: мусор от модели ({reply[:40]!r}) — пропускаю")
            skipped += 1
            continue

        # Два английских слова подряд — это рассуждение модели, не реплика
        if "twinby" in reply.lower() or "твинби" in reply.lower():
            _log(f"{name}: упомянул платформу — не отправляю ({reply[:60]!r})")
            skipped += 1
            continue

        if re.search(r"\b[A-Za-z]{2,}\s+[A-Za-z]{2,}\b", reply):
            _log(f"{name}: английский текст — не отправляю ({reply[:60]!r})")
            skipped += 1
            continue

        # Модель процитировала промт по-русски — в чат такое не уходит
        _bad_ru = False
        if len(reply) > 200:
            _bad_ru = True
        elif re.search(r"[А-ЯЁ]{4,}", reply):
            _bad_ru = True
        elif re.match(r"^\s*\d+\s*[.)]\s", reply):
            _bad_ru = True
        else:
            _lc = reply.lower()
            for _w in ("правило", "случай а", "случай б", "вариант ответа",
                       "промт", "инструкц", "запрещено", "обязана",
                       "нужно ответить", "нужно убе", "ответ должен",
                       "не здоровайся", "в этом случае", "первый ответ",
                       "выбрать один из", "предложенных вариантов",
                       "не копируй", "перефразируй", "так что отвечу"):
                if _w in _lc:
                    _bad_ru = True
                    break
        if _bad_ru:
            _log(f"{name}: кусок промта — не отправляю ({reply[:80]!r})")
            skipped += 1
            continue

        if force_telegram and contacts and contacts.lower() not in reply.lower():
            fallback_phrases = [
                f"давай лучше в телеге, вот мой ник {contacts} а то тут редко захожу",
                f"сюда редко захожу, погнали в тг {contacts}",
                f"тут неудобно, го в телегу {contacts}",
            ]
            reply = random.choice(fallback_phrases)

        # Названа сумма — решаем детерминированно, модели цифры не доверяем.
        _amount = _offered_amount(_last_in)
        _wants_tg = bool(re.search(
            r"(давай|дай|дашь|скинь|кинь|кинешь|оставь|оставишь|пришли|напиши|скажи)\s+"
            r"(мне\s+|свой\s+)?(тг|телег|телеграм|telegram|ник|юзер|username)|"
            r"^\s*(тг|телега|телеграм|ник|юзер)\s*[?!.]*\s*$", _last_in))
        _forced_contact = False
        if _amount and _amount < MIN_PRICE:
            _log(f"{name}: предложил {_amount} — ниже минимума, контакт не даю")
            reply = "мне столько не подходит"
        elif _amount >= MIN_PRICE:
            _log(f"{name}: предложил {_amount} — подходит, отдаю контакт")
            if already_has_contact:
                reply = "давай там, жду"
            else:
                reply = "да, подходит, давай в тг"
                if contacts:
                    reply += "\n" + contacts
                    _forced_contact = True
        # Прямо просит контакт — кидаем только ник, без вступления.
        elif _wants_tg and contacts:
            _log(f"{name}: просит контакт — отдаю ник без вступления")
            reply = contacts
            _forced_contact = True
        # Спрашивает цену — первый раз перекидываем вопрос ему.
        elif re.search(r"скольк[оа]\s*(ты\s*)?(хочешь|берешь|берёшь|просишь|стоит)|"
                       r"какая сумма|какой прайс|что по деньгам|"
                       r"^\s*(а\s+|ну\s+)?скольк[оа]\s*[?!.)]*\s*$", _last_in):
            _asked_back = any(
                "рассчитыва" in (m.get("content") or "").lower()
                for m in history if m.get("role") == "assistant"
            )
            if not _asked_back:
                _log(f"{name}: спрашивает цену — перекидываю вопрос обратно")
                reply = random.choice([
                    "та не много, а ты на сколько рассчитываешь?",
                    "не много, а ты на какую сумму рассчитываешь?",
                ])
            else:
                _log(f"{name}: второй раз про цену — увожу в тг")
                reply = "тут это не обсуждаю, давай в тг"
                if contacts:
                    reply += "\n" + contacts
                    _forced_contact = True
        # МП / табу / услуги — перечислять нельзя, за это банят анкету.
        elif re.search(r"табу|каки[ем]\s*услуг|что вход|по классик|"
                       r"как(ое|ая)\s*мп|что\s*по\s*мп|мп\s*как(ое|ая)|"
                       r"скольк[оа]\s*мп(?![а-яё])", _last_in):
            _log(f"{name}: вопрос про мп/табу — безопасная фраза")
            reply = "тут такое не обсуждаю, чтоб не забанили, а так можем у тебя встретиться"
            if contacts and not already_has_contact:
                reply += "\nостальное лучше в тг " + contacts

        # Прощание на горячий вопрос (цена / встреча / условия) = слитый лид.
        if re.search(r"скольк|сумм|\bцен|услови|прайс|что по ч[ёе]м|за скольк|встреч|встрет",
                     _last_in) and \
           re.search(r"не по пути|удачи|всего доброго|прощай|пока\b", reply.lower()):
            _log(f"{name}: прощание на горячий вопрос — подменяю")
            if re.search(r"встреч|встрет|увидим", _last_in) and \
               not re.search(r"скольк|сумм|\bцен|прайс|услови", _last_in):
                reply = "да, не против, когда именно?"
            else:
                reply = "у тебя или у меня, мне без разницы"
                if contacts:
                    reply += "\n" + contacts

        # Эхо: три слова подряд из его сообщения в нашей реплике.
        _his = re.findall(r"[а-яёa-z]+", _last_in)
        _mine = re.findall(r"[а-яёa-z]+", reply.lower())
        if len(_his) >= 3 and len(_mine) >= 3:
            _tri = {" ".join(_his[i:i + 3]) for i in range(len(_his) - 2)}
            if any(" ".join(_mine[i:i + 3]) in _tri for i in range(len(_mine) - 2)):
                _log(f"{name}: эхо его слов — пропускаю круг ({reply[:60]!r})")
                skipped += 1
                continue

        if reply.count("?") > 1:
            _log(f"{name}: несколько вопросов в ответе — пропускаю круг ({reply[:60]!r})")
            skipped += 1
            continue

        if any(t in reply.lower() for t in (
                "всё спокойно", "все спокойно", "как проходит", "рада знакомству",
                "звучит заманчиво", "звучит интригующе", "звучит неплохо",
                "уточню детали", "уточни детали", "подходящий день", "своим чередом",
                "обстоят дела", "держи позитив", "всё будет хорошо",
                "как прошёл день", "как прошел день", "интересное предложение")) or \
                reply.strip().lower().rstrip(".") in ("понимаю", "ясно", "хорошо", "бывает"):
            _log(f"{name}: книжный оборот — пропускаю круг ({reply[:60]!r})")
            skipped += 1
            continue

        if should_cancel_fn and should_cancel_fn():
            break

        contact_already_sent = bool(contacts) and any(
            contacts.lower() in (m.get("content") or "").lower()
            for m in history if m.get("role") == "assistant"
        )
        if contact_already_sent and not _forced_contact and contacts and contacts.lower() in reply.lower():
            import re as _re
            reply = _re.sub(_re.escape(contacts), "", reply, flags=_re.IGNORECASE).strip().strip("—-,. ")
            if not reply:
                print(f"[TWINBY AUTO-REPLY] {name}: контакт уже был в истории, ответ пуст после вырезки — пропуск", flush=True)
                skipped += 1
                continue

        fresh_resp = get_chat_messages(token, chat_id)
        fresh_msgs = fresh_resp.get("results") or fresh_resp.get("data") or []
        if fresh_msgs:
            _fresh_ordered = _msgs_chronological(fresh_msgs)
            last_owner = str(_fresh_ordered[-1].get("ownerId") or _fresh_ordered[-1].get("owner_id") or "")
            me = get_me(token)
            my_id = str(me.get("id") or me.get("user_id") or "")
            if last_owner == my_id:
                print(f"[TWINBY AUTO-REPLY] {name}: уже ответили (другой процесс), пропускаю", flush=True)
                skipped += 1
                continue

        try:
            if contacts and contacts.lower() in reply.lower():
                import re as _re
                reply_without_contact = _re.sub(_re.escape(contacts), "", reply, flags=_re.IGNORECASE).strip()
                reply_without_contact = reply_without_contact.strip("—-,. ")
                if reply_without_contact:
                    send_message(token, chat_id, reply_without_contact)
                    time.sleep(random.uniform(2, 4))
                send_result = send_message(token, chat_id, contacts)
                status = send_result.get("_status")
                if status in (200, 201):
                    replied += 1
                    contacts_sent += 1
                    _log(f"{name}: ✓ контакт передан")
                else:
                    errors += 1
            else:
                send_result = send_message(token, chat_id, reply)
                status = send_result.get("_status")
                if status in (200, 201):
                    replied += 1
                    _log(f"{name}: ✓ ответ отправлен")
                else:
                    errors += 1
                    print(f"[TWINBY AUTO-REPLY] {name}: ✗ {send_result}", flush=True)
        except Exception as e:
            errors += 1
            print(f"[TWINBY AUTO-REPLY] {name}: ✗ {e}", flush=True)
            continue

        time.sleep(random.uniform(1, 3))

    return {
        "replied": replied,
        "skipped": skipped,
        "errors": errors,
        "contacts_sent": contacts_sent,
        "greeted": greeted,
    }
