(function () {
  const $ = (id) => document.getElementById(id);
  const CITE = /\[@(commit|pr|issue|discussion):([^\]]+)\]/g;
  const state = {
    investigation: null,
    selected: null,
    bodies: [],
    width: 800,
    height: 560,
    view: { x: 0, y: 0, k: 1 },
    viewport: null,
    drag: null,
  };

  const colors = {
    introduced: "#e7d7b1",
    modified: "#e08a4f",
    "motivated-by": "#a3b18a",
    reverted: "#d1614a",
    linked: "#6d6258",
  };

  $("demo").addEventListener("click", () => run("/api/demo", null, "Excavating the sample repository…"));
  $("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const repo = $("repo").value.trim();
    const file = $("file").value.trim();
    const line = $("line").value.trim();
    const symbol = $("symbol").value.trim();
    if (!repo || !file || (!line && !symbol)) {
      showError("Repository, file, and either a line or a symbol are required.");
      return;
    }
    const body = {
      repo,
      file,
      question: $("question").value.trim(),
      offline: $("offline").checked,
    };
    if (line) body.line = Number(line);
    if (symbol) body.symbol = symbol;
    run("/api/investigate", body, "Following blame…");
  });
  $("copy").addEventListener("click", async () => {
    if (!state.investigation) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.investigation, null, 2));
      setStatus("Copied the investigation JSON.");
    } catch {
      setStatus("Clipboard is unavailable in this browser.");
    }
  });
  document.querySelectorAll("[data-edge]").forEach((box) => {
    box.addEventListener("change", applyFilters);
  });
  window.addEventListener("resize", () => {
    if (state.investigation) drawGraph(state.investigation.graph);
  });

  boot();

  async function boot() {
    try {
      const response = await fetch("/api/config");
      const config = await response.json();
      const bits = [];
      bits.push(config.github ? "GitHub token detected" : "No GitHub token");
      bits.push(config.llm ? `model ${config.model}` : "heuristic narrator");
      $("credential").textContent = bits.join(" · ");
    } catch {
      $("credential").textContent = "Local UI";
    }
  }

  async function run(url, body, status) {
    setBusy(true);
    showError("");
    setStatus(status);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Excavation failed");
      state.investigation = payload;
      fillForm(payload);
      render(payload);
      setStatus(`${payload.narrativeMode} · ${payload.graph.nodes.length} artifacts · ${payload.graph.edges.length} edges`);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Excavation failed");
      setStatus("Excavation failed.");
    } finally {
      setBusy(false);
    }
  }

  function fillForm(report) {
    $("repo").value = report.source.requestedRepo || report.source.repo;
    $("file").value = report.source.file;
    $("line").value = report.source.lineStart === report.source.lineEnd ? String(report.source.lineStart) : "";
    $("symbol").value = report.source.symbol || "";
    $("question").value = report.question;
  }

  function render(report) {
    $("copy").disabled = false;
    const focus = report.graph.nodes.find((node) => node.type === "focus");
    const warnings = report.warnings.length
      ? `<ul class="warnings">${report.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>`
      : "";
    const snippet = focus ? `<pre class="snippet">${esc(focus.data.snippet)}</pre>` : "";
    const heading = focus
      ? `<p class="meta">${esc(focus.data.file)}${focus.data.symbol ? " · " + esc(focus.data.symbol) : ""} · lines ${focus.data.lineStart}–${focus.data.lineEnd}</p><h2>${esc(report.question)}</h2>`
      : `<h2>${esc(report.question)}</h2>`;
    $("narrative").innerHTML = `${heading}${snippet}${warnings}${renderNarrative(report.narrative)}`;
    $("narrative").querySelectorAll("[data-cite]").forEach((button) => {
      button.addEventListener("click", () => selectNode(button.dataset.cite));
    });
    drawGraph(report.graph);
    renderArtifacts(report.graph);
    const focusId = focus ? focus.id : report.graph.nodes[0]?.id;
    if (focusId) selectNode(focusId);
  }

  function renderNarrative(text) {
    const withCode = esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
    const withCites = withCode.replace(CITE, (_, kind, value) => {
      const id = nodeId(kind, value);
      return `<button type="button" class="cite" data-cite="${esc(id)}">${esc(citeLabel(kind, value))}</button>`;
    });
    return withCites
      .split(/\n\n+/)
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  function renderArtifacts(graph) {
    $("artifacts").innerHTML = graph.nodes
      .map(
        (node) =>
          `<button type="button" data-artifact="${esc(node.id)}"><strong>${esc(kindLabel(node.type))}</strong> ${esc(node.label)}</button>`,
      )
      .join("");
    $("artifacts").querySelectorAll("[data-artifact]").forEach((button) => {
      button.addEventListener("click", () => selectNode(button.dataset.artifact));
    });
  }

  function drawGraph(graph) {
    const svg = $("graph");
    const width = Math.max(320, svg.clientWidth || 800);
    const height = Math.max(520, svg.clientHeight || 560);
    state.width = width;
    state.height = height;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren();

    const defs = svgEl("defs");
    for (const [type, color] of Object.entries(colors)) {
      const marker = svgEl("marker");
      marker.setAttribute("id", `arrow-${type}`);
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "9");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "7");
      marker.setAttribute("markerHeight", "7");
      marker.setAttribute("orient", "auto-start-reverse");
      const path = svgEl("path");
      path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
      path.setAttribute("fill", color);
      marker.append(path);
      defs.append(marker);
    }

    const viewport = svgEl("g");
    state.viewport = viewport;
    const edgeLayer = svgEl("g");
    const nodeLayer = svgEl("g");
    svg.append(defs, viewport);
    viewport.append(edgeLayer, nodeLayer);
    state.bodies = simulate(graph.nodes, graph.edges, width, height);
    const byId = new Map(state.bodies.map((body) => [body.id, body]));

    for (const edge of graph.edges) {
      if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
      const line = svgEl("line");
      line.setAttribute("class", `edge ${edge.type}`);
      line.dataset.type = edge.type;
      line.dataset.source = edge.source;
      line.dataset.target = edge.target;
      line.setAttribute("marker-end", `url(#arrow-${edge.type})`);
      const title = svgEl("title");
      title.textContent = `${edge.type}: ${edge.evidence || ""}`;
      line.append(title);
      edgeLayer.append(line);
    }

    for (const body of state.bodies) {
      const group = svgEl("g");
      group.setAttribute("class", `node ${body.type}`);
      group.dataset.id = body.id;
      const circle = svgEl("circle");
      circle.setAttribute("r", String(body.r));
      const title = svgEl("title");
      title.textContent = body.full;
      const text = svgEl("text");
      text.setAttribute("y", String(body.r + 14));
      text.textContent = body.short;
      group.append(circle, title, text);
      group.addEventListener("pointerdown", (event) => startDrag(event, body));
      nodeLayer.append(group);
    }

    svg.addEventListener("pointerdown", (event) => {
      if (event.target !== svg) return;
      state.drag = { mode: "pan", x: event.clientX, y: event.clientY, ox: state.view.x, oy: state.view.y };
    });
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("pointerleave", onPointerUp);
    svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.08 : 0.92;
        state.view.k = Math.min(2.5, Math.max(0.45, state.view.k * factor));
        applyView();
      },
      { passive: false },
    );

    applyPositions();
    applyView();
    applyFilters();
  }

  function simulate(nodes, edges, width, height) {
    const bodies = nodes.map((node, index) => {
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
      const orbit = node.type === "focus" ? 0 : Math.min(width, height) * 0.33;
      return {
        id: node.id,
        type: node.type,
        short: shortLabel(node),
        full: node.label,
        r: node.type === "focus" ? 26 : node.type === "discussion" ? 13 : 18,
        x: width / 2 + Math.cos(angle) * orbit,
        y: height / 2 + Math.sin(angle) * orbit * 0.82,
        vx: 0,
        vy: 0,
        pin: node.type === "focus",
      };
    });
    const byId = new Map(bodies.map((body) => [body.id, body]));
    for (let step = 0; step < 280; step += 1) {
      for (let i = 0; i < bodies.length; i += 1) {
        for (let j = i + 1; j < bodies.length; j += 1) {
          const a = bodies[i];
          const b = bodies[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const dist = Math.hypot(dx, dy) || 0.01;
          const min = a.r + b.r + 36;
          const force = 1800 / (dist * dist) + (dist < min ? (min - dist) * 0.08 : 0);
          const ux = dx / dist;
          const uy = dy / dist;
          if (!a.pin) {
            a.vx += ux * force;
            a.vy += uy * force;
          }
          if (!b.pin) {
            b.vx -= ux * force;
            b.vy -= uy * force;
          }
        }
      }
      for (const edge of edges) {
        const a = byId.get(edge.source);
        const b = byId.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const desired = edge.type === "linked" ? 170 : 130;
        const force = (dist - desired) * 0.01;
        const ux = dx / dist;
        const uy = dy / dist;
        if (!a.pin) {
          a.vx += ux * force;
          a.vy += uy * force;
        }
        if (!b.pin) {
          b.vx -= ux * force;
          b.vy -= uy * force;
        }
      }
      for (const body of bodies) {
        if (body.pin) {
          body.x = width / 2;
          body.y = height / 2;
          continue;
        }
        body.vx += (width / 2 - body.x) * 0.004;
        body.vy += (height / 2 - body.y) * 0.004;
        body.vx *= 0.74;
        body.vy *= 0.74;
        body.x = clamp(body.x + body.vx, body.r + 16, width - body.r - 16);
        body.y = clamp(body.y + body.vy, body.r + 24, height - body.r - 28);
      }
    }
    return bodies;
  }

  function applyPositions() {
    const byId = new Map(state.bodies.map((body) => [body.id, body]));
    for (const body of state.bodies) {
      const group = $("graph").querySelector(`[data-id="${cssEscape(body.id)}"]`);
      if (group) group.setAttribute("transform", `translate(${body.x} ${body.y})`);
    }
    $("graph").querySelectorAll(".edge").forEach((line) => {
      const source = byId.get(line.dataset.source);
      const target = byId.get(line.dataset.target);
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      line.setAttribute("x1", String(source.x + ux * (source.r + 2)));
      line.setAttribute("y1", String(source.y + uy * (source.r + 2)));
      line.setAttribute("x2", String(target.x - ux * (target.r + 8)));
      line.setAttribute("y2", String(target.y - uy * (target.r + 8)));
    });
  }

  function applyView() {
    if (!state.viewport) return;
    state.viewport.setAttribute("transform", `translate(${state.view.x} ${state.view.y}) scale(${state.view.k})`);
  }

  function applyFilters() {
    const enabled = new Set(
      [...document.querySelectorAll("[data-edge]:checked")].map((box) => box.dataset.edge),
    );
    $("graph").querySelectorAll(".edge").forEach((line) => {
      line.toggleAttribute("hidden", !enabled.has(line.dataset.type));
    });
  }

  function startDrag(event, body) {
    event.stopPropagation();
    const start = clientToWorld(event);
    state.drag = { mode: "node", id: body.id, dx: start.x - body.x, dy: start.y - body.y, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!state.drag) return;
    if (state.drag.mode === "pan") {
      state.view.x = state.drag.ox + (event.clientX - state.drag.x);
      state.view.y = state.drag.oy + (event.clientY - state.drag.y);
      applyView();
      return;
    }
    const body = state.bodies.find((item) => item.id === state.drag.id);
    if (!body || body.pin) return;
    const point = clientToWorld(event);
    const x = point.x - state.drag.dx;
    const y = point.y - state.drag.dy;
    if (Math.hypot(x - body.x, y - body.y) > 2) state.drag.moved = true;
    body.x = x;
    body.y = y;
    applyPositions();
  }

  function onPointerUp() {
    const drag = state.drag;
    state.drag = null;
    if (drag && drag.mode === "node" && !drag.moved) selectNode(drag.id);
  }

  function clientToWorld(event) {
    const svg = $("graph");
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * state.width;
    const y = ((event.clientY - rect.top) / rect.height) * state.height;
    return {
      x: (x - state.view.x) / state.view.k,
      y: (y - state.view.y) / state.view.k,
    };
  }

  function selectNode(id) {
    if (!id || !state.investigation) return;
    state.selected = id;
    $("graph").querySelectorAll(".node").forEach((node) => node.classList.toggle("is-selected", node.dataset.id === id));
    $("graph").querySelectorAll(".edge").forEach((edge) => {
      edge.classList.toggle("is-hot", edge.dataset.source === id || edge.dataset.target === id);
    });
    $("narrative").querySelectorAll(".cite").forEach((button) => button.classList.toggle("is-on", button.dataset.cite === id));
    $("artifacts").querySelectorAll("[data-artifact]").forEach((button) => {
      button.classList.toggle("is-on", button.dataset.artifact === id);
    });
    const node = state.investigation.graph.nodes.find((item) => item.id === id);
    if (!node) return;
    $("inspector").innerHTML = renderInspector(node);
  }

  function renderInspector(node) {
    const rows = Object.entries(node.data)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => {
        const printed = Array.isArray(value) ? value.join("\n") : String(value);
        return `<dt>${esc(key)}</dt><dd>${esc(printed)}</dd>`;
      })
      .join("");
    const body = typeof node.data.body === "string" && node.data.body.trim() ? `<p>${esc(node.data.body)}</p>` : "";
    return `<p class="kind">${esc(kindLabel(node.type))}</p><h3>${esc(node.label)}</h3>${body}<dl>${rows}</dl>`;
  }

  function setBusy(busy) {
    $("report").setAttribute("aria-busy", busy ? "true" : "false");
    $("demo").disabled = busy;
    $("form").querySelector("button").disabled = busy;
  }

  function setStatus(text) {
    $("status").textContent = text;
  }

  function showError(text) {
    const el = $("error");
    el.hidden = !text;
    el.textContent = text;
  }

  function nodeId(kind, value) {
    if (kind === "commit") return `commit:${value}`;
    if (kind === "pr") return `pr:${value}`;
    if (kind === "issue") return `issue:${value}`;
    return `discussion:${value}`;
  }

  function citeLabel(kind, value) {
    if (kind === "commit") return `commit ${value.slice(0, 7)}`;
    if (kind === "pr") return `PR #${value}`;
    if (kind === "issue") return `issue #${value}`;
    return "discussion";
  }

  function shortLabel(node) {
    if (node.type === "focus") return node.data.symbol || "line";
    if (node.type === "commit") return node.data.shortSha;
    if (node.type === "pull_request" || node.type === "issue") return `#${node.data.number}`;
    return node.data.author || "note";
  }

  function kindLabel(type) {
    if (type === "pull_request") return "pull request";
    if (type === "focus") return "focus";
    return type.replaceAll("_", " ");
  }

  function svgEl(name) {
    return document.createElementNS("http://www.w3.org/2000/svg", name);
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
})();
