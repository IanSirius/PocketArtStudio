"use strict";

const {
  ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath
} = require("obsidian");

const viewType = "pocket-art-studio-fragments";
const defaults = { folder: "随身输入艺术/片段", website: "" };
const attachmentLimit = 10 * 1024 * 1024;
const libraryMarker = "pocket-art-fragment";
const contextMarker = "<!-- pocket-art:context -->";
const media = {
  文字: "有哪一句话，你今天听见了却一直记得？",
  声音: "那声音停下以后，你还听见了什么？",
  画面: "如果只留下一个画面，光落在了哪里？"
};
const stageNames = { draft: "私人记录", ready: "待分享" };
const attachmentExtensions = /\.(?:jpe?g|png|webp|gif|avif|mp3|m4a|wav|ogg|opus|flac|aac|webm)$/i;

function text(value) {
  return typeof value === "string" ? value : "";
}

function put(parent, tag, value = "", className = "") {
  const element = parent.ownerDocument.createElement(tag);
  if (value) element.textContent = value;
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

function control(parent, label, onClick, className = "") {
  const element = put(parent, "button", label, className);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

function field(parent, label, tag, hint) {
  const wrapper = put(parent, "label", "", "pas-field");
  put(wrapper, "span", label);
  const input = put(wrapper, tag);
  if (hint) input.placeholder = hint;
  return input;
}

function selectOptions(select, values) {
  for (const [value, label] of values) put(select, "option", label).value = value;
}

function safeFolder(value) {
  const raw = text(value).trim();
  const parts = raw.split("/");
  if (!raw || raw.length > 150 || parts.some((part) =>
    !part || part.startsWith(".") || part.endsWith(".") || part !== part.trim() ||
    /[<>:"\\|?*\[\]#^%\u0000-\u001f]/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  )) throw new Error("请填写知识库里的相对文件夹路径，例如 随身输入艺术/片段。");
  return normalizePath(raw);
}

function safeWebsite(value) {
  const raw = text(value).trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Use the same message for unsupported and malformed URLs. */ }
  throw new Error("请填写有效的 HTTPS 网站地址。");
}

function filePart(value, fallback) {
  return text(value).replace(/[<>:"/\\|?*\[\]#^%\u0000-\u001f]/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 75).trim() || fallback;
}

function boundedInput(value, max) {
  return Array.from(text(value).trim()).slice(0, max).join("");
}

function makeMarkdown(fragment) {
  const quoted = (value) => JSON.stringify(value);
  const lines = [
    "---", `pocket_art: ${libraryMarker}`, `pocket_art_title: ${quoted(fragment.title)}`,
    `pocket_art_medium: ${quoted(fragment.medium)}`, "pocket_art_stage: draft",
    `pocket_art_created: ${quoted(fragment.created)}`, "---", "",
    `# ${fragment.title}`, "", fragment.body
  ];
  if (fragment.prompt || fragment.related || fragment.attachment) {
    lines.push("", contextMarker);
    if (fragment.prompt) lines.push("", "## 记录时的问题", "", fragment.prompt);
    if (fragment.related) lines.push("", "## 相关笔记", "", fragment.related);
    if (fragment.attachment) lines.push("", "## 附件", "", `!${fragment.attachment}`);
    lines.push("", "<!-- /pocket-art:context -->");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function shareableText(markdown) {
  const noProperties = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const noContext = noProperties.split(contextMarker, 1)[0];
  return noContext.trimStart().replace(/^# [^\r\n]+\r?\n/, "").trim();
}

async function ensureFolder(vault, folder) {
  let current = "";
  for (const part of folder.split("/")) {
    current = current ? `${current}/${part}` : part;
    let entry = vault.getAbstractFileByPath(current);
    if (!entry) {
      try { entry = await vault.createFolder(current); }
      catch (error) {
        entry = vault.getAbstractFileByPath(current);
        if (!entry) throw error;
      }
    }
    if (!(entry instanceof TFolder)) throw new Error(`「${current}」已经是一个文件。`);
  }
}

class PocketArtStudio extends Plugin {
  async onload() {
    const saved = await this.loadData() || {};
    this.settings = { ...defaults };
    try { this.settings.folder = safeFolder(saved.folder || defaults.folder); } catch {}
    try { this.settings.website = safeWebsite(saved.website); } catch {}
    this.registerView(viewType, (leaf) => new FragmentView(leaf, this));
    this.addRibbonIcon("book-open", "打开片段册", () => this.run(() => this.openLibrary()));
    this.addCommand({
      id: "open-fragment-library", name: "打开片段册",
      callback: () => this.run(() => this.openLibrary())
    });
    this.addCommand({
      id: "capture-fragment", name: "记录生活片段",
      callback: () => new CaptureModal(this, this.app.workspace.getActiveFile()).open()
    });
    this.addCommand({
      id: "prepare-fragment-to-share", name: "整理供分享的文字",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!this.fragmentInfo(file)) return false;
        if (!checking) this.run(() => this.openShare(file));
        return true;
      }
    });
    this.addSettingTab(new PocketSettings(this));
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.metadataCache.on("changed", (file) => {
        if (this.isInFolder(file)) this.refreshLibrary();
      }));
      for (const event of ["delete", "rename"]) {
        this.registerEvent(this.app.vault.on(event, (file, oldPath) => {
          if (this.isInFolder(file) || oldPath?.startsWith(this.settings.folder + "/")) this.refreshLibrary();
        }));
      }
    });
  }

  run(operation) {
    Promise.resolve().then(operation).catch((error) => new Notice(error.message || "操作暂时未完成，请再试一次。"));
  }

  isInFolder(file) {
    return file instanceof TFile && file.path.startsWith(this.settings.folder + "/");
  }

  fragmentInfo(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return null;
    const props = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (props?.pocket_art !== libraryMarker) return null;
    return {
      file, title: text(props.pocket_art_title) || file.basename,
      medium: Object.hasOwn(media, props.pocket_art_medium) ? props.pocket_art_medium : "文字",
      stage: props.pocket_art_stage === "ready" ? "ready" : "draft",
      permission: props.pocket_art_permission === "excerpt" ? "excerpt" : "inspiration",
      date: text(props.pocket_art_created) || new Date(file.stat.ctime).toISOString()
    };
  }

  listFragments() {
    return this.app.vault.getMarkdownFiles()
      .filter((file) => this.isInFolder(file))
      .map((file) => this.fragmentInfo(file)).filter(Boolean)
      .sort((left, right) => right.date.localeCompare(left.date) || left.title.localeCompare(right.title));
  }

  refreshLibrary() {
    for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
      if (leaf.view instanceof FragmentView) leaf.view.renderEntries();
    }
  }

  async openLibrary() {
    let [leaf] = this.app.workspace.getLeavesOfType(viewType);
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(true) || this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: viewType, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async saveFragment({ title, body, medium, prompt, relatedFile, attachment }) {
    const created = new Date().toISOString();
    const fallback = body.split(/[\n。！？]/, 1)[0] || attachment?.name.replace(/\.[^.]+$/, "") || "生活片段";
    const heading = boundedInput(title || fallback, 80).replace(/[\r\n]+/g, " ");
    const related = relatedFile instanceof TFile
      ? this.app.fileManager.generateMarkdownLink(relatedFile, this.settings.folder + "/片段.md") : "";
    const folder = this.settings.folder;
    const { vault, fileManager } = this.app;
    await ensureFolder(vault, folder);
    const stamp = created.slice(0, 19).replace("T", " ").replace(/:/g, "");
    const stem = `${stamp} ${filePart(heading, "生活片段")}`;
    let path = `${folder}/${stem}.md`;
    for (let number = 2; vault.getAbstractFileByPath(path); number += 1) path = `${folder}/${stem} (${number}).md`;
    let mediaFile;
    if (attachment) {
      const mediaFolder = `${folder}/附件`;
      await ensureFolder(vault, mediaFolder);
      const unique = crypto.randomUUID();
      const extension = attachment.name.match(attachmentExtensions)?.[0];
      if (!extension) throw new Error("这个附件格式暂时无法保存。");
      const attachmentStem = filePart(attachment.name.slice(0, -extension.length), "附件");
      mediaFile = await vault.createBinary(`${mediaFolder}/${unique} ${attachmentStem}${extension}`, await attachment.arrayBuffer());
    }
    try {
      return await vault.create(path, makeMarkdown({
        title: heading, body, medium, prompt, created, related,
        attachment: mediaFile ? fileManager.generateMarkdownLink(mediaFile, path) : ""
      }));
    } catch (error) {
      if (mediaFile) await vault.trash(mediaFile, true).catch(() => {});
      throw error;
    }
  }

  async openNote(file) {
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  async openShare(file) {
    const info = this.fragmentInfo(file);
    if (!info) throw new Error("请先打开片段册里的记录。");
    const markdown = await this.app.vault.read(file);
    new ShareModal(this, info, shareableText(markdown)).open();
  }
}

class FragmentView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.query = "";
    this.filter = "";
  }
  getViewType() { return viewType; }
  getDisplayText() { return "随身片段册"; }
  getIcon() { return "book-open"; }
  async onOpen() {
    const panel = this.contentEl;
    panel.replaceChildren();
    panel.classList.add("pas-library");
    const header = put(panel, "header", "", "pas-mast");
    put(header, "p", "随身输入艺术", "pas-kicker");
    put(header, "h1", "生活片段册");
    put(header, "p", "收下一点当时没来得及多想的生活。");
    control(header, "记录一个片段", () => {
      new CaptureModal(this.plugin, this.app.workspace.getActiveFile()).open();
    }, "mod-cta");
    const filters = put(panel, "div", "", "pas-filters");
    const search = field(filters, "搜索片段", "input", "片段名");
    search.type = "search";
    search.value = this.query;
    const medium = field(filters, "按类型筛选", "select");
    selectOptions(medium, [["", "所有类型"], ...Object.keys(media).map((name) => [name, name]), ["ready", "待分享"]]);
    medium.value = this.filter;
    search.addEventListener("input", () => { this.query = search.value; this.renderEntries(); });
    medium.addEventListener("change", () => { this.filter = medium.value; this.renderEntries(); });
    this.entries = put(panel, "div", "", "pas-entries");
    this.renderEntries();
  }

  renderEntries() {
    if (!this.entries) return;
    const query = this.query.trim().toLocaleLowerCase();
    const fragments = this.plugin.listFragments().filter((entry) =>
      (!query || entry.title.toLocaleLowerCase().includes(query)) &&
      (!this.filter || this.filter === entry.medium || this.filter === entry.stage)
    );
    this.entries.replaceChildren();
    if (!fragments.length) {
      put(this.entries, "p", query || this.filter ? "没有符合条件的片段。" : "片段册还是空的。一句话、一张图或一点声音都可以开始。", "pas-empty");
    }
    for (const entry of fragments) {
      const card = put(this.entries, "article", "", "pas-entry");
      const meta = put(card, "div", "", "pas-entry-meta");
      put(meta, "span", entry.medium);
      put(meta, "span", stageNames[entry.stage]);
      put(card, "h2", entry.title);
      put(card, "time", entry.date.slice(0, 10));
      const buttons = put(card, "div", "", "pas-actions");
      control(buttons, "打开笔记", () => this.plugin.run(() => this.plugin.openNote(entry.file)));
      control(buttons, "准备分享", () => this.plugin.run(() => this.plugin.openShare(entry.file)), "clickable-icon pas-quiet");
    }
  }

  async onClose() { this.entries = null; }
}

class CaptureModal extends Modal {
  constructor(plugin, relatedFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.relatedFile = relatedFile;
  }
  onOpen() {
    this.titleEl.setText("记录生活片段");
    const root = this.contentEl;
    root.classList.add("pas-modal");
    const form = put(root, "form", "", "pas-form");
    const type = field(form, "这个片段更像", "select");
    selectOptions(type, Object.keys(media).map((name) => [name, name]));
    const promptBox = put(form, "p", media[type.value], "pas-question");
    type.addEventListener("change", () => { promptBox.textContent = media[type.value]; });
    const title = field(form, "标题（选填）", "input", "例如，打烊以后还亮的灯");
    title.maxLength = 80;
    const body = field(form, "你想留下什么", "textarea", "一句原话、一个场景，或一段尚未说清的记忆。");
    body.rows = 5;
    body.maxLength = 8000;
    const file = field(form, "附一张照片或一段音频（选填，最大 10 MB）", "input");
    file.type = "file";
    file.accept = "image/jpeg,image/png,image/webp,image/gif,image/avif,audio/*";
    let associate;
    if (this.relatedFile instanceof TFile && this.relatedFile.extension === "md") {
      const label = put(form, "label", "", "pas-check");
      associate = put(label, "input");
      associate.type = "checkbox";
      put(label, "span", `关联笔记「${this.relatedFile.basename}」`);
    }
    const footer = put(form, "div", "", "pas-actions");
    const save = put(footer, "button", "存入片段册", "mod-cta");
    save.type = "submit";
    control(footer, "取消", () => { if (!save.disabled) this.close(); });
    const status = put(form, "p", "", "pas-status");
    status.setAttribute("role", "status");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const attachment = file.files?.[0];
      const value = body.value.trim();
      status.textContent = "";
      if (!value && !attachment) {
        status.textContent = "写下一点内容，或选择一个附件。";
        body.focus();
        return;
      }
      if (attachment && (!attachment.size || attachment.size > attachmentLimit ||
          !attachmentExtensions.test(attachment.name) ||
          (attachment.type && !/^(image|audio)\//.test(attachment.type)))) {
        status.textContent = "请选择 10 MB 以内的常见照片或音频文件。";
        return;
      }
      save.disabled = true;
      try {
        const note = await this.plugin.saveFragment({
          title: title.value.trim(), body: value, medium: type.value,
          prompt: media[type.value], relatedFile: associate?.checked ? this.relatedFile : null, attachment
        });
        new Notice("已存入片段册。");
        this.close();
        this.plugin.run(() => this.plugin.openNote(note));
      } catch (error) {
        status.textContent = error.message || "暂时无法保存片段。";
        save.disabled = false;
      }
    });
    body.focus();
  }
  onClose() { this.contentEl.replaceChildren(); }
}

class ShareModal extends Modal {
  constructor(plugin, fragment, excerpt) {
    super(plugin.app);
    this.plugin = plugin;
    this.fragment = fragment;
    this.excerpt = excerpt;
  }
  onOpen() {
    this.titleEl.setText("整理供分享的文字");
    const root = this.contentEl;
    root.classList.add("pas-modal", "pas-form");
    put(root, "p", "保留你愿意说出去的句子。你可以改写、删去地点或姓名，再复制给需要的人。", "pas-muted");
    const draft = field(root, "准备分享的文字", "textarea", "照片和音频需在对方的投稿页面单独选择。");
    draft.rows = 7;
    draft.value = this.excerpt;
    const option = field(root, "希望素材怎样被使用", "select");
    selectOptions(option, [
      ["inspiration", "仅作为创作灵感"], ["excerpt", "可以商议在本项目中节选"]
    ]);
    option.value = this.fragment.permission;
    const footer = put(root, "div", "", "pas-actions");
    const status = put(root, "p", "", "pas-status");
    status.setAttribute("role", "status");
    const draftText = () => draft.value.trim();
    const copy = async (value, message) => {
      if (!value) {
        status.textContent = "先填写你愿意分享的文字。";
        return;
      }
      try {
        await draft.ownerDocument.defaultView.navigator.clipboard.writeText(value);
        status.textContent = message;
      } catch {
        status.textContent = "无法访问剪贴板。可直接选中文字复制。";
        draft.select();
      }
    };
    control(footer, "复制这段文字", () => copy(draftText(), "文字已复制。"), "mod-cta");
    control(footer, "标记为待分享", () => this.plugin.run(async () => {
      await this.app.fileManager.processFrontMatter(this.fragment.file, (props) => {
        props.pocket_art_stage = "ready";
        props.pocket_art_permission = option.value;
      });
      status.textContent = "已标记为待分享。对外分享前可再删改。";
    }));
    const note = put(root, "p", "", "pas-muted");
    const updateNote = () => {
      note.textContent = option.value === "excerpt"
        ? "投稿时可选择「允许节选」，并和艺术家确认具体用法。"
        : "投稿时可选择「仅作为灵感」，由艺术家用自己的方式表达。";
    };
    option.addEventListener("change", updateNote);
    updateNote();
    const ai = put(root, "details", "", "pas-ai");
    put(ai, "summary", "借 AI 追问一个细节");
    put(ai, "p", "你可以自己把提示词粘贴到 AI 工具里。");
    const include = put(ai, "label", "", "pas-check");
    const checked = put(include, "input");
    checked.type = "checkbox";
    put(include, "span", "把上面这段可分享文字也放进提示词");
    control(ai, "复制提示词", () => {
      const instruction = "请用中文问我一个简短、具体的问题，帮我回想一个生活片段的声音、画面或动作。保留我原来的说法，避免替我解释感受或补写细节。";
      const prompt = checked.checked && draftText() ? `${instruction}\n\n我选出的片段：\n${draftText()}` : instruction;
      copy(prompt, "提示词已复制。");
    });
    if (this.plugin.settings.website) {
      const link = put(root, "a", "打开 Pocket Art Studio 的征集页 ↗", "pas-link");
      link.href = this.plugin.settings.website;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  onClose() { this.contentEl.replaceChildren(); }
}

class PocketSettings extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }
  display() {
    const root = this.containerEl;
    root.replaceChildren();
    new Setting(root).setName("片段保存位置")
      .setDesc("知识库内的相对路径。新记录存入这里，已有笔记可以在 Obsidian 里移动。")
      .addText((input) => input.setValue(this.plugin.settings.folder).onChange((value) => this.update("folder", value, safeFolder)));
    new Setting(root).setName("Pocket Art Studio 网站")
      .setDesc("选填。可填写工作室主页或某份征集链接，分享窗口会显示打开入口。")
      .addText((input) => input.setPlaceholder("https://…").setValue(this.plugin.settings.website)
        .onChange((value) => this.update("website", value, safeWebsite)));
    this.status = put(root, "p", "", "pas-status");
    this.status.setAttribute("role", "status");
  }
  async update(name, value, validate) {
    try {
      const normalized = validate(value);
      const settings = { ...this.plugin.settings, [name]: normalized };
      this.plugin.settings = settings;
      await this.plugin.saveData(settings);
      this.status.textContent = "";
      this.plugin.refreshLibrary();
    } catch (error) {
      this.status.textContent = error.message;
    }
  }
}

module.exports = PocketArtStudio;
