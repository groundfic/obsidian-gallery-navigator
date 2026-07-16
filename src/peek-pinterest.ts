/*
 * Pinterest 以圖搜圖（visual search）——Image Peek 的「第二層」面板。
 * 移植自 Gallery Navigator，改寫為 TS，並改成疊在 Peek 覆層之上的獨立層級。
 *
 * 注意：這裡打的是 Pinterest 的行動端 visual_search endpoint，無需 API key，
 * 但也因此不是公開契約——回應格式若變動，只影響本面板，不影響預覽本身。
 */

import {
	App,
	MarkdownView,
	Notice,
	Platform,
	Scope,
	requestUrl,
	setIcon,
} from "obsidian";
import { t } from "./i18n.js";

const PIN_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PIN_ENDPOINT =
	"https://api.pinterest.com/v3/visual_search/extension/image/";

/** Pinterest 回應中我們實際會用到的欄位（其餘忽略） */
interface PinItem {
	id?: string;
	title?: string;
	grid_title?: string;
	link?: string;
	tracked_link?: string;
	image_medium_url?: string;
	image_large_url?: string;
	image_square_url?: string;
	image_medium_size_pixels?: { width?: number; height?: number };
	image_large_size_pixels?: { width?: number; height?: number };
	/* 動態內容判斷用（旗標不可靠，只當「拿不到 gif 就別顯示」的依據） */
	is_video?: boolean;
	videos?: unknown;
	video_status?: unknown;
	story_pin_data?: unknown;
	type?: string;
	embed?: { type?: string };
	/** 探測到的原檔 gif 網址（我們自己塞的） */
	_gifUrl?: string;
}

/* ===== 動圖（gif）處理 =====
   實測（2026-07）：visual_search 的回應只有靜態 jpg，整包沒有任何 .gif / .mp4 網址，
   連 is_video 旗標都不可靠（真 gif 的 pin，is_video 竟是 false）。
   但原檔就放在 i.pinimg.com/originals/<a>/<b>/<c>/<hash>.gif —— 用縮圖 hash 推得出來。
   → 換算成 originals 的 .gif，HEAD 一下：200 + image/gif ＝ 這個 pin 真的是動圖，直接播原檔。 */

/** .../474x/11/50/80/<hash>.jpg → .../originals/11/50/80/<hash>.gif */
function pinGifGuess(url: string | undefined): string | null {
	if (!url || !/i\.pinimg\.com/i.test(url)) return null;
	const g = String(url)
		.split("?")[0]
		.replace(/\/(originals|\d+x)\//, "/originals/")
		.replace(/\.(jpe?g|png|webp)$/i, ".gif");
	return /\/originals\/.+\.gif$/i.test(g) ? g : null;
}

/** HEAD 探測（結果快取；併發上限 5，免一頁 80 張同時打爆） */
const gifCache = new Map<string, Promise<string | null>>();
let gifRunning = 0;
const gifQueue: Array<() => Promise<void>> = [];
function gifPump() {
	while (gifRunning < 5 && gifQueue.length) {
		const job = gifQueue.shift() as () => Promise<void>;
		gifRunning++;
		void job().finally(() => {
			gifRunning--;
			gifPump();
		});
	}
}
function probePinGif(thumbUrl: string | undefined): Promise<string | null> {
	const guess = pinGifGuess(thumbUrl);
	if (!guess) return Promise.resolve(null);
	const cached = gifCache.get(guess);
	if (cached) return cached;

	const p = new Promise<string | null>((resolve) => {
		gifQueue.push(async () => {
			try {
				const r = await requestUrl({ url: guess, method: "HEAD", throw: false });
				const h = (r?.headers || {}) as Record<string, string>;
				const ct = h["content-type"] || h["Content-Type"] || "";
				resolve(r?.status === 200 && /image\/gif/i.test(ct) ? guess : null);
			} catch (e) {
				resolve(null);
			}
		});
		gifPump();
	});
	gifCache.set(guess, p);
	return p;
}

/** 這個 pin 是不是動態內容（gif / 影片 / story pin） */
function pinIsAnimated(p: PinItem): boolean {
	if (!p) return false;
	if (p.is_video || p.videos || p.video_status || p.story_pin_data) return true;
	if (p.embed && /video|gif/i.test(String(p.embed.type || ""))) return true;
	return /video|story/i.test(String(p.type || ""));
}

/** blob → 長邊 ≤1600 的標準 JPEG（失敗回 null）
    Pinterest 這支端點對上傳的圖很挑：太大、或 gif/webp/avif/heic 會直接回 400（code 2651）。 */
function toJpeg(blob: Blob): Promise<ArrayBuffer | null> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(blob);
		const im = new Image();
		im.onload = () => {
			try {
				const MAX = 1600;
				const w0 = im.naturalWidth;
				const h0 = im.naturalHeight;
				if (!w0 || !h0) {
					URL.revokeObjectURL(url);
					return resolve(null);
				}
				const s = Math.min(1, MAX / Math.max(w0, h0));
				const cv = activeDocument.createElement("canvas");
				cv.width = Math.max(1, Math.round(w0 * s));
				cv.height = Math.max(1, Math.round(h0 * s));
				const ctx = cv.getContext("2d");
				if (!ctx) {
					URL.revokeObjectURL(url);
					return resolve(null);
				}
				ctx.fillStyle = "#fff"; // gif/png 透明底 → 白底（JPEG 無透明）
				ctx.fillRect(0, 0, cv.width, cv.height);
				ctx.drawImage(im, 0, 0, cv.width, cv.height); // gif 只畫第一幀，正是我們要的
				cv.toBlob(
					(b) => {
						URL.revokeObjectURL(url);
						if (!b) return resolve(null);
						b.arrayBuffer()
							.then(resolve)
							.catch(() => resolve(null));
					},
					"image/jpeg",
					0.92
				);
			} catch (e) {
				URL.revokeObjectURL(url);
				resolve(null);
			}
		};
		im.onerror = () => {
			URL.revokeObjectURL(url);
			resolve(null);
		};
		im.src = url;
	});
}

/** 容錯 JSON 解析：Pinterest 回應的字串欄位偶爾含原始控制字元，嚴格 JSON.parse 會炸 */
function parseJsonLoose(text: string): Record<string, unknown> | null {
	try {
		return JSON.parse(text);
	} catch (e) {
		/* 落到寬鬆解析 */
	}
	try {
		return JSON.parse(String(text).replace(/[\u0000-\u001F]/g, " "));
	} catch (e) {
		return null;
	}
}

/** 手動組 multipart/form-data（requestUrl 不支援 FormData，得自己拼 bytes） */
function buildMultipart(
	fields: Record<string, string>,
	fileField: string,
	fileName: string,
	fileBytes: ArrayBuffer,
	mime: string
): { boundary: string; body: ArrayBuffer } {
	const boundary =
		"----IPBoundary" +
		Math.random().toString(16).slice(2) +
		Date.now().toString(16);
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (const k of Object.keys(fields)) {
		chunks.push(
			enc.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`
			)
		);
	}
	chunks.push(
		enc.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`
		)
	);
	chunks.push(new Uint8Array(fileBytes));
	chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));

	const total = chunks.reduce((s, c) => s + c.byteLength, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.byteLength;
	}
	return { boundary, body: out.buffer };
}

/* ===== 瀑布流版面引擎（shortest-column，同 Pinterest） ===== */

class MasonryLayout {
	private items: HTMLElement[] = [];
	private lastW = 0;
	private raf = 0;
	private ro: ResizeObserver;

	constructor(
		private container: HTMLElement,
		private gap = 10,
		private minCol = 150,
		/** >0 = 強制固定欄數（手機用） */
		private fixedCols = 0
	) {
		container.style.position = "relative";
		this.ro = new ResizeObserver(() => {
			if (this.container.clientWidth !== this.lastW) this.scheduleLayout();
		});
		this.ro.observe(container);
		// load 事件不冒泡，但捕獲階段抓得到——一條就涵蓋所有後續插入的圖
		container.addEventListener("load", () => this.scheduleLayout(), true);
	}

	add(el: HTMLElement) {
		el.style.position = "absolute";
		el.style.top = "0";
		el.style.left = "0";
		this.items.push(el);
		this.scheduleLayout();
	}

	clear() {
		this.items = [];
		this.container.empty();
		this.container.style.height = "0px";
		this.lastW = 0;
	}

	/** 事後才發現不該顯示的項目（例如拿不到 gif 的動態 pin）→ 移除並重排 */
	remove(el: HTMLElement) {
		const i = this.items.indexOf(el);
		if (i >= 0) this.items.splice(i, 1);
		el.remove();
		this.scheduleLayout();
	}

	private scheduleLayout() {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.layout();
		});
	}

	private layout() {
		const W = this.container.clientWidth;
		if (!W || !this.items.length) {
			if (!this.items.length) this.container.style.height = "0px";
			return;
		}
		this.lastW = W;
		const cols =
			this.fixedCols ||
			Math.max(1, Math.floor((W + this.gap) / (this.minCol + this.gap)));
		const colW = (W - this.gap * (cols - 1)) / cols;

		// 先統一設寬（一次 reflow），再一次量測高度
		for (const el of this.items) el.style.width = colW + "px";
		const heights = this.items.map((el) => el.offsetHeight);

		const colH = new Array(cols).fill(0) as number[];
		this.items.forEach((el, i) => {
			let c = 0;
			for (let k = 1; k < cols; k++) if (colH[k] < colH[c]) c = k; // 最矮的欄
			el.style.left = c * (colW + this.gap) + "px";
			el.style.top = colH[c] + "px";
			colH[c] += heights[i] + this.gap;
		});
		this.container.style.height = Math.max(...colH) + "px";
	}

	destroy() {
		this.ro.disconnect();
		if (this.raf) cancelAnimationFrame(this.raf);
	}
}

/* ===== 第二層：Pinterest 找相似面板 ===== */

export class PinterestPanel {
	private rootEl: HTMLElement;
	private gridEl: HTMLElement;
	private chipsEl: HTMLElement;
	private statusEl: HTMLElement;
	private scrollEl: HTMLElement;
	private loadingEl!: HTMLElement;
	private sentinelEl!: HTMLElement;

	private masonry: MasonryLayout;
	private keyScope: Scope;
	private io: IntersectionObserver | null = null;

	private bookmark = "";
	private loading = false;
	private srcBuf: ArrayBuffer | null = null;
	private srcMime = "image/png";
	/** 原始位元組（JPEG 版被 Pinterest 退件時的退路） */
	private rawBuf: ArrayBuffer | null = null;
	private rawMime = "image/png";
	private useRaw = false;
	/** 拿不到 gif 而被略過的動態 pin 數 */
	private skipped = 0;
	private statusBase = "";
	private readonly isMobile = Platform.isMobile;

	/** 關閉後通知宿主（PeekOverlay）——讓它恢復自己的輸入狀態 */
	onClosed?: () => void;

	constructor(
		private app: App,
		private srcUrl: string,
		private srcTitle: string,
		/**
		 * 取得來源圖 bytes。由 main.ts 注入（共用 fetchImageBlob）：
		 * vault 圖走 adapter.readBinary、外部圖走 requestUrl——裸 fetch() 會被 CORS 擋。
		 */
		private loadBlob: () => Promise<Blob>
	) {
		const isMobile = this.isMobile;

		// 自己的按鍵作用域，疊在 PeekOverlay 之上：
		// Esc/Space 先關這一層；方向鍵吃掉，避免底下的預覽跟著換圖
		this.keyScope = new Scope();
		const swallow = (evt: KeyboardEvent) => {
			evt.preventDefault();
			return false;
		};
		this.keyScope.register([], "Escape", (evt) => {
			evt.preventDefault();
			this.close();
			return false;
		});
		this.keyScope.register([], " ", (evt) => {
			evt.preventDefault();
			this.close();
			return false;
		});
		this.keyScope.register([], "ArrowLeft", swallow);
		this.keyScope.register([], "ArrowRight", swallow);
		this.app.keymap.pushScope(this.keyScope);

		this.rootEl = activeDocument.body.createDiv({ cls: "ip-pin-layer" });

		const backdrop = this.rootEl.createDiv({ cls: "ip-pin-backdrop" });
		backdrop.addEventListener("click", () => this.close());

		const panel = this.rootEl.createDiv({ cls: "ip-pin-panel" });

		// 標題列
		const header = panel.createDiv({ cls: "ip-pin-header" });
		const backBtn = header.createDiv({
			cls: "qp-btn",
			attr: { "aria-label": "Back (Esc)" },
		});
		setIcon(backBtn, isMobile ? "chevron-left" : "x");
		backBtn.addEventListener("click", () => this.close());

		const titleEl = header.createDiv({ cls: "ip-pin-title" });
		titleEl.setText(t("Pinterest visual search"));

		// 主體：左＝原始查詢圖，中＝可拖曳分隔桿，右＝結果（捲動容器）
		const body = panel.createDiv({ cls: "ip-pin-body" });

		const origEl = body.createDiv({ cls: "ip-pin-orig" });
		const origImg = origEl.createEl("img", { cls: "ip-pin-orig-img" });
		origImg.src = this.srcUrl;
		if (this.srcTitle) {
			origEl.createDiv({ cls: "ip-pin-orig-name" }).setText(this.srcTitle);
		}

		const splitter = body.createDiv({ cls: "ip-pin-splitter" });

		this.scrollEl = body.createDiv({ cls: "ip-pin-scroll" });
		this.statusEl = this.scrollEl.createDiv({ cls: "ip-pin-status" });
		this.chipsEl = this.scrollEl.createDiv({ cls: "ip-pin-chips" });
		this.gridEl = this.scrollEl.createDiv({ cls: "ip-pin-grid" });

		// 手機：把原圖併進結果捲動區最上方 → 往下捲時跟著捲走，不佔死畫面
		if (isMobile) this.scrollEl.insertBefore(origEl, this.scrollEl.firstChild);

		// 桌機：拖曳分隔桿調整左欄寬度
		if (!isMobile) this.bindSplitter(splitter, body, origEl);

		// 手機固定 2 欄；桌機依寬度自動
		this.masonry = new MasonryLayout(
			this.gridEl,
			10,
			150,
			isMobile ? 2 : 0
		);

		void this.search();
	}

	/** 拖曳分隔桿：調整左欄（原圖）寬度 */
	private bindSplitter(
		splitter: HTMLElement,
		body: HTMLElement,
		origEl: HTMLElement
	) {
		const onMove = (e: MouseEvent) => {
			const rect = body.getBoundingClientRect();
			const w = Math.max(
				160,
				Math.min(rect.width - 240, e.clientX - rect.left)
			);
			origEl.style.flex = `0 0 ${w}px`;
		};
		const onUp = () => {
			activeDocument.body.style.cursor = "";
			activeDocument.removeEventListener("mousemove", onMove);
			activeDocument.removeEventListener("mouseup", onUp);
		};
		splitter.addEventListener("mousedown", (e) => {
			e.preventDefault();
			activeDocument.body.style.cursor = "col-resize";
			activeDocument.addEventListener("mousemove", onMove);
			activeDocument.addEventListener("mouseup", onUp);
		});
	}

	// ---------- 搜尋 ----------

	/** 讀一次來源圖 bytes 並快取（分頁時重複用）
	    上傳前先正規化成標準 JPEG：直接送 gif/webp/過大的圖，Pinterest 會回 400（code 2651）。 */
	private async ensureBuf() {
		if (this.srcBuf) return;
		const blob = await this.loadBlob();
		if (!blob || !blob.size) throw new Error(t("Could not read this image"));
		this.rawBuf = await blob.arrayBuffer();
		this.rawMime = blob.type || "image/png";

		const jpeg = await toJpeg(blob);
		if (jpeg) {
			this.srcBuf = jpeg;
			this.srcMime = "image/jpeg";
		} else {
			this.srcBuf = this.rawBuf;
			this.srcMime = this.rawMime;
		}
	}

	/** 打一頁（bookmark 空 = 第一頁）；raw=true 改送原始位元組（JPEG 版被退件時的退路） */
	private async fetchPage(bookmark: string, raw = false) {
		await this.ensureBuf();
		const buf = (raw ? this.rawBuf : this.srcBuf) as ArrayBuffer;
		const mime = raw ? this.rawMime : this.srcMime;
		const { boundary, body } = buildMultipart(
			{ x: "0", y: "0", w: "1", h: "1", page_size: "80" },
			"image",
			"image.jpg",
			buf,
			mime
		);
		const url =
			PIN_ENDPOINT +
			(bookmark ? "?bookmark=" + encodeURIComponent(bookmark) : "");
		return requestUrl({
			url,
			method: "PUT",
			headers: {
				"Content-Type": "multipart/form-data; boundary=" + boundary,
				"User-Agent": PIN_UA,
			},
			body,
			throw: false,
		});
	}

	/** 把 Pinterest 的錯誤訊息挖出來（400 通常會附原因） */
	private errMsg(res: { text?: string }): string {
		const j = (parseJsonLoose(res?.text || "") || {}) as Record<string, string>;
		const m = j.message || j.error_message;
		if (m) return String(m).slice(0, 120);
		const t = String(res?.text || "")
			.replace(/\s+/g, " ")
			.trim();
		return t ? t.slice(0, 120) : "";
	}

	private async search() {
		this.statusEl.setText(t("Searching…"));
		this.useRaw = false;
		this.skipped = 0;
		try {
			let res = await this.fetchPage("");
			// JPEG 版被退件（多半是 400）→ 用原始位元組再試一次
			if (res.status !== 200 && this.rawBuf && this.srcMime !== this.rawMime) {
				const res2 = await this.fetchPage("", true);
				if (res2.status === 200) {
					res = res2;
					this.useRaw = true;
				}
			}
			if (res.status !== 200) {
				const why = this.errMsg(res);
				this.statusEl.setText(
					t("Pinterest responded with status {{status}} (private API — image too large / unsupported format / rate limited)", { status: res.status }) + (why ? " · " + why : "")
				);
				return;
			}
			const j = parseJsonLoose(res.text) || {};
			const pins = (j.data as PinItem[]) || [];
			if (!pins.length) {
				this.statusEl.setText(t("No similar images found"));
				return;
			}
			this.bookmark = (j.bookmark as string) || "";
			this.renderChips((j.annotations as unknown[]) || []);

			if (this.isMobile) {
				// 手機畫面窄，說明文字佔掉一整行——只留一個「往下捲」的箭頭
				this.statusEl.empty();
				const hint = this.statusEl.createDiv({ cls: "ip-pin-scrollhint" });
				setIcon(hint, "chevron-down");
				this.statusBase = "";
			} else {
				this.statusBase =
					t("Similar results · broader as you scroll · hover to preview/download");
				this.statusEl.setText(this.statusBase);
			}
			this.renderPins(pins, false);
			this.setupInfiniteScroll();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.statusEl.setText(t("Search failed: {{msg}}", { msg }));
		}
	}

	/** 無限捲動：底部哨兵進視野就抓下一頁 */
	private setupInfiniteScroll() {
		this.loadingEl = this.scrollEl.createDiv({ cls: "ip-pin-loading" });
		this.sentinelEl = this.scrollEl.createDiv({ cls: "ip-pin-sentinel" });
		this.io?.disconnect();
		this.io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) void this.autoLoad();
			},
			{ root: this.scrollEl, rootMargin: "400px 0px" }
		);
		this.io.observe(this.sentinelEl);
	}

	private async autoLoad() {
		if (this.loading || !this.bookmark) return;
		this.loading = true;
		this.loadingEl.setText(t("Loading…"));
		try {
			// 沿用第一頁成功的那種上傳格式
			const res = await this.fetchPage(this.bookmark, this.useRaw);
			const j = parseJsonLoose(res.text) || {};
			this.bookmark = (j.bookmark as string) || "";
			this.renderPins((j.data as PinItem[]) || [], true);
		} catch (e) {
			/* 失敗就下次捲動再試 */
		}
		this.loading = false;

		if (!this.bookmark) {
			this.loadingEl.setText(t("— no more results —"));
			this.io?.disconnect();
			return;
		}
		this.loadingEl.setText("");

		// 結果還沒填滿視窗就繼續補
		requestAnimationFrame(() => {
			if (!this.bookmark || this.loading) return;
			const r = this.sentinelEl.getBoundingClientRect();
			const cr = this.scrollEl.getBoundingClientRect();
			if (r.top < cr.bottom + 400) void this.autoLoad();
		});
	}

	// ---------- 繪製 ----------

	private pinUrl(p: PinItem): string {
		return p.id
			? "https://www.pinterest.com/pin/" + p.id + "/"
			: p.link || p.tracked_link || "";
	}

	private openExternal(url: string) {
		if (!url) return;
		window.open(url, "_blank");
	}

	/** 主題關鍵字 chip → 開 Pinterest 關鍵字搜尋（比視覺相似更廣） */
	private renderChips(annotations: unknown[]) {
		this.chipsEl.empty();
		for (const a of annotations) {
			const term =
				typeof a === "string"
					? a
					: ((a as Record<string, string>)?.name ??
						(a as Record<string, string>)?.term ??
						(a as Record<string, string>)?.query);
			if (!term) continue;
			const chip = this.chipsEl.createEl("button", {
				cls: "ip-pin-chip",
				text: "# " + term,
			});
			chip.setAttr("title", t("Search \"{{term}}\" on Pinterest (broader)", { term }));
			chip.addEventListener("click", () =>
				this.openExternal(
					"https://www.pinterest.com/search/pins/?q=" +
						encodeURIComponent(term)
				)
			);
		}
	}

	private renderPins(pins: PinItem[], append: boolean) {
		if (!append) {
			this.masonry.clear();
			this.skipped = 0;
		}

		for (const p of pins) {
			const thumb =
				p.image_medium_url || p.image_large_url || p.image_square_url;
			if (!thumb) continue;
			const big = p.image_large_url || thumb;

			const cell = this.gridEl.createDiv({ cls: "ip-pin-cell" });
			const im = cell.createEl("img");

			// 用已知尺寸先占好高度（不必等圖載入就能正確排版）
			const dim = p.image_medium_size_pixels || p.image_large_size_pixels;
			if (dim?.width && dim?.height) {
				im.style.aspectRatio = `${dim.width} / ${dim.height}`;
			}
			im.src = thumb;
			im.loading = "lazy";
			if (p.title) im.setAttr("title", p.title);

			// 背景探測原檔 gif：是動圖 → 換成會動的原檔 + GIF 角標；
			// 是動態 pin 卻拿不到 gif（只有影片）→ 不顯示，直接把格子移除。
			void probePinGif(big).then((gif) => {
				if (!cell.isConnected) return;
				if (gif) {
					p._gifUrl = gif; // 下載時抓原始 gif
					im.removeAttribute("loading");
					im.src = gif;
					cell.createDiv({ cls: "ip-pin-gif-badge", text: "GIF" });
					return;
				}
				if (pinIsAnimated(p)) {
					this.skipped++;
					this.masonry.remove(cell);
					if (this.statusBase) {
						this.statusEl.setText(
							`${this.statusBase} · ${t("skipped {{n}} animated pins without a gif", { n: this.skipped })}`
						);
					}
				}
			});

			// 桌機：點格子 = 直接到 Pinterest 原網址
			// 手機：沒有 hover，點格子先叫出動作按鈕（再點一次收起）
			cell.addEventListener("click", () => {
				if (this.isMobile) {
					cell.classList.toggle("ip-pin-cell-active");
					return;
				}
				this.openExternal(this.pinUrl(p));
			});

			// 動作按鈕：到原網址 / 下載（桌機 hover 浮現，手機點格子後顯示）
			const actions = cell.createDiv({ cls: "ip-pin-actions" });

			const openBtn = actions.createEl("button", { cls: "ip-pin-act" });
			setIcon(openBtn, "external-link");
			openBtn.setAttr("title", t("Open on Pinterest"));
			openBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openExternal(this.pinUrl(p));
			});

			const dlBtn = actions.createEl("button", { cls: "ip-pin-act" });
			setIcon(dlBtn, "download");
			dlBtn.setAttr("title", t("Download and insert into note"));
			dlBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.downloadAndInsert(p);
			});

			this.masonry.add(cell);
		}
	}

	// ---------- 下載並插入目前筆記 ----------

	private async downloadAndInsert(pin: PinItem) {
		// gif pin → 抓探測到的原始 .gif，不要存成靜態縮圖
		const url =
			pin._gifUrl ||
			pin.image_large_url ||
			pin.image_medium_url ||
			pin.image_square_url;
		if (!url) {
			new Notice(t("No downloadable image URL"));
			return;
		}

		try {
			new Notice(t("Downloading…"));
			const res = await requestUrl({ url, method: "GET" });

			const extM = url.split("?")[0].match(/\.(jpe?g|png|gif|webp)$/i);
			const ext = extM ? extM[1].toLowerCase() : "jpg";

			if (!this.app.vault.getAbstractFileByPath("img")) {
				try {
					await this.app.vault.createFolder("img");
				} catch (e) {
					/* 已存在（競態）就忽略 */
				}
			}

			// 絕不覆蓋既有圖片：同名就加序號
			const base = "pinterest_" + (pin.id || Date.now());
			let imgPath = `img/${base}.${ext}`;
			let n = 1;
			while (this.app.vault.getAbstractFileByPath(imgPath)) {
				imgPath = `img/${base}_${n}.${ext}`;
				n++;
			}
			await this.app.vault.createBinary(imgPath, res.arrayBuffer);
			await this.insertEmbed(imgPath);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(t("Download failed: {{msg}}", { msg }));
		}
	}

	/**
	 * 把 ![[img/…]] 放進目前筆記。
	 * 編輯模式插在游標處；閱讀模式沒有有效游標（會落在檔頭），改接到檔尾；
	 * Canvas 或非 md 檔則只留檔案，不亂寫。
	 */
	private async insertEmbed(imgPath: string) {
		const embed = `![[${imgPath}]]`;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.getMode() === "source" && view.editor) {
			view.editor.replaceSelection(embed + "\n");
			new Notice("Inserted: " + imgPath);
			return;
		}

		const file = this.app.workspace.getActiveFile();
		if (file && file.extension === "md") {
			await this.app.vault.append(file, "\n" + embed + "\n");
			new Notice("Appended to " + file.basename + ": " + imgPath);
			return;
		}

		new Notice("Saved (no active note): " + imgPath);
	}

	// ---------- 關閉 ----------

	close() {
		this.app.keymap.popScope(this.keyScope);
		this.io?.disconnect();
		this.masonry.destroy();
		this.rootEl.remove();
		this.onClosed?.();
	}
}
