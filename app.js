(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const SVGNS = "http://www.w3.org/2000/svg";
  const TICK_MS = 50;

  $("[data-year]").textContent = new Date().getFullYear();

  // ---------- What I do at each layer ----------
  const DETAILS = {
    machine: {
      title: "Machine: where the product is made",
      body: "Fillers, mixers, presses, detectors and the sensors on them. I work with the people who run the equipment to understand what the machine actually does, what it can measure, and what can go wrong, and I build software that talks to devices directly when there's no PLC in the way.",
      items: [
        "Serial and DAQ integrations with instruments and detectors (Meridian metal detection)",
        "Microcontroller and device-level communication",
        "Requirements gathered on the plant floor, not just in a conference room"
      ]
    },
    plc: {
      title: "PLC: the logic that runs the line",
      body: "The controller decides when motors run, valves open and batches advance. I read and work alongside ladder logic and tag databases so the software above it stays in step with what the controls engineers built.",
      items: [
        "Rockwell Studio 5000 and FactoryTalk View tag structures",
        "FactoryTalk Batch recipe phases and procedures (E&J Gallo)",
        "GE Cimplicity and HMI integrations (Paragon Industries)"
      ]
    },
    integration: {
      title: "Integration: getting data off the floor safely",
      body: "This is the layer most projects live or die on. Moving PLC data into databases and business systems reliably, in both directions, without bringing down production when something upstream hiccups.",
      items: [
        "OPC and OPC UA clients, MQTT, SignalR and REST services",
        "Real-time scheduling fed by plant data (Rob-Ex at E&J Gallo)",
        "Azure IoT and cloud pipelines, SSIS and SQL Server"
      ]
    },
    apps: {
      title: "Applications: what the business sees",
      body: "Dashboards, MES and ERP, recipe editors, traceability, customer APIs and mobile apps. The goal is software that operators actually use and managers actually trust.",
      items: [
        "Full MES and ERP covering scheduling through shipping (Paragon Industries)",
        "Web-based recipe management for fermentation and blending (E&J Gallo)",
        "Lot and defect traceability in a regulated industry (Meridian Medical)",
        "Clinical mobile apps on iOS and Android (Innovative ECMO)"
      ]
    }
  };

  const detail = $("[data-detail]");
  const detailBody = $("[data-detail-body]");
  let openStage = null;

  function showDetail(key) {
    if (openStage === key) return hideDetail();
    openStage = key;
    const d = DETAILS[key];
    detailBody.innerHTML =
      `<h3>${d.title}</h3><p>${d.body}</p><ul>${d.items.map(i => `<li>${i}</li>`).join("")}</ul>`;
    detail.hidden = false;
    $$(".stage").forEach(s => s.classList.toggle("active", s.dataset.stage === key));
    $$("[data-open]").forEach(b => b.setAttribute("aria-expanded", b.dataset.open === key));
    detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function hideDetail() {
    openStage = null;
    detail.hidden = true;
    $$(".stage").forEach(s => s.classList.remove("active"));
    $$("[data-open]").forEach(b => b.setAttribute("aria-expanded", "false"));
  }
  $$("[data-open]").forEach(b => b.addEventListener("click", () => showDetail(b.dataset.open)));
  $("[data-close]").addEventListener("click", hideDetail);

  // ---------- Simulation state ----------
  const S = {
    running: false,
    fault: false,
    speed: 2,
    count: 0,
    level: 82,
    bottles: [],
    eye: false,
    runTicks: 0,
    downTicks: 0,
    recent: [],       // timestamps of counts, for rate
    history: [],      // rate samples for the trend
    woTarget: 400,
    wo: 2291,
    woDone: 0
  };

  const el = {
    lamp: $("[data-lamp]"), state: $("[data-state]"),
    alarm: $("[data-alarm]"), alarmText: $("[data-alarm-text]"),
    bottles: $("[data-bottles]"), jam: $("[data-jam]"),
    tank: $("[data-tank-fill]"), stream: $("[data-stream]"),
    eye: $("[data-eye]"), beam: $("[data-eye-beam]"),
    log: $("[data-log]"), trend: $("[data-trend]"),
    rungRails: $$(".rung .rail"), segs: $$(".rung .seg"),
    btn: Object.fromEntries($$("[data-action]").map(b => [b.dataset.action, b]))
  };

  // ---------- Machine drawing ----------
  function makeBottle(x) {
    const g = document.createElementNS(SVGNS, "g");
    const fill = document.createElementNS(SVGNS, "rect");
    fill.setAttribute("class", "bottle-fill");
    fill.setAttribute("x", 2); fill.setAttribute("width", 14);
    const body = document.createElementNS(SVGNS, "path");
    body.setAttribute("class", "bottle");
    body.setAttribute("d", "M6 0 h6 v6 l4 5 v19 h-16 v-19 l4 -5 z");
    g.append(fill, body);
    el.bottles.append(g);
    return { x, fill: 0, counted: false, g, fillRect: fill };
  }
  function drawBottle(b) {
    b.g.setAttribute("transform", `translate(${b.x - 8} 102)`);
    const h = 18 * b.fill;
    b.fillRect.setAttribute("y", 30 - h);
    b.fillRect.setAttribute("height", h);
  }
  for (let x = 20; x < 300; x += 52) {
    const b = makeBottle(x);
    if (x > 160) { b.fill = 1; b.counted = x > 230; }
    S.bottles.push(b); drawBottle(b);
  }

  // ---------- Wires / packets ----------
  const wires = $$("[data-wire]");
  function packet(i, bad) {
    if (document.hidden) return;
    const p = document.createElement("span");
    p.className = "packet" + (bad ? " bad" : "");
    wires[i].append(p);
    p.addEventListener("animationend", () => p.remove());
    setTimeout(() => p.remove(), 1500);
  }

  // ---------- Integration log ----------
  const chips = $$(".chip");
  function log(html, cls) {
    const li = document.createElement("li");
    li.innerHTML = html;
    if (cls) li.className = cls;
    el.log.append(li);
    while (el.log.children.length > 14) el.log.firstElementChild.remove();
  }
  function lightChip(i) {
    chips[i].classList.add("lit");
    setTimeout(() => chips[i].classList.remove("lit"), 400);
  }
  const ts = () => new Date().toTimeString().slice(0, 8);

  // ---------- PLC tags ----------
  function setTag(name, value) {
    const td = $(`[data-t="${name}"]`);
    if (td.textContent === String(value)) return;
    td.textContent = value;
    td.classList.add("flash");
    setTimeout(() => td.classList.remove("flash"), 250);
  }

  // ---------- Count event ripples up the stack ----------
  function onCount() {
    S.count++;
    S.recent.push(performance.now());
    packet(0);
    setTag("count", S.count);
    setTimeout(() => {
      packet(1);
      lightChip(0);
      lightChip(1);
      log(`${ts()} <b>mqtt</b> plant/line1/filler/count <b>${S.count}</b>`);
      setTimeout(() => {
        packet(2);
        S.woDone++;
        if (S.woDone % 10 === 0) {
          lightChip(2); lightChip(3);
          log(`${ts()} <b>POST</b> /api/workorders/WO-${S.wo}/produced <b>200</b>`, "ok");
          $('[data-k="erp"]').textContent = "synced " + ts();
        }
        if (S.woDone >= S.woTarget) {
          log(`${ts()} <b>ERP</b> WO-${S.wo} complete, next order released`, "ok");
          S.wo++; S.woDone = 0;
        }
        renderApps();
      }, 450);
    }, 450);
  }

  // ---------- Controls ----------
  function setRunning(on) {
    if (S.fault && on) return;
    S.running = on;
    setTag("run", on ? 1 : 0);
    log(`${ts()} <b>opcua</b> ns=2;s=Line1.Run = <b>${on ? "true" : "false"}</b>`);
    lightChip(0);
    render();
  }
  function jam() {
    if (S.fault) return;
    S.fault = true;
    setTag("fault", 1);
    log(`${ts()} <b>ALARM</b> Line1.Fault conveyor jam at photo-eye`, "err");
    log(`${ts()} <b>mqtt</b> plant/line1/alarms <b>{"code":"JAM","sev":2}</b>`, "err");
    packet(0, true);
    setTimeout(() => packet(1, true), 450);
    setTimeout(() => packet(2, true), 900);
    render();
  }
  function reset() {
    if (!S.fault) return;
    S.fault = false;
    setTag("fault", 0);
    log(`${ts()} <b>ack</b> fault cleared by operator`, "ok");
    render();
  }

  el.btn.start.addEventListener("click", () => setRunning(true));
  el.btn.stop.addEventListener("click", () => setRunning(false));
  el.btn.fault.addEventListener("click", jam);
  el.btn.reset.addEventListener("click", reset);
  $("[data-speed]").addEventListener("input", e => { S.speed = +e.target.value; });

  // ---------- Rendering ----------
  function motorOn() { return S.running && !S.fault; }

  function render() {
    const on = motorOn();
    el.lamp.className = "status-lamp" + (S.fault ? " fault" : on ? " run" : "");
    el.state.className = "hmi-state" + (S.fault ? " fault" : on ? " run" : "");
    el.state.textContent = S.fault ? "FAULTED" : on ? "RUNNING" : "STOPPED";
    el.alarm.hidden = !S.fault;
    el.alarmText.textContent = "Conveyor jam at filler outfeed. Clear the jam, then reset.";
    el.jam.style.display = S.fault ? "" : "none";
    el.btn.start.disabled = S.fault || S.running;
    el.btn.stop.disabled = !S.running;
    el.btn.fault.disabled = S.fault;
    el.btn.reset.disabled = !S.fault;
    $$(".stage").forEach(s => s.classList.toggle("alarm", S.fault));

    const motor = $('[data-r="motor"]');
    motor.textContent = on ? "ON" : "OFF";
    motor.className = on ? "on-txt" : S.fault ? "bad-txt" : "";

    // Ladder: power flows left to right through closed contacts
    const runClosed = S.running, faultClosed = !S.fault;
    $('[data-c="run"]').classList.toggle("hot", runClosed);
    $('[data-c="fault"]').classList.toggle("hot", faultClosed);
    $('[data-c="motor"]').classList.toggle("hot", on);
    el.rungRails[0].classList.add("hot");
    el.segs[0].classList.toggle("hot", runClosed);
    el.segs[1].classList.toggle("hot", runClosed && faultClosed);
    el.rungRails[1].classList.toggle("hot", on);
  }

  function renderApps() {
    $('[data-k="units"]').textContent = S.count.toLocaleString();
    const total = S.runTicks + S.downTicks;
    $('[data-k="avail"]').textContent = total ? Math.round(100 * S.runTicks / total) + "%" : "100%";
    $('[data-k="wo"]').textContent = "WO-" + S.wo;
    const pct = Math.round(100 * S.woDone / S.woTarget);
    $('[data-k="wopct"]').textContent = pct + "%";
    $('[data-k="wobar"]').style.width = pct + "%";
  }

  function rate() {
    const now = performance.now();
    S.recent = S.recent.filter(t => now - t < 10000);
    return S.recent.length * 6;
  }

  function drawTrend() {
    const c = el.trend;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(document.documentElement);
    const data = S.history;
    const max = Math.max(80, ...data);
    ctx.strokeStyle = cs.getPropertyValue("--line");
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(0, h * i / 3); ctx.lineTo(w, h * i / 3); ctx.stroke(); }
    if (data.length < 2) return;
    ctx.strokeStyle = cs.getPropertyValue(S.fault ? "--bad" : "--accent");
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / 59) * w, y = h - 6 - (v / max) * (h - 12);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  // ---------- Main loop ----------
  let tick = 0;
  function step() {
    tick++;
    const on = motorOn();
    if (S.running || S.fault) on ? S.runTicks++ : S.downTicks++;

    let filling = false;
    if (on) {
      const v = S.speed * 1.1;
      S.bottles.forEach(b => {
        b.x += v;
        if (b.x > 140 && b.x < 160) { b.fill = Math.min(1, b.fill + v / 20); filling = true; }
        if (!b.counted && b.x >= 230) { b.counted = true; onCount(); }
      });
      S.bottles = S.bottles.filter(b => { if (b.x > 320) { b.g.remove(); return false; } return true; });
      const first = S.bottles.reduce((m, b) => Math.min(m, b.x), Infinity);
      if (first > 32) S.bottles.push(makeBottle(first - 52));
      S.bottles.forEach(drawBottle);
      $$("circle", $("[data-rollers]")).forEach((r, i) => r.setAttribute("r", 3.5 + ((tick + i) % 4 < 2 ? 0.5 : 0)));
    }

    S.level += filling ? -0.12 * S.speed : 0.08;
    S.level = Math.max(55, Math.min(95, S.level));
    el.tank.setAttribute("height", 38 * S.level / 100);
    el.tank.setAttribute("y", 49 - 38 * S.level / 100);
    el.stream.setAttribute("height", filling ? 24 : 0);

    S.eye = S.bottles.some(b => Math.abs(b.x - 230) < 9);
    el.eye.classList.toggle("on", S.eye);
    el.beam.classList.toggle("on", S.eye);
    $('[data-r="eye"]').textContent = S.fault ? "BLOCKED" : S.eye ? "MADE" : "CLEAR";
    $('[data-r="tank"]').textContent = S.level.toFixed(0) + "%";

    if (tick % 4 === 0) {
      setTag("level", S.level.toFixed(1));
      setTag("scan", (2.1 + Math.random() * 0.5).toFixed(2));
    }
    if (tick % 20 === 0) {
      const r = rate();
      $('[data-k="rate"]').textContent = r;
      S.history.push(r);
      if (S.history.length > 60) S.history.shift();
      renderApps();
      drawTrend();
      if (on && tick % 100 === 0) {
        lightChip(0);
        log(`${ts()} <b>opcua</b> ns=2;s=Tank.Level = <b>${S.level.toFixed(1)}</b>`);
      }
    }
  }

  render();
  renderApps();
  log(`${ts()} <b>opcua</b> session opened to PLC 10.0.1.20`, "ok");
  log(`${ts()} <b>mqtt</b> connected to broker plant-edge-01`, "ok");
  setInterval(step, TICK_MS);
  window.addEventListener("resize", drawTrend);
  setTimeout(() => { if (!S.running && !S.fault) setRunning(true); }, 900);
})();
