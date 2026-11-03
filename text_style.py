# text_style.py — юникод-шрифты для AI-менеджера.
#
# Задача: если в карточке аналитика поле (имя / контакты) записано
# стилизованным юникод-шрифтом (𝓶𝓪𝓼𝓱𝓪, 𝗺𝗮𝘀𝗵𝗮, ᴍᴀsʜᴀ …), то в исходящем
# сообщении оно должно уйти ровно в том же виде — даже если модель
# переписала его обычными буквами.
#
# Ничего не импортирует кроме stdlib. Подключается в shared.py.

from __future__ import annotations

import re
import unicodedata

# ── Карты стилей ──────────────────────────────────────────────────────────
# base = (заглавные, строчные, цифры) — None значит «в этом стиле нет»
_BASES: dict[str, tuple[int | None, int | None, int | None]] = {
    "bold":              (0x1D400, 0x1D41A, 0x1D7CE),
    "italic":            (0x1D434, 0x1D44E, None),
    "bold_italic":       (0x1D468, 0x1D482, None),
    "script":            (0x1D49C, 0x1D4B6, None),
    "bold_script":       (0x1D4D0, 0x1D4EA, None),
    "fraktur":           (0x1D504, 0x1D51E, None),
    "bold_fraktur":      (0x1D56C, 0x1D586, None),
    "double_struck":     (0x1D538, 0x1D552, 0x1D7D8),
    "sans":              (0x1D5A0, 0x1D5BA, 0x1D7E2),
    "sans_bold":         (0x1D5D4, 0x1D5EE, 0x1D7EC),
    "sans_italic":       (0x1D608, 0x1D622, None),
    "sans_bold_italic":  (0x1D63C, 0x1D656, None),
    "mono":              (0x1D670, 0x1D68A, 0x1D7F6),
    "fullwidth":         (0xFF21,  0xFF41,  0xFF10),
}

# Дырки в Unicode: часть букв живёт вне основного блока.
_HOLES: dict[str, dict[str, str]] = {
    "italic": {"h": "ℎ"},
    "script": {
        "B": "ℬ", "E": "ℰ", "F": "ℱ", "H": "ℋ",
        "I": "ℐ", "L": "ℒ", "M": "ℳ", "R": "ℛ",
        "e": "ℯ", "g": "ℊ", "o": "ℴ",
    },
    "fraktur": {
        "C": "ℭ", "H": "ℌ", "I": "ℑ", "R": "ℜ",
        "Z": "ℨ",
    },
    "double_struck": {
        "C": "ℂ", "H": "ℍ", "N": "ℕ", "P": "ℙ",
        "Q": "ℚ", "R": "ℝ", "Z": "ℤ",
    },
}

# Стили без арифметической закономерности — задаём построчно.
_EXPLICIT: dict[str, dict[str, str]] = {
    "small_caps": dict(zip(
        "abcdefghijklmnopqrstuvwxyz",
        "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘꞯʀꜱᴛᴜᴠᴡxʏᴢ",
    )),
    "circled": {
        **dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                   "ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏ")),
        **dict(zip("abcdefghijklmnopqrstuvwxyz",
                   "ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ")),
        **dict(zip("0123456789", "⓪①②③④⑤⑥⑦⑧⑨")),
    },
}

_ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"
_DIGITS = "0123456789"


def _build_maps() -> dict[str, dict[str, str]]:
    maps: dict[str, dict[str, str]] = {}
    for style, (up, low, dig) in _BASES.items():
        m: dict[str, str] = {}
        if up is not None:
            for i, ch in enumerate(_ASCII_UPPER):
                m[ch] = chr(up + i)
        if low is not None:
            for i, ch in enumerate(_ASCII_LOWER):
                m[ch] = chr(low + i)
        if dig is not None:
            for i, ch in enumerate(_DIGITS):
                m[ch] = chr(dig + i)
        m.update(_HOLES.get(style, {}))
        maps[style] = m
    maps.update(_EXPLICIT)
    return maps


STYLE_MAPS: dict[str, dict[str, str]] = _build_maps()

# Обратная карта: стилизованный символ -> (стиль, обычный символ)
_REVERSE: dict[str, tuple[str, str]] = {}
for _style, _m in STYLE_MAPS.items():
    for _plain, _fancy in _m.items():
        _REVERSE.setdefault(_fancy, (_style, _plain))

STYLE_NAMES = ["plain", *STYLE_MAPS.keys()]


# ── Публичные функции ─────────────────────────────────────────────────────

def is_styled_char(ch: str) -> bool:
    """Символ из известного юникод-шрифта.

    Нужен фильтрам вроде _strip_foreign_script в shared.py: они режут всё,
    что не LATIN/CYRILLIC по имени в Unicode, а 𝓶 зовётся
    MATHEMATICAL BOLD SCRIPT SMALL M — и вылетает вместе с иероглифами.
    """
    return ch in _REVERSE


def strip_style(text: str) -> str:
    """Стилизованный текст -> обычные ASCII-буквы.

    '𝓶𝓪𝓼𝓱𝓪' -> 'masha'. Незнакомую экзотику добиваем через NFKD, но только
    выше 0x1000: иначе разложение съедает диакритику кириллицы и
    'онлайн' превращается в 'онлаин', а 'ёж' в 'еж'.
    """
    if not text:
        return ""
    out = []
    for ch in text:
        hit = _REVERSE.get(ch)
        if hit:
            out.append(hit[1])
            continue
        if ord(ch) < 0x1000:  # ASCII, кириллица, латиница с диакритикой
            out.append(ch)
            continue
        norm = unicodedata.normalize("NFKD", ch)
        norm = "".join(c for c in norm if not unicodedata.combining(c))
        out.append(norm or ch)
    return "".join(out)


def detect_style(text: str, min_ratio: float = 0.6) -> str | None:
    """Какой юникод-шрифт преобладает в строке. None — обычный текст.

    min_ratio — доля стилизованных букв среди всех буквенно-цифровых,
    ниже которой считаем, что шрифта нет (случайный символ не в счёт).
    """
    if not text:
        return None
    counts: dict[str, int] = {}
    total = 0
    for ch in text:
        hit = _REVERSE.get(ch)
        if hit:
            counts[hit[0]] = counts.get(hit[0], 0) + 1
            total += 1
        elif ch.isalnum():
            total += 1
    if not counts or not total:
        return None
    style, n = max(counts.items(), key=lambda kv: kv[1])
    return style if n / total >= min_ratio else None


def has_styled(text: str) -> bool:
    """Есть ли в строке хоть один символ юникод-шрифта.

    В отличие от detect_style не требует единого стиля: контактный блок
    вида '𝚃𝙰𝙳𝚄𝚂𝙷𝙰𝚂 𝘄𝗿𝗶𝘁𝗲 𝗺𝗲' смешивает моно и жирный, и «преобладающего»
    стиля там нет.
    """
    return any(ch in _REVERSE for ch in (text or ""))


def to_style(text: str, style: str | None) -> str:
    """Обычный текст -> стилизованный. Неизвестные символы не трогаем."""
    if not text or not style or style == "plain":
        return text
    m = STYLE_MAPS.get(style)
    if not m:
        return text
    return "".join(m.get(ch, ch) for ch in text)


def restyle(text: str, style: str | None) -> str:
    """Перевести текст в стиль `style`, предварительно сняв текущий."""
    return to_style(strip_style(text), style)


# ── Восстановление контактов/имени в ответе модели ────────────────────────

def _flex_pattern(plain: str) -> str:
    """Регулярка, которая найдёт `plain` в ответе, даже если модель:
    - написала его другим регистром,
    - вставила пробелы/точки между символами,
    - написала его своим юникод-шрифтом.
    """
    parts: list[tuple[bool, str]] = []  # (это буква/цифра, regex)
    for ch in plain:
        if ch.isalnum():
            variants = {re.escape(ch), re.escape(ch.upper()), re.escape(ch.lower())}
            for m in STYLE_MAPS.values():
                for c in (ch, ch.lower(), ch.upper()):
                    if c in m:
                        variants.add(re.escape(m[c]))
            parts.append((True, "(?:" + "|".join(sorted(variants)) + ")"))
        elif ch.isspace():
            parts.append((False, r"\s+"))
        else:
            parts.append((False, re.escape(ch) + "?"))

    # Разделитель вставляем только между двумя реальными символами, иначе
    # необязательная '@' в начале съедает пробел перед словом.
    body = ""
    for i, (is_alnum, rx) in enumerate(parts):
        if i and is_alnum and parts[i - 1][0]:
            body += r"[\s.\-_]?"
        body += rx
    # не даём зацепиться за середину другого слова
    return r"(?<![0-9A-Za-z])" + body + r"(?![0-9A-Za-z])"


def restore_styled(reply: str, sources: list[str] | tuple[str, ...]) -> str:
    """Главная функция.

    `sources` — значения полей карточки как их ввёл пользователь
    (contacts, bot_name, …). Для каждого стилизованного значения ищем в
    ответе модели его «расстилизованный» вариант и подменяем на оригинал.

    Модель почти всегда переписывает @𝓶𝓪𝓼𝓱𝓪 как @masha — эта функция
    возвращает исходное написание.
    """
    if not reply:
        return reply
    for src in sources or ():
        src = (src or "").strip()
        if not src:
            continue
        # Из поля вида "Telegram: @𝓶𝓪𝓼𝓱𝓪" нас интересуют сами токены,
        # а не подпись перед двоеточием: сам ярлык обычно без шрифта и
        # утянул бы долю стилизованных символов вниз.
        for token in _tokens(src):
            plain = strip_style(token)
            if len(plain.strip("@ ")) < 3:
                continue
            if token in reply:
                continue  # уже в нужном виде
            try:
                pat = re.compile(_flex_pattern(plain), re.IGNORECASE)
            except re.error:
                continue
            reply = pat.sub(lambda _m, t=token: t, reply)
    return reply


def _tokens(value: str) -> list[str]:
    """Режет значение поля на осмысленные куски: весь блок, @ник, имя.

    Целое значение идёт первым кандидатом — контактный блок «ник +
    сопроводительный текст» надо восстанавливать одним куском, иначе
    короткие слова внутри него останутся обычными.
    """
    out: list[str] = []
    whole = (value or "").strip()
    if whole and has_styled(whole):
        out.append(whole)
    for chunk in re.split(r"[,;\n]+", value):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" in chunk:
            chunk = chunk.split(":", 1)[1].strip() or chunk
        for piece in chunk.split():
            piece = piece.strip(" .!?()[]«»\"'")
            if piece and has_styled(piece):
                out.append(piece)
        if chunk and has_styled(chunk):
            out.append(chunk)
    # длинные токены первыми — чтобы не подменить часть внутри целого
    return sorted(set(out), key=len, reverse=True)
