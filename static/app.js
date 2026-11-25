/* A股看盘 · 前端逻辑（TDX 数据） */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    selected: { code: "sh000001", name: "上证指数", decimal: 2 },
    mode: "minute",
    rankSort: "pct",
    range: "5y",
    theme: "dark",
    performance: null,
    pendingZoom: null,
    klineMeta: null,
    alerts: [],
    alertBusy: false,
    showAuction: (() => {
      try { return localStorage.getItem("ashare-show-auction") !== "0"; } catch (e) { return true; }
    })(),
    showMarks: (() => {
      try { return localStorage.getItem("ashare-marks") !== "0"; } catch (e) { return true; }
    })(),
    // 分时均线逐条开关（图例点击），与 K 线的 MA5/10/20/60 图例同一套交互
    maOff: (() => {
      try {
        const raw = localStorage.getItem("ashare-ma-off");
        return raw ? JSON.parse(raw) : {};
      } catch (e) { return {}; }
    })(),
    maLevels: null,
    minuteData: null,
    auctionData: null,
    watchlist: [],
    drag: null,
    quote: null,
    chart: null,
    reqSeq: 0,
    chartSeq: 0,
    searchTimer: null,
    searchItems: [],
    searchActive: -1,
    busy: {},
  };

  const PALETTES = {
    dark: {
      up: "#ff5a5f",
      down: "#2fd47f",
      price: "#e6e2d9",
      avg: "#a8926d",
      grid: "#1e2228",
      axis: "#858a91",
      border: "#2c3138",
      text: "#e7e4dd",
      label: "#8a8f95",
      tooltipBg: "rgba(12,14,17,.98)",
      shadow: "0 8px 22px rgba(0,0,0,.35)",
      rule: "#575d66",
      markUp: "#ff5a5f", // 顶/拉 文字：6.41:1
      markDown: "#2fd47f", // 底/砸 文字：10.11:1
      // K线均线 / 分时参考线共用一组，同色相、只按主题取不同深浅（对底色均 ≥7:1）
      ma5: "#c8a05f",
      ma10: "#86a4bb",
      ma20: "#b495b9",
      ma60: "#8aa89a",
    },
    light: {
      up: "#e02424",
      down: "#00a86b",
      price: "#1a1d20",
      avg: "#8a6a3f",
      grid: "#e8eaec",
      axis: "#5f646b",
      border: "#dfe1e4",
      text: "#1b1e22",
      label: "#5f646b",
      tooltipBg: "rgba(255,255,255,.99)",
      shadow: "0 8px 22px rgba(0,0,0,.10)",
      rule: "#adb2b7",
      markUp: "#e02424", // 顶/拉 文字：4.72:1
      markDown: "#067a4b", // 底/砸 文字：5.39:1（原来是 #00a86b，只有 3.08:1）
      ma5: "#8a6a3f", // 4.98:1
      ma10: "#55728a", // 5.05:1
      ma20: "#7a5c7e", // 5.74:1
      ma60: "#4f6b5f", // 5.83:1
    },
  };

  const COLORS = { ...PALETTES.dark };

  function applyTheme(theme, rerender = true) {
    state.theme = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", state.theme);
    Object.assign(COLORS, PALETTES[state.theme]);
    try { localStorage.setItem("ashare-theme", state.theme); } catch (e) { /* ignore */ }
    if (rerender && state.chart) loadChart();
  }

  const ALERT_KEY = "ashare-alerts-v1";

  const RANGES = {
    "1y": { count: 250, label: "1年" },
    "3y": { count: 750, label: "3年" },
    "5y": { count: 1250, label: "5年" },
    all: { count: 20000, label: "全部" },
  };

  const TAGS = {
    a_share: "A股",
    etf: "ETF",
    index: "指数",
    bond: "转债",
    b_share: "B股",
    unknown: "其他",
  };

  /* ---------------- 格式化 ---------------- */
  function num(v) {
    return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
  }

  function fmtPrice(v, dec) {
    const n = num(v);
    if (n === null) return "--";
    return n.toFixed(dec ?? state.selected.decimal ?? 2);
  }

  function fmtPct(v, sign = true) {
    const n = num(v);
    if (n === null) return "--";
    return `${sign && n > 0 ? "+" : ""}${n.toFixed(2)}%`;
  }

  // 振幅 = (最高 - 最低) / 昨收。缺任一字段（停牌/一字板缺数据）返回 null，交给调用方显示 --。
  function amplitude(q) {
    const pre = num(q && q.pre_close);
    const hi = num(q && q.high);
    const lo = num(q && q.low);
    if (!pre || hi === null || lo === null) return null;
    return ((hi - lo) / pre) * 100;
  }

  function fmtAmp(q) {
    const a = amplitude(q);
    return a === null ? "--" : `${a.toFixed(2)}%`;
  }

  function fmtAmount(v) {
    const n = num(v);
    if (!n) return "--";
    if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
    if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(0)}万`;
    return n.toFixed(0);
  }

  function fmtVolume(v) {
    const n = num(v) || 0;
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿手`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万手`;
    return `${n.toFixed(0)}手`;
  }

  function dirClass(v) {
    const n = num(v) || 0;
    return n > 0 ? "up" : n < 0 ? "down" : "flat";
  }

  function decimalsFor(code, price) {
    const c = (code || "").slice(2);
    if (/^(5|11|12|13|15|16|18)/.test(c)) return 3;
    if (num(price) !== null && num(price) < 10) return 3;
    return 2;
  }

  function niceStep(raw) {
    if (!raw || raw <= 0) return 1;
    const exp = Math.floor(Math.log10(raw));
    const base = raw / Math.pow(10, exp);
    let n;
    if (base <= 1) n = 1;
    else if (base <= 2) n = 2;
    else if (base <= 2.5) n = 2.5;
    else if (base <= 5) n = 5;
    else n = 10;
    return n * Math.pow(10, exp);
  }

  function niceRange(lo, hi, split) {
    const span = Math.max(hi - lo, 1e-9);
    const step = niceStep(span / split);
    return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step, step];
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  /* ---------------- 雪球外链 ---------------- */
  // sh600519 -> https://xueqiu.com/S/SH600519（sz→SZ、bj→BJ）
  function xueqiuUrl(code) {
    const raw = String(code ?? "").trim();
    const m = raw.match(/^(sh|sz|bj)(\d{6})$/i);
    if (m) return `https://xueqiu.com/S/${m[1].toUpperCase()}${m[2]}`;
    if (/^\d{6}$/.test(raw)) {
      const head = raw[0];
      const pre = head === "6" || head === "9" ? "SH" : head === "4" || head === "8" ? "BJ" : "SZ";
      return `https://xueqiu.com/S/${pre}${raw}`;
    }
    return "";
  }

  function codeLinkHTML(code, cls) {
    const url = xueqiuUrl(code);
    const name = String(code ?? "");
    if (!url) return `<span class="${cls}">${esc(name)}</span>`;
    return `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer"`
      + ` title="在雪球查看 ${esc(name.toUpperCase())}">${esc(name)}</a>`;
  }

  // 把已存在的 <a class="code-link"> 更新为当前标的的雪球地址
  function setCodeLink(el, code) {
    if (!el) return;
    const url = xueqiuUrl(code);
    const text = el.querySelector(".code-text") || el;
    text.textContent = String(code ?? "");
    if (!url) {
      el.removeAttribute("href");
      el.classList.add("no-link");
      return;
    }
    el.classList.remove("no-link");
    el.href = url;
    const label = String(code).toUpperCase();
    el.title = `在雪球查看 ${label}`;
    el.setAttribute("aria-label", `在雪球查看 ${label}（新标签页打开）`);
  }

  /* ---------------- 网络 ---------------- */
  async function api(path, options) {
    const res = await fetch(path, { cache: "no-store", ...(options || {}) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  function setConn(ok) {
    const dot = $("#connDot");
    dot.classList.toggle("ok", ok === true);
    dot.classList.toggle("err", ok === false);
    $("#connText").textContent = ok === true ? "数据正常" : ok === false ? "连接异常" : "连接中";
  }

  /* ---------------- 时钟 ---------------- */
  function tickClock() {
    const d = new Date();
    $("#clock").textContent = d.toLocaleTimeString("zh-CN", { hour12: false });
  }

  /* ---------------- 指数条 ---------------- */
  function renderIndices(indices) {
    const wrap = $("#indexStrip");
    const left = wrap.scrollLeft; // 窄屏横向滚动时，3 秒一轮的重绘别把位置弹回开头
    wrap.innerHTML = (indices || []).map((it) => {
      const dec = 2;
      const active = it.code === state.selected.code ? "active" : "";
      return `
        <div class="index-card ${active}" data-code="${esc(it.code)}" data-name="${esc(it.name)}">
          <div class="idx-name">${esc(it.name)}</div>
          <div class="idx-line">
            <span class="idx-value ${dirClass(it.pct)}">${fmtPrice(it.last, dec)}</span>
            <span class="idx-chg ${dirClass(it.pct)}">${fmtPct(it.pct)}</span>
          </div>
        </div>`;
    }).join("");
    if (left) wrap.scrollLeft = left;
  }

  // 窄屏指数条是横滑的：从搜索/排行切换标的时，把对应指数滚进可视区
  function revealActiveIndex() {
    if (window.innerWidth > 760) return;
    const strip = $("#indexStrip");
    const card = strip.querySelector(".index-card.active");
    if (!card) return;
    const s = strip.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    if (c.left < s.left) strip.scrollBy({ left: c.left - s.left - 12 });
    else if (c.right > s.right) strip.scrollBy({ left: c.right - s.right + 12 });
  }

  function renderBreadth(b) {
    if (!b) return;
    const up = b.up || 0;
    const down = b.down || 0;
    const total = Math.max(up + down, 1);
    $("#breadthUp").style.width = `${(up / total) * 100}%`;
    $("#breadthDown").style.width = `${(down / total) * 100}%`;
    $("#breadthStats").innerHTML = [
      `上涨 <b class="up">${up}</b>`,
      `下跌 <b class="down">${down}</b>`,
      `平盘 <b>${b.flat || 0}</b>`,
      `涨停 <b class="up">${b.limit_up || 0}</b>`,
      `跌停 <b class="down">${b.limit_down || 0}</b>`,
      `两市成交 <b>${fmtAmount(b.amount)}</b>`,
    ].join('<span class="sep">|</span>');
    renderWidthSignal(up, down);
  }

  /* ---------------- 市场宽度信号灯（P1-1） ---------------- */
  // width = 上涨 / (上涨 + 下跌)。历史：<45% 次日 +0.643%(胜率58%)，>60% 次日 -0.206%。
  // 注意这是同步指标，最近 60 天胜率仅 34%，所以 UI 必须标"历史统计，非预测"。
  const WIDTH_ZONES = [
    { max: 45, key: "cool", text: "宽度偏弱 · 历史次日偏强" },
    { max: 60, key: "neutral", text: "宽度中性" },
    { max: Infinity, key: "hot", text: "宽度偏热 · 历史次日偏弱" },
  ];

  function renderWidthSignal(up, down) {
    const el = $("#widthSignal");
    const denom = up + down;
    if (!denom) { el.classList.add("hidden"); return; }
    const width = (up / denom) * 100;
    const zone = WIDTH_ZONES.find((z) => width < z.max) || WIDTH_ZONES[WIDTH_ZONES.length - 1];
    el.classList.remove("hidden");
    el.dataset.zone = zone.key;
    el.innerHTML = `<b>${width.toFixed(0)}%</b><em>${zone.text}</em>`;
    const hist = zone.key === "cool"
      ? "历史：宽度 <45% 后次日均值 +0.64%，胜率 58%（样本内）"
      : zone.key === "hot"
        ? "历史：宽度 >60% 后次日均值 −0.21%（样本内）"
        : "历史：45–60% 区间无明显方向";
    el.title = `${hist}。这是同步指标，近 60 天胜率仅 34%，不能当预测用。`;
  }

  async function refreshOverview() {
    try {
      const data = await api("/api/overview");
      state.overview = data;
      renderIndices(data.indices);
      renderBreadth(data.breadth);
      setConn(true);
    } catch (err) {
      setConn(false);
    }
  }

  /* ---------------- 个股抬头 ---------------- */
  function renderQuote(q) {
    const dec = state.selected.decimal;
    $("#stockName").textContent = state.selected.name;
    setCodeLink($("#stockCode"), state.selected.code);
    $("#stockLast").textContent = fmtPrice(q.last, dec);
    $("#stockLast").className = `last ${dirClass(q.pct)}`;
    $("#stockChange").textContent = q.change > 0 ? `+${fmtPrice(q.change, dec)}` : fmtPrice(q.change, dec);
    $("#stockChange").className = `chg ${dirClass(q.pct)}`;
    $("#stockPct").textContent = fmtPct(q.pct);
    $("#stockPct").className = `pct ${dirClass(q.pct)}`;
    // 窄屏 .stats 整块隐藏，振幅改在这里补一个；桌面端由 CSS 藏掉，避免同一屏出现两次
    $("#stockAmp").textContent = `振 ${fmtAmp(q)}`;

    const pre = num(q.pre_close) || 0;
    const isIndex = /^(sh000|sz399|bj899)/.test(state.selected.code);
    const turnover = isIndex ? 0 : num(q.turnover);
    // 振幅和换手是两件事，之前写成二选一（个股只剩换手，看不到振幅）。
    // 指数没有换手，只多出振幅一项，正好仍排成 3 列 × 2 行。
    const stats = [
      ["今开", fmtPrice(q.open, dec), dirClass(q.open - pre)],
      ["最高", fmtPrice(q.high, dec), dirClass(q.high - pre)],
      ["最低", fmtPrice(q.low, dec), dirClass(q.low - pre)],
      ["昨收", fmtPrice(pre, dec), ""],
      ["振幅", fmtAmp(q), ""],
      turnover ? ["换手", `${turnover.toFixed(2)}%`, ""] : null,
      ["成交额", fmtAmount(q.amount), ""],
    ].filter(Boolean);
    $("#stockStats").innerHTML = stats.map(([k, v, cls]) =>
      `<div class="stat"><span>${k}</span><b class="${cls}">${v}</b></div>`).join("");

    renderDayPosition(q);
    syncStar();
  }

  /* ---------------- 收盘位置连续低位天数（P1-2） ---------------- */
  // 每只股票每天收盘记一次 pos（同 P0-1 公式）。连续 N 天 <25% 之后，
  // 历史 6 次样本里 5 次次日上涨、均值 +3.71%（唯一失败的一次 −7.61%，幅度很大）。
  // 只存本地：数据在 localStorage，按设备独立。
  const STREAK_KEY = "ashare-posstreak-v1";
  const STREAK_LOW = 25;

  function loadStreaks() {
    try {
      const raw = localStorage.getItem(STREAK_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) { return {}; }
  }

  function saveStreaks(obj) {
    try { localStorage.setItem(STREAK_KEY, JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }

  // 收盘后才记录：15:00 之后、且服务端确认今天是交易日，同一交易日只记一次。
  // 用 /api/auction 的 trading_date 兜底，避免节假日把前一天的陈旧行情记成今天。
  let streakBusy = false;
  function todayStr() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  // 收盘后只跑一次：把「当前显示 + 全部自选」当天收盘位置记进 localStorage。
  // 只记当前这只的话，没点开过的标的永远没有历史，连续低位就永远算不出来。
  async function maybeRecordAllCloses(currentQ) {
    if (streakBusy) return;
    const now = new Date();
    const hm = now.getHours() * 60 + now.getMinutes();
    if (hm < 15 * 60) return;                        // 还没收盘
    if (now.getDay() === 0 || now.getDay() === 6) return;
    const today = todayStr();
    const all = loadStreaks();

    // 待记录清单：当前标的 + 自选里今天还没记的
    const pending = [];
    const curCode = state.selected.code;
    if (currentQ && (!all[curCode] || all[curCode].date !== today)) pending.push([curCode, currentQ]);
    for (const w of state.watchlist) {
      if (w.code === curCode) continue;
      if (all[w.code] && all[w.code].date === today) continue;
      if (!w.last || !w.high || !w.low) continue;
      pending.push([w.code, w]);
    }
    if (!pending.length) return;

    streakBusy = true;
    try {
      // 用一只票的 auction 确认今天确实是交易日（节假日行情是陈旧的）
      const au = await api(`/api/auction?code=${encodeURIComponent(curCode)}`).catch(() => null);
      if (!au || au.trading_date !== today) return;
      let changed = false;
      for (const [code, q] of pending) {
        const info = dayPosition(q);
        if (!info || info.flat) continue;            // 一字板没有位置可言
        const r = all[code] || { date: null, days: [] };
        if (r.date === today) continue;
        r.date = today;
        r.days = [...(r.days || []), { d: today, pos: +info.pct.toFixed(1) }].slice(-40);
        all[code] = r;
        changed = true;
      }
      if (changed) saveStreaks(all);
    } finally {
      streakBusy = false;
    }
  }

  // 连续多少天收盘 pos < 25%（从最后一天往前数）
  function closeStreak(code) {
    const all = loadStreaks();
    const rec = all[code];
    if (!rec || !rec.days || !rec.days.length) return 0;
    let n = 0;
    for (let i = rec.days.length - 1; i >= 0; i--) {
      if (rec.days[i].pos < STREAK_LOW) n += 1;
      else break;
    }
    return n;
  }

  function renderStreak(code) {
    const el = $("#posStreak");
    const n = closeStreak(code);
    if (n < 2) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.textContent = `连续 ${n} 天收盘低位`;
    el.title = `最近 ${n} 个交易日收盘位置都低于 ${STREAK_LOW}%。`
      + `历史样本（连续 3 天 <25% 后）：5/6 次次日上涨，均值 +3.71%，但唯一失败的一次是 −7.61%。样本仅 6 次，别当保证。`;
  }

  /* ---------------- 日内位置（防追涨） ---------------- */
  // pos = (last - low) / (high - low)：现价在今日高低区间的位置。
  // >70% 是"当天已经涨上去了才买"的位置，做成常驻显示，下单前能看见。
  const POS_ZONES = [
    { max: 30, key: "low", text: "低位区" },
    { max: 50, key: "near", text: "中性偏低" },
    { max: 70, key: "mid", text: "偏高" },
    { max: Infinity, key: "high", text: "追涨区" },
  ];

  function dayPosition(q) {
    const hi = num(q.high);
    const lo = num(q.low);
    const last = num(q.last);
    if (hi == null || lo == null || last == null) return null;
    const span = hi - lo;
    // 一字板 / 停牌：全天一个价，位置没有意义
    if (span <= 0) return { pct: 100, flat: true, zone: POS_ZONES[POS_ZONES.length - 1] };
    const pct = Math.max(0, Math.min(100, ((last - lo) / span) * 100));
    const zone = POS_ZONES.find((z) => pct < z.max) || POS_ZONES[POS_ZONES.length - 1];
    return { pct, flat: false, zone };
  }

  function renderDayPosition(q) {
    const row = $("#posRow");
    const info = dayPosition(q);
    if (!info) { row.classList.add("hidden"); return; }
    row.classList.remove("hidden");
    row.dataset.zone = info.flat ? "flat" : info.zone.key;
    $("#posFill").style.width = `${info.flat ? 100 : info.pct}%`;
    $("#posPct").textContent = info.flat ? "全天同价" : `${info.pct.toFixed(0)}%`;
    $("#posZone").textContent = info.flat ? "一字/停牌" : info.zone.text;
    row.title = info.flat
      ? "今日最高 = 最低，位置无意义"
      : `现价在今日 ${fmtPrice(q.low)}–${fmtPrice(q.high)} 区间的 ${info.pct.toFixed(1)}% 位置`;
    renderStreak(state.selected.code);
    maybeRecordAllCloses(q);
  }

  // 占位：高度本来就稳定（字体/行高固定），跳的是宽度——
  // "--" 只有 33px，换到 "3476.47" 是 116px，整行会横着弹一下。
  // 所以占位用「和真实数值等宽的空白数字」，视觉上仍是一块留白，但宽度不变。
  function placeholderDigits(n) {
    // U+2007 FIGURE SPACE：宽度等于数字，配合等宽字体正好对齐
    return "\u2007".repeat(n);
  }

  function renderQuotePlaceholder() {
    $("#stockName").textContent = state.selected.name;
    setCodeLink($("#stockCode"), state.selected.code);
    $("#stockLast").textContent = placeholderDigits(7);
    $("#stockChange").textContent = placeholderDigits(6);
    $("#stockPct").textContent = placeholderDigits(6);
    $("#stockAmp").textContent = "";
    $("#stockStats").innerHTML = "";
    // 位置条不隐藏：它在抬头里占一行，隐藏后再出现会把下面的图表挤 13px。
    // 改成保留行高、内容留白，数据到位时只换字不动版。
    renderPosPlaceholder();
    syncStar();
  }

  function renderPosPlaceholder() {
    const row = $("#posRow");
    row.classList.remove("hidden");
    row.dataset.zone = "flat";
    $("#posFill").style.width = "0%";
    $("#posPct").textContent = "";
    $("#posZone").textContent = "";
    $("#posStreak").classList.add("hidden");
    row.title = "";
  }

  async function loadQuote() {
    const code = state.selected.code;
    try {
      const q = await api(`/api/quote?code=${encodeURIComponent(code)}`);
      if (state.selected.code !== code) return;
      state.quote = q;
      if (q.name && !/^(sh|sz|bj)\d{6}$/.test(q.name)) {
        state.selected.name = q.name;
      }
      renderQuote(q);
      if (!$("#alertPanel").classList.contains("hidden")) updateAlertTarget();
    } catch (err) {
      if (state.selected.code === code) setConn(false);
    }
  }

  /* ---------------- 自选 ---------------- */
  function inWatch(code) {
    return state.watchlist.some((w) => w.code === code);
  }

  function syncStar() {
    const on = inWatch(state.selected.code);
    const btn = $("#starBtn");
    btn.classList.toggle("on", on);
    const label = $("#starText");
    if (label) label.textContent = on ? "已自选" : "自选";
    btn.title = on ? "移出自选" : "加入自选";
    btn.setAttribute("aria-label", btn.title);
  }

  function renderWatchlist(items) {
    state.watchlist = items || [];
    $("#watchCount").textContent = state.watchlist.length;
    $("#watchBtnCount").textContent = state.watchlist.length;
    $("#watchBtn").setAttribute("aria-label", `自选列表，共 ${state.watchlist.length} 只`);
    $("#watchEmpty").classList.toggle("hidden", state.watchlist.length > 0);
    // 拖拽过程中不要重绘，否则会把手里的节点换掉
    if (state.drag && state.drag.active) { syncStar(); return; }
    const wrap = $("#watchList");
    wrap.innerHTML = state.watchlist.map((it) => {
      const dec = decimalsFor(it.code, it.last);
      const active = it.code === state.selected.code ? "active" : "";
      return `
        <div class="watch-row ${active}" data-code="${esc(it.code)}" data-name="${esc(it.name)}">
          <button class="w-drag" type="button" data-drag="${esc(it.code)}"
                  title="拖动调整顺序" aria-label="拖动调整 ${esc(it.name)} 的顺序">
            <svg viewBox="0 0 6 14" aria-hidden="true"><circle cx="1.4" cy="2" r=".9" fill="currentColor"/><circle cx="4.6" cy="2" r=".9" fill="currentColor"/><circle cx="1.4" cy="7" r=".9" fill="currentColor"/><circle cx="4.6" cy="7" r=".9" fill="currentColor"/><circle cx="1.4" cy="12" r=".9" fill="currentColor"/><circle cx="4.6" cy="12" r=".9" fill="currentColor"/></svg>
          </button>
          <div class="w-name">${esc(it.name)}</div>
          <div class="w-meta">
            ${codeLinkHTML(it.code, "w-code code-link")}
            <span class="w-amp" title="振幅 =（最高 − 最低）/ 昨收">振 ${fmtAmp(it)}</span>
          </div>
          <div class="w-price ${dirClass(it.pct)}">${fmtPrice(it.last, dec)}</div>
          <div class="w-pct ${dirClass(it.pct)}">${fmtPct(it.pct)}</div>
          <button class="w-del" data-del="${esc(it.code)}" title="移出自选">×</button>
        </div>`;
    }).join("");
    syncStar();
  }

  /* ---------------- 自选拖拽排序 ---------------- */
  // 用 pointer 事件自己实现：HTML5 dnd 在触屏上不工作，而手机是最需要排序的场景。
  function dragOrder() {
    return $$("#watchList .watch-row").map((el) => el.dataset.code);
  }

  function startDrag(e) {
    const handle = e.target.closest(".w-drag");
    if (!handle) return;
    const row = handle.closest(".watch-row");
    if (!row) return;
    e.preventDefault();
    const rows = $$("#watchList .watch-row");
    state.drag = {
      active: true,
      code: row.dataset.code,
      startY: e.clientY,
      rowH: row.offsetHeight || 44,
      rows,
      from: rows.indexOf(row),
      to: rows.indexOf(row),
      left: false,
    };
    row.classList.add("dragging");
    $("#watchList").classList.add("dragging");
    handle.setPointerCapture?.(e.pointerId);
    if (window.innerWidth > 760) document.body.style.cursor = "grabbing";
  }

  function moveDrag(e) {
    const d = state.drag;
    if (!d || !d.active) return;
    e.preventDefault();
    const dy = e.clientY - d.startY;
    const row = d.rows[d.from];
    row.style.transform = `translateY(${dy}px)`;
    // 目标是往下挪几个位置（用行高估算，行高固定）
    const steps = Math.round(dy / d.rowH);
    const to = Math.max(0, Math.min(d.rows.length - 1, d.from + steps));
    if (to !== d.to) {
      d.to = to;
      d.rows.forEach((el, i) => {
        if (i === d.from) return;
        let shift = 0;
        if (d.from < to && i > d.from && i <= to) shift = -d.rowH;
        else if (d.from > to && i >= to && i < d.from) shift = d.rowH;
        el.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    }
  }

  async function endDrag() {
    const d = state.drag;
    if (!d || !d.active) return;
    state.drag = null;
    const row = d.rows[d.from];
    row.style.transform = "";
    d.rows.forEach((el) => { el.style.transform = ""; el.classList.remove("dragging"); });
    $("#watchList").classList.remove("dragging");
    if (window.innerWidth > 760) document.body.style.cursor = "";
    if (d.to === d.from) return;

    const codes = dragOrder();
    const moved = codes.splice(d.from, 1)[0];
    codes.splice(d.to, 0, moved);
    // 先本地重排（不等网络），失败再拉回服务端顺序
    const byCode = new Map(state.watchlist.map((w) => [w.code, w]));
    state.watchlist = codes.map((c) => byCode.get(c)).filter(Boolean);
    renderWatchlist(state.watchlist);
    try {
      await api("/api/watchlist/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes }),
      });
    } catch (err) {
      setConn(false);
      await refreshWatchlist();
    }
  }

  async function refreshWatchlist() {
    if (state.drag && state.drag.active) return;
    try {
      const data = await api("/api/watchlist");
      renderWatchlist(data.items);
    } catch (err) {
      /* 静默，下一轮再试 */
    }
  }

  async function toggleWatch() {
    const code = state.selected.code;
    try {
      if (inWatch(code)) {
        await api(`/api/watchlist?code=${encodeURIComponent(code)}`, { method: "DELETE" });
      } else {
        await api("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
      }
      await refreshWatchlist();
    } catch (err) {
      setConn(false);
    }
  }

  /* ---------------- 区间涨跌 ---------------- */
  function renderPerformance(data) {
    const wrap = $("#perfItems");
    const periods = (data && data.periods) || [];
    if (!periods.length) {
      wrap.innerHTML = '<span class="perf-empty">历史数据不足</span>';
      return;
    }
    wrap.innerHTML = periods
      .map((p) => {
        const cls = p.pct > 0 ? "up" : p.pct < 0 ? "down" : "flat";
        const sign = p.pct > 0 ? "+" : "";
        return `<div class="perf-item" data-bars="${p.bars}" title="${esc(p.start_date)} 至 ${esc(p.end_date)}">
          <span>${esc(p.label)}</span><b class="${cls}">${sign}${p.pct.toFixed(2)}%</b>
        </div>`;
      })
      .join("");
  }

  async function loadPerformance() {
    const code = state.selected.code;
    try {
      const data = await api(`/api/performance?code=${encodeURIComponent(code)}`);
      if (state.selected.code !== code) return;
      state.performance = data;
      renderPerformance(data);
    } catch (err) {
      /* 静默，下一轮再试 */
    }
  }

  /* ---------------- 盯盘提醒 ---------------- */
  function loadAlerts() {
    try {
      const raw = JSON.parse(localStorage.getItem(ALERT_KEY) || "[]");
      state.alerts = Array.isArray(raw)
        ? raw.filter((a) => a && a.id && a.code && a.type && Number.isFinite(Number(a.value)))
        : [];
    } catch (e) {
      state.alerts = [];
    }
  }

  function saveAlerts() {
    try { localStorage.setItem(ALERT_KEY, JSON.stringify(state.alerts)); } catch (e) { /* ignore */ }
  }

  function alertLabel(a) {
    const v = Number(a.value) || 0;
    if (a.type === "price_above") return `价格 ≥ ${v.toFixed(a.dec ?? 2)}`;
    if (a.type === "price_below") return `价格 ≤ ${v.toFixed(a.dec ?? 2)}`;
    if (a.type === "pct_above") return `涨幅 ≥ ${v.toFixed(2)}%`;
    return `跌幅 ≥ ${Math.abs(v).toFixed(2)}%`;
  }

  function renderAlerts() {
    const list = $("#alertList");
    const badge = $("#alertBadge");
    const has = state.alerts.length > 0;
    const hit = state.alerts.some((a) => a.triggered);
    const active = state.alerts.filter((a) => !a.triggered).length;
    badge.classList.toggle("on", has);
    badge.classList.toggle("hit", hit);
    $("#alertBtn").title = has ? `盯盘提醒（监控中 ${active} 个）` : "盯盘提醒";
    if (!has) {
      list.innerHTML = '<div class="alert-empty">还没有盯盘条件。<br>添加后，触发时会弹出系统通知和页面提示。</div>';
      return;
    }
    list.innerHTML = state.alerts.map((a) => {
      const when = a.triggeredAt ? new Date(a.triggeredAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
      return `<div class="alert-item ${a.triggered ? "done" : ""}" data-id="${esc(a.id)}" data-code="${esc(a.code)}">
        <div class="alert-line"><b>${esc(a.name)}</b><span class="alert-cond">${alertLabel(a)}</span></div>
        <div class="alert-meta">${a.triggered ? `已触发 ${when}` : "监控中"}</div>
        <div class="alert-actions">
          ${a.triggered ? '<button type="button" data-act="reset">重置</button>' : ""}
          <button type="button" data-act="del">删除</button>
        </div>
      </div>`;
    }).join("");
  }

  function updatePerm() {
    const el = $("#alertPerm");
    if (!("Notification" in window)) {
      el.innerHTML = "<span>当前浏览器不支持系统通知，仅页面内提示</span>";
      return;
    }
    const p = Notification.permission;
    if (p === "granted") {
      el.innerHTML = '<span>系统通知已开启</span><button type="button" data-notify="test">测试</button>';
    } else if (p === "denied") {
      el.innerHTML = "<span>通知被浏览器拒绝，请在站点设置中允许</span>";
    } else {
      el.innerHTML = '<span>开启系统通知，切到后台也能提醒</span><button type="button" data-notify="enable">开启</button>';
    }
  }

  async function showSystemNotification(title, body, tag, code) {
    if (!("Notification" in window) || Notification.permission !== "granted") return false;
    if (navigator.serviceWorker) {
      try {
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((resolve) => setTimeout(() => resolve(null), 800)),
        ]);
        if (reg && reg.showNotification) {
          await reg.showNotification(title, { body, tag, data: { code } });
          return true;
        }
      } catch (e) { /* fall through */ }
    }
    try {
      const n = new Notification(title, { body, tag });
      n.onclick = () => { window.focus(); selectByCode(code); };
      return true;
    } catch (e) {
      return false;
    }
  }

  async function requestNotify() {
    if (!("Notification" in window)) { updatePerm(); return; }
    if (Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
    updatePerm();
    if (Notification.permission === "granted") {
      showSystemNotification("盯盘通知已开启", "触发条件时会在这里提醒你", "perm-test", state.selected.code);
    }
  }

  function selectByCode(code) {
    if (!code) return;
    const a = state.alerts.find((x) => x.code === code);
    selectStock(code, a ? a.name : code, a ? a.dec : decimalsFor(code));
  }

  function pushToast(title, body, alert) {
    const box = $("#toasts");
    while (box.children.length >= 3) box.firstElementChild.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span>`;
    el.addEventListener("click", () => {
      closeAlerts();
      selectByCode(alert.code);
      el.remove();
    });
    box.appendChild(el);
    setTimeout(() => el.remove(), 9000);
  }

  async function evaluateAlerts() {
    if (state.alertBusy) return;
    const active = state.alerts.filter((a) => !a.triggered);
    if (!active.length) return;
    state.alertBusy = true;
    try {
      const codes = [...new Set(active.map((a) => a.code))];
      const map = new Map();
      for (let i = 0; i < codes.length; i += 50) {
        const data = await api(
          `/api/quotes?codes=${encodeURIComponent(codes.slice(i, i + 50).join(","))}`
        );
        for (const s of data.items || []) map.set(s.code, s);
      }
      let changed = false;
      for (const a of active) {
        const snap = map.get(a.code);
        if (!snap || !snap.last) continue;
        const v = Number(a.value);
        let hit = false;
        if (a.type === "price_above") hit = snap.last >= v;
        else if (a.type === "price_below") hit = snap.last <= v;
        else if (a.type === "pct_above") hit = snap.pct >= v;
        else if (a.type === "pct_below") hit = snap.pct <= -Math.abs(v);
        if (!hit || a.lastHit) {
          a.lastHit = hit;
          continue;
        }
        a.lastHit = hit;
        a.triggered = true;
        a.triggeredAt = Date.now();
        a.lastPrice = snap.last;
        a.lastPct = snap.pct;
        changed = true;
        const dec = a.dec || decimalsFor(a.code, snap.last);
        const price = fmtPrice(snap.last, dec);
        showSystemNotification(
          `${a.name} ${price}`,
          `${alertLabel(a)} 已触发 · 现价 ${price}（${fmtPct(snap.pct)}）`,
          a.id,
          a.code
        );
        pushToast(`${a.name} ${price}`, `${alertLabel(a)} 已触发 · ${fmtPct(snap.pct)}`, a);
      }
      if (changed) {
        saveAlerts();
        renderAlerts();
      }
    } catch (e) {
      /* 网络错误静默，下一轮再试 */
    } finally {
      state.alertBusy = false;
    }
  }

  function suggestThreshold() {
    const input = $("#alertValue");
    const q = state.quote;
    if (!q || !q.last) return;
    const type = $("#alertType").value;
    const dec = state.selected.decimal;
    if (type === "price_above") input.value = (q.last * 1.01).toFixed(dec);
    else if (type === "price_below") input.value = (q.last * 0.99).toFixed(dec);
    else input.value = "5.00";
  }

  function updateAlertTarget() {
    $("#alertName").textContent = state.selected.name;
    setCodeLink($("#alertCode"), state.selected.code);
    const q = state.quote;
    if (q && q.last) {
      $("#alertQuote").innerHTML = `<span class="${dirClass(q.pct)}">${fmtPrice(q.last, state.selected.decimal)} ${fmtPct(q.pct)}</span>`;
    } else {
      $("#alertQuote").textContent = "";
    }
    if (!$("#alertValue").value) suggestThreshold();
  }

  function openAlerts() {
    closeWatchDrawer(false);
    $("#alertOverlay").classList.remove("hidden");
    $("#alertPanel").classList.remove("hidden");
    document.body.classList.add("alert-open");
    updatePerm();
    updateAlertTarget();
    renderAlerts();
    if (window.innerWidth > 760) setTimeout(() => $("#alertValue").focus(), 30);
  }

  function closeAlerts() {
    $("#alertOverlay").classList.add("hidden");
    $("#alertPanel").classList.add("hidden");
    document.body.classList.remove("alert-open");
  }

  /* ---------------- 自选抽屉（窄屏） ---------------- */
  function watchDrawerOpen() {
    return document.body.classList.contains("watch-open");
  }

  function openWatchDrawer() {
    if (window.innerWidth > 760) return;
    closeAlerts();
    document.body.classList.add("watch-open");
    $("#watchBtn").setAttribute("aria-expanded", "true");
    setTimeout(() => $("#watchClose").focus({ preventScroll: true }), 40);
  }

  function closeWatchDrawer(refocus) {
    if (!watchDrawerOpen()) return;
    document.body.classList.remove("watch-open");
    $("#watchBtn").setAttribute("aria-expanded", "false");
    if (refocus) $("#watchBtn").focus({ preventScroll: true });
  }

  async function addAlert(e) {
    e.preventDefault();
    const type = $("#alertType").value;
    const raw = Number($("#alertValue").value);
    const hint = $("#alertHint");
    hint.classList.remove("warn");
    if (!Number.isFinite(raw)) {
      hint.textContent = "请输入有效阈值";
      hint.classList.add("warn");
      return;
    }
    const isPct = type.startsWith("pct");
    const value = isPct ? Math.abs(raw) : raw;
    if ((isPct && (value <= 0 || value > 30)) || (!isPct && value <= 0)) {
      hint.textContent = isPct ? "涨跌幅阈值需在 0–30% 之间" : "价格阈值需大于 0";
      hint.classList.add("warn");
      return;
    }
    const alert = {
      id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      code: state.selected.code,
      name: state.selected.name,
      type,
      value,
      dec: state.selected.decimal,
      triggered: false,
      lastHit: false,
      createdAt: Date.now(),
      triggeredAt: null,
      lastPrice: state.quote ? state.quote.last : null,
    };
    state.alerts.unshift(alert);
    saveAlerts();
    renderAlerts();
    hint.textContent = `已添加：${alertLabel(alert)}`;
    $("#alertValue").value = "";
    if ("Notification" in window && Notification.permission === "default") {
      await requestNotify();
    }
    evaluateAlerts();
  }

  // 分时图上要对照的日均线价位：MA5 / MA20 / MA60，用日K收盘价算
  const MA_DEFS = [
    { n: 5, key: "ma5", label: "MA5" },
    { n: 20, key: "ma20", label: "MA20" },
    { n: 60, key: "ma60", label: "MA60" },
  ];

  async function loadMaLevels(code) {
    try {
      const data = await api(`/api/kline?code=${encodeURIComponent(code)}&period=day&count=70&adjust=qfq`);
      const bars = data.bars || [];
      const closes = bars.map((b) => b[2]);
      const out = [];
      for (const def of MA_DEFS) {
        if (closes.length < def.n) continue;
        const slice = closes.slice(-def.n);
        const avg = slice.reduce((s, v) => s + v, 0) / def.n;
        out.push({ ...def, value: +avg.toFixed(3) });
      }
      return out.length ? out : null;
    } catch (e) {
      return null;
    }
  }

  // 分时图右上角的均线图例：与 K 线 MA 图例同形（12×2 色块 + 名称），
  // 点击逐条开关，开着的才显示价位
  function renderMaLegend(lastPrice) {
    const el = $("#maLegend");
    if (!el) return;
    const levels = state.mode === "minute" ? state.maLevels : null;
    if (!levels || !levels.length) { el.classList.add("hidden"); return; }
    const dec = state.selected.decimal;
    const price = num(lastPrice);
    el.innerHTML = levels.map((ma) => {
      const off = Boolean(state.maOff[ma.key]);
      const diff = price ? (price / ma.value - 1) * 100 : null;
      const dTxt = diff == null ? "" : `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}%`;
      const title = off
        ? `显示 ${ma.label}`
        : `隐藏 ${ma.label}${dTxt ? `（现价距它 ${dTxt}）` : ""}`;
      // 关闭时文字照常保留、只压暗：图例贴右对齐，若整段变短会让所有项右移，
      // 鼠标下的目标就换了，连点第二次会打偏到另一条线上。
      return `<button type="button" class="ma-item${off ? " off" : ""}" data-ma="${ma.key}"`
        + ` aria-pressed="${off ? "false" : "true"}" title="${esc(title)}">`
        + `<i style="background:${COLORS[ma.key]}"></i>${ma.label}`
        + `<b>${fmtPrice(ma.value, dec)}</b><em>${dTxt}</em></button>`;
    }).join("");
    el.classList.remove("hidden");
  }

  /* ---------------- 选中 ---------------- */
  function selectStock(code, name, decimal) {
    if (!code) return;
    state.selected = {
      code,
      name: name || code,
      decimal: decimal ?? decimalsFor(code),
    };
    state.quote = null;
    state.performance = null;
    state.pendingZoom = null;
    $("#perfItems").innerHTML = "";
    renderQuotePlaceholder();
    $$(".index-card").forEach((el) => el.classList.toggle("active", el.dataset.code === code));
    revealActiveIndex();
    $$(".watch-row").forEach((el) => el.classList.toggle("active", el.dataset.code === code));
    loadQuote();
    loadChart();
    loadPerformance();
    syncStar();
    if (!$("#alertPanel").classList.contains("hidden")) updateAlertTarget();
    closeWatchDrawer(false);
  }

  /* ---------------- 图表 ---------------- */
  function initChart() {
    if (!window.echarts) {
      $("#chartEmpty").textContent = "ECharts 加载失败";
      $("#chartEmpty").classList.remove("hidden");
      return;
    }
    state.chart = echarts.init($("#chart"), null, { renderer: "canvas" });
    state.chart.on("dataZoom", scheduleRangeText);
    window.addEventListener("resize", () => state.chart && state.chart.resize());
    if (window.ResizeObserver) {
      new ResizeObserver(() => state.chart && state.chart.resize()).observe($("#chart"));
    }
  }

  function showChartEmpty(msg) {
    const el = $("#chartEmpty");
    el.textContent = msg || "暂无数据";
    el.classList.remove("hidden");
  }

  function hideChartEmpty() {
    $("#chartEmpty").classList.add("hidden");
  }

  function tooltipBox(inner) {
    return `<div class="tt">${inner}</div>`;
  }

  function resampleAuction(points, buckets = 31) {
    if (!points || !points.length) return [];
    const toSec = (t) => {
      const parts = String(t).split(":").map(Number);
      return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
    };
    const start = 9 * 3600 + 15 * 60;
    const end = 9 * 3600 + 25 * 60;
    const out = [];
    let idx = 0;
    let last = null;
    for (let i = 0; i < buckets; i++) {
      const target = start + ((end - start) * i) / (buckets - 1);
      while (idx < points.length && toSec(points[idx][0]) <= target + 2) {
        last = points[idx];
        idx += 1;
      }
      if (!last) continue;
      const sec = Math.round(target);
      const hh = String(Math.floor(sec / 3600)).padStart(2, "0");
      const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
      const ss = String(sec % 60).padStart(2, "0");
      out.push([ss === "00" ? `${hh}:${mm}` : `${hh}:${mm}:${ss}`, last[1], last[2], last[3]]);
    }
    if (out.length) {
      const fin = points[points.length - 1];
      out[out.length - 1] = ["09:25", fin[1], fin[2], fin[3]];
    }
    return out;
  }

  function sessionLabels() {
    const pad = (n) => String(n).padStart(2, "0");
    const out = [];
    for (let m = 9 * 60 + 31; m <= 11 * 60 + 30; m++) {
      out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
    }
    for (let m = 13 * 60 + 1; m <= 15 * 60; m++) {
      out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
    }
    return out;
  }

  function renderMinute(data, auction) {
    if (!state.chart) return;
    const minutePoints = data.points || [];
    const minuteMap = new Map();
    for (const p of minutePoints) minuteMap.set(p[0], p);
    const sessions = sessionLabels();
    const pre = num(data.pre_close) || num(auction && auction.pre_close) || 0;
    const auctionHasData = Boolean(auction && auction.points && auction.points.length);
    const au = state.showAuction && auctionHasData ? resampleAuction(auction.points, 11) : [];
    const hasAuction = au.length > 1;
    const hasSessionData = sessions.some((t) => minuteMap.has(t));

    if (!pre || (!hasAuction && !hasSessionData)) {
      updateAuctionToggle(auctionHasData);
      showChartEmpty("当前无分时数据");
      state.chart.clear();
      return;
    }
    hideChartEmpty();

    const dec = state.selected.decimal;
    const isIndex = /^(sh000|sz399|bj899)/.test(data.code || state.selected.code);
    const times = [];
    const prices = [];
    const avgs = [];
    const vols = [];
    const matched = [];
    const unmatched = [];

    if (hasAuction) {
      for (let i = 0; i < au.length; i++) {
        times.push(au[i][0]);
        prices.push(au[i][1]);
        avgs.push(null);
        vols.push(i === 0 ? au[i][2] : Math.max(0, au[i][2] - au[i - 1][2]));
        matched.push(au[i][2]);
        unmatched.push(au[i][3]);
      }
    }

    const openPrice =
      num(data.open) ||
      (au.length ? au[au.length - 1][1] : null) ||
      (minutePoints.length ? minutePoints[0][1] : null);
    times.push("09:30");
    prices.push(openPrice);
    avgs.push(null);
    vols.push(0);
    matched.push(0);
    unmatched.push(0);
    const separatorIndex = times.length - 1;

    for (const t of sessions) {
      const p = minuteMap.get(t) || (t === "13:01" ? minuteMap.get("13:00") : null);
      times.push(t);
      prices.push(p ? p[1] : null);
      avgs.push(p ? (p[2] || null) : null);
      vols.push(p ? p[3] : null);
      matched.push(0);
      unmatched.push(0);
    }

    const validPrices = prices.filter((v) => v != null);
    const devs = validPrices.map((p) => Math.abs(p / pre - 1));
    // 轴只按分时价格撑开；均线不参与，否则一条远在 5% 外的 MA5 会把分时压成一小条
    const dev = Math.max(...devs, 0.004) * 1.12;
    const [min, max, step] = niceRange(pre * (1 - dev), pre * (1 + dev), 5);

    const labelSet = new Set(["09:30", "10:30", "11:30", "14:00", "15:00"]);

    let cumPv = 0;
    let cumV = 0;
    const computedAvg = avgs.map((v, i) => {
      if (i <= separatorIndex) return null;
      const vv = vols[i] || 0;
      if (vv) {
        cumPv += prices[i] * vv;
        cumV += vv;
      }
      // 未到的时刻没有成交：返回 null，让均价线跟着价格线一起断掉，
      // 否则会用累计均价一路平着画到 15:00。
      if (prices[i] == null) return null;
      return cumV ? +(cumPv / cumV).toFixed(3) : prices[i];
    });
    const avgLine = isIndex ? computedAvg : avgs;

    const volColors = vols.map((v, i) => {
      if (v == null) return COLORS.axis;
      if (i < separatorIndex) return prices[i] >= pre ? COLORS.up : COLORS.down;
      const prev = i > 0 && prices[i - 1] != null ? prices[i - 1] : pre;
      return prices[i] >= prev ? COLORS.up : COLORS.down;
    });

    const labelCfg = {
      color: COLORS.axis,
      fontSize: 11,
      hideOverlap: true,
      interval: (i, val) => labelSet.has(val),
      formatter: (v) => (v === "11:30" ? "11:30/13:00" : v.slice(0, 5)),
    };

    const markData = [{ yAxis: pre }];
    const minuteMarks = state.showMarks
      ? findMinuteMarks(prices, vols, isIndex, separatorIndex + 1).map((h) => ({
          coord: [h.i, prices[h.i]],
          value: h.dir === "up" ? "拉" : "砸",
          symbol: "triangle",
          symbolRotate: h.dir === "up" ? 0 : 180,
          symbolSize: 5,
          itemStyle: { color: h.dir === "up" ? COLORS.up : COLORS.down },
          label: {
            show: true,
            position: h.dir === "up" ? "top" : "bottom",
            distance: 0,
            color: h.dir === "up" ? COLORS.markUp : COLORS.markDown,
            fontSize: 10,
            fontWeight: 500,
            lineHeight: 10,
          },
        }))
      : [];
    if (hasAuction) {
      markData.push({ xAxis: "09:30", lineStyle: { color: COLORS.border, type: "solid", width: 1 } });
    }

    // 日均线参考线：只画落在【坐标轴范围内】的。轴内位置是准的；
    // 轴外不硬画（会被压到边缘，看着像今日成交价），改为在图例里用 ↑↓ 标注它在视野外。
    if (state.maLevels) {
      for (const ma of state.maLevels) {
        if (state.maOff[ma.key]) continue;
        if (ma.value < min || ma.value > max) continue;
        markData.push({
          yAxis: ma.value,
          lineStyle: { color: COLORS[ma.key], type: "solid", width: 1, opacity: 0.85 },
          label: {
            show: true,
            position: "insideEndTop",
            distance: 2,
            formatter: `${ma.label} ${fmtPrice(ma.value, dec)}`,
            color: COLORS[ma.key],
            fontSize: 9.5,
          },
        });
      }
    }
    // 窄屏放不下一行均线数值：让它单独占一行，图区顶部相应下移


    // 用最后一个有成交的分钟价，而不是 15:00 的空槽
    let lastMinutePrice = null;
    for (let i = prices.length - 1; i >= 0; i--) {
      if (prices[i] != null) { lastMinutePrice = prices[i]; break; }
    }

    // 图例先渲染，再按它的真实高度让出顶部空间（窄屏会换行成两行，写死数值会压到图上）
    const legendEl = $("#maLegend");
    const legendWraps = state.chart.getWidth() < 560;
    legendEl.classList.toggle("wide", legendWraps);
    renderMaLegend(lastMinutePrice);
    const legendH = legendEl.classList.contains("hidden") ? 0 : legendEl.offsetHeight + 4;

    const option = {
      animation: false,
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        backgroundColor: COLORS.tooltipBg,
        borderColor: COLORS.border,
        borderWidth: 1,
        padding: [8, 10],
        confine: true,
        textStyle: {
          color: COLORS.text,
          fontSize: 11.5,
          fontFamily: '"Inter","PingFang SC","Microsoft YaHei",sans-serif',
        },
        extraCssText: `border-radius:2px;box-shadow:${COLORS.shadow};`,
        axisPointer: { type: "cross", lineStyle: { color: COLORS.axis, type: "solid", opacity: 0.55 }, crossStyle: { color: COLORS.axis, type: "solid", opacity: 0.55 } },
        formatter(params) {
          if (!params || !params.length) return "";
          const idx = params[0].dataIndex;
          const price = prices[idx];
          if (price == null) return "";
          const pct = pre ? ((price / pre - 1) * 100) : 0;
          const dir = pct >= 0 ? "up" : "down";
          const head = times[idx];
          const rows = [`<div class="tt-head">${esc(head)}</div>`];
          rows.push(`<div class="tt-row"><span>价格</span><span class="tt-val ${dir}">${fmtPrice(price, dec)}<em>${fmtPct(pct)}</em></span></div>`);
          if (hasAuction && idx < au.length) {
            rows[0] = `<div class="tt-head">竞价 ${esc(head)}</div>`;
            if (!isIndex) {
              rows.push(`<div class="tt-row"><span>匹配量</span><span class="tt-val">${fmtVolume(matched[idx])}</span></div>`);
              rows.push(`<div class="tt-row"><span>未匹配</span><span class="tt-val">${fmtVolume(unmatched[idx])}</span></div>`);
            }
          } else if (idx === separatorIndex) {
            rows[0] = '<div class="tt-head">09:30 开盘</div>';
          } else {
            const avg = avgLine[idx];
            rows.push(`<div class="tt-row"><span>均价</span><span class="tt-val">${avg ? fmtPrice(avg, dec) : "--"}</span></div>`);
            rows.push(`<div class="tt-row"><span>成交量</span><span class="tt-val">${vols[idx] == null ? "--" : fmtVolume(vols[idx])}</span></div>`);
          }
          return `<div class="tt">${rows.join("")}</div>`;
        },
      },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      grid: [
        { left: 64, right: 64, top: Math.max(18, (legendWraps ? 15 : 4) + legendH), height: "58%" },
        { left: 64, right: 64, top: "72%", height: "16%" },
      ],
      xAxis: [
        {
          type: "category",
          data: times,
          boundaryGap: false,
          axisPointer: { label: { show: false } },
          axisLine: { lineStyle: { color: COLORS.border } },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false },
        },
        {
          type: "category",
          gridIndex: 1,
          data: times,
          boundaryGap: false,
          axisPointer: {
            label: {
              backgroundColor: COLORS.axis,
              color: COLORS.bg,
              fontSize: 10,
              borderWidth: 0,
              borderRadius: 2,
              padding: [2, 4],
            },
          },
          axisLine: { lineStyle: { color: COLORS.border } },
          axisTick: { show: false },
          axisLabel: labelCfg,
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          scale: true,
          min,
          max,
          interval: step,
          position: "left",
          axisPointer: { label: { show: false } },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: COLORS.axis, fontSize: 11, formatter: (v) => v.toFixed(dec) },
          splitLine: { lineStyle: { color: COLORS.grid } },
        },
        {
          min,
          max,
          interval: step,
          position: "right",
          axisPointer: { label: { show: false } },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: COLORS.axis,
            fontSize: 11,
            formatter: (v) => `${((v / pre - 1) * 100).toFixed(2)}%`,
          },
          splitLine: { show: false },
        },
        {
          gridIndex: 1,
          scale: true,
          axisPointer: { label: { show: false } },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "价格",
          type: "line",
          data: prices,
          showSymbol: false,
          smooth: false,
          lineStyle: { width: 1.4, color: COLORS.price },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: COLORS.rule, type: "dashed", width: 1 },
            label: { show: false },
            data: markData,
          },
          markPoint: minuteMarks.length ? { silent: true, data: minuteMarks } : undefined,
        },
        {
          name: "均价",
          type: "line",
          data: avgLine,
          showSymbol: false,
          lineStyle: { width: 1, color: COLORS.avg },
        },
        {
          name: "成交量",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 2,
          data: vols,
          itemStyle: {
            opacity: 0.55,
            color: (p) => volColors[p.dataIndex] || COLORS.axis,
          },
          barWidth: "62%",
        },
      ],
    };
    state.chart.setOption(option, true);
    updateAuctionToggle(auctionHasData);
  }

  function updateAuctionToggle(hasData) {
    const btn = $("#auctionToggle");
    if (!btn) return;
    if (!hasData || state.mode !== "minute") {
      btn.classList.add("hidden");
      return;
    }
    const o = (state.auctionData && state.auctionData.open) || {};
    const dec = state.selected.decimal;
    btn.classList.remove("hidden");
    if (state.showAuction && o.price) {
      const cls = o.pct > 0 ? "up" : o.pct < 0 ? "down" : "flat";
      btn.innerHTML = `竞价 ${fmtPrice(o.price, dec)} <em class="${cls}">${fmtPct(o.pct)}</em> <span class="chev">‹</span>`;
      btn.title = "收起集合竞价";
    } else {
      btn.innerHTML = '竞价 09:15~25 <span class="chev">›</span>';
      btn.title = "展开集合竞价";
    }
  }

  function movingAverage(closes, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= n) sum -= closes[i - n];
      out.push(i >= n - 1 ? +(sum / n).toFixed(3) : "-");
    }
    return out;
  }

  /* ---------------- 顶/底、拉/砸标注 ---------------- */
  // 顶/底：左右各 span 根的分形极值 + 摆动幅度过滤（相当于 ZigZag 近似）。
  // 右侧 span 根还没走完的枢轴一律不标，避免"未来函数"式的重绘。
  function findPivots(bars, span, minSwing) {
    const n = bars.length;
    const highs = bars.map((b) => b[4]);
    const lows = bars.map((b) => b[3]);
    const cand = [];
    for (let i = span; i < n - span; i++) {
      let isTop = true;
      let isBottom = true;
      for (let j = i - span; j <= i + span; j++) {
        if (j === i) continue;
        if (highs[j] >= highs[i]) isTop = false;
        if (lows[j] <= lows[i]) isBottom = false;
        if (!isTop && !isBottom) break;
      }
      if (isTop) cand.push({ i, kind: "top", price: highs[i] });
      else if (isBottom) cand.push({ i, kind: "bottom", price: lows[i] });
    }
    // 同向合并取更极端值；反向摆动不到 minSwing 的直接丢弃
    const out = [];
    for (const p of cand) {
      const last = out[out.length - 1];
      if (!last) { out.push(p); continue; }
      if (last.kind === p.kind) {
        if (p.kind === "top" ? p.price > last.price : p.price < last.price) out[out.length - 1] = p;
        continue;
      }
      const swing = p.kind === "top" ? p.price / last.price - 1 : last.price / p.price - 1;
      if (swing >= minSwing) out.push(p);
    }
    return out;
  }

  // 拉/砸：3 分钟涨跌幅超过阈值，且这 3 分钟均量 ≥ 前 10 分钟均量的 2 倍
  function findMinuteMarks(prices, vols, isIndex, from) {
    const n = prices.length;
    const k = 3;
    const thr = isIndex ? 0.004 : 0.012;
    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const hits = [];
    for (let i = Math.max(from + k, k); i < n; i++) {
      const a = prices[i - k];
      const b = prices[i];
      if (!a || b == null) continue;
      const chg = b / a - 1;
      if (Math.abs(chg) < thr) continue;
      const seg = [];
      const base = [];
      for (let j = i - k + 1; j <= i; j++) if (vols[j] != null) seg.push(vols[j]);
      for (let j = Math.max(from, i - k - 10); j <= i - k; j++) if (vols[j] > 0) base.push(vols[j]);
      if (!seg.length || base.length < 3) continue;
      if (avg(seg) < avg(base) * 2) continue;
      hits.push({ i, dir: chg > 0 ? "up" : "down", chg });
    }
    // 5 分钟内同向只留幅度最大的一次，最多 6 个
    const out = [];
    for (const h of hits) {
      const last = out[out.length - 1];
      if (last && last.dir === h.dir && h.i - last.i <= 5) {
        if (Math.abs(h.chg) > Math.abs(last.chg)) out[out.length - 1] = h;
        continue;
      }
      out.push(h);
    }
    return out.slice(-6);
  }

  function renderKline(data) {
    if (!state.chart) return;
    const bars = data.bars || [];
    if (!bars.length) {
      showChartEmpty("当前无K线数据");
      state.chart.clear();
      return;
    }
    hideChartEmpty();

    const dates = bars.map((b) => b[0]);
    const ohlc = bars.map((b) => [b[1], b[2], b[3], b[4]]);
    const closes = bars.map((b) => b[2]);
    const vols = bars.map((b) => b[5]);

    const ma5 = movingAverage(closes, 5);
    const ma10 = movingAverage(closes, 10);
    const ma20 = movingAverage(closes, 20);
    const ma60 = movingAverage(closes, 60);
    const maLines = [
      { label: "MA5", data: ma5, color: COLORS.ma5 },
      { label: "MA10", data: ma10, color: COLORS.ma10 },
      { label: "MA20", data: ma20, color: COLORS.ma20 },
      { label: "MA60", data: ma60, color: COLORS.ma60 },
    ];

    // 顶/底：日线要求摆动 ≥6%，周 ≥10%，月 ≥15%，避免小波动刷满屏
    const swing = state.mode === "week" ? 0.1 : state.mode === "month" ? 0.15 : 0.06;
    const pivots = state.showMarks ? findPivots(bars, 5, swing) : [];
    const kMarks = pivots.map((p) => ({
      coord: [p.i, p.price],
      value: p.kind === "top" ? "顶" : "底",
      // 用 0.1px 的透明点占位：只留文字，位置正好落在折线拐点上
      symbol: "circle",
      symbolSize: 0.1,
      itemStyle: { color: "transparent" },
      label: {
        show: true,
        position: p.kind === "top" ? "top" : "bottom",
        distance: 1,
        color: p.kind === "top" ? COLORS.markUp : COLORS.markDown,
        fontSize: 10,
        fontWeight: 500,
        lineHeight: 10,
      },
    }));

    const dec = state.selected.decimal;
    const zoomStart = Math.max(0, dates.length - 160);
    const adjLabel = data.adjust === "none" ? "不复权" : data.adjust === "hfq" ? "后复权" : "前复权";
    // 窄屏图窄，长文本会压到右侧 MA 图例上：缩成「根数 · 复权」，图例只留色块
    const narrow = state.chart.getWidth() < 560;
    const rangeText = narrow
      ? `${bars.length} 根 · ${adjLabel}`
      : `${bars[0][0]} 至 ${bars[bars.length - 1][0]}，${bars.length} 根，${adjLabel}`;
    state.klineMeta = { dates, adjust: adjLabel };

    const option = {
      animation: false,
      backgroundColor: "transparent",
      graphic: [
        {
          id: "rangeText",
          type: "text",
          left: 64,
          top: 5,
          style: { text: rangeText, fill: COLORS.axis, font: "10.5px -apple-system, sans-serif" },
        },
      ],
      legend: {
        data: ["MA5", "MA10", "MA20", "MA60"],
        right: narrow ? 8 : 58, top: 2,
        itemWidth: 12, itemHeight: 2, itemGap: narrow ? 9 : 12,
        textStyle: { color: COLORS.axis, fontSize: 11 },
        formatter: narrow ? () => "" : undefined,
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: COLORS.tooltipBg,
        borderColor: COLORS.border,
        borderWidth: 1,
        padding: [8, 10],
        confine: true,
        textStyle: {
          color: COLORS.text,
          fontSize: 11.5,
          fontFamily: '"Inter","PingFang SC","Microsoft YaHei",sans-serif',
        },
        extraCssText: `border-radius:2px;box-shadow:${COLORS.shadow};`,
        axisPointer: { type: "cross", lineStyle: { color: COLORS.axis, type: "solid", opacity: 0.55 }, crossStyle: { color: COLORS.axis, type: "solid", opacity: 0.55 } },
        formatter(params) {
          if (!params || !params.length) return "";
          const idx = params[0].dataIndex;
          const b = bars[idx];
          if (!b) return "";
          const [, open, close, low, high, vol] = b;
          const preClose = idx > 0 ? bars[idx - 1][2] : open;
          const pct = preClose ? ((close / preClose - 1) * 100) : 0;
          const amp = fmtAmp({ pre_close: preClose, high, low });
          const maRows = maLines
            .map((m) => `<div class="tt-row"><span class="tt-ma"><i style="background:${m.color}"></i>${m.label}</span><span class="tt-val">${fmtPrice(m.data[idx])}</span></div>`)
            .join("");
          return tooltipBox(`
            <div class="tt-head">${esc(b[0])}</div>
            <div class="tt-row"><span>开</span><span class="tt-val">${fmtPrice(open)}</span></div>
            <div class="tt-row"><span>收</span><span class="tt-val ${close >= open ? "up" : "down"}">${fmtPrice(close)}</span></div>
            <div class="tt-row"><span>高 / 低</span><span class="tt-val">${fmtPrice(high)} / ${fmtPrice(low)}</span></div>
            <div class="tt-row"><span>涨跌</span><span class="tt-val ${pct >= 0 ? "up" : "down"}">${fmtPct(pct)}</span></div>
            <div class="tt-row"><span>振幅</span><span class="tt-val">${amp}</span></div>
            <div class="tt-row"><span>成交量</span><span class="tt-val">${fmtVolume(vol)}</span></div>
            <div class="tt-sep"></div>
            ${maRows}`);
        },
      },
      grid: [
        { left: 64, right: 64, top: 28, height: "52%" },
        { left: 64, right: 64, top: "69%", height: "12%" },
      ],
      xAxis: [
        {
          type: "category", data: dates, boundaryGap: true,
          axisPointer: { label: { show: false } },
          axisLine: { lineStyle: { color: COLORS.border } },
          axisTick: { show: false }, axisLabel: { show: false }, splitLine: { show: false },
        },
        {
          type: "category", gridIndex: 1, data: dates, boundaryGap: true,
          axisPointer: { label: { backgroundColor: COLORS.axis, color: COLORS.bg, fontSize: 10, borderWidth: 0, borderRadius: 2, padding: [2, 4] } },
          axisLine: { lineStyle: { color: COLORS.border } },
          axisTick: { show: false },
          axisLabel: { color: COLORS.axis, fontSize: 11, hideOverlap: true },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          scale: true, splitNumber: 6, position: "left",
          axisPointer: { label: { show: false } },
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: COLORS.axis, fontSize: 11, formatter: (v) => v.toFixed(dec) },
          splitLine: { lineStyle: { color: COLORS.grid } },
        },
        {
          gridIndex: 1, scale: true,
          axisPointer: { label: { show: false } },
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { show: false }, splitLine: { show: false },
        },
      ],
      dataZoom: [
        {
          type: "inside", xAxisIndex: [0, 1],
          startValue: zoomStart, endValue: dates.length - 1,
          filterMode: "filter",
        },
        {
          type: "slider", xAxisIndex: [0, 1],
          startValue: zoomStart, endValue: dates.length - 1,
          filterMode: "filter",
          bottom: 4, height: 18,
          borderColor: "rgba(128,128,128,.35)",
          backgroundColor: "rgba(128,128,128,.18)",
          fillerColor: "rgba(128,128,128,.16)",
          handleSize: "85%",
          showDetail: false,
          handleStyle: { color: "#8a8f95" },
          textStyle: { color: COLORS.axis, fontSize: 9.5 },
          dataBackground: {
            lineStyle: { color: "rgba(128,128,128,.25)" },
            areaStyle: { color: "rgba(128,128,128,.12)" },
          },
          selectedDataBackground: {
            lineStyle: { color: "rgba(128,128,128,.55)" },
            areaStyle: { color: "rgba(128,128,128,.18)" },
          },
        },
      ],
      series: [
        {
          name: "K线", type: "candlestick", data: ohlc,
          itemStyle: {
            color: COLORS.up, color0: COLORS.down,
            borderColor: COLORS.up, borderColor0: COLORS.down,
          },
          markPoint: kMarks.length ? { silent: true, data: kMarks } : undefined,
        },
        { name: "MA5", type: "line", data: ma5, showSymbol: false, lineStyle: { width: 1, color: COLORS.ma5 } },
        { name: "MA10", type: "line", data: ma10, showSymbol: false, lineStyle: { width: 1, color: COLORS.ma10 } },
        { name: "MA20", type: "line", data: ma20, showSymbol: false, lineStyle: { width: 1, color: COLORS.ma20 } },
        { name: "MA60", type: "line", data: ma60, showSymbol: false, lineStyle: { width: 1, color: COLORS.ma60 } },
        {
          name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: vols,
          itemStyle: {
            opacity: 0.55,
            color: (p) => {
              const b = bars[p.dataIndex];
              return b && b[2] >= b[1] ? COLORS.up : COLORS.down;
            },
          },
        },
      ],
    };
    state.chart.setOption(option, true);
    if (state.pendingZoom && state.mode === "day") {
      const n = dates.length;
      const start = Math.max(0, n - 1 - state.pendingZoom);
      state.chart.dispatchAction({ type: "dataZoom", startValue: start, endValue: n - 1 });
      state.pendingZoom = null;
    }
    scheduleRangeText();
  }

  let rangeRaf = 0;
  function scheduleRangeText() {
    if (rangeRaf) return;
    rangeRaf = requestAnimationFrame(() => {
      rangeRaf = 0;
      updateRangeText();
    });
  }

  function updateRangeText() {
    if (!state.chart || !state.klineMeta) return;
    const dates = state.klineMeta.dates;
    const n = dates.length;
    if (!n) return;
    const opt = state.chart.getOption();
    const dz = (opt.dataZoom || []).find((d) => d.type === "inside") || (opt.dataZoom || [])[0] || {};
    let s = dz.startValue;
    let e = dz.endValue;
    if (typeof s !== "number" || typeof e !== "number") {
      s = Math.round((((dz.start ?? 0) / 100) * (n - 1)));
      e = Math.round((((dz.end ?? 100) / 100) * (n - 1)));
    }
    s = Math.max(0, Math.min(n - 1, Math.round(s)));
    e = Math.max(0, Math.min(n - 1, Math.round(e)));
    const text = state.chart.getWidth() < 560
      ? `${e - s + 1} 根 · ${state.klineMeta.adjust}`
      : `${dates[s]} 至 ${dates[e]}，${e - s + 1} 根，${state.klineMeta.adjust}`;
    state.chart.setOption({
      graphic: [
        {
          id: "rangeText",
          type: "text",
          left: 64,
          top: 5,
          style: { text, fill: COLORS.axis, font: "10.5px -apple-system, sans-serif" },
        },
      ],
    });
  }

  async function loadChart() {
    const code = state.selected.code;
    const mode = state.mode;
    const seq = ++state.chartSeq;
    try {
      if (mode === "minute") {
        const [data, auction, maLevels] = await Promise.all([
          api(`/api/minute?code=${encodeURIComponent(code)}`),
          api(`/api/auction?code=${encodeURIComponent(code)}`).catch(() => null),
          loadMaLevels(code),
        ]);
        if (seq !== state.chartSeq) return;
        state.minuteData = data;
        state.auctionData = auction;
        state.maLevels = maLevels;
        renderMinute(data, auction);
      } else {
        const range = RANGES[state.range] || RANGES["5y"];
        const adjust = state.range === "all" ? "none" : "qfq";
        const data = await api(
          `/api/kline?code=${encodeURIComponent(code)}&period=${mode}&count=${range.count}&adjust=${adjust}`
        );
        if (seq !== state.chartSeq) return;
        renderKline(data);
      }
    } catch (err) {
      if (seq === state.chartSeq) showChartEmpty(`图表加载失败：${err.message}`);
    }
  }

  /* ---------------- 排行 ---------------- */
  function renderRank(rows) {
    const wrap = $("#rankList");
    wrap.innerHTML = (rows || []).map((r) => {
      const dec = decimalsFor(r.code, r.last);
      return `
        <div class="rank-row" data-code="${esc(r.code)}" data-name="${esc(r.name)}" data-dec="${dec}">
          <div class="rank-no">${r.rank}</div>
          <div class="rank-name">${esc(r.name)}</div>
          ${codeLinkHTML(r.code, "rank-code code-link")}
          <div class="rank-price">${fmtPrice(r.last, dec)}</div>
          <div class="rank-pct ${dirClass(r.pct)}">${fmtPct(r.pct)}</div>
        </div>`;
    }).join("");
  }

  async function refreshRank() {
    try {
      const data = await api(`/api/rank?sort=${state.rankSort}`);
      renderRank(data.rows);
    } catch (err) {
      /* 静默 */
    }
  }

  /* ---------------- 搜索 ---------------- */
  function hideSearch() {
    $("#searchResults").classList.add("hidden");
    state.searchItems = [];
    state.searchActive = -1;
  }

  function renderSearch(items, query) {
    const box = $("#searchResults");
    state.searchItems = items;
    state.searchActive = items.length ? 0 : -1;
    if (!items.length) {
      const hint = /^\d{6}$/.test(query.trim())
        ? `未收录该代码，按 <b>Enter</b> 尝试直接解析 ${esc(query.trim())}`
        : "未找到匹配的代码或名称";
      box.innerHTML = `<div class="sr-empty">${hint}</div>`;
      box.classList.remove("hidden");
      return;
    }
    box.innerHTML = items.map((it, i) => `
      <div class="sr-item ${i === 0 ? "active" : ""}" data-i="${i}">
        <span class="sr-name">${esc(it.name)}</span>
        <span class="sr-code">${esc(it.code)}</span>
        <span class="sr-tag">${TAGS[it.cat] || "其他"}</span>
      </div>`).join("");
    box.classList.remove("hidden");
  }

  function highlightSearch() {
    $$("#searchResults .sr-item").forEach((el, i) => {
      el.classList.toggle("active", i === state.searchActive);
    });
  }

  function pickSearch(item) {
    if (!item) return;
    hideSearch();
    $("#searchInput").value = "";
    $("#searchInput").blur();
    selectStock(item.code, item.name, item.decimal);
  }

  async function runSearch(q) {
    const query = q.trim();
    if (!query) { hideSearch(); return; }
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
      if ($("#searchInput").value.trim() !== query) return;
      renderSearch(data.results || [], query);
    } catch (err) {
      /* 静默 */
    }
  }

  async function enterSearch() {
    if (state.searchActive >= 0 && state.searchItems[state.searchActive]) {
      pickSearch(state.searchItems[state.searchActive]);
      return;
    }
    const q = $("#searchInput").value.trim();
    if (!q) return;
    if (/^\d{6}$/.test(q) || /^(sh|sz|bj)\d{6}$/i.test(q)) {
      try {
        const data = await api(`/api/lookup?code=${encodeURIComponent(q)}`);
        if (data.ok) pickSearch(data.item);
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  function syncChartChrome() {
    const isK = ["day", "week", "month"].includes(state.mode);
    $("#rangeWrap").classList.toggle("hidden", !isK);
    // 分时均线图例只在分时出现；K 线用自带的 MA5/10/20/60 图例
    if (isK) $("#maLegend").classList.add("hidden");
    if (state.mode !== "minute") $("#auctionToggle").classList.add("hidden");
  }

  function syncMarkBtn() {
    const btn = $("#markBtn");
    if (!btn) return;
    btn.classList.toggle("on", state.showMarks);
    btn.setAttribute("aria-pressed", state.showMarks ? "true" : "false");
    btn.title = state.showMarks ? "已显示顶/底、拉/砸标注（点击关闭）" : "显示顶/底、拉/砸标注";
  }

  function switchMode(mode) {
    if (mode !== "day") state.pendingZoom = null;
    state.mode = mode;
    $$("#chartTabs button[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    syncChartChrome();
    loadChart();
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    $("#indexStrip").addEventListener("click", (e) => {
      const card = e.target.closest(".index-card");
      if (!card) return;
      selectStock(card.dataset.code, card.dataset.name, 2);
    });

    // 拖拽排序（pointer 事件：鼠标 + 触屏都走同一套）
    const wl = $("#watchList");
    wl.addEventListener("pointerdown", startDrag);
    wl.addEventListener("pointermove", moveDrag);
    wl.addEventListener("pointerup", endDrag);
    wl.addEventListener("pointercancel", endDrag);

    $("#watchList").addEventListener("click", async (e) => {
      // 拖拽手柄不是"选股"入口
      if (e.target.closest(".w-drag")) return;
      const del = e.target.closest(".w-del");
      if (del) {
        e.stopPropagation();
        try {
          await api(`/api/watchlist?code=${encodeURIComponent(del.dataset.del)}`, { method: "DELETE" });
          await refreshWatchlist();
        } catch (err) { setConn(false); }
        return;
      }
      // 代码本身是雪球外链：点代码只开新标签，不切换标的
      if (e.target.closest("a.code-link")) return;
      const row = e.target.closest(".watch-row");
      if (row) selectStock(row.dataset.code, row.dataset.name, decimalsFor(row.dataset.code));
    });

    $("#starBtn").addEventListener("click", toggleWatch);

    $("#watchBtn").addEventListener("click", () => {
      if (watchDrawerOpen()) closeWatchDrawer(true);
      else openWatchDrawer();
    });
    $("#watchClose").addEventListener("click", () => closeWatchDrawer(true));
    $("#watchScrim").addEventListener("click", () => closeWatchDrawer(false));

    window.addEventListener("resize", () => {
      if (window.innerWidth > 760) closeWatchDrawer(false);
    });

    $("#alertBtn").addEventListener("click", () => {
      if (!$("#alertPanel").classList.contains("hidden")) closeAlerts();
      else openAlerts();
    });
    $("#alertClose").addEventListener("click", closeAlerts);
    $("#alertOverlay").addEventListener("click", closeAlerts);
    $("#alertForm").addEventListener("submit", addAlert);
    $("#alertType").addEventListener("change", suggestThreshold);
    $("#alertPerm").addEventListener("click", (e) => {
      const act = e.target.closest("button[data-notify]");
      if (!act) return;
      if (act.dataset.notify === "enable") requestNotify();
      else if (act.dataset.notify === "test") {
        showSystemNotification("测试通知", "盯盘提醒工作正常", "test", state.selected.code);
      }
    });
    $("#alertList").addEventListener("click", (e) => {
      const item = e.target.closest(".alert-item");
      if (!item) return;
      const alert = state.alerts.find((a) => a.id === item.dataset.id);
      if (!alert) return;
      const act = e.target.closest("button");
      if (act && act.dataset.act === "del") {
        state.alerts = state.alerts.filter((a) => a.id !== alert.id);
        saveAlerts();
        renderAlerts();
      } else if (act && act.dataset.act === "reset") {
        alert.triggered = false;
        alert.triggeredAt = null;
        alert.lastHit = true;
        saveAlerts();
        renderAlerts();
        evaluateAlerts();
      } else {
        selectByCode(alert.code);
        closeAlerts();
      }
    });

    $("#themeBtn").addEventListener("click", () => {
      applyTheme(state.theme === "dark" ? "light" : "dark");
    });

    $("#chartTabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      switchMode(btn.dataset.mode);
    });

    $("#rangeSel").addEventListener("change", (e) => {
      state.range = e.target.value;
      loadChart();
    });

    $("#maLegend").addEventListener("click", (e) => {
      const item = e.target.closest(".ma-item");
      if (!item) return;
      const key = item.dataset.ma;
      if (!key) return;
      state.maOff[key] = !state.maOff[key];
      if (!state.maOff[key]) delete state.maOff[key];
      try { localStorage.setItem("ashare-ma-off", JSON.stringify(state.maOff)); } catch (e2) { /* ignore */ }
      if (state.minuteData) renderMinute(state.minuteData, state.auctionData);
      else loadChart();
    });

    $("#markBtn").addEventListener("click", () => {
      state.showMarks = !state.showMarks;
      try { localStorage.setItem("ashare-marks", state.showMarks ? "1" : "0"); } catch (e) { /* ignore */ }
      syncMarkBtn();
      loadChart();
    });

    $("#auctionToggle").addEventListener("click", () => {
      state.showAuction = !state.showAuction;
      try { localStorage.setItem("ashare-show-auction", state.showAuction ? "1" : "0"); } catch (e) { /* ignore */ }
      if (state.minuteData) renderMinute(state.minuteData, state.auctionData);
      else loadChart();
    });

    $("#perfItems").addEventListener("click", (e) => {
      const item = e.target.closest(".perf-item");
      if (!item) return;
      const bars = Number(item.dataset.bars);
      if (!bars) return;
      state.pendingZoom = bars;
      switchMode("day");
    });

    $("#rankTabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-sort]");
      if (!btn) return;
      state.rankSort = btn.dataset.sort;
      $$("#rankTabs button").forEach((b) => b.classList.toggle("active", b === btn));
      refreshRank();
    });

    $("#rankList").addEventListener("click", (e) => {
      // 代码本身是雪球外链：点代码只开新标签，不切换标的
      if (e.target.closest("a.code-link")) return;
      const row = e.target.closest(".rank-row");
      if (row) selectStock(row.dataset.code, row.dataset.name, Number(row.dataset.dec));
    });

    const input = $("#searchInput");
    input.addEventListener("input", () => {
      clearTimeout(state.searchTimer);
      const q = input.value;
      if (!q.trim()) { hideSearch(); return; }
      state.searchTimer = setTimeout(() => runSearch(q), 180);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!state.searchItems.length) return;
        state.searchActive = (state.searchActive + 1) % state.searchItems.length;
        highlightSearch();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!state.searchItems.length) return;
        state.searchActive = (state.searchActive - 1 + state.searchItems.length) % state.searchItems.length;
        highlightSearch();
      } else if (e.key === "Enter") {
        e.preventDefault();
        enterSearch();
      } else if (e.key === "Escape") {
        hideSearch();
        input.blur();
      }
    });

    $("#searchResults").addEventListener("mousedown", (e) => {
      const item = e.target.closest(".sr-item");
      if (!item) return;
      e.preventDefault();
      pickSearch(state.searchItems[Number(item.dataset.i)]);
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-wrap")) hideSearch();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && watchDrawerOpen()) {
        closeWatchDrawer(true);
        return;
      }
      if (e.key === "Escape" && !$("#alertPanel").classList.contains("hidden")) {
        closeAlerts();
        return;
      }
      if (e.key === "/" && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  /* ---------------- 轮询 ---------------- */
  function startPolling() {
    setInterval(() => {
      if (document.hidden) return;
      refreshOverview();
    }, 3000);

    setInterval(() => {
      if (document.hidden) return;
      refreshWatchlist();
    }, 5000);

    setInterval(() => {
      if (document.hidden) return;
      loadQuote();
    }, 4000);

    setInterval(() => {
      if (document.hidden) return;
      refreshRank();
    }, 10000);

    setInterval(() => {
      if (document.hidden) return;
      loadPerformance();
    }, 60000);

    setInterval(() => {
      if (document.hidden) return;
      if (state.mode === "minute") loadChart();
    }, 30000);

    setInterval(() => {
      evaluateAlerts();
    }, 3000);

  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    applyTheme(document.documentElement.getAttribute("data-theme"), false);
    loadAlerts();
    renderAlerts();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* ignore */ });
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data && e.data.type === "alert-click" && e.data.code) selectByCode(e.data.code);
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) evaluateAlerts();
    });
    tickClock();
    setInterval(tickClock, 1000);
    initChart();
    bindEvents();
    syncMarkBtn();

    await Promise.all([refreshOverview(), refreshWatchlist(), refreshRank()]);
    selectStock("sh000001", "上证指数", 2);
    syncChartChrome();
    startPolling();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
