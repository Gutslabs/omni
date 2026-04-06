let actions = [];
let cachedActions = null;
let cachedActionsAt = 0;
let cachedActionsPromise = null;
let actionsCacheVersion = 0;
const ACTION_CACHE_TTL_MS = 1000;
const restrictedNewTabSources = new Map();
const fallbackFaviconUrl = chrome.runtime.getURL("assets/globe.svg");

// Category definitions for action toggles
const CATEGORIES = {
	'tab-management': ['new-tab', 'create-bookmark', 'mute', 'unmute', 'pin', 'unpin', 'reload', 'duplicate-tab', 'close-tab', 'close-window'],
	'new-links': [], // populated dynamically - any action with a .new URL
	'browser-actions': ['history', 'incognito', 'downloads', 'extensions', 'settings', 'manage-data', 'remove-all', 'remove-history', 'remove-cookies', 'remove-cache', 'remove-local-storage', 'remove-passwords'],
	'navigation': ['scroll-bottom', 'scroll-top', 'go-back', 'go-forward', 'fullscreen']
};

function isNewLink(action) {
	return action.url && (action.url.includes('.new') || action.url.includes('/new'));
}

function filterByCategories(allActions, disabledCategories) {
	if (!disabledCategories || disabledCategories.length === 0) return allActions;

	return allActions.filter(action => {
		for (const cat of disabledCategories) {
			if (cat === 'new-links' && isNewLink(action)) return false;
			if (CATEGORIES[cat] && CATEGORIES[cat].includes(action.action)) return false;
		}
		return true;
	});
}

function invalidateActionsCache() {
	cachedActions = null;
	cachedActionsAt = 0;
	cachedActionsPromise = null;
	actionsCacheVersion += 1;
}

async function getActionsSnapshot(force = false) {
	const version = actionsCacheVersion;
	const now = Date.now();
	if (!force && cachedActions && (now - cachedActionsAt) < ACTION_CACHE_TTL_MS) {
		return cachedActions;
	}
	if (!force && cachedActionsPromise) {
		return cachedActionsPromise;
	}

	cachedActionsPromise = buildActions().then((list) => {
		if (version !== actionsCacheVersion) {
			return list;
		}
		actions = list;
		cachedActions = list;
		cachedActionsAt = Date.now();
		return list;
	}).finally(() => {
		if (version === actionsCacheVersion) {
			cachedActionsPromise = null;
		}
	});

	return cachedActionsPromise;
}

function canUseContentScript(url) {
	if (!url || typeof url !== "string") return false;
	if (url.startsWith("https://chrome.google.com/webstore")) return false;
	if (url.startsWith("https://chromewebstore.google.com/")) return false;

	try {
		const protocol = new URL(url).protocol;
		return protocol === "http:" || protocol === "https:" || protocol === "file:";
	} catch (e) {
		return false;
	}
}

function getChromeFaviconUrl(url) {
	if (!url || typeof url !== "string") return fallbackFaviconUrl;

	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:" || parsedUrl.protocol === "file:") {
			const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
			faviconUrl.searchParams.set("pageUrl", parsedUrl.href);
			faviconUrl.searchParams.set("size", "32");
			return faviconUrl.toString();
		}
	} catch (e) {}

	return fallbackFaviconUrl;
}

function openOmniInNewTab(sourceTab) {
	const createOptions = { url: "./newtab.html" };
	if (sourceTab && sourceTab.windowId != null) createOptions.windowId = sourceTab.windowId;
	if (sourceTab && sourceTab.index != null) createOptions.index = sourceTab.index + 1;

	return chrome.tabs.create(createOptions).then((createdTab) => {
		if (createdTab && createdTab.id != null) {
			restrictedNewTabSources.set(createdTab.id, sourceTab && sourceTab.url ? sourceTab.url : "");
		}

		if (sourceTab && sourceTab.id != null) {
			chrome.tabs.remove(sourceTab.id).catch(() => {});
		}
	}).catch(() => {});
}

function ensureOmniInjected(tabId) {
	const manifest = chrome.runtime.getManifest();
	const contentScript = manifest.content_scripts && manifest.content_scripts[0];
	if (!contentScript) return Promise.reject(new Error("Missing content script config"));

	return chrome.scripting.insertCSS({
		target: { tabId },
		files: contentScript.css || []
	}).catch(() => {}).then(() => (
		chrome.scripting.executeScript({
			target: { tabId },
			files: contentScript.js || []
		})
	));
}

function openOmniOnTab(tab) {
	if (!tab || tab.id == null) return openOmniInNewTab(tab);
	if (canUseContentScript(tab.url)) {
		return chrome.tabs.sendMessage(tab.id, {request: "open-omni"}).catch(() => {
			return ensureOmniInjected(tab.id)
				.then(() => chrome.tabs.sendMessage(tab.id, {request: "open-omni"}))
				.catch(() => openOmniInNewTab(tab));
		});
	}
	return openOmniInNewTab(tab);
}

// Build the default action list (atomic, returns array)
const buildDefaultActions = async () => {
	const response = await getCurrentTab();
	const currentTab = response || {};
	const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	let muteaction = {title:"Mute tab", desc:"Mute the current tab", type:"action", action:"mute", emoji:true, emojiChar:"\uD83D\uDD07", keycheck:true, keys:['\u2325','\u21E7', 'M']};
	let pinaction = {title:"Pin tab", desc:"Pin the current tab", type:"action", action:"pin", emoji:true, emojiChar:"\uD83D\uDCCC", keycheck:true, keys:['\u2325','\u21E7', 'P']};
	if (currentTab.mutedInfo && currentTab.mutedInfo.muted) {
		muteaction = {title:"Unmute tab", desc:"Unmute the current tab", type:"action", action:"unmute", emoji:true, emojiChar:"\uD83D\uDD08", keycheck:true, keys:['\u2325','\u21E7', 'M']};
	}
	if (currentTab.pinned) {
		pinaction = {title:"Unpin tab", desc:"Unpin the current tab", type:"action", action:"unpin", emoji:true, emojiChar:"\uD83D\uDCCC", keycheck:true, keys:['\u2325','\u21E7', 'P']};
	}
	let defaults = [
			{title:"New tab", desc:"Open a new tab", type:"action", action:"new-tab", emoji:true, emojiChar:"\u2728", keycheck:true, keys:['\u2318','T']},
			{title:"Bookmark", desc:"Create a bookmark", type:"action", action:"create-bookmark", emoji:true, emojiChar:"\uD83D\uDCD5", keycheck:true, keys:['\u2318','D']},
			pinaction,
			{title:"Fullscreen", desc:"Make the page fullscreen", type:"action", action:"fullscreen", emoji:true, emojiChar:"\uD83D\uDDA5", keycheck:true, keys:['\u2318', 'Ctrl', 'F']},
			muteaction,
			{title:"Reload", desc:"Reload the page", type:"action", action:"reload", emoji:true, emojiChar:"\u267B\uFE0F", keycheck:true, keys:['\u2318','\u21E7', 'R']},
			{title:"Help", desc:"Get help with Omni on GitHub", type:"action", action:"url", url:"https://github.com/alyssaxuu/omni", emoji:true, emojiChar:"\uD83E\uDD14", keycheck:false},
			{title:"Compose email", desc:"Compose a new email", type:"action", action:"email", emoji:true, emojiChar:"\u2709\uFE0F", keycheck:true, keys:['\u2325','\u21E7', 'C']},
			{title:"Print page", desc:"Print the current page", type:"action", action:"print", emoji:true, emojiChar:"\uD83D\uDDA8\uFE0F", keycheck:true, keys:['\u2318', 'P']},
			{title:"New Notion page", desc:"Create a new Notion page", type:"action", action:"url", url:"https://notion.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-notion.png"), keycheck:false},
			{title:"New Sheets spreadsheet", desc:"Create a new Google Sheets spreadsheet", type:"action", action:"url", url:"https://sheets.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-sheets.png"), keycheck:false},
			{title:"New Docs document", desc:"Create a new Google Docs document", type:"action", action:"url", emoji:false, url:"https://docs.new", favIconUrl:chrome.runtime.getURL("assets/logo-docs.png"), keycheck:false},
			{title:"New Slides presentation", desc:"Create a new Google Slides presentation", type:"action", action:"url", url:"https://slides.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-slides.png"), keycheck:false},
			{title:"New form", desc:"Create a new Google Forms form", type:"action", action:"url", url:"https://forms.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-forms.png"), keycheck:false},
			{title:"New Medium story", desc:"Create a new Medium story", type:"action", action:"url", url:"https://story.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-medium.png"), keycheck:false},
			{title:"New GitHub repository", desc:"Create a new GitHub repository", type:"action", action:"url", url:"https://github.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-github.png"), keycheck:false},
			{title:"New GitHub gist", desc:"Create a new GitHub gist", type:"action", action:"url", url:"https://gist.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-github.png"), keycheck:false},
			{title:"New CodePen pen", desc:"Create a new CodePen pen", type:"action", action:"url", url:"https://pen.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-codepen.png"), keycheck:false},
			{title:"New Excel spreadsheet", desc:"Create a new Excel spreadsheet", type:"action", action:"url", url:"https://excel.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-excel.png"), keycheck:false},
			{title:"New PowerPoint presentation", desc:"Create a new PowerPoint presentation", type:"action", action:"url", url:"https://powerpoint.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-powerpoint.png"), keycheck:false},
			{title:"New Word document", desc:"Create a new Word document", type:"action", action:"url", url:"https://word.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-word.png"), keycheck:false},
			{title:"Create a whiteboard", desc:"Create a collaborative whiteboard", type:"action", action:"url", url:"https://whiteboard.new", emoji:true, emojiChar:"\uD83E\uDDD1\u200D\uD83C\uDFEB", keycheck:false},
			{title:"Record a video", desc:"Record and edit a video", type:"action", action:"url", url:"https://recording.new", emoji:true, emojiChar:"\uD83D\uDCF9", keycheck:false},
			{title:"Create a Figma file", desc:"Create a new Figma file", type:"action", action:"url", url:"https://figma.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-figma.png"), keycheck:false},
			{title:"Create a FigJam file", desc:"Create a new FigJam file", type:"action", action:"url", url:"https://figjam.new", emoji:true, emojiChar:"\uD83D\uDD8C", keycheck:false},
			{title:"Hunt a product", desc:"Submit a product to Product Hunt", type:"action", action:"url", url:"https://www.producthunt.com/posts/new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-producthunt.png"), keycheck:false},
			{title:"Make a tweet", desc:"Make a tweet on Twitter", type:"action", action:"url", url:"https://twitter.com/intent/tweet", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-twitter.png"), keycheck:false},
			{title:"Create a playlist", desc:"Create a Spotify playlist", type:"action", action:"url", url:"https://playlist.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-spotify.png"), keycheck:false},
			{title:"Create a Canva design", desc:"Create a new design with Canva", type:"action", action:"url", url:"https://design.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-canva.png"), keycheck:false},
			{title:"Create a new podcast episode", desc:"Create a new podcast episode with Anchor", type:"action", action:"url", url:"https://episode.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-anchor.png"), keycheck:false},
			{title:"Edit an image", desc:"Edit an image with Adobe Photoshop", type:"action", action:"url", url:"https://photo.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-photoshop.png"), keycheck:false},
			{title:"Convert to PDF", desc:"Convert a file to PDF", type:"action", action:"url", url:"https://pdf.new", emoji:true, emojiChar:"\uD83D\uDCC4", keycheck:false},
			{title:"Scan a QR code", desc:"Scan a QR code with your camera", type:"action", action:"url", url:"https://scan.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-qr.png"), keycheck:false},
			{title:"Add a task to Asana", desc:"Create a new task in Asana", type:"action", action:"url", url:"https://task.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-asana.png"), keycheck:false},
			{title:"Add an issue to Linear", desc:"Create a new issue in Linear", type:"action", action:"url", url:"https://linear.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-linear.png"), keycheck:false},
			{title:"Add a task to WIP", desc:"Create a new task in WIP", type:"action", action:"url", url:"https://todo.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-wip.png"), keycheck:false},
			{title:"Create an event", desc:"Add an event to Google Calendar", type:"action", action:"url", url:"https://cal.new", emoji:false, favIconUrl:chrome.runtime.getURL("assets/logo-calendar.png"), keycheck:false},
			{title:"Add a note", desc:"Add a note to Google Keep", type:"action", action:"url", emoji:false, url:"https://note.new", favIconUrl:chrome.runtime.getURL("assets/logo-keep.png"), keycheck:false},
			{title:"New meeting", desc:"Start a Google Meet meeting", type:"action", action:"url", emoji:false, url:"https://meet.new", favIconUrl:chrome.runtime.getURL("assets/logo-meet.png"), keycheck:false},
			{title:"Browsing history", desc:"Browse through your browsing history", type:"action", action:"history", emoji:true, emojiChar:"\uD83D\uDDC2", keycheck:true, keys:['\u2318','Y']},
			{title:"Incognito mode", desc:"Open an incognito window", type:"action", action:"incognito", emoji:true, emojiChar:"\uD83D\uDD75\uFE0F", keycheck:true, keys:['\u2318','\u21E7', 'N']},
			{title:"Downloads", desc:"Browse through your downloads", type:"action", action:"downloads", emoji:true, emojiChar:"\uD83D\uDCE6", keycheck:true, keys:['\u2318','\u21E7', 'J']},
			{title:"Extensions", desc:"Manage your Chrome Extensions", type:"action", action:"extensions", emoji:true, emojiChar:"\uD83E\uDDE9", keycheck:false, keys:['\u2318','D']},
			{title:"Chrome settings", desc:"Open the Chrome settings", type:"action", action:"settings", emoji:true, emojiChar:"\u2699\uFE0F", keycheck:true, keys:['\u2318',',']},
			{title:"Scroll to bottom", desc:"Scroll to the bottom of the page", type:"action", action:"scroll-bottom", emoji:true, emojiChar:"\uD83D\uDC47", keycheck:true, keys:['\u2318','\u2193']},
			{title:"Scroll to top", desc:"Scroll to the top of the page", type:"action", action:"scroll-top", emoji:true, emojiChar:"\uD83D\uDC46", keycheck:true, keys:['\u2318','\u2191']},
			{title:"Go back", desc:"Go back in history for the current tab", type:"action", action:"go-back", emoji:true, emojiChar:"\uD83D\uDC48",  keycheck:true, keys:['\u2318','\u2190']},
			{title:"Go forward", desc:"Go forward in history for the current tab", type:"action", action:"go-forward", emoji:true, emojiChar:"\uD83D\uDC49", keycheck:true, keys:['\u2318','\u2192']},
			{title:"Duplicate tab", desc:"Make a copy of the current tab", type:"action", action:"duplicate-tab", emoji:true, emojiChar:"\uD83D\uDCCB", keycheck:true, keys:['\u2325','\u21E7', 'D']},
			{title:"Close tab", desc:"Close the current tab", type:"action", action:"close-tab", emoji:true, emojiChar:"\uD83D\uDDD1", keycheck:true, keys:['\u2318','W']},
			{title:"Close window", desc:"Close the current window", type:"action", action:"close-window", emoji:true, emojiChar:"\uD83D\uDCA5", keycheck:true, keys:['\u2318','\u21E7', 'W']},
			{title:"Manage browsing data", desc:"Manage your browsing data", type:"action", action:"manage-data", emoji:true, emojiChar:"\uD83D\uDD2C", keycheck:true, keys:['\u2318','\u21E7', 'Delete']},
			{title:"Clear all browsing data", desc:"Clear all of your browsing data", type:"action", action:"remove-all", emoji:true, emojiChar:"\uD83E\uDDF9", keycheck:false, keys:['\u2318','D']},
			{title:"Clear browsing history", desc:"Clear all of your browsing history", type:"action", action:"remove-history", emoji:true, emojiChar:"\uD83D\uDDC2", keycheck:false, keys:['\u2318','D']},
			{title:"Clear cookies", desc:"Clear all cookies", type:"action", action:"remove-cookies", emoji:true, emojiChar:"\uD83C\uDF6A", keycheck:false, keys:['\u2318','D']},
			{title:"Clear cache", desc:"Clear the cache", type:"action", action:"remove-cache", emoji:true, emojiChar:"\uD83D\uDDC4", keycheck:false, keys:['\u2318','D']},
			{title:"Clear local storage", desc:"Clear the local storage", type:"action", action:"remove-local-storage", emoji:true, emojiChar:"\uD83D\uDCE6", keycheck:false, keys:['\u2318','D']},
		{title:"Clear passwords", desc:"Clear all saved passwords", type:"action", action:"remove-passwords", emoji:true, emojiChar:"\uD83D\uDD11", keycheck:false, keys:['\u2318','D']},
	];

	if (!isMac) {
		for (const action of defaults) {
			switch (action.action) {
				case "reload":
					action.keys = ['F5'];
					break;
				case "fullscreen":
					action.keys = ['F11'];
					break;
				case "downloads":
					action.keys = ['Ctrl', 'J'];
					break;
				case "settings":
					action.keycheck = false;
					break;
				case "history":
					action.keys = ['Ctrl', 'H'];
					break;
				case "go-back":
					action.keys = ['Alt','\u2190'];
					break;
				case "go-forward":
					action.keys = ['Alt','\u2192']
					break;
				case "scroll-top":
					action.keys = ['Home'];
					break;
				case "scroll-bottom":
					action.keys = ['End'];
					break;
			}
			for (const key in action.keys) {
				if (action.keys[key] === "\u2318") {
					action.keys[key] = "Ctrl";
				} else if (action.keys[key] === "\u2325") {
					action.keys[key] = "Alt";
				}
			}
		}
	}

	// Filter by disabled categories
	const settings = await new Promise((resolve) => {
		chrome.storage.sync.get({ disabledCategories: [] }, resolve);
	});
	return filterByCategories(defaults, settings.disabledCategories);
};

// Get all tabs as actions (atomic)
const getTabsAsActions = async () => {
	const tabs = await chrome.tabs.query({});
	return tabs.map((tab) => ({
		...tab,
		desc: "Chrome tab",
		keycheck: false,
		action: "switch-tab",
		type: "tab",
		favIconUrl: getChromeFaviconUrl(tab.url || tab.pendingUrl || "")
	}));
};

// Get recent bookmarks as actions (atomic)
const getBookmarksAsActions = () => new Promise((resolve) => {
	const result = [];
	const walk = (bookmarks) => {
		for (const bookmark of bookmarks) {
			if (bookmark.url) {
				result.push({title:bookmark.title, desc:"Bookmark", id:bookmark.id, url:bookmark.url, type:"bookmark", action:"bookmark", emoji:true, emojiChar:"\u2B50\uFE0F", keycheck:false});
			}
			if (bookmark.children) walk(bookmark.children);
		}
	};
	chrome.bookmarks.getRecent(100, (bookmarks) => {
		walk(bookmarks);
		resolve(result);
	});
});

// Open on install
chrome.runtime.onInstalled.addListener((object) => {
  const manifest = chrome.runtime.getManifest();

  const injectIntoTab = (tab) => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: manifest.content_scripts[0].js,
    }).catch(() => {});
    chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: [manifest.content_scripts[0].css[0]],
    }).catch(() => {});
  };

  chrome.windows.getAll(
    {
      populate: true,
    },
    (windows) => {
      let currentWindow;
      const w = windows.length;

      for (let i = 0; i < w; i++) {
        currentWindow = windows[i];

        let currentTab;
        const t = currentWindow.tabs.length;

	        for (let j = 0; j < t; j++) {
	          currentTab = currentWindow.tabs[j];
					if (canUseContentScript(currentTab.url)) {
	          	injectIntoTab(currentTab);
					}
	        }
      }
    }
  );

  if (object.reason === "install") {
    chrome.tabs.create({ url: "https://alyssax.com/omni/" });
  }
});

// Check when the extension button is clicked
chrome.action.onClicked.addListener((tab) => {
	openOmniOnTab(tab);
});

// Listen for the open omni shortcut
chrome.commands.onCommand.addListener((command) => {
	if (command === "open-omni") {
		getCurrentTab().then((response) => {
			openOmniOnTab(response);
			recoverOpenOmniShortcutRace(response).catch(() => {});
		});
	}
});

// Get the current tab
const getCurrentTab = async () => {
	try {
		const queryOptions = { active: true, currentWindow: true };
		const [tab] = await chrome.tabs.query(queryOptions);
		return tab;
	} catch (e) {
		return null;
	}
}

function isBlankShortcutTarget(tab, initialTabId) {
	if (!tab || tab.id == null || tab.id === initialTabId) return false;

	const url = tab.pendingUrl || tab.url || "";
	if (url === "about:blank" || url === "chrome://newtab/") return true;

	return !url && (!tab.title || tab.title === "Untitled");
}

async function recoverOpenOmniShortcutRace(initialTab) {
	const initialTabId = initialTab && initialTab.id != null ? initialTab.id : null;

	await new Promise((resolve) => setTimeout(resolve, 150));

	const activeTab = await getCurrentTab();
	if (!isBlankShortcutTarget(activeTab, initialTabId)) return;

	return openOmniOnTab(activeTab);
}

// Restore the original restricted tab that was replaced by the extension page.
function restoreNewTab(tab) {
	if (!tab || tab.id == null) return;
	const sourceUrl = restrictedNewTabSources.get(tab.id);
	restrictedNewTabSources.delete(tab.id);

	if (!sourceUrl) {
		chrome.tabs.remove(tab.id).catch(() => {});
		return;
	}

	chrome.tabs.create({
		url: sourceUrl,
		windowId: tab.windowId,
		index: tab.index
	}).then(() => {
		chrome.tabs.remove(tab.id).catch(() => {});
	}).catch(() => {
		chrome.tabs.remove(tab.id).catch(() => {});
	});
}

// Build the full action list atomically. Called synchronously on demand
// (from "get-actions") rather than on every tab event, so the array is never
// seen in a half-rebuilt state by the content script.
const buildActions = async () => {
	const [currentTab, tabs] = await Promise.all([
		getCurrentTab(),
		getTabsAsActions()
	]);
	const muteAction = currentTab && currentTab.id != null ? {
		title: currentTab.mutedInfo && currentTab.mutedInfo.muted ? "Unmute page" : "Mute page",
		desc: currentTab.mutedInfo && currentTab.mutedInfo.muted ? "Unmute the current page" : "Mute the current page",
		type: "action",
		action: "toggle-mute",
		emoji: true,
		emojiChar: currentTab.mutedInfo && currentTab.mutedInfo.muted ? "\uD83D\uDD08" : "\uD83D\uDD07",
		keycheck: false
	} : null;

	return muteAction ? [muteAction].concat(tabs) : tabs;
};

// Action handlers
const switchTab = (tab) => {
	if (!tab || tab.id == null || tab.windowId == null) return;
	chrome.tabs.update(tab.id, { active: true }).then(() => {
		chrome.windows.update(tab.windowId, { focused: true });
	}).catch(() => {});
}
const goBack = (tab) => {
	if (!tab || tab.id == null) return;
	chrome.tabs.goBack({
		tabId: tab.id
	}).catch(() => {});
}
const goForward = (tab) => {
	if (!tab || tab.id == null) return;
	chrome.tabs.goForward({
		tabId: tab.id
	}).catch(() => {});
}
const duplicateTab = (tab) => {
	const targetTabId = tab && tab.id != null ? tab.id : null;
	if (targetTabId != null) {
		invalidateActionsCache();
		chrome.tabs.duplicate(targetTabId).catch(() => {});
		return;
	}
	getCurrentTab().then((response) => {
		if (response && response.id != null) {
			invalidateActionsCache();
			chrome.tabs.duplicate(response.id).catch(() => {});
		}
	})
}
const createBookmark = (tab) => {
	if (tab && tab.url) {
		invalidateActionsCache();
		chrome.bookmarks.create({
			title: tab.title,
			url: tab.url
		});
		return;
	}
	getCurrentTab().then((response) => {
		if (response && response.url) {
			invalidateActionsCache();
			chrome.bookmarks.create({
				title: response.title,
				url: response.url
			});
		}
	})
}
const muteTab = (mute, tab) =>{
	const targetTabId = tab && tab.id != null ? tab.id : null;
	if (targetTabId != null) {
		invalidateActionsCache();
		chrome.tabs.update(targetTabId, {"muted": mute}).catch(() => {});
		return;
	}
	getCurrentTab().then((response) => {
		if (response && response.id != null) {
			invalidateActionsCache();
			chrome.tabs.update(response.id, {"muted": mute}).catch(() => {});
		}
	});
}
const reloadTab = (tab) => {
	if (tab && tab.id != null) {
		chrome.tabs.reload(tab.id).catch(() => {});
		return;
	}
	chrome.tabs.reload().catch(() => {});
}
const pinTab = (pin, tab) => {
	const targetTabId = tab && tab.id != null ? tab.id : null;
	if (targetTabId != null) {
		invalidateActionsCache();
		chrome.tabs.update(targetTabId, {"pinned": pin}).catch(() => {});
		return;
	}
	getCurrentTab().then((response) => {
		if (response && response.id != null) {
			invalidateActionsCache();
			chrome.tabs.update(response.id, {"pinned": pin}).catch(() => {});
		}
	});
}
const clearAllData = () => {
	chrome.browsingData.remove({
		"since": 0
	}, {
		"appcache": true,
		"cache": true,
		"cacheStorage": true,
		"cookies": true,
		"downloads": true,
		"fileSystems": true,
		"formData": true,
		"history": true,
		"indexedDB": true,
		"localStorage": true,
		"passwords": true,
		"serviceWorkers": true,
		"webSQL": true
	});
}
const clearBrowsingData = () => {
	chrome.browsingData.removeHistory({"since": 0});
}
const clearCookies = () =>{
	chrome.browsingData.removeCookies({"since": 0});
}
const clearCache = () => {
	chrome.browsingData.removeCache({"since": 0});
}
const clearLocalStorage = () => {
	chrome.browsingData.removeLocalStorage({"since": 0});
}
const clearPasswords = () => {
	chrome.browsingData.removePasswords({"since": 0});
}
const openChromeUrl = (url) => {
	chrome.tabs.create({url: 'chrome://' + url});
}
const openIncognito = () => {
	chrome.windows.create({"incognito": true});
}
const closeWindow = (id) => {
	chrome.windows.remove(id);
}
const closeTab = (tab) => {
	if (!tab || tab.id == null) return;
	invalidateActionsCache();
	chrome.tabs.remove(tab.id).catch(() => {});
}
const closeCurrentTab = (tab) => {
	if (tab && tab.id != null) {
		closeTab(tab);
		return;
	}
	getCurrentTab().then(closeTab)
}
const removeBookmark = (bookmark) => {
	if (!bookmark || bookmark.id == null) return;
	invalidateActionsCache();
	chrome.bookmarks.remove(bookmark.id).catch(() => {});
}
const toggleMute = (tab) => {
	const muted = !!(tab && tab.mutedInfo && tab.mutedInfo.muted);
	muteTab(!muted, tab);
}
const togglePin = (tab) => {
	const pinned = !!(tab && tab.pinned);
	pinTab(!pinned, tab);
}
const createNewTab = (senderTab) => {
	const createOptions = {};
	if (senderTab && senderTab.windowId != null) createOptions.windowId = senderTab.windowId;
	if (senderTab && senderTab.index != null) createOptions.index = senderTab.index + 1;
	chrome.tabs.create(createOptions).catch(() => {});
}
const searchGoogle = (query, senderTab, openInNewTab) => {
	if (!query) return;
	const googleUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);

	if (openInNewTab || !senderTab || senderTab.id == null) {
		const createOptions = { url: googleUrl };
		if (senderTab && senderTab.windowId != null) createOptions.windowId = senderTab.windowId;
		if (senderTab && senderTab.index != null) createOptions.index = senderTab.index + 1;
		chrome.tabs.create(createOptions).catch(() => {});
		return;
	}

	chrome.tabs.update(senderTab.id, { url: googleUrl }).catch(() => {
		chrome.tabs.create({ url: googleUrl }).catch(() => {});
	});
}

chrome.tabs.onCreated.addListener(invalidateActionsCache);
chrome.tabs.onRemoved.addListener((tabId) => {
	restrictedNewTabSources.delete(tabId);
	invalidateActionsCache();
});
chrome.tabs.onUpdated.addListener(invalidateActionsCache);
chrome.bookmarks.onCreated.addListener(invalidateActionsCache);
chrome.bookmarks.onRemoved.addListener(invalidateActionsCache);
chrome.bookmarks.onChanged.addListener(invalidateActionsCache);
chrome.bookmarks.onMoved.addListener(invalidateActionsCache);
chrome.storage.onChanged.addListener((changes, namespace) => {
	if (namespace === "sync" && changes.disabledCategories) {
		invalidateActionsCache();
	}
});

// Receive messages from any tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	const senderTab = sender && sender.tab ? sender.tab : null;
	switch (message.request) {
		case "get-actions":
			// Build atomically and reply asynchronously. Returning true keeps
			// the message channel open until sendResponse is called.
			getActionsSnapshot().then((list) => {
				sendResponse({actions: list});
			}).catch(() => {
				sendResponse({actions: []});
			});
			return true;
		case "switch-tab":
			switchTab(message.tab || senderTab);
			break;
		case "go-back":
			goBack(senderTab);
			break;
		case "go-forward":
			goForward(senderTab);
			break;
		case "duplicate-tab":
			duplicateTab(senderTab);
			break;
			case "create-bookmark":
				createBookmark(senderTab);
				break;
			case "new-tab":
				createNewTab(senderTab);
				break;
			case "mute":
				muteTab(true, senderTab);
				break;
		case "unmute":
			muteTab(false, senderTab);
			break;
		case "toggle-mute":
			toggleMute(senderTab);
			break;
		case "reload":
			reloadTab(senderTab);
			break;
		case "pin":
			pinTab(true, senderTab);
			break;
		case "unpin":
			pinTab(false, senderTab);
			break;
		case "toggle-pin":
			togglePin(senderTab);
			break;
		case "remove-all":
			clearAllData();
			break;
		case "remove-history":
			clearBrowsingData();
			break;
		case "remove-cookies":
			clearCookies();
			break;
		case "remove-cache":
			clearCache();
			break;
		case "remove-local-storage":
			clearLocalStorage();
			break;
		case "remove-passwords":
			clearPasswords();
			break;
		case "history":
		case "downloads":
		case "extensions":
		case "settings":
		case "extensions/shortcuts":
			openChromeUrl(message.request);
			break;
		case "manage-data":
			openChromeUrl("settings/clearBrowserData");
			break;
		case "incognito":
			openIncognito();
			break;
		case "close-window":
			if (senderTab) closeWindow(senderTab.windowId);
			break;
		case "close-tab":
			closeCurrentTab(senderTab);
			break;
			case "search-history":
				chrome.history.search({text:message.query, maxResults:200, startTime:0}).then((data) => {
					sendResponse({
					history: data.map((action) => ({
						...action,
						type: "history",
						emoji: true,
						emojiChar: "\uD83C\uDFDB",
						action: "history",
						keyCheck: false
					}))
				});
				}).catch(() => {
					sendResponse({history: []});
				})
				return true;
			case "search-bookmarks":
				chrome.bookmarks.search({query:message.query}).then((data) => {
				sendResponse({
					bookmarks: data
						.filter((action) => !!action.url)
						.slice(0, 200)
						.map((action) => ({
							...action,
							type: "bookmark",
							emoji: true,
							emojiChar: "\u2B50\uFE0F",
							action: "bookmark",
							keyCheck: false
						}))
				});
				}).catch(() => {
					sendResponse({bookmarks: []});
				})
				return true;
		case "remove":
			if (message.type == "bookmark") {
				removeBookmark(message.action);
			} else {
				closeTab(message.action);
			}
			break;
		case "search":
			searchGoogle(message.query, senderTab, !!message.newTab);
			break;
			case "restore-new-tab":
				restoreNewTab(senderTab);
				break;
		case "close-omni":
			if (senderTab && senderTab.id != null) {
				chrome.tabs.sendMessage(senderTab.id, {request: "close-omni"}).catch(() => {});
			}
			break;
		}
});

// Keep the cache warm only when explicitly requested.
