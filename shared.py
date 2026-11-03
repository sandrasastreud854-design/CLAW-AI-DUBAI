# shared.py — общий код для всех микросерверов CLAW-DATYNG
import json
import os
import re
import secrets
import threading
import time
import uuid
import unicodedata
import http.client
from datetime import datetime
from pathlib import Path
from typing import Any

import bcrypt
import httpx
from supabase import create_client, Client
from supabase.client import ClientOptions

from text_style import is_styled_char, restore_styled, strip_style

# ── Supabase ──────────────────────────────────────────────

SUPABASE_URL = "https://cfystxxxafopwqpfdumw.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmeXN0eHh4YWZvcHdxcGZkdW13Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MzcxNTIzMywiZXhwIjoyMTA5MjkxMjMzfQ.99zv4GQnhGNGe0pzR_MiaFtFJz7YEg1pTX0_fZc9kjc"

_supabase_http_client = httpx.Client(http2=False, timeout=30.0)
supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_KEY,
    options=ClientOptions(httpx_client=_supabase_http_client),
)

LEADS_SUPABASE_URL = "https://cfystxxxafopwqpfdumw.supabase.co"
LEADS_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmeXN0eHh4YWZvcHdxcGZkdW13Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MzcxNTIzMywiZXhwIjoyMTA5MjkxMjMzfQ.99zv4GQnhGNGe0pzR_MiaFtFJz7YEg1pTX0_fZc9kjc"

_leads_http_client = httpx.Client(http2=False, timeout=30.0)
leads_supabase: Client = create_client(
    LEADS_SUPABASE_URL,
    LEADS_SUPABASE_KEY,
    options=ClientOptions(httpx_client=_leads_http_client),
)

TELEGRAM_BOT_TOKEN = ""
ACCESS_CODE = "VIPDATYNG3906"

# ── Paths ─────────────────────────────────────────────────

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# ── Auth ──────────────────────────────────────────────────

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except Exception:
        return False

def create_session(user_id: str, email: str) -> str:
    token = secrets.token_urlsafe(32)
    supabase.table("app_sessions").insert({
        "token": token,
        "user_id": user_id,
        "email": email,
    }).execute()
    return token

def get_session(token: str) -> dict | None:
    try:
        res = supabase.table("app_sessions").select("*").eq("token", token).execute()
        if not res.data:
            return None
        row = res.data[0]
        return {"user_id": row.get("user_id"), "email": row.get("email")}
    except Exception as e:
        print("get_session error:", repr(e))
        return None

def require_auth(authorization: str | None) -> dict:
    from fastapi import HTTPException
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Не авторизован")
    token = authorization[len("Bearer "):].strip()
    session = get_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Сессия недействительна")
    return session

# ── Team helpers ──────────────────────────────────────────

_team_cache: dict[str, tuple] = {}
_TEAM_TTL = 60        # состав команды меняется редко, чаще раза в минуту не спрашиваем


def get_team_owner_emails(email: str) -> list[str]:
    _hit = _team_cache.get(email)
    if _hit and time.time() - _hit[0] < _TEAM_TTL:
        return _hit[1]
    owner_emails = {email}
    member_res = supabase.table("team_members").select("owner_email").eq("member_email", email).eq("status", "active").execute()
    for row in member_res.data or []:
        owner_emails.add(row["owner_email"])
    owned_team_res = supabase.table("team_members").select("member_email").eq("owner_email", email).eq("status", "active").execute()
    for row in owned_team_res.data or []:
        owner_emails.add(row["member_email"])
    result = list(owner_emails)
    _team_cache[email] = (time.time(), result)
    return result

# ── AI Settings ───────────────────────────────────────────

def default_ai_settings() -> dict:
    return {
        "groq_api_key": "", "groq_api_keys": "", "groq_model": "openai/gpt-oss-120b",
        "bot_name": "", "bot_age": "", "bot_gender": "female", "location": "",
        "persona": "", "goal": "", "stop_topics": "", "contacts": "",
        "contacts_trigger": "", "tg_chat_id": "", "gemini_api_keys": "", "updated_at": None,
        "proxy_protocol": "", "proxy_host": "", "proxy_port": "", "proxy_login": "",
        "proxy_password": "", "user_agent": "",
    }

def get_ai_settings(account_id: str) -> dict:
    res = supabase.table("ai_settings").select("*").eq("account_id", account_id).execute()
    if res.data:
        return {**default_ai_settings(), **res.data[0]}
    return default_ai_settings()

def save_ai_settings(account_id: str, payload: dict) -> dict:
    merged = {**default_ai_settings(), **payload, "account_id": account_id, "updated_at": datetime.now().isoformat()}
    existing = supabase.table("ai_settings").select("account_id").eq("account_id", account_id).execute()
    if existing.data:
        supabase.table("ai_settings").update(merged).eq("account_id", account_id).execute()
    else:
        supabase.table("ai_settings").insert(merged).execute()
    return merged

def get_groq_keys(settings: dict) -> list[str]:
    multi = (settings.get("groq_api_keys") or "").strip()
    if multi:
        keys = [k.strip() for k in multi.splitlines() if k.strip()]
    else:
        single = (settings.get("groq_api_key") or "").strip()
        keys = [single] if single else []
    # OpenRouter отключён: его бесплатные модели рассуждают по-английски.
    groq_only = [k for k in keys if not k.lower().startswith("sk-or-")]
    if groq_only:
        return groq_only
    return keys

def get_gemini_keys(settings: dict) -> list[str]:
    multi = (settings.get("gemini_api_keys") or "").strip()
    return [k.strip() for k in multi.splitlines() if k.strip()]

# ── Groq / Gemini ─────────────────────────────────────────

_groq_key_index: dict[str, int] = {}
_groq_key_dead: dict[str, float] = {}   # ключ -> когда признан мёртвым
_GROQ_KEY_DEAD_TTL = 30 * 60            # полчаса не трогаем
_groq_key_exhausted_at: dict[str, float] = {}
GROQ_KEY_COOLDOWN_SECONDS = 60 * 60
_groq_key_reset_date: str = ""

def _reset_groq_keys_if_new_day():
    global _groq_key_index, _groq_key_reset_date
    today = datetime.now().strftime("%Y-%m-%d")
    if _groq_key_reset_date != today:
        _groq_key_reset_date = today
        _groq_key_index = {}

def is_key_exhausted(error_msg: str) -> bool:
    msg = (error_msg or "").lower()
    return any(w in msg for w in [
        "rate_limit", "rate limit", "quota", "exceeded", "limit reached", "429",
        "restricted", "invalid api key", "invalid_api_key", "401", "403",
        "forbidden", "account is", "disabled",
        "organization has been", "suspended", "deactivated",
        # OpenRouter
        "402", "requires more credits", "insufficient credit", "insufficient_quota",
        "no endpoints found", "not enough credits", "never purchased", "purchase more",
        "does not exist", "model_not_found", "model not found", "do not have access",
        "user not found", "invalid_request_error",
        "inference is blocked", "blocked on this account", "openrouter.ai",
    ])

def _has_foreign_script(text: str) -> bool:
    for ch in text:
        if ch.isspace() or not ch.isalpha():
            continue
        if is_styled_char(ch):
            continue  # юникод-шрифт из карточки — это не иероглиф
        try:
            name = unicodedata.name(ch)
        except ValueError:
            continue
        if not (name.startswith("CYRILLIC") or name.startswith("LATIN")):
            return True
    return False

def _strip_foreign_script(text: str) -> str:
    result = []
    for ch in text:
        if ch.isalpha() and not is_styled_char(ch):
            try:
                name = unicodedata.name(ch)
            except ValueError:
                result.append(ch)
                continue
            if name.startswith("CYRILLIC") or name.startswith("LATIN"):
                result.append(ch)
        else:
            result.append(ch)
    return re.sub(r"\s{2,}", " ", "".join(result)).strip()

# Авто-роутер openrouter/free сюда не ставить: он подсовывает рассуждающие
# модели, те съедают max_tokens на размышления и возвращают пустой content.
OPENROUTER_MODEL_FALLBACKS = [
    "nvidia/nemotron-3.5-lightning:free",
    "dots-studio/dots-3-note-preview:free",
    "thinkingmachines/inkling-small:free",
    "liquid/lfm-2.5-2.6b:free",
    "meta-llama/llama-3.3-70b-instruct",
]
OPENROUTER_FALLBACK_MODEL = OPENROUTER_MODEL_FALLBACKS[0]

def _is_openrouter_key(api_key: str) -> bool:
    return (api_key or "").strip().lower().startswith("sk-or-")

def call_groq(api_key: str, model: str, system_prompt: str, messages: list[dict],
              skip_words: list[str] | None = None) -> str:
    if not api_key:
        raise ValueError("Groq API ключ не задан")

    is_openrouter = _is_openrouter_key(api_key)
    use_model = model or "openai/gpt-oss-20b"
    # Проверка "нет слэша" перестала работать, когда groq-модели стали
    # называться openai/gpt-oss-* — сверяемся со списком напрямую
    if is_openrouter and use_model not in OPENROUTER_MODEL_FALLBACKS:
        use_model = OPENROUTER_FALLBACK_MODEL

    body_data = {
        "model": use_model,
        "messages": [{"role": "system", "content": system_prompt}] + messages,
        "temperature": 0.8,
    }
    if is_openrouter:
        body_data["max_tokens"] = 80
        body_data["reasoning"] = {"exclude": True}
    else:
        # gpt-oss — reasoning-модель: размышления тоже тратят токены.
        # Со старым лимитом 80 они съедали весь бюджет и content приходил пустой.
        body_data["max_completion_tokens"] = 512
        body_data["reasoning_effort"] = "low"
        body_data["reasoning_format"] = "hidden"
    payload = json.dumps(body_data, ensure_ascii=False).encode("utf-8")

    host = "openrouter.ai" if is_openrouter else "api.groq.com"
    path = "/api/v1/chat/completions" if is_openrouter else "/openai/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "Content-Length": str(len(payload)),
    }
    if is_openrouter:
        headers["HTTP-Referer"] = "https://claw-ai-manager.local"
        headers["X-Title"] = "CLAW-AI Manager"

    conn = http.client.HTTPSConnection(host, timeout=30)
    try:
        conn.request("POST", path, body=payload, headers=headers)
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="ignore")
    finally:
        conn.close()
    try:
        data = json.loads(body)
    except Exception:
        raise RuntimeError(f"{'OpenRouter' if is_openrouter else 'Groq'} вернул не-JSON (HTTP {resp.status}): {body[:200]}")
    if resp.status >= 400:
        err_msg = (data.get("error") or {}).get("message") or f"{'OpenRouter' if is_openrouter else 'Groq'} error {resp.status}"
        raise RuntimeError(err_msg)
    _choice = (data.get("choices") or [{}])[0] or {}
    _msg = _choice.get("message") or {}
    # Поле reasoning — это размышления модели, а не реплика.
    # Раньше оно шло в чат как запасной вариант и палило бота.
    content = (_msg.get("content") or "").strip()
    content = re.sub(r"<think(?:ing)?>.*?</think(?:ing)?>", "", content, flags=re.DOTALL | re.IGNORECASE).strip()
    content = re.sub(r"<think(?:ing)?>.*", "", content, flags=re.DOTALL | re.IGNORECASE).strip()
    content = re.sub(r"</?think(?:ing)?>", "", content, flags=re.IGNORECASE).strip()
    if _has_foreign_script(content):
        content = _strip_foreign_script(content)
    if len(content) < 2 or content in [".", ",", "!", "?", "-", "—"]:
        return ""

    # Два английских слова подряд — рассуждение модели, не реплика.
    # Контакт анкеты латиницей под это правило попадать не должен.
    _check = content
    for _w in (skip_words or []):
        if _w:
            _check = _check.replace(_w, " ")
    if re.search(r"\b[A-Za-z]{2,}\s+[A-Za-z]{2,}\b", _check):
        print(f"[GROQ] Английский текст, отброшен: {content[:120]!r}", flush=True)
        return ""

    _is_contact = content.strip().lower() in (system_prompt or "").lower()
    if not _is_contact:
        if len(content) > 170:
            print(f"[GROQ] Слишком длинно ({len(content)}) — кусок промта, отброшен", flush=True)
            return ""
        if re.search(r"[А-ЯЁ]{4,}", content):
            print(f"[GROQ] КАПС из промта, отброшен: {content[:100]!r}", flush=True)
            return ""
        if re.match(r"^\s*\d+\s*[.)]\s", content):
            print(f"[GROQ] Пункт инструкции, отброшен: {content[:100]!r}", flush=True)
            return ""
        _instr = [
            "правило", "случай а", "случай б", "вариант ответа", "промт",
            "инструкц", "запрещено", "обязана", "нужно ответить", "нужно убе",
            "ответ должен", "не здоровайся", "отвечу тепло", "так что отвечу",
            "в этом случае", "первый ответ", "это твой", "выбрать один из",
            "предложенных вариантов", "не копируй", "перефразируй",
        ]
        if any(w in content.lower() for w in _instr):
            print(f"[GROQ] Текст промта в ответе, отброшен: {content[:100]!r}", flush=True)
            return ""

    return content

def call_gemini(api_key: str, system_prompt: str, messages: list[dict]) -> str:
    contents = []
    contents.append({"role": "user", "parts": [{"text": system_prompt}]})
    contents.append({"role": "model", "parts": [{"text": "Поняла, буду следовать инструкциям."}]})
    for msg in messages:
        role = "model" if msg["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": msg["content"]}]})
    payload = json.dumps({
        "contents": contents,
        "generationConfig": {"maxOutputTokens": 80, "temperature": 0.8},
    }, ensure_ascii=False).encode("utf-8")
    conn = http.client.HTTPSConnection("generativelanguage.googleapis.com", timeout=30)
    try:
        conn.request("POST", f"/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}",
                     body=payload, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="ignore")
    finally:
        conn.close()
    data = json.loads(body)
    if resp.status >= 400:
        err = (data.get("error") or {}).get("message") or f"Gemini error {resp.status}"
        raise RuntimeError(f"Gemini: {err}")
    try:
        content = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError):
        return ""
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
    if _has_foreign_script(content):
        content = _strip_foreign_script(content)
    if len(content) < 2:
        return ""
    return content

def call_gemini_with_rotation(account_id: str, settings: dict, system_prompt: str, messages: list[dict]) -> str:
    keys = get_gemini_keys(settings)
    if not keys:
        raise RuntimeError("Gemini ключи не заданы")
    _gemini_key_index = getattr(call_gemini_with_rotation, "_index", {})
    start = _gemini_key_index.get(account_id, 0) % len(keys)
    _gemini_key_index[account_id] = start
    call_gemini_with_rotation._index = _gemini_key_index
    for attempt in range(len(keys)):
        idx = _gemini_key_index[account_id] % len(keys)
        key = keys[idx]
        try:
            return call_gemini(key, system_prompt, messages)
        except RuntimeError as e:
            if is_key_exhausted(str(e)):
                _gemini_key_index[account_id] = (idx + 1) % len(keys)
                continue
            raise
    raise RuntimeError("Все Gemini ключи исчерпаны")

def call_openrouter(api_key: str, system_prompt: str, messages: list[dict]) -> str:
    if not api_key:
        raise RuntimeError("OpenRouter API key not set")
    payload = json.dumps({
        "model": OPENROUTER_FALLBACK_MODEL,
        "messages": [{"role": "system", "content": system_prompt}] + messages,
        "max_tokens": 80,
        "temperature": 0.8,
        "reasoning": {"exclude": True},
    }, ensure_ascii=False)
    conn = http.client.HTTPSConnection("openrouter.ai", timeout=30)
    try:
        conn.request("POST", "/api/v1/chat/completions", body=payload, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        })
        resp = conn.getresponse()
        data = json.loads(resp.read().decode())
        if "error" in data:
            raise RuntimeError(f"OpenRouter error: {data['error']}")
        _c = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        _c = re.sub(r"<think>.*?</think>", "", _c, flags=re.DOTALL).strip()
        if _has_foreign_script(_c):
            _c = _strip_foreign_script(_c)
        if len(_c) < 2 or _c in [".", ",", "!", "?", "-", "—"]:
            return ""
        return _c
    finally:
        conn.close()

def _apply_card_font(reply: str, settings: dict) -> str:
    """Возвращает в ответ модели точное написание полей карточки.

    Модель почти всегда перепишет @𝓶𝓪𝓼𝓱𝓪 обычными буквами — здесь чиним.
    """
    if not reply:
        return reply
    try:
        return restore_styled(reply, [
            settings.get("contacts") or "",
            settings.get("bot_name") or "",
        ])
    except Exception as e:
        print(f"[FONT] restore_styled упал: {e}", flush=True)
        return reply


def call_groq_with_rotation(account_id: str, settings: dict, system_prompt: str, messages: list[dict]) -> str:
    _reset_groq_keys_if_new_day()
    keys = get_groq_keys(settings)
    if not keys:
        raise ValueError("Groq API ключи не заданы в настройках анкеты")
    model = settings.get("groq_model") or "openai/gpt-oss-120b"
    if account_id not in _groq_key_index:
        _groq_key_index[account_id] = 0
    for attempt in range(len(keys)):
        now = time.time()
        for k in list(_groq_key_exhausted_at.keys()):
            if now - _groq_key_exhausted_at[k] >= GROQ_KEY_COOLDOWN_SECONDS:
                del _groq_key_exhausted_at[k]
        idx = _groq_key_index[account_id] % len(keys)
        key = keys[idx]
        skipped = 0
        while key in _groq_key_exhausted_at and skipped < len(keys):
            _groq_key_index[account_id] = (idx + 1) % len(keys)
            idx = _groq_key_index[account_id]
            key = keys[idx]
            skipped += 1
        try:
            _skip = [
                strip_style((settings.get("contacts") or "").strip()),
                (settings.get("contacts") or "").strip(),
                strip_style((settings.get("contacts") or "").strip()).lstrip("@"),
            ]
            return _apply_card_font(
                call_groq(key, model, system_prompt, messages, skip_words=_skip), settings)
        except Exception as e:
            err = str(e)
            if is_key_exhausted(err):
                _groq_key_dead[key] = time.time()
                print(f"[GROQ] Ключ #{idx + 1}/{len(keys)} исчерпан ({err[:120]}), переключаюсь...", flush=True)
                _groq_key_exhausted_at[key] = time.time()
                _groq_key_index[account_id] = (idx + 1) % len(keys)
                continue
            if isinstance(e, RuntimeError):
                raise
            print(f"[GROQ] Ключ #{idx + 1}/{len(keys)} — сбой связи ({type(e).__name__}: {err[:120]}), пробую следующий", flush=True)
            _groq_key_index[account_id] = (idx + 1) % len(keys)
            continue
    raise RuntimeError(f"Все {len(keys)} Groq API ключей исчерпаны")

# ── System prompt ─────────────────────────────────────────

def build_system_prompt(s: dict, platform: str = "") -> str:
    gender = s.get("bot_gender", "female")
    gender_word = "девушка" if gender == "female" else "парень"
    name = (s.get("bot_name") or "").strip()
    age = (s.get("bot_age") or "").strip()
    location = (s.get("location") or "").strip()
    persona = (s.get("persona") or "").strip()
    goal = (s.get("goal") or "").strip()
    stop_topics = (s.get("stop_topics") or "").strip()
    # В промпт контакт уходит обычными буквами — юникод-шрифт съедает
    # лишние токены и путает модель. Стиль вернёт _apply_card_font.
    contact = strip_style((s.get("contacts") or "").strip())
    contact_enabled = bool(contact and s.get("contacts_trigger"))

    identity = [f"Ты реальная живая {gender_word} на сайте знакомств."]
    if name:
        identity.append(f"Тебя зовут {name}.")
    if age:
        identity.append(f"Тебе {age} лет.")
    parts = [" ".join(identity)]

    if location:
        city = location.split(",")[0].strip()
        parts.append(f"ЛОКАЦИЯ: {location}. На 'откуда/какой город/где живёшь' отвечай только '{city}'.")

    if persona:
        parts.append(f"ХАРАКТЕР И СТИЛЬ: {persona}")
    if goal:
        parts.append(f"ЦЕЛЬ: {goal}")
    if stop_topics:
        parts.append(f"НЕ ОБСУЖДАЙ: {stop_topics}")

    if contact_enabled:
        if (platform or "").lower() == "atolin":
            parts.append(
                f"КОНТАКТ: твой точный контакт — {contact}. "
                "Давай его только когда человек согласился перейти в другое место "
                "или сам предложил обменяться контактами. "
                "НИКОГДА не пиши названий мессенджеров и соцсетей "
                "(тг, телеграм, вотсап, вайбер, вк, инстаграм) "
                "и слов «юзер», «ник», «никнейм», «логин», «аккаунт». "
                f"Контакт даёшь только внутри фразы, одним сообщением. "
                f"Формат: 'давай, так даже лучше будет {contact}'."
            )
        else:
            parts.append(
                f"ТЕЛЕГРАМ: твой точный контакт — {contact}. "
                "Давай его сразу, если человек просит тг/контакт; предлагает встречу; "
                "сам прислал контакт; просит фото; спрашивает цену, условия или что входит. "
                f"Формат: 'лови тг {contact}, там спишемся'."
            )

    parts.append(
        f"ОТВЕТ: 1-2 коротких предложения, как обычная {gender_word}. "
        "Без списков, официоза и обращения по имени. "
        "На грубость — холодно, на намёк — игриво. Не поняла — 'это как?'."
    )

    return "\n\n".join(parts)

# ── Task log ──────────────────────────────────────────────

def append_task_log(entry: dict) -> dict:
    record = {
        "id": f"task_{uuid.uuid4().hex[:12]}",
        "created_at": datetime.now().isoformat(),
        "account_id": entry.get("account_id"),
        "type": entry.get("type"),
        "liked": int(entry.get("liked") or 0),
        "skipped": int(entry.get("skipped") or 0),
        "errors": int(entry.get("errors") or 0),
        "replied": int(entry.get("replied") or 0),
        "greeted": int(entry.get("greeted") or 0),
        "contacts_sent": int(entry.get("contacts_sent") or 0),
        "sent": int(entry.get("sent") or 0),
        "failed": int(entry.get("failed") or 0),
        "summary": entry.get("summary", ""),
    }
    try:
        supabase.table("tasks_log").insert(record).execute()
    except Exception as e:
        print("[TASK_LOG] Ошибка записи:", repr(e), flush=True)
    return record

# ── Block / Chain ─────────────────────────────────────────

def mark_account_blocked(account_id: str) -> dict:
    try:
        supabase.table("accounts").update({
            "is_blocked": True,
            "blocked_at": datetime.now().isoformat(),
            "block_reason": "Profile blocked or photo confirmation required",
            "run_status": "idle",
            "run_task": "",
            "run_note": "Анкета заблокирована",
        }).eq("id", account_id).execute()
        print(f"[BLOCKED] Анкета {account_id} отмечена заблокированной", flush=True)
        return {"ok": False, "reserve_account_id": None, "reason": "blocked"}
    except Exception as e:
        print(f"[BLOCKED] Ошибка: {e}", flush=True)
        return {"ok": False, "reserve_account_id": None, "reason": str(e)}

# ── Telegram ──────────────────────────────────────────────

def normalize_telegram(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"^(?:https?://)?(?:www\.)?(?:t\.me/|telegram\.me/)", "", value)
    return value.lstrip("@").rstrip("/").strip()

def telegram_was_sent(user_id: str, telegram: str) -> bool:
    telegram = normalize_telegram(telegram)
    if not user_id or not telegram:
        return False
    result = supabase.table("telegram_delivery_log").select("id").eq("platform", "mamba").eq("user_id", str(user_id)).eq("telegram", telegram).limit(1).execute()
    return bool(result.data)

def reserve_telegram_send(user_id: str, telegram: str, account_id: str) -> bool:
    telegram = normalize_telegram(telegram)
    try:
        supabase.table("telegram_delivery_log").insert({
            "platform": "mamba",
            "user_id": str(user_id),
            "telegram": telegram,
            "account_id": str(account_id),
        }).execute()
        return True
    except Exception as exc:
        error_text = str(exc).lower()
        if "23505" in error_text or "duplicate" in error_text:
            return False
        raise

def cancel_telegram_reservation(user_id: str, telegram: str, account_id: str):
    telegram = normalize_telegram(telegram)
    supabase.table("telegram_delivery_log").delete().eq("platform", "mamba").eq("user_id", str(user_id)).eq("telegram", telegram).eq("account_id", str(account_id)).execute()

# ── Cancel flags ──────────────────────────────────────────

CANCEL_FLAGS: dict[str, bool] = {}
ACTIVE_JOB_IDS: dict[str, str] = {}

def should_cancel(account_id: str, job_id: str | None = None) -> bool:
    if CANCEL_FLAGS.get(account_id, False):
        return True
    job_id = job_id or ACTIVE_JOB_IDS.get(account_id)
    if not job_id:
        return False
    try:
        res = supabase.table("job_queue").select("status").eq("id", job_id).limit(1).execute()
        return bool(res.data and res.data[0].get("status") == "cancelled")
    except Exception:
        return False

def push_split_log_sync(account_id: str, message: str):
    try:
        owner_res = supabase.table("accounts").select("owner_email").eq("id", account_id).limit(1).execute()
        owner_email = owner_res.data[0].get("owner_email") if owner_res.data else ""
        supabase.table("split_logs").insert({
            "owner_email": owner_email or "",
            "account_id": account_id,
            "message": message,
        }).execute()
    except Exception as e:
        print(f"[SPLIT_LOG] Ошибка: {e}", flush=True)

# ── Галочки «лайкать» / «отвечать» с карточки анкеты ──────
# Воркер зовёт gate_job перед работой: если галочка выключена,
# задача либо подменяется на другую, либо отменяется.

def get_run_opts(account_id: str) -> tuple[bool, bool, int]:
    """(ставить лайки, отвечать в чатах, лимит лайков за круг)"""
    try:
        r = (supabase.table("run_schedules")
             .select("do_likes, do_chats, limit_likes")
             .eq("account_id", account_id).limit(1).execute())
        row = (r.data or [{}])[0]
    except Exception as e:
        print(f"[RUN-OPTS] не прочитал run_schedules: {e}", flush=True)
        row = {}
    return (row.get("do_likes") is not False,
            row.get("do_chats") is not False,
            int(row.get("limit_likes") or 10))


def gate_job(account_id: str, job_type: str) -> str:
    """Что делать с задачей: тот же тип, подменённый, или "" — не делать."""
    do_likes, do_chats, _ = get_run_opts(account_id)
    is_likes = job_type in ("likes", "likes-http")
    is_chats = job_type in ("auto-reply", "auto-reply-http")

    if is_likes and not do_likes:
        return "auto-reply-http" if do_chats else ""
    if is_chats and not do_chats:
        return "likes-http" if do_likes else ""
    return job_type
