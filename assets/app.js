/* QueryFrame 前端交互层。
 *
 * 只负责 DOM：渲染表单、收集输入、展示结果、失败节流。
 * 一切与"算 id / 解密"有关的逻辑都在 query.js 里，便于脱离浏览器验证。
 */

import { lookup } from "./query.js";

const site = window.__QF__ || {
    title: "",
    notice: "",
    footer: "",
    fields: [],
    identitySchema: [],
};

const FAILS_KEY = "qf.fails";
const LOCK_KEY = "qf.lockUntil";
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

/** notfound 与 corrupt 必须共用同一句话 —— 否则页面就成了探测器。 */
const NOT_FOUND_TEXT = "未找到匹配的记录。请检查输入是否与报名时一致。";

const $ = (sel, root = document) => root.querySelector(sel);

let cachedData = null;
const inputEls = new Map();

/* ── 失败节流（抬高暴力尝试的门槛，非安全边界）───────── */

function readInt(key) {
    try {
        return parseInt(localStorage.getItem(key) || "0", 10) || 0;
    } catch {
        return 0;
    }
}

function writeInt(key, value) {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        /* 隐私模式下会抛异常，忽略即可 */
    }
}

function lockRemainingMs() {
    return Math.max(0, readInt(LOCK_KEY) - Date.now());
}

function noteFailure() {
    const n = readInt(FAILS_KEY) + 1;
    if (n >= MAX_FAILS) {
        writeInt(LOCK_KEY, Date.now() + LOCK_MS);
        writeInt(FAILS_KEY, 0);
    } else {
        writeInt(FAILS_KEY, n);
    }
}

function clearFailures() {
    writeInt(FAILS_KEY, 0);
    writeInt(LOCK_KEY, 0);
}

/* ── 数据加载 ─────────────────────────────────────────── */

async function loadData() {
    if (cachedData) return cachedData;
    const res = await fetch("data.json", { cache: "default" });
    if (!res.ok) throw new Error(`data.json 加载失败（HTTP ${res.status}）`);
    cachedData = await res.json();
    return cachedData;
}

/* ── 视图 ─────────────────────────────────────────────── */

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function renderHeader() {
    document.title = site.title || "结果查询";
    $("#qf-title").textContent = site.title || "结果查询";

    const notice = $("#qf-notice");
    if (site.notice) {
        String(site.notice)
            .split("\n")
            .forEach((line, i) => {
                if (i) notice.appendChild(document.createElement("br"));
                notice.appendChild(document.createTextNode(line));
            });
    } else {
        notice.remove();
    }

    const footer = $("#qf-footer");
    if (site.footer) footer.textContent = site.footer;
    else footer.remove();
}

function renderForm() {
    const form = $("#qf-form");
    form.replaceChildren();
    inputEls.clear();

    for (const field of site.fields) {
        const wrap = el("div", "field");

        const label = el("label", "field-label", field.label);
        label.htmlFor = `qf-${field.key}`;
        wrap.appendChild(label);

        const input = document.createElement("input");
        input.id = `qf-${field.key}`;
        input.name = field.key;
        input.type = field.type || "text";
        input.className = "field-input";
        input.placeholder = field.placeholder || "";
        input.autocomplete = field.autocomplete || "off";
        input.autocapitalize = "off";
        input.spellcheck = false;
        if (field.required) input.required = true;
        input.addEventListener("input", () => {
            wrap.classList.remove("has-error");
            const msg = wrap.querySelector(".field-msg");
            if (msg) msg.textContent = "";
        });
        wrap.appendChild(input);
        inputEls.set(field.key, input);

        if (field.hint) wrap.appendChild(el("div", "field-hint", field.hint));

        wrap.appendChild(el("div", "field-msg", ""));
        form.appendChild(wrap);
    }

    const button = document.createElement("button");
    button.type = "submit";
    button.className = "submit-button";
    button.id = "qf-submit";
    button.textContent = "查询";
    form.appendChild(button);
}

function setFieldError(key, message) {
    const input = inputEls.get(key);
    if (!input) return;
    input.closest(".field").classList.add("has-error");
    const msg = input.closest(".field").querySelector(".field-msg");
    if (msg) msg.textContent = message;
}

function collectInputs() {
    const values = {};
    for (const [key, input] of inputEls) values[key] = input.value;
    return values;
}

function validateInputs() {
    let firstBad = null;
    for (const field of site.fields) {
        const input = inputEls.get(field.key);
        if (!input) continue;
        const raw = input.value;

        if (field.required && !raw.trim()) {
            setFieldError(field.key, "此项为必填");
            firstBad = firstBad || input;
            continue;
        }
        if (field.pattern && raw.trim()) {
            let re = null;
            try {
                re = new RegExp(field.pattern);
            } catch {
                re = null; /* 配置里的正则 JS 不支持时跳过前端校验 */
            }
            if (re && !re.test(raw.trim())) {
                setFieldError(field.key, field.patternMsg || "格式不正确");
                firstBad = firstBad || input;
            }
        }
    }
    if (firstBad) firstBad.focus();
    return !firstBad;
}

function buildResultCard(payload) {
    const card = el("div", "result-card");

    for (const group of payload.groups || []) {
        if (group.title) card.appendChild(el("div", "result-group-title", group.title));

        const list = el("div", "result-list");
        for (const item of group.items || []) {
            const row = el("div", "result-item");
            if (item.block) row.classList.add("is-block");
            if (item.label) row.appendChild(el("span", "result-label", item.label));

            const valueWrap = el("span", "result-value");
            if (item.emphasis) valueWrap.classList.add("is-emphasis");

            const valueText = el("span", "result-text", item.value);
            if (item.reveal === "sealed") {
                valueText.classList.add("sealed");
                valueText.title = "点击查看";
                valueText.addEventListener("click", () => valueText.classList.remove("sealed"));
            }
            valueWrap.appendChild(valueText);

            if (item.copy) {
                const btn = el("button", "copy-button", "复制");
                btn.type = "button";
                btn.addEventListener("click", async () => {
                    try {
                        await navigator.clipboard.writeText(item.value);
                        btn.textContent = "已复制";
                    } catch {
                        btn.textContent = "复制失败";
                    }
                    setTimeout(() => {
                        btn.textContent = "复制";
                    }, 1600);
                });
                valueWrap.appendChild(btn);
            }

            row.appendChild(valueWrap);
            list.appendChild(row);
        }
        card.appendChild(list);
    }

    if (!card.childNodes.length) card.appendChild(el("div", "result-empty", "暂无可展示的信息"));
    return card;
}

function showResult(node) {
    const box = $("#qf-result");
    box.replaceChildren(node);
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showError(message) {
    showResult(el("div", "result-card result-card--error", message));
}

/* ── 提交 ─────────────────────────────────────────────── */

async function onSubmit(event) {
    event.preventDefault();
    const button = $("#qf-submit");

    const locked = lockRemainingMs();
    if (locked > 0) {
        showError(`尝试次数过多，请 ${Math.ceil(locked / 60000)} 分钟后再试。`);
        return;
    }

    if (!validateInputs()) return;

    button.disabled = true;
    button.textContent = "查询中…";

    try {
        const data = await loadData();
        const result = await lookup(data, site.identitySchema, collectInputs());

        if (result.status === "ok") {
            clearFailures();
            showResult(buildResultCard(result.payload));
        } else if (result.status === "invalid") {
            showError(result.reason || NOT_FOUND_TEXT);
        } else {
            if (result.status === "notfound") noteFailure();
            showError(NOT_FOUND_TEXT);
        }
    } catch (err) {
        showError("页面资源加载失败，请刷新后重试。");
        console.error(err);
    } finally {
        button.disabled = false;
        button.textContent = "查询";
    }
}

/* ── 启动 ─────────────────────────────────────────────── */

function boot() {
    renderHeader();
    renderForm();
    $("#qf-form").addEventListener("submit", onSubmit);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}
