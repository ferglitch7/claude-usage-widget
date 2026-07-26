"""Cliente del endpoint interno de uso de claude.ai.

Contrato descubierto via DevTools (Network) el 2026-07-02:

    GET https://claude.ai/api/organizations/{org_id}/usage

`org_id` no requiere una llamada aparte: viaja en la cookie `lastActiveOrg`.
La respuesta trae un array generico `limits[]`; cada entrada describe un
bloque de limite (sesion actual, semanal-todos-los-modelos, semanal-por-modelo
scoped como Fable). Iteramos ese array tal cual venga en vez de asumir que
existen bloques concretos, para que un plan sin Fable no rompa nada.
"""

from __future__ import annotations

import http.cookiejar
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import requests

BASE_URL = "https://claude.ai"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT_SECONDS = 10


class AuthError(Exception):
    """La sesion no es valida (401/403) o falta la cookie de organizacion."""


class UsageRequestError(Exception):
    """Fallo de red, HTTP inesperado, o respuesta que no es JSON valido."""


@dataclass
class LimitBlock:
    kind: str
    label: str
    percent: float
    resets_at: Optional[datetime]
    is_active: bool
    value_text: Optional[str] = None
    """Texto a mostrar en vez de "{percent}%" (ej. creditos: "USD 23.73 de USD 40.00")."""


def _get_org_id(cookiejar: http.cookiejar.CookieJar) -> Optional[str]:
    for cookie in cookiejar:
        if cookie.name == "lastActiveOrg":
            return cookie.value
    return None


def _label_for(entry: dict) -> str:
    kind = entry.get("kind")
    if kind == "session":
        return "Current session"
    if kind == "weekly_all":
        return "All models"
    if kind == "weekly_scoped":
        scope = entry.get("scope") or {}
        model = scope.get("model") or {}
        return model.get("display_name") or "Weekly (scoped)"
    return kind or "Unknown"


def _parse_resets_at(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def fetch_usage(cookiejar: http.cookiejar.CookieJar) -> list[LimitBlock]:
    """Consulta /api/organizations/{org_id}/usage y devuelve los bloques de limite.

    Lanza AuthError si falta la cookie de organizacion o el servidor responde
    401/403 (sesion rotada/expirada). Lanza UsageRequestError para fallos de
    red o respuestas que no son JSON (p.ej. un challenge de Cloudflare si
    cf_clearance quedo invalido).
    """
    org_id = _get_org_id(cookiejar)
    if org_id is None:
        raise AuthError("no se encontro la cookie 'lastActiveOrg'")

    url = f"{BASE_URL}/api/organizations/{org_id}/usage"
    headers = {
        "accept": "*/*",
        "content-type": "application/json",
        "referer": f"{BASE_URL}/new",
        "user-agent": USER_AGENT,
        "anthropic-client-platform": "web_claude_ai",
    }

    try:
        response = requests.get(
            url, cookies=cookiejar, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS
        )
    except requests.RequestException as exc:
        raise UsageRequestError(str(exc)) from exc

    if response.status_code in (401, 403):
        raise AuthError(f"sesion invalida (status {response.status_code})")
    response.raise_for_status()

    try:
        data = response.json()
    except ValueError as exc:
        raise UsageRequestError(f"respuesta no es JSON valido: {exc}") from exc

    blocks = []
    for entry in data.get("limits", []):
        blocks.append(
            LimitBlock(
                kind=entry.get("kind", ""),
                label=_label_for(entry),
                percent=float(entry.get("percent") or 0),
                resets_at=_parse_resets_at(entry.get("resets_at")),
                is_active=bool(entry.get("is_active")),
            )
        )

    spend = data.get("spend") or {}
    if spend.get("enabled"):
        used = spend.get("used") or {}
        limit = spend.get("limit") or {}
        used_amount = used.get("amount_minor", 0) / (10 ** used.get("exponent", 2))
        limit_amount = limit.get("amount_minor", 0) / (10 ** limit.get("exponent", 2))
        currency = used.get("currency", "USD")
        blocks.append(
            LimitBlock(
                kind="credits",
                label="Usage credits",
                percent=float(spend.get("percent") or 0),
                resets_at=None,
                is_active=True,
                value_text=f"{currency} {used_amount:.2f} de {currency} {limit_amount:.2f}",
            )
        )

    return blocks
