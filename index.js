#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as kufar from "./kufar-api.js";
import { startLogin, openInBrowser } from "./login-server.js";

const DRAFTS_DIR = path.join(kufar.DATA_DIR, "drafts");
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff"]);

// ---------- helpers ----------

const expandHome = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

// Accepts files and/or folders, returns a list of images
async function collectImages(inputs) {
  const result = [];
  for (const raw of inputs) {
    const p = path.resolve(expandHome(raw));
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      const entries = (await fs.readdir(p)).sort();
      for (const name of entries) {
        if (IMAGE_EXT.has(path.extname(name).toLowerCase())) result.push(path.join(p, name));
      }
    } else {
      result.push(p);
    }
  }
  return result;
}

function slugify(text) {
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
    і: "i", ў: "u",
  };
  return text
    .toLowerCase()
    .split("")
    .map((c) => map[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "ad";
}

// Auto white balance using the "gray world" method: equalize the channel means
async function grayWorldCoefficients(buffer) {
  const { channels } = await sharp(buffer).stats();
  const [r, g, b] = channels.slice(0, 3).map((c) => c.mean);
  const avg = (r + g + b) / 3;
  const clamp = (v) => Math.min(1.25, Math.max(0.8, v));
  return [clamp(avg / r), clamp(avg / g), clamp(avg / b)];
}

const enhanceOptions = {
  brightness: z.number().min(0.5).max(1.8).default(1.05).describe("Brightness, 1 = unchanged"),
  contrast: z.number().min(0.5).max(1.8).default(1.08).describe("Contrast, 1 = unchanged"),
  saturation: z.number().min(0).max(2).default(1.1).describe("Saturation, 1 = unchanged"),
  white_balance: z.boolean().default(true).describe("Automatic white balance"),
  sharpen: z.boolean().default(true).describe("Light sharpening"),
  max_size: z.number().int().min(400).max(4000).default(1920).describe("Maximum side length in pixels"),
  square: z.boolean().default(false).describe("Center-crop to a square"),
  quality: z.number().int().min(50).max(100).default(85).describe("JPEG quality"),
};

async function enhanceOne(input, output, o) {
  // .rotate() with no arguments orients the photo by EXIF (phone photos)
  let base = await sharp(input).rotate().toColourspace("srgb").removeAlpha().toBuffer();

  let img = sharp(base);
  if (o.square) {
    const { width, height } = await sharp(base).metadata();
    const side = Math.min(width, height);
    img = img.extract({
      left: Math.floor((width - side) / 2),
      top: Math.floor((height - side) / 2),
      width: side,
      height: side,
    });
  }
  img = img.resize(o.max_size, o.max_size, { fit: "inside", withoutEnlargement: true });

  // White balance and contrast in a single .linear(): a second call in sharp overrides the first
  const resized = await img.toBuffer();
  const k = o.white_balance ? await grayWorldCoefficients(resized) : [1, 1, 1];
  const offset = 128 * (1 - o.contrast);
  img = sharp(resized)
    .linear(k.map((c) => c * o.contrast), [offset, offset, offset])
    .modulate({ brightness: o.brightness, saturation: o.saturation });

  if (o.sharpen) img = img.sharpen({ sigma: 0.8 });

  await img.jpeg({ quality: o.quality, mozjpeg: true }).withMetadata({ exif: {} }).toFile(output);
  return output;
}

async function enhanceMany(files, outDir, o) {
  await fs.mkdir(outDir, { recursive: true });
  const done = [];
  const errors = [];
  let i = 1;
  for (const file of files) {
    const name = `${String(i++).padStart(2, "0")}_${path.parse(file).name}.jpg`;
    try {
      done.push(await enhanceOne(file, path.join(outDir, name), o));
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }
  return { done, errors };
}

const text = (s) => ({ content: [{ type: "text", text: s }] });

// ---------- server ----------

const server = new McpServer(
  { name: "kufar", version: "1.0.0" },
  {
    instructions:
      "Assistant for ads on Kufar (kufar.by). Rules:\n" +
      "- Call the tools yourself; never ask the user to \"call kufar_login\" or any other tool.\n" +
      "- If a Kufar login is needed (or a tool reports you are not logged in), call kufar_login yourself: " +
      "it opens the login page in the browser. Tell the user to log in there, and after they reply, check kufar_status.\n" +
      "- Login is only via SMS on the kufar_login page. Never ask the user to send the SMS code in the chat.\n" +
      "- Do not ask the user for the category ID — find it with kufar_categories.\n" +
      "- Publishing order: create_draft → kufar_categories → kufar_category_fields (value codes) → " +
      "publish_ad with dry_run=true → show the result to the user → publish_ad with dry_run=false.\n" +
      "- Pick field codes (condition, brand, district, etc.) yourself from the item description; ask only for what you don't know (name, email).\n" +
      "- Write the ad title and description in Russian — Kufar is a Belarusian marketplace.\n" +
      "- Before publish_ad with dry_run=false, show the final ad and get explicit consent.",
  }
);

server.registerTool(
  "enhance_photos",
  {
    title: "Enhance photos",
    description:
      "Processes photos for an ad: EXIF rotation, white balance, brightness, contrast, " +
      "saturation, sharpening, downscaling. Originals are not modified.",
    inputSchema: {
      inputs: z.array(z.string()).min(1).describe("Paths to photos or photo folders"),
      output_dir: z.string().optional().describe("Output folder. Defaults to an 'enhanced' folder next to the first photo"),
      ...enhanceOptions,
    },
  },
  async ({ inputs, output_dir, ...o }) => {
    const files = await collectImages(inputs);
    if (!files.length) return text("No photos found.");
    const outDir = output_dir
      ? path.resolve(expandHome(output_dir))
      : path.join(path.dirname(files[0]), "enhanced");
    const { done, errors } = await enhanceMany(files, outDir, o);
    let msg = `Processed ${done.length} of ${files.length} photos → ${outDir}\n` + done.join("\n");
    if (errors.length) msg += `\n\nErrors:\n${errors.join("\n")}`;
    return text(msg);
  }
);

server.registerTool(
  "create_draft",
  {
    title: "Create ad draft",
    description:
      "Creates a draft folder in drafts/: processed photos, ad.json and description.txt. " +
      "The assistant writes the title and description.",
    inputSchema: {
      title: z.string().max(50).describe("Ad title (Kufar allows up to 50 characters)"),
      description: z.string().max(4000).describe("Ad text"),
      price: z.number().nonnegative().optional().describe("Price in BYN; omit for a negotiable price"),
      category: z.string().optional().describe("Category, e.g. 'Phones'"),
      condition: z.enum(["new", "used"]).optional(),
      city: z.string().optional().describe("City / district"),
      photos: z.array(z.string()).default([]).describe("Paths to photos or photo folders"),
      enhance: z.boolean().default(true).describe("Apply photo enhancement"),
      ...enhanceOptions,
    },
  },
  async ({ title, description, price, category, condition, city, photos, enhance, ...o }) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const dir = path.join(DRAFTS_DIR, `${stamp}_${slugify(title)}`);
    const photosDir = path.join(dir, "photos");
    await fs.mkdir(photosDir, { recursive: true });

    const files = await collectImages(photos);
    let saved = [];
    let errors = [];
    if (files.length) {
      if (enhance) {
        ({ done: saved, errors } = await enhanceMany(files, photosDir, o));
      } else {
        let i = 1;
        for (const f of files) {
          const dest = path.join(photosDir, `${String(i++).padStart(2, "0")}_${path.basename(f)}`);
          await fs.copyFile(f, dest);
          saved.push(dest);
        }
      }
    }

    const ad = {
      title,
      description,
      price: price ?? null,
      category: category ?? null,
      condition: condition ?? null,
      city: city ?? null,
      photos: saved.map((p) => path.relative(dir, p)),
      status: "draft",
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, "ad.json"), JSON.stringify(ad, null, 2));
    await fs.writeFile(
      path.join(dir, "description.txt"),
      `${title}\n\n${description}\n\nPrice: ${price != null ? `${price} BYN` : "negotiable"}\n`
    );

    let msg = `Draft created: ${dir}\nPhotos: ${saved.length}`;
    if (errors.length) msg += `\nErrors:\n${errors.join("\n")}`;
    return text(msg);
  }
);

server.registerTool(
  "list_drafts",
  {
    title: "List drafts",
    description: "Lists all ad drafts from the drafts/ folder",
    inputSchema: {},
  },
  async () => {
    let dirs = [];
    try {
      dirs = (await fs.readdir(DRAFTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory());
    } catch {}
    if (!dirs.length) return text("No drafts yet.");
    const rows = [];
    for (const d of dirs.sort((a, b) => b.name.localeCompare(a.name))) {
      try {
        const ad = JSON.parse(await fs.readFile(path.join(DRAFTS_DIR, d.name, "ad.json"), "utf8"));
        const price = ad.price != null ? `${ad.price} BYN` : "negotiable";
        rows.push(`• ${ad.title} — ${price} — ${ad.photos.length} photos — ${ad.status}\n  ${path.join(DRAFTS_DIR, d.name)}`);
      } catch {
        rows.push(`• ${d.name} (no ad.json)`);
      }
    }
    return text(rows.join("\n"));
  }
);

// ---------- Kufar: login and publishing ----------

// Show API errors together with the response body — it shows what changed on Kufar's side
function errorText(e) {
  let msg = `Error: ${e.message}`;
  if (e.body !== undefined) {
    const body = typeof e.body === "string" ? e.body : JSON.stringify(e.body, null, 2);
    msg += `\n\nServer response:\n${body.slice(0, 3000)}`;
  }
  return { ...text(msg), isError: true };
}

// If a tool needs a login, open the login page right away instead of asking the user to call kufar_login
async function loginPrompt(reason) {
  const url = await startLogin();
  const opened = openInBrowser(url);
  return text(
    `${reason} ${opened ? "Opened the login page in the browser" : "Open the login page in the browser"}:\n${url}\n\n` +
      "Ask the user to log in there via SMS and tell you when done. " +
      "Then check kufar_status and retry the action. The link is valid for 10 minutes."
  );
}

const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof kufar.NeedLoginError) {
      try {
        return await loginPrompt(e.message);
      } catch (e2) {
        return errorText(e2);
      }
    }
    return errorText(e);
  }
};

function sessionSummary(s) {
  if (!s?.jwt) return "Not logged in. Call kufar_login to log in.";
  const p = kufar.decodeJwt(s.jwt) ?? {};
  const exp = p.exp ? new Date(p.exp * 1000) : null;
  const lines = ["Logged in."];
  if (s.login) lines.push(`Login: ${s.login}`);
  const id = p.aid ?? p.account_id ?? p.user_id ?? p.sub;
  if (id) lines.push(`Account ID: ${id}`);
  if (exp) lines.push(`Token valid until: ${exp.toLocaleString("en-GB")}${exp < new Date() ? " — EXPIRED, log in again" : ""}`);
  return lines.join("\n");
}

async function resolveDraft(draft) {
  const p = path.isAbsolute(expandHome(draft)) ? path.resolve(expandHome(draft)) : path.join(DRAFTS_DIR, draft);
  const ad = JSON.parse(await fs.readFile(path.join(p, "ad.json"), "utf8"));
  return { dir: p, ad };
}

server.registerTool(
  "kufar_login",
  {
    title: "Log in to Kufar",
    description:
      "Opens a local Kufar SMS login page in the browser. " +
      "The user enters their details in the browser — they never reach the chat. " +
      "Never ask the user to send their phone number or SMS code in the chat. After login, check kufar_status.",
    inputSchema: {},
  },
  safe(() => loginPrompt(""))
);

server.registerTool(
  "kufar_status",
  { title: "Login status", description: "Shows whether you are logged in to Kufar and when the token expires", inputSchema: {} },
  safe(async () => text(sessionSummary(await kufar.loadSession())))
);

server.registerTool(
  "kufar_logout",
  { title: "Log out", description: "Deletes the saved Kufar token", inputSchema: {} },
  safe(async () => {
    await kufar.clearSession();
    return text("Token deleted.");
  })
);

server.registerTool(
  "kufar_categories",
  {
    title: "Kufar categories",
    description:
      "Finds a category ID (needed for publish_ad). Searches the category tree, or, if it is unavailable, " +
      "ads from search results: pass what you are selling in search, e.g. \"hp laptop\". Kufar is in Russian, so Russian queries match best.",
    inputSchema: { search: z.string().describe("Category or item name, e.g. 'laptop'") },
  },
  safe(async ({ search }) => {
    const q = search.toLowerCase();

    // 1. Category tree
    let treeError;
    try {
      const tree = await kufar.getCategories();
      const found = [];
      // Walk the whole tree: the exact response structure is undocumented
      const walk = (node, trail) => {
        if (Array.isArray(node)) return node.forEach((n) => walk(n, trail));
        if (!node || typeof node !== "object") return;
        const name = node.name_ru ?? node.name ?? node.label;
        const here = name ? [...trail, name] : trail;
        if (node.id != null && typeof name === "string" && name.toLowerCase().includes(q)) {
          found.push(`${node.id} — ${here.join(" › ")}`);
        }
        for (const v of Object.values(node)) if (typeof v === "object") walk(v, here);
      };
      walk(tree, []);
      if (found.length) return text([...new Set(found)].slice(0, 30).join("\n"));
    } catch (e) {
      treeError = e;
    }

    // 2. From search results: every ad has a category ID
    const ads = await kufar.searchAds(search, 100);
    if (!ads.length) return text(`No ads found for "${search}" — try another word.`);
    const stats = new Map();
    for (const ad of ads) {
      const id = ad.category ?? ad.category_id;
      if (id == null) continue;
      const param = (ad.ad_parameters ?? []).find((p) => p.p === "category");
      const entry = stats.get(String(id)) ?? { count: 0, name: param?.vl, examples: [] };
      entry.count++;
      if (entry.examples.length < 3 && ad.subject) entry.examples.push(ad.subject);
      stats.set(String(id), entry);
    }
    if (!stats.size) {
      return text(`Ads have no category field. Sample ad:\n${JSON.stringify(ads[0], null, 2).slice(0, 3000)}`);
    }
    const rows = [...stats.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([id, e]) => `${id}${e.name ? ` — ${e.name}` : ""} (${e.count} of ${ads.length} ads), e.g.: ${e.examples.join("; ")}`);
    return text(
      (treeError ? `Category tree unavailable (${treeError.message}); inferred from search results.\n\n` : "") +
        `Ad categories for "${search}":\n${rows.join("\n")}`
    );
  })
);

// System form fields the user does not fill in
const HIDDEN_FIELDS = new Set(["environment_id", "remote_addr", "remote_browser", "ad_id", "import_code", "parent_category", "category"]);

function describeField(f, maxValues = 200) {
  const label = f.labels?.name?.ru ?? f.name;
  let line = `${f.required ? "* " : "  "}${f.name} — ${label} (${f.type}${f.multi ? ", multiple" : ""})`;
  const vals = f.values ?? [];
  if (vals.length) {
    const shown = vals.slice(0, maxValues).map((v) => `${v.value}=${v.labels?.ru ?? v.value}`);
    line += `\n    values: ${shown.join("; ")}${vals.length > maxValues ? `; …${vals.length - maxValues} more` : ""}`;
  }
  return line;
}

async function loadForm(category, values = {}) {
  const cat = await kufar.findParentCategory(category);
  if (!cat) throw new Error(`Category ${category} not found in the Kufar tree. Find the ID with kufar_categories.`);
  const meta = await kufar.getAdMeta(category, cat.parent);
  const all = { company_ad: "0", type: "sell", ...values, category: String(category), parent_category: String(cat.parent) };
  return { cat, meta, fields: kufar.activeFields(meta, all) };
}

server.registerTool(
  "kufar_category_fields",
  {
    title: "Ad fields for a category",
    description:
      "Shows the ad form fields for a category: required (*) and optional, with allowed values. " +
      "List field values are passed to publish_ad as numeric codes (e.g. condition: 1 = used). " +
      "The field set depends on values already chosen (e.g. area appears after region) — pass them in values.",
    inputSchema: {
      category: z.number().int().describe("Subcategory ID from kufar_categories"),
      values: z.record(z.string(), z.any()).default({}).describe("Values already chosen, e.g. {\"region\": 7}"),
    },
  },
  safe(async ({ category, values }) => {
    const { cat, fields } = await loadForm(category, values);
    const visible = fields
      .filter((f) => !HIDDEN_FIELDS.has(f.name) && (f.required || f.ui_component?.type))
      .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
    return text(
      `${cat.parentName} › ${cat.name} (${category})\n* — required field\n\n` + visible.map((f) => describeField(f)).join("\n")
    );
  })
);

server.registerTool(
  "publish_ad",
  {
    title: "Publish ad",
    description:
      "Publishes a draft from drafts/ on Kufar: uploads photos and creates the ad. " +
      "First get the fields with kufar_category_fields and pass value codes in fields. " +
      "Defaults to dry_run=true — checks required fields and shows what would be sent without publishing anything. " +
      "Before dry_run=false, show the user the result and get their consent.",
    inputSchema: {
      draft: z.string().describe("Draft folder name from list_drafts, or a full path"),
      category: z.number().int().describe("Subcategory ID from kufar_categories"),
      fields: z
        .record(z.string(), z.any())
        .default({})
        .describe("Form fields as codes from kufar_category_fields: condition, region, area, brand, etc."),
      name: z.string().optional().describe("Seller name shown in the ad"),
      email: z.string().optional().describe("Account email"),
      phone: z.string().optional().describe("Phone; defaults to the number used to log in"),
      currency: z.enum(["BYR", "USD", "EUR"]).default("BYR").describe("BYR — Belarusian rubles"),
      dry_run: z.boolean().default(true).describe("true — only validate and show the request"),
    },
  },
  safe(async ({ draft, category, fields, name, email, phone, currency, dry_run }) => {
    const { dir, ad } = await resolveDraft(draft);
    if (ad.status === "published" && !dry_run) {
      return text(`This draft is already published (ad_id ${ad.kufar_ad_id}). Not sending it again.`);
    }
    const session = await kufar.loadSession();
    if (!session?.jwt) throw new kufar.NeedLoginError("Publishing requires a Kufar login.");

    const sessionPhone = /^\d{12}$/.test(session.login ?? "") ? session.login : undefined;
    const payload = {
      language: "ru",
      type: "sell",
      company_ad: false,
      remuneration_type: "1",
      currency,
      category: String(category),
      subject: ad.title,
      body: ad.description,
      phone_hidden: "0",
      ...(ad.price != null && { price: String(ad.price) }),
      ...(name && { name }),
      ...(email && { email }),
      ...((phone || sessionPhone) && { phone: phone ? kufar.normalizePhone(phone) : sessionPhone }),
      ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)])),
    };

    // Validate against the form metadata
    const { cat, fields: formFields } = await loadForm(category, payload);
    const problems = [];
    for (const f of formFields) {
      if (HIDDEN_FIELDS.has(f.name)) continue;
      const v = payload[f.name];
      const empty = v === undefined || v === "" || (Array.isArray(v) && !v.length);
      if (f.required && empty) problems.push(`missing required field: ${describeField(f, 30)}`);
      if (!empty && f.values?.length) {
        const allowed = new Set(f.values.map((x) => String(x.value)));
        const asCode = (x) => (typeof x === "boolean" ? (x ? "1" : "0") : String(x));
        const bad = (Array.isArray(v) ? v : [v]).filter((x) => !allowed.has(asCode(x)));
        if (bad.length) problems.push(`invalid value ${f.name}=${bad.join(",")}: ${describeField(f, 30)}`);
      }
    }
    const known = new Set(formFields.map((f) => f.name));
    const unknown = Object.keys(fields).filter((k) => !known.has(k));
    if (unknown.length) {
      unknown.forEach((k) => delete payload[k]);
      problems.push(`fields do not belong to this category, not sending them: ${unknown.join(", ")}`);
    }
    if ((ad.description ?? "").length < 20) problems.push("description is shorter than 20 characters");

    const photos = ad.photos.map((p) => path.join(dir, p));
    if (dry_run || problems.some((p) => !p.startsWith("fields do not belong"))) {
      return text(
        `${dry_run ? "Dry run — nothing was sent." : "Not sent: fix the errors first."}\n` +
          `Category: ${cat.parentName} › ${cat.name}\n\n` +
          (problems.length ? `Problems:\n- ${problems.join("\n- ")}\n\n` : "All required fields are filled in.\n\n") +
          `Photos to upload (${photos.length}):\n${photos.join("\n")}\n\n` +
          `Ad:\n${JSON.stringify(payload, null, 2)}` +
          (problems.length ? "" : "\n\nTo publish, run again with dry_run=false (after the user agrees).")
      );
    }

    const uploaded = [];
    for (const p of photos) uploaded.push(await kufar.uploadImage(p));
    payload.images = uploaded.map((u) => u.path ?? u.id);
    payload.is_new_image = uploaded.map(() => true);

    let result;
    try {
      result = await kufar.insertAd(payload);
    } catch (e) {
      if (e.status === 422) {
        e.message = `Kufar rejected the ad (field errors, see the response). ${e.message}`;
      }
      throw e;
    }
    const adId = result?.ad_id ?? result?.id ?? result?.ad?.ad_id;
    if (adId) {
      Object.assign(ad, { status: "published", kufar_ad_id: adId, published_at: new Date().toISOString() });
      await fs.writeFile(path.join(dir, "ad.json"), JSON.stringify(ad, null, 2));
    }
    return text(
      adId
        ? `Ad submitted. ID: ${adId}. It will appear on the site after moderation: https://www.kufar.by/item/${adId}\n\n${JSON.stringify(result, null, 2).slice(0, 2000)}`
        : `Kufar responded without an ad ID — check the response:\n${JSON.stringify(result, null, 2).slice(0, 3000)}`
    );
  })
);

server.registerTool(
  "kufar_api_request",
  {
    title: "Kufar API request (diagnostics)",
    description:
      "Sends an arbitrary request to *.kufar.by with the current token and returns the full response. " +
      "Useful for debugging if Kufar changes its API.",
    inputSchema: {
      url: z.url(),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
      json: z.any().optional().describe("Request body (JSON)"),
      headers: z.record(z.string(), z.string()).default({}),
      auth: z.boolean().default(true).describe("Include the auth token"),
    },
  },
  safe(async ({ url, method, json, headers, auth }) => {
    const data = await kufar.request(url, { method, json, headers, auth });
    const out = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return text(out.slice(0, 8000));
  })
);

await server.connect(new StdioServerTransport());
console.error("kufar MCP started");
