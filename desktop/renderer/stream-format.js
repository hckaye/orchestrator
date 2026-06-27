// Format orchestrator worker logs (stream-json / NDJSON) into CLI-like HTML.
// Supports Grok/Cursor token streams, Codex item events, Claude stream-json,
// plus plain supervisor lines.

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const shortPath = (p) => {
  if (!p) return "";
  const s = String(p);
  // collapse worktree noise
  const m = s.match(/\.worktrees\/[^/]+\/(.+)$/);
  if (m) return m[1];
  const home = typeof navigator !== "undefined" ? "" : "";
  return s.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
};

/**
 * @param {string} rawLog
 * @param {{ workerType?: string, live?: boolean, maxBlocks?: number }} [opts]
 * @returns {string} HTML
 */
export function formatStreamLog(rawLog, opts = {}) {
  const live = !!opts.live;
  const maxBlocks = opts.maxBlocks ?? 400;
  if (!rawLog || !String(rawLog).trim()) {
    return `<span class="term-dim">${live ? "waiting for output…" : "(empty log)"}</span>${
      live ? '<span class="term-cursor"></span>' : ""
    }`;
  }

  const lines = String(rawLog).split("\n");
  /** @type {{ kind: string, html: string }[]} */
  const blocks = [];
  let textBuf = "";
  let thoughtBuf = "";
  let lastRawJson = null; // consecutive-line dedupe (stdout+stderr double)
  let lastTextPiece = "";
  let lastThoughtPiece = "";
  let pendingCmd = null; // codex command started

  const flushText = () => {
    if (!textBuf) return;
    const t = collapseDupRuns(textBuf).trimEnd();
    textBuf = "";
    lastTextPiece = "";
    if (!t.trim()) return;
    blocks.push({
      kind: "assistant",
      html: `<div class="sf-block sf-assistant">
        <div class="sf-label">assistant</div>
        <div class="sf-body sf-md">${renderSoftMarkdown(t)}</div>
      </div>`,
    });
  };

  const flushThought = () => {
    if (!thoughtBuf) return;
    const t = collapseDupRuns(thoughtBuf).trimEnd();
    thoughtBuf = "";
    lastThoughtPiece = "";
    if (!t.trim()) return;
    // keep thoughts compact — show last ~2.5k if huge
    const shown = t.length > 2500 ? "…" + t.slice(-2500) : t;
    blocks.push({
      kind: "thinking",
      html: `<div class="sf-block sf-thinking">
        <div class="sf-label">thinking</div>
        <div class="sf-body sf-thought">${esc(shown)}</div>
      </div>`,
    });
  };

  const appendText = (s) => {
    if (!s) return;
    // skip exact echo of previous piece (common double-pipe of stream-json)
    if (s === lastTextPiece) return;
    if (s.length && textBuf.endsWith(s)) return;
    lastTextPiece = s;
    textBuf += s;
  };
  const appendThought = (s) => {
    if (!s) return;
    if (s === lastThoughtPiece) return;
    if (s.length && thoughtBuf.endsWith(s)) return;
    lastThoughtPiece = s;
    thoughtBuf += s;
  };

  const flushStreams = () => {
    flushThought();
    flushText();
  };

  for (const line of lines) {
    // Supervisor / plain timestamp lines
    if (/^\[[\d\-T:.Z]+\]\s/.test(line) || /^=== /.test(line)) {
      flushStreams();
      blocks.push({
        kind: "sys",
        html: `<div class="sf-block sf-sys"><span class="sf-sys-mark">▸</span> ${esc(line)}</div>`,
      });
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // JSON event?
    if (trimmed.startsWith("{") && (trimmed.endsWith("}") || trimmed.includes('{"type"'))) {
      // dedupe exact consecutive JSON lines (double-piped stdout)
      if (trimmed === lastRawJson) continue;
      lastRawJson = trimmed;

      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        lastRawJson = null;
        flushStreams();
        blocks.push({
          kind: "plain",
          html: `<div class="sf-line">${esc(line)}</div>`,
        });
        continue;
      }

      const handled = ingestEvent(ev, {
        flushStreams,
        flushText,
        flushThought,
        appendText,
        appendThought,
        push: (b) => blocks.push(b),
        pendingCmd: {
          get: () => pendingCmd,
          set: (v) => {
            pendingCmd = v;
          },
        },
      });
      if (!handled) {
        // unknown JSON — compact one-liner
        flushStreams();
        const t = ev.type || ev.event || "json";
        blocks.push({
          kind: "json",
          html: `<div class="sf-block sf-json-fallback"><span class="sf-label">${esc(
            String(t)
          )}</span> <span class="sf-dim">${esc(summarizeUnknown(ev))}</span></div>`,
        });
      }
      continue;
    }

    lastRawJson = null;
    // plain text line
    flushStreams();
    // error-looking
    const cls = /\b(error|failed|exception|ActionRequiredError)\b/i.test(line)
      ? "sf-err"
      : "sf-plain";
    blocks.push({
      kind: "plain",
      html: `<div class="sf-line ${cls}">${esc(line)}</div>`,
    });
  }

  flushStreams();
  if (pendingCmd) {
    blocks.push({
      kind: "cmd",
      html: renderCommand({
        command: pendingCmd.command,
        status: "running",
        output: pendingCmd.output || "",
      }),
    });
  }

  const slice = blocks.length > maxBlocks ? blocks.slice(-maxBlocks) : blocks;
  const trunc =
    blocks.length > maxBlocks
      ? `<div class="sf-block sf-sys sf-dim">… ${blocks.length - maxBlocks} earlier blocks omitted …</div>`
      : "";

  return (
    trunc +
    slice.map((b) => b.html).join("") +
    (live ? '<span class="term-cursor"></span>' : "")
  );
}

function collapseDupRuns(s) {
  if (!s) return s;
  let t = s;
  // Exact doubled body (whole stream written twice back-to-back)
  for (let guard = 0; guard < 3; guard++) {
    if (t.length < 8) break;
    const half = Math.floor(t.length / 2);
    if (t.slice(0, half) === t.slice(half)) {
      t = t.slice(0, half);
      continue;
    }
    let collapsed = false;
    for (const d of [-2, -1, 1, 2]) {
      const h = half + d;
      if (h > 4 && h < t.length && t.slice(0, h) === t.slice(h, h * 2) && h * 2 >= t.length - 2) {
        t = t.slice(0, h);
        collapsed = true;
        break;
      }
    }
    if (!collapsed) break;
  }
  // Adjacent phrase echoes from dual-piped stream-json:
  // "The user wantsThe user wants…" / "worktree worktree" / "指摘レビュー指摘"
  for (let i = 0; i < 12; i++) {
    const n = t.replace(/([\s\S]{3,100}?)\1/g, "$1");
    if (n === t) break;
    t = n;
  }
  // consecutive identical lines
  const lines = t.split("\n");
  const outLines = [];
  for (const line of lines) {
    if (outLines.length && outLines[outLines.length - 1] === line && line.length < 240) continue;
    outLines.push(line);
  }
  t = outLines.join("\n");
  // consecutive identical whitespace-delimited tokens
  const parts = t.split(/(\s+)/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] && parts[i] === parts[i + 1] && !/^\s+$/.test(parts[i])) {
      out.push(parts[i]);
      i++;
      continue;
    }
    out.push(parts[i]);
  }
  return out.join("");
}

/**
 * @returns {boolean} handled
 */
function ingestEvent(ev, ctx) {
  const type = ev.type || ev.event || "";

  // —— Grok / Cursor / generic token stream ——
  if (type === "text" || type === "assistant_delta" || type === "content_block_delta") {
    ctx.flushThought();
    const piece =
      ev.data ??
      ev.text ??
      ev.delta?.text ??
      ev.delta?.data ??
      (typeof ev.content === "string" ? ev.content : "") ??
      "";
    if (piece) ctx.appendText(String(piece));
    return true;
  }
  if (type === "thought" || type === "thinking" || type === "reasoning") {
    ctx.flushText();
    const piece = ev.data ?? ev.text ?? ev.delta?.text ?? "";
    if (piece) ctx.appendThought(String(piece));
    return true;
  }
  if (type === "end" || type === "result" || type === "turn.completed") {
    ctx.flushStreams();
    ctx.push({ kind: "end", html: renderEnd(ev) });
    return true;
  }
  if (type === "system") {
    ctx.flushStreams();
    ctx.push({ kind: "sys", html: renderSystem(ev) });
    return true;
  }
  if (type === "user") {
    ctx.flushStreams();
    ctx.push({ kind: "user", html: renderUser(ev) });
    return true;
  }
  if (type === "assistant") {
    ctx.flushStreams();
    ctx.push({ kind: "assistant", html: renderClaudeAssistant(ev) });
    return true;
  }
  if (type === "rate_limit_event") {
    ctx.flushStreams();
    const info = ev.rate_limit_info || {};
    ctx.push({
      kind: "err",
      html: `<div class="sf-block sf-err-block">
        <div class="sf-label">rate limit</div>
        <div class="sf-body">${esc(info.rateLimitType || "limit")} · ${esc(
        info.status || ""
      )} ${info.resetsAt ? "· resets " + esc(String(info.resetsAt)) : ""}</div>
      </div>`,
    });
    return true;
  }

  // —— Codex thread / turn ——
  if (type === "thread.started") {
    ctx.flushStreams();
    ctx.push({
      kind: "sys",
      html: `<div class="sf-block sf-sys"><span class="sf-sys-mark">◎</span> thread <span class="sf-mono">${esc(
        ev.thread_id || ""
      )}</span></div>`,
    });
    return true;
  }
  if (type === "turn.started") {
    ctx.flushStreams();
    ctx.push({
      kind: "sys",
      html: `<div class="sf-block sf-sys sf-dim"><span class="sf-sys-mark">↳</span> turn started</div>`,
    });
    return true;
  }

  // —— Codex items ——
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = ev.item || {};
    const it = item.type || "";
    if (it === "command_execution") {
      if (type === "item.started") {
        ctx.flushStreams();
        ctx.pendingCmd.set({ command: item.command, output: item.aggregated_output || "" });
        return true;
      }
      if (type === "item.completed") {
        ctx.flushStreams();
        ctx.pendingCmd.set(null);
        ctx.push({
          kind: "cmd",
          html: renderCommand({
            command: item.command,
            status: item.status || "completed",
            exitCode: item.exit_code,
            output: item.aggregated_output || "",
          }),
        });
        return true;
      }
      // updated — refresh pending output silently by storing
      if (ctx.pendingCmd.get()) {
        ctx.pendingCmd.set({
          command: item.command || ctx.pendingCmd.get().command,
          output: item.aggregated_output || ctx.pendingCmd.get().output,
        });
      }
      return true;
    }
    if (it === "file_change") {
      if (type === "item.started") return true; // wait for completed
      ctx.flushStreams();
      ctx.push({ kind: "files", html: renderFileChanges(item) });
      return true;
    }
    if (it === "agent_message") {
      if (type !== "item.completed" && type !== "item.updated") return true;
      ctx.flushStreams();
      const text = item.text || "";
      if (text.trim()) {
        ctx.push({
          kind: "assistant",
          html: `<div class="sf-block sf-assistant">
            <div class="sf-label">assistant</div>
            <div class="sf-body sf-md">${renderSoftMarkdown(text)}</div>
          </div>`,
        });
      }
      return true;
    }
    if (it === "todo_list") {
      ctx.flushStreams();
      ctx.push({ kind: "todo", html: renderTodo(item) });
      return true;
    }
    // other items
    if (type === "item.completed") {
      ctx.flushStreams();
      ctx.push({
        kind: "item",
        html: `<div class="sf-block sf-json-fallback"><span class="sf-label">${esc(
          it || "item"
        )}</span> <span class="sf-dim">${esc(item.status || "done")}</span></div>`,
      });
      return true;
    }
    return true;
  }

  // Claude-style stream events
  if (type === "stream_event" || type === "content_block_start" || type === "content_block_stop") {
    return true; // ignore noise
  }
  if (type === "tool_use" || type === "tool_call") {
    ctx.flushStreams();
    ctx.push({ kind: "tool", html: renderToolUse(ev) });
    return true;
  }
  if (type === "tool_result") {
    ctx.flushStreams();
    ctx.push({ kind: "tool", html: renderToolResult(ev) });
    return true;
  }

  return false;
}

function renderCommand({ command, status, exitCode, output }) {
  const cmd = prettyShell(command || "");
  const ok = exitCode === 0 || status === "completed";
  const running = status === "running" || status === "in_progress";
  const codeLabel =
    exitCode == null ? (running ? "running" : status || "") : `exit ${exitCode}`;
  const out = String(output || "");
  const outLines = out.split("\n");
  const trimmed =
    outLines.length > 40
      ? outLines.slice(0, 8).join("\n") +
        `\n… (${outLines.length - 16} lines) …\n` +
        outLines.slice(-8).join("\n")
      : out;
  return `<div class="sf-block sf-cmd ${running ? "sf-running" : ok ? "sf-ok" : "sf-fail"}">
    <div class="sf-cmd-head">
      <span class="sf-cmd-prompt">$</span>
      <span class="sf-cmd-text">${esc(cmd)}</span>
      <span class="sf-cmd-status">${esc(codeLabel)}</span>
    </div>
    ${
      trimmed.trim()
        ? `<pre class="sf-cmd-out">${esc(trimmed.replace(/\n$/, ""))}</pre>`
        : ""
    }
  </div>`;
}

function prettyShell(cmd) {
  // unwrap /bin/zsh -lc '...'
  const m = cmd.match(/^\/bin\/(?:z|ba)?sh\s+-lc\s+['"]([\s\S]*)['"]\s*$/);
  if (m) return m[1];
  const m2 = cmd.match(/^\/bin\/(?:z|ba)?sh\s+-lc\s+(.*)$/);
  if (m2) {
    let inner = m2[1];
    if (
      (inner.startsWith("'") && inner.endsWith("'")) ||
      (inner.startsWith('"') && inner.endsWith('"'))
    ) {
      inner = inner.slice(1, -1);
    }
    return inner;
  }
  return cmd;
}

function renderFileChanges(item) {
  const changes = item.changes || item.files || [];
  const rows = changes
    .map((c) => {
      const kind = c.kind || c.type || c.action || "update";
      const path = shortPath(c.path || c.filename || c.file || "");
      const mark =
        kind === "create" || kind === "add"
          ? "+"
          : kind === "delete" || kind === "remove"
            ? "−"
            : "✎";
      return `<div class="sf-file-row"><span class="sf-file-mark">${mark}</span> <span class="sf-file-kind">${esc(
        kind
      )}</span> <span class="sf-mono">${esc(path)}</span></div>`;
    })
    .join("");
  return `<div class="sf-block sf-files">
    <div class="sf-label">files ${esc(item.status || "")}</div>
    ${rows || '<div class="sf-dim">(no paths)</div>'}
  </div>`;
}

function renderTodo(item) {
  const items = item.items || item.todos || [];
  const rows = items
    .map((t) => {
      const done = !!(t.completed || t.status === "completed" || t.status === "done");
      const text = t.text || t.content || t.title || "";
      return `<div class="sf-todo-row ${done ? "done" : ""}"><span class="sf-todo-box">${
        done ? "✓" : "○"
      }</span> ${esc(text)}</div>`;
    })
    .join("");
  return `<div class="sf-block sf-todo">
    <div class="sf-label">todos</div>
    ${rows}
  </div>`;
}

function renderEnd(ev) {
  const usage = ev.usage || {};
  const cost =
    ev.total_cost_usd != null
      ? `$${Number(ev.total_cost_usd).toFixed(3)}`
      : usage.total_cost_usd != null
        ? `$${Number(usage.total_cost_usd).toFixed(3)}`
        : null;
  const turns = ev.num_turns != null ? `${ev.num_turns} turns` : null;
  const reason = ev.stopReason || ev.stop_reason || ev.subtype || "";
  const err = ev.is_error || ev.error;
  const resultText =
    typeof ev.result === "string" ? ev.result : ev.result?.message || "";
  const bits = [reason, turns, cost].filter(Boolean).join(" · ");
  const inTok = usage.input_tokens ?? usage.inputTokens;
  const outTok = usage.output_tokens ?? usage.outputTokens;
  const tok =
    inTok != null || outTok != null
      ? `tokens in ${fmtNum(inTok)} / out ${fmtNum(outTok)}`
      : "";
  return `<div class="sf-block sf-end ${err ? "sf-fail" : "sf-ok"}">
    <div class="sf-end-line">── ${esc(err ? "failed" : "done")}${
    bits ? " · " + esc(bits) : ""
  }${tok ? " · " + esc(tok) : ""} ──</div>
    ${resultText ? `<div class="sf-body">${esc(resultText)}</div>` : ""}
  </div>`;
}

function renderSystem(ev) {
  const sub = ev.subtype || "";
  if (sub === "init") {
    return `<div class="sf-block sf-sys">
      <span class="sf-sys-mark">◎</span>
      session <span class="sf-mono">${esc(ev.session_id || "")}</span>
      · model <span class="sf-accent">${esc(ev.model || "")}</span>
      ${ev.cwd ? `· <span class="sf-dim">${esc(shortPath(ev.cwd))}</span>` : ""}
    </div>`;
  }
  if (sub === "hook_started" || sub === "hook_response") {
    return `<div class="sf-block sf-sys sf-dim"><span class="sf-sys-mark">hook</span> ${esc(
      ev.hook_name || ev.hook_event || sub
    )}</div>`;
  }
  return `<div class="sf-block sf-sys"><span class="sf-sys-mark">▸</span> system ${esc(
    sub || ""
  )} ${esc(summarizeUnknown(ev))}</div>`;
}

function renderUser(ev) {
  const msg = ev.message || {};
  const content = msg.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    // tool results etc.
    const parts = content.map((c) => {
      if (typeof c === "string") return c;
      if (c.type === "text") return c.text || "";
      if (c.type === "tool_result") {
        const body =
          typeof c.content === "string"
            ? c.content
            : Array.isArray(c.content)
              ? c.content.map((x) => x.text || "").join("")
              : JSON.stringify(c.content ?? "").slice(0, 500);
        return `⟵ tool_result${c.is_error ? " (error)" : ""}\n${body}`;
      }
      return JSON.stringify(c).slice(0, 300);
    });
    text = parts.join("\n");
  } else if (content && typeof content === "object") {
    text = JSON.stringify(content).slice(0, 800);
  }
  // Don't dump huge handoff prompts in full
  const shown = text.length > 1200 ? text.slice(0, 1200) + "\n…" : text;
  return `<div class="sf-block sf-user">
    <div class="sf-label">user</div>
    <div class="sf-body">${esc(shown)}</div>
  </div>`;
}

function renderClaudeAssistant(ev) {
  const msg = ev.message || {};
  const content = msg.content;
  const chunks = [];
  if (typeof content === "string") {
    chunks.push(
      `<div class="sf-body sf-md">${renderSoftMarkdown(content)}</div>`
    );
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === "text") {
        chunks.push(
          `<div class="sf-body sf-md">${renderSoftMarkdown(c.text || "")}</div>`
        );
      } else if (c.type === "tool_use") {
        chunks.push(renderToolUse(c));
      } else if (c.type === "thinking") {
        chunks.push(
          `<div class="sf-body sf-thought">${esc(c.thinking || c.text || "")}</div>`
        );
      }
    }
  }
  if (ev.error || ev.is_api_error_message) {
    chunks.push(
      `<div class="sf-body sf-err">${esc(ev.error || msg.stop_reason || "api error")}</div>`
    );
  }
  if (!chunks.length) {
    chunks.push(`<div class="sf-dim">${esc(summarizeUnknown(ev))}</div>`);
  }
  return `<div class="sf-block sf-assistant">
    <div class="sf-label">assistant${msg.model ? " · " + esc(msg.model) : ""}</div>
    ${chunks.join("")}
  </div>`;
}

function renderToolUse(ev) {
  const name = ev.name || ev.tool || ev.tool_name || "tool";
  const input = ev.input || ev.arguments || ev.params || {};
  let detail = "";
  if (typeof input === "string") detail = input;
  else if (input.command) detail = input.command;
  else if (input.file_path || input.path) detail = input.file_path || input.path;
  else if (input.pattern) detail = `/${input.pattern}/`;
  else detail = JSON.stringify(input).slice(0, 400);
  return `<div class="sf-block sf-tool">
    <div class="sf-cmd-head">
      <span class="sf-tool-mark">⚙</span>
      <span class="sf-cmd-text">${esc(name)}</span>
    </div>
    <div class="sf-tool-detail sf-mono">${esc(detail)}</div>
  </div>`;
}

function renderToolResult(ev) {
  const body =
    typeof ev.content === "string"
      ? ev.content
      : typeof ev.output === "string"
        ? ev.output
        : JSON.stringify(ev.content ?? ev.output ?? "").slice(0, 800);
  const shown = body.length > 1000 ? body.slice(0, 1000) + "\n…" : body;
  return `<div class="sf-block sf-tool-result ${ev.is_error ? "sf-fail" : ""}">
    <div class="sf-label">tool result</div>
    <pre class="sf-cmd-out">${esc(shown)}</pre>
  </div>`;
}

function renderSoftMarkdown(text) {
  // Escape first, then apply light decorations for code fences / inline code / headers
  let t = esc(text);
  // fenced code
  t = t.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="sf-code"><span class="sf-code-lang">${esc(
      lang || ""
    )}</span>${code}</pre>`;
  });
  // inline code
  t = t.replace(/`([^`\n]+)`/g, '<code class="sf-inline">$1</code>');
  // bold
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // headings at line start
  t = t.replace(/(^|\n)(#{1,3})\s+(.+)/g, (_, br, h, rest) => {
    return `${br}<div class="sf-h sf-h${h.length}">${rest}</div>`;
  });
  // newlines → br for non-pre content — use white-space: pre-wrap in CSS instead
  return t;
}

function summarizeUnknown(ev) {
  try {
    const s = JSON.stringify(ev);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch {
    return "";
  }
}

function fmtNum(n) {
  if (n == null) return "—";
  const x = Number(n);
  if (x >= 1e6) return (x / 1e6).toFixed(1) + "M";
  if (x >= 1e3) return (x / 1e3).toFixed(1) + "k";
  return String(x);
}
