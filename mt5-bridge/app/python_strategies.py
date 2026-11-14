"""Accept Python strategy files (and JSON bundles that wrap them).

The desk has two kinds of Python input:

* **runnable** — a file that defines ``on_bar(ctx)``. The bridge replays it on
  the broker's bars inside an isolated subprocess with a restricted set of
  builtins and imports, so a strategy can be backtested without being allowed
  to touch the network, the filesystem or the terminal.
* **external** — a full expert advisor that imports ``MetaTrader5`` and places
  its own orders. It is registered so it can be tracked, but the bridge refuses
  to pretend it can replay it: doing so would need the terminal itself.

Analysis never executes the file. It parses the AST, reads module-level
``META``/``SYMBOL`` literals and reports exactly what it found.
"""

from __future__ import annotations

import ast
import json
import re
from typing import Any

from .models import TF_MINUTES

MAX_CODE_BYTES = 400_000

# Imports a sandboxed strategy may use. Everything else is rejected before the
# code ever runs: no filesystem, no sockets, no process control, no terminal.
ALLOWED_IMPORTS = {
    "math",
    "statistics",
    "datetime",
    "typing",
    "dataclasses",
    "enum",
    "collections",
    "itertools",
    "functools",
    "decimal",
    "json",
    "re",
    "random",
}

# Names that would let strategy code escape the sandbox or reach the machine.
BANNED_CALLS = {
    "eval",
    "exec",
    "compile",
    "__import__",
    "globals",
    "locals",
    "vars",
    "getattr",
    "setattr",
    "delattr",
    "input",
    "breakpoint",
    "open",
    "memoryview",
    "object",
    "type",
}

BANNED_MODULES = {
    "os",
    "sys",
    "subprocess",
    "socket",
    "ssl",
    "shutil",
    "pathlib",
    "tempfile",
    "glob",
    "importlib",
    "ctypes",
    "multiprocessing",
    "threading",
    "asyncio",
    "signal",
    "pickle",
    "marshal",
    "shelve",
    "sqlite3",
    "urllib",
    "http",
    "ftplib",
    "smtplib",
    "requests",
    "httpx",
    "builtins",
    "gc",
    "inspect",
    "webbrowser",
    "winreg",
    "MetaTrader5",
}

MT5_CALLS = {
    "initialize",
    "shutdown",
    "order_send",
    "orders_get",
    "positions_get",
    "history_deals_get",
    "copy_rates_from_pos",
    "copy_rates_range",
    "copy_ticks_from",
    "symbol_info",
    "symbol_info_tick",
    "symbol_select",
    "account_info",
}

_PYTHON_KEYS = ("source", "code", "content", "python", "script", "text")
_SLUG_RE = re.compile(r"[^a-z0-9]+")


class PythonStrategyError(ValueError):
    """Raised when a file cannot be turned into a Python strategy."""


class AnalysisError(ValueError):
    """A structured analysis failure with per-field messages."""

    def __init__(self, errors: list[dict], *, mode: str = "python") -> None:
        super().__init__("; ".join(e["msg"] for e in errors) or "invalid Python strategy")
        self.errors = errors
        self.mode = mode


def _looks_like_python(text: str) -> bool:
    return bool(re.search(r"^\s*(?:def|class|import|from|async\s+def)\s+\w", text, re.M))


def _meta_dict(data: dict) -> dict:
    meta = data.get("metadata")
    return meta if isinstance(meta, dict) else {}


def extract_python(payload: Any) -> tuple[str, str | None]:
    """Pull Python source out of a raw string or a converter-style JSON bundle."""
    if isinstance(payload, str):
        raw = payload.strip()
        if not raw:
            raise PythonStrategyError("The file is empty.")
        if raw.startswith("{"):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                return raw, None
            return extract_python(parsed)
        return raw, None

    if isinstance(payload, dict):
        data = payload
        for wrapper in ("payload", "file", "document", "data"):
            inner = data.get(wrapper)
            if isinstance(inner, dict):
                data = inner
                break
        if isinstance(data.get("strategy"), dict):
            data = data["strategy"]
        if isinstance(data.get("value"), str) and _looks_like_python(data["value"]):
            return data["value"], data.get("filename")
        if isinstance(data.get("strategy"), str) and _looks_like_python(data["strategy"]):
            return data["strategy"], data.get("filename")

        meta = _meta_dict(data)
        filename = (
            data.get("filename")
            or data.get("fileName")
            or meta.get("source_file")
            or meta.get("file")
            or meta.get("sourceFile")
        )

        for key in _PYTHON_KEYS:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                if key in {"source", "code", "python", "script"} or _looks_like_python(value):
                    return value, filename if isinstance(filename, str) else None

        files = data.get("files")
        if isinstance(files, list):
            for item in files:
                if not isinstance(item, dict):
                    continue
                content = item.get("content") or item.get("source") or item.get("code")
                if isinstance(content, str) and content.strip():
                    name = item.get("name") or item.get("filename") or filename
                    return content, name if isinstance(name, str) else None

        source = data.get("source")
        if isinstance(source, dict):
            for key in ("code", "content", "text"):
                if isinstance(source.get(key), str) and source[key].strip():
                    return source[key], filename if isinstance(filename, str) else None

    raise PythonStrategyError("No Python source was found in this file.")


def _literal_assignments(tree: ast.Module) -> dict[str, Any]:
    found: dict[str, Any] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        try:
            found[target.id] = ast.literal_eval(node.value)
        except (ValueError, SyntaxError):
            continue
    return found


def slugify(value: str, fallback: str = "python-strategy") -> str:
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    slug = slug[:64].strip("-")
    if len(slug) < 2:
        slug = fallback
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,63}", slug):
        slug = fallback
    return slug


def _walk_risk(meta: dict) -> dict:
    raw = meta.get("risk")
    risk: dict[str, Any] = {"riskPct": 1.0, "maxPositions": 1}
    if isinstance(raw, dict):
        for key, low, high in (("riskPct", 0.05, 10.0), ("maxLots", 0.01, 100.0)):
            value = raw.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                risk[key] = max(low, min(high, float(value)))
        positions = raw.get("maxPositions")
        if isinstance(positions, int) and 1 <= positions <= 10:
            risk["maxPositions"] = positions
    elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
        risk["riskPct"] = max(0.05, min(10.0, float(raw)))
    return risk


def _describe(doc: str | None, mode: str) -> str:
    first = ""
    if doc:
        for line in doc.strip().splitlines():
            text = line.strip()
            if text:
                first = text
                break
    if mode == "external":
        base = (
            "Python expert advisor that drives MetaTrader 5 itself. Registered as an "
            "external strategy: the bridge keeps its source and metadata, but cannot "
            "replay it on bar history because it places its own orders."
        )
    else:
        base = "Python strategy replayed by the bridge's sandboxed on_bar runner."
    return (base + (f" {first}" if first else ""))[:600]


def _scan(tree: ast.Module) -> dict:
    imports: list[str] = []
    mt5_modules: set[str] = set()
    mt5_names: set[str] = set()
    banned_imports: list[str] = []
    banned_calls: list[str] = []
    dunder_attrs: list[str] = []
    has_on_bar = False

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                imports.append(alias.name)
                if root == "MetaTrader5":
                    mt5_modules.add(alias.asname or "MetaTrader5")
                elif root in BANNED_MODULES:
                    banned_imports.append(alias.name)
                elif root not in ALLOWED_IMPORTS and alias.name not in ALLOWED_IMPORTS:
                    banned_imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            root = module.split(".")[0]
            imports.append(module)
            if root == "MetaTrader5":
                for alias in node.names:
                    mt5_names.add(alias.asname or alias.name)
            elif root in BANNED_MODULES:
                banned_imports.append(module)
            elif root not in ALLOWED_IMPORTS:
                banned_imports.append(module)
        elif isinstance(node, ast.FunctionDef) and node.name == "on_bar":
            has_on_bar = True
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__") and node.attr != "__name__":
            dunder_attrs.append(node.attr)
        elif isinstance(node, ast.Call):
            func = node.func
            name = ""
            if isinstance(func, ast.Name):
                name = func.id
            elif isinstance(func, ast.Attribute):
                name = func.attr
                base = func.value
                if isinstance(base, ast.Name) and (
                    base.id in mt5_modules or base.id in mt5_names
                ):
                    mt5_modules.add(base.id)
            if name in BANNED_CALLS:
                banned_calls.append(name)

    external = bool(mt5_modules or mt5_names) or any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in MT5_CALLS
        for node in ast.walk(tree)
    )

    return {
        "imports": sorted(set(imports)),
        "external": external,
        "hasOnBar": has_on_bar,
        "bannedImports": sorted(set(banned_imports)),
        "bannedCalls": sorted(set(banned_calls)),
        "dunderAttrs": sorted(set(dunder_attrs)),
    }


def analyze_python(
    payload: Any,
    *,
    filename: str | None = None,
    name: str | None = None,
    symbol: str | None = None,
    timeframe: str | None = None,
    direction: str | None = None,
) -> dict:
    """Parse a Python strategy and build a manifest for it. Never executes it."""
    code, detected_name = extract_python(payload)
    code = code.strip()
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise AnalysisError([{"loc": "code", "msg": "the file is larger than 400 KB"}])
    if not code:
        raise AnalysisError([{"loc": "code", "msg": "the file is empty"}])

    source_file = (filename or detected_name or "").strip() or None
    if source_file:
        source_file = source_file.split("/")[-1].split("\\")[-1][:180]

    try:
        tree = ast.parse(code, filename=source_file or "<strategy>")
    except SyntaxError as exc:
        raise AnalysisError(
            [
                {
                    "loc": f"line {exc.lineno}" if exc.lineno else "code",
                    "msg": f"Python syntax error: {exc.msg}",
                }
            ]
        ) from exc

    scan = _scan(tree)
    literals = _literal_assignments(tree)
    meta_raw = None
    for key in ("META", "STRATEGY", "VAELOR"):
        value = literals.get(key)
        if isinstance(value, dict):
            meta_raw = value
            break
    meta: dict[str, Any] = dict(meta_raw or {})
    doc = ast.get_docstring(tree)
    mode = "external" if scan["external"] else "python"

    errors: list[dict] = []
    warnings: list[str] = []

    if mode == "python":
        if scan["bannedImports"]:
            errors.append(
                {
                    "loc": "imports",
                    "msg": "imports not allowed in a sandboxed strategy: "
                    + ", ".join(scan["bannedImports"])
                    + " (math, statistics, datetime, typing, dataclasses, enum, collections, "
                    "itertools, functools, decimal, json, re and random are allowed)",
                }
            )
        if scan["bannedCalls"]:
            errors.append(
                {
                    "loc": "code",
                    "msg": "calls not allowed in a sandboxed strategy: "
                    + ", ".join(scan["bannedCalls"]),
                }
            )
        if scan["dunderAttrs"]:
            errors.append(
                {
                    "loc": "code",
                    "msg": "double-underscore access is not allowed: "
                    + ", ".join(scan["dunderAttrs"]),
                }
            )
        if not scan["hasOnBar"]:
            errors.append(
                {
                    "loc": "on_bar",
                    "msg": "a Python strategy must define `def on_bar(ctx)` — see the manual "
                    "for the ctx helpers and the signal shape",
                }
            )
    else:
        warnings.append(
            "This file imports MetaTrader5 and manages its own orders. It will be registered "
            "as an external strategy: the bridge will not backtest or signal it."
        )

    symbols: list[str] = []
    raw_symbols = meta.get("symbols")
    if isinstance(raw_symbols, str):
        raw_symbols = [raw_symbols]
    if isinstance(raw_symbols, list):
        for item in raw_symbols:
            text = str(item).strip().upper()
            if re.fullmatch(r"[A-Z0-9._#-]{2,20}", text):
                symbols.append(text)
    if symbol and re.fullmatch(r"[A-Z0-9._#-]{2,20}", symbol.strip().upper()):
        symbols.insert(0, symbol.strip().upper())
    detected_symbol = literals.get("SYMBOL") or literals.get("symbol")
    if isinstance(detected_symbol, str) and detected_symbol.strip():
        candidate = detected_symbol.strip().upper()
        if re.fullmatch(r"[A-Z0-9._#-]{2,20}", candidate):
            symbols.append(candidate)
    if not symbols:
        symbols = ["XAUUSD"]
    deduped: list[str] = []
    for item in symbols:
        if item not in deduped:
            deduped.append(item)
    symbols = deduped[:8]

    tf_raw = (timeframe or meta.get("timeframe") or literals.get("TIMEFRAME") or "H1")
    tf = str(tf_raw).strip().upper()
    if tf not in TF_MINUTES:
        errors.append(
            {"loc": "timeframe", "msg": f"timeframe must be one of {', '.join(TF_MINUTES)}"}
        )
        tf = "H1"

    dir_raw = str(meta.get("direction") or direction or "both").strip().lower()
    if dir_raw not in {"long", "short", "both"}:
        dir_raw = "both"

    friendly = (
        (name or meta.get("name") or "").strip()
        or (doc.strip().splitlines()[0].strip() if doc and doc.strip() else "")
        or (source_file.rsplit(".", 1)[0] if source_file else "")
        or "Python strategy"
    )
    friendly = friendly[:80]
    if len(friendly) < 2:
        friendly = "Python strategy"

    raw_id = str(meta.get("id") or "").strip() or (
        source_file.rsplit(".", 1)[0] if source_file else friendly
    )
    strategy_id = slugify(raw_id, slugify(friendly))

    tags = ["python", mode]
    raw_tags = meta.get("tags")
    if isinstance(raw_tags, list):
        for item in raw_tags:
            text = re.sub(r"[^a-zA-Z0-9_-]", "", str(item))[:24]
            if text and text not in tags:
                tags.append(text)
    tags = tags[:12]

    manifest = {
        "id": strategy_id,
        "name": friendly,
        "author": str(meta.get("author") or ("python" if mode == "python" else "external"))[:80],
        "description": _describe(doc, mode),
        "version": 1,
        "symbols": symbols,
        "timeframe": tf,
        "direction": dir_raw,
        "risk": _walk_risk(meta),
        "tags": tags,
        "enabled": False,
        "autoExecute": False,
        "language": "python",
        "runtime": mode,
        "code": code,
        "sourceFile": source_file,
    }

    if errors:
        raise AnalysisError(errors, mode=mode)

    return {
        "ok": True,
        "mode": mode,
        "manifest": manifest,
        "imports": scan["imports"],
        "warnings": warnings,
        "hooks": ["on_bar"] if mode == "python" else [],
        "sourceFile": source_file,
        "summary": {
            "name": friendly,
            "id": strategy_id,
            "symbols": symbols,
            "timeframe": tf,
            "direction": dir_raw,
            "lines": len(code.splitlines()),
            "external": mode == "external",
        },
    }
