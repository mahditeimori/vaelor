"""Request/response models and the strategy DSL types."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Timeframe = Literal["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"]
Side = Literal["buy", "sell"]
Direction = Literal["long", "short", "both"]
OrderType = Literal["market", "limit"]

TF_MINUTES: dict[str, int] = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "M30": 30,
    "H1": 60,
    "H4": 240,
    "D1": 1440,
    "W1": 10080,
}

CONDITION_TYPES = {
    "ema_cross",
    "sma_cross",
    "price_vs_ema",
    "price_vs_sma",
    "rsi",
    "macd",
    "breakout",
    "bollinger",
    "atr_filter",
    "always",
}

EXIT_TYPES = {"atr", "pips", "percent", "fixed_r"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Condition(BaseModel):
    """One rule clause.

    Only the fields relevant to `type` are read; the rest stay unset. Validation
    is done centrally in `strategies.validate_condition` so the error messages
    can explain the DSL.
    """

    type: str
    fast: int | None = None
    slow: int | None = None
    period: int | None = None
    op: Literal["above", "below", "cross_up", "cross_down"] | None = None
    value: float | None = None
    direction: Literal["up", "down"] | None = None
    lookback: int | None = None
    side: Literal["high", "low", "upper", "lower"] | None = None
    mult: float | None = None
    mode: Literal["touch", "close_outside"] | None = None
    min: float | None = None


class Group(BaseModel):
    all: list[Condition] = Field(default_factory=list)
    any: list[Condition] = Field(default_factory=list)

    @model_validator(mode="after")
    def _not_empty(self) -> "Group":
        if not self.all and not self.any:
            raise ValueError("group needs at least one condition in `all` or `any`")
        return self


class ExitRule(BaseModel):
    type: Literal["atr", "pips", "percent"]
    mult: float | None = None
    pips: float | None = None
    pct: float | None = None


class RiskSpec(BaseModel):
    riskPct: float = Field(default=1.0, ge=0.05, le=10)
    maxPositions: int = Field(default=1, ge=1, le=10)
    maxLots: float | None = Field(default=None, gt=0, le=100)


class StrategyManifest(BaseModel):
    id: str = Field(min_length=2, max_length=64)
    name: str = Field(min_length=2, max_length=80)
    author: str = Field(default="unknown", max_length=80)
    description: str = Field(default="", max_length=600)
    version: int = Field(default=1, ge=1)
    symbols: list[str] = Field(min_length=1, max_length=8)
    timeframe: Timeframe = "H1"
    direction: Direction = "both"
    # Either one generic entry group (side taken from `direction`) or explicit
    # long/short groups. Explicit groups are what AI authors usually emit.
    entry: Group | None = None
    entryLong: Group | None = None
    entryShort: Group | None = None
    exit: Group | None = None
    stop: ExitRule | None = None
    target: ExitRule | None = None
    trail: ExitRule | None = None
    risk: RiskSpec = Field(default_factory=RiskSpec)
    tags: list[str] = Field(default_factory=list, max_length=12)
    enabled: bool = False
    autoExecute: bool = False
    createdAt: str = Field(default_factory=now_iso)
    updatedAt: str = Field(default_factory=now_iso)

    @field_validator("id")
    @classmethod
    def _slug(cls, value: str) -> str:
        slug = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,63}", slug):
            raise ValueError("id must be a lowercase slug (a-z, 0-9, dot, dash, underscore)")
        return slug

    @field_validator("symbols")
    @classmethod
    def _symbols(cls, value: list[str]) -> list[str]:
        cleaned = []
        for item in value:
            sym = str(item).strip().upper()
            if not re.fullmatch(r"[A-Z0-9._#-]{2,20}", sym):
                raise ValueError(f"invalid symbol: {item!r}")
            if sym not in cleaned:
                cleaned.append(sym)
        if not cleaned:
            raise ValueError("at least one symbol is required")
        return cleaned

    @model_validator(mode="after")
    def _has_entry(self) -> "StrategyManifest":
        if not (self.entry or self.entryLong or self.entryShort):
            raise ValueError("strategy needs entry, entryLong or entryShort")
        return self


class RiskConfig(BaseModel):
    riskPerTradePct: float = Field(default=1.0, ge=0.05, le=5)
    maxLotPerTrade: float = Field(default=2.0, gt=0, le=100)
    maxOpenPositions: int = Field(default=5, ge=1, le=50)
    maxDailyLossPct: float = Field(default=3.0, ge=0.5, le=50)
    maxDrawdownPct: float = Field(default=10.0, ge=1, le=100)
    symbolWhitelist: list[str] = Field(default_factory=list, max_length=60)
    allowMarketOrders: bool = True
    killSwitch: bool = False

    @field_validator("symbolWhitelist")
    @classmethod
    def _upper(cls, value: list[str]) -> list[str]:
        return [v.strip().upper() for v in value if v.strip()]


class OrderRequest(BaseModel):
    symbol: str = Field(min_length=2, max_length=20)
    side: Side
    volume: float = Field(gt=0, le=100)
    type: OrderType = "market"
    price: float | None = Field(default=None, gt=0)
    sl: float | None = Field(default=None, gt=0)
    tp: float | None = Field(default=None, gt=0)
    comment: str = Field(default="", max_length=64)
    strategyId: str | None = None
    idempotencyKey: str | None = Field(default=None, max_length=80)
    confirm: bool = False

    @field_validator("symbol")
    @classmethod
    def _symbol(cls, value: str) -> str:
        return value.strip().upper()

    @model_validator(mode="after")
    def _limit_needs_price(self) -> "OrderRequest":
        if self.type == "limit" and not self.price:
            raise ValueError("limit orders require a price")
        return self


class ModifyRequest(BaseModel):
    sl: float | None = Field(default=None, ge=0)
    tp: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _something(self) -> "ModifyRequest":
        if self.sl is None and self.tp is None:
            raise ValueError("provide sl and/or tp")
        return self


class CloseRequest(BaseModel):
    volume: float | None = Field(default=None, gt=0, le=100)


class TrailRequest(BaseModel):
    distancePips: float = Field(gt=0, le=10000)


class SignalDecision(BaseModel):
    volume: float | None = Field(default=None, gt=0, le=100)
    note: str = Field(default="", max_length=200)


class ModeRequest(BaseModel):
    mode: Literal["simulation", "live"]
    confirm: str = ""


class KillRequest(BaseModel):
    active: bool = True
    closePositions: bool = False
    confirm: str = ""


class BacktestRequest(BaseModel):
    strategyId: str | None = None
    strategy: StrategyManifest | None = None
    symbol: str
    timeframe: Timeframe | None = None
    start: str | None = None
    end: str | None = None
    initialBalance: float = Field(default=10000, gt=100, le=10_000_000)
    riskPct: float | None = Field(default=None, ge=0.05, le=10)
    spreadPips: float = Field(default=1.0, ge=0, le=100)
    commissionPerLot: float = Field(default=0.0, ge=0, le=100)
    leverage: int = Field(default=100, ge=1, le=1000)

    @model_validator(mode="after")
    def _one_source(self) -> "BacktestRequest":
        if not self.strategyId and not self.strategy:
            raise ValueError("provide strategyId or an inline strategy")
        return self

    @field_validator("symbol")
    @classmethod
    def _symbol(cls, value: str) -> str:
        return value.strip().upper()


class BacktestOptions(BaseModel):
    initialBalance: float = 10000
    riskPct: float | None = None
    spreadPips: float = 1.0
    commissionPerLot: float = 0.0
    leverage: int = 100


class SignalIn(BaseModel):
    id: str | None = None
    strategyId: str
    symbol: str
    side: Side
    entry: float | None = None
    sl: float | None = None
    tp: float | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    note: str = ""
    createdAt: str = Field(default_factory=now_iso)

    @field_validator("symbol")
    @classmethod
    def _symbol(cls, value: str) -> str:
        return value.strip().upper()


def dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(exclude_none=True)
