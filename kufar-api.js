// Client for the unofficial Kufar API.
// There is no documentation: endpoints come from open-source projects (the `kufar` Python package, 2023;
// PHP dionchaika/kufar-api, 2019) and may go stale. If something stops working,
// inspect the current request in DevTools (Network) and update ENDPOINTS below.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

// Keep user data outside the package folder: when installed via npx it lives in the npm cache
export const DATA_DIR = process.env.KUFAR_MCP_HOME || path.join(os.homedir(), ".kufar-mcp");
const SESSION_FILE = path.join(DATA_DIR, "session.json");

export const ENDPOINTS = {
  // SMS login: GET ?phone= → code_token, then POST { phone, code_token, code } → jwt (phone is required — verified)
  phoneCode: "https://cre-auth.kufar.by/v2/auth/phone/code",
  // The URLs below come from the kufar.by site config and JS (the /ain/create page), October 2026
  categories: "https://api.kufar.by/category-tree/v1/category_tree",
  // Ad search — used to determine the category ID when the category tree is unavailable
  search: [
    "https://cre-api.kufar.by/ads-search/v1/engine/v1/search/rendered-paginated",
    "https://api.kufar.by/search-api/v2/search/rendered-paginated",
    "https://api.kufar.by/search-api/v1/search/rendered-paginated",
  ],
  // Photos: multipart with a `file` field → { id, path }
  imageUpload: "https://ads-image-uploader.kufar.by/v1/images",
  // Ad creation: { ad: {...} }; form errors return 422 with a list of fields
  adInsert: "https://api.kufar.by/insertion/v1/processing/insert",
  // Ad form metadata: which fields a category requires
  adMeta: "https://api.kufar.by/insertion/v1/meta/bootstrap",
};

const ALLOWED_HOST = /(^|\.)kufar\.by$/;

// ---------- session ----------

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function loadSession() {
  return readJson(SESSION_FILE);
}

async function saveSession(data) {
  const prev = (await loadSession()) ?? {};
  const next = { ...prev, ...data, saved_at: new Date().toISOString() };
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(SESSION_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export async function clearSession() {
  const prev = (await loadSession()) ?? {};
  // Keep device_id so Kufar keeps seeing the same "device"
  await fs.writeFile(SESSION_FILE, JSON.stringify({ device_id: prev.device_id }, null, 2), { mode: 0o600 });
}

async function deviceId() {
  const s = await loadSession();
  if (s?.device_id) return s.device_id;
  const id = crypto.randomUUID();
  await saveSession({ device_id: id });
  return id;
}

// JWT payload without signature verification — only to show who is logged in and until when
export function decodeJwt(jwt) {
  try {
    const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// ---------- HTTP ----------

async function baseHeaders() {
  return {
    "user-agent": "Kufar/v3.0.1/13/Xiaomi/Mi 9T Pro",
    "x-app-name": "Android Kufar",
    "x-app-version": "v3.0.1",
    "x-device-id": await deviceId(),
    accept: "application/json",
  };
}

// Login required: MCP tools catch this error and open the login page themselves
export class NeedLoginError extends Error {}

async function authHeaders() {
  const s = await loadSession();
  if (!s?.jwt) throw new NeedLoginError("Not logged in to Kufar.");
  const h = { authorization: `Bearer ${s.jwt}` };
  if (s.session_id) h["session-id"] = String(s.session_id);
  return h;
}

export class KufarError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

// Generic request: on error returns the status and full response body — they show what changed
export async function request(url, { method = "GET", json, form, headers = {}, auth = false } = {}) {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOST.test(host)) throw new Error(`Only kufar.by domains are allowed, got: ${host}`);

  const h = { ...(await baseHeaders()), ...(auth ? await authHeaders() : {}), ...headers };
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json; charset=UTF-8";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }

  let res;
  try {
    res = await fetch(url, { method, headers: h, body });
  } catch (e) {
    const cause = e.cause?.code ?? e.cause?.message ?? e.message;
    throw new KufarError(
      `Could not connect to ${host}: ${cause}. If you are outside Belarus or using a VPN, Kufar may drop the connection.`,
      { url }
    );
  }
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}

  if (res.status === 401 && auth) throw new NeedLoginError("Kufar session expired.");
  if (!res.ok) {
    const hint =
      // Kufar's geo-block page text ("Access restricted")
      res.status === 403 && typeof data === "string" && data.includes("Доступ ограничен")
        ? " (Kufar blocks IPs outside Belarus)"
        : res.status === 401
          ? " (session is invalid — log in again)"
          : "";
    throw new KufarError(`HTTP ${res.status} ${method} ${url}${hint}`, { status: res.status, body: data, url });
  }
  return data;
}

// ---------- API ----------

function saveLoginResponse(data, loginName) {
  const jwt = data?.jwt ?? data?.token;
  if (!jwt) throw new KufarError("No jwt in the response — the response format has changed", { body: data });
  return saveSession({ jwt, session_id: data["session-id"] ?? data.session_id ?? null, login: loginName });
}

// Normalize a Belarusian phone number to 375XXXXXXXXX
export function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("375")) return digits;
  if (digits.startsWith("80")) return `375${digits.slice(2)}`;
  return digits.length === 9 ? `375${digits}` : digits;
}

export async function requestSmsCode(phone) {
  const url = `${ENDPOINTS.phoneCode}?phone=${encodeURIComponent(normalizePhone(phone))}`;
  const data = await request(url);
  if (!data?.code_token) throw new KufarError("No code_token in the response — the response format has changed", { body: data });
  return data.code_token;
}

export async function verifySmsCode(codeToken, code, phone) {
  const normalized = normalizePhone(phone);
  const data = await request(ENDPOINTS.phoneCode, {
    method: "POST",
    json: { phone: normalized, code_token: codeToken, code },
  });
  return saveLoginResponse(data, normalized);
}

export async function getCategories() {
  return request(ENDPOINTS.categories, { headers: { "accept-language": "ru" } });
}

// Tries the search URLs in turn; returns a list of ads
export async function searchAds(query, size = 50) {
  let lastError;
  for (const base of ENDPOINTS.search) {
    try {
      const url = `${base}?query=${encodeURIComponent(query)}&size=${size}&lang=ru`;
      const data = await request(url);
      if (Array.isArray(data?.ads)) return data.ads;
      lastError = new KufarError(`Unexpected search response: ${base}`, { body: data });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// Headers matching the site's ad form
async function insertionHeaders(application = "ad_insertion") {
  const envId = await deviceId();
  return {
    "x-segmentation": `routing=web_ad_insertion;application=${application};platform=web;taxonomy-version=2`,
    "x-pulse-environment-id": envId,
    "x-rudder-anonymous-id": envId,
  };
}

// Returns { id, path }; the ad uses path (or id if there is no path)
export async function uploadImage(file) {
  const buf = await fs.readFile(file);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/jpeg" }), path.basename(file));
  const data = await request(ENDPOINTS.imageUpload, { method: "POST", form, auth: true });
  if (!data?.id && !data?.path) throw new KufarError("Could not parse the photo upload response", { body: data });
  return { id: data.id, path: data.path };
}

// Ad form fields for a category (ad_metadata from meta/bootstrap)
export async function getAdMeta(category, parent) {
  const qs = new URLSearchParams({
    application: parent ? "ad_insertion" : "ad_insertion_base",
    platform: "web",
    routing: "web_ad_insertion",
    company_ad: "0",
    "taxonomy-version": "2",
  });
  if (parent) qs.set("parent", String(parent));
  if (category) qs.set("category", String(category));
  return request(`${ENDPOINTS.adMeta}?${qs}`, {
    auth: true,
    headers: await insertionHeaders(parent ? "ad_insertion" : "ad_insertion_base"),
  });
}

export async function insertAd(ad) {
  return request(ENDPOINTS.adInsert, {
    method: "POST",
    json: { ad: { ...ad, environment_id: await deviceId() } },
    auth: true,
    headers: await insertionHeaders(),
  });
}

// ---------- ad form fields ----------

// Rule condition: an exact value or "$in[1,2,3]"
function ruleMatches(rule, values) {
  return Object.entries(rule).every(([key, cond]) => {
    let v = values[key];
    if (v === undefined || v === null) return false;
    if (typeof v === "boolean") v = v ? "1" : "0";
    const m = /^\$in\[(.*)\]$/.exec(String(cond));
    if (m) return m[1].split(",").map((x) => x.trim()).includes(String(v));
    return String(v) === String(cond);
  });
}

// Active form fields for the given values (rules depend on category, region, etc.)
export function activeFields(adMeta, values) {
  const params = adMeta?.ad_metadata?.parameters;
  if (!params?.refs || !params?.rules) throw new KufarError("Unexpected ad form metadata format", { body: adMeta });
  const byName = new Map();
  for (const r of params.rules) {
    if (!ruleMatches(r.rule ?? {}, values)) continue;
    for (const ref of r.refs) {
      const f = params.refs[ref];
      if (!f) continue;
      // One name can appear in several rules (area for different regions) — take the more specific one
      const prev = byName.get(f.name);
      if (!prev || Object.keys(r.rule ?? {}).length > prev.specificity) {
        byName.set(f.name, { ...f, specificity: Object.keys(r.rule ?? {}).length });
      }
    }
  }
  return [...byName.values()];
}

export async function findParentCategory(category) {
  const tree = await getCategories();
  for (const c of tree?.categories ?? []) {
    for (const sub of c.subcategories ?? []) {
      if (String(sub.id) === String(category)) return { parent: c.id, parentName: c.name_ru ?? c.name, name: sub.name_ru ?? sub.name };
    }
  }
  return null;
}
