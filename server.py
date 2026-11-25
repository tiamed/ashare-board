#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A股通用看盘 Web 服务（TDX / eltdx 数据源）。

启动：
    ./run.sh                      # 自动建 venv、装依赖、启动
    python3 server.py --port 8848 # 已装好依赖时

特性：
  - 任意 A 股 / ETF / 指数 / 可转债，输入代码或名称即可查看
  - 实时快照、分时、日/周/月 K（前复权）、涨幅/成交额/涨速排行
  - 自选股持久化在 config.json

仅依赖 Python 标准库 + eltdx；eltdx 为非商业学习授权，详见 NOTICE.md。
"""
from __future__ import annotations

import gzip
import json
import math
import os
import re
import sys
import threading
import time
import traceback
from collections import OrderedDict
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE, "static")
CONFIG_PATH = os.path.join(BASE, "config.json")

import eltdx

INDEXES = [
    ("sh000001", "上证指数"),
    ("sz399001", "深证成指"),
    ("sz399006", "创业板指"),
    ("sh000688", "科创50"),
    ("sh000300", "沪深300"),
    ("bj899050", "北证50"),
]

KEEP_CATS = {"a_share", "etf", "index", "b_share"}
CAT_RANK = {"a_share": 0, "etf": 1, "index": 2, "b_share": 3, "bond": 4, "unknown": 5}

# 首次运行（没有 config.json）时的默认自选，避免新装打开是空列表。
# 只放几个流动性和代表性都够的标的，用户第一件事通常是删掉换成自己的。
DEFAULT_WATCHLIST = [
    ("sh000001", "上证指数"),
    ("sh600519", "贵州茅台"),
    ("sh601857", "中国石油"),
    ("sz000858", "五 粮 液"),
    ("sz002594", "比亚迪"),
    ("sh588170", "科创半导ETF"),
]


def now_str() -> str:
    return datetime.now().strftime("%H:%M:%S")


def is_trading_time(dt: datetime | None = None) -> bool:
    dt = dt or datetime.now()
    if dt.weekday() >= 5:
        return False
    hm = dt.hour * 60 + dt.minute
    return (9 * 60 + 15 <= hm <= 11 * 60 + 30) or (13 * 60 <= hm <= 15 * 60)


def finite(v, default=0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def round_price(v) -> float:
    return round(finite(v), 3)


def candidates(raw: str) -> list[str]:
    """把用户输入的代码转成候选 TDX 全代码。"""
    s = (raw or "").strip().lower().replace(" ", "")
    if len(s) >= 8 and s[:2] in ("sh", "sz", "bj"):
        return [s[:2] + s[2:8]]
    digits = "".join(ch for ch in s if ch.isdigit())
    if len(digits) != 6:
        return []
    if digits.startswith(("92", "8", "4")):
        return ["bj" + digits, "sz" + digits]
    if digits[0] == "6":
        return ["sh" + digits]
    if digits[0] in "03":
        return ["sz" + digits, "sh" + digits]
    if digits.startswith(("11", "13", "50", "51", "56", "58")):
        return ["sh" + digits]
    if digits.startswith(("12", "15", "16", "18")):
        return ["sz" + digits]
    return ["sh" + digits, "sz" + digits, "bj" + digits]


def keep_security(row) -> bool:
    if row.category in KEEP_CATS:
        return True
    code = row.code or ""
    if row.exchange == "sh" and code.startswith(("110", "111", "113", "118", "132")):
        return True
    if row.exchange == "sz" and code.startswith(("123", "127", "128", "125")):
        return True
    return False


class TTL:
    """带 LRU 上限的 TTL 缓存，按「条目数 + 估算字节」双重封顶。

    原来只有写没有删，缓存大小由「用户点过多少个不同的 (code, period, count, adjust)」
    决定。更要紧的是条目之间大小差 3 个数量级：一个 1250 根 K 线约 0.2MB，
    而一个 20000 根 K 线在内存里约 2.7MB。只按条目数封顶（400 条）最坏就是 1.08GB，
    所以必须同时按字节封顶。
    """

    def __init__(self, max_entries: int = 400, max_bytes: int = 192 * 1024 * 1024):
        self._data: OrderedDict = OrderedDict()   # key -> (ts, value, size)
        self._lock = threading.Lock()
        self.max_entries = max(16, int(max_entries))
        self.max_bytes = max(8 * 1024 * 1024, int(max_bytes))
        self._bytes = 0
        self.hits = 0
        self.misses = 0
        self.evicted = 0

    def get(self, key, ttl, fn, weigh=None):
        """weigh(value) -> 估算字节数。已知大小的调用方应传入，未传按 2KB 估。"""
        now = time.time()
        with self._lock:
            hit = self._data.get(key)
            if hit and now - hit[0] < ttl:
                self._data.move_to_end(key)
                self.hits += 1
                return hit[1]
        self.misses += 1
        value = fn()
        try:
            size = int(weigh(value)) if weigh else 2048
        except Exception:
            size = 2048
        size = max(64, size)
        with self._lock:
            old = self._data.pop(key, None)
            if old:
                self._bytes -= old[2]
            self._data[key] = (time.time(), value, size)
            self._bytes += size
            self._data.move_to_end(key)
            # 超限就从最久未用的开始丢，直到两个上限都满足
            while self._data and (
                len(self._data) > self.max_entries or self._bytes > self.max_bytes
            ):
                _, (_, _, dropped) = self._data.popitem(last=False)
                self._bytes -= dropped
                self.evicted += 1
        return value

    def stats(self) -> dict:
        with self._lock:
            return {
                "entries": len(self._data),
                "max_entries": self.max_entries,
                "bytes": self._bytes,
                "max_bytes": self.max_bytes,
                "hits": self.hits,
                "misses": self.misses,
                "evicted": self.evicted,
            }


class Feed:
    """TDX 数据访问层。每个用途独立连接，避免排行请求阻塞快照。"""

    def __init__(self):
        self._clients: dict[str, object] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        self.cache = TTL()

        self.index: dict[str, dict] = {}
        self.index_list: list[tuple] = []
        self.index_ready = False
        self.a_count = 0

        self.profiles: dict[str, dict] = {}
        self._profile_lock = threading.Lock()
        self._profile_last = 0.0

    # ---------- 连接 ----------
    def _client(self, name: str):
        with self._guard:
            client = self._clients.get(name)
            if client is None:
                client = eltdx.Client(timeout=8.0)
                self._clients[name] = client
            return client

    def _lock(self, name: str) -> threading.Lock:
        with self._guard:
            lock = self._locks.get(name)
            if lock is None:
                lock = threading.Lock()
                self._locks[name] = lock
            return lock

    def call(self, name: str, fn):
        lock = self._lock(name)
        with lock:
            try:
                return fn(self._client(name))
            except Exception:
                # 连接可能已失效，重建一次
                with self._guard:
                    old = self._clients.pop(name, None)
                try:
                    if old is not None:
                        old.close()
                except Exception:
                    pass
                return fn(self._client(name))

    # ---------- 代码索引 ----------
    def load_index(self):
        try:
            rows = []
            for market in ("sh", "sz", "bj"):
                part = self.call("quote", lambda c, m=market: c.codes.all(m))
                rows.extend(part)
            index = {}
            for row in rows:
                if not keep_security(row):
                    continue
                full = row.exchange + row.code
                cat = row.category
                if cat == "unknown":
                    cat = "bond"
                index[full] = {
                    "code": full,
                    "name": row.name,
                    "decimal": min(int(row.decimal or 2), 3),
                    "cat": cat,
                }
            self.index = index
            self.index_list = [
                (v["code"], v["name"], v["decimal"], v["cat"]) for v in index.values()
            ]
            self.a_count = sum(1 for v in index.values() if v["cat"] == "a_share")
            self.index_ready = True
            print(f"[feed] 代码索引就绪: {len(index)} 条 / A股 {self.a_count}", flush=True)
        except Exception as exc:
            print("[feed] 代码索引加载失败:", exc, flush=True)

    def search(self, query: str, limit: int = 12) -> list[dict]:
        q = (query or "").strip()
        if not q:
            return []
        ql = q.lower()
        digits = "".join(ch for ch in ql if ch.isdigit())
        hits: list[tuple] = []
        seen: set[str] = set()

        def push(code, name, dec, cat, score):
            if code in seen:
                return
            seen.add(code)
            hits.append((score, CAT_RANK.get(cat, 9), code, name, dec, cat))

        exact = candidates(ql)
        for cand in exact:
            item = self.index.get(cand)
            if item:
                push(cand, item["name"], item["decimal"], item["cat"], 0)

        if ql.isdigit() and len(digits) == 6:
            for code, name, dec, cat in self.index_list:
                if code[2:] == digits:
                    push(code, name, dec, cat, 1)
        elif digits and len(digits) >= 2:
            for code, name, dec, cat in self.index_list:
                if code[2:].startswith(digits):
                    push(code, name, dec, cat, 3)
        elif not digits:
            contains = []
            for code, name, dec, cat in self.index_list:
                if name == q:
                    push(code, name, dec, cat, 0)
                elif name.startswith(q):
                    contains.append((1, 0, code, name, dec, cat))
                elif q in name:
                    contains.append((2, 0, code, name, dec, cat))
            for item in contains:
                push(item[2], item[3], item[4], item[5], item[0])

        hits.sort(key=lambda x: (x[0], x[1], len(x[3])))
        return [
            {"code": c, "name": n, "decimal": d, "cat": cat}
            for _, _, c, n, d, cat in hits[:limit]
        ]

    def lookup(self, raw: str) -> dict | None:
        for cand in candidates(raw):
            item = self.index.get(cand)
            if item:
                return dict(item)
        # 索引未加载完或新证券：用快照验证
        for cand in candidates(raw):
            try:
                snap = self.snapshots([cand]).get(cand)
                if snap and snap["last"] > 0:
                    name = cand
                    return {"code": cand, "name": name, "decimal": 3 if snap["last"] < 10 else 2, "cat": "unknown"}
            except Exception:
                continue
        return None

    # ---------- 快照 ----------
    def snapshots(self, codes: list[str]) -> dict[str, dict]:
        if not codes:
            return {}
        rows = self.call("quote", lambda c: c.quotes.get_snapshots(codes))
        return {f"{r.exchange}{r.code}": self._snap_json(r) for r in rows}

    @staticmethod
    def _snap_json(s) -> dict:
        pre = finite(s.pre_close_price)
        last = finite(s.last_price)
        change = last - pre
        pct = (change / pre * 100.0) if pre else 0.0
        return {
            "code": f"{s.exchange}{s.code}",
            "last": round(last, 3),
            "pre_close": round(pre, 3),
            "open": round(finite(s.open_price), 3),
            "high": round(finite(s.high_price), 3),
            "low": round(finite(s.low_price), 3),
            "change": round(change, 3),
            "pct": round(pct, 2),
            "volume": int(finite(s.total_hand)),
            "amount": finite(s.amount),
        }

    def quotes(self, codes: list[str]) -> list[dict]:
        """批量快照（给盯盘轮询用，不拉 profile，避免慢请求）。"""
        clean = []
        seen = set()
        for code in codes:
            code = (code or "").strip()
            if code and code not in seen:
                seen.add(code)
                clean.append(code)
        clean = clean[:50]
        if not clean:
            return []
        snaps = self.snapshots(clean)
        out = []
        for code in clean:
            snap = snaps.get(code)
            if not snap:
                continue
            item = dict(snap)
            with self._profile_lock:
                prof = self.profiles.get(code)
            name = (prof or {}).get("name")
            if not name:
                meta = self.index.get(code)
                name = meta.get("name") if meta else code
            item["name"] = name
            out.append(item)
        return out

    # ---------- 自选资料 ----------
    def fetch_profiles(self, codes: list[str]) -> dict[str, dict]:
        codes = [c for c in codes if c]
        if not codes:
            return {}
        try:
            table = self.call("aux", lambda c: c.helpers.stock_profile_table(codes))
        except Exception as exc:
            print("[feed] profile 拉取失败:", exc, flush=True)
            return {}
        out = {}
        for row in table.rows:
            out[f"{row.exchange}{row.code}"] = {
                "name": row.name,
                "turnover": finite(row.turnover_rate),
                "circ_mv": finite(row.circulating_market_value),
                "total_mv": finite(row.total_market_value),
                "cat": row.category,
                "ts": time.time(),
            }
        with self._profile_lock:
            self.profiles.update(out)
        return out

    def profile_loop(self, get_codes):
        while True:
            try:
                codes = get_codes()
                stale = []
                now = time.time()
                with self._profile_lock:
                    for code in codes:
                        p = self.profiles.get(code)
                        if not p or now - p["ts"] > 300:
                            stale.append(code)
                if stale:
                    self.fetch_profiles(stale)
            except Exception as exc:
                print("[feed] profile 循环异常:", exc, flush=True)
            time.sleep(60)

    # ---------- 行情聚合 ----------
    def market_scale(self, stat) -> float:
        n = self.a_count or 5500
        try:
            scale = finite(stat.total_count) / n
        except Exception:
            scale = 1.0
        return scale if 5 <= scale <= 15 else 1.0

    def overview(self) -> dict:
        def build():
            snaps = self.snapshots([code for code, _ in INDEXES])
            stat = self.call("quote", lambda c: c.helpers.market_stat())
            scale = self.market_scale(stat)
            indices = []
            for code, name in INDEXES:
                s = snaps.get(code)
                item = dict(s) if s else {"code": code, "last": 0, "pct": 0}
                item["name"] = name
                indices.append(item)
            up = round(finite(stat.up_count) / scale)
            down = round(finite(stat.down_count) / scale)
            flat = round(finite(stat.neutral_count) / scale)
            suspended = round(finite(stat.suspended_count) / scale)
            total = round(finite(stat.total_count) / scale)
            return {
                "ts": now_str(),
                "trading": is_trading_time(),
                "indices": indices,
                "breadth": {
                    "up": up,
                    "down": down,
                    "flat": flat,
                    "suspended": suspended,
                    "total": total,
                    "limit_up": round(finite(stat.limit_up_count) / scale),
                    "limit_down": round(finite(stat.limit_down_count) / scale),
                    "amount": finite(stat.total_amount),
                },
            }

        return self.cache.get("overview", 2.5, build)

    def rank(self, sort: str, count: int = 18) -> dict:
        def build():
            if sort == "drop":
                table = self.call(
                    "rank",
                    lambda c: c.helpers.realtime_rank(
                        category="沪深A股", sort_by="涨幅", count=count, ascending=True
                    ),
                )
            else:
                label = {"pct": "涨幅", "amount": "成交额", "speed": "涨速"}.get(sort, "涨幅")
                table = self.call(
                    "rank",
                    lambda c: c.helpers.realtime_rank(
                        category="沪深A股", sort_by=label, count=count
                    ),
                )
            rows = []
            for r in table.rows:
                rows.append(
                    {
                        "rank": r.rank,
                        "code": r.full_code,
                        "name": r.name or r.full_code,
                        "last": round_price(r.last_price),
                        "pct": round(finite(r.change_pct), 2),
                        "amount": finite(r.amount),
                        "volume": int(finite(r.volume_hand)),
                    }
                )
            return {"ts": now_str(), "sort": sort, "rows": rows}

        return self.cache.get(f"rank:{sort}:{count}", 8.0, build)

    def minute(self, code: str) -> dict:
        def build():
            series = self.call("chart", lambda c: c.minutes.today(code))
            snap = self.snapshots([code]).get(code) or {}
            points = []
            for p in series.points:
                points.append(
                    [
                        p.time_label,
                        round_price(p.price),
                        round_price(p.avg_price),
                        int(finite(p.volume)),
                    ]
                )
            return {
                "code": code,
                "pre_close": snap.get("pre_close", 0),
                "open": snap.get("open", 0),
                "points": points,
                "ts": now_str(),
            }

        return self.cache.get(
            f"minute:{code}", 4.0, build,
            weigh=lambda v: len(v.get("points") or ()) * 60 + 256,
        )

    def kline(self, code: str, period: str, count: int, adjust: str = "qfq") -> dict:
        count = max(30, min(int(count), 20000))
        adjust = adjust if adjust in ("qfq", "none", "hfq") else "qfq"

        def load(adj: str):
            # TDX 单页上限 800 根，start 从最新往历史翻页；翻完后按时间排序去重
            collected = []
            start = 0
            pages = 0
            while len(collected) < count:
                want = min(800, count - len(collected))
                page = self.call(
                    "chart",
                    lambda c: c.bars.get(
                        code, period=period, start=start, count=want, adjust=adj
                    ),
                )
                batch = list(getattr(page, "bars", ()) or ())
                if not batch:
                    break
                collected.extend(batch)
                start += len(batch)
                pages += 1
                if len(batch) < want or pages >= 32:
                    break
            uniq = {b.time: b for b in collected}
            return sorted(uniq.values(), key=lambda b: b.time)

        def build():
            ordered = load(adjust)
            used = adjust
            # 极端分红股的前复权历史价格可能为负，自动退回不复权保证坐标有效
            if used == "qfq" and any(finite(b.low) <= 0 or finite(b.close) <= 0 for b in ordered):
                ordered = load("none")
                used = "none"
            bars = []
            for b in ordered:
                bars.append(
                    [
                        b.time.strftime("%Y-%m-%d"),
                        round_price(b.open),
                        round_price(b.close),
                        round_price(b.low),
                        round_price(b.high),
                        round(finite(b.volume_lots), 2),
                        finite(b.amount),
                    ]
                )
            return {
                "code": code,
                "period": period,
                "adjust": used,
                "bars": bars,
                "total": len(bars),
                "first": bars[0][0] if bars else None,
                "last": bars[-1][0] if bars else None,
                "ts": now_str(),
            }

        return self.cache.get(
            f"kline:{code}:{period}:{count}:{adjust}", 60.0, build,
            weigh=lambda v: len(v.get("bars") or ()) * 140 + 512,
        )

    def auction(self, code: str, date: str | None = None) -> dict:
        """开盘/收盘集合竞价快照 + 开盘竞价明细。"""

        def build():
            data = self.call("aux", lambda c: c.helpers.auction_data(code, date))
            snap = self.snapshots([code]).get(code) or {}
            points = list(getattr(getattr(data, "series", None), "points", ()) or ())
            opens = [p for p in points if p.time_label < "09:30"]
            closes = [p for p in points if p.time_label >= "14:57"]
            is_index = code.startswith(("sh000", "sz399", "bj899"))
            pre = finite(data.pre_close_price) or finite(snap.get("pre_close"))

            tick = getattr(data, "snapshot_0925", None)
            tick_price = finite(getattr(tick, "price", 0))
            last_open = opens[-1] if opens else None
            if last_open and tick_price and 0.5 < (tick_price / max(last_open.price, 1e-9)) < 2:
                price = tick_price
            elif last_open:
                price = finite(last_open.price)
            elif tick_price:
                price = tick_price
            else:
                price = finite(data.open_price)

            pct = (price / pre - 1) * 100 if pre else 0.0
            volume = int(finite(data.open_volume)) if not is_index else 0
            amount = price * volume * 100 if (volume and not is_index) else 0.0
            matched = int(finite(getattr(tick, "volume", 0))) if tick else (int(finite(last_open.matched_volume)) if last_open else volume)
            unmatched = int(finite(last_open.unmatched_volume)) if last_open else 0
            if is_index:
                matched = 0
                unmatched = 0

            close_price = finite(closes[-1].price) if closes else 0.0
            close_pct = (close_price / pre - 1) * 100 if (close_price and pre) else 0.0
            close_matched = int(finite(closes[-1].matched_volume)) if closes else 0

            series = []
            for p in opens:
                series.append(
                    [
                        p.time_label,
                        round_price(p.price),
                        0 if is_index else int(finite(p.matched_volume)),
                        0 if is_index else int(finite(p.unmatched_volume)),
                    ]
                )
            if price:
                series.append(["09:25", round_price(price), matched, unmatched])

            return {
                "code": code,
                "trading_date": str(data.trading_date) if data.trading_date else None,
                "pre_close": round_price(pre),
                "is_index": is_index,
                "open": {
                    "price": round_price(price),
                    "pct": round(pct, 2),
                    "volume": volume,
                    "amount": amount,
                    "matched": matched,
                    "unmatched": unmatched,
                },
                "close": {
                    "price": round_price(close_price),
                    "pct": round(close_pct, 2),
                    "matched": close_matched,
                },
                "points": series,
                "ts": now_str(),
            }

        return self.cache.get(
            f"auction:{code}:{date or 'today'}", 5.0, build,
            weigh=lambda v: len(v.get("points") or ()) * 60 + 256,
        )

    def performance(self, code: str) -> dict:
        """计算所选标的的阶段涨跌幅（基于日K收盘价，前复权）。"""

        def build():
            data = self.kline(code, "day", 320, "qfq")
            bars = data.get("bars") or []
            periods = []
            if len(bars) >= 2:
                last_close = bars[-1][2]
                for label, days in (
                    ("5日", 5),
                    ("10日", 10),
                    ("20日", 20),
                    ("60日", 60),
                    ("120日", 120),
                    ("250日", 250),
                ):
                    idx = len(bars) - 1 - days
                    if idx < 0:
                        continue
                    base = bars[idx][2]
                    pct = (last_close / base - 1) * 100 if base else 0.0
                    periods.append(
                        {
                            "label": label,
                            "bars": days,
                            "pct": round(pct, 2),
                            "start_date": bars[idx][0],
                            "end_date": bars[-1][0],
                        }
                    )
                year_start = f"{datetime.now().year}-01-01"
                ytd_idx = None
                for i, bar in enumerate(bars):
                    if bar[0] < year_start:
                        ytd_idx = i
                    else:
                        break
                if ytd_idx is not None:
                    base = bars[ytd_idx][2]
                    pct = (last_close / base - 1) * 100 if base else 0.0
                    periods.append(
                        {
                            "label": "年初至今",
                            "bars": len(bars) - 1 - ytd_idx,
                            "pct": round(pct, 2),
                            "start_date": bars[ytd_idx][0],
                            "end_date": bars[-1][0],
                        }
                    )
            return {
                "code": code,
                "periods": periods,
                "adjust": data.get("adjust"),
                "last_date": bars[-1][0] if bars else None,
                "ts": now_str(),
            }

        return self.cache.get(f"perf:{code}", 30.0, build, weigh=lambda v: 1024)

    def quote_detail(self, code: str) -> dict:
        snap = self.snapshots([code]).get(code)
        if not snap:
            raise ValueError("未找到该代码的行情")
        with self._profile_lock:
            prof = self.profiles.get(code)
        if prof is None:
            prof = self.fetch_profiles([code]).get(code)
        if prof:
            snap["name"] = prof.get("name") or snap["code"]
            snap["turnover"] = round(finite(prof.get("turnover")), 2)
            snap["circ_mv"] = finite(prof.get("circ_mv"))
            snap["total_mv"] = finite(prof.get("total_mv"))
            snap["cat"] = prof.get("cat")
        else:
            snap["name"] = snap["code"]
            snap["turnover"] = 0
        return snap


# ---------------- 配置 ----------------
class Store:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.data = {"watchlist": []}
        self.load()

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            watch = []
            for item in data.get("watchlist", []):
                code = item.get("code")
                if code and re.fullmatch(r"(sh|sz|bj)\d{6}", code):
                    watch.append({"code": code, "name": item.get("name") or code})
            self.data = {"watchlist": watch}
        except FileNotFoundError:
            # 首次运行：给一份能直接看的默认自选，别让新装用户面对空列表
            self.data = {"watchlist": [{"code": c, "name": n} for c, n in DEFAULT_WATCHLIST]}
            self.save()
            print(f"[store] 未找到 {self.path}，已创建默认自选 {len(DEFAULT_WATCHLIST)} 项", flush=True)
        except Exception as exc:
            print("[store] 读取配置失败:", exc, flush=True)

    def save(self):
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        except OSError as exc:
            # 只读文件系统（容器里忘了挂卷）不该让整个服务崩掉
            print(f"[store] 保存失败（{self.path} 可能只读）: {exc}", flush=True)

    def codes(self) -> list[str]:
        with self.lock:
            return [w["code"] for w in self.data["watchlist"]]

    def items(self) -> list[dict]:
        with self.lock:
            return [dict(w) for w in self.data["watchlist"]]

    def add(self, code: str, name: str) -> bool:
        with self.lock:
            if any(w["code"] == code for w in self.data["watchlist"]):
                return False
            self.data["watchlist"].append({"code": code, "name": name})
            self.save()
            return True

    def reorder(self, codes: list[str]) -> bool:
        """按给定顺序重排自选；未列出的保持原相对顺序追加在后面。"""
        with self.lock:
            cur = self.data["watchlist"]
            by_code = {w["code"]: w for w in cur}
            ordered = [by_code[c] for c in codes if c in by_code]
            seen = {w["code"] for w in ordered}
            ordered.extend(w for w in cur if w["code"] not in seen)
            if [w["code"] for w in ordered] == [w["code"] for w in cur]:
                return False
            self.data["watchlist"] = ordered
            self.save()
            return True

    def remove(self, code: str) -> bool:
        with self.lock:
            before = len(self.data["watchlist"])
            self.data["watchlist"] = [w for w in self.data["watchlist"] if w["code"] != code]
            changed = len(self.data["watchlist"]) != before
            if changed:
                self.save()
            return changed


feed = Feed()
store = Store(CONFIG_PATH)


def watchlist_payload() -> dict:
    items = store.items()
    codes = [w["code"] for w in items]
    snaps = feed.snapshots(codes) if codes else {}
    out = []
    for w in items:
        s = snaps.get(w["code"])
        if not s:
            out.append({"code": w["code"], "name": w["name"], "last": 0, "pct": 0})
            continue
        item = dict(s)
        with feed._profile_lock:
            prof = feed.profiles.get(w["code"])
        item["name"] = (prof or {}).get("name") or w["name"]
        item["turnover"] = round(finite((prof or {}).get("turnover")), 2)
        out.append(item)
    return {"ts": now_str(), "items": out}


def search_payload(query: str) -> dict:
    if not feed.index_ready:
        item = feed.lookup(query)
        return {"ts": now_str(), "ready": False, "results": [item] if item else []}
    return {"ts": now_str(), "ready": True, "results": feed.search(query)}


class Handler(SimpleHTTPRequestHandler):
    server_version = "AShareBoard/1.0"
    # HTTP/1.1 才能 keep-alive。页面每 3~5 秒轮询，HTTP/1.0 每次新建 TCP 太浪费。
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    # ---------- 静态资源（gzip + 304 + keep-alive） ----------
    # 原来交给 SimpleHTTPRequestHandler 直接发原文件：echarts.min.js 1.0MB 原样传输，
    # 首屏合计约 1.2MB，而 API 反而是压缩过的。这里自己处理，压完约 360KB。
    _GZIP_TYPES = (".js", ".css", ".html", ".svg", ".json", ".map")
    _static_cache: dict = {}      # path -> (mtime, size, raw, gzipped)
    _static_lock = threading.Lock()

    def _resolve_static(self, url_path: str):
        rel = url_path.lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(STATIC_DIR, rel))
        # 防目录穿越：解析后必须仍在 STATIC_DIR 内
        root = os.path.realpath(STATIC_DIR)
        if not (full == root or full.startswith(root + os.sep)):
            return None
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        return full if os.path.isfile(full) else None

    def _serve_static(self, url_path: str) -> bool:
        full = self._resolve_static(url_path)
        if not full:
            return False
        try:
            st = os.stat(full)
        except OSError:
            return False

        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return True

        ext = os.path.splitext(full)[1].lower()
        wants_gzip = (
            ext in self._GZIP_TYPES
            and "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
        )

        raw = gz = None
        with self._static_lock:
            cached = self._static_cache.get(full)
            if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
                _, _, raw, gz = cached
        if raw is None:
            try:
                with open(full, "rb") as fh:
                    raw = fh.read()
            except OSError:
                return False
            if ext in self._GZIP_TYPES:
                gz = gzip.compress(raw, 6)
            with self._static_lock:
                self._static_cache[full] = (st.st_mtime, st.st_size, raw, gz)

        body = gz if (wants_gzip and gz is not None) else raw
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(full) or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", self.date_time_string(st.st_mtime))
        # no-cache = 允许缓存但每次校验（配 ETag 命中 304 只回几个字节）
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Vary", "Accept-Encoding")
        if wants_gzip and gz is not None:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()

        if self.command == "HEAD":
            return True
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        return True

    # ---------- 工具 ----------
    def _send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Accept-Encoding")
        if len(body) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 5)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = 400):
        self._send_json({"error": message}, status)

    def _body_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    def end_headers(self):
        # 静态资源和 API 各自都显式发过 Cache-Control，这里不再重复发（重复会出现两个头）
        super().end_headers()

    # ---------- 路由 ----------
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            try:
                self._api_get(parsed)
            except Exception as exc:
                traceback.print_exc()
                self._error(f"{type(exc).__name__}: {exc}", 500)
            return
        if parsed.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if self._serve_static(parsed.path):
            return
        self._error("not found", 404)

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/") or parsed.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if self._serve_static(parsed.path):
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/watchlist":
                self._api_watch_add()
            elif parsed.path == "/api/watchlist/reorder":
                self._api_watch_reorder()
            else:
                self._error("not found", 404)
        except Exception as exc:
            traceback.print_exc()
            self._error(f"{type(exc).__name__}: {exc}", 500)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/watchlist":
            self._error("not found", 404)
            return
        code = (parse_qs(parsed.query).get("code") or [""])[0]
        if store.remove(code):
            self._send_json({"ok": True})
        else:
            self._send_json({"ok": False, "error": "不在自选中"}, 404)

    def _api_get(self, parsed):
        query = parse_qs(parsed.query)
        path = parsed.path
        q = lambda key, default="": (query.get(key) or [default])[0]

        if path == "/api/health":
            self._send_json(
                {
                    "ok": True,
                    "ts": now_str(),
                    "index_ready": feed.index_ready,
                    "cache": feed.cache.stats(),
                }
            )
        elif path == "/api/overview":
            self._send_json(feed.overview())
        elif path == "/api/watchlist":
            self._send_json(watchlist_payload())
        elif path == "/api/search":
            self._send_json(search_payload(q("q")))
        elif path == "/api/lookup":
            item = feed.lookup(q("code"))
            if item:
                self._send_json({"ok": True, "item": item})
            else:
                self._send_json({"ok": False, "error": "未找到该代码"}, 404)
        elif path == "/api/quote":
            code = q("code")
            self._send_json(feed.quote_detail(code))
        elif path == "/api/performance":
            self._send_json(feed.performance(q("code")))
        elif path == "/api/auction":
            date = q("date") or None
            self._send_json(feed.auction(q("code"), date))
        elif path == "/api/quotes":
            codes = [c.strip() for c in q("codes").split(",") if c.strip()]
            self._send_json({"ts": now_str(), "items": feed.quotes(codes)})
        elif path == "/api/minute":
            self._send_json(feed.minute(q("code")))
        elif path == "/api/kline":
            period = q("period", "day")
            if period not in ("day", "week", "month"):
                period = "day"
            count = int(q("count", "20000") or 20000)
            count = max(30, min(count, 20000))
            adjust = q("adjust", "qfq")
            if adjust not in ("qfq", "none", "hfq"):
                adjust = "qfq"
            self._send_json(feed.kline(q("code"), period, count, adjust))
        elif path == "/api/rank":
            sort = q("sort", "pct")
            if sort not in ("pct", "drop", "amount", "speed"):
                sort = "pct"
            self._send_json(feed.rank(sort))
        else:
            self._error("not found", 404)

    def _api_watch_add(self):
        body = self._body_json()
        raw = str(body.get("code") or "")
        item = feed.lookup(raw)
        if not item:
            self._error("未找到该代码", 404)
            return
        code = item["code"]
        prof = feed.fetch_profiles([code]).get(code)
        name = (prof or {}).get("name") or item.get("name") or code
        added = store.add(code, name)
        self._send_json(
            {
                "ok": True,
                "added": added,
                "item": {"code": code, "name": name},
                "watchlist": watchlist_payload(),
            }
        )

    def _api_watch_reorder(self):
        body = self._body_json()
        codes = body.get("codes")
        if not isinstance(codes, list) or not all(isinstance(c, str) for c in codes):
            self._error("codes 必须是代码数组", 400)
            return
        known = set(store.codes())
        if not set(codes).issubset(known):
            self._error("包含不在自选中的代码", 400)
            return
        store.reorder(codes)
        self._send_json({"ok": True, "watchlist": watchlist_payload()})

    def log_message(self, fmt, *args):
        path = getattr(self, "path", "") or ""
        if path.startswith("/api/") and not path.startswith("/api/health"):
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def _lan_ips():
    """尽力列出本机的局域网 IPv4，用于 0.0.0.0 模式下打印访问地址。

    不引入第三方库：用 UDP connect 探测出口网卡（不会真的发包），失败就返回空。
    """
    ips = []
    try:
        import socket

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            ips.append(sock.getsockname()[0])
        finally:
            sock.close()
    except Exception:
        pass
    return ips


def main():
    # 自部署友好：所有可变项都能用 CLI 或环境变量覆盖，不写死路径。
    port = int(os.environ.get("ASHARE_PORT", "8848"))
    host = os.environ.get("ASHARE_HOST", "127.0.0.1")
    global CONFIG_PATH
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
        elif arg == "--host" and i + 1 < len(args):
            host = args[i + 1]
        elif arg == "--config" and i + 1 < len(args):
            CONFIG_PATH = os.path.abspath(args[i + 1])
        elif arg in ("-h", "--help"):
            print(
                "用法: server.py [--port 8848] [--host 127.0.0.1] [--config config.json]\n"
                "\n环境变量: ASHARE_PORT / ASHARE_HOST / ASHARE_CONFIG / ASHARE_CACHE_MAX / ASHARE_CACHE_MB\n"
                "  ASHARE_HOST=0.0.0.0 才能被同网段其他设备访问（请自行确认网络环境）。",
                flush=True,
            )
            return

    if os.environ.get("ASHARE_CONFIG"):
        CONFIG_PATH = os.path.abspath(os.environ["ASHARE_CONFIG"])
    store.path = CONFIG_PATH
    store.load()

    if os.environ.get("ASHARE_CACHE_MAX"):
        # 条目数上限
        try:
            feed.cache.max_entries = max(16, int(os.environ["ASHARE_CACHE_MAX"]))
        except ValueError:
            pass
    if os.environ.get("ASHARE_CACHE_MB"):
        # 字节上限（MB），小内存机器（1C1G）调小这个
        try:
            feed.cache.max_bytes = max(8, int(os.environ["ASHARE_CACHE_MB"])) * 1024 * 1024
        except ValueError:
            pass

    print("[boot] 连接 TDX 并加载代码表 ...", flush=True)
    try:
        feed.snapshots(["sh000001"])
        feed.overview()
    except Exception as exc:
        print("[boot] 预热失败（服务仍启动）:", exc, flush=True)

    threading.Thread(target=feed.load_index, daemon=True).start()
    threading.Thread(target=feed.profile_loop, args=(store.codes,), daemon=True).start()

    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        # 自部署最常见的第一道坎：端口被占。给一句能直接照做的提示，别甩 traceback。
        if getattr(exc, "errno", None) in (98, 48):  # Linux EADDRINUSE / macOS
            print(
                f"[boot] 端口 {port} 已被占用。\n"
                f"       换个端口：./run.sh 8899\n"
                f"       或看谁占着：ss -ltnp | grep {port}",
                flush=True,
            )
            sys.exit(1)
        raise
    httpd.daemon_threads = True
    if host == "0.0.0.0":
        print(f"[boot] 看盘服务已启动，监听所有网卡的 {port} 端口", flush=True)
        # 只报 127.0.0.1 会让人以为别处访问不了；同时给出局域网地址
        for ip in _lan_ips():
            print(f"       本机访问:   http://127.0.0.1:{port}", flush=True)
            print(f"       局域网访问: http://{ip}:{port}", flush=True)
            break
        print("[boot] 注意：本服务没有鉴权，能访问该端口的人都能改自选。", flush=True)
    else:
        print(f"[boot] 看盘服务已启动: http://{host}:{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[boot] 已停止", flush=True)


if __name__ == "__main__":
    main()
