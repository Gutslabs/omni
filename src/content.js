// Prevent double injection (happens when extension is reloaded)
if (window.__omniInitialized) { /* skip */ } else {
window.__omniInitialized = true;

// Detect extension context invalidation (orphaned content script after reload)
const extAlive = () => {
	try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
	catch (e) { return false; }
};

// Workaround to capture Esc key on certain sites
var isOpen = false;
document.addEventListener("keyup", (e) => {
	if (!e.isTrusted) return;
	if (!extAlive()) return;
	if (e.key == "Escape" && isOpen) {
		try { chrome.runtime.sendMessage({request:"close-omni"}); } catch (err) {}
	}
}, true);

// Helper functions
const $ = (selector, parent) => (parent || document).querySelector(selector);
const $$ = (selector, parent) => (parent || document).querySelectorAll(selector);

function htmlToElement(html) {
	const template = document.createElement('template');
	template.innerHTML = html.trim();
	return template.content.firstChild;
}

// Wait for DOM ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}

function init() {
	var actions = [];
	var filteredActions = null; // holds the filtered array when in filter mode
	var isFiltered = false;

	// Load settings then init UI
	if (!extAlive()) return;
	try {
		chrome.storage.sync.get({
			theme: 'system',
			accentColor: '#6068d2',
			disabledCategories: []
		}, (settings) => {
			initUI(settings);
		});
	} catch (e) { return; }

	function initUI(settings) {
		if (!extAlive()) return;
		// Append the omni into the current page
		fetch(chrome.runtime.getURL('/content.html'))
			.then(r => r.text())
			.then(data => {
				const container = htmlToElement(data);
				// Append both elements (omni-extension and toast)
				const tempDiv = document.createElement('div');
				tempDiv.innerHTML = data;
				Array.from(tempDiv.children).forEach(child => document.body.appendChild(child));

				// Get checkmark image for toast
				const toastImg = $("#omni-extension-toast img");
				if (toastImg) toastImg.setAttribute("src", chrome.runtime.getURL("assets/check.svg"));

				// Apply theme
				applyTheme(settings.theme);
				applyAccentColor(settings.accentColor);

				// Request actions from the background
				if (extAlive()) {
					try {
						chrome.runtime.sendMessage({request:"get-actions"}, (response) => {
							if (response) actions = response.actions;
						});
					} catch (err) {}
				}

				// New tab page workaround
				if (extAlive() && window.location.href === `chrome-extension://${chrome.runtime.id}/newtab.html`) {
					isOpen = true;
					const omniExt = $("#omni-extension");
					if (omniExt) omniExt.classList.remove("omni-closing");
					window.setTimeout(() => {
						const input = $("#omni-extension input");
						if (input) input.focus();
					}, 100);
				}

				// Bind events
				document.addEventListener("click", (e) => {
					if (!isOpen) return;
					// Ignore synthetic clicks dispatched by the host page
					if (!e.isTrusted) return;
					if (!extAlive()) return;

					const item = e.target.closest(".omni-item-active");
					if (item) { handleAction(e); return; }

					// Strict overlay match — close only when clicking the overlay itself
					if (e.target.id === "omni-overlay") closeOmni();
					if (e.target.closest("#open-page-omni-extension-thing")) openShortcuts();
				}, true);

				document.addEventListener("mouseover", (e) => {
					const item = e.target.closest(".omni-extension .omni-item:not(.omni-item-active)");
					if (item) hoverItem.call(item);
				});

				const omniInput = $(".omni-extension input");
				if (omniInput) {
					omniInput.addEventListener("keyup", search);
				}
			});

		// Listen for settings changes
		try {
			chrome.storage.onChanged.addListener((changes, namespace) => {
				if (namespace === 'sync') {
					if (changes.theme) applyTheme(changes.theme.newValue);
					if (changes.accentColor) applyAccentColor(changes.accentColor.newValue);
				}
			});
		} catch (e) {}
	}

	function applyTheme(theme) {
		const omniExt = $("#omni-extension");
		const toast = $("#omni-extension-toast");
		const targets = [omniExt, toast].filter(Boolean);

		targets.forEach(el => {
			el.classList.remove("omni-theme-dark", "omni-theme-light", "omni-theme-system");
			el.classList.add(`omni-theme-${theme}`);
		});
	}

	function applyAccentColor(color) {
		const omniExt = $("#omni-extension");
		const toast = $("#omni-extension-toast");
		[omniExt, toast].filter(Boolean).forEach(el => {
			el.style.setProperty('--accent', color);
			// Generate a darker hover variant
			el.style.setProperty('--accent-hover', darkenColor(color, 20));
		});
	}

	function darkenColor(hex, percent) {
		const num = parseInt(hex.replace('#', ''), 16);
		const amt = Math.round(2.55 * percent);
		const R = Math.max((num >> 16) - amt, 0);
		const G = Math.max((num >> 8 & 0x00FF) - amt, 0);
		const B = Math.max((num & 0x0000FF) - amt, 0);
		return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
	}

	function renderAction(action, index, keys, img) {
		const hiddenClass = (action.action == "search" || action.action == "goto") ? " omni-hidden" : "";
		const omniList = $("#omni-extension #omni-list");
		if (omniList) {
			omniList.insertAdjacentHTML("beforeend",
				`<div class='omni-item${hiddenClass}' data-index='${index}' data-type='${action.type}'>${img}<div class='omni-item-details'><div class='omni-item-name'>${action.title}</div><div class='omni-item-desc'>${action.desc}</div></div>${keys}<div class='omni-select'>Select <span class='omni-shortcut'>\u23CE</span></div></div>`
			);
		}
		if (!action.emoji) {
			var loadimg = new Image();
			loadimg.src = action.favIconUrl;
			loadimg.onerror = () => {
				const el = $(`.omni-item[data-index='${index}'] img`);
				if (el) el.setAttribute("src", chrome.runtime.getURL("/assets/globe.svg"));
			}
		}
	}

	// Add actions to the omni
	function populateOmni() {
		filteredActions = null;
		isFiltered = false;
		const omniList = $("#omni-extension #omni-list");
		if (omniList) omniList.innerHTML = "";
		actions.forEach((action, index) => {
			var keys = "";
			if (action.keycheck) {
				keys = "<div class='omni-keys'>";
				action.keys.forEach(function(key){
					keys += "<span class='omni-shortcut'>"+key+"</span>";
				});
				keys += "</div>";
			}

			if (!action.emoji) {
				var onload = 'if ("naturalHeight" in this) {if (this.naturalHeight + this.naturalWidth === 0) {this.onerror();return;}} else if (this.width + this.height == 0) {this.onerror();return;}';
				var img = "<img src='"+action.favIconUrl+"' alt='favicon' onload='"+onload+"' onerror='this.src=\""+chrome.runtime.getURL("/assets/globe.svg")+"\"' class='omni-icon'>";
				renderAction(action, index, keys, img);
			} else {
				var img = "<span class='omni-emoji-action'>"+action.emojiChar+"</span>";
				renderAction(action, index, keys, img);
			}
		});
		// Mark first VISIBLE item as active
		const firstVisible = Array.from($$("#omni-extension #omni-list .omni-item")).find(el => !el.classList.contains('omni-hidden'));
		if (firstVisible) firstVisible.classList.add("omni-item-active");
		const results = $(".omni-extension #omni-results");
		if (results) {
			const visible = Array.from($$("#omni-extension #omni-list .omni-item")).filter(el => !el.classList.contains('omni-hidden')).length;
			results.textContent = visible + " results";
		}
	}

	// Add filtered actions to the omni
	function populateOmniFilter(filterArr) {
		isFiltered = true;
		filteredActions = filterArr;
		const omniList = $("#omni-extension #omni-list");
		if (omniList) omniList.innerHTML = "";
		const renderRow = (index) => {
			const action = filteredActions[index];
			var keys = "";
			if (action.keycheck) {
				keys = "<div class='omni-keys'>";
				action.keys.forEach(function(key){
					keys += "<span class='omni-shortcut'>"+key+"</span>";
				});
				keys += "</div>";
			}
			var img = "<img src='"+action.favIconUrl+"' alt='favicon' onerror='this.src=\""+chrome.runtime.getURL("/assets/globe.svg")+"\"' class='omni-icon'>";
			if (action.emoji) {
				img = "<span class='omni-emoji-action'>"+action.emojiChar+"</span>";
			}
			const activeClass = index === 0 ? " omni-item-active" : "";
			return htmlToElement(
				`<div class='omni-item${activeClass}' data-index='${index}' data-type='${action.type}' data-url='${action.url}'>${img}<div class='omni-item-details'><div class='omni-item-name'>${action.title}</div><div class='omni-item-desc'>${action.url}</div></div>${keys}<div class='omni-select'>Select <span class='omni-shortcut'>\u23CE</span></div></div>`
			);
		}
		if (filteredActions.length) {
			new VirtualizedList.default(omniList, {
				height: 400,
				rowHeight: 60,
				rowCount: filteredActions.length,
				renderRow,
				onMount: () => {
					const results = $(".omni-extension #omni-results");
					if (results) results.textContent = filteredActions.length + " results";
				},
			});
		}
	}

	// Safe wrapper for chrome.runtime.sendMessage — returns false if context invalid
	function safeSend(msg, cb) {
		if (!extAlive()) return false;
		try {
			if (cb) chrome.runtime.sendMessage(msg, cb);
			else chrome.runtime.sendMessage(msg);
			return true;
		} catch (e) { return false; }
	}

	// Helpers to lock/unlock host-page scroll while popup is open.
	// This prevents scrollbar toggling → viewport width shift → layout loop.
	let savedOverflow = '';
	function lockScroll() {
		savedOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
	}
	function unlockScroll() {
		document.body.style.overflow = savedOverflow;
	}

	// Open the omni
	function openOmni() {
		if (!safeSend({request:"get-actions"}, (response) => {
			if (!response) return;
			isOpen = true;
			actions = response.actions;
			const input = $("#omni-extension input");
			if (input) input.value = "";
			populateOmni();
			lockScroll();
			const omniExt = $("#omni-extension");
			if (omniExt) omniExt.classList.remove("omni-closing");
			window.setTimeout(() => {
				if (input) {
					input.focus();
					focusLock.on(input);
					input.focus();
				}
			}, 100);
		})) { return; }
	}

	// Close the omni
	function closeOmni() {
		const input = $("#omni-extension input");
		if (input) try { focusLock.off(input); } catch (e) {}
		unlockScroll();
		if (!extAlive()) {
			isOpen = false;
			const omniExt = $("#omni-extension");
			if (omniExt) omniExt.classList.add("omni-closing");
			return;
		}
		if (window.location.href === `chrome-extension://${chrome.runtime.id}/newtab.html`) {
			try { chrome.runtime.sendMessage({request:"restore-new-tab"}); } catch (e) {}
		} else {
			isOpen = false;
			const omniExt = $("#omni-extension");
			if (omniExt) omniExt.classList.add("omni-closing");
		}
	}

	// Force-close without messaging the background (for tab visibility loss)
	function forceCloseOmni() {
		isOpen = false;
		const input = $("#omni-extension input");
		if (input) try { focusLock.off(input); } catch (e) {}
		unlockScroll();
		const omniExt = $("#omni-extension");
		if (omniExt) omniExt.classList.add("omni-closing");
	}

	// The newtab page is special — popup is the entire page, don't auto-close it
	const isNewTabPage = () => {
		try {
			return window.location.href === `chrome-extension://${chrome.runtime.id}/newtab.html`;
		} catch (e) { return false; }
	};

	// Close popup when the tab is hidden (tab switch, window hide, minimize)
	// NOTE: intentionally NOT listening to window.blur — it fires spuriously on
	// pages with iframes or resize loops and would cause a close/open oscillation.
	document.addEventListener("visibilitychange", () => {
		if (document.hidden && isOpen && !isNewTabPage()) forceCloseOmni();
	});

	// Hover over an action in the omni
	function hoverItem() {
		const active = $(".omni-item-active");
		if (active) active.classList.remove("omni-item-active");
		this.classList.add("omni-item-active");
	}

	// Show a toast when an action has been performed
	function showToast(action) {
		const toastSpan = $("#omni-extension-toast span");
		if (toastSpan) toastSpan.textContent = '"' + action.title + '" has been successfully performed';
		const toast = $("#omni-extension-toast");
		if (toast) toast.classList.add("omni-show-toast");
		setTimeout(() => {
			const showToast = $(".omni-show-toast");
			if (showToast) showToast.classList.remove("omni-show-toast");
		}, 3000);
	}

	// Autocomplete commands
	function checkShortHand(e, value) {
		var el = $(".omni-extension input");
		if (!el) return;
		if (e.keyCode != 8) {
			if (value == "/t") {
				el.value = "/tabs ";
			} else if (value == "/b") {
				el.value = "/bookmarks ";
			} else if (value == "/h") {
				el.value = "/history ";
			} else if (value == "/r") {
				el.value = "/remove ";
			} else if (value == "/a") {
				el.value = "/actions ";
			}
		} else {
			if (value == "/tabs" || value == "/bookmarks" || value == "/actions" || value == "/remove" || value == "/history") {
				el.value = "";
			}
		}
	}

	function addhttp(url) {
		if (!/^(?:f|ht)tps?\:\/\//.test(url)) {
			url = "http://" + url;
		}
		return url;
	}

	function validURL(str) {
		var pattern = new RegExp('^(https?:\\/\\/)?'+
			'((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|'+
			'((\\d{1,3}\\.){3}\\d{1,3}))'+
			'(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*'+
			'(\\?[;&a-z\\d%_.~+=-]*)?'+
			'(\\#[-a-z\\d_]*)?$','i');
		return !!pattern.test(str);
	}

	// Helper to show/hide elements using class (resilient to `all: unset` reset)
	function toggleItem(el, show) {
		if (show) el.classList.remove('omni-hidden');
		else el.classList.add('omni-hidden');
	}

	function getItemByAction(actionName) {
		const idx = actions.findIndex(x => x.action == actionName);
		return $(`.omni-item[data-index='${idx}']`);
	}

	function hideSearchAndGoto() {
		const searchEl = getItemByAction("search");
		const gotoEl = getItemByAction("goto");
		if (searchEl) searchEl.classList.add('omni-hidden');
		if (gotoEl) gotoEl.classList.add('omni-hidden');
	}

	// Search for an action in the omni
	function search(e) {
		if (e.keyCode == 37 || e.keyCode == 38 || e.keyCode == 39 || e.keyCode == 40 || e.keyCode == 13) {
			return;
		}
		var value = this.value.toLowerCase();
		checkShortHand(e, value);
		value = this.value.toLowerCase();

		if (value.startsWith("/history")) {
			hideSearchAndGoto();
			var tempvalue = value.replace("/history ", "");
			var query = "";
			if (tempvalue != "/history") {
				query = value.replace("/history ", "");
			}
			safeSend({request:"search-history", query:query}, (response) => {
				if (response) populateOmniFilter(response.history);
			});
		} else if (value.startsWith("/bookmarks")) {
			hideSearchAndGoto();
			var tempvalue = value.replace("/bookmarks ", "");
			if (tempvalue != "/bookmarks" && tempvalue != "") {
				var query = value.replace("/bookmarks ", "");
				safeSend({request:"search-bookmarks", query:query}, (response) => {
					if (response) populateOmniFilter(response.bookmarks);
				});
			} else {
				populateOmniFilter(actions.filter(x => x.type == "bookmark"));
			}
		} else {
			if (isFiltered) {
				populateOmni();
			}
			const items = $$("#omni-extension #omni-list .omni-item");
			items.forEach((el) => {
				const name = $(".omni-item-name", el);
				const desc = $(".omni-item-desc", el);
				const nameText = name ? name.textContent.toLowerCase() : "";
				const descText = desc ? desc.textContent.toLowerCase() : "";
				const type = el.getAttribute("data-type");

				if (value.startsWith("/tabs")) {
					hideSearchAndGoto();
					var tempvalue = value.replace("/tabs ", "");
					if (tempvalue == "/tabs") {
						toggleItem(el, type == "tab");
					} else {
						toggleItem(el, (nameText.indexOf(tempvalue) > -1 || descText.indexOf(tempvalue) > -1) && type == "tab");
					}
				} else if (value.startsWith("/remove")) {
					hideSearchAndGoto();
					var tempvalue = value.replace("/remove ", "");
					if (tempvalue == "/remove") {
						toggleItem(el, type == "bookmark" || type == "tab");
					} else {
						toggleItem(el, (nameText.indexOf(tempvalue) > -1 || descText.indexOf(tempvalue) > -1) && (type == "bookmark" || type == "tab"));
					}
				} else if (value.startsWith("/actions")) {
					hideSearchAndGoto();
					var tempvalue = value.replace("/actions ", "");
					if (tempvalue == "/actions") {
						toggleItem(el, type == "action");
					} else {
						toggleItem(el, (nameText.indexOf(tempvalue) > -1 || descText.indexOf(tempvalue) > -1) && type == "action");
					}
				} else {
					toggleItem(el, nameText.indexOf(value) > -1 || descText.indexOf(value) > -1);
					const searchEl = getItemByAction("search");
					const gotoEl = getItemByAction("goto");
					if (value == "") {
						if (searchEl) searchEl.classList.add('omni-hidden');
						if (gotoEl) gotoEl.classList.add('omni-hidden');
					} else if (!validURL(value)) {
						if (searchEl) searchEl.classList.remove('omni-hidden');
						if (gotoEl) gotoEl.classList.add('omni-hidden');
						const searchName = $(".omni-item-name", searchEl);
						if (searchName) searchName.textContent = '"' + value + '"';
					} else {
						if (searchEl) searchEl.classList.add('omni-hidden');
						if (gotoEl) gotoEl.classList.remove('omni-hidden');
						const gotoName = $(".omni-item-name", gotoEl);
						if (gotoName) gotoName.textContent = value;
					}
				}
			});
		}

		const results = $(".omni-extension #omni-results");
		const visibleCount = Array.from($$("#omni-extension #omni-list .omni-item")).filter(el => !el.classList.contains('omni-hidden')).length;
		if (results) results.textContent = visibleCount + " results";

		const active = $(".omni-item-active");
		if (active) active.classList.remove("omni-item-active");
		const firstVisible = Array.from($$("#omni-extension #omni-list .omni-item")).find(el => !el.classList.contains('omni-hidden'));
		if (firstVisible) firstVisible.classList.add("omni-item-active");
	}

	// Handle actions from the omni
	function handleAction(e) {
		const activeEl = $(".omni-item-active");
		if (!activeEl) return;
		const idx = parseInt(activeEl.getAttribute("data-index"));
		const sourceArray = isFiltered && filteredActions ? filteredActions : actions;
		var action = sourceArray[idx];
		if (!action) return;
		closeOmni();
		const inputVal = ($(".omni-extension input") || {}).value || "";
		const lowerInput = inputVal.toLowerCase();

		if (lowerInput.startsWith("/remove")) {
			safeSend({request:"remove", type:action.type, action:action});
		} else if (lowerInput.startsWith("/history")) {
			if (e.ctrlKey || e.metaKey) {
				window.open(activeEl.getAttribute("data-url"));
			} else {
				window.open(activeEl.getAttribute("data-url"), "_self");
			}
		} else if (lowerInput.startsWith("/bookmarks")) {
			if (e.ctrlKey || e.metaKey) {
				window.open(activeEl.getAttribute("data-url"));
			} else {
				window.open(activeEl.getAttribute("data-url"), "_self");
			}
		} else {
			safeSend({request:action.action, tab:action, query:inputVal});
			switch (action.action) {
				case "bookmark":
					if (e.ctrlKey || e.metaKey) {
						window.open(action.url);
					} else {
						window.open(action.url, "_self");
					}
					break;
				case "scroll-bottom":
					window.scrollTo(0,document.body.scrollHeight);
					showToast(action);
					break;
				case "scroll-top":
					window.scrollTo(0,0);
					break;
				case "navigation":
					if (e.ctrlKey || e.metaKey) {
						window.open(action.url);
					} else {
						window.open(action.url, "_self");
					}
					break;
				case "fullscreen":
					document.documentElement.requestFullscreen();
					break;
				case "new-tab":
					window.open("");
					break;
				case "email":
					window.open("mailto:");
					break;
				case "url":
					if (e.ctrlKey || e.metaKey) {
						window.open(action.url);
					} else {
						window.open(action.url, "_self");
					}
					break;
				case "goto":
					if (e.ctrlKey || e.metaKey) {
						window.open(addhttp(inputVal));
					} else {
						window.open(addhttp(inputVal), "_self");
					}
					break;
				case "print":
					window.print();
					break;
				case "remove-all":
				case "remove-history":
				case "remove-cookies":
				case "remove-cache":
				case "remove-local-storage":
				case "remove-passwords":
					showToast(action);
					break;
			}
		}

		// Fetch actions again
		safeSend({request:"get-actions"}, (response) => {
			if (response) {
				actions = response.actions;
				populateOmni();
			}
		});
	}

	function openShortcuts() {
		safeSend({request:"extensions/shortcuts"});
	}

	// Track modifier keys for Alt+Shift combos
	var down = [];

	function moveActive(direction) {
		const active = $(".omni-item-active");
		if (!active) return;
		let target = direction === 'up' ? active.previousElementSibling : active.nextElementSibling;
		while (target && target.classList.contains('omni-hidden')) {
			target = direction === 'up' ? target.previousElementSibling : target.nextElementSibling;
		}
		if (target) {
			active.classList.remove("omni-item-active");
			target.classList.add("omni-item-active");
			// Scroll only within the list, not the host page
			const list = $("#omni-extension #omni-list");
			if (list) {
				const tTop = target.offsetTop;
				const tBot = tTop + target.offsetHeight;
				if (tTop < list.scrollTop) {
					list.scrollTop = tTop;
				} else if (tBot > list.scrollTop + list.clientHeight) {
					list.scrollTop = tBot - list.clientHeight;
				}
			}
		}
	}

	document.addEventListener("keydown", (e) => {
		if (!e.isTrusted) return;
		if (!extAlive()) return;
		down[e.keyCode] = true;
		if (!isOpen) return;

		// Ignore OS key-repeat events to prevent multi-step jumps
		if (e.repeat) {
			if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") {
				e.preventDefault();
				e.stopImmediatePropagation();
			}
			return;
		}

		switch (e.key) {
			case "ArrowUp":
				e.preventDefault();
				e.stopImmediatePropagation();
				moveActive('up');
				break;
			case "ArrowDown":
				e.preventDefault();
				e.stopImmediatePropagation();
				moveActive('down');
				break;
			case "Enter":
				e.preventDefault();
				e.stopImmediatePropagation();
				handleAction(e);
				break;
			case "Escape":
				e.preventDefault();
				closeOmni();
				break;
		}
	}, true);

	document.addEventListener("keyup", (e) => {
		if (!e.isTrusted) return;
		if (!extAlive()) { down = []; return; }
		if (down[18] && down[16] && down[80]) {
			if (actions.find(x => x.action == "pin") != undefined) {
				safeSend({request:"pin-tab"});
			} else {
				safeSend({request:"unpin-tab"});
			}
			safeSend({request:"get-actions"}, (response) => {
				if (response) {
					actions = response.actions;
					populateOmni();
				}
			});
		} else if (down[18] && down[16] && down[77]) {
			if (actions.find(x => x.action == "mute") != undefined) {
				safeSend({request:"mute-tab"});
			} else {
				safeSend({request:"unmute-tab"});
			}
			safeSend({request:"get-actions"}, (response) => {
				if (response) {
					actions = response.actions;
					populateOmni();
				}
			});
		} else if (down[18] && down[16] && down[67]) {
			window.open("mailto:");
		}

		down = [];
	});

	// Receive messages from background
	try {
		chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
			if (!extAlive()) return;
			if (message.request == "open-omni") {
				if (isOpen) {
					closeOmni();
				} else {
					openOmni();
				}
			} else if (message.request == "close-omni") {
				closeOmni();
			}
		});
	} catch (e) {}
}

} // end of double-injection guard
