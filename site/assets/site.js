// Bond site motion engine. No dependencies. Every loop pauses offscreen and in hidden
// tabs, and prefers-reduced-motion gets the final state of each piece with no movement.
(() => {
  "use strict";
  const d = document;
  const root = d.documentElement;
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FINE = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const $ = (s, c = d) => c.querySelector(s);
  const $$ = (s, c = d) => Array.from(c.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const raf = (fn) => {
    let q = false;
    return (...a) => {
      if (q) return;
      q = true;
      requestAnimationFrame(() => { q = false; fn(...a); });
    };
  };

  /* ---------------- visibility helpers ---------------- */
  const visible = new WeakMap();
  const visIO = new IntersectionObserver((es) => {
    for (const e of es) {
      visible.set(e.target, e.isIntersecting);
      const w = e.target.__waiters;
      if (e.isIntersecting && !d.hidden && w) { e.target.__waiters = []; w.forEach((f) => f()); }
    }
  }, { threshold: 0.12 });
  const watched = new Set();
  const watch = (el) => { if (el && !watched.has(el)) { watched.add(el); visIO.observe(el); } return el; };
  const whenVisible = (el) => new Promise((res) => {
    if (visible.get(el) && !d.hidden) return res();
    (el.__waiters ||= []).push(res);
  });
  // Loops park while the tab is hidden and resume where they were when it comes back.
  d.addEventListener("visibilitychange", () => {
    if (d.hidden) return;
    watched.forEach((el) => { if (visible.get(el) && el.__waiters) el.__waiters.splice(0).forEach((f) => f()); });
  });

  /* ---------------- theme ---------------- */
  const toggle = $(".theme-toggle");
  const syncToggle = () => toggle?.setAttribute("aria-pressed", String(root.dataset.theme === "light"));
  syncToggle();
  toggle?.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch { /* private mode */ }
    syncToggle();
    d.dispatchEvent(new Event("themechange"));
  });

  /* ---------------- nav, progress, active link, sheet ---------------- */
  const nav = $("[data-nav]");
  const bar = $(".progress");
  const onScroll = raf(() => {
    const y = scrollY;
    nav?.classList.toggle("scrolled", y > 24);
    const max = d.documentElement.scrollHeight - innerHeight;
    bar?.style.setProperty("--p", max > 0 ? (y / max).toFixed(4) : "0");
  });
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const links = $$(".nav-links a");
  const secIO = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + e.target.id));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  ["features", "how", "verify", "real", "security", "developers"].forEach((id) => { const s = d.getElementById(id); if (s) secIO.observe(s); });

  const sheet = $("#sheet");
  const menuBtn = $(".menu-btn");
  const setSheet = (open) => {
    sheet?.setAttribute("data-open", String(open));
    menuBtn?.setAttribute("aria-expanded", String(open));
    menuBtn?.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  menuBtn?.addEventListener("click", () => setSheet(sheet?.getAttribute("data-open") !== "true"));
  $$("#sheet a").forEach((a) => a.addEventListener("click", () => setSheet(false)));
  d.addEventListener("keydown", (e) => { if (e.key === "Escape") setSheet(false); });

  /* ---------------- text splitting ---------------- */
  const title = $(".hero-title[data-split]");
  if (title) {
    let i = 0;
    for (const line of $$(".line", title)) {
      const frag = d.createDocumentFragment();
      for (const node of Array.from(line.childNodes)) {
        if (node.nodeType === 3) {
          node.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.append(" "); return; }
            const w = d.createElement("span"); w.className = "w";
            const s = d.createElement("span"); s.textContent = part; s.style.setProperty("--i", i++);
            w.append(s); frag.append(w);
          });
        } else {
          const w = d.createElement("span"); w.className = "w";
          const s = d.createElement("span"); s.style.setProperty("--i", i++);
          s.append(node); w.append(s); frag.append(w);
        }
      }
      line.replaceChildren(frag);
    }
    requestAnimationFrame(() => setTimeout(() => title.classList.add("in"), 60));
  }

  const scrub = $("[data-scrub]");
  let scrubWords = [];
  if (scrub) {
    const wrapText = (el) => {
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === 3) {
          const frag = d.createDocumentFragment();
          node.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.append(part); return; }
            const s = d.createElement("span"); s.className = "w"; s.textContent = part; frag.append(s);
          });
          node.replaceWith(frag);
        } else if (node.nodeType === 1) wrapText(node);
      }
    };
    wrapText(scrub);
    scrubWords = $$(".w", scrub);
    const update = raf(() => {
      const r = scrub.getBoundingClientRect();
      const p = clamp((innerHeight * 0.82 - r.top) / (r.height + innerHeight * 0.25), 0, 1);
      const n = Math.round(p * scrubWords.length);
      scrubWords.forEach((w, k) => w.classList.toggle("on", k < n));
    });
    if (RM) scrubWords.forEach((w) => w.classList.add("on"));
    else { addEventListener("scroll", update, { passive: true }); addEventListener("resize", update); update(); }
  }

  /* ---------------- reveal + counters ---------------- */
  const countUp = (el) => {
    const to = parseFloat(el.dataset.count);
    const dec = parseInt(el.dataset.decimals || "0", 10);
    if (RM || !isFinite(to)) { el.textContent = to.toFixed(dec); return; }
    const t0 = performance.now(), dur = 1400;
    const step = (t) => {
      const k = clamp((t - t0) / dur, 0, 1);
      const e = 1 - Math.pow(1 - k, 4);
      el.textContent = (to * e).toFixed(dec);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const revIO = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      $$("[data-count]", e.target).forEach(countUp);
      if (e.target.matches("[data-count]")) countUp(e.target);
      revIO.unobserve(e.target);
    }
  }, { threshold: 0.14, rootMargin: "0px 0px -6% 0px" });
  $$(".reveal, .card, .cta-card, .hero-proof").forEach((el) => revIO.observe(el));

  /* ---------------- pointer effects ---------------- */
  if (FINE && !RM) {
    d.body.classList.add("has-pointer");
    const glow = $(".cursor-glow");
    addEventListener("pointermove", raf((e) => {
      glow?.style.setProperty("--cx", e.clientX + "px");
      glow?.style.setProperty("--cy", e.clientY + "px");
    }), { passive: true });

    $$("[data-spot]").forEach((card) => {
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", e.clientX - r.left + "px");
        card.style.setProperty("--my", e.clientY - r.top + "px");
      });
    });

    $$("[data-magnetic]").forEach((b) => {
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        const x = (e.clientX - r.left - r.width / 2) * 0.22;
        const y = (e.clientY - r.top - r.height / 2) * 0.32;
        b.style.transform = `translate(${x}px, ${y}px)`;
      });
      b.addEventListener("pointerleave", () => { b.style.transform = ""; });
    });

    const phone = $("[data-tilt]");
    const stage = $(".hero");
    stage?.addEventListener("pointermove", raf((e) => {
      const r = stage.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      phone?.style.setProperty("--ry", (nx * 12).toFixed(2) + "deg");
      phone?.style.setProperty("--rx", (-ny * 9).toFixed(2) + "deg");
    }));
    stage?.addEventListener("pointerleave", () => { phone?.style.setProperty("--ry", "0deg"); phone?.style.setProperty("--rx", "0deg"); });
  }

  /* ---------------- hero graph canvas ---------------- */
  const canvas = $(".graph");
  if (canvas && !RM) {
    const ctx = canvas.getContext("2d");
    const hero = $(".hero");
    watch(hero);
    let W = 0, H = 0, DPR = 1, nodes = [], packets = [], mouse = { x: -9999, y: -9999 };
    let colors = {};
    const readColors = () => {
      const light = root.dataset.theme === "light";
      colors = light
        ? { edge: "11,14,19", human: "#0A8EA8", agent: "#7A3CF0", mint: "#07A26C", a: 0.5 }
        : { edge: "255,255,255", human: "#5CE1E6", agent: "#B48CFF", mint: "#14F195", a: 1 };
    };
    readColors();
    d.addEventListener("themechange", readColors);
    const resize = () => {
      DPR = Math.min(devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * DPR; canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const count = Math.round(clamp((W * H) / 26000, 16, 46));
      nodes = Array.from({ length: count }, (_, i) => ({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
        r: 2 + Math.random() * 2.6, agent: i % 3 === 0,
      }));
      packets = [];
    };
    resize();
    addEventListener("resize", raf(resize));
    hero.addEventListener("pointermove", (e) => { const r = canvas.getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });
    hero.addEventListener("pointerleave", () => { mouse = { x: -9999, y: -9999 }; });
    const LINK = 150;
    let last = 0;
    const frame = async (t) => {
      if (!visible.get(hero) || d.hidden) { await whenVisible(hero); last = performance.now(); requestAnimationFrame(frame); return; }
      const dt = Math.min(48, t - (last || t)); last = t;
      ctx.clearRect(0, 0, W, H);
      for (const n of nodes) {
        n.x += n.vx * dt * 0.06; n.y += n.vy * dt * 0.06;
        if (n.x < -20) n.x = W + 20; if (n.x > W + 20) n.x = -20;
        if (n.y < -20) n.y = H + 20; if (n.y > H + 20) n.y = -20;
        const mx = n.x - mouse.x, my = n.y - mouse.y, md = Math.hypot(mx, my);
        if (md < 140 && md > 0.1) { n.x += (mx / md) * 0.35; n.y += (my / md) * 0.35; }
      }
      const edges = [];
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist > LINK) continue;
          edges.push([a, b]);
          const near = Math.hypot((a.x + b.x) / 2 - mouse.x, (a.y + b.y) / 2 - mouse.y) < 160;
          ctx.strokeStyle = near ? `rgba(20,241,149,${(0.28 * (1 - dist / LINK) * colors.a).toFixed(3)})` : `rgba(${colors.edge},${(0.09 * (1 - dist / LINK) * colors.a + 0.01).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      if (edges.length && packets.length < 7 && Math.random() < 0.035) {
        const [a, b] = edges[(Math.random() * edges.length) | 0];
        packets.push({ a, b, t: 0, s: 0.0007 + Math.random() * 0.0006 });
      }
      packets = packets.filter((p) => (p.t += p.s * dt) < 1);
      for (const p of packets) {
        const x = p.a.x + (p.b.x - p.a.x) * p.t, y = p.a.y + (p.b.y - p.a.y) * p.t;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 12);
        g.addColorStop(0, colors.mint); g.addColorStop(1, "rgba(20,241,149,0)");
        ctx.globalAlpha = Math.sin(p.t * Math.PI) * colors.a;
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
      for (const n of nodes) {
        ctx.fillStyle = n.agent ? colors.agent : colors.human;
        ctx.globalAlpha = 0.55 * colors.a + 0.15;
        if (n.agent) {
          const s = n.r * 2.3, rr = s * 0.32;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(n.x - s / 2, n.y - s / 2, s, s, rr); else ctx.rect(n.x - s / 2, n.y - s / 2, s, s);
          ctx.fill();
        } else { ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill(); }
        ctx.globalAlpha = 1;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /* ---------------- the live thread on the phone ---------------- */
  const phoneEl = $(".phone");
  if (phoneEl) {
    const S = {
      screen: $(".screen", phoneEl), inner: $("[data-thread]", phoneEl), input: $("[data-input]", phoneEl),
      typed: $("[data-input] .typed", phoneEl), mention: $("[data-mention]", phoneEl), send: $("[data-send]", phoneEl),
      pay: $("[data-paybtn]", phoneEl), sheet: $("[data-sheet]", phoneEl), amount: $("[data-amount]", phoneEl),
      auth: $("[data-auth]", phoneEl), authLabel: $("[data-auth-label]", phoneEl), status: $("[data-room-status]", phoneEl),
    };
    const callouts = Object.fromEntries($$("[data-callout]").map((c) => [c.dataset.callout, c]));
    const light = (k) => { Object.values(callouts).forEach((c) => c.classList.remove("lit")); if (k) callouts[k]?.classList.add("lit"); };
    watch(phoneEl);
    const now = () => { const t = new Date(); return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`; };
    const el = (html) => { const t = d.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
    const msg = (who, body) => {
      const agent = who === "bond";
      const meta = { maya: ["a-maya", "MA", "Maya"], you: ["a-you", "YO", "You"], bond: ["", "BO", "Bond"] }[who];
      return el(`<div class="msg"><span class="av ${agent ? "ag" : "h " + meta[0]}">${meta[1]}</span><div>
        <div class="msg-head"><b class="${agent ? "agent" : ""}">${meta[2]}</b>${agent ? '<span class="agt">AGENT</span><span class="vbadge uns">Unsigned</span>' : '<span class="vbadge">Verified</span>'}<time>${now()}</time></div>
        <div class="body">${body}</div></div></div>`);
    };
    const add = (node) => { S.inner.append(node); return node; };
    const gate = async (ms) => { await whenVisible(phoneEl); await sleep(ms); await whenVisible(phoneEl); };

    const AGENT_REPLY = "You hold <strong>12.50 USDC</strong> and 1 SOL on devnet. Want to settle up with Maya?";
    const receiptHTML = `<div class="receipt"><div class="rc-body">
      <div class="rc-top"><span>PAYMENT</span><span class="ok"><i class="ck"></i>Confirmed</span></div>
      <div class="rc-amt"><b>5</b><span>USDC</span><em>devnet</em></div>
      <div class="rc-row"><span>From</span><code>GuvA…j4R6</code></div><div class="rc-row"><span>To</span><code>7xKX…9fQ2</code></div>
      <div class="rc-link">↗ View on Solana Explorer (devnet)</div></div></div>`;

    const finalState = () => {
      S.inner.replaceChildren();
      add(msg("maya", "<p>Seeker build ships tonight. Who covers the RPC credits?</p>"));
      add(msg("you", "<p>@Bond what's my USDC balance?</p>"));
      add(msg("bond", `<div class="tool ok"><div class="t1"><i class="ck"></i>returned</div><code>USDC 12.50 · SOL 1.00 · devnet</code></div>`));
      add(msg("bond", `<p>${AGENT_REPLY}</p>`));
      add(msg("you", receiptHTML));
      light("pay");
    };

    const typeInto = async (text) => {
      S.input.classList.add("focus", "has");
      S.typed.textContent = "";
      for (const ch of text) {
        S.typed.textContent += ch;
        if (S.typed.textContent.startsWith("@Bond")) S.mention.classList.add("on");
        S.send.classList.add("on");
        await gate(38 + Math.random() * 55);
      }
    };
    const pressSend = async () => {
      S.send.classList.add("tap"); await sleep(140); S.send.classList.remove("tap", "on");
      S.typed.textContent = ""; S.input.classList.remove("has", "focus"); S.mention.classList.remove("on");
    };
    const stream = async (p, html) => {
      // Stream word by word, keeping inline tags whole.
      const parts = html.match(/<[^>]+>[^<]*<\/[^>]+>|[^\s<]+|\s+/g) || [];
      let acc = "";
      for (const part of parts) {
        acc += part;
        p.innerHTML = acc + '<span class="caret-b"></span>';
        if (part.trim()) await gate(55 + Math.random() * 60);
      }
      p.innerHTML = acc;
    };

    const loop = async () => {
      for (;;) {
        await whenVisible(phoneEl);
        S.inner.style.opacity = "1";
        S.inner.replaceChildren();
        light(null);
        await gate(500);
        add(msg("maya", "<p>Seeker build ships tonight. Who covers the RPC credits?</p>"));
        await gate(1100);
        await typeInto("@Bond what's my USDC balance?");
        await gate(350);
        await pressSend();
        add(msg("you", "<p>@Bond what's my USDC balance?</p>"));
        light("sign");
        await gate(900);
        S.status.textContent = "Bond is working…"; S.status.parentElement.classList.add("busy");
        const thinking = add(msg("bond", '<span class="typing"><i></i><i></i><i></i></span>'));
        await gate(1100);
        const body = $(".body", thinking);
        body.innerHTML = `<div class="tool"><div class="t1"><span class="spin"></span>called <code>solana_get_balance</code></div><code>{ "owner": "GuvA…j4R6", "cluster": "devnet" }</code><small>Agent-reported. Not a signed on-chain receipt.</small></div>`;
        light("tool");
        await gate(1500);
        add(msg("bond", `<div class="tool ok"><div class="t1"><i class="ck"></i>returned</div><code>USDC 12.50 · SOL 1.00 · devnet</code></div>`));
        await gate(700);
        const reply = add(msg("bond", "<p></p>"));
        await stream($("p", reply), AGENT_REPLY);
        S.status.textContent = "2 humans · 1 agent"; S.status.parentElement.classList.remove("busy");
        light(null);
        await gate(1300);
        S.pay.classList.add("tap"); await sleep(160); S.pay.classList.remove("tap");
        S.screen.classList.add("dim"); S.sheet.classList.add("open");
        S.amount.textContent = "0.00";
        await gate(650);
        for (let k = 1; k <= 20; k++) { S.amount.textContent = (5 * (1 - Math.pow(1 - k / 20, 3))).toFixed(2); await sleep(30); }
        await gate(500);
        S.auth.classList.add("scan"); S.authLabel.textContent = "Hold to confirm…";
        await gate(1100);
        S.auth.classList.remove("scan"); S.auth.classList.add("done"); S.authLabel.textContent = "Signed via Mobile Wallet Adapter";
        await gate(800);
        S.sheet.classList.remove("open"); S.screen.classList.remove("dim");
        await gate(450);
        add(msg("you", receiptHTML));
        light("pay");
        S.auth.classList.remove("done"); S.authLabel.textContent = "Confirm with fingerprint";
        await gate(4200);
        S.inner.style.opacity = "0";
        await gate(600);
      }
    };
    if (RM) finalState(); else loop();
  }

  /* ---------------- bento: scramble ---------------- */
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  $$("[data-scramble]").forEach((code) => {
    if (RM) return;
    const target = code.dataset.scramble;
    const card = code.closest(".card");
    watch(card);
    const prefix = target.startsWith("did:key:") ? 9 : 0;
    (async () => {
      for (;;) {
        await whenVisible(card);
        const frames = 26;
        for (let f = 0; f <= frames; f++) {
          const done = Math.floor((f / frames) * (target.length - prefix)) + prefix;
          let s = target.slice(0, done);
          for (let k = done; k < target.length; k++) s += B58[(Math.random() * B58.length) | 0];
          code.textContent = s;
          await sleep(34);
        }
        code.textContent = target;
        await sleep(4200 + Math.random() * 800);
      }
    })();
  });

  /* ---------------- how it works: steps ---------------- */
  const dag = $("[data-dag]");
  const rail = $(".how-rail");
  const steps = $$(".step");
  if (dag && steps.length) {
    const setStep = (n) => {
      dag.setAttribute("data-step", String(n));
      steps.forEach((s) => s.classList.toggle("active", s.dataset.step === String(n)));
      rail?.style.setProperty("--hp", String(n / steps.length));
    };
    setStep(1);
    // On narrow screens the pinned diagram covers the top of the viewport, so the trigger
    // line sits lower, in the part of the screen the steps are actually read in.
    const narrow = matchMedia("(max-width: 1080px)").matches;
    const stepIO = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) setStep(parseInt(e.target.dataset.step, 10));
    }, { rootMargin: narrow ? "-66% 0px -28% 0px" : "-48% 0px -48% 0px" });
    steps.forEach((s) => stepIO.observe(s));
  }

  /* ---------------- verify playground (real crypto) ---------------- */
  const pg = $("[data-playground]");
  if (pg) initPlayground(pg).catch((e) => {
    const t = $("[data-pg-verdict-text]", pg), s = $("[data-pg-verdict-sub]", pg);
    if (t) t.textContent = "Signing unavailable";
    if (s) s.textContent = "This browser has no WebCrypto here (it needs a secure context). " + (e?.message || "");
  });

  async function initPlayground(pg) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("");
    const enc = new TextEncoder();
    const q = (s) => $(s, pg);
    const ui = {
      msg: q("#pg-msg"), did: q("[data-pg-did]"), addr: q("[data-pg-addr]"), alg: q("[data-pg-alg]"),
      canon: q("[data-pg-canon]"), digest: q("[data-pg-digest]"), sig: q("[data-pg-sig]"),
      verdict: q("[data-pg-verdict]"), vt: q("[data-pg-verdict-text]"), vs: q("[data-pg-verdict-sub]"),
      tamper: q("[data-pg-tamper]"), restore: q("[data-pg-restore]"), note: q("[data-pg-note]"),
    };

    let alg = { name: "Ed25519" }, keys;
    try { keys = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]); }
    catch {
      alg = { name: "ECDSA", hash: "SHA-256" };
      keys = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    }
    const pub = new Uint8Array(await subtle.exportKey("raw", keys.publicKey));
    let did;
    if (alg.name === "Ed25519") {
      did = "did:key:z" + b58(concat(new Uint8Array([0xed, 0x01]), pub));
      ui.did.textContent = did;
      ui.addr.textContent = b58(pub);
    } else {
      did = "did:example:p256:" + hex(pub.slice(1, 9));
      ui.alg.textContent = "ECDSA P-256 fallback";
      ui.did.textContent = "did:key needs Ed25519, which this browser's WebCrypto lacks";
      ui.addr.textContent = "n/a for P-256";
      ui.note.textContent = "Your browser has no WebCrypto Ed25519, so this demo signs with ECDSA P-256. Bond itself always uses Ed25519.";
    }

    const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const id = Array.from({ length: 26 }, () => ULID[(Math.random() * 32) | 0]).join("");
    const createdAt = new Date().toISOString();
    let lamport = 1;
    const nodeFor = (body) => ({ id, roomId: "seeker-builders", parentId: null, type: "text", payload: { body, mentions: [] }, authorDid: did, lamport, createdAt });

    let signed = null; // { canonical, sig }
    let received = null; // canonical string as it arrived
    let tamperAt = -1;

    const render = () => {
      const s = received ?? "";
      let html = esc(s)
        .replace(/&quot;([a-zA-Z]+)&quot;:/g, '<span class="k">&quot;$1&quot;</span>:')
        .replace(/:&quot;([^&]*?)&quot;/g, ':<span class="s">&quot;$1&quot;</span>');
      if (tamperAt >= 0) {
        const before = esc(s.slice(0, tamperAt)), ch = esc(s[tamperAt]), after = esc(s.slice(tamperAt + 1));
        html = before + '<span class="x">' + ch + "</span>" + after;
      }
      ui.canon.innerHTML = html;
    };

    const verify = async () => {
      ui.verdict.dataset.state = "pending";
      const digest = new Uint8Array(await subtle.digest("SHA-256", enc.encode(received)));
      const ok = await subtle.verify(alg, keys.publicKey, signed.sig, digest);
      await sleep(RM ? 0 : 260);
      ui.verdict.dataset.state = ok ? "verified" : "tampered";
      ui.vt.textContent = ok ? "Verified" : "Tampered";
      ui.vs.textContent = ok
        ? "The signature matches these exact bytes and this did:key."
        : "One byte changed, so the digest no longer matches the signature. Bond drops this node.";
    };

    const sign = async () => {
      const canonical = jcs(nodeFor(ui.msg.value));
      const digest = new Uint8Array(await subtle.digest("SHA-256", enc.encode(canonical)));
      const sig = new Uint8Array(await subtle.sign(alg, keys.privateKey, digest));
      signed = { canonical, sig };
      received = canonical; tamperAt = -1;
      ui.digest.textContent = hex(digest);
      ui.sig.textContent = b64url(sig);
      [ui.digest, ui.sig].forEach((x) => { x.classList.remove("flash"); void x.offsetWidth; x.classList.add("flash"); });
      ui.restore.disabled = true;
      render();
      await verify();
    };

    let tmr = 0;
    ui.msg.addEventListener("input", () => { clearTimeout(tmr); tmr = setTimeout(() => { lamport++; sign(); }, 240); });
    ui.tamper.addEventListener("click", async () => {
      if (!signed) return;
      // Flip one character inside the message body of the received copy.
      const start = signed.canonical.indexOf('"body":"') + 8;
      const end = signed.canonical.indexOf('"', start);
      const span = Math.max(1, end - start);
      tamperAt = start + ((Math.random() * span) | 0);
      const c = signed.canonical.charCodeAt(tamperAt);
      let next = String.fromCharCode(c === 122 ? 97 : c === 90 ? 65 : c === 32 ? 95 : c + 1);
      if (next === '"' || next === "\\") next = "x";
      received = signed.canonical.slice(0, tamperAt) + next + signed.canonical.slice(tamperAt + 1);
      ui.restore.disabled = false;
      render();
      await verify();
    });
    ui.restore.addEventListener("click", async () => { received = signed.canonical; tamperAt = -1; ui.restore.disabled = true; render(); await verify(); });
    await sign();
  }

  // RFC 8785 over the subset Bond signs: sorted keys, JSON.stringify primitives.
  function jcs(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "[" + v.map((x) => jcs(x === undefined ? null : x)).join(",") + "]";
    if (typeof v === "object") {
      return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  }
  function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
  function hex(u) { return Array.from(u, (x) => x.toString(16).padStart(2, "0")).join(""); }
  function b64url(u) { let s = ""; u.forEach((x) => (s += String.fromCharCode(x))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function b58(bytes) {
    const digits = [0];
    for (const byte of bytes) {
      let carry = byte;
      for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = "";
    for (const byte of bytes) { if (byte === 0) out += "1"; else break; }
    for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k]];
    return out;
  }

  /* ---------------- real vs simulated filter ---------------- */
  const fbtns = $$("[data-filter]");
  const caps = $$(".caps li");
  fbtns.forEach((b) => b.addEventListener("click", () => {
    fbtns.forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    const f = b.dataset.filter;
    caps.forEach((li) => li.classList.toggle("out", f !== "all" && li.dataset.kind !== f));
  }));

  /* ---------------- terminal replay ---------------- */
  const term = $("[data-term]");
  if (term) {
    const out = $("[data-term-out]", term);
    const lines = [
      ["h", "=== app: tsc --noEmit (strict) ==="], ["ok", "no type errors"],
      ["h", "=== app: jest (unit + adversarial) ==="], ["ok", "Tests: 336 passed, 336 total"],
      ["h", "=== app: lint ==="], ["ok", "clean"],
      ["h", "=== app: expo export -p web ==="], ["ok", "web routes emitted: 16"],
      ["h", "=== server: typecheck ==="], ["ok", "no type errors"],
      ["h", "=== server: tests (unit + adversarial) ==="], ["ok", "74 passed"],
      ["h", "=== supply chain: audit (high and critical fail) ==="], ["ok", "app, server: none beyond the 3 allowlisted in SECURITY.md"],
    ];
    const line = (c, t) => (c === "ok" ? `<span class="ok"><i class="ck"></i> ${t}</span>` : `<span class="${c}">${t}</span>`);
    const finalHTML = '<span class="p">~/bond $</span> ./verify.sh\n\n' + lines.map(([c, t]) => line(c, t)).join("\n") + '\n\n<span class="green">ALL GREEN</span>';
    if (RM) out.innerHTML = finalHTML;
    else {
      out.innerHTML = '<span class="p">~/bond $</span> <span class="cur"></span>';
      const io = new IntersectionObserver(async (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        let html = '<span class="p">~/bond $</span> ';
        for (const ch of "./verify.sh") { html += ch; out.innerHTML = html + '<span class="cur"></span>'; await sleep(70); }
        html += "\n\n"; out.innerHTML = html; await sleep(400);
        for (const [c, t] of lines) {
          html += line(c, t) + "\n";
          out.innerHTML = html + '<span class="cur"></span>';
          await sleep(c === "h" ? 260 : 420);
        }
        out.innerHTML = html + '\n<span class="green">ALL GREEN</span>';
      }, { threshold: 0.35 });
      io.observe(term);
    }
  }

  /* ---------------- code tabs + copy ---------------- */
  const tabs = $$('.tabs [role="tab"]');
  tabs.forEach((t) => t.addEventListener("click", () => {
    tabs.forEach((x) => {
      const on = x === t;
      x.setAttribute("aria-selected", String(on));
      const panel = d.getElementById(x.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
  }));
  $(".tabs")?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = tabs.indexOf(d.activeElement);
    if (i < 0) return;
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    n.focus(); n.click();
  });
  const copy = $("[data-copy]");
  copy?.addEventListener("click", async () => {
    const panel = $$(".code-card pre.code").find((p) => !p.hidden);
    try {
      await navigator.clipboard.writeText(panel?.innerText.trim() ?? "");
      copy.textContent = "Copied"; copy.classList.add("done");
    } catch { copy.textContent = "Select + copy"; }
    setTimeout(() => { copy.textContent = "Copy"; copy.classList.remove("done"); }, 1600);
  });

  /* ---------------- SSE lane ---------------- */
  const lane = $("[data-lane]");
  if (lane) {
    const items = $$("li", lane);
    if (RM) items.forEach((li) => li.classList.add("on"));
    else {
      watch(lane);
      (async () => {
        for (;;) {
          await whenVisible(lane);
          for (const li of items) { li.classList.add("on"); await sleep(520); }
          await sleep(1400);
          items.forEach((li) => li.classList.remove("on"));
          await sleep(500);
        }
      })();
    }
  }
})();
