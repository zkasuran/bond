/* Bond pitch deck controller. No dependencies, no network, no inline script.
   Fits the 1920x1080 stage to the window, routes keys, touch and wheel, runs each slide's
   motion timeline while it is on screen and puts every slide back to its settled final
   frame when it leaves, so overview, print and the PDF export always see finished slides.
   ?static renders final frames with no motion (the exporter uses it for previews). */
(() => {
  "use strict";
  const doc = document;
  const html = doc.documentElement;
  const stage = doc.getElementById("stage");
  const slides = Array.from(stage.querySelectorAll(".slide"));
  const N = slides.length;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const isStatic = new URLSearchParams(location.search).has("static");
  const pad = (n) => String(n).padStart(2, "0");

  let cur = -1;
  let gen = 0; // bumps on every slide change, so stale timers and frames do nothing
  let timers = [];
  let playing = false;
  let playTimer = 0;
  let overview = false;
  let wheelLock = 0;

  const motion = () => !reduce.matches && !isStatic;
  html.classList.add("js");
  if (motion()) html.classList.add("anim");
  reduce.addEventListener?.("change", () => html.classList.toggle("anim", motion()));

  /* ------------------------------------------------------------- fit to the window */
  function fit() {
    html.style.setProperty("--s", String(Math.min(innerWidth / 1920, innerHeight / 1080)));
    const cols = 4, gap = 22, side = 40;
    const w = Math.min(innerWidth, 1800) - side * 2 - gap * (cols - 1);
    html.style.setProperty("--ovz", String(Math.max(0.1, Math.min(0.24, w / cols / 1920))));
  }
  addEventListener("resize", fit);
  fit();

  /* ------------------------------------------------------------- headlines, word by word */
  // The plain markup is kept so print can put it back: the spaces between word boxes are never
  // painted, so a PDF built from split headlines would read and bookmark them as one long word.
  const plain = new Map();
  function split(el) {
    plain.set(el, el.innerHTML);
    let i = 0;
    const word = (content) => {
      const w = doc.createElement("span");
      w.className = "w";
      const inner = doc.createElement("span");
      inner.style.setProperty("--i", String(i++));
      if (typeof content === "string") inner.textContent = content;
      else inner.appendChild(content);
      w.appendChild(inner);
      return w;
    };
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const frag = doc.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            frag.appendChild(/^\s+$/.test(part) ? doc.createTextNode(part) : word(part));
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1 && !child.classList.contains("br")) {
          if (child.classList.contains("shine") || child.tagName === "CODE") {
            const ph = doc.createComment("");
            child.replaceWith(ph);
            ph.replaceWith(word(child));
          } else {
            walk(child);
          }
        }
      }
    };
    walk(el);
  }
  // Final frames (?static, which the PDF export uses) have no word motion, so nothing to split.
  if (!isStatic) doc.querySelectorAll(".split").forEach(split);

  /* ------------------------------------------------------------- the sky: one camera, many scenes */
  // [x %, y %, scale, opacity] for the mint, violet and cyan light on each scene.
  const SCENES = {
    cover:    [[70, 18, 1.1, .7], [88, 76, 1.3, .75], [4, 96, .8, .35]],
    gap:      [[96, 8, .8, .22], [100, 100, 1.1, .45], [0, 0, .9, .25]],
    key:      [[86, 86, 1.0, .5], [28, 112, .9, .3], [58, 18, 1.0, .5]],
    seeker:   [[70, 40, 1.1, .6], [100, 92, 1.0, .4], [0, 100, .8, .25]],
    thread:   [[100, 18, .9, .4], [70, 60, 1.2, .7], [0, 92, .8, .3]],
    agents:   [[0, 100, .7, .2], [72, 42, 1.3, .85], [100, 0, .8, .3]],
    license:  [[50, 30, 1.3, .55], [92, 100, 1.1, .55], [0, 0, .7, .2]],
    explain:  [[74, 32, 1.1, .6], [100, 100, 1.0, .5], [0, 82, .7, .2]],
    skr:      [[18, 100, .8, .3], [100, 100, .8, .3], [74, 30, 1.2, .7]],
    protect:  [[74, 40, 1.1, .6], [0, 100, .8, .3], [100, 100, .8, .25]],
    design:   [[10, 10, .9, .4], [88, 88, 1.2, .6], [50, 50, .8, .2]],
    proof:    [[30, 0, 1.0, .5], [100, 50, 1.0, .45], [70, 100, .8, .3]],
    security: [[100, 100, .8, .3], [0, 0, .9, .35], [50, 112, .9, .25]],
    loop:     [[74, 52, 1.2, .6], [100, 18, .9, .5], [0, 100, .8, .25]],
    status:   [[14, 40, .9, .35], [86, 40, .9, .35], [50, 112, .9, .3]],
    close:    [[36, 30, 1.2, .65], [64, 30, 1.2, .7], [50, 100, 1.0, .35]],
  };
  const ORB = [["20,241,149", .42], ["153,69,255", .5], ["92,225,230", .3]];
  const orbs = Array.from(doc.querySelectorAll(".sky i"));
  const sceneOf = (s) => SCENES[s.dataset.scene] || SCENES.cover;
  function sky(s) {
    sceneOf(s).forEach(([x, y, k, o], j) => {
      const st = orbs[j].style;
      st.setProperty("--x", String(x));
      st.setProperty("--y", String(y));
      st.setProperty("--k", String(k));
      st.opacity = String(o);
    });
  }
  // The same light, baked into each slide for print, the PDF and the overview.
  slides.forEach((s) => {
    const g = sceneOf(s).map(([x, y, k, o], j) =>
      `radial-gradient(circle ${Math.round(550 * k)}px at ${x}% ${y}%, rgba(${ORB[j][0]},${(ORB[j][1] * o).toFixed(3)}), rgba(${ORB[j][0]},0))`).join(", ");
    s.style.setProperty("--pbg", g);
  });

  /* ------------------------------------------------------------- timelines */
  const later = (fn, ms) => {
    const g = gen;
    timers.push(setTimeout(() => { if (g === gen) fn(); }, ms));
  };
  const frames = (fn) => {
    const g = gen;
    const step = (now) => { if (g === gen && fn(now) !== false) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  function stopTimelines() {
    gen++;
    timers.forEach(clearTimeout);
    timers = [];
  }
  const delayOf = (el) => {
    if (el.dataset.delay) return parseFloat(el.dataset.delay);
    const host = el.closest(".rv");
    return host ? parseFloat(getComputedStyle(host).getPropertyValue("--d")) || 0 : 0;
  };

  function counters(s) {
    s.querySelectorAll(".count").forEach((el) => {
      const to = Number(el.dataset.to);
      el.dataset.final ??= el.textContent;
      const t0 = performance.now() + delayOf(el) * 1000 + 280;
      const dur = 1300;
      el.textContent = "0";
      frames((now) => {
        const p = Math.min(1, Math.max(0, (now - t0) / dur));
        el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 4))));
        return p < 1;
      });
    });
  }

  const HEX = "0123456789abcdef";
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const rnd = (a) => a[(Math.random() * a.length) | 0];
  function scramble(el, alpha, startMs, endMs) {
    const fin = (el.dataset.final ??= el.textContent);
    const t0 = performance.now();
    let last = 0;
    frames((now) => {
      const t = now - t0;
      if (t >= endMs) { el.textContent = fin; return false; }
      if (t >= startMs && now - last > 45) {
        last = now;
        el.textContent = Array.from(fin, (ch) => (ch === ":" ? ch : rnd(alpha))).join("");
      }
      return true;
    });
  }
  function decode(el, alpha, startMs, dur, keep = 0) {
    const fin = (el.dataset.final ??= el.textContent);
    const t0 = performance.now();
    let last = 0;
    el.textContent = fin.slice(0, keep) + Array.from(fin.slice(keep), () => rnd(alpha)).join("");
    frames((now) => {
      const t = now - t0;
      if (t >= startMs + dur) { el.textContent = fin; return false; }
      if (t >= startMs && now - last > 40) {
        last = now;
        const settled = keep + Math.floor(((t - startMs) / dur) * (fin.length - keep));
        el.textContent = fin.slice(0, settled) + Array.from(fin.slice(settled), () => rnd(alpha)).join("");
      }
      return true;
    });
  }

  // Cover pulses: a travelling pulse is visible only while its animation runs, and its edge's
  // resting pulse steps aside meanwhile, so before, after and without SMIL the drawing is the static frame.
  const runs = Array.from(doc.querySelectorAll(".pulses-anim > g"));
  const rests = Array.from(doc.querySelectorAll(".pulses-static > g"));
  const restPulse = (i) => { runs[i].classList.remove("run"); rests[i]?.classList.remove("off"); };
  runs.forEach((g, i) => {
    const a = g.querySelector("animateMotion");
    a.addEventListener("beginEvent", () => { g.classList.add("run"); rests[i]?.classList.add("off"); });
    a.addEventListener("endEvent", () => restPulse(i));
  });

  const TIMELINES = {
    s01(s) {
      s.querySelectorAll(".pulses-anim animateMotion").forEach((a, i) => {
        later(() => { try { a.beginElement(); } catch (e) { /* SMIL unavailable: the static frame stays */ } }, 1500 + i * 420);
      });
    },
    s03(s) {
      s.querySelectorAll(".bytes span").forEach((b) => {
        const start = 620 + Math.random() * 420;
        scramble(b, HEX, start, start + 300 + Math.random() * 700);
      });
      s.querySelectorAll(".dec").forEach((el, j) => decode(el, B58, 1500 + j * 220, 1300, el.textContent.startsWith("did:key:") ? 9 : 0));
    },
    s05: thread,
  };

  /* the product slide: a scripted replay of the real flow */
  const CO_AT = ['[data-k="2"] .mh', '[data-k="3"] .tc', '[data-k="6"] .rc']; // what each callout points at
  let flips = [];
  function thread(s) {
    const q = (sel) => s.querySelector(sel);
    const thr = q("[data-thread]");
    const msgs = Array.from(s.querySelectorAll(".hm[data-k]"));
    const cos = Array.from(s.querySelectorAll(".co"));
    const typing = q("[data-typing]");
    const status = q("[data-status]");
    const inp = q(".inp");
    const ph = q("[data-ph]");
    const typed = q("[data-typed]");
    const sheet = q("[data-sheet]");
    const amt = q("[data-amt]");
    const pins = Array.from(s.querySelectorAll("[data-pin] i"));
    const rc = q("[data-rc]");
    status.dataset.final ??= status.textContent;
    amt.dataset.final ??= amt.textContent;
    cos.forEach((c) => { c.dataset.top ??= c.style.top; });
    s.classList.add("replay");

    // Layout position inside the slide. offsetTop ignores transforms, so in-flight motion never skews it.
    const yIn = (el) => { let y = 0; for (let e = el; e && e !== s; e = e.offsetParent) y += e.offsetTop; return y; };
    const pin = (c, i) => {
      const t = q(CO_AT[i]);
      c.style.top = Math.round(yIn(t) + t.offsetHeight / 2 - c.offsetHeight / 2) + "px";
    };
    // FLIP: the thread grows from the bottom, so earlier nodes glide up instead of jumping,
    // and each visible callout glides with the node it points at (same duration and curve).
    const change = (fn) => {
      const was = Array.from(thr.children).filter((e) => e.offsetParent);
      const before = was.map((e) => e.offsetTop);
      fn();
      was.forEach((e, j) => {
        const dy = before[j] - e.offsetTop;
        if (e.offsetParent && Math.abs(dy) > 0.5 && e.animate) {
          flips.push(e.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 480, easing: "cubic-bezier(.16, 1, .3, 1)" }));
        }
      });
      cos.forEach((c, i) => { if (c.classList.contains("show")) pin(c, i); });
    };
    const show = (k) => change(() => msgs[k - 1].classList.add("show"));
    // A callout appears already beside its node, then follows it.
    const call = (i) => {
      const c = cos[i];
      c.classList.add("snap");
      pin(c, i);
      void c.offsetWidth;
      c.classList.remove("snap");
      c.classList.add("show");
    };

    const text = "@Bond how much USDC do I have on devnet?";
    const T0 = 1250;
    const per = 30;
    later(() => show(1), 450);
    later(() => { ph.hidden = true; s.classList.add("typing-on"); }, T0);
    // The field scrolls with the caret, like a real input.
    for (let i = 1; i <= text.length; i++) later(() => { typed.textContent = text.slice(0, i); inp.scrollLeft = inp.scrollWidth; }, T0 + i * per);
    const send = T0 + text.length * per + 260;
    later(() => { typed.textContent = ""; inp.scrollLeft = 0; ph.hidden = false; s.classList.remove("typing-on"); show(2); call(0); }, send);
    later(() => { change(() => typing.classList.add("show")); status.textContent = "Bond is working…"; }, send + 550);
    later(() => { change(() => { typing.classList.remove("show"); msgs[2].classList.add("show"); }); call(1); }, send + 1450);
    later(() => show(4), send + 2250);
    later(() => { show(5); status.textContent = status.dataset.final; }, send + 3050);
    later(() => s.classList.add("pay-press"), send + 3900);
    later(() => {
      sheet.classList.add("open");
      amt.textContent = "0.00";
      const t0 = performance.now() + 250;
      frames((now) => {
        const p = Math.min(1, Math.max(0, (now - t0) / 650));
        amt.textContent = (5 * (1 - Math.pow(1 - p, 3))).toFixed(2);
        return p < 1;
      });
    }, send + 4200);
    pins.forEach((dot, i) => later(() => dot.classList.add("f"), send + 5200 + i * 120));
    later(() => sheet.classList.remove("open"), send + 6250);
    later(() => { rc.classList.add("pend"); show(6); }, send + 6700);
    later(() => { rc.classList.remove("pend"); rc.classList.add("pop"); call(2); }, send + 7500);
  }
  function resetThread(s) {
    flips.forEach((a) => a.cancel());
    flips = [];
    s.classList.remove("replay", "typing-on", "pay-press");
    s.querySelectorAll(".show").forEach((e) => e.classList.remove("show"));
    s.querySelectorAll(".co").forEach((c) => { c.classList.remove("snap"); if (c.dataset.top) c.style.top = c.dataset.top; });
    s.querySelectorAll("[data-pin] i").forEach((e) => e.classList.remove("f"));
    s.querySelector("[data-sheet]").classList.remove("open");
    s.querySelector("[data-rc]").classList.remove("pend", "pop");
    s.querySelector("[data-typed]").textContent = "";
    s.querySelector("[data-ph]").hidden = false;
    s.querySelector(".inp").scrollLeft = 0;
  }

  /* put a slide back to its settled final frame */
  function settle(s) {
    s.querySelectorAll("[data-final]").forEach((el) => { el.textContent = el.dataset.final; });
    s.querySelectorAll(".pulses-anim animateMotion").forEach((a) => { try { a.endElement(); } catch (e) { /* no SMIL */ } });
    if (s.querySelector(".pulses-anim")) runs.forEach((g, i) => restPulse(i));
    if (s.id === "s05") resetThread(s);
  }

  /* ------------------------------------------------------------- navigation */
  const titleEl = doc.getElementById("ui-title");
  const countEl = doc.getElementById("ui-count");
  const progEl = doc.getElementById("prog");
  const live = doc.getElementById("live");
  const notes = doc.getElementById("notes");
  const notesT = doc.getElementById("notes-t");
  const notesN = doc.getElementById("notes-n");
  const help = doc.getElementById("help");
  const apBar = doc.getElementById("ap");

  // One rule for what can take focus and clicks. Presenting: only the slide on screen (with
  // ?static, every slide, so print and the PDF export see them all). Overview: no slide; the
  // thumbnails are previews, opened by click, or by the arrow keys and Enter.
  function applyInert() {
    slides.forEach((s, i) => { s.inert = overview || (!isStatic && i !== cur); });
  }

  function go(n, opts = {}) {
    n = Math.max(0, Math.min(N - 1, n));
    if (n === cur && !opts.replay) return;
    const prev = slides[cur];
    const next = slides[n];
    const dir = n >= cur ? 1 : -1;
    stopTimelines();
    if (prev && prev !== next) {
      prev.classList.remove("on");
      prev.setAttribute("aria-hidden", "true");
      settle(prev);
      if (motion() && !overview) {
        prev.style.setProperty("--dir", String(dir));
        prev.classList.add("out");
        // Only the latest exit may clear the fade, so a quick back-and-forth never cuts one short.
        const tok = (prev._out = (prev._out || 0) + 1);
        setTimeout(() => { if (prev._out === tok) prev.classList.remove("out"); }, 650);
      }
    }
    if (opts.replay) {
      settle(next);
      next.classList.remove("on");
      void next.offsetWidth; // restart the CSS animations
    }
    next._out = (next._out || 0) + 1;
    next.classList.remove("out");
    next.classList.add("on");
    next.removeAttribute("aria-hidden");
    cur = n;
    applyInert();
    sky(next);
    paintUi(next);
    if (motion() && !overview) {
      TIMELINES[next.id]?.(next);
      counters(next);
    }
    if (!opts.silent) history.replaceState(null, "", "#/" + (n + 1));
    if (playing) schedulePlay();
  }
  const step = (d) => go(cur + d);

  function paintUi(s) {
    const n = slides.indexOf(s) + 1;
    titleEl.textContent = s.dataset.title || "Bond";
    countEl.textContent = pad(n) + " / " + pad(N);
    progEl.style.setProperty("--p", String(n / N));
    live.textContent = "Slide " + n + " of " + N + ": " + (s.dataset.title || "");
    const sn = s.querySelector(".sn");
    notesT.textContent = sn ? sn.textContent.trim() : "";
    notesN.textContent = pad(n);
    slides.forEach((x, i) => x.classList.toggle("cur", i === n - 1));
  }

  /* ------------------------------------------------------------- play the deck on its own */
  function schedulePlay() {
    clearTimeout(playTimer);
    if (!playing) return;
    const ms = (parseFloat(slides[cur].dataset.dur) || 8) * 1000;
    if (apBar.animate) {
      apBar.getAnimations?.().forEach((a) => a.cancel());
      apBar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: ms, easing: "linear", fill: "forwards" });
    }
    playTimer = setTimeout(() => {
      if (cur >= N - 1) setPlaying(false);
      else go(cur + 1);
    }, ms);
  }
  function setPlaying(on) {
    playing = on;
    html.classList.toggle("playing", on);
    doc.querySelector('[data-act="play"]').setAttribute("aria-pressed", String(on));
    if (on) { if (overview) setOverview(false); schedulePlay(); }
    else clearTimeout(playTimer);
  }

  /* ------------------------------------------------------------- overview */
  function setOverview(on, target = cur) {
    overview = on;
    stopTimelines();
    slides.forEach(settle);
    html.classList.toggle("ov", on);
    doc.querySelector('[data-act="grid"]').setAttribute("aria-pressed", String(on));
    applyInert();
    if (on) {
      setPlaying(false);
      slides[cur].scrollIntoView({ block: "center" });
      live.textContent = `Overview. Slide ${cur + 1} of ${N}: ${slides[cur].dataset.title || ""}. Arrow keys move, Enter opens.`;
      return;
    }
    slides.forEach((s) => s.classList.remove("hov"));
    if (target !== cur) go(target);
    else go(cur, { replay: true, silent: true });
  }
  // Thumbnails are inert, so the stage takes the pointer and finds the slide under it.
  const slideAt = (x, y) => slides.findIndex((s) => {
    const r = s.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  stage.addEventListener("click", (e) => {
    if (!overview) return;
    const i = slideAt(e.clientX, e.clientY);
    if (i >= 0) setOverview(false, i);
  });
  stage.addEventListener("mousemove", (e) => {
    if (!overview) return;
    const i = slideAt(e.clientX, e.clientY);
    slides.forEach((s, j) => s.classList.toggle("hov", j === i));
  });

  /* ------------------------------------------------------------- panels */
  function toggleNotes(force) {
    const on = force ?? notes.hidden;
    notes.hidden = !on;
    doc.querySelector('[data-act="notes"]').setAttribute("aria-pressed", String(on));
  }
  // A real modal: everything behind it is inert while it is open, and the deck stops playing.
  let helpReturn = null;
  const behindHelp = [doc.getElementById("deck"), doc.getElementById("ui"), notes];
  function toggleHelp(force) {
    const on = force ?? help.hidden;
    help.hidden = !on;
    behindHelp.forEach((el) => { el.inert = on; });
    if (on) {
      if (playing) setPlaying(false);
      helpReturn = doc.activeElement;
      help.querySelector(".help-x").focus();
    } else {
      helpReturn?.focus?.();
    }
  }
  function fullscreen() {
    const el = doc.documentElement;
    if (doc.fullscreenElement) { doc.exitFullscreen?.(); return; }
    const req = el.requestFullscreen?.();
    if (req && req.catch) req.catch(() => { live.textContent = "Fullscreen is blocked here. Use your browser's full screen key, F11 or Ctrl+Cmd+F."; });
  }

  /* ------------------------------------------------------------- input */
  doc.querySelector(".bar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "prev") step(-1);
    else if (act === "next") step(1);
    else if (act === "play") setPlaying(!playing);
    else if (act === "grid") setOverview(!overview);
    else if (act === "notes") toggleNotes();
    else if (act === "full") fullscreen();
    else if (act === "help") toggleHelp();
  });
  help.addEventListener("click", (e) => {
    if (e.target === help || e.target.closest(".help-x")) toggleHelp(false);
  });

  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (!help.hidden) {
      if (k === "Escape" || k === "?") { e.preventDefault(); toggleHelp(false); }
      if (k === "Tab") { // keep focus going round the dialog
        const f = Array.from(help.querySelectorAll("a[href], button"));
        const i = f.indexOf(doc.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
      return;
    }
    const manual = () => { if (playing) setPlaying(false); };
    switch (k) {
      case "ArrowRight": case "PageDown": case "ArrowDown":
        e.preventDefault(); manual(); overview ? go(cur + 1, { silent: true }) : step(1); if (overview) slides[cur].scrollIntoView({ block: "nearest" }); break;
      case " ":
        if (e.target.closest?.("button, a")) return;
        e.preventDefault(); manual(); step(e.shiftKey ? -1 : 1); break;
      case "ArrowLeft": case "PageUp": case "ArrowUp":
        e.preventDefault(); manual(); overview ? go(cur - 1, { silent: true }) : step(-1); if (overview) slides[cur].scrollIntoView({ block: "nearest" }); break;
      case "Home": e.preventDefault(); manual(); go(0); break;
      case "End": e.preventDefault(); manual(); go(N - 1); break;
      case "Enter": if (overview) { e.preventDefault(); setOverview(false); } break;
      case "Escape": e.preventDefault(); if (!notes.hidden) toggleNotes(false); else setOverview(!overview); break;
      case "g": case "G": setOverview(!overview); break;
      case "p": case "P": setPlaying(!playing); break;
      case "n": case "N": toggleNotes(); break;
      case "f": case "F": fullscreen(); break;
      case "r": case "R": if (!overview) go(cur, { replay: true, silent: true }); break;
      case "?": toggleHelp(true); break;
      default:
        if (/^[1-9]$/.test(k) && !overview) { manual(); go(Number(k) - 1); }
    }
  });

  addEventListener("wheel", (e) => {
    if (overview || !help.hidden || e.target.closest?.("#notes")) return;
    if (Math.abs(e.deltaY) < 24 && Math.abs(e.deltaX) < 24) return;
    const now = Date.now();
    if (now < wheelLock) return;
    wheelLock = now + 900;
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (playing) setPlaying(false);
    step(d > 0 ? 1 : -1);
  }, { passive: true });

  let tx = 0, ty = 0;
  addEventListener("touchstart", (e) => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  addEventListener("touchend", (e) => {
    if (overview || !help.hidden || e.target.closest?.("#notes")) return;
    const dx = e.changedTouches[0].clientX - tx;
    const dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) { if (playing) setPlaying(false); step(dx < 0 ? 1 : -1); }
  }, { passive: true });

  // In-deck links (#s14) jump to that slide instead of scrolling the stage.
  doc.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#s"]');
    if (!a) return;
    const i = slides.findIndex((s) => "#" + s.id === a.getAttribute("href"));
    if (i < 0) return;
    e.preventDefault();
    if (overview) setOverview(false);
    go(i);
  });

  // The presenter bar fades out when the pointer rests, but never under the pointer or under
  // keyboard focus (a mouse click leaves no :focus-visible, so clicking Next still lets it fade).
  let idleTimer = 0;
  const bar = doc.querySelector(".bar");
  const wake = () => {
    html.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!overview && help.hidden && !bar.matches(":hover") && !bar.querySelector(":focus-visible")) html.classList.add("idle");
    }, 2600);
  };
  ["mousemove", "pointerdown", "keydown", "touchstart"].forEach((t) => addEventListener(t, wake, { passive: true }));
  doc.querySelector(".bar").addEventListener("mouseenter", () => clearTimeout(idleTimer));

  // Printing (and the PDF export): settle everything, then the print stylesheet lays out one slide
  // per page. Every page is visible on paper, so every slide joins the accessibility tree, which is
  // what the tagged PDF and its bookmark outline are built from.
  // Overview's grid outranks the print layout, so it steps aside for the print and comes back after.
  let unsplit = false;
  addEventListener("beforeprint", () => {
    stopTimelines();
    html.classList.remove("ov");
    if (!unsplit) { plain.forEach((markup, el) => { el.innerHTML = markup; }); unsplit = true; }
    slides.forEach((s) => { settle(s); s.removeAttribute("aria-hidden"); s.inert = false; });
  });
  addEventListener("afterprint", () => {
    html.classList.toggle("ov", overview);
    if (unsplit) { Array.from(plain.keys()).forEach(split); unsplit = false; }
    slides.forEach((s, i) => { if (i !== cur) s.setAttribute("aria-hidden", "true"); });
    applyInert();
    if (!overview) go(cur, { replay: true, silent: true });
  });

  function fromHash() {
    const h = location.hash;
    let m = /^#\/(\d+)$/.exec(h);
    if (m) return Number(m[1]) - 1;
    m = /^#(s\d\d)$/.exec(h);
    if (m) return slides.findIndex((s) => s.id === m[1]);
    return -1;
  }
  addEventListener("hashchange", () => { const i = fromHash(); if (i >= 0 && i !== cur) go(i, { silent: true }); });

  // Start once fonts are in, so the first headline does not re-wrap mid-animation.
  slides.forEach((s) => s.setAttribute("aria-hidden", "true"));
  applyInert();
  const start = () => { const i = fromHash(); go(i >= 0 ? i : 0, { silent: true }); wake(); };
  if (doc.fonts && doc.fonts.ready) Promise.race([doc.fonts.ready, new Promise((r) => setTimeout(r, 1500))]).then(start);
  else start();
})();
