import {
	App,
	FileSystemAdapter,
	Notice,
	TFile,
	Platform,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Scope,
	Setting,
	setIcon,
} from "obsidian";
import { PinterestPanel } from "./peek-pinterest";
import { t } from "./i18n.js";

interface QuickPeekSettings {
	dblclickToOpen: boolean;
	spaceToOpen: boolean;
	showActions: boolean;
	backdropBlur: boolean;
	/** 符合這些 CSS 選擇器的容器內的圖片不觸發預覽（逗號分隔） */
	excludeSelectors: string;
	/** 相關圖片 MOC 筆記路徑（以 ## 標題分組，群組內 ![[圖]]） */
	mocPath: string;
	/** 側欄顯示幾張相關縮圖 */
	relatedCount: number;
	/** 標題列顯示「找相似」按鈕（Pinterest 以圖搜圖，點了才連線） */
	pinterestSearch: boolean;
}

const DEFAULT_SETTINGS: QuickPeekSettings = {
	dblclickToOpen: true,
	spaceToOpen: true,
	showActions: true,
	backdropBlur: true,
	excludeSelectors: '[class*="lcp-"]',
	mocPath: "",
	relatedCount: 6,
	pinterestSearch: false,   // 逆向私有 API → 預設關閉（上架政策），設定可開
};

interface ResolvedImage {
	src: string;
	title: string;
	vaultPath: string | null;
}

/** MOC 解析：讀指定筆記，依 ## 標題分組，建立「圖片連結 → 群組」索引。
 *  圖片以 vault 內的檔名比對（不含資料夾），與 ![[檔名]] 對齊。 */
class MocIndex {
	// 標題 → 該群組下的圖片連結字串（原樣，例如 "sub/pic.png" 或 "pic.png"）
	private groups = new Map<string, string[]>();
	private mtime = 0;
	private path = "";

	constructor(private app: App) {}

	/** 必要時重建索引（檔案有變動才重讀）。回傳是否有可用的 MOC。 */
	async ensure(mocPath: string): Promise<boolean> {
		const p = (mocPath || "").trim();
		if (!p) {
			this.groups.clear();
			this.path = "";
			return false;
		}
		const file = this.app.vault.getAbstractFileByPath(p);
		if (!(file instanceof TFile)) {
			this.groups.clear();
			this.path = "";
			return false;
		}
		// 沒換檔、沒更動 → 沿用快取
		if (this.path === p && this.mtime === file.stat.mtime) return true;

		const text = await this.app.vault.cachedRead(file);
		this.parse(text);
		this.path = p;
		this.mtime = file.stat.mtime;
		return true;
	}

	private parse(text: string) {
		this.groups.clear();
		const lines = text.split(/\r?\n/);
		let current = "(ungrouped)";
		const embedRe = /!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
		for (const line of lines) {
			const h = line.match(/^#{1,6}\s+(.*)$/);
			if (h) {
				current = h[1].trim();
				if (!this.groups.has(current)) this.groups.set(current, []);
				continue;
			}
			let m: RegExpExecArray | null;
			while ((m = embedRe.exec(line)) !== null) {
				const link = m[1].trim();
				if (!this.groups.has(current)) this.groups.set(current, []);
				this.groups.get(current)!.push(link);
			}
		}
	}

	/** 取得與指定圖片同群組的其他圖片連結（用檔名比對）。 */
	relatedTo(vaultPath: string | null, fileName: string): string[] {
		const target = fileName.toLowerCase();
		for (const links of this.groups.values()) {
			const hit = links.some((l) => {
				const base = l.split("/").pop()?.toLowerCase() ?? l.toLowerCase();
				return base === target;
			});
			if (hit) {
				// 回傳同群組其他圖（排除自己）
				return links.filter((l) => {
					const base = l.split("/").pop()?.toLowerCase() ?? l.toLowerCase();
					return base !== target;
				});
			}
		}
		return [];
	}
}

/** 圖片允許出現的容器（筆記閱讀模式、Live Preview、Canvas、hover 預覽） */
/** Obsidian 桌面版存在但未列入公開型別的 API（見 README "internal APIs" 段落） */
interface AppWithDesktopInternals extends App {
	openWithDefaultApp?: (path: string) => void;
	showInFolder?: (path: string) => void;
}

type ShareMenuInstance = {
	popup: (opts: { window: unknown; x: number; y: number }) => void;
};
type ShareMenuCtor = new (opts: { filePaths: string[] }) => ShareMenuInstance;
interface ElectronRemoteLike {
	ShareMenu?: ShareMenuCtor;
	getCurrentWindow: () => unknown;
	require?: (module: string) => { ShareMenu?: ShareMenuCtor } | undefined;
}

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
};

function mimeFromPath(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXT[ext] ?? "image/png";
}

/** 取回圖片資料，全程不使用 fetch：
 *  vault 內檔案 → 官方 vault API 直接讀（桌面 app:// 與行動端 capacitor:// 皆適用）
 *  外部 http(s) → requestUrl（避開 CORS）
 *  data: URI → 手動解碼 */
async function fetchImageBlob(
	app: App,
	src: string,
	vaultPath: string | null
): Promise<Blob> {
	if (vaultPath) {
		const data = await app.vault.adapter.readBinary(vaultPath);
		return new Blob([data], { type: mimeFromPath(vaultPath) });
	}
	if (src.startsWith("data:")) {
		const match = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(src);
		if (!match) throw new Error("Malformed data URI");
		const type = match[1] || "image/png";
		if (match[2]) {
			const bin = atob(match[3]);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			return new Blob([bytes], { type });
		}
		return new Blob([decodeURIComponent(match[3])], { type });
	}
	if (src.startsWith("http")) {
		const res = await requestUrl({ url: src });
		const type = res.headers["content-type"]?.split(";")[0] ?? "image/png";
		return new Blob([res.arrayBuffer], { type });
	}
	throw new Error("Unsupported image source");
}

/* 只在 Canvas 生效（2026-08-01）。
   Obsidian 1.13 起，筆記內的圖片已有原生 lightbox，Peek 再插一手只會重複；
   但原生那套**不涵蓋 Canvas**，所以這裡專門補 Canvas 這一塊。 */
const CONTAINER_SELECTOR = ".canvas-wrapper";

export class PeekModule {
	plugin: any;
	app: App;
	settings: QuickPeekSettings = DEFAULT_SETTINGS;
	mocIndex!: MocIndex;

	constructor(plugin: any) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.mocIndex = new MocIndex(plugin.app);
	}

	/** 用 ![[連結]] 的檔名解析出 vault 內的圖片檔與資源網址 */
	resolveMocLink(link: string): { file: TFile; src: string } | null {
		const clean = link.split("#")[0].split("|")[0].trim();
		const file = this.app.metadataCache.getFirstLinkpathDest(clean, "");
		if (file instanceof TFile) {
			return { file, src: this.app.vault.getResourcePath(file) };
		}
		return null;
	}
	private overlay: PeekOverlay | null = null;
	private hoveredImg: HTMLImageElement | null = null;
	private downPos: { x: number; y: number } | null = null;
	private downTime = 0;
	/** 觸控雙點偵測 */
	private lastTap: { img: HTMLImageElement | null; time: number } = {
		img: null,
		time: 0,
	};

	async start() {
		this.loadSettings();

		// 追蹤目前懸停的圖片（給 Space 觸發用）
		this.plugin.registerDomEvent(activeDocument, "mouseover", (evt) => {
			const img = this.previewableImg(evt.target);
			if (img) this.hoveredImg = img;
		});
		this.plugin.registerDomEvent(activeDocument, "mouseout", (evt) => {
			if (evt.target === this.hoveredImg) this.hoveredImg = null;
		});

		// 記錄按下位置，用來區分「點」與「拖曳」
		this.plugin.registerDomEvent(
			activeDocument,
			"pointerdown",
			(evt) => {
				this.downPos = { x: evt.clientX, y: evt.clientY };
				this.downTime = Date.now();
			},
			{ capture: true }
		);

		// 桌面：雙擊開啟
		this.plugin.registerDomEvent(activeDocument, "dblclick", this.onDblClick, {
			capture: true,
		});
		// 觸控：雙點開啟（行動版的 dblclick 不可靠，自己偵測）
		this.plugin.registerDomEvent(activeDocument, "pointerup", this.onPointerUp, {
			capture: true,
		});

		this.plugin.registerDomEvent(window, "keydown", this.onKeyDown, {
			capture: true,
		});

		this.plugin.addCommand({
			id: "peek-image",
			name: "Preview hovered or selected image",
			callback: () => {
				const img = this.hoveredImg ?? this.focusedCanvasImg();
				if (img) this.open(img);
			},
		});
	}

	stop() {
		this.overlay?.destroy();
	}

	// ---------- 事件 ----------

	private onDblClick = (evt: MouseEvent) => {
		if (!this.settings.dblclickToOpen || this.overlay) return;
		if (evt.defaultPrevented || evt.button !== 0) return;
		// 保留 Obsidian 原生的修飾鍵行為
		if (evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;

		const img = this.previewableImg(evt.target);
		if (!img) return;

		evt.preventDefault();
		evt.stopPropagation();
		this.open(img);
	};

	private onPointerUp = (evt: PointerEvent) => {
		if (evt.pointerType === "mouse") return;
		if (!this.settings.dblclickToOpen || this.overlay) return;

		const img = this.previewableImg(evt.target);
		if (!img) {
			this.lastTap.img = null;
			return;
		}
		// 拖曳不算點
		if (this.downPos) {
			const dx = evt.clientX - this.downPos.x;
			const dy = evt.clientY - this.downPos.y;
			if (dx * dx + dy * dy > 100) {
				this.lastTap.img = null;
				return;
			}
		}
		// 長按不算點（保留 Obsidian 的長按選單）
		if (this.downTime && Date.now() - this.downTime > 450) {
			this.lastTap.img = null;
			return;
		}

		// 筆記內：單點直接開啟；Canvas：維持雙點（單點留給選取節點）
		const inCanvas = !!img.closest(".canvas-wrapper, .canvas-node");
		if (!inCanvas) {
			evt.preventDefault();
			evt.stopPropagation();
			this.open(img);
			return;
		}

		const now = Date.now();
		if (this.lastTap.img === img && now - this.lastTap.time < 350) {
			this.lastTap = { img: null, time: 0 };
			evt.preventDefault();
			evt.stopPropagation();
			this.open(img);
		} else {
			this.lastTap = { img, time: now };
		}
	};

	private onKeyDown = (evt: KeyboardEvent) => {
		// 覆層開啟中：按鍵全部由覆層的 Scope 處理（見 PeekOverlay 建構子），
		// 這裡只負責不要讓「Space 開啟預覽」的邏輯重複觸發
		if (this.overlay) {
			return;
		}

		if (!this.settings.spaceToOpen || evt.code !== "Space") return;
		if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
		// 正在輸入文字時不攔截空白鍵
		if (this.isEditingContext()) return;

		const img = this.hoveredImg ?? this.focusedCanvasImg();
		if (!img || !img.isConnected) return;

		evt.preventDefault();
		evt.stopPropagation();
		this.open(img);
	};

	private isEditingContext(): boolean {
		const el = activeDocument.activeElement;
		if (!el) return false;
		if (el.instanceOf(HTMLInputElement) || el.instanceOf(HTMLTextAreaElement))
			return true;
		return (
			(el.instanceOf(HTMLElement) && el.isContentEditable) ||
			!!el.closest(".cm-editor")
		);
	}

	/** Canvas 中被選取（focused）的圖片節點，模仿無邊記「選取後按 Space」 */
	private focusedCanvasImg(): HTMLImageElement | null {
		const img = activeDocument.querySelector<HTMLImageElement>(
			".canvas-node.is-focused .canvas-node-content img"
		);
		// 一樣要通過完整檢查（排除選擇器、vault 圖檔限制），
		// 否則選到連結卡片節點按 Space 會誤開卡片裡的圖
		return img ? this.previewableImg(img) : null;
	}

	// requireLoaded=true（點擊開啟用）：圖必須已下載完（naturalWidth>0），才不會點到破圖。
	// requireLoaded=false（建 ←→ 清單用）：放寬此限，讓「還沒 lazy 載入」的圖也進清單，
	//   方向鍵才能循環到筆記內全部的圖（切到時才在 overlay 載入）。
	private previewableImg(
		target: EventTarget | null,
		requireLoaded = true
	): HTMLImageElement | null {
		if (!(target instanceof HTMLImageElement)) return null;
		if (target.closest(".image-peek-overlay")) return null;
		// 不攔截超連結內的圖片
		if (target.closest("a")) return null;
		// 不攔截其他外掛的元件（例如連結卡片的預覽圖）
		const exclude = this.settings.excludeSelectors?.trim();
		if (exclude) {
			try {
				if (target.closest(exclude)) return null;
			} catch {
				// 選擇器寫錯就略過，不要讓整個外掛掛掉
			}
		}
		if (!target.closest(CONTAINER_SELECTOR)) return null;
		if (requireLoaded && target.naturalWidth === 0) return null;
		// Canvas 上只預覽 vault 內的圖片檔（app:// 資源）。
		// 連結卡片類外掛的圖片是 base64 或外部網址，一律放行不攔截。
		if (target.closest(".canvas-wrapper, .canvas-node")) {
			const src = target.currentSrc || target.src;
			if (!src.startsWith("app:")) return null;
		}
		return target;
	}

	// ---------- 開啟 ----------

	open(img: HTMLImageElement) {
		this.overlay?.destroy();

		// 收集同一個視圖內的所有圖片，給 ← → 導覽
		const root = img.closest(CONTAINER_SELECTOR);
		const list = root
			? // 在筆記／Canvas 容器內：收「全部」可預覽圖（含尚未 lazy 載入、捲出視窗的）→ 循環筆記內所有圖
			  Array.from(root.querySelectorAll("img")).filter((el) =>
					this.previewableImg(el, false)
			  )
			: // 找不到已知容器 → 退回整份 body，但只收「已載入且可見」的（避免抓到全 app 的隱藏圖）
			  Array.from(activeDocument.body.querySelectorAll("img")).filter(
					(el) =>
						this.previewableImg(el) &&
						el.getBoundingClientRect().width > 0
			  );
		const index = Math.max(0, list.indexOf(img));

		this.overlay = new PeekOverlay(this, list.length ? list : [img], index);
		this.overlay.onClosed = () => (this.overlay = null);
	}

	/** 從 img 元素反推 vault 內路徑與顯示名稱 */
	resolveImage(img: HTMLImageElement): ResolvedImage {
		const src = img.currentSrc || img.src;

		// 側欄點擊產生的臨時 img：直接帶 vault 路徑，優先處理
		const mocPath = img.getAttribute("data-qp-moc-path");
		if (mocPath) {
			const f = this.app.vault.getAbstractFileByPath(mocPath);
			if (f instanceof TFile) {
				return {
					src: this.app.vault.getResourcePath(f),
					title: f.name,
					vaultPath: f.path,
				};
			}
		}

		// 1. 筆記內嵌：<span class="internal-embed" src="圖片.png">
		const embed = img.closest(".internal-embed[src]");
		const link = embed?.getAttribute("src");
		if (link) {
			const clean = decodeURIComponent(link.split("#")[0].split("|")[0]);
			const file = this.app.metadataCache.getFirstLinkpathDest(
				clean,
				this.app.workspace.getActiveFile()?.path ?? ""
			);
			if (file) {
				return {
					src: this.app.vault.getResourcePath(file),
					title: file.name,
					vaultPath: file.path,
				};
			}
		}

		// 2. Canvas 檔案節點：用節點標籤上的檔名反查
		const label = img
			.closest(".canvas-node")
			?.querySelector(".canvas-node-label")
			?.textContent?.trim();
		if (label) {
			const file = this.app.metadataCache.getFirstLinkpathDest(label, "");
			if (file) {
				return {
					src: this.app.vault.getResourcePath(file),
					title: file.name,
					vaultPath: file.path,
				};
			}
		}

		// 3. app:// 資源網址 → 還原成 vault 相對路徑
		try {
			const url = new URL(src);
			if (url.protocol === "app:") {
				let p = decodeURIComponent(url.pathname);
				if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // Windows 磁碟機
				const adapter = this.app.vault.adapter;
				const basePath =
					adapter instanceof FileSystemAdapter
						? adapter.getBasePath()
						: null;
				if (basePath && p.startsWith(basePath)) {
					const rel = p.slice(basePath.length).replace(/^[/\\]+/, "");
					return {
						src,
						title: rel.split("/").pop() ?? rel,
						vaultPath: rel,
					};
				}
				return { src, title: p.split("/").pop() ?? t("Image"), vaultPath: null };
			}
			// 4. 外部圖片
			const name = url.pathname.split("/").pop();
			return { src, title: name || url.hostname, vaultPath: null };
		} catch {
			return { src, title: "Image", vaultPath: null };
		}
	}

	loadSettings() {
		const st = this.plugin.state;
		st.peek = Object.assign({}, DEFAULT_SETTINGS, st.peek);
		this.settings = st.peek;
	}
	async saveSettings() {
		await this.plugin.saveState();
	}
}

// ---------------------------------------------------------------- Overlay

class PeekOverlay {
	onClosed: (() => void) | null = null;

	private rootEl: HTMLElement;
	private backdropEl: HTMLElement;
	private panelEl: HTMLElement;
	private stageEl: HTMLElement;
	private imgEl: HTMLImageElement;
	private titleEl: HTMLElement;
	private counterEl: HTMLElement;
	private actionsEl: HTMLElement;
	private sidebarEl: HTMLElement;
	private relatedEl: HTMLElement;

	private scale = 1;
	private tx = 0;
	private ty = 0;
	private closing = false;

	/** 多點觸控狀態 */
	private pointers = new Map<number, { x: number; y: number }>();
	private lastPinchDist = 0;
	private lastMid: { x: number; y: number } | null = null;
	private panStart: { x: number; y: number; tx: number; ty: number } | null =
		null;
	private tapMoved = false;
	private lastStageTap = 0;
	/** 手機下滑關閉：本次手勢累積的垂直位移（>0 = 往下） */
	private dismissDy = 0;

	private keyScope: Scope;
	private currentInfo: ResolvedImage | null = null;
	/** 第二層：Pinterest 找相似（未開啟時為 null） */
	private pinPanel: PinterestPanel | null = null;

	constructor(
		private plugin: QuickPeekPlugin,
		private list: HTMLImageElement[],
		private index: number
	) {
		// 推入自己的按鍵作用域：預覽開啟期間，方向鍵／Space／Esc 由覆層獨佔，
		// Canvas 的「方向鍵移動節點」等快捷鍵不會再收到事件（與 Modal 同機制）
		this.keyScope = new Scope();
		this.keyScope.register([], "ArrowLeft", (evt) => {
			evt.preventDefault();
			this.navigate(-1);
			return false;
		});
		this.keyScope.register([], "ArrowRight", (evt) => {
			evt.preventDefault();
			this.navigate(1);
			return false;
		});
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
		plugin.app.keymap.pushScope(this.keyScope);

		const doc = activeDocument.body;

		/* 外觀對齊 Obsidian 1.13 的原生 lightbox（2026-08-01）：
		   直接沿用原生的 class 名稱，樣式就整套繼承 —— 不必自己複製一份數值，
		   Obsidian 之後微調 lightbox 也會自動跟上。
		   使用者針對原生寫的 snippet（例如隱藏檔名）與我們加的動作膠囊
		   （.lightbox .gn-lb-actions）也會一併生效。
		   ⚠️ 代價是綁在私有 class 上；認不得就退回 .qp-* 的樣式，不會壞掉。 */
		this.rootEl = doc.createDiv({ cls: "image-peek-overlay lightbox" });
		if (plugin.settings.backdropBlur) this.rootEl.addClass("qp-blur");

		this.backdropEl = this.rootEl.createDiv({ cls: "qp-backdrop lightbox-bg" });
		this.backdropEl.addEventListener("click", () => this.close());

		this.panelEl = this.rootEl.createDiv({ cls: "qp-panel lightbox-content" });

		// 主內容區：左舞台 + 右側欄
		const mainEl = this.panelEl.createDiv({ cls: "qp-main" });
		const leftEl = mainEl.createDiv({ cls: "qp-left" });

		// 標題列（移到左側上方）
		const header = leftEl.createDiv({ cls: "qp-header lightbox-titlebar" });
		// lightbox 是全螢幕、不可拖曳 → 不再綁標題列拖曳

		const closeBtn = header.createDiv({
			cls: "qp-btn qp-close modal-close-button mod-raised clickable-icon",
			attr: { "aria-label": "Close (Esc / Space)" },
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.close());

		this.titleEl = header.createDiv({ cls: "qp-title lightbox-titlebar-text" });

		// 手機的動作列是「底部膠囊」，必須掛在面板上、不能掛在標題列底下：
		// 標題列在手機是 absolute，會變成子元素的 containing block，
		// 膠囊的 bottom 定位就會相對那條 42px 的標題列，等於被吸到畫面頂端去。
		this.actionsEl = Platform.isMobile
			? this.panelEl.createDiv({ cls: "qp-actions" })
			: header.createDiv({ cls: "qp-actions" });

		// 舞台
		this.stageEl = leftEl.createDiv({ cls: "qp-stage lightbox-media" });
		const wrapEl = this.stageEl.createDiv({ cls: "media-wrapper" });
		this.imgEl = wrapEl.createEl("img", { cls: "qp-img" });
		this.counterEl = leftEl.createDiv({ cls: "qp-counter" });

		// 右側欄：相關圖片
		this.sidebarEl = mainEl.createDiv({ cls: "qp-sidebar" });
		const relTitle = this.sidebarEl.createDiv({ cls: "qp-sidebar-title" });
		relTitle.setText("Related");
		this.relatedEl = this.sidebarEl.createDiv({ cls: "qp-related-grid" });
		this.sidebarEl.style.display = "none"; // 預設隱藏，有相關圖才顯示

		// 桌機：四邊 + 四角皆可拖曳調整視窗大小（圖片跟著縮放）
		if (!Platform.isMobile) this.buildResizeHandles();

		this.bindStageEvents();
		this.show(this.index, true);
	}

	// ---------- 顯示某一張 ----------

	private show(index: number, animateFromSource: boolean) {
		this.index = (index + this.list.length) % this.list.length;
		const srcImg = this.list[this.index];
		const info = this.plugin.resolveImage(srcImg);
		this.currentInfo = info;

		this.scale = 1;
		this.tx = 0;
		this.ty = 0;
		this.applyTransform(false);

		this.imgEl.src = info.src;

		// 載入相關圖片（同 MOC 群組）。非同步，不阻塞主圖顯示
		void this.loadRelated(info);
		this.titleEl.setText(info.title);
		this.counterEl.setText(
			this.list.length > 1 ? `${this.index + 1} / ${this.list.length}` : ""
		);
		this.buildActions(info);

		if (animateFromSource) {
			this.animateIn(srcImg);
		}
	}

	private buildActions(info: ResolvedImage) {
		this.actionsEl.empty();
		if (!this.plugin.settings.showActions) return;

		// 找相似（Pinterest 以圖搜圖）：第二層面板，點了才連線——不預先打 API
		if (this.plugin.settings.pinterestSearch) {
			const similarBtn = this.actionsEl.createDiv({
				cls: "qp-btn",
				attr: { "aria-label": "Find similar images" },
			});
			setIcon(similarBtn, "search");
			similarBtn.addEventListener("click", () => this.openPinterest(info));
		}

		// 分享（macOS 桌面用系統分享選單；行動端用系統分享面板）
		const canShareDesktop =
			Platform.isDesktop && Platform.isMacOS && !!info.vaultPath;
		const canShareMobile =
			Platform.isMobile && typeof navigator.share === "function";
		if (canShareDesktop || canShareMobile) {
			const shareBtn = this.actionsEl.createDiv({
				cls: "qp-btn",
				attr: { "aria-label": "Share" },
			});
			setIcon(shareBtn, "share");
			shareBtn.addEventListener("click", () => {
				void this.shareImage(info, shareBtn);
			});
		}

		// 複製圖片（所有圖片皆可，含外部圖片）
		const copyBtn = this.actionsEl.createDiv({
			cls: "qp-btn",
			attr: { "aria-label": "Copy image" },
		});
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", () => {
			void this.copyImage();
		});

		// 以下動作僅 vault 內圖片、桌面版
		const vaultPath = info.vaultPath;
		if (!vaultPath || !Platform.isDesktop) return;

		const app = this.plugin.app as AppWithDesktopInternals;
		const openBtn = this.actionsEl.createDiv({
			cls: "qp-btn",
			attr: { "aria-label": "Open in default app" },
		});
		setIcon(openBtn, "external-link");
		openBtn.addEventListener("click", () => {
			app.openWithDefaultApp?.(vaultPath);
		});

		const revealBtn = this.actionsEl.createDiv({
			cls: "qp-btn",
			attr: {
				"aria-label": Platform.isMacOS ? "Reveal in Finder" : "Show in file explorer",
			},
		});
		setIcon(revealBtn, "folder");
		revealBtn.addEventListener("click", () => {
			app.showInFolder?.(vaultPath);
		});
	}

	/** 開第二層：Pinterest 找相似。重複點擊不會疊出第二個面板 */
	private openPinterest(info: ResolvedImage) {
		if (this.pinPanel) return;
		const app = this.plugin.app;
		const panel = new PinterestPanel(app, info.src, info.title, () =>
			// 共用取圖路徑：vault 圖讀 binary、外部圖走 requestUrl（避開 CORS）
			fetchImageBlob(app, info.src, info.vaultPath)
		);
		panel.onClosed = () => {
			this.pinPanel = null;
		};
		this.pinPanel = panel;
	}

	/** 叫出系統分享：macOS 桌面 → Apple 分享選單；行動端 → 系統分享面板。
	 *  （桌機用 window.require('electron') 取 ShareMenu；已 gate + try/catch + 手機安全，
	 *   此寫法在獨立版 Image Peek 已通過上架審查，故保留。） */
	private async shareImage(info: ResolvedImage, anchor: HTMLElement) {
		// --- macOS 桌面：Electron 原生 ShareMenu ---
		if (Platform.isDesktop) {
			try {
				if (!Platform.isMacOS || !info.vaultPath)
					throw new Error(t("System share is not supported on this platform"));
				const w = window as Window & {
					require?: (module: string) => unknown;
				};
				const electron = w.require?.("electron") as
					| { remote?: ElectronRemoteLike }
					| undefined;
				const remote =
					electron?.remote ??
					(w.require?.("@electron/remote") as
						| ElectronRemoteLike
						| undefined);
				const ShareMenu =
					remote?.ShareMenu ?? remote?.require?.("electron")?.ShareMenu;
				const adapter = this.plugin.app.vault.adapter;
				const basePath =
					adapter instanceof FileSystemAdapter
						? adapter.getBasePath()
						: null;
				if (!ShareMenu || !basePath || !remote)
					throw new Error(t("Could not open the system share sheet"));

				const absPath = `${basePath}/${info.vaultPath}`;
				const menu = new ShareMenu({ filePaths: [absPath] });
				const rect = anchor.getBoundingClientRect();
				menu.popup({
					window: remote.getCurrentWindow(),
					x: Math.round(rect.left),
					y: Math.round(rect.bottom + 4),
				});
			} catch (e) {
				console.error("Image Peek share failed", e);
				new Notice("System sharing is not supported on this platform");
			}
			return;
		}

		// --- 行動端：Web Share API（帶圖片檔） ---
		try {
			const blob = await fetchImageBlob(
				this.plugin.app,
				this.imgEl.src,
				info.vaultPath
			);
			const type = blob.type || "image/png";
			const ext = (type.split("/")[1] ?? "png").replace("jpeg", "jpg");
			const name = /\.[a-z0-9]+$/i.test(info.title)
				? info.title
				: `${info.title || "image"}.${ext}`;
			const file = new File([blob], name, { type });

			const shareData: ShareData = { files: [file], title: info.title };
			if (navigator.canShare?.(shareData)) {
				await navigator.share(shareData);
			} else if (typeof navigator.share === "function") {
				await navigator.share({ title: info.title, text: info.title });
			} else {
				throw new Error(t("Web Share is not supported"));
			}
		} catch (e) {
			if (e instanceof Error && e.name === "AbortError") return; // 使用者自己取消分享
			console.error("Image Peek share failed", e);
			new Notice("Could not share this image");
		}
	}

	/** 複製圖片到剪貼簿（一律轉成 PNG，剪貼簿 API 只收 PNG） */
	private async copyImage() {
		const toPng = (source: CanvasImageSource, w: number, h: number) =>
			new Promise<Blob>((res, rej) => {
				const canvas = activeDocument.createElement("canvas");
				canvas.width = w;
				canvas.height = h;
				canvas.getContext("2d")!.drawImage(source, 0, 0);
				canvas.toBlob(
					(b) => (b ? res(b) : rej(new Error(t("PNG conversion failed")))),
					"image/png"
				);
			});

		try {
			let blob: Blob;
			try {
				// 一般情況：直接從已載入的 <img> 畫到 canvas
				if (!this.imgEl.complete || !this.imgEl.naturalWidth)
					throw new Error(t("Image not loaded yet"));
				blob = await toPng(
					this.imgEl,
					this.imgEl.naturalWidth,
					this.imgEl.naturalHeight
				);
			} catch {
				// 跨網域圖片會污染 canvas：改抓原始資料再轉
				const bitmap = await createImageBitmap(
					await fetchImageBlob(
						this.plugin.app,
						this.imgEl.src,
						this.currentInfo?.vaultPath ?? null
					)
				);
				blob = await toPng(bitmap, bitmap.width, bitmap.height);
				bitmap.close();
			}
			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": blob }),
			]);
			new Notice("Image copied");
		} catch (e) {
			console.error("Image Peek copy failed", e);
			new Notice("Could not copy this image");
		}
	}

	/** 載入並渲染側欄的相關圖片（同 MOC 群組，隨機取樣） */
	private async loadRelated(info: ResolvedImage) {
		this.relatedEl.empty();
		this.sidebarEl.style.display = "none";

		const moc = this.plugin.settings.mocPath;
		if (!moc) return;

		const ok = await this.plugin.mocIndex.ensure(moc);
		if (!ok) return;

		const fileName = info.title; // resolveImage 的 title 即檔名
		const related = this.plugin.mocIndex.relatedTo(info.vaultPath, fileName);
		if (!related.length) return;

		// 隨機洗牌取前 N 張
		const shuffled = related.slice();
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
		}
		const max = this.plugin.settings.relatedCount;
		const pick = shuffled.slice(0, max);

		let shown = 0;
		for (const link of pick) {
			const resolved = this.plugin.resolveMocLink(link);
			if (!resolved) continue;
			const cell = this.relatedEl.createDiv({ cls: "qp-related-cell" });
			const thumb = cell.createEl("img", { cls: "qp-related-thumb" });
			thumb.src = resolved.src;
			thumb.loading = "lazy";
			cell.addEventListener("click", () => this.openByFile(resolved.file));
			shown++;
		}

		// 若同群組總數超過顯示數，補一個 "+N" 提示
		const remain = related.length - shown;
		if (remain > 0) {
			const more = this.relatedEl.createDiv({
				cls: "qp-related-cell qp-related-more",
			});
			more.setText("+" + remain);
		}

		if (shown > 0) this.sidebarEl.style.display = "";
	}

	/** 點側欄縮圖：把預覽切換到該圖（加進 list 並跳過去） */
	private openByFile(file: TFile) {
		const src = this.plugin.app.vault.getResourcePath(file);
		// 建一個臨時 img 當作 list 項，讓既有 show 流程能解析
		const tmp = activeDocument.createElement("img");
		tmp.src = src;
		tmp.setAttribute("data-qp-moc-path", file.path);
		this.list.push(tmp);
		this.show(this.list.length - 1, false);
	}

	navigate(dir: number) {
		if (this.list.length < 2) return;
		this.show(this.index + dir, false);
	}

	// ---------- 動畫 ----------

	/** FLIP：從來源縮圖的位置「長」到定位，模仿 Quick Look */
	private animateIn(srcImg: HTMLImageElement) {
		// 尊重系統「減少動態效果」設定：跳過 FLIP 動畫直接定位
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			this.rootEl.addClass("qp-open");
			return;
		}
		this.rootEl.addClass("qp-entering");

		const run = () => {
			const from = srcImg.getBoundingClientRect();
			const to = this.imgEl.getBoundingClientRect();
			if (from.width > 0 && to.width > 0) {
				const sx = from.width / to.width;
				const sy = from.height / to.height;
				const dx = from.left + from.width / 2 - (to.left + to.width / 2);
				const dy = from.top + from.height / 2 - (to.top + to.height / 2);
				this.imgEl.setCssStyles({
					transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
					opacity: "0.3",
				});
			}
			window.requestAnimationFrame(() => {
				this.rootEl.removeClass("qp-entering");
				this.rootEl.addClass("qp-open");
				this.imgEl.setCssStyles({
					transition:
						"transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms ease",
					transform: "",
					opacity: "1",
				});
				window.setTimeout(() => {
					this.imgEl.setCssStyles({ transition: "" });
				}, 280);
			});
		};

		if (this.imgEl.complete && this.imgEl.naturalWidth > 0) {
			window.requestAnimationFrame(run);
		} else {
			this.imgEl.addEventListener(
				"load",
				() => window.requestAnimationFrame(run),
				{ once: true }
			);
			this.imgEl.addEventListener(
				"error",
				() => this.rootEl.addClass("qp-open"),
				{ once: true }
			);
		}
	}

	close() {
		if (this.closing) return;
		this.closing = true;

		// 收回到來源縮圖
		const srcImg = this.list[this.index];
		const from = srcImg?.isConnected ? srcImg.getBoundingClientRect() : null;
		const to = this.imgEl.getBoundingClientRect();

		this.rootEl.removeClass("qp-open");
		this.rootEl.addClass("qp-closing");

		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)"
		).matches;
		if (!reduceMotion && from && from.width > 0 && to.width > 0) {
			// to 已含目前的 transform（縮放／平移／下滑位移），所以新的 transform
			// 必須「疊加」在現況上，而不是取代——否則收回前會先跳一下。
			const sx = from.width / to.width;
			const sy = from.height / to.height;
			const dx = from.left + from.width / 2 - (to.left + to.width / 2);
			const dy = from.top + from.height / 2 - (to.top + to.height / 2);
			this.imgEl.setCssStyles({
				transition:
					"transform 200ms cubic-bezier(0.4, 0, 0.6, 1), opacity 180ms ease",
				transform: `translate(${this.tx + dx}px, ${this.ty + dy}px) scale(${
					this.scale * sx
				}, ${this.scale * sy})`,
				opacity: "0",
			});
		}

		window.setTimeout(() => this.destroy(), reduceMotion ? 0 : 210);
	}

	destroy() {
		// 第二層若還開著，一起收掉（避免預覽關閉後留下孤兒層與它的 keyScope）
		this.pinPanel?.close();
		this.pinPanel = null;

		this.plugin.app.keymap.popScope(this.keyScope);
		this.rootEl.remove();
		this.onClosed?.();
	}

	// ---------- 縮放與平移 ----------

	/**
	 * 以畫面座標 (px, py) 為中心縮放 factor 倍。
	 * 下限鎖在 1（fit）：只能放大，不能縮到比原本顯示尺寸還小。
	 * 一旦捏回 1 就順手歸零位移，回到置中的 fit 狀態。
	 */
	private zoomAt(px: number, py: number, factor: number) {
		const rect = this.imgEl.getBoundingClientRect();
		const cx = px - (rect.left + rect.width / 2);
		const cy = py - (rect.top + rect.height / 2);
		const next = Math.min(8, Math.max(1, this.scale * factor));

		if (next === 1) {
			this.scale = 1;
			this.tx = 0;
			this.ty = 0;
			this.applyTransform(false);
			return;
		}

		const applied = next / this.scale;
		this.tx -= cx * (applied - 1);
		this.ty -= cy * (applied - 1);
		this.scale = next;
		this.applyTransform(false);
	}

	private toggleZoom() {
		if (this.scale !== 1 || this.tx || this.ty) {
			this.scale = 1;
			this.tx = 0;
			this.ty = 0;
		} else {
			this.scale = 2;
		}
		this.applyTransform(true);
	}

	/**
	 * 把面板從「flex 置中 + 尺寸由圖片撐開」鎖成絕對定位的明確幾何。
	 * 移動與調整大小都需要這一步，否則面板會一直被 flex 拉回正中央。
	 * 回傳鎖定當下的矩形。
	 */
	private lockPanelGeometry(): DOMRect {
		const rect = this.panelEl.getBoundingClientRect();
		this.panelEl.addClass("qp-sized");
		this.panelEl.setCssStyles({
			left: `${rect.left}px`,
			top: `${rect.top}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});
		return rect;
	}

	/** 桌機：拖標題列移動整個視窗 */
	private bindHeaderDrag(header: HTMLElement) {
		header.addClass("qp-draggable");
		header.addEventListener("pointerdown", (evt: PointerEvent) => {
			if (evt.button !== 0) return;
			// 點在按鈕上是要按按鈕，不是要拖視窗
			if ((evt.target as HTMLElement).closest(".qp-btn")) return;
			evt.preventDefault();

			const rect = this.lockPanelGeometry();
			const startX = evt.clientX;
			const startY = evt.clientY;
			const { left: L, top: T, width: W, height: H } = rect;

			activeDocument.body.style.cursor = "grabbing";

			const onMove = (e: PointerEvent) => {
				// 夾在視窗內，避免把面板拖到抓不回來
				const left = Math.max(
					0,
					Math.min(L + (e.clientX - startX), window.innerWidth - W)
				);
				const top = Math.max(
					0,
					Math.min(T + (e.clientY - startY), window.innerHeight - H)
				);
				this.panelEl.setCssStyles({ left: `${left}px`, top: `${top}px` });
			};
			const onUp = () => {
				activeDocument.body.style.cursor = "";
				activeDocument.removeEventListener("pointermove", onMove);
				activeDocument.removeEventListener("pointerup", onUp);
			};
			activeDocument.addEventListener("pointermove", onMove);
			activeDocument.addEventListener("pointerup", onUp);
		});
	}

	/** 桌機：四邊 + 四角的拖曳把手 */
	private buildResizeHandles() {
		const DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
		for (const dir of DIRS) {
			const grip = this.panelEl.createDiv({
				cls: `qp-resize qp-resize-${dir}`,
				attr: { "aria-label": "Resize" },
			});
			grip.addEventListener("pointerdown", (evt: PointerEvent) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.beginResize(dir, evt);
			});
		}
	}

	/**
	 * 調整視窗大小。
	 * 平常面板是 flex 置中、尺寸由圖片自然撐開（FLIP 動畫仰賴這點）；使用者一動手
	 * 就切成絕對定位（qp-sized），這樣「拉哪邊、動哪邊」，對邊維持不動——
	 * 若還留在 flex 置中，拉左邊會讓右邊跟著往內縮。
	 */
	private beginResize(dir: string, evt: PointerEvent) {
		const MIN_W = 320;
		const MIN_H = 240;

		const rect = this.lockPanelGeometry();

		// 拖曳期間鎖住游標：手指移出把手範圍時，游標不該跳回箭頭
		const CURSORS: Record<string, string> = {
			n: "ns-resize",
			s: "ns-resize",
			e: "ew-resize",
			w: "ew-resize",
			ne: "nesw-resize",
			sw: "nesw-resize",
			nw: "nwse-resize",
			se: "nwse-resize",
		};
		activeDocument.body.style.cursor = CURSORS[dir] ?? "";

		const startX = evt.clientX;
		const startY = evt.clientY;
		const { left: L, top: T, width: W, height: H } = rect;

		// 對邊座標，拖曳期間固定不動
		const RIGHT = L + W;
		const BOTTOM = T + H;

		const onMove = (e: PointerEvent) => {
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			let left = L;
			let top = T;
			let w = W;
			let h = H;

			if (dir.includes("e")) {
				w = Math.max(MIN_W, Math.min(W + dx, window.innerWidth - L));
			}
			if (dir.includes("s")) {
				h = Math.max(MIN_H, Math.min(H + dy, window.innerHeight - T));
			}
			if (dir.includes("w")) {
				// 左緣跟著游標，右緣釘住：夾在 [0, RIGHT - MIN_W]
				left = Math.max(0, Math.min(L + dx, RIGHT - MIN_W));
				w = RIGHT - left;
			}
			if (dir.includes("n")) {
				// 上緣跟著游標，下緣釘住：夾在 [0, BOTTOM - MIN_H]
				top = Math.max(0, Math.min(T + dy, BOTTOM - MIN_H));
				h = BOTTOM - top;
			}

			this.panelEl.setCssStyles({
				left: `${left}px`,
				top: `${top}px`,
				width: `${w}px`,
				height: `${h}px`,
			});
		};

		const onUp = () => {
			activeDocument.body.style.cursor = "";
			activeDocument.removeEventListener("pointermove", onMove);
			activeDocument.removeEventListener("pointerup", onUp);
		};
		activeDocument.addEventListener("pointermove", onMove);
		activeDocument.addEventListener("pointerup", onUp);
	}

	/** 手機且未放大時，單指拖曳是「下滑關閉」而不是平移 */
	private canDismiss(): boolean {
		return Platform.isMobile && this.scale === 1;
	}

	/** 拖不夠遠：彈回原位，還原黑底與控制列 */
	private cancelDismiss() {
		this.tx = 0;
		this.ty = 0;
		this.applyTransform(true);
		this.panelEl.removeClass("qp-dismissing");
		this.backdropEl.style.opacity = "";
	}

	private bindStageEvents() {
		// 滾輪縮放（以游標為中心）；trackpad 捏合在 Electron 會轉成 ctrl+wheel，同樣適用
		this.stageEl.addEventListener(
			"wheel",
			(evt: WheelEvent) => {
				evt.preventDefault();
				const speed = evt.ctrlKey ? 0.01 : 0.0022;
				this.zoomAt(evt.clientX, evt.clientY, Math.exp(-evt.deltaY * speed));
			},
			{ passive: false }
		);

		const el = this.stageEl;

		el.addEventListener("pointerdown", (evt: PointerEvent) => {
			if (evt.pointerType === "mouse" && evt.button !== 0) return;
			evt.preventDefault();
			el.setPointerCapture(evt.pointerId);
			this.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });

			if (this.pointers.size === 1) {
				this.panStart = {
					x: evt.clientX,
					y: evt.clientY,
					tx: this.tx,
					ty: this.ty,
				};
				this.tapMoved = false;
				this.imgEl.addClass("qp-grabbing");
			} else if (this.pointers.size === 2) {
				// 進入雙指捏合，停止單指平移
				this.panStart = null;
				const [a, b] = [...this.pointers.values()];
				this.lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
				this.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			}
		});

		el.addEventListener("pointermove", (evt: PointerEvent) => {
			if (!this.pointers.has(evt.pointerId)) return;
			this.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });

			if (this.pointers.size >= 2) {
				// 雙指：捏合縮放 + 跟隨中點平移
				const [a, b] = [...this.pointers.values()];
				const dist = Math.hypot(a.x - b.x, a.y - b.y);
				const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
				if (this.lastPinchDist > 0 && this.lastMid) {
					this.zoomAt(mid.x, mid.y, dist / this.lastPinchDist);
					this.tx += mid.x - this.lastMid.x;
					this.ty += mid.y - this.lastMid.y;
					this.applyTransform(false);
				}
				this.lastPinchDist = dist;
				this.lastMid = mid;
				this.tapMoved = true;
			} else if (this.panStart) {
				const dx = evt.clientX - this.panStart.x;
				const dy = evt.clientY - this.panStart.y;
				if (dx * dx + dy * dy > 64) this.tapMoved = true;

				if (this.canDismiss()) {
					// 手機且未放大：單指拖曳 = 下滑關閉手勢（圖跟手、背景漸淡）。
					// 過了 tapMoved 門檻才起作用，否則點按也會被當成手勢。
					if (!this.tapMoved) return;

					this.dismissDy = dy;
					this.tx = dx * 0.4; // 水平加阻尼，維持「往下丟」的方向感
					this.ty = dy;
					this.applyTransform(false);

					// 讓黑底與標題列/膠囊一起退場，才看得到底下的筆記
					this.panelEl.addClass("qp-dismissing");

					// 只有往下拖才淡出（往上拖單純跟手，放開會彈回）
					const p = Math.min(1, Math.max(0, dy) / 320);
					this.backdropEl.style.opacity = String(1 - p * 0.85);
				} else {
					// 一般平移（桌機，或手機已放大）
					this.tx = this.panStart.tx + dx;
					this.ty = this.panStart.ty + dy;
					this.applyTransform(false);
				}
			}
		});

		const endPointer = (evt: PointerEvent) => {
			if (!this.pointers.delete(evt.pointerId)) return;

			if (this.pointers.size < 2) {
				this.lastPinchDist = 0;
				this.lastMid = null;
			}
			if (this.pointers.size === 1) {
				// 捏合結束剩一指：重新錨定平移
				const [p] = [...this.pointers.values()];
				this.panStart = { x: p.x, y: p.y, tx: this.tx, ty: this.ty };
			} else if (this.pointers.size === 0) {
				this.panStart = null;
				this.imgEl.removeClass("qp-grabbing");

				// 下滑關閉：拖夠遠就關，不夠就彈回。
				// 要求 tapMoved，否則手指的細微抖動會被當成手勢，吃掉雙點放大。
				if (this.tapMoved && this.dismissDy !== 0) {
					const dy = this.dismissDy;
					this.dismissDy = 0;
					if (dy > 110) {
						this.close();
						return;
					}
					this.cancelDismiss();
					return;
				}
				this.dismissDy = 0;

				// 觸控雙點：fit ↔ 2x
				if (evt.pointerType !== "mouse" && !this.tapMoved) {
					const now = Date.now();
					if (now - this.lastStageTap < 320) {
						this.toggleZoom();
						this.lastStageTap = 0;
					} else {
						this.lastStageTap = now;
					}
				}
			}
		};
		el.addEventListener("pointerup", endPointer);
		el.addEventListener("pointercancel", endPointer);

		// 滑鼠雙擊：fit ↔ 2x（觸控用上面的雙點偵測，避免重複觸發）
		if (!Platform.isMobile) {
			this.imgEl.addEventListener("dblclick", () => this.toggleZoom());
		}
	}

	private applyTransform(animated: boolean) {
		this.imgEl.setCssStyles({
			transition: animated ? "transform 180ms ease" : "",
			transform: `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`,
		});
		if (animated) {
			window.setTimeout(
				() => this.imgEl.setCssStyles({ transition: "" }),
				200
			);
		}
	}
}

// ---------------------------------------------------------------- Settings


/* 設定區塊：由 src/main.js 的統一設定頁呼叫 */
export function renderPeekSettings(containerEl: HTMLElement, plugin: any) {
	const st = plugin.state;
	st.peek = Object.assign({}, DEFAULT_SETTINGS, st.peek);
	const s = st.peek;
	const save = () => plugin.saveState();

	new Setting(containerEl)
		.setName(t('Click an image to open the preview'))
		.setDesc(t('Desktop: double-click (single click keeps native behavior). Mobile: single tap in notes, double tap on Canvas'))
		.addToggle((t: any) => t.setValue(s.dblclickToOpen !== false).onChange((v: boolean) => { s.dblclickToOpen = v; save(); }));

	new Setting(containerEl)
		.setName(t('Press Space to open the preview'))
		.setDesc(t('Press Space while hovering an image (or with an image node selected on Canvas)'))
		.addToggle((t: any) => t.setValue(s.spaceToOpen !== false).onChange((v: boolean) => { s.spaceToOpen = v; save(); }));

	new Setting(containerEl)
		.setName(t('Show action buttons'))
		.setDesc(t('Share / copy / open-in-system buttons in the preview window'))
		.addToggle((t: any) => t.setValue(s.showActions !== false).onChange((v: boolean) => { s.showActions = v; save(); }));

	new Setting(containerEl)
		.setName(t('Background blur'))
		.setDesc(t('Turn off on low-end devices for better performance'))
		.addToggle((t: any) => t.setValue(s.backdropBlur !== false).onChange((v: boolean) => { s.backdropBlur = v; save(); }));

	new Setting(containerEl)
		.setName(t('Pinterest visual search'))
		.setDesc(t('Show a visual search button in the preview window'))
		.addToggle((t: any) => t.setValue(s.pinterestSearch !== false).onChange((v: boolean) => { s.pinterestSearch = v; save(); }));

	new Setting(containerEl)
		.setName(t('Excluded images (CSS selectors)'))
		.setDesc(t('Images matching these selectors will not trigger the preview'))
		.addText((t: any) => t.setValue(s.excludeSelectors || '').onChange((v: string) => { s.excludeSelectors = v; save(); }));

	new Setting(containerEl)
		.setName(t('MOC note for related images'))
		.setDesc(t('Grouped by ## headings; the sidebar shows other images in the same group. Empty = sidebar off'))
		.addText((t: any) => t.setValue(s.mocPath || '').onChange((v: string) => { s.mocPath = v; save(); }));

	new Setting(containerEl)
		.setName(t('Number of related images in the sidebar'))
		.addSlider((sl: any) => sl.setLimits(1, 12, 1).setValue(s.relatedCount || 6).setDynamicTooltip()
			.onChange((v: number) => { s.relatedCount = v; save(); }));
}
