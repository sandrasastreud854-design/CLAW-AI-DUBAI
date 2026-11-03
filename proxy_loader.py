# proxy_loader.py
from shared import supabase as _client

_cache = {}
_cache_ttl = 60  # секунд
import time

def get_proxy(platform: str) -> dict:
    """Возвращает прокси для платформы из Supabase. Кэш 60 сек."""
    now = time.time()
    if platform in _cache and now - _cache[platform]["_ts"] < _cache_ttl:
        return _cache[platform]

    try:
        res = _client.table("proxy_settings").select("*").eq("id", platform).execute()
        if res.data:
            row = res.data[0]
            row["_ts"] = now
            _cache[platform] = row
            return row
    except Exception as e:
        print(f"[PROXY] Ошибка загрузки прокси для {platform}: {e}")

    # Фолбек — пустой прокси
    return {"use_proxy": False, "_ts": now}
