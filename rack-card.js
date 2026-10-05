/*
 * Rack Card — a front view of a network rack for Home Assistant dashboards.
 *
 * Every device is drawn to scale (1 unit = 1 mm, 1U = 44.45 mm) and its lights follow real entities: status LEDs,
 * switch and gateway port lights, UPS display, cooling fans. Tapping a device runs its tap_action, by default a
 * navigation to its pop-up hash (Bubble Card pop-ups). Plain JavaScript, no build step, no external libraries.
 */
(() => {
  const VERSION = "0.6.1";
  const TAG = "rack-card";
  if (customElements.get(TAG)) return;

  // ------------------------------------------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

  // geometry (mm)
  const UH = 44.45, PW = 482.6, RAIL = 15.9, FR = 12, GUT = 22, CAP = 54, BASE = 16;
  const X0 = GUT + FR, X1 = X0 + PW, W = X1 + FR + 4;
  const HOLES = [6.35, 22.225, 38.1];

  const CABLE = { blue: "#3b82f6", grey: "#9ca3af", yellow: "#facc15", green: "#22c55e", red: "#ef4444", black: "#1f2937", white: "#f3f4f6", orange: "#fb923c", purple: "#a855f7" };

  const BAD = new Set(["unavailable", "disconnected", "offline", "off", "heartbeat_missed", "isolated", "inform_error", "down", "problem"]);
  const GOOD = new Set(["on", "online", "connected", "home", "up", "ol", "true", "ok"]);
  // "ok" | "bad" | "idle" | "none"
  const health = (st) => {
    if (!st) return "none";
    const s = String(st.state).toLowerCase();
    if (s === "unavailable") return "bad";
    if (GOOD.has(s)) return "ok";
    if (s === "unknown") return "none";
    const n = parseFloat(s);
    if (!isNaN(n)) return n > 0 ? "ok" : "idle";
    return BAD.has(s) ? "bad" : "idle";
  };
  const num = (hass, id) => { const n = parseFloat(hass?.states[id]?.state); return isNaN(n) ? null : n; };
  const val = (hass, id, unit = "") => { const n = num(hass, id); return n === null ? "—" : `${Math.round(n)}${unit}`; };
  const portName = (k, word) => ({ sfp1: "SFP+ 1", sfp2: "SFP+ 2", wan: "WAN" })[String(k).toLowerCase()] || `${word || "Port"} ${k}`;
  const fmtW = (w) => `${(Math.round(w * 10) / 10).toString().replace(".", ",")} W`;

  // the dashboard's own configuration, through HA's frontend tree
  const huiRoot = () => {
    const main = document.querySelector("home-assistant")?.shadowRoot?.querySelector("home-assistant-main");
    return main?.shadowRoot?.querySelector("ha-panel-lovelace")?.shadowRoot?.querySelector("hui-root") || null;
  };
  // the first rack-card with its own devices, in one view (by path) or in the whole dashboard, looking inside
  // sections, stacks, conditional cards and pop-ups
  const findRack = (ll, view) => {
    if (!ll) return null;
    const views = (ll.views || []).filter((v) => !view || v.path === view);
    const walk = (n, depth) => {
      if (!n || typeof n !== "object" || depth > 12) return null;
      if (Array.isArray(n)) { for (const x of n) { const r = walk(x, depth + 1); if (r) return r; } return null; }
      if (n.type === `custom:${TAG}` && Array.isArray(n.devices) && n.from_view === undefined && n.only === undefined) return n;
      for (const k of ["sections", "cards", "card", "footer", "header"]) { const r = walk(n[k], depth + 1); if (r) return r; }
      return null;
    };
    for (const v of views) { const r = walk(v, 0); if (r) return r; }
    return null;
  };
  const portList = (ports) => Object.entries(ports || {}).map(([k, p]) => (typeof p === "string" ? { port: k, entity: p } : { port: k, ...p }));
  const labelOf = (l) => (typeof l === "string" ? { label: l } : (l || {}));
  // a patch port holds up to two cables: link is "U:port" or a list of them
  const linksOf = (l) => [].concat(l?.link || []).filter(Boolean).map(String);

  // ------------------------------------------------------------------------------------------------ drawing
  const screws = (y, h) => {
    const ys = h > UH ? [y + HOLES[1], y + h - UH + HOLES[1]] : [y + h / 2];
    return ys.map((sy) => [X0 + RAIL / 2, X1 - RAIL / 2].map((sx) =>
      `<circle cx="${sx}" cy="${sy}" r="3.6" class="screw"/><path d="M${sx - 2.2} ${sy}h4.4M${sx} ${sy - 2.2}v4.4" class="screw-x"/>`).join("")).join("");
  };
  const face = (y, h, cls) => `<rect x="${X0}" y="${y + 0.4}" width="${PW}" height="${h - 0.8}" rx="2" class="${cls}"/>`;

  // while a device is drawn, every port records its box here (patch cables are routed to these)
  let REG = null;
  const reg = (key, x, y, w, h) => { if (REG) REG[String(key)] = { x, y, w, h }; };

  // RJ45 jack, top-left at x,y. notch: "top" | "bottom". leds: UDM style corner LEDs instead of the Etherlighting ring
  const jack = (x, y, key, { w = 13, h = 11, notch = "bottom", leds = false } = {}) => {
    reg(key, x, y, w, h);
    const n = notch === "top" ? `M${x + w / 2 - 2.5} ${y}v2.2h5v-2.2` : `M${x + w / 2 - 2.5} ${y + h}v-2.2h5v2.2`;
    const ly = notch === "top" ? y + h - 2 : y + 0.6;
    const l = leds ? `<rect x="${x + 0.8}" y="${ly}" width="2.6" height="1.4" class="pled link"/><rect x="${x + w - 3.4}" y="${ly}" width="2.6" height="1.4" class="pled poe-led"/>` : "";
    return `<g class="port${leds ? " leds" : ""}" data-port="${key}"><rect x="${x - 1.3}" y="${y - 1.3}" width="${w + 2.6}" height="${h + 2.6}" rx="1.8" class="port-glow"/>`
      + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="0.9" class="jack"/><path d="${n}" class="jack-notch"/>${l}</g>`;
  };
  const sfp = (x, y, key, w = 18, h = 10) => (reg(key, x, y, w, h), "") + `<g class="port" data-port="${key}"><rect x="${x - 1.3}" y="${y - 1.3}" width="${w + 2.6}" height="${h + 2.6}" rx="1.4" class="port-glow"/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="0.8" class="sfp"/><rect x="${x + 2.2}" y="${y + 2.4}" width="${w - 4.4}" height="${h - 4.8}" class="sfp-in"/></g>`;
  // small square touchscreen with a two-line readout
  const lcm = (x, y, s, caption) => `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="2.4" class="lcm" data-h-target="lcm"/>`
    + `<text x="${x + s / 2}" y="${y + s * 0.52}" class="lcm-big" text-anchor="middle" data-txt="big"></text>`
    + `<text x="${x + s / 2}" y="${y + s * 0.8}" class="lcm-small" text-anchor="middle" data-txt="small"></text>`
    + (caption ? `<text x="${x}" y="${y + s + 5.6}" class="cap-txt">${esc(caption)}</text>` : "");

  const DRAW = {
    // an open slot: only the rails and the dark inside of the rack
    empty() { return ""; },

    // UniFi aluminium blank panel
    blank(d, y, h) {
      return face(y, h, "alu") + `<rect x="${X0 + RAIL + 4}" y="${y + 3}" width="${PW - 2 * RAIL - 8}" height="0.8" rx="0.4" class="groove"/>` + screws(y, h);
    },

    // UniFi aluminium vented panel: a field of round holes in a staggered grid
    vented(d, y, h) {
      let v = "";
      const x0 = X0 + RAIL + 14, x1 = X1 - RAIL - 14, step = 6.2, rowH = 5.4;
      for (let r = 0; r < Math.round(h / UH); r++) {
        const top = y + r * UH + 7, rows = Math.floor((UH - 14) / rowH) + 1;
        for (let j = 0; j < rows; j++) {
          const off = j % 2 ? step / 2 : 0;
          for (let x = x0 + off; x <= x1; x += step) v += `<circle cx="${x.toFixed(1)}" cy="${(top + j * rowH).toFixed(1)}" r="1.9" class="perf"/>`;
        }
      }
      return face(y, h, "alu") + v + screws(y, h);
    },

    // a PDU mounted at the back of an open slot; labelled outlets show a plug
    pdu(d, y, h) {
      const n = clamp(d.outlets || 8, 1, 12), bx = X0 + RAIL + 8, bw = PW - 2 * RAIL - 16, by = y + 5, bh = h - 10;
      let out = `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="2" class="pdu"/>`
        + `<rect x="${bx + 10}" y="${by + bh / 2 - 6}" width="12" height="12" rx="1.5" class="pdu-sw"/><rect x="${bx + 12}" y="${by + bh / 2 - 4}" width="8" height="8" rx="1" class="pdu-sw-on" data-led="status"/>`
        + `<text x="${bx + 30}" y="${by + bh / 2 + 3}" class="pdu-txt">${esc(d.label ?? "PDU")}</text>`;
      const pitch = 30, ox = bx + bw - 10 - n * pitch, cy = by + bh / 2 - 3.5;
      for (let i = 0; i < n; i++) {
        const x = ox + i * pitch + 4, cx = x + 11, l = labelOf((d.labels || {})[i + 1]);
        out += `<g class="pp"><title>${esc(`${i + 1}${l.label ? ` · ${l.label}` : ""}`)}</title>`
          + `<rect x="${x}" y="${cy - 9}" width="22" height="18" rx="3" class="pdu-out"/><circle cx="${cx - 4}" cy="${cy}" r="1.7" class="pdu-pin"/><circle cx="${cx + 4}" cy="${cy}" r="1.7" class="pdu-pin"/>`
          + (l.label ? `<rect x="${x + 2}" y="${cy - 7}" width="18" height="14" rx="3" class="plug"/><rect x="${x + 8}" y="${cy - 3}" width="6" height="6" rx="1.2" class="plug-in"/>` : "")
          + `<text x="${cx}" y="${cy + 15}" class="pdu-lbl">${esc(l.label ? clip(l.label, 11) : String(i + 1))}</text></g>`;
      }
      return out;
    },

    shelf(d, y, h) {
      const fy = y + h - 6;
      let out = `<rect x="${X0}" y="${y + 0.4}" width="${RAIL + 3}" height="${h - 0.8}" rx="1.5" class="alu"/><rect x="${X1 - RAIL - 3}" y="${y + 0.4}" width="${RAIL + 3}" height="${h - 0.8}" rx="1.5" class="alu"/>`;
      // mini PC on the left (a NUC-size box: about 144 × 41 mm, drawn a touch lower to fit the shelf)
      const nx = X0 + RAIL + 14, nw = 144, nh = 34, ny = fy - nh;
      out += `<rect x="${nx}" y="${ny}" width="${nw}" height="${nh}" rx="3.5" class="nuc"/><rect x="${nx + 1}" y="${ny + 0.6}" width="${nw - 2}" height="2" rx="1" class="nuc-hi"/>`
        + `<circle cx="${nx + 14}" cy="${ny + nh / 2}" r="5.2" class="nuc-btn"/><circle cx="${nx + 14}" cy="${ny + nh / 2}" r="5.2" class="led-ring" data-led="status"/>`
        + `<rect x="${nx + 30}" y="${ny + 12}" width="13" height="5" rx="0.6" class="usb"/><rect x="${nx + 30}" y="${ny + 20}" width="13" height="5" rx="0.6" class="usb"/>`
        + `<rect x="${nx + 49}" y="${ny + 14.5}" width="9" height="3.4" rx="1.7" class="usb"/><circle cx="${nx + 64}" cy="${ny + 16.2}" r="2" class="usb"/>`
        + `<text x="${nx + nw - 8}" y="${ny + nh / 2 + 3}" class="nuc-txt" text-anchor="end">${esc(d.label ?? "NUC")}</text>`;
      out += `<rect x="${nx + nw + 12}" y="${ny + 9}" width="92" height="16" rx="8" class="tag"/>`
        + `<text x="${nx + nw + 58}" y="${ny + 20}" class="tag-txt" text-anchor="middle" data-txt="readout"></text>`;
      // UniFi AI Port on the right, seen from its end (150 × 64 × 38.4 mm, lying lengthwise)
      if (d.ai_port) {
        const aw = 64, ah = 34, ax = X1 - RAIL - 26 - aw, ay = fy - ah;
        out += `<g class="sub" data-sub="ai_port"><title>${esc(d.ai_port.name || "AI Port")}</title>`
          + `<rect x="${ax}" y="${ay}" width="${aw}" height="${ah}" rx="9" class="aiport"/><rect x="${ax + 6}" y="${ay + 1.4}" width="${aw - 12}" height="2.4" rx="1.2" class="aiport-hi"/>`
          + `<rect x="${ax + aw / 2 - 8}" y="${ay + 8}" width="16" height="2" rx="1" class="led" data-led="ai_port"/>`
          + `<rect x="${ax + aw / 2 - 6.5}" y="${ay + 16}" width="13" height="11" rx="0.9" class="jack"/><path d="M${ax + aw / 2 - 2.5} ${ay + 27}v-2.2h5v2.2" class="jack-notch"/>`
          + `<rect x="${ax - 2}" y="${ay - 2}" width="${aw + 4}" height="${ah + 4}" rx="11" class="hl sub-hl"/></g>`;
      }
      // the tray lip, aluminium with slots
      out += `<rect x="${X0}" y="${fy}" width="${PW}" height="6" rx="1" class="alu"/>`;
      for (let i = 0; i < 40; i++) out += `<rect x="${X0 + 40 + i * 10.2}" y="${fy + 2}" width="6" height="2" rx="1" class="alu-slot"/>`;
      return out + screws(y, h);
    },

    // UniFi Switch Pro Max 16 PoE: touchscreen, 16 RJ45 in one row (12 GbE + 4 2.5 GbE), 2 SFP+, reset
    switch16(d, y, h) {
      let out = face(y, h, "alu") + screws(y, h);
      out += lcm(X0 + RAIL + 10, y + 7, 24, d.caption ?? "USW Pro Max");
      const px = X0 + 64, pitch = 18.6, gap = 9;
      for (let i = 0; i < 16; i++) {
        const x = px + i * pitch + (i >= 8 ? gap : 0);
        out += jack(x, y + 12, i + 1, { w: 13.5, h: 11.5 }) + `<text x="${x + 6.75}" y="${y + 31.5}" class="pnum">${i + 1}</text>`;
      }
      out += `<rect x="${px + 12 * pitch + gap}" y="${y + 34}" width="${4 * pitch - 3.5}" height="1.4" rx="0.7" class="bar-25"/>`;
      const sx = px + 16 * pitch + gap + 12;
      out += `<rect x="${sx + 6}" y="${y + 8.4}" width="5" height="1.4" rx="0.7" class="sfp-led" data-sfp-led="sfp1"/><rect x="${sx + 29}" y="${y + 8.4}" width="5" height="1.4" rx="0.7" class="sfp-led" data-sfp-led="sfp2"/>`
        + sfp(sx, y + 12.5, "sfp1") + sfp(sx + 23, y + 12.5, "sfp2")
        + `<text x="${sx + 9}" y="${y + 31.5}" class="pnum">17</text><text x="${sx + 32}" y="${y + 31.5}" class="pnum">18</text>`;
      out += `<circle cx="${sx + 53}" cy="${y + 18}" r="1.3" class="reset"/><text x="${sx + 53}" y="${y + 26}" class="pnum">RESET</text>`;
      return out;
    },

    // UniFi Dream Machine SE: touchscreen, HDD bay, 8 RJ45 (2 × 4), 2.5 GbE WAN, 2 SFP+, reset
    gateway(d, y, h) {
      let out = face(y, h, "alu") + screws(y, h);
      // the grooves along the top edge
      [[X0 + 52, 120], [X0 + 176, 96], [X0 + 276, 94], [X0 + 374, 78]].forEach(([x, w]) => { out += `<rect x="${x}" y="${y + 3}" width="${w}" height="0.9" rx="0.45" class="groove"/>`; });
      out += lcm(X0 + RAIL + 10, y + 8, 22, d.caption ?? "Dream Machine SE");
      // HDD bay with its tray
      const bx = X0 + 178, bw = 112, by = y + 10, bh = 26;
      out += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="1.6" class="bay"/><rect x="${bx + 2.5}" y="${by + 2.5}" width="${bw - 5}" height="${bh - 5}" rx="1.2" class="tray"/>`
        + `<circle cx="${bx + bw - 9}" cy="${by + bh / 2}" r="1.6" class="latch"/>`
        + `<circle cx="${bx + 9}" cy="${by + bh / 2}" r="1.8" class="led" data-led="disk"/>`
        + `<text x="${bx + 15}" y="${by + bh / 2 + 2.2}" class="bay-txt" data-txt="disk"></text>`;
      // LAN 1-8, odd on top
      const px = X0 + 312, pitch = 16.5;
      for (let c = 0; c < 4; c++) {
        const x = px + c * pitch;
        out += jack(x, y + 8.5, 2 * c + 1, { w: 13, h: 11, notch: "top", leds: true }) + jack(x, y + 24.5, 2 * c + 2, { w: 13, h: 11, leds: true });
      }
      const wx = px + 4 * pitch + 8;
      out += jack(wx, y + 24.5, "wan", { w: 13, h: 11, leds: true }) + `<text x="${wx + 6.5}" y="${y + 19}" class="pnum">WAN</text>`;
      const sx = wx + 21;
      out += sfp(sx, y + 8.5, "sfp1", 18, 10.5) + sfp(sx, y + 24.5, "sfp2", 18, 10.5);
      out += `<circle cx="${sx + 26}" cy="${y + 31}" r="1.2" class="reset"/>`;
      return out;
    },

    patch(d, y, h) {
      const n = clamp(d.ports || 24, 1, 48), rows = n > 24 ? 2 : 1, per = Math.ceil(n / rows);
      const span = PW - 2 * RAIL - 36, groups = Math.max(1, Math.ceil(per / 6)), gap = per > 6 ? 7 : 0;
      const pitch = (span - (groups - 1) * gap) / per, kw = Math.min(11, pitch - 4), kh = rows === 2 ? 10 : 11.5;
      const sx = X0 + RAIL + 18 + (pitch - kw) / 2;
      let out = face(y, h, "alu") + screws(y, h);
      for (let i = 0; i < n; i++) {
        const r = Math.floor(i / per), c = i % per, x = sx + c * pitch + Math.floor(c / 6) * gap;
        const ky = rows === 2 ? y + 7 + r * 18 : y + 13;
        const l = labelOf((d.labels || {})[i + 1]);
        const plugged = !!(l.label || l.color || linksOf(l).length);
        reg(i + 1, x, ky, kw, kh);
        out += `<g class="pp"><title>${esc(`${i + 1}${l.label ? ` · ${l.label}` : ""}${linksOf(l).map((k) => ` → U${k.replace(":", " · ").toUpperCase()}`).join("")}`)}</title>`
          + `<rect x="${x}" y="${ky}" width="${kw}" height="${kh}" rx="1" class="keystone"/><rect x="${x + 1.8}" y="${ky + 2}" width="${kw - 3.6}" height="${kh - 4}" rx="0.6" class="keystone-in"/>`
          + (plugged ? `<rect x="${x + 0.8}" y="${ky + 1}" width="${kw - 1.6}" height="${kh - 2}" rx="1.2" fill="${esc(CABLE[l.color] || l.color || CABLE.blue)}" class="boot"/>` : "")
          + (rows === 1 ? `<text x="${x + kw / 2}" y="${ky - 2.4}" class="pnum">${i + 1}</text>` : "")
          + (rows === 1 && l.label ? `<text x="${x + kw / 2}" y="${ky + kh + 6}" class="pp-lbl">${esc(clip(l.label, Math.max(2, Math.floor(pitch / 2.6))))}</text>` : "")
          + "</g>";
      }
      return out;
    },

    // left to right: brand and model, vents, buttons, LCD
    ups(d, y, h) {
      let out = face(y, h, "black") + screws(y, h);
      out += `<rect x="${X0 + RAIL + 5}" y="${y + 5}" width="${PW - 2 * RAIL - 10}" height="${h - 10}" rx="4" class="bezel"/>`;
      const lw = 104, lx = X1 - RAIL - 16 - lw, ly = y + 15, lh = h - 30;
      out += `<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" rx="3" class="ups-lcd" data-fill="lcd"/>`
        + `<rect x="${lx + 8}" y="${ly + 10}" width="22" height="12" rx="1.5" class="lcd-ink-o"/><rect x="${lx + 30}" y="${ly + 13.5}" width="2.6" height="5" class="lcd-ink"/>`
        + `<rect x="${lx + 10}" y="${ly + 12}" width="18" height="8" rx="0.8" class="lcd-ink" data-bar="battery"/>`
        + `<text x="${lx + 40}" y="${ly + 21.5}" class="lcd-big" data-txt="battery"></text>`
        + `<text x="${lx + 8}" y="${ly + 38}" class="lcd-small" data-txt="load"></text>`
        + `<text x="${lx + 8}" y="${ly + 49}" class="lcd-small" data-txt="runtime"></text>`;
      // buttons left of the display: power button next to it, the two small ones further out
      const cy = y + h / 2, pb = lx - 22;
      out += `<circle cx="${pb}" cy="${cy}" r="7.5" class="ups-btn"/><circle cx="${pb}" cy="${cy}" r="7.5" class="led-ring" data-led="status"/>`
        + `<path d="M${pb} ${cy - 4.5}v4M${pb - 3.4} ${cy - 2.4}a4.6 4.6 0 1 0 6.8 0" class="pwr-glyph"/>`
        + `<circle cx="${pb - 20}" cy="${cy - 7}" r="3.2" class="ups-btn sm"/><circle cx="${pb - 20}" cy="${cy + 7}" r="3.2" class="ups-btn sm"/>`;
      // vents in the middle
      for (let i = 0; i < 18; i++) out += `<rect x="${pb - 44 - i * 8.2}" y="${y + 16}" width="3.4" height="${h - 32}" rx="1.7" class="vent"/>`;
      // brand and model on the left
      out += `<text x="${X0 + RAIL + 16}" y="${cy + 2}" class="brand">${esc(d.brand ?? "")}</text>`
        + `<text x="${X0 + RAIL + 17}" y="${cy + 13}" class="model">${esc(d.label ?? "")}</text>`;
      return out;
    },
  };
  DRAW.switch = DRAW.switch16;
  DRAW["usw-pro-max-16-poe"] = DRAW.switch16;
  DRAW["udm-se"] = DRAW.gateway;
  DRAW.nuc = DRAW.shelf;
  DRAW["patch-panel"] = DRAW.patch;
  const TYPES = ["empty", "blank", "vented", "pdu", "shelf", "switch", "gateway", "patch", "ups"];
  const FREE = ["empty", "blank", "vented"];
  const isSwitch = (t) => ["switch", "switch16", "usw-pro-max-16-poe"].includes(t);
  const isGateway = (t) => ["gateway", "udm-se"].includes(t);

  const fanSvg = (cx, cy, r, key) => {
    let blades = "";
    for (let i = 0; i < 7; i++) blades += `<path d="M0 0C${r * 0.15} ${-r * 0.35} ${r * 0.55} ${-r * 0.75} ${r * 0.18} ${-r * 0.92}C${-r * 0.1} ${-r * 0.7} ${-r * 0.12} ${-r * 0.3} 0 0Z" transform="rotate(${i * 360 / 7})" class="blade"/>`;
    let grill = "";
    for (let k = 1; k <= 4; k++) grill += `<circle r="${(r * k) / 4.3}" class="grill"/>`;
    return `<g transform="translate(${cx} ${cy})" data-fan="${key}"><circle r="${r + 1.5}" class="fan-ring"/><g class="rotor">${blades}</g>`
      + `<circle r="${r * 0.22}" class="hub"/>${grill}<path d="M${-r} 0H${r}M0 ${-r}V${r}" class="grill"/></g>`;
  };

  // ------------------------------------------------------------------------------------------------ card
  class RackCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._sig = "";
    }

    static getStubConfig() {
      return {
        units: 6,
        devices: [
          { type: "pdu", u: 1 },
          { type: "switch", u: 2, name: "Switch" },
          { type: "patch", u: 3, ports: 24 },
          { type: "gateway", u: 4, name: "Gateway" },
          { type: "ups", u: 5, size: 2, name: "UPS", brand: "", label: "" },
        ],
      };
    }

    static getConfigElement() { return document.createElement(`${TAG}-editor`); }

    // A linked card ('from_view' and/or 'only') has no devices of its own: it reads the main rack-card of the
    // dashboard and shows all of it or only some units, so the rack is configured once.
    setConfig(config) {
      if (!config) throw new Error("rack-card: missing configuration");
      if (config.from_view !== undefined || config.only !== undefined) {
        this._raw = config; this._src = null; this._config = null;
        if (this._hass) this._resolve(); else this._message("…");
        return;
      }
      this._raw = null;
      if (!Array.isArray(config.devices)) throw new Error("rack-card: 'devices' is required");
      this._apply(config);
    }

    _message(text) {
      this._config = null; this._watched = [];
      this.shadowRoot.innerHTML = `<style>${CSS}</style><ha-card class="msg">${esc(text)}</ha-card>`;
    }

    // read the main card again whenever the dashboard is saved (HA replaces the config object)
    _resolve() {
      const src = findRack(huiRoot()?.lovelace?.config, this._raw.from_view);
      if (!src) { if (!this._config) this._message(`rack-card: no rack-card found${this._raw.from_view ? ` in the view '${this._raw.from_view}'` : ""}`); return; }
      if (src === this._src && this._config) return;
      this._src = src;
      const { from_view, only, type, ...own } = this._raw;
      const cfg = { ...src, ...own };
      if (only !== undefined) {
        const want = [].concat(only).map(Number);
        const pick = (src.devices || []).filter((d) => want.includes(Number(d.u)));
        if (!pick.length) { this._message("rack-card: none of the units in 'only' holds a device"); return; }
        const sz = (d) => d.size || (d.type === "ups" ? 2 : 1);
        const top = Math.min(...pick.map((d) => d.u)), bottom = Math.max(...pick.map((d) => d.u + sz(d) - 1));
        // shift the units so the first one shown is U1; patch cable links follow
        cfg.devices = pick.map((d) => {
          const n = { ...d, u: d.u - top + 1 };
          if (d.labels) n.labels = Object.fromEntries(Object.entries(d.labels).map(([p, l]) => {
            if (!l || typeof l !== "object" || !linksOf(l).length) return [p, l];
            const moved = linksOf(l).map((k) => { const [lu, lp] = k.split(":"); return `${Number(lu) - top + 1}:${lp}`; });
            return [p, { ...l, link: moved.length > 1 ? moved : moved[0] }];
          }));
          return n;
        });
        cfg.units = bottom - top + 1;
        if (!("cooling" in own)) delete cfg.cooling;
        if (!("frame" in own)) cfg.frame = false;
        if (!("title" in own)) delete cfg.title;
      }
      if (!("device_tap" in own)) cfg.device_tap = false;
      this._apply(cfg);
    }

    _apply(config) {
      const devices = config.devices.map((d, i) => {
        if (!DRAW[d.type]) throw new Error(`rack-card: unknown device type '${d.type}'`);
        if (!(d.u >= 1)) throw new Error(`rack-card: device ${i + 1} needs 'u'`);
        return { ...d, size: d.size || (d.type === "ups" ? 2 : 1), _i: i };
      });
      const units = config.units || Math.max(1, ...devices.map((d) => d.u + d.size - 1));
      const used = new Set();
      devices.forEach((d) => { for (let k = 0; k < d.size; k++) used.add(d.u + k); });
      // free units: open slots, or blank / vented panels with free_units
      const free = FREE.includes(config.free_units) ? config.free_units : "empty";
      for (let u = 1; u <= units; u++) if (!used.has(u)) devices.push({ type: free, u, size: 1, _i: -1 });
      this._config = { ...config, units };
      this._devices = devices.sort((a, b) => a.u - b.u);
      this._build();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._raw) this._resolve();
      if (!this._config) return;
      const sig = (this._watched || []).map((id) => hass.states[id]?.state).join("|");
      if (sig !== this._sig) { this._sig = sig; this._update(); }
    }

    getCardSize() { return this._config ? 6 + Math.ceil(this._config.units * 0.6) : 2; }
    getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

    // ---------------------------------------------------------------------------------------------- build
    _build() {
      const c = this._config, H = CAP + c.units * UH + BASE;
      const watched = new Set();
      const add = (id) => id && watched.add(id);
      let holes = "", devs = "", nums = "";

      for (let u = 0; u < c.units; u++) {
        const y = CAP + u * UH;
        for (const hy of HOLES) for (const rx of [X0 + RAIL / 2, X1 - RAIL / 2]) holes += `<rect x="${rx - 3.2}" y="${y + hy - 3.2}" width="6.4" height="6.4" rx="0.6" class="hole"/>`;
        const n = c.numbering === "bottom" ? c.units - u : u + 1;
        nums += `<text x="${GUT - 6}" y="${y + UH / 2 + 3}" class="unum" text-anchor="end">${n}</text>`;
        if (u) nums += `<path d="M${GUT - 14} ${y}h8" class="utick"/>`;
      }

      const ports = {}; // port boxes per device, by the device's U
      for (const d of this._devices) {
        const u0 = c.numbering === "bottom" ? c.units - (d.u + d.size - 1) + 1 : d.u;
        const y = CAP + (u0 - 1) * UH, h = d.size * UH;
        const act = c.device_tap === false ? null : this._action(d);
        [d.status, d.cpu, d.memory, d.temperature, d.battery, d.load, d.runtime, d.disk, d.storage, d.ai_port?.status].forEach(add);
        portList(d.type === "patch" ? null : d.ports).forEach((p) => { add(p.entity); add(p.poe); });
        REG = {};
        devs += `<g class="dev${act ? " tap" : ""}" data-i="${d._i}"${act ? ` tabindex="0" role="button" aria-label="${esc(d.name || d.type)}"` : ""}>`
          + (d.name ? `<title>${esc(d.name)}</title>` : "")
          + `<rect x="${X0}" y="${y}" width="${PW}" height="${h}" class="hit"/>`
          + DRAW[d.type](d, y, h)
          + `<rect x="${X0 - 1}" y="${y + 0.2}" width="${PW + 2}" height="${h - 0.4}" rx="3" class="hl"/></g>`;
        ports[d.u] = REG;
        REG = null;
      }
      const cables = this._cables(ports);

      // cooling cap: intake fan on the left, exhaust fan on the right
      const k = c.cooling;
      let cap = `<rect x="${GUT}" y="0" width="${PW + 2 * FR}" height="${CAP}" rx="7" class="frame"/><rect x="${X0}" y="7" width="${PW}" height="${CAP - 10}" rx="3" class="cap"/>`;
      if (k) {
        [k.temperature, k.humidity, k.fault, k.sensor_fault, k.status, k.fan_in, k.fan_out].forEach(add);
        const r = 17, cy = 7 + (CAP - 10) / 2;
        let fx = "";
        if (k.fan_in) fx += fanSvg(X0 + 42, cy, r, "in") + `<text x="${X0 + 42 + r + 8}" y="${cy + 3}" class="tiny">${esc(k.in_label ?? "IN")}</text>`;
        if (k.fan_out) fx += fanSvg(X1 - 42, cy, r, "out") + `<text x="${X1 - 42 - r - 8}" y="${cy + 3}" class="tiny" text-anchor="end">${esc(k.out_label ?? "OUT")}</text>`;
        const act = c.device_tap === false ? null : this._action(k);
        cap = `<g class="dev${act ? " tap" : ""}" data-i="cooling"${act ? ` tabindex="0" role="button" aria-label="${esc(k.name || "Cooling")}"` : ""}>`
          + `<title>${esc(k.name || "Cooling")}</title>${cap}${fx}`
          + `<rect x="${X0 + PW / 2 - 70}" y="${cy - 15}" width="140" height="30" rx="4" class="oled"/>`
          + `<text x="${X0 + PW / 2 - 6}" y="${cy + 6}" class="oled-big" text-anchor="end" data-txt="temp"></text>`
          + `<text x="${X0 + PW / 2 + 4}" y="${cy - 1}" class="oled-small" data-txt="hum"></text>`
          + `<text x="${X0 + PW / 2 + 4}" y="${cy + 9}" class="oled-small" data-txt="fans"></text>`
          + `<circle cx="${X0 + PW / 2 + 60}" cy="${cy - 8}" r="2" class="led" data-led="cooling"/>`
          + `<rect x="${GUT}" y="0" width="${PW + 2 * FR}" height="${CAP}" rx="7" class="hl"/></g>`;
      }

      this._watched = [...watched];
      this._sig = "";
      const title = c.title ? `<div class="title">${esc(c.title)}</div>` : "";
      // frame: false draws the devices alone (no frame, cap, rails, numbers or plinth), cropped to their faceplates
      const framed = c.frame !== false;
      const box = framed ? `0 0 ${W} ${H}` : `${X0 - 1} ${CAP - 1} ${PW + 2} ${c.units * UH + 2}`;
      this._pop = null;
      this.shadowRoot.innerHTML = `<style>${CSS}</style><ha-card class="${framed ? "" : "bare"}">${title}<div class="wrap" style="max-width:${esc(c.max_width || "100%")}"><div class="port-pop" hidden></div>
        <svg viewBox="${box}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(c.title || "Rack")}" class="${c.finish === "dark" ? "dark" : "light"}">
          <defs>
            <linearGradient id="rk-frame-l" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d9dde1"/><stop offset=".5" stop-color="#eef0f2"/><stop offset="1" stop-color="#d9dde1"/></linearGradient>
            <linearGradient id="rk-depth-l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9ba1a8"/><stop offset=".5" stop-color="#b8bdc3"/><stop offset="1" stop-color="#9ba1a8"/></linearGradient>
            <linearGradient id="rk-alu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e4e7ea"/><stop offset=".5" stop-color="#d3d7db"/><stop offset="1" stop-color="#bfc4c9"/></linearGradient>
            <linearGradient id="rk-black" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2d32"/><stop offset="1" stop-color="#16181b"/></linearGradient>
            <linearGradient id="rk-frame" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2b2f35"/><stop offset=".5" stop-color="#1f2227"/><stop offset="1" stop-color="#2b2f35"/></linearGradient>
            <linearGradient id="rk-depth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050506"/><stop offset=".5" stop-color="#0d0e10"/><stop offset="1" stop-color="#050506"/></linearGradient>
          </defs>
          ${framed ? `<rect x="${GUT}" y="0" width="${PW + 2 * FR}" height="${H}" rx="7" class="frame"/>` : ""}
          <rect x="${X0}" y="${CAP}" width="${PW}" height="${c.units * UH}" class="interior"/>
          ${framed ? `<rect x="${X0}" y="${CAP}" width="${RAIL}" height="${c.units * UH}" class="rail"/>
          <rect x="${X1 - RAIL}" y="${CAP}" width="${RAIL}" height="${c.units * UH}" class="rail"/>
          ${holes}${nums}` : ""}${devs}${cables}${framed ? cap : ""}
          ${framed ? `<rect x="${GUT + 10}" y="${H - BASE + 4}" width="${PW + 2 * FR - 20}" height="${BASE - 8}" rx="2" class="plinth"/>` : ""}
        </svg></div></ha-card>`;

      this.shadowRoot.querySelectorAll(".dev.tap").forEach((g) => {
        const run = () => this._run(g.dataset.i);
        g.addEventListener("click", run);
        g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } });
      });
      // a device inside another one (the AI Port on the shelf) has its own action
      if (c.device_tap !== false) this.shadowRoot.querySelectorAll(".sub").forEach((s) => {
        const d = this._devices.find((x) => String(x._i) === s.closest(".dev").dataset.i), sub = d && d[s.dataset.sub];
        if (!sub || !this._action(sub)) return;
        s.classList.add("tap");
        s.addEventListener("click", (e) => { e.stopPropagation(); this._exec(this._action(sub), sub); });
      });
      // device_tap: false — the devices do nothing, the ports bound to an entity open it
      if (c.device_tap === false) for (const d of this._devices) {
        if (d._i < 0 || d.type === "patch") continue;
        const g = this.shadowRoot.querySelector(`.dev[data-i="${d._i}"]`);
        for (const p of portList(d.ports)) {
          const el = g?.querySelector(`[data-port="${p.port}"]`);
          if (!el || (!p.entity && !p.poe)) continue;
          el.classList.add("tap");
          el.addEventListener("click", (e) => { e.stopPropagation(); this._openPort(d, p, el); });
        }
      }
      if (this._hass) this._update();
    }

    // short patch cables from patch panel ports to switch / gateway ports. A link is "U:port" (e.g. "3:5"), stored on
    // the patch panel port; the cable leaves each port on the side facing the other device and ends in a plug
    _cables(ports) {
      let out = "";
      for (const d of this._devices) {
        if (d.type !== "patch" && d.type !== "patch-panel") continue;
        for (const [p, raw] of Object.entries(d.labels || {})) {
          const l = labelOf(raw);
          for (const k of linksOf(l)) {
          const [tu, tp] = k.split(":");
          const a = ports[d.u]?.[p], b = ports[tu]?.[tp];
          if (!a || !b) continue;
          const col = esc(CABLE[l.color] || l.color || CABLE.blue);
          const down = b.y > a.y; // the device is below the patch panel
          const ax = a.x + a.w / 2, ay = down ? a.y + a.h - 1.5 : a.y + 1.5;
          const bx = b.x + b.w / 2, by = down ? b.y + 1.5 : b.y + b.h - 1.5;
          const dy = by - ay;
          const path = `M${ax.toFixed(1)} ${ay.toFixed(1)}C${ax.toFixed(1)} ${(ay + dy * 0.6).toFixed(1)} ${bx.toFixed(1)} ${(by - dy * 0.6).toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
          out += `<g class="cable"><path d="${path}" class="cable-sh"/><path d="${path}" stroke="${col}" class="cable-in"/>`
            + `<rect x="${b.x + 0.7}" y="${b.y + 0.7}" width="${b.w - 1.4}" height="${b.h - 1.4}" rx="1.3" fill="${col}" class="boot"/>`
            + `<rect x="${b.x + b.w / 2 - 2.5}" y="${down ? b.y + 1.6 : b.y + b.h - 3.2}" width="5" height="1.6" rx="0.6" class="boot-tab"/></g>`;
          // a cable leaving downwards crosses the port label: draw the label again on top of it
          if (down && l.label && a.h > 10.5) out += `<text x="${ax}" y="${a.y + a.h + 6}" class="pp-lbl halo">${esc(clip(l.label, Math.max(2, Math.floor((a.w + 5) / 2.6))))}</text>`;
          }
        }
      }
      return out ? `<g class="cables">${out}</g>` : "";
    }

    // ---------------------------------------------------------------------------------------------- live values
    _update() {
      const hass = this._hass, root = this.shadowRoot;
      if (!hass || !root.querySelector("svg")) return;
      const st = (id) => (id ? hass.states[id] : undefined);
      const setLed = (g, key, h) => g.querySelectorAll(`[data-led="${key}"]`).forEach((el) => el.setAttribute("data-h", h));
      const setTxt = (g, key, t) => g.querySelectorAll(`[data-txt="${key}"]`).forEach((el) => { el.textContent = t; });
      const title = (el, text) => {
        let t = el.querySelector(":scope > title");
        if (!t) { t = document.createElementNS("http://www.w3.org/2000/svg", "title"); el.prepend(t); }
        t.textContent = text;
      };

      for (const d of this._devices) {
        if (d._i < 0) continue;
        const g = root.querySelector(`.dev[data-i="${d._i}"]`);
        if (!g) continue;
        const h = d.status ? health(st(d.status)) : "none";
        g.classList.toggle("down", h === "bad");
        setLed(g, "status", h);
        g.querySelectorAll('[data-h-target="lcm"]').forEach((el) => el.setAttribute("data-h", h));

        if (d.type !== "patch") for (const p of portList(d.ports)) {
          const el = g.querySelector(`[data-port="${p.port}"]`);
          if (!el) continue;
          const pi = this._portInfo(p);
          el.setAttribute("data-h", pi.h);
          el.classList.toggle("poe", pi.w !== null && pi.w > 0);
          const led = g.querySelector(`[data-sfp-led="${p.port}"]`);
          if (led) led.setAttribute("data-h", pi.h);
          title(el, `${portName(p.port)} · ${pi.name}${pi.w !== null && pi.w > 0 ? ` · PoE ${fmtW(pi.w)}` : ""}`);
        }

        if (d.type === "shelf" || d.type === "nuc") {
          const parts = [];
          if (d.cpu) parts.push(`CPU ${val(hass, d.cpu, "%")}`);
          if (d.memory) parts.push(`RAM ${val(hass, d.memory, "%")}`);
          setTxt(g, "readout", parts.join(" · "));
          if (d.ai_port) setLed(g, "ai_port", d.ai_port.status ? health(st(d.ai_port.status)) : "none");
        }
        if (isSwitch(d.type) || isGateway(d.type)) {
          setTxt(g, "big", h === "bad" ? "!" : (d.temperature ? val(hass, d.temperature, "°") : ""));
          setTxt(g, "small", d.cpu ? `CPU ${val(hass, d.cpu, "%")}` : "");
        }
        if (isGateway(d.type)) {
          // the disk entity is a problem sensor: on (or unavailable) means trouble
          const ds = st(d.disk)?.state;
          setLed(g, "disk", !d.disk ? "none" : (ds === "on" || ds === "unavailable" ? "bad" : "ok"));
          setTxt(g, "disk", d.storage ? `HDD ${val(hass, d.storage, "%")}` : "HDD");
        }
        if (d.type === "ups") {
          const b = num(hass, d.battery);
          setTxt(g, "battery", b === null ? "—" : `${Math.round(b)}%`);
          setTxt(g, "load", d.load ? `LOAD ${val(hass, d.load, "%")}` : "");
          setTxt(g, "runtime", d.runtime ? `${val(hass, d.runtime)} MIN` : "");
          const bar = g.querySelector('[data-bar="battery"]');
          if (bar) bar.setAttribute("width", String(18 * clamp((b ?? 0) / 100, 0, 1)));
          const s = String(st(d.status)?.state || "").toLowerCase();
          const ups = !st(d.status) ? "none" : (s === "unavailable" ? "bad" : (/online|^ol/.test(s) ? "ok" : (/batter|^ob|discharg/.test(s) ? "warn" : "bad")));
          setLed(g, "status", ups);
          g.classList.toggle("down", ups === "bad");
          g.querySelector('[data-fill="lcd"]')?.setAttribute("data-h", ups);
        }
      }

      const k = this._config.cooling;
      const g = root.querySelector('.dev[data-i="cooling"]');
      if (k && g) {
        const t = num(hass, k.temperature), hu = num(hass, k.humidity);
        setTxt(g, "temp", t === null ? "—" : `${t.toFixed(1)}°`);
        setTxt(g, "hum", hu === null ? "" : `${Math.round(hu)}% UR`);
        const fault = st(k.fault)?.state === "on" || st(k.sensor_fault)?.state === "on";
        const sh = k.status ? health(st(k.status)) : "ok";
        setLed(g, "cooling", fault || sh === "bad" ? "bad" : "ok");
        g.classList.toggle("down", fault || sh === "bad");
        const rpms = [];
        [["in", k.fan_in], ["out", k.fan_out]].forEach(([key, id]) => {
          const el = g.querySelector(`[data-fan="${key}"]`);
          const rpm = num(hass, id);
          if (rpm !== null && rpm > 0) rpms.push(rpm);
          if (!el) return;
          const spin = rpm !== null && rpm > 0;
          el.querySelector(".rotor").style.animationDuration = spin ? `${clamp(1500 / rpm, 0.35, 6).toFixed(2)}s` : "";
          el.classList.toggle("spin", spin);
          el.classList.toggle("stopped", !spin);
          title(el, `${key === "in" ? (k.in_label ?? "IN") : (k.out_label ?? "OUT")} · ${rpm === null ? "—" : `${Math.round(rpm)} rpm`}`);
        });
        setTxt(g, "fans", rpms.length ? `${Math.round(Math.max(...rpms))} RPM` : (k.fan_in || k.fan_out ? strings(hass).fansStopped : ""));
      }
      if (this._pop) this._renderPop();
    }

    // ---------------------------------------------------------------------------------------------- ports
    // a port reads 'entity' (the connected device: state or power) and, optionally, 'poe' (its PoE power in W)
    _portInfo(p) {
      const hass = this._hass, s = p.entity ? hass?.states[p.entity] : undefined;
      const isW = (x) => !!(x && x.attributes?.unit_of_measurement === "W");
      const ws = p.poe ? hass?.states[p.poe] : (isW(s) ? s : undefined);
      const wv = ws ? parseFloat(ws.state) : NaN, w = isFinite(wv) ? wv : null;
      // on a port "off" is a device switched off (a TV in standby), not a fault: only unavailable is
      const h = s ? (String(s.state).toLowerCase() === "off" ? "idle" : health(s)) : (w !== null ? (w > 0 ? "ok" : "idle") : "none");
      return { h, w, name: p.name || s?.attributes?.friendly_name || p.entity || "" };
    }

    // the little panel a tapped port opens, under the port
    _openPort(d, p, el) {
      this._closePop();
      this._pop = { d, p, el };
      this._renderPop();
      const box = this.shadowRoot.querySelector(".port-pop");
      this._outside = (e) => { const path = e.composedPath(); if (!path.includes(box) && !path.includes(el)) this._closePop(); };
      this._esc = (e) => { if (e.key === "Escape") this._closePop(); };
      setTimeout(() => { if (!this._pop) return; document.addEventListener("click", this._outside, true); document.addEventListener("keydown", this._esc); });
    }

    _closePop() {
      if (this._outside) document.removeEventListener("click", this._outside, true);
      if (this._esc) document.removeEventListener("keydown", this._esc);
      this._outside = this._esc = null; this._pop = null;
      const box = this.shadowRoot.querySelector(".port-pop");
      if (box) box.hidden = true;
    }

    disconnectedCallback() { this._closePop(); }

    _renderPop() {
      const box = this.shadowRoot.querySelector(".port-pop"), wrap = this.shadowRoot.querySelector(".wrap");
      if (!this._pop || !box || !wrap) return;
      const { d, p, el } = this._pop, T = strings(this._hass), pi = this._portInfo(p);
      const col = { ok: "#4ade80", idle: "#9ca3af", bad: "#f87171", none: "#9ca3af" }[pi.h];
      const txt = { ok: T.portOn, idle: T.portOff, bad: T.portUnavailable, none: "—" }[pi.h];
      let rows = `<div class="r"><span>${esc(T.portStatus)}</span><b><i class="dot" style="background:${col}"></i>${esc(txt)}</b></div>`;
      const ip = p.entity ? this._hass?.states[p.entity]?.attributes?.ip : undefined;
      if (ip) rows += `<div class="r"><span>IP</span><b>${esc(ip)}</b></div>`;
      if (p.poe || pi.w !== null) rows += `<div class="r"><span>PoE</span><b>${pi.w === null ? "—" : (pi.w > 0 ? fmtW(pi.w) : esc(T.portNoPoe))}</b></div>`;
      const ent = p.entity || p.poe;
      box.innerHTML = `<div class="ph"><div class="t"><small>${esc(portName(p.port, T.portWord))}</small><b>${esc(pi.name)}</b></div>`
        + `<button class="x" aria-label="${esc(T.close)}">✕</button></div>${rows}${ent ? `<button class="more">${esc(T.portDetails)}</button>` : ""}`;
      box.hidden = false;
      box.querySelector(".x").addEventListener("click", (e) => { e.stopPropagation(); this._closePop(); });
      box.querySelector(".more")?.addEventListener("click", (e) => { e.stopPropagation(); this._closePop(); this._exec({ action: "more-info", entity: ent }, d); });
      const wr = wrap.getBoundingClientRect(), er = el.getBoundingClientRect(), bw = box.offsetWidth || 220;
      box.style.left = `${clamp(er.left + er.width / 2 - wr.left - bw / 2, 0, Math.max(0, wr.width - bw))}px`;
      box.style.top = `${er.bottom - wr.top + 6}px`;
    }

    // ---------------------------------------------------------------------------------------------- actions
    _action(d) {
      if (d.tap_action) return d.tap_action.action === "none" ? null : d.tap_action;
      if (d.popup) return { action: "navigate", navigation_path: d.popup };
      if (d.status) return { action: "more-info", entity: d.status };
      return null;
    }

    _run(i) {
      const d = i === "cooling" ? this._config.cooling : this._devices.find((x) => String(x._i) === i);
      const act = d && this._action(d);
      if (act) this._exec(act, d);
    }

    _exec(act, d) {
      if (navigator.vibrate) try { navigator.vibrate(8); } catch (e) { /* not allowed */ }
      switch (act.action) {
        case "navigate": {
          const path = act.navigation_path;
          const url = path.startsWith("#") ? `${location.pathname}${location.search}${path}` : path;
          history.pushState(null, "", url);
          window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
          break;
        }
        case "more-info":
          this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: act.entity || d.status }, bubbles: true, composed: true }));
          break;
        case "url":
          window.open(act.url_path, act.new_tab === false ? "_self" : "_blank");
          break;
        default:
          // let Home Assistant handle the rest (perform-action, toggle, ...)
          this.dispatchEvent(new CustomEvent("hass-action", { detail: { config: { entity: d.status, tap_action: act }, action: "tap" }, bubbles: true, composed: true }));
      }
    }
  }

  const CSS = `
    :host { display: block; }
    ha-card { padding: 12px 10px 10px; overflow: visible; }
    ha-card.bare { padding: 0; background: none; box-shadow: none; border: none; }
    .title { font: 500 16px/1.3 var(--ha-font-family-body, system-ui); color: var(--primary-text-color); padding: 2px 6px 10px; }
    .wrap { margin: 0 auto; position: relative; }
    .port-pop { position: absolute; z-index: 5; width: 220px; box-sizing: border-box; padding: 10px 12px 12px; border-radius: 14px;
      background: var(--card-background-color, var(--ha-card-background, #fff)); color: var(--primary-text-color);
      box-shadow: 0 8px 28px rgba(0,0,0,.28); border: 1px solid var(--divider-color); font: 13px/1.35 var(--ha-font-family-body, system-ui); }
    .port-pop[hidden] { display: none; }
    .port-pop .ph { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
    .port-pop .ph .t { flex: 1; min-width: 0; }
    .port-pop .ph .t small { display: block; color: var(--secondary-text-color); font-size: 11px; font-weight: 600; letter-spacing: .3px; }
    .port-pop .ph .t b { display: block; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .port-pop .x { border: none; background: none; color: var(--secondary-text-color); font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 4px; }
    .port-pop .r { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; border-top: 1px solid var(--divider-color); }
    .port-pop .r span { color: var(--secondary-text-color); }
    .port-pop .r b { font-weight: 600; }
    .port-pop .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
    .port-pop .more { margin-top: 8px; width: 100%; padding: 7px 10px; border-radius: 10px; border: 1px solid var(--divider-color); background: transparent;
      color: var(--primary-color); font: 600 13px var(--ha-font-family-body, system-ui); cursor: pointer; }
    svg { display: block; width: 100%; height: auto; font-family: var(--ha-font-family-body, system-ui, sans-serif); -webkit-tap-highlight-color: transparent; }
    .frame { fill: url(#rk-frame); }
    .interior { fill: url(#rk-depth); }
    .rail { fill: #2f343a; }
    .hole { fill: #08090a; }
    .unum { fill: var(--secondary-text-color); font-size: 10px; font-weight: 600; }
    .utick { stroke: var(--divider-color); stroke-width: 1; }
    .plinth { fill: #15171a; }
    .cap { fill: #17191c; }
    .screw { fill: #8d939a; stroke: #4a4f55; stroke-width: .6; }
    .screw-x { stroke: #4a4f55; stroke-width: .9; stroke-linecap: round; }
    .light .frame { fill: url(#rk-frame-l); }
    .light .interior { fill: url(#rk-depth-l); }
    .light .rail { fill: #cdd2d7; }
    .light .hole { fill: #5a6067; }
    .light .cap { fill: #e2e5e8; }
    .light .plinth { fill: #c6cbd0; }
    .light .tiny { fill: #5f666e; }
    .light .fan-ring { stroke: #a9afb5; }
    .perf { fill: #6f767d; }
    .led[data-led="ai_port"][data-h="ok"] { fill: #60a5fa; filter: drop-shadow(0 0 2px #60a5fa); }
    .cables { pointer-events: none; }
    .cable-sh { fill: none; stroke: rgba(0,0,0,.45); stroke-width: 4.4; stroke-linecap: round; }
    .cable-in { fill: none; stroke-width: 3.2; stroke-linecap: round; }
    .boot-tab { fill: rgba(0,0,0,.35); }
    .pp-lbl.halo { paint-order: stroke; stroke: #d3d7db; stroke-width: 1.6px; stroke-linejoin: round; }
    .plug { fill: #1b1d20; stroke: #000; stroke-width: .4; }
    .plug-in { fill: #2e3237; }
    .pdu-lbl { fill: #9aa1a8; font-size: 4.6px; font-weight: 600; text-anchor: middle; }
    .aiport { fill: #26292d; stroke: #15171a; stroke-width: .6; }
    .aiport-hi { fill: #3a3e44; }
    .ai-txt { fill: #8a9097; font-size: 4px; font-weight: 700; letter-spacing: .6px; text-anchor: middle; }
    .sub.tap { cursor: pointer; }
    .port.tap { cursor: pointer; }
    @media (hover: hover) { .port.tap:hover .port-glow { stroke: var(--primary-color) !important; filter: none !important; } }
    ha-card.msg { padding: 14px 16px; font: 13px/1.4 var(--ha-font-family-body, system-ui); color: var(--secondary-text-color); }
    .dev .sub-hl { stroke: transparent !important; fill: transparent !important; animation: none !important; }
    @media (hover: hover) { .dev .sub.tap:hover .sub-hl { stroke: var(--primary-color) !important; } }
    .black { fill: url(#rk-black); }
    .alu { fill: url(#rk-alu); stroke: #aeb4ba; stroke-width: .5; }
    .alu-slot { fill: #9aa1a8; }
    .groove { fill: #b4bac0; }
    .vent { fill: #0d0e10; opacity: .85; }
    .hit { fill: transparent; }
    .pdu { fill: #24272b; stroke: #33373c; stroke-width: .8; }
    .pdu-sw { fill: #111214; }
    .pdu-sw-on { fill: #4b1c1c; }
    .pdu-sw-on[data-h="ok"], .pdu-sw-on:not([data-h]), .pdu-sw-on[data-h="none"] { fill: #ef4444; filter: drop-shadow(0 0 2px #ef4444); }
    .pdu-txt { fill: #7b8189; font-size: 8px; font-weight: 700; letter-spacing: 1.4px; }
    .pdu-out { fill: #0c0d0e; stroke: #3b4046; stroke-width: .7; }
    .pdu-pin { fill: #2c3035; }
    .nuc { fill: #141518; stroke: #2c2f34; stroke-width: .8; }
    .nuc-hi { fill: #2c3036; }
    .nuc-btn { fill: #0b0c0d; }
    .nuc-txt { fill: #6d737a; font-size: 7.5px; font-weight: 600; letter-spacing: .6px; }
    .usb { fill: #050506; stroke: #3a3e43; stroke-width: .5; }
    .tag { fill: #23272c; stroke: #3a3f45; stroke-width: .6; }
    .tag-txt { fill: #c9d1d9; font-size: 7.5px; font-weight: 600; letter-spacing: .3px; }
    .tiny { fill: #7d838a; font-size: 6px; font-weight: 700; letter-spacing: .6px; }
    .lcm { fill: #0b0c0e; stroke: #8b9299; stroke-width: .5; }
    .lcm[data-h="bad"] { fill: #3a1010; }
    .lcm-big { fill: #e9edf1; font-size: 8.5px; font-weight: 600; }
    .lcm-small { fill: #8fa3b5; font-size: 4.2px; font-weight: 600; }
    .cap-txt { fill: #6b7179; font-size: 3.6px; font-weight: 600; }
    .pnum { fill: #7a8189; font-size: 4px; font-weight: 600; text-anchor: middle; }
    .bar-25 { fill: #9ba2a9; }
    .jack { fill: #101113; }
    .jack-notch { fill: #2a2d31; }
    .sfp { fill: #7f868d; }
    .sfp-in { fill: #121315; }
    .sfp-led { fill: #a7adb3; }
    .sfp-led[data-h="ok"] { fill: #4ade80; }
    .reset { fill: #3a3f45; }
    .port-glow { fill: none; stroke: transparent; stroke-width: 1.5; }
    .port:not(.leds)[data-h="ok"] .port-glow { stroke: #4ade80; filter: drop-shadow(0 0 2px #4ade80); }
    .port.poe:not(.leds)[data-h="ok"] .port-glow { stroke: #60a5fa; filter: drop-shadow(0 0 2px #60a5fa); }
    .port:not(.leds)[data-h="idle"] .port-glow { stroke: #9ca3af; }
    .port[data-h="bad"] .port-glow { stroke: #f87171; }
    .pled { fill: #2b2e33; }
    .port[data-h="ok"] .pled.link { fill: #4ade80; filter: drop-shadow(0 0 1.5px #4ade80); }
    .port.poe[data-h="ok"] .pled.poe-led { fill: #fbbf24; filter: drop-shadow(0 0 1.5px #fbbf24); }
    .bay { fill: #9da4ab; }
    .tray { fill: url(#rk-alu); stroke: #a2a9b0; stroke-width: .5; }
    .latch { fill: #7c838a; }
    .bay-txt { fill: #5f666e; font-size: 5px; font-weight: 700; letter-spacing: .4px; }
    .keystone { fill: #2a2d31; }
    .keystone-in { fill: #050506; }
    .boot { stroke: rgba(0,0,0,.35); stroke-width: .5; }
    .pp-lbl { fill: #4b5259; font-size: 4.2px; font-weight: 600; text-anchor: middle; }
    .bezel { fill: #121315; stroke: #2b2e33; stroke-width: .8; }
    .ups-lcd { fill: #1c3a52; stroke: #0a0b0c; stroke-width: 1.2; }
    .ups-lcd[data-h="warn"] { fill: #5a4410; }
    .ups-lcd[data-h="bad"] { fill: #5a1a1a; }
    .lcd-ink { fill: #bfe3ff; }
    .lcd-ink-o { fill: none; stroke: #bfe3ff; stroke-width: 1.2; }
    .lcd-big { fill: #e3f3ff; font-size: 15px; font-weight: 700; }
    .lcd-small { fill: #a8cdea; font-size: 8px; font-weight: 700; letter-spacing: .6px; }
    .ups-btn { fill: #26292e; }
    .ups-btn.sm { fill: #1d2024; stroke: #3a3f45; stroke-width: .5; }
    .pwr-glyph { fill: none; stroke: #8a9097; stroke-width: 1.2; stroke-linecap: round; }
    .brand { fill: #e5e7eb; font-size: 15px; font-weight: 800; font-style: italic; letter-spacing: -.2px; }
    .model { fill: #8a9097; font-size: 7px; font-weight: 600; letter-spacing: 1px; }
    .oled { fill: #050607; stroke: #2a2e33; stroke-width: .8; }
    .oled-big { fill: #e9f6ff; font-size: 17px; font-weight: 700; }
    .oled-small { fill: #7fb2d6; font-size: 7px; font-weight: 700; letter-spacing: .5px; }
    .fan-ring { fill: #0b0c0e; stroke: #33373c; stroke-width: 1.2; }
    .blade { fill: #3b4047; }
    .hub { fill: #262a2f; stroke: #474c53; stroke-width: .6; }
    .grill { fill: none; stroke: #4b5057; stroke-width: .7; }
    .rotor { transform-box: fill-box; transform-origin: center; }
    [data-fan].spin .rotor { animation: rk-spin linear infinite; }
    [data-fan].stopped .blade { fill: #2a2d32; }
    @keyframes rk-spin { to { transform: rotate(360deg); } }
    .led { fill: #3a3f45; }
    .led-ring { fill: none; stroke: #3a3f45; stroke-width: 1.4; }
    [data-h="ok"].led { fill: #4ade80; filter: drop-shadow(0 0 2px #4ade80); }
    [data-h="ok"].led-ring { stroke: #4ade80; filter: drop-shadow(0 0 2px #4ade80); }
    [data-h="warn"].led { fill: #fbbf24; filter: drop-shadow(0 0 2px #fbbf24); }
    [data-h="warn"].led-ring { stroke: #fbbf24; filter: drop-shadow(0 0 2px #fbbf24); }
    [data-h="bad"].led { fill: #f87171; filter: drop-shadow(0 0 2px #f87171); }
    [data-h="bad"].led-ring { stroke: #f87171; filter: drop-shadow(0 0 2px #f87171); }
    [data-h="idle"].led { fill: #6b7280; }
    .hl { fill: transparent; stroke: transparent; stroke-width: 2.4; pointer-events: none; }
    .dev.tap { cursor: pointer; outline: none; }
    .dev.down .hl { stroke: #f87171; animation: rk-pulse 1.6s ease-in-out infinite; }
    @media (hover: hover) { .dev.tap:hover .hl { stroke: var(--primary-color); fill: rgba(255,255,255,.04); } }
    .dev.tap:focus-visible .hl { stroke: var(--primary-color); }
    .dev.tap:active .hl { fill: rgba(255,255,255,.08); }
    @keyframes rk-pulse { 50% { stroke-opacity: .25; } }
    @media (prefers-reduced-motion: reduce) { [data-fan].spin .rotor, .dev.down .hl { animation: none; } }
  `;

  // ------------------------------------------------------------------------------------------------ editor
  const STR = {
    it: {
      general: "Rack", cooling: "Raffreddamento", devices: "Dispositivi", add: "Dispositivo", remove: "Rimuovi",
      ports: "Porte", addPort: "Aggiungi porta", patchLabels: "Etichette delle porte", pduLabels: "Etichette delle prese", free: "libera",
      aiPort: "AI Port sul ripiano", up: "Sposta su", down: "Sposta giù",
      portWord: "Porta", portStatus: "Stato", portOn: "Collegato", portOff: "Spento", portUnavailable: "Non disponibile", portNoPoe: "Nessun consumo",
      portDetails: "Dettagli", close: "Chiudi", fansStopped: "FERME",
      linked: "Collegata a un'altra rack-card", makeLinked: "Collega a un'altra rack-card",
      linkedHint: "Per mostrare solo alcuni dispositivi di un rack già configurato (per esempio in un pop-up), collega questa card: legge tutto da quella principale.",
      linkedNote: "Dispositivi, porte, entità ed etichette arrivano dalla rack-card principale della vista scelta: si modificano lì.",
      linkedMissing: "Nessuna rack-card con dispositivi in questa vista.",
      finish: { light: "Chiaro", dark: "Scuro" },
      types: { empty: "Slot vuoto", blank: "Pannello cieco UniFi", vented: "Pannello ventilato UniFi", pdu: "PDU", shelf: "Ripiano con NUC", switch: "Switch UniFi Pro Max 16 PoE", gateway: "UniFi Dream Machine SE", patch: "Patch panel", ups: "UPS" },
      colors: { blue: "Blu", grey: "Grigio", yellow: "Giallo", green: "Verde", red: "Rosso", black: "Nero", white: "Bianco", orange: "Arancio", purple: "Viola" },
      labels: {
        title: "Titolo", units: "Unità del rack", numbering: "Numerazione", free_units: "Unità libere", max_width: "Larghezza massima (es. 640px)",
        name: "Nome", popup: "Pop-up (es. #rack-ups)", status: "Entità di stato", temperature: "Temperatura", humidity: "Umidità",
        fault: "Guasto ventole", sensor_fault: "Guasto sensori", fan_in: "Ventola ingresso (rpm)", fan_out: "Ventola uscita (rpm)",
        type: "Tipo", u: "Posizione (U)", size: "Altezza (U)", label: "Scritta sul frontale", caption: "Scritta sotto lo schermo", brand: "Marca",
        cpu: "CPU", memory: "Memoria", disk: "Problema disco", storage: "Uso disco", battery: "Batteria", load: "Carico", runtime: "Autonomia (min)",
        outlets: "Prese", ports: "Numero porte", port: "Porta", entity: "Entità (dispositivo collegato)", poe: "PoE (sensore in W)", color: "Colore cavo", cable: "Cavo collegato", plug: "Cosa è collegato", link: "Bretella verso", link2: "Seconda bretella",
        finish: "Colore del rack", show: "Mostra", frame: "Cornice del rack (spenta: solo i dispositivi, a tutta larghezza)",
        from_view: "Vista della rack-card principale", only: "Dispositivi da mostrare", device_tap: "Tocco sul dispositivo intero (spento: si toccano le porte)",
      },
      numbering: { top: "Dall'alto (U1 in alto)", bottom: "Dal basso (U1 in basso)" },
      freeUnits: { empty: "Slot aperti", blank: "Pannelli ciechi", vented: "Pannelli ventilati" },
    },
    en: {
      general: "Rack", cooling: "Cooling", devices: "Devices", add: "Device", remove: "Remove",
      ports: "Ports", addPort: "Add port", patchLabels: "Port labels", pduLabels: "Outlet labels", free: "free",
      aiPort: "AI Port on the shelf", up: "Move up", down: "Move down",
      portWord: "Port", portStatus: "Status", portOn: "Connected", portOff: "Off", portUnavailable: "Unavailable", portNoPoe: "Not drawing power",
      portDetails: "Details", close: "Close", fansStopped: "STOPPED",
      linked: "Linked to another rack-card", makeLinked: "Link to another rack-card",
      linkedHint: "To show only some devices of a rack you already configured (e.g. in a pop-up), link this card: it reads everything from the main one.",
      linkedNote: "Devices, ports, entities and labels come from the main rack-card of the chosen view: edit them there.",
      linkedMissing: "No rack-card with devices in this view.",
      finish: { light: "Light", dark: "Dark" },
      types: { empty: "Empty slot", blank: "UniFi blank panel", vented: "UniFi vented panel", pdu: "PDU", shelf: "Shelf with NUC", switch: "UniFi Switch Pro Max 16 PoE", gateway: "UniFi Dream Machine SE", patch: "Patch panel", ups: "UPS" },
      colors: { blue: "Blue", grey: "Grey", yellow: "Yellow", green: "Green", red: "Red", black: "Black", white: "White", orange: "Orange", purple: "Purple" },
      labels: {
        title: "Title", units: "Rack units", numbering: "Numbering", free_units: "Free units", max_width: "Max width (e.g. 640px)",
        name: "Name", popup: "Pop-up (e.g. #rack-ups)", status: "Status entity", temperature: "Temperature", humidity: "Humidity",
        fault: "Fan fault", sensor_fault: "Sensor fault", fan_in: "Intake fan (rpm)", fan_out: "Exhaust fan (rpm)",
        type: "Type", u: "Position (U)", size: "Height (U)", label: "Front label", caption: "Caption under the screen", brand: "Brand",
        cpu: "CPU", memory: "Memory", disk: "Disk problem", storage: "Disk usage", battery: "Battery", load: "Load", runtime: "Runtime (min)",
        outlets: "Outlets", ports: "Number of ports", port: "Port", entity: "Entity (connected device)", poe: "PoE (power sensor in W)", color: "Cable colour", cable: "Connected cable", plug: "Plugged in", link: "Patch cable to", link2: "Second patch cable",
        finish: "Rack colour", show: "Show", frame: "Rack frame (off: the devices alone, full width)",
        from_view: "View of the main rack-card", only: "Devices to show", device_tap: "Tap on the whole device (off: the ports are tapped)",
      },
      numbering: { top: "From the top (U1 at the top)", bottom: "From the bottom (U1 at the bottom)" },
      freeUnits: { empty: "Open slots", blank: "Blank panels", vented: "Vented panels" },
    },
  };
  const strings = (hass) => STR[(hass?.locale?.language || hass?.language || "en").slice(0, 2)] || STR.en;

  const ent = (name) => ({ name, selector: { entity: {} } });
  const txt = (name) => ({ name, selector: { text: {} } });
  const grid = (...schema) => ({ type: "grid", name: "", schema });
  // uOpts: the position menu, every unit with what sits there
  const deviceSchema = (t, T, uOpts) => {
    const base = [
      grid({ name: "type", selector: { select: { mode: "dropdown", options: TYPES.map((v) => ({ value: v, label: T.types[v] })) } } },
        { name: "u", selector: { select: { mode: "dropdown", options: uOpts } } }),
    ];
    if (FREE.includes(t)) return [...base, grid({ name: "size", selector: { number: { min: 1, max: 8, mode: "box" } } }, txt("name"))];
    const named = [grid(txt("name"), txt("popup")), ent("status")];
    if (t === "pdu") return [...base, ...named, grid(txt("label"), { name: "outlets", selector: { number: { min: 1, max: 12, mode: "box" } } })];
    if (t === "shelf") return [...base, ...named, txt("label"), grid(ent("cpu"), ent("memory"))];
    if (t === "switch") return [...base, ...named, txt("caption"), grid(ent("temperature"), ent("cpu"))];
    if (t === "gateway") return [...base, ...named, txt("caption"), grid(ent("temperature"), ent("cpu")), grid(ent("disk"), ent("storage"))];
    if (t === "patch") return [...base, grid(txt("name"), txt("popup")), { name: "ports", selector: { number: { min: 1, max: 48, mode: "box" } } }];
    if (t === "ups") return [...base, grid({ name: "size", selector: { number: { min: 1, max: 4, mode: "box" } } }, txt("name")), grid(txt("popup"), ent("status")),
      grid(txt("brand"), txt("label")), grid(ent("battery"), ent("load")), ent("runtime")];
    return base;
  };
  const portOptions = (t) => (isSwitch(t) ? [...Array.from({ length: 16 }, (_, i) => String(i + 1)), "sfp1", "sfp2"] : ["1", "2", "3", "4", "5", "6", "7", "8", "wan", "sfp1", "sfp2"]);

  class RackCardEditor extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }); this._open = new Set(); }

    set hass(h) {
      const first = !this._hass;
      this._hass = h;
      this.shadowRoot.querySelectorAll("ha-form").forEach((f) => { f.hass = h; });
      if (first) this._render();
    }

    // HA hands every change straight back: keep the editor's own object when nothing really changed
    setConfig(config) {
      if (this._config && JSON.stringify(config) === JSON.stringify(this._config)) return;
      this._config = JSON.parse(JSON.stringify(config));
      this._render();
    }

    async connectedCallback() {
      if (!customElements.get("ha-form")) {
        try { const h = await window.loadCardHelpers(); const c = await h.createCardElement({ type: "entities", entities: [] }); await c.constructor.getConfigElement(); }
        catch (e) { /* drawn once HA has loaded it */ }
      }
      this._render();
    }

    _fire(redraw) {
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: JSON.parse(JSON.stringify(this._config)) }, bubbles: true, composed: true }));
      if (redraw) this._render();
    }

    _form(schema, data, onChange) {
      const f = document.createElement("ha-form");
      const T = strings(this._hass);
      f.hass = this._hass; f.schema = schema; f.data = data;
      f.computeLabel = (s) => T.labels[s.name] ?? s.name;
      let last = JSON.stringify(data);
      f.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const v = ev.detail.value, j = JSON.stringify(v);
        if (!f.isConnected || j === last) return;
        last = j; f.data = v;
        onChange(v);
      });
      return f;
    }

    _el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

    // drop empty values so the YAML stays short
    _clean(o) { Object.keys(o).forEach((k) => { if (o[k] === "" || o[k] === undefined || o[k] === null) delete o[k]; }); return o; }

    _render() {
      const sr = this.shadowRoot, c = this._config;
      sr.innerHTML = `<style>${EDITOR_CSS}</style>`;
      if (!c || !this._hass || !customElements.get("ha-form")) return;
      const T = strings(this._hass);
      if (c.from_view !== undefined || c.only !== undefined) { this._renderLinked(T); return; }
      c.devices = c.devices || [];

      // general
      const gen = this._el("div", "box", `<h3>${T.general}</h3>`);
      gen.append(this._form([
        grid(txt("title"), { name: "units", selector: { number: { min: 1, max: 48, mode: "box" } } }),
        grid({ name: "numbering", selector: { select: { mode: "dropdown", options: [{ value: "top", label: T.numbering.top }, { value: "bottom", label: T.numbering.bottom }] } } },
          { name: "free_units", selector: { select: { mode: "dropdown", options: FREE.map((f) => ({ value: f, label: T.freeUnits[f] })) } } }),
        grid({ name: "finish", selector: { select: { mode: "dropdown", options: [{ value: "light", label: T.finish.light }, { value: "dark", label: T.finish.dark }] } } }, txt("max_width")),
        { name: "frame", selector: { boolean: {} } },
      ], { title: c.title, units: c.units, numbering: c.numbering || "top", free_units: c.free_units || "empty", finish: c.finish || "light", max_width: c.max_width, frame: c.frame !== false }, (v) => {
        const unitsChanged = v.units !== c.units;
        Object.assign(c, v);
        if (c.frame !== false) delete c.frame;
        if (c.numbering === "top") delete c.numbering;
        if (c.free_units === "empty") delete c.free_units;
        if (c.finish === "light") delete c.finish;
        this._clean(c); this._fire(unitsChanged);
      }));
      sr.append(gen);

      // cooling
      const k = c.cooling || {};
      const cool = this._el("div", "box", `<h3>${T.cooling}</h3>`);
      cool.append(this._form([grid(txt("name"), txt("popup")), grid(ent("temperature"), ent("humidity")), grid(ent("fan_in"), ent("fan_out")), ent("status"), grid(ent("fault"), ent("sensor_fault"))], k, (v) => {
        c.cooling = this._clean({ ...v }); if (!Object.keys(c.cooling).length) delete c.cooling; this._fire();
      }));
      sr.append(cool);

      // devices, top to bottom
      const list = this._el("div", "box", `<h3>${T.devices}</h3>`);
      const order = c.devices.map((d, i) => i).sort((a, b) => (c.devices[a].u || 0) - (c.devices[b].u || 0));
      for (const i of order) list.append(this._device(i, T));
      const bar = this._el("div", "adds");
      [["blank", T.types.blank], ["vented", T.types.vented], ["switch", T.add]].forEach(([type, label]) => {
        const b = this._el("button", "add", `+ ${esc(label)}`);
        b.addEventListener("click", () => {
          const used = this._used();
          let u = 1; while (used.has(u)) u++;
          c.devices.push(type === "switch" ? { type, u, name: "" } : { type, u });
          if (c.units && u > c.units) c.units = u;
          if (type === "switch") this._open.add(c.devices.length - 1);
          this._clean(c.devices[c.devices.length - 1]); this._fire(true);
        });
        bar.append(b);
      });
      list.append(bar);
      const link = this._el("button", "add sm", `↪ ${esc(T.makeLinked)}`);
      link.addEventListener("click", () => {
        const views = this._rackViews();
        this._config = { type: c.type || `custom:${TAG}`, from_view: views[0]?.value || "", only: [] };
        this._fire(true);
      });
      list.append(this._el("p", "note", esc(T.linkedHint)), link);
      sr.append(list);
    }

    // views of this dashboard that hold a main rack-card
    _rackViews() {
      const ll = huiRoot()?.lovelace?.config;
      return (ll?.views || []).filter((v) => v.path && findRack(ll, v.path)).map((v) => ({ value: v.path, label: v.title || v.path }));
    }

    // a linked card: which view to read and which units to show
    _renderLinked(T) {
      const sr = this.shadowRoot, c = this._config;
      const ll = huiRoot()?.lovelace?.config, src = findRack(ll, c.from_view);
      const box = this._el("div", "box", `<h3>${esc(T.linked)}</h3>`);
      box.append(this._el("p", "note", esc(T.linkedNote)));
      const views = this._rackViews();
      const units = (src?.devices || []).slice().sort((a, b) => a.u - b.u).map((d) => ({ value: String(d.u), label: `U${d.u} · ${d.name || T.types[d.type] || d.type}` }));
      const schema = [
        { name: "from_view", selector: { select: { mode: "dropdown", options: views.length ? views : [{ value: c.from_view || "", label: c.from_view || "—" }] } } },
        { name: "only", selector: { select: { multiple: true, mode: "list", options: units } } },
        grid({ name: "frame", selector: { boolean: {} } }, { name: "device_tap", selector: { boolean: {} } }),
      ];
      box.append(this._form(schema, { from_view: c.from_view, only: [].concat(c.only || []).map(String), frame: c.frame === true, device_tap: c.device_tap === true }, (v) => {
        const n = { type: c.type || `custom:${TAG}`, from_view: v.from_view };
        if (v.only && v.only.length) n.only = v.only.map(Number);
        if (v.frame) n.frame = true;
        if (v.device_tap) n.device_tap = true;
        const viewChanged = n.from_view !== c.from_view;
        this._config = n;
        this._fire(viewChanged);
      }));
      if (!src) box.append(this._el("p", "note", esc(T.linkedMissing)));
      sr.append(box);
    }

    _size(d) { return d.size || (d.type === "ups" ? 2 : 1); }

    // units taken by the devices, except the one at index skip
    _used(skip = -1) {
      const used = new Map();
      this._config.devices.forEach((d, i) => { if (i !== skip) for (let s = 0; s < this._size(d); s++) used.set(d.u + s, i); });
      return used;
    }

    // one step up or down: into a free unit, or swapping places with the neighbour
    _move(i, dir) {
      const c = this._config, d = c.devices[i], size = this._size(d), units = c.units || 48;
      const target = dir < 0 ? d.u - 1 : d.u + size;
      if (target < 1 || target > units) return;
      const before = c.devices.map((x) => x.u);
      const other = this._used(i).get(target);
      if (other === undefined) d.u += dir;
      else {
        const o = c.devices[other], os = this._size(o);
        if (dir < 0) { d.u = o.u; o.u = d.u + size; } else { o.u = d.u; d.u = d.u + os; }
      }
      this._relink(before);
      this._fire(true);
    }

    // patch cable links point at a device by its U: follow the devices that moved
    _relink(before) {
      const c = this._config, map = {};
      c.devices.forEach((x, k) => { if (before[k] !== x.u) map[before[k]] = x.u; });
      if (!Object.keys(map).length) return;
      c.devices.forEach((x) => {
        Object.entries(x.labels || {}).forEach(([p, raw]) => {
          if (!raw || typeof raw !== "object" || !linksOf(raw).length) return;
          const moved = linksOf(raw).map((k) => { const [u, port] = k.split(":"); return map[u] !== undefined ? `${map[u]}:${port}` : k; });
          raw.link = moved.length > 1 ? moved : moved[0];
        });
      });
    }

    _device(i, T) {
      const c = this._config, d = c.devices[i];
      const t = DRAW[d.type] === DRAW.switch16 ? "switch" : DRAW[d.type] === DRAW.gateway ? "gateway" : DRAW[d.type] === DRAW.shelf ? "shelf" : DRAW[d.type] === DRAW.patch ? "patch" : d.type;
      const size = d.size || (d.type === "ups" ? 2 : 1);
      const box = this._el("div", `dev${this._open.has(i) ? " open" : ""}`);
      const head = this._el("div", "head", `<span class="u">U${d.u}${size > 1 ? `–${d.u + size - 1}` : ""}</span><span class="nm">${esc(d.name || T.types[t] || d.type)}</span><span class="ty">${esc(T.types[t] || d.type)}</span>`
        + `<button class="mv" data-dir="-1" title="${T.up}">▲</button><button class="mv" data-dir="1" title="${T.down}">▼</button><span class="chev">▾</span>`);
      head.querySelectorAll(".mv").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); this._move(i, +b.dataset.dir); }));
      head.addEventListener("click", () => { this._open.has(i) ? this._open.delete(i) : this._open.add(i); box.classList.toggle("open"); });
      box.append(head);
      const body = this._el("div", "body");
      box.append(body);
      if (!this._open.has(i)) { head.addEventListener("click", () => { if (!body.childElementCount) this._deviceBody(body, i, t, T); }, { once: true }); return box; }
      this._deviceBody(body, i, t, T);
      return box;
    }

    _deviceBody(body, i, t, T) {
      const c = this._config, d = c.devices[i];
      const used = this._used(i), units = Math.max(c.units || 0, d.u + this._size(d) - 1);
      const uOpts = Array.from({ length: units }, (_, k) => {
        const u = k + 1, o = used.get(u), od = o !== undefined ? c.devices[o] : null;
        return { value: String(u), label: `U${u} · ${od ? (od.name || T.types[od.type] || od.type) : T.free}` };
      });
      body.append(this._form(deviceSchema(t, T, uOpts), { ...d, type: t, u: String(d.u) }, (v) => {
        const cur = c.devices[i];
        v = { ...v, u: Number(v.u) || cur.u };
        const typeChanged = v.type !== t, redraw = typeChanged || v.u !== cur.u || v.size !== cur.size || (["patch", "pdu"].includes(t) && (v.ports !== cur.ports || v.outlets !== cur.outlets));
        const keep = typeChanged ? { type: v.type, u: v.u, name: v.name } : v;
        const before = c.devices.map((x) => x.u);
        c.devices[i] = this._clean({ ...(typeChanged ? {} : cur), ...keep });
        this._relink(before);
        this._fire(redraw);
      }));

      if (t === "shelf") {
        const a = d.ai_port || {};
        const sec = this._el("div", "sub", `<h4>${T.aiPort}</h4>`);
        sec.append(this._form([{ name: "show", selector: { boolean: {} } }, grid(txt("name"), txt("popup")), ent("status")], { show: !!d.ai_port, name: a.name, popup: a.popup, status: a.status }, (v) => {
          const cur = c.devices[i];
          if (!v.show) delete cur.ai_port; else cur.ai_port = this._clean({ name: v.name, popup: v.popup, status: v.status });
          this._fire();
        }));
        body.append(sec);
      }

      if (t === "pdu") {
        const n = clamp(d.outlets || 8, 1, 12);
        const det = this._el("details", "sub", `<summary>${T.pduLabels} (${n})</summary>`);
        for (let p = 1; p <= n; p++) {
          const line = this._el("div", "row");
          line.append(this._el("span", "pn", String(p)));
          line.append(this._form([txt("plug")], { plug: labelOf((d.labels || {})[p]).label }, (v) => {
            const cur = c.devices[i];
            cur.labels = cur.labels || {};
            if (v.plug) cur.labels[p] = v.plug; else delete cur.labels[p];
            if (!Object.keys(cur.labels).length) delete cur.labels;
            this._fire();
          }));
          det.append(line);
        }
        body.append(det);
      }

      if (t === "switch" || t === "gateway") {
        const sec = this._el("div", "sub", `<h4>${T.ports}</h4>`);
        const rows = portList(d.ports);
        const save = (redraw) => {
          const m = {};
          rows.forEach((r) => { if (r.port !== undefined && r.port !== "") m[r.port] = this._clean({ name: r.name, entity: r.entity, poe: r.poe }); });
          const cur = c.devices[i];
          cur.ports = m; if (!Object.keys(m).length) delete cur.ports;
          this._fire(redraw);
        };
        rows.forEach((r, n) => {
          const line = this._el("div", "row");
          line.append(this._form([grid({ name: "port", selector: { select: { mode: "dropdown", options: portOptions(t).map((p) => ({ value: p, label: p.toUpperCase() })) } } }, txt("name")), grid(ent("entity"), ent("poe"))],
            { port: String(r.port), name: r.name, entity: r.entity, poe: r.poe }, (v) => { rows[n] = v; save(); }));
          const x = this._el("button", "x", "✕"); x.title = T.remove;
          x.addEventListener("click", () => { rows.splice(n, 1); save(true); });
          line.append(x); sec.append(line);
        });
        const add = this._el("button", "add sm", `+ ${T.addPort}`);
        add.addEventListener("click", () => {
          const usedP = new Set(rows.map((r) => String(r.port)));
          rows.push({ port: portOptions(t).find((p) => !usedP.has(p)) || "1" }); save(true);
        });
        sec.append(add); body.append(sec);
      }

      if (t === "patch") {
        const n = clamp(d.ports || 24, 1, 48);
        const det = this._el("details", "sub", `<summary>${T.patchLabels} (${n})</summary>`);
        const colors = Object.keys(CABLE).map((v) => ({ value: v, label: T.colors[v] }));
        // every switch / gateway port a patch cable can reach
        const targets = [{ value: "", label: "—" }];
        c.devices.filter((x) => isSwitch(x.type) || isGateway(x.type)).sort((a, b) => a.u - b.u).forEach((x) => {
          portOptions(isSwitch(x.type) ? "switch" : "gateway").forEach((pp) => targets.push({ value: `${x.u}:${pp}`, label: `U${x.u} · ${x.name || T.types[isSwitch(x.type) ? "switch" : "gateway"]} · ${pp.toUpperCase()}` }));
        });
        for (let p = 1; p <= n; p++) {
          const l = labelOf((d.labels || {})[p]);
          const line = this._el("div", "row");
          line.append(this._el("span", "pn", String(p)));
          line.append(this._form([grid(txt("cable"), { name: "color", selector: { select: { mode: "dropdown", options: colors } } }), grid({ name: "link", selector: { select: { mode: "dropdown", options: targets } } }, { name: "link2", selector: { select: { mode: "dropdown", options: targets } } })],
            { cable: l.label, color: l.color, link: linksOf(l)[0] || "", link2: linksOf(l)[1] || "" }, (v) => {
            const cur = c.devices[i];
            cur.labels = cur.labels || {};
            const ls = [v.link, v.link2].filter(Boolean);
            const e = this._clean({ label: v.cable, color: v.color, link: ls.length > 1 ? ls : ls[0] });
            if (!Object.keys(e).length) delete cur.labels[p]; else cur.labels[p] = e.color || e.link ? e : e.label;
            if (!Object.keys(cur.labels).length) delete cur.labels;
            this._fire();
          }));
          det.append(line);
        }
        body.append(det);
      }

      const rm = this._el("button", "rm", T.remove);
      rm.addEventListener("click", () => {
        c.devices.splice(i, 1);
        this._open = new Set([...this._open].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)));
        this._fire(true);
      });
      body.append(rm);
    }
  }

  const EDITOR_CSS = `
    :host { display: block; }
    .box { border: 1px solid var(--divider-color); border-radius: 12px; padding: 10px 12px 12px; margin-bottom: 12px; }
    h3 { margin: 2px 0 10px; font: 600 15px/1.3 var(--ha-font-family-body, system-ui); color: var(--primary-text-color); }
    h4 { margin: 10px 0 6px; font: 600 13px/1.3 var(--ha-font-family-body, system-ui); color: var(--secondary-text-color); }
    .dev { border: 1px solid var(--divider-color); border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
    .head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; user-select: none; }
    .head .u { font: 700 12px system-ui; color: var(--primary-color); min-width: 44px; }
    .head .nm { flex: 1; font: 500 14px system-ui; color: var(--primary-text-color); }
    .head .ty { font: 12px system-ui; color: var(--secondary-text-color); }
    .head .chev { color: var(--secondary-text-color); transition: transform .2s; }
    .head .mv { padding: 2px 7px; font-size: 10px; line-height: 1.4; }
    .adds { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .dev.open .head .chev { transform: rotate(180deg); }
    .body { display: none; padding: 0 12px 12px; }
    .dev.open .body { display: block; }
    .sub { margin-top: 10px; }
    details.sub summary { cursor: pointer; font: 600 13px system-ui; color: var(--secondary-text-color); padding: 6px 0; }
    .row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .row ha-form { flex: 1; }
    .pn { min-width: 22px; text-align: right; font: 600 12px system-ui; color: var(--secondary-text-color); }
    button { font: 500 13px system-ui; border-radius: 999px; border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color); padding: 7px 14px; cursor: pointer; }
    button.add { border-color: var(--primary-color); color: var(--primary-color); }
    button.sm { padding: 5px 10px; font-size: 12px; }
    button.x { padding: 4px 9px; }
    button.rm { margin-top: 10px; color: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }
    .note { margin: 10px 2px 8px; font: 12px/1.45 var(--ha-font-family-body, system-ui); color: var(--secondary-text-color); }
  `;

  customElements.define(TAG, RackCard);
  customElements.define(`${TAG}-editor`, RackCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: TAG, name: "Rack Card", description: "A to-scale front view of a network rack with live lights and pop-ups.", preview: false });
  console.info(`%c RACK-CARD %c ${VERSION} `, "background:#1f2227;color:#4ade80;font-weight:700", "background:#4ade80;color:#1f2227");
})();
