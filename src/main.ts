import {
	App,
	Editor,
	FileSystemAdapter,
	MarkdownView,
	Notice,
	Plugin,
	normalizePath,
	TextFileView,
	TFile,
	TAbstractFile,
	TFolder,
	Vault,
	WorkspaceWindow,
} from "obsidian";
import {
	AttachmentManagementPluginSettings,
	DEFAULT_SETTINGS,
	SETTINGS_ROOT_INFOLDER,
	SETTINGS_ROOT_NEXTTONOTE,
	SETTINGS_VARIABLES_DATES,
	SETTINGS_VARIABLES_NOTENAME,
	SETTINGS_VARIABLES_NOTEPATH,
	SettingTab,
} from "./settings";
import * as path from "path";
import {
	debugLog,
	getTAbstractFileByPathDepth,
	isCanvasFile,
	isMarkdownFile,
	isPastedImage,
	stripPaths,
} from "./utils";

export default class AttachmentManagementPlugin extends Plugin {
	settings: AttachmentManagementPluginSettings;
	adapter: FileSystemAdapter;
	originalObsAttachPath: string;

	async onload() {
		await this.loadSettings();

		const pkg = require("../package.json");
		console.log(
			`Plugin loading: ${pkg.name} ${pkg.version} BUILD_ENV=${process.env.BUILD_ENV}`
		);
		this.adapter = this.app.vault.adapter as FileSystemAdapter;
		this.backupConfigs();

		this.registerEvent(
			// not working while drop file to text view
			this.app.vault.on("create", (file: TAbstractFile) => {
				// only processing create of file, ignore folder creation
				if (!(file instanceof TFile)) {
					return;
				}
				// https://github.com/reorx/obsidian-paste-image-rename/blob/master/src/main.ts#LL81C23-L81C23
				// if the file is created more than 1 second ago, the event is most likely be fired on vault initialization when starting Obsidian app, ignore it
				const timeGapMs = new Date().getTime() - file.stat.ctime;
				if (timeGapMs > 1000) {
					return;
				}
				// ignore markdown and canvas file.
				if (isMarkdownFile(file) || isCanvasFile(file)) {
					return;
				}
				if (isPastedImage(file)) {
					debugLog("Image created", file.path);
					this.processPastedImg(file);
				}
			})
		);

		this.registerEvent(
			// while trigger rename event on rename a folder, for each file/folder in this renamed folder (include itself) will trigger this event
			this.app.vault.on(
				"rename",
				async (file: TAbstractFile, oldPath: string) => {
					debugLog("New path:", file.path);
					debugLog("Old path:", oldPath);

					if (
						!this.settings.autoRenameFolder ||
						!this.settings.attachmentPath.includes("${notename}") ||
						!this.settings.attachmentPath.includes("${notepath}")
					) {
						return;
					}

					if (file instanceof TFile) {
						let renameType = false;
						if (
							path.basename(oldPath, path.extname(oldPath)) ===
							path.basename(file.path, path.extname(file.path))
						) {
							// rename event of folder
							renameType = false;
							debugLog("renameType: Folder");
						} else {
							// rename event of file
							renameType = true;
							debugLog("renameType: File");
						}

						await this.onRename(file, oldPath, renameType);
					} else if (file instanceof TFolder) {
						// ignore folder
						const rf = file as TFolder;
						debugLog("folder:", rf.name);
						return;
					}
				}
			)
		);

		this.registerEvent(
			this.app.workspace.on(
				"editor-drop",
				(evt: DragEvent, editor: Editor, info: MarkdownView) => {
					if (evt === undefined) {
						return;
					}
					// only processing markdown file
					const activeFile = this.getActiveFile();
					if (
						activeFile === undefined ||
						activeFile.extension !== "md"
					) {
						return;
					}

					this.onDrop(evt, activeFile);
				}
			)
		);

		// register drop event on Dom element of root split (for editor normaly) for support no markdown files (like canvas)
		const w = this.app.workspace.rootSplit.win;
		this.registerDomEvent(w, "drop", (evt: DragEvent) => {
			if (evt === undefined) {
				return;
			}

			// ignore markdown files in this event listener
			const activeFile = this.getActiveFile();
			if (activeFile === undefined || activeFile.extension == "md") {
				return;
			}

			this.onDrop(evt, activeFile);
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));
	}

	async onDrop(ev: DragEvent, activeFile: TFile, dropType?: string) {
		const df = ev.dataTransfer;
		if (df === null) {
			return;
		}
		ev.preventDefault();
		debugLog("Drop files", df.files);
		debugLog("Drop items", df.items);

		const fItems = df.files;
		// const tItems = df.items;

		// list all drop files
		debugLog("fItems length:", fItems.length);
		for (let key = 0; key < fItems.length; key++) {
			let dropFile = fItems.item(key);
			if (dropFile === null) {
				debugLog("continue");
				continue;
			}
			if (
				dropFile.name !== "" &&
				(dropFile.type === "image/png" ||
					dropFile.type === "image/jpeg")
			) {
				debugLog("Drop File Name:", dropFile.name);
				const attachPath = this.getAttachmentPath(
					activeFile.basename,
					activeFile.parent?.path as string
				);
				this.updateAttachmentFolderConfig(attachPath);
				const name = this.getPastedImageFileName(activeFile.basename);
				let extension = "";
				dropFile.type === "image/png"
					? (extension = "png")
					: dropFile.type === "image/jpeg" && (extension = "jpeg");

				const buf = await	dropFile.arrayBuffer();

				if (!await this.adapter.exists(attachPath)) {
					await this.adapter.mkdir(attachPath);
				}

				// @ts-ignore
				const attachFile = await this.app.saveAttachment(
					name,
					extension,
					buf
				);

				debugLog("Save attachment to:", attachFile.path);
				this.restoreConfigs();
				const mdLink = await this.app.fileManager.generateMarkdownLink(
					attachFile,
					activeFile.path
				);
				debugLog("Markdown link:", mdLink);
			}
		}
	}

	async onRename(file: TAbstractFile, oldPath: string, renameType: boolean) {
		// if the renamed file was a attachment, skip
		const flag = await this.isAttachment(file, oldPath);
		if (flag) {
			return;
		}
		const rf = file as TFile;
		// oldnotename, oldnotepath
		const oldNotePath = path.posix.dirname(oldPath);
		const oldNoteName = path.posix.basename(
			oldPath,
			path.posix.extname(oldPath)
		);

		debugLog("Old Note Path:", oldNotePath);
		debugLog("Old Note Name:", oldNoteName);

		let oldAttachPath = this.getAttachmentPath(oldNoteName, oldNotePath);
		let newAttachPath = this.getAttachmentPath(
			rf.basename,
			rf.parent?.path as string
		);

		debugLog("Old attachment path:", oldAttachPath);
		debugLog("New attachment path:", newAttachPath);

		// if the attachment file does not exist, skip
		const exitsAttachPath = await this.adapter.exists(oldAttachPath);
		if (!exitsAttachPath) {
			return;
		}

		const strip = stripPaths(oldAttachPath, newAttachPath);
		if (strip === undefined) {
			new Notice(
				`Error rename path ${oldAttachPath} to ${newAttachPath}`
			);
			return;
		}

		const stripedOldAttachPath = strip.nsrc;
		const stripedNewAttachPath = strip.ndst;

		debugLog("nsrc:", stripedOldAttachPath);
		debugLog("ndst:", stripedNewAttachPath);

		const exitsDst = await this.adapter.exists(stripedNewAttachPath);
		if (exitsDst) {
			// if the file exists in the vault
			if (renameType) {
				new Notice(`Same file name exists: ${stripedNewAttachPath}`);
				return;
			} else {
				// for most case, this should not be happen, we just notice it.
				new Notice(`Folder already exists: ${stripedNewAttachPath}`);
				return;
			}
		} else {
			debugLog(
				"relative:",
				path.posix.relative(oldAttachPath, stripedOldAttachPath)
			);
			debugLog(
				"relative number:",
				path.posix
					.relative(oldAttachPath, stripedOldAttachPath)
					.split("/").length
			);
			// TODO: this may take a few long time to complete
			Vault.recurseChildren(this.app.vault.getRoot(), (cfile) => {
				if (cfile.path === stripedOldAttachPath) {
					this.app.fileManager.renameFile(
						cfile,
						stripedNewAttachPath
					);
					return;
				}
			});
		}
	}

	/**
	 * Check if the file is an attachment
	 * @param file - the file to check
	 * @param oldPath - the old path of this file
	 * @returns true if the file is an attachment, otherwise false
	 */
	async isAttachment(file: TAbstractFile, oldPath: string): Promise<boolean> {
		if (file instanceof TFile) {
			// checking the old state of the file
			const extension = path.posix.extname(oldPath);
			if (extension === ".md" || extension === ".canvas") {
				return false;
			}
		}
		// else if (file instanceof TFolder) {
		// 	//@ts-ignore
		// 	const obsmediadir = app.vault.getConfig("attachmentFolderPath");
		// 	switch (this.settings.saveAttE) {
		// 		case "inFolderBelow":
		// 			if (!oldPath.includes(this.settings.attachmentRoot)) {
		// 				return false;
		// 			}
		// 			break;
		// 		case "nextToNote":
		// 			break;
		// 		default:
		// 			if (obsmediadir === "/") {
		// 				// in vault root folder case, for this case, it will take a bunch time to rename
		// 				// search the all vault folders
		// 			} else if (obsmediadir === "./") {
		// 				// in current folder case
		// 				// search the oldPath
		// 			} else if (obsmediadir.match(/\.\/.+/g) !== null) {
		// 				// in subfolder case
		// 				// search the oldPath
		// 			} else {
		// 				// in specified folder case
		// 				return !oldPath.includes(obsmediadir);
		// 			}
		// 	}
		// }

		return true;
	}

	/**
	 * Post-processing of created img file.
	 * @param file - thie file to process
	 * @returns - none
	 */
	async processPastedImg(file: TFile) {
		debugLog("Craeted file:", file.name);

		const activeFile = this.getActiveFile();
		if (activeFile === undefined) {
			new Notice("Error: No active file found.");
			return;
		}
		const ext = activeFile.extension;

		debugLog("Active file name", activeFile.basename);
		debugLog("Active file path", activeFile.parent?.path);

		// TODO: what if activeFile.parent was undefined
		const attachPath = this.getAttachmentPath(
			activeFile.basename,
			activeFile.parent?.path as string
		);

		const attachName =
			this.getPastedImageFileName(activeFile.basename) +
			"." +
			file.extension;

		debugLog("New path of created file:", attachPath, attachName);

		// no using updatelink right now.
		this.renameFile(
			file,
			attachPath,
			attachName,
			activeFile.path,
			ext,
			true
		);
	}

	/**
	 * Rename the file spcified by `@param file`, and update the link of the file if specified updateLink
	 * @param file - file to rename
	 * @param attachPath - where to the renamed file will be move to
	 * @param attachName - name of the renamed file
	 * @param sourcePath - path of the associated activefile file
	 * @param extension - extension of associated activefile of file
	 * @param updateLink - whether to replace the link of renamed file
	 * @returns - none
	 */
	async renameFile(
		file: TFile,
		attachPath: string,
		attachName: string,
		sourcePath: string,
		extension: string,
		updateLink?: boolean
	) {
		// Make sure the path was craeted
		if (!(await this.adapter.exists(attachPath))) {
			await this.adapter.mkdir(attachPath);
		}

		debugLog("Souce path:", file.path);

		const dest = normalizePath(path.posix.join(attachPath, attachName));

		debugLog("Destination path:", dest);

		const oldLinkText = this.app.fileManager.generateMarkdownLink(
			file,
			sourcePath
		);
		const oldPath = file.path;
		const oldName = file.name;

		try {
			// this api will rename or move the file
			await this.app.fileManager.renameFile(file, dest);
			new Notice(`reanamed ${oldName} to ${attachName}`);
			// await this.adapter.rename(file.path, dst);
		} catch (err) {
			new Notice(`failed to move ${file.path} to ${dest}`);
			throw err;
		}

		if (!updateLink) {
			return;
		}

		// in case fileManager.renameFile may not update the internal link in the active file,
		// we manually replace the current line by manipulating the editor
		let newLinkText = await this.app.fileManager.generateMarkdownLink(
			file,
			sourcePath
		);
		debugLog("replace text", oldLinkText, newLinkText);

		const view = this.getActiveView();
		if (view === null) {
			new Notice(
				`Failed to replace linking in ${sourcePath}: no active editor`
			);
			return;
		}
		const contnet = view.getViewData();
		let val = "";
		switch (extension) {
			case "md":
				val = contnet.replace(oldLinkText, newLinkText);
				break;
			case "canvas":
				val = contnet.replace(
					`/(file\s*\:\s*\")${oldPath}(\")/`,
					`$1${dest}$2`
				);
				break;
		}

		view.setViewData(val, false);
		new Notice(`update 1 link in ${sourcePath}`);
	}

	/**
	 * Return the active text file, `md` or `canvas`
	 * @returns - the active file or undefined if no active file
	 */
	getActiveFile(): TFile | undefined {
		const view = this.getActiveView();
		const file = view?.file;
		debugLog("active file", file?.path);
		return file;
	}

	/**
	 * Return the active view of text file
	 * @returns - the active view of text file
	 */
	getActiveView(): TextFileView | null {
		return this.app.workspace.getActiveViewOfType(TextFileView);
	}

	/**
	 * Generate the attachment path with specified variables
	 * @param noteName - basename (without extension) of note
	 * @param notePath - path of note
	 * @returns attachment path
	 */
	getAttachmentPath(noteName: string, notePath: string): string {
		const root = this.getRootPath(notePath);
		const attachPath = path.join(
			root,
			this.settings.attachmentPath
				.replace(`${SETTINGS_VARIABLES_NOTEPATH}`, notePath)
				.replace(`${SETTINGS_VARIABLES_NOTENAME}`, noteName)
		);
		return normalizePath(attachPath);
	}

	/**
	 * Get root path to save attachment file
	 * @param notePath - path of note
	 * @returns root path to save attachment file
	 */
	getRootPath(notePath: string): string {
		let root = "";

		//@ts-ignore
		const obsmediadir = app.vault.getConfig("attachmentFolderPath");
		// debugLog("obsmediadir", obsmediadir);
		switch (this.settings.saveAttE) {
			case `${SETTINGS_ROOT_INFOLDER}`:
				root = path.posix.join(this.settings.attachmentRoot);
				break;
			case `${SETTINGS_ROOT_NEXTTONOTE}`:
				root = path.posix.join(
					notePath,
					this.settings.attachmentRoot.replace("./", "")
				);
				break;
			default:
				if (obsmediadir === "/") {
					// in vault root folder case
					root = obsmediadir;
				} else if (obsmediadir === "./") {
					// in current folder case
					root = path.posix.join(notePath);
				} else if (obsmediadir.match(/\.\/.+/g) !== null) {
					// in subfolder case
					root = path.posix.join(
						notePath,
						obsmediadir.replace("./", "")
					);
				} else {
					// in specified folder case
					root = obsmediadir;
				}
		}

		return root === "/" ? root : normalizePath(root);
	}

	/**
	 * Generate the image file name with specified variable
	 * @param noteName - basename (without extension) of note
	 * @returns image file name
	 */
	getPastedImageFileName(noteName: string) {
		const datetime = window.moment().format(this.settings.dateFormat);
		const imgName = this.settings.imageFormat
			.replace(`${SETTINGS_VARIABLES_DATES}`, datetime)
			.replace(`${SETTINGS_VARIABLES_NOTENAME}`, noteName);
		return imgName;
	}

	backupConfigs() {
		//@ts-ignore
		this.originalObsAttachPath = this.app.vault.getConfig(
			"attachmentFolderPath"
		);
	}

	restoreConfigs() {
		//@ts-ignore
		this.app.vault.setConfig(
			"attachmentFolderPath",
			this.originalObsAttachPath
		);
	}
	updateAttachmentFolderConfig(path: string) {
		//@ts-ignore
		this.app.vault.setConfig("attachmentFolderPath", path);
	}

	onunload() {
		this.restoreConfigs();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
