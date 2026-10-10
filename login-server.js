// Local Kufar SMS login page (similar to the OAuth login flow in other MCP servers).
// The phone number and code are entered in the browser and sent straight to the Kufar API — they never reach the Claude chat.
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as kufar from "./kufar-api.js";

const LIFETIME_MS = 10 * 60 * 1000;
let current = null; // { url, server, timer, origin }

export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

function stop() {
  if (!current) return;
  clearTimeout(current.timer);
  current.server.close();
  current = null;
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function describeError(e) {
  let msg = e.message;
  if (e.body && typeof e.body === "object") {
    const detail = e.body.message ?? e.body.error ?? e.body.detail;
    if (detail) msg += `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  }
  return msg;
}

// Starts the login page (or reuses one already running). Returns its URL.
export async function startLogin() {
  if (current) return current.url;

  const secret = crypto.randomBytes(16).toString("hex");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const [, key, ...rest] = url.pathname.split("/");
    const action = rest.join("/");
    if (key !== secret) return sendJson(res, 404, { error: "not found" });

    if (req.method === "GET" && !action) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(PAGE);
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

    // Accept requests only from the login page itself
    const origin = req.headers.origin;
    if (origin && origin !== current?.origin) return sendJson(res, 403, { error: "forbidden" });

    try {
      const body = await readBody(req);
      if (action === "request") {
        const codeToken = await kufar.requestSmsCode(String(body.phone ?? ""));
        return sendJson(res, 200, { ok: true, code_token: codeToken });
      }
      if (action === "verify") {
        await kufar.verifySmsCode(String(body.code_token), String(body.code ?? "").trim(), String(body.phone ?? ""));
        sendJson(res, 200, { ok: true });
        setTimeout(stop, 1500); // logged in — the page is no longer needed
        return;
      }
      sendJson(res, 404, { error: "unknown action" });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: describeError(e) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/${secret}`;
  current = { url, server, origin, timer: setTimeout(stop, LIFETIME_MS) };
  return url;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in to Kufar — kufar-mcp</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --text:#1f2329; --muted:#6b7280; --line:#e3e5e8; --accent:#2b7a4b; --accent-text:#fff; --err:#c0392b; --ok:#2b7a4b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --card:#1f2228; --text:#e8eaed; --muted:#9aa0a6; --line:#33373e; --accent:#3fa56a; --err:#ef6b5b; --ok:#3fa56a; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text); font:15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .card { width:100%; max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px 24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 20px; }
  label { display:block; font-size:13px; color:var(--muted); margin:12px 0 4px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:transparent; }
  .primary { width:100%; margin-top:18px; padding:11px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-text); font:inherit; font-weight:600; cursor:pointer; }
  .primary:disabled { opacity:.6; cursor:default; }
  .link { background:none; border:0; padding:0; margin-top:12px; color:var(--muted); font:inherit; font-size:13px; text-decoration:underline; cursor:pointer; }
  .msg { margin-top:14px; font-size:14px; min-height:1em; }
  .msg.err { color:var(--err); } .msg.ok { color:var(--ok); }
  .done { text-align:center; padding:20px 0; }
  .done .big { font-size:40px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main class="card">
  <form id="form">
    <h1>Log in to Kufar</h1>
    <p class="sub">Your phone number and code go straight to Kufar and are stored only on this computer. Claude never sees them.</p>
    <label for="phone">Phone number</label>
    <input id="phone" name="phone" type="tel" placeholder="+375 29 123-45-67" autocomplete="tel" required>
    <div id="codeBox" hidden>
      <label for="code">SMS code</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code">
    </div>
    <button class="primary" id="btn">Get code</button>
    <button type="button" class="link" id="again" hidden>Change number or resend code</button>
    <div class="msg" id="msg" role="status"></div>
  </form>

  <section id="done" class="done" hidden>
    <div class="big">✓</div>
    <h1>Logged in</h1>
    <p class="sub">You can close this tab and return to Claude.</p>
  </section>
</main>
<script>
  const base = location.pathname.replace(/\\/$/, "");
  const form = document.getElementById("form");
  const btn = document.getElementById("btn");
  const again = document.getElementById("again");
  const codeBox = document.getElementById("codeBox");
  const msg = document.getElementById("msg");
  const say = (text, kind) => { msg.textContent = text; msg.className = "msg " + (kind || ""); };
  let codeToken = null;

  async function post(action, data) {
    const res = await fetch(base + "/" + action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    if (!res.ok) throw new Error("This login page has expired — ask Claude to open it again.");
    return res.json();
  }

  function reset() {
    codeToken = null;
    codeBox.hidden = true; again.hidden = true;
    form.code.required = false; form.code.value = "";
    form.phone.readOnly = false; form.phone.focus();
    btn.textContent = "Get code";
    say("");
  }
  again.addEventListener("click", reset);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true; say("Please wait…");
    try {
      if (!codeToken) {
        const r = await post("request", { phone: form.phone.value });
        if (!r.ok) return say(r.error, "err");
        codeToken = r.code_token;
        codeBox.hidden = false; again.hidden = false;
        form.phone.readOnly = true;
        form.code.required = true; form.code.focus();
        btn.textContent = "Log in";
        say("Code sent.", "ok");
      } else {
        const r = await post("verify", { code_token: codeToken, code: form.code.value, phone: form.phone.value });
        if (!r.ok) return say(r.error, "err");
        form.hidden = true;
        document.getElementById("done").hidden = false;
      }
    } catch (err) {
      say(err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
