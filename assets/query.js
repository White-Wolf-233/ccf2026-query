/* QueryFrame 运行时。
 *
 * 与 queryframe/normalize.py、crypto.py 严格对偶 —— 任何一侧改动都必须
 * 重跑 `python tests/gen_vectors.py`，再让 `python -m pytest tests/ -q` 通过。
 * tests/vectors.json 里是两边共用的基准：同一组输入必须算出同一个身份串和 id。
 *
 * 本文件不接触 DOM，可被 Node 直接 import，用于构建后的自动化验证。
 */

const PAGE_SIZE = 40;

const _LOOKUP_TABLE = [
    113, 54, 236, 241, 240, 203, 194, 74, 17, 208, 119, 9, 138, 210, 66, 162,
    88, 159, 204, 66, 167, 214, 232, 105, 104, 45, 41, 66, 164, 74, 190, 193
];

const RETRY_LIMIT = 3;
const FAILURE_LOCK_MS = 300000;

const _BACKOFF_TABLE = [
    205, 180, 238, 36, 37, 181, 1, 99, 29, 36, 60, 2, 135, 145, 80, 94,
    162, 254, 36, 14, 237, 187, 45, 82, 94, 22, 105, 248, 9, 24, 76, 176
];

const CACHE_TTL_MS = 60000;

const SALT_B64 = "i6ohCGox5MKgNh6+NsvhFXpXdzYdruoY7kwwqS1srVw=";

/* ── 字节工具 ─────────────────────────────────────────── */

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToHex(bytes) {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
}

function keyMaterial() {
    const out = new Uint8Array(_LOOKUP_TABLE.length);
    for (let i = 0; i < out.length; i++) out[i] = _LOOKUP_TABLE[i] ^ _BACKOFF_TABLE[i];
    return out;
}

/* ── 规范化：必须与 normalize.py 逐条对应 ──────────────── */

const _WS_EDGE = /^[\s\u3000]+|[\s\u3000]+$/g;
const _WS_ANY = /[\s\u3000]/g;

function nStrip(v) {
    return v.replace(_WS_EDGE, "");
}

function nNoSpace(v) {
    return v.replace(_WS_ANY, "");
}

function nFullwidthToHalfwidth(v) {
    let out = "";
    for (const ch of v) {
        const cp = ch.codePointAt(0);
        if (cp >= 0xff01 && cp < 0xff5f) out += String.fromCodePoint(cp - 0xfee0);
        else if (cp === 0x3000) out += " ";
        else out += ch;
    }
    return out;
}

function nDigitsOnly(v) {
    return nFullwidthToHalfwidth(v).replace(/[^0-9]/g, "");
}

function nAlnumOnly(v) {
    return nFullwidthToHalfwidth(v).replace(/[^0-9A-Za-z]/g, "");
}

function nRemove(v, chars) {
    let out = "";
    for (const ch of v) if (!chars.includes(ch)) out += ch;
    return out;
}

export function normalizeValue(raw, ops) {
    let v = raw === null || raw === undefined ? "" : String(raw);
    for (const op of ops || []) {
        if (op === "strip") v = nStrip(v);
        else if (op === "nospace") v = nNoSpace(v);
        else if (op === "lower") v = v.toLowerCase();
        else if (op === "upper") v = v.toUpperCase();
        else if (op === "fullwidth_to_halfwidth") v = nFullwidthToHalfwidth(v);
        else if (op === "digits_only") v = nDigitsOnly(v);
        else if (op === "alnum_only") v = nAlnumOnly(v);
        else if (op.startsWith("remove:")) v = nRemove(v, op.slice(7));
        else throw new Error(`未知规范化规则 ${op}`);
    }
    return v;
}

/* ── 身份串与查表键 ───────────────────────────────────── */

export function buildIdentity(values) {
    const enc = new TextEncoder();
    return values.map((v) => `${enc.encode(v).length}:${v}`).join("|");
}

export async function computeId(saltBytes, identity) {
    const identityBytes = new TextEncoder().encode(identity);
    const buf = new Uint8Array(saltBytes.length + identityBytes.length);
    buf.set(saltBytes, 0);
    buf.set(identityBytes, saltBytes.length);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return bytesToHex(digest).slice(0, 16);
}

/* ── 解密 ─────────────────────────────────────────────── */

export async function decryptBlob(keyBytes, blob) {
    const iv = blob.slice(0, 12);
    const ct = blob.slice(12);
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(plain);
}

/* ── 对外主流程 ───────────────────────────────────────── */

/**
 * 按 fields 定义计算身份串、查表、解密。
 *
 * fields: [{key, normalize}]，顺序即 identityFields 顺序
 * inputs: {key: 用户输入}
 * 返回：{status, payload?, reason?}
 *   status: "ok" | "notfound" | "corrupt" | "invalid"
 *
 * 注意：notfound 与 invalid 对用户展示的文案必须完全一致，
 * 否则页面会变成一个"查询项是否存在"的探测接口。
 */
export async function lookup(data, fields, inputs) {
    for (const f of fields) {
        if (f.required !== false && !String(inputs[f.key] ?? "").length) {
            return { status: "invalid", reason: `${f.label}不能为空` };
        }
    }

    const salt = b64ToBytes(data.salt);
    const normalized = fields.map((f) => normalizeValue(inputs[f.key] ?? "", f.normalize));
    const identity = buildIdentity(normalized);
    const id = await computeId(salt, identity);

    const blobB64 = data.records[id];
    if (!blobB64) return { status: "notfound" };

    try {
        const text = await decryptBlob(keyMaterial(), b64ToBytes(blobB64));
        return { status: "ok", payload: JSON.parse(text) };
    } catch (err) {
        return { status: "corrupt", reason: String(err) };
    }
}

export const _internal = { keyMaterial, PAGE_SIZE, RETRY_LIMIT, FAILURE_LOCK_MS, CACHE_TTL_MS };
